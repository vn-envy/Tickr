import { constants } from "node:fs";
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { MediaProvenance, MediaRights } from "../autopilot/contracts";
import { TOKEN_KEY_ENV } from "../meta/graph-tokens";
import type { OwnerMediaConsent } from "./cinema-types";
import { dHashDistance, imageDHash, NEAR_DUPLICATE_DISTANCE, type GalleryRole, type OfficialGalleryResult } from "./gallery";
import {
  copyPrivateHashed, MAX_OWNER_IMAGE_BYTES, MAX_OWNER_VIDEO_BYTES, mediaExtension, OwnerUploadError, probeOwnerVideo,
  sanitizeOwnerImage, sniffMediaType, type OwnerUploadRecord, type OwnerVideoContainer, type SniffedMedia,
} from "./uploads";

/**
 * One provenance-carrying media catalog per Autopilot run. Files are content-addressed private
 * copies; the manifest is zod-validated, digest-checked on every read and written atomically.
 * Rights are derived from provenance, never chosen by a caller. Captions and page labels are
 * untrusted data. localPath is private: use publicMediaAsset() for API responses and exports.
 *
 * Manifest integrity: without an integrityKey the digest is a plain SHA-256 that detects
 * corruption and partial or hand edits, but anyone able to write the file can recompute it. With
 * an integrityKey (a server-held secret, see mediaLibraryIntegrityKey; never META_API_KEY) it is an
 * HMAC, so a provenance or rights edit by someone without the key is detected. Either way, export
 * approval must still re-verify each asset's bytes (verifyAsset) against the approved hashes.
 */
export const MAX_LIBRARY_ASSETS = 80;
export const MAX_LIBRARY_VIDEOS = 12;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_DUPLICATE_RECORDS = 8;
const LIBRARY_FOLDER = "media-library";

export type { MediaProvenance, MediaRights };
export type MediaAssetKind = "image" | "video";

export const RIGHTS_BY_PROVENANCE: Record<MediaProvenance, MediaRights> = {
  owner_upload: "owner_attested", owner_instagram: "owner_attested", owner_facebook: "owner_attested",
  official_website: "unknown_review_required", meta_illustration: "generated_illustration",
};
/** Owner-supplied pictures win over the same picture found elsewhere. */
const PROVENANCE_PRIORITY: Record<MediaProvenance, number> = { owner_upload: 4, owner_instagram: 3, owner_facebook: 3, official_website: 2, meta_illustration: 1 };

export class MediaLibraryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "MediaLibraryError";
  }
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const provenanceSchema = z.enum(["official_website", "owner_upload", "owner_instagram", "owner_facebook", "meta_illustration"]);
const httpsUrlSchema = z.string().max(2048).refine((value) => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
});
const consentSchema = z.object({
  ownsOrLicensedMedia: z.boolean(),
  peopleVisibleHaveConsented: z.union([z.boolean(), z.literal("no_people")]),
  attestedAt: z.string().datetime({ offset: true }),
}).strict();
const mimeTypes = { image: ["image/png", "image/jpeg", "image/webp"], video: ["video/mp4", "video/quicktime", "video/webm"] } as const;
const duplicateSchema = z.object({
  provenance: provenanceSchema, sha256: sha256Schema, match: z.enum(["exact", "near", "source_id"]),
  sourceUrl: httpsUrlSchema.nullable(), sourcePageUrl: httpsUrlSchema.nullable(), sourceId: z.string().max(128).nullable(),
}).strict();
const storedAssetSchema = z.object({
  id: z.string().regex(/^asset_[a-f0-9]{24}$/),
  kind: z.enum(["image", "video"]),
  provenance: provenanceSchema,
  rights: z.enum(["owner_attested", "unknown_review_required", "generated_illustration"]),
  sha256: sha256Schema,
  bytes: z.number().int().positive().max(MAX_OWNER_VIDEO_BYTES),
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000),
  durationSeconds: z.number().positive().max(3600).nullable(),
  mimeType: z.enum([...mimeTypes.image, ...mimeTypes.video]),
  file: z.string().regex(/^asset_[a-f0-9]{24}\.(?:png|jpg|webp|mp4|mov|webm)$/),
  dHash: z.string().regex(/^[a-f0-9]{16}$/).nullable(),
  sourceUrl: httpsUrlSchema.nullable(),
  sourcePageUrl: httpsUrlSchema.nullable(),
  sourceId: z.string().regex(/^[A-Za-z0-9_:.-]{1,128}$/).nullable(),
  caption: z.string().max(2200).nullable(),
  capturedAt: z.string().datetime({ offset: true }).nullable(),
  addedAt: z.string().datetime({ offset: true }),
  consent: consentSchema.nullable(),
  hints: z.object({
    pageRole: z.enum(["product", "interior", "storefront", "social_preview", "logo", "page_image"]).nullable(),
    productName: z.string().max(180).nullable(),
    originalName: z.string().max(120).nullable(),
  }).strict(),
  duplicates: z.array(duplicateSchema).max(MAX_DUPLICATE_RECORDS),
}).strict().superRefine((asset, context) => {
  const problem = (message: string) => context.addIssue({ code: "custom", message });
  if (asset.id !== `asset_${asset.sha256.slice(0, 24)}` || !asset.file.startsWith(`${asset.id}.`)) problem("id/file must be bound to the content hash");
  if (asset.rights !== RIGHTS_BY_PROVENANCE[asset.provenance]) problem("rights must follow provenance");
  if (!(mimeTypes[asset.kind] as readonly string[]).includes(asset.mimeType)) problem("mime type must match kind");
  if (asset.kind === "image" ? asset.dHash === null || asset.durationSeconds !== null : asset.dHash !== null || asset.durationSeconds === null) problem("kind-specific fields are inconsistent");
  if (asset.kind === "image" && asset.bytes > MAX_OWNER_IMAGE_BYTES) problem("image exceeds the size limit");
  if (asset.provenance === "owner_upload" && !asset.consent?.ownsOrLicensedMedia) problem("owner uploads require consent");
});
const manifestBodySchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().datetime({ offset: true }),
  assets: z.array(storedAssetSchema).max(MAX_LIBRARY_ASSETS),
}).strict().superRefine((manifest, context) => {
  const ids = new Set(manifest.assets.map((asset) => asset.id));
  if (ids.size !== manifest.assets.length) context.addIssue({ code: "custom", message: "duplicate asset ids" });
  if (manifest.assets.filter((asset) => asset.kind === "video").length > MAX_LIBRARY_VIDEOS) context.addIssue({ code: "custom", message: "too many videos" });
});
const manifestSchema = z.object({ body: manifestBodySchema, digest: sha256Schema, integrity: z.enum(["sha256", "hmac-sha256"]).optional() }).strict();
type ManifestIntegrity = "sha256" | "hmac-sha256";
const MANIFEST_KEY_INFO = "tickr/media-library/manifest-integrity/v1";

/**
 * Derives the manifest HMAC key (HKDF-SHA256 subkey) from the TICKR_SECRET_KEY server secret, or
 * returns null when that secret is not configured. The key never leaves the server process.
 */
export function mediaLibraryIntegrityKey(environment: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = environment[TOKEN_KEY_ENV]?.trim();
  if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) return null;
  const material = Buffer.from(raw, "base64");
  if (material.length !== 32) return null;
  const key = Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), MANIFEST_KEY_INFO, 32));
  material.fill(0);
  return key;
}

type StoredAsset = z.infer<typeof storedAssetSchema>;
type ManifestBody = z.infer<typeof manifestBodySchema>;

export interface MediaAssetRecord extends Omit<StoredAsset, "file"> {
  /** Absolute private path inside the run's media library. Never exported or sent to a browser. */
  localPath: string;
}
export type PublicMediaAsset = Omit<MediaAssetRecord, "localPath">;

export function publicMediaAsset(asset: MediaAssetRecord): PublicMediaAsset {
  const { localPath: _privatePath, ...metadata } = asset;
  void _privatePath;
  return metadata;
}

export interface NewMediaAsset {
  kind: MediaAssetKind;
  provenance: MediaProvenance;
  /** Absolute path of an application-produced file. It is copied; the source is never moved or trusted for identity. */
  filePath: string;
  mimeType: string;
  sourceUrl?: string | null;
  sourcePageUrl?: string | null;
  sourceId?: string | null;
  caption?: string | null;
  capturedAt?: string | null;
  consent?: OwnerMediaConsent | null;
  hints?: { pageRole?: GalleryRole | null; productName?: string | null; originalName?: string | null };
  /** When supplied, the copied bytes must hash to this value. */
  expectedSha256?: string;
}

export type AddAssetResult =
  | { status: "added"; asset: MediaAssetRecord; evicted: string | null }
  | { status: "duplicate"; asset: MediaAssetRecord; match: "exact" | "near" | "source_id" }
  | { status: "replaced"; asset: MediaAssetRecord; replaced: string; match: "exact" | "near"; absorbed: string[] }
  | { status: "rejected"; asset: null; reason: "asset_limit" | "video_limit" }
  /** One import item failed validation; other items of the same import still proceed. */
  | { status: "rejected"; asset: null; reason: "invalid_asset"; code: string; sourceUrl: string | null };

/** Owner-connected Instagram/Facebook media item, as produced by the Meta Graph adapter. */
export interface MetaGraphMediaItem {
  sourceId: string;
  kind: MediaAssetKind;
  caption: string | null;
  permalink: string | null;
  timestamp: string | null;
  provenance: "owner_instagram" | "owner_facebook";
}

const graphItemSchema = z.object({
  sourceId: z.string().regex(/^[A-Za-z0-9_:.-]{1,128}$/),
  kind: z.enum(["image", "video"]),
  caption: z.string().max(20_000).nullable(),
  permalink: z.string().max(2048).nullable(),
  timestamp: z.string().max(64).nullable(),
  provenance: z.enum(["owner_instagram", "owner_facebook"]),
}).passthrough();

const cleanText = (value: string | null | undefined, max: number) =>
  typeof value === "string" ? value.normalize("NFKC").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, max) || null : null;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function digestOf(body: ManifestBody, key: Buffer | null): string {
  const payload = `tickr-media-library-v1\n${canonicalJson(body)}`;
  return (key ? createHmac("sha256", key) : createHash("sha256")).update(payload).digest("hex");
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  // Graph timestamps use "+0000"; normalise the offset before parsing.
  const parsed = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(parsed) && parsed > Date.UTC(2000, 0, 1) && parsed < Date.now() + 86_400_000 ? new Date(parsed).toISOString() : null;
}

function socialPermalink(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowed = ["instagram.com", "facebook.com", "fb.com", "fb.watch"].some((domain) => host === domain || host.endsWith(`.${domain}`));
    return url.protocol === "https:" && !url.username && !url.password && allowed && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

async function readHead(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const head = Buffer.alloc(64);
    const { bytesRead } = await handle.read(head, 0, 64, 0);
    return head.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const chunk of handle.createReadStream({ highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>) { hash.update(chunk); bytes += chunk.length; }
  } finally { await handle.close().catch(() => undefined); }
  return { sha256: hash.digest("hex"), bytes };
}

const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  locks.set(key, next);
  try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
}

export class MediaLibrary {
  readonly directory: string;
  private readonly filesDirectory: string;
  private readonly manifestPath: string;
  private readonly integrityKey: Buffer | null;

  private constructor(directory: string, integrityKey: Buffer | null) {
    this.directory = directory;
    this.integrityKey = integrityKey;
    this.filesDirectory = join(directory, "files");
    this.manifestPath = join(directory, "manifest.json");
  }

  /**
   * runDir is an application-controlled private run directory (normally under ignored .data/).
   * Pass integrityKey (normally mediaLibraryIntegrityKey()) to authenticate the manifest; a library
   * written with a key cannot be opened without it, and a keyed open rejects an unkeyed manifest.
   */
  static async open(runDir: string, options: { integrityKey?: Buffer | null } = {}): Promise<MediaLibrary> {
    if (typeof runDir !== "string" || !isAbsolute(runDir)) throw new MediaLibraryError("LIBRARY_INVALID", "The media library location is not configured correctly.");
    const key = options.integrityKey ?? null;
    if (key !== null && (!Buffer.isBuffer(key) || key.length < 32)) throw new MediaLibraryError("LIBRARY_INVALID", "The media library integrity key is not configured correctly.");
    const library = new MediaLibrary(join(resolve(runDir), LIBRARY_FOLDER), key ? Buffer.from(key) : null);
    await mkdir(library.filesDirectory, { recursive: true, mode: 0o700 });
    for (const path of [library.directory, library.filesDirectory]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new MediaLibraryError("LIBRARY_INVALID", "The media library location is not configured correctly.");
    }
    await library.load();
    return library;
  }

  async listAssets(filter: { kind?: MediaAssetKind; provenance?: MediaProvenance } = {}): Promise<MediaAssetRecord[]> {
    const manifest = await this.load();
    return manifest.assets
      .filter((asset) => (!filter.kind || asset.kind === filter.kind) && (!filter.provenance || asset.provenance === filter.provenance))
      .map((asset) => this.toRecord(asset));
  }

  async getAsset(id: string): Promise<MediaAssetRecord | null> {
    const asset = (await this.load()).assets.find((item) => item.id === id);
    return asset ? this.toRecord(asset) : null;
  }

  /** Re-hashes the stored bytes; use before sending an asset to Meta or rendering an export. */
  async verifyAsset(id: string): Promise<MediaAssetRecord> {
    const asset = await this.getAsset(id);
    if (!asset) throw new MediaLibraryError("ASSET_NOT_FOUND", "The media asset is not in this library.");
    try {
      const info = await lstat(asset.localPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.bytes) throw new Error("size");
      const actual = await hashFile(asset.localPath);
      if (actual.sha256 !== asset.sha256 || actual.bytes !== asset.bytes) throw new Error("hash");
    } catch {
      throw new MediaLibraryError("ASSET_TAMPERED", "A stored media file no longer matches its recorded content hash.");
    }
    return asset;
  }

  /** Drops these assets from the manifest and deletes their private copies; unknown ids are ignored. */
  async removeAssets(ids: readonly string[]): Promise<number> {
    const drop = new Set(ids);
    return withLock(this.manifestPath, async () => {
      const manifest = await this.load();
      const removed = manifest.assets.filter((asset) => drop.has(asset.id));
      if (!removed.length) return 0;
      await this.write({ ...manifest, assets: manifest.assets.filter((asset) => !drop.has(asset.id)) });
      for (const asset of removed) {
        const path = join(this.filesDirectory, asset.file);
        if (path.startsWith(this.filesDirectory + sep)) await unlink(path).catch(() => undefined);
      }
      return removed.length;
    });
  }

  async addAsset(input: NewMediaAsset): Promise<AddAssetResult> {
    const prepared = await this.prepare(input);
    return withLock(this.manifestPath, () => this.commit(prepared));
  }

  /** Imports every gallery asset; one invalid or changed file is reported and does not stop the rest. */
  async importFromGallery(result: OfficialGalleryResult): Promise<AddAssetResult[]> {
    const outcomes: AddAssetResult[] = [];
    for (const asset of result.assets) {
      const filePath = result.localFiles[asset.id];
      const sourceUrl = typeof asset.sourceUrl === "string" && httpsUrlSchema.safeParse(asset.sourceUrl).success ? asset.sourceUrl : null;
      if (!filePath) { outcomes.push({ status: "rejected", asset: null, reason: "invalid_asset", code: "ASSET_UNREADABLE", sourceUrl }); continue; }
      try {
        outcomes.push(await this.addAsset({
          kind: "image", provenance: "official_website", filePath, mimeType: asset.mimeType, expectedSha256: asset.sha256,
          sourceUrl: asset.sourceUrl, sourcePageUrl: asset.sourcePageUrl, caption: asset.label,
          hints: { pageRole: asset.role, productName: asset.productName },
        }));
      } catch (error) {
        // Library-wide failures (manifest or storage) still stop the import; per-asset ones do not.
        if (!(error instanceof MediaLibraryError) || ["MANIFEST_INVALID", "MANIFEST_TAMPERED", "MANIFEST_KEY_REQUIRED", "LIBRARY_INVALID"].includes(error.code)) throw error;
        outcomes.push({ status: "rejected", asset: null, reason: "invalid_asset", code: error.code, sourceUrl });
      }
    }
    return outcomes;
  }

  async importUpload(upload: OwnerUploadRecord): Promise<AddAssetResult> {
    if (upload.provenance !== "owner_upload" || upload.rights !== "owner_attested") throw new MediaLibraryError("ASSET_INVALID", "The media record is not an owner upload.");
    return this.addAsset({
      kind: upload.kind, provenance: "owner_upload", filePath: upload.path, mimeType: upload.mimeType, expectedSha256: upload.sha256,
      consent: upload.consent, hints: { originalName: upload.originalName },
    });
  }

  /**
   * Adds one owner-connected Instagram/Facebook item whose bytes the Graph adapter already
   * downloaded from a Meta CDN. Images are re-encoded here (metadata stripped); videos stay
   * private originals until clip normalization. Expiring CDN URLs are never stored.
   */
  async importMetaGraphItem(item: MetaGraphMediaItem, downloadedFile: { path: string; mimeType: string; sha256?: string }, consent: OwnerMediaConsent | null = null): Promise<AddAssetResult> {
    const parsed = graphItemSchema.safeParse(item);
    if (!parsed.success) throw new MediaLibraryError("ASSET_INVALID", "The connected-account media item was not valid.");
    if (downloadedFile.sha256 !== undefined && !sha256Schema.safeParse(downloadedFile.sha256).success) throw new MediaLibraryError("ASSET_INVALID", "The media record was not valid.");
    const base = {
      kind: parsed.data.kind, provenance: parsed.data.provenance, sourceId: parsed.data.sourceId, consent,
      caption: cleanText(parsed.data.caption, 2200), sourcePageUrl: socialPermalink(parsed.data.permalink), sourceUrl: null,
      capturedAt: normalizeTimestamp(parsed.data.timestamp),
    } satisfies Partial<NewMediaAsset>;
    const existing = (await this.load()).assets.find((asset) => asset.provenance === base.provenance && asset.sourceId === base.sourceId);
    if (existing) return { status: "duplicate", asset: this.toRecord(existing), match: "source_id" };
    if (base.kind === "video") return this.addAsset({ ...base, filePath: downloadedFile.path, mimeType: downloadedFile.mimeType, expectedSha256: downloadedFile.sha256 });
    const sniffed = sniffMediaType(await this.readSource(downloadedFile.path, MAX_OWNER_IMAGE_BYTES).then(readHead));
    if (!sniffed || typeof sniffed === "string" || sniffed.kind !== "image") throw new MediaLibraryError("TYPE_MISMATCH", "The connected-account media bytes did not match the expected type.");
    let sanitized: Awaited<ReturnType<typeof sanitizeOwnerImage>>;
    try {
      const handle = await open(downloadedFile.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const original = await handle.readFile();
        if (downloadedFile.sha256 && createHash("sha256").update(original).digest("hex") !== downloadedFile.sha256) throw new MediaLibraryError("HASH_MISMATCH", "The media bytes changed after they were validated.");
        sanitized = await sanitizeOwnerImage(original, sniffed.container as "png" | "jpeg" | "webp");
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof MediaLibraryError) throw error;
      if (error instanceof OwnerUploadError) throw new MediaLibraryError(error.code, error.message);
      throw new MediaLibraryError("ASSET_UNREADABLE", "The media file could not be read.");
    }
    const staging = join(this.filesDirectory, `staging_${randomBytes(12).toString("hex")}.${mediaExtension(sniffed.container)}`);
    const handle = await open(staging, "wx", 0o600);
    try { await handle.writeFile(sanitized.bytes); await handle.sync(); } finally { await handle.close(); }
    try { return await this.addAsset({ ...base, filePath: staging, mimeType: sniffed.mimeType }); }
    finally { await unlink(staging).catch(() => undefined); }
  }

  private toRecord(asset: StoredAsset): MediaAssetRecord {
    const { file, ...rest } = asset;
    return { ...structuredClone(rest), localPath: join(this.filesDirectory, file) };
  }

  private async readSource(path: string, maxBytes: number): Promise<string> {
    if (typeof path !== "string" || !isAbsolute(path)) throw new MediaLibraryError("ASSET_UNREADABLE", "The media file could not be read.");
    let info;
    try { info = await lstat(path); } catch { throw new MediaLibraryError("ASSET_UNREADABLE", "The media file could not be read."); }
    if (!info.isFile() || info.isSymbolicLink()) throw new MediaLibraryError("ASSET_UNREADABLE", "The media file could not be read.");
    if (!info.size || info.size > maxBytes) throw new MediaLibraryError("FILE_TOO_LARGE", "The media file exceeds the library size limit.");
    return path;
  }

  /** Validates, copies and inspects outside the manifest lock; nothing is published yet. */
  private async prepare(input: NewMediaAsset) {
    const provenance = provenanceSchema.safeParse(input?.provenance);
    if (!provenance.success || !["image", "video"].includes(input.kind)) throw new MediaLibraryError("ASSET_INVALID", "The media record was not valid.");
    const optionalUrl = (value: string | null | undefined) => {
      if (value === undefined || value === null) return null;
      const checked = httpsUrlSchema.safeParse(value);
      if (!checked.success) throw new MediaLibraryError("ASSET_INVALID", "Media source links must be HTTPS URLs.");
      return checked.data;
    };
    const consent = input.consent === undefined || input.consent === null ? null : consentSchema.safeParse(input.consent);
    if (consent && !consent.success) throw new MediaLibraryError("ASSET_INVALID", "The owner media consent record was not valid.");
    if (provenance.data === "owner_upload" && !(consent?.success && consent.data.ownsOrLicensedMedia)) throw new MediaLibraryError("CONSENT_REQUIRED", "Owner uploads require the owner's media consent.");
    const sourceId = input.sourceId ?? null;
    if (sourceId !== null && !/^[A-Za-z0-9_:.-]{1,128}$/.test(sourceId)) throw new MediaLibraryError("ASSET_INVALID", "The media record was not valid.");
    if (input.expectedSha256 !== undefined && !sha256Schema.safeParse(input.expectedSha256).success) throw new MediaLibraryError("ASSET_INVALID", "The media record was not valid.");
    const capturedAt = input.capturedAt ? normalizeTimestamp(input.capturedAt) : null;
    const maxBytes = input.kind === "image" ? MAX_OWNER_IMAGE_BYTES : MAX_OWNER_VIDEO_BYTES;
    const path = await this.readSource(input.filePath, maxBytes);
    const sniffed = sniffMediaType(await readHead(path));
    const declared = String(input.mimeType ?? "").split(";")[0].trim().toLowerCase();
    const isoBmff = (type: string) => type === "video/mp4" || type === "video/quicktime";
    if (!sniffed || typeof sniffed === "string" || sniffed.kind !== input.kind || (declared !== sniffed.mimeType && !(isoBmff(declared) && isoBmff(sniffed.mimeType)))) {
      throw new MediaLibraryError("TYPE_MISMATCH", "The media bytes did not match the declared type.");
    }
    const pending = join(this.filesDirectory, `pending_${randomBytes(12).toString("hex")}.${mediaExtension(sniffed.container)}`);
    let copied: { sha256: string; bytes: number };
    try { copied = await copyPrivateHashed(path, pending, maxBytes); }
    catch (error) {
      if (error instanceof OwnerUploadError && error.code === "FILE_TOO_LARGE") throw new MediaLibraryError("FILE_TOO_LARGE", "The media file exceeds the library size limit.");
      throw new MediaLibraryError("ASSET_UNREADABLE", "The media file could not be read.");
    }
    try {
      if (input.expectedSha256 && copied.sha256 !== input.expectedSha256) throw new MediaLibraryError("HASH_MISMATCH", "The media bytes changed after they were validated.");
      const inspected = await this.inspect(pending, sniffed);
      const asset: StoredAsset = {
        id: `asset_${copied.sha256.slice(0, 24)}`, kind: input.kind, provenance: provenance.data, rights: RIGHTS_BY_PROVENANCE[provenance.data],
        sha256: copied.sha256, bytes: copied.bytes, ...inspected, mimeType: sniffed.mimeType,
        file: `asset_${copied.sha256.slice(0, 24)}.${mediaExtension(sniffed.container)}`,
        sourceUrl: optionalUrl(input.sourceUrl), sourcePageUrl: optionalUrl(input.sourcePageUrl), sourceId,
        caption: cleanText(input.caption, 2200), capturedAt, addedAt: new Date().toISOString(),
        consent: consent?.success ? consent.data : null,
        hints: {
          pageRole: input.hints?.pageRole ?? null,
          productName: cleanText(input.hints?.productName, 180),
          originalName: cleanText(input.hints?.originalName, 120),
        },
        duplicates: [],
      };
      const checked = storedAssetSchema.safeParse(asset);
      if (!checked.success) throw new MediaLibraryError("ASSET_INVALID", "The media record was not valid.");
      return { asset: checked.data, pending };
    } catch (error) {
      await unlink(pending).catch(() => undefined);
      throw error;
    }
  }

  private async inspect(path: string, sniffed: SniffedMedia): Promise<Pick<StoredAsset, "width" | "height" | "durationSeconds" | "dHash">> {
    if (sniffed.kind === "video") {
      try {
        const probe = await probeOwnerVideo(path, sniffed.container as OwnerVideoContainer);
        return { width: probe.width, height: probe.height, durationSeconds: probe.durationSeconds, dHash: null };
      } catch (error) {
        if (error instanceof OwnerUploadError) throw new MediaLibraryError(error.code, error.message);
        throw new MediaLibraryError("ASSET_UNREADABLE", "The media file could not be read.");
      }
    }
    let metadata;
    try { metadata = await sharp(path, { limitInputPixels: 50_000_000, failOn: "error", animated: false }).metadata(); }
    catch { throw new MediaLibraryError("ASSET_UNREADABLE", "The image could not be decoded."); }
    if (metadata.format !== sniffed.container || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw new MediaLibraryError("ASSET_INVALID", "The image could not be decoded as a single still picture.");
    // Library images must already be sanitized (gallery normalizer, upload re-encode or Graph adapter).
    if (metadata.exif || metadata.xmp || metadata.iptc) throw new MediaLibraryError("IMAGE_NOT_SANITIZED", "Images must have private metadata removed before entering the library.");
    return { width: metadata.width, height: metadata.height, durationSeconds: null, dHash: await imageDHash(path) };
  }

  private async commit({ asset, pending }: { asset: StoredAsset; pending: string }): Promise<AddAssetResult> {
    const discard = () => unlink(pending).catch(() => undefined);
    try {
      const manifest = await this.load();
      const assets = [...manifest.assets];
      const exact = assets.find((item) => item.sha256 === asset.sha256);
      const bySource = asset.sourceId ? assets.find((item) => item.provenance === asset.provenance && item.sourceId === asset.sourceId) : undefined;
      const distance = (item: StoredAsset) => item.dHash && asset.dHash ? dHashDistance(item.dHash, asset.dHash) : Infinity;
      const nearMatches = assets.filter((item) => item !== exact && distance(item) <= NEAR_DUPLICATE_DISTANCE).sort((a, b) => distance(a) - distance(b));
      const matches = [...(exact ? [exact] : []), ...nearMatches];
      const priority = PROVENANCE_PRIORITY[asset.provenance];
      // An equal- or higher-priority copy of the picture keeps its place; otherwise the newcomer
      // replaces the closest lower-priority copy and absorbs every other one.
      const keeper = bySource ?? matches.find((item) => PROVENANCE_PRIORITY[item.provenance] >= priority);
      const kindOf = (item: StoredAsset) => item === bySource ? "source_id" as const : item === exact ? "exact" as const : "near" as const;
      const note = (from: StoredAsset, kind: "exact" | "near" | "source_id") => ({
        provenance: from.provenance, sha256: from.sha256, match: kind, sourceUrl: from.sourceUrl, sourcePageUrl: from.sourcePageUrl, sourceId: from.sourceId,
      });

      if (keeper) {
        await discard();
        const match = kindOf(keeper);
        const seen = keeper.duplicates.some((entry) => entry.provenance === asset.provenance && entry.sha256 === asset.sha256 && entry.sourceUrl === asset.sourceUrl && entry.sourceId === asset.sourceId);
        if (!seen && keeper.duplicates.length < MAX_DUPLICATE_RECORDS && match !== "source_id") {
          assets[assets.indexOf(keeper)] = { ...keeper, duplicates: [...keeper.duplicates, note(asset, match)] };
          await this.write({ ...manifest, assets });
          return { status: "duplicate", asset: this.toRecord(assets.find((item) => item.id === keeper.id)!), match };
        }
        return { status: "duplicate", asset: this.toRecord(keeper), match };
      }

      const duplicate = matches[0];
      const removed: StoredAsset[] = [];
      if (duplicate) {
        for (const item of matches) {
          removed.push(item);
          assets.splice(assets.indexOf(item), 1);
        }
        asset.duplicates = matches.flatMap((item) => [note(item, kindOf(item) as "exact" | "near"), ...item.duplicates]).slice(0, MAX_DUPLICATE_RECORDS);
      } else {
        const videoFull = asset.kind === "video" && assets.filter((item) => item.kind === "video").length >= MAX_LIBRARY_VIDEOS;
        const full = assets.length >= MAX_LIBRARY_ASSETS;
        if (videoFull || full) {
          // Evict the lowest-priority (most recently added among equals) asset only for a higher-priority newcomer.
          const victim = assets
            .filter((item) => (!videoFull || item.kind === "video") && PROVENANCE_PRIORITY[item.provenance] < priority)
            .sort((a, b) => PROVENANCE_PRIORITY[a.provenance] - PROVENANCE_PRIORITY[b.provenance] || b.addedAt.localeCompare(a.addedAt))[0];
          if (!victim) { await discard(); return { status: "rejected", asset: null, reason: videoFull ? "video_limit" : "asset_limit" }; }
          removed.push(victim);
          assets.splice(assets.indexOf(victim), 1);
        }
      }
      const finalPath = join(this.filesDirectory, asset.file);
      if (!finalPath.startsWith(this.filesDirectory + sep)) throw new MediaLibraryError("LIBRARY_INVALID", "The media library location is not configured correctly.");
      await rename(pending, finalPath);
      assets.push(asset);
      await this.write({ ...manifest, assets });
      for (const item of removed) if (item.file !== asset.file) await unlink(join(this.filesDirectory, item.file)).catch(() => undefined);
      const record = this.toRecord(asset);
      if (duplicate) return { status: "replaced", asset: record, replaced: duplicate.id, match: kindOf(duplicate) as "exact" | "near", absorbed: removed.slice(1).map((item) => item.id) };
      return { status: "added", asset: record, evicted: removed[0]?.id ?? null };
    } catch (error) {
      await discard();
      throw error;
    }
  }

  private async load(): Promise<ManifestBody> {
    let raw: string;
    try {
      const info = await lstat(this.manifestPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) throw new MediaLibraryError("MANIFEST_INVALID", "The media library manifest is not valid.");
      const handle = await open(this.manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { raw = await handle.readFile("utf8"); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, updatedAt: new Date(0).toISOString(), assets: [] };
      if (error instanceof MediaLibraryError) throw error;
      throw new MediaLibraryError("MANIFEST_INVALID", "The media library manifest is not valid.");
    }
    let parsed: z.infer<typeof manifestSchema>;
    try { parsed = manifestSchema.parse(JSON.parse(raw)); } catch { throw new MediaLibraryError("MANIFEST_INVALID", "The media library manifest is not valid."); }
    const integrity: ManifestIntegrity = parsed.integrity ?? "sha256";
    if (integrity === "hmac-sha256" && !this.integrityKey) throw new MediaLibraryError("MANIFEST_KEY_REQUIRED", "The media library manifest requires the server integrity key.");
    // A keyed library never accepts an unkeyed (recomputable) digest.
    const expected = Buffer.from(digestOf(parsed.body, integrity === "hmac-sha256" ? this.integrityKey : null), "hex");
    if ((integrity === "sha256" && this.integrityKey) || !timingSafeEqual(expected, Buffer.from(parsed.digest, "hex"))) {
      throw new MediaLibraryError("MANIFEST_TAMPERED", "The media library manifest failed its integrity check.");
    }
    return parsed.body;
  }

  private async write(body: ManifestBody) {
    const next = manifestBodySchema.parse({ ...body, updatedAt: new Date().toISOString() });
    const temporary = join(this.directory, `.manifest-${randomBytes(8).toString("hex")}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    const integrity: ManifestIntegrity = this.integrityKey ? "hmac-sha256" : "sha256";
    try { await handle.writeFile(JSON.stringify({ body: next, digest: digestOf(next, this.integrityKey), integrity })); await handle.sync(); }
    catch (error) { await handle.close(); await unlink(temporary).catch(() => undefined); throw error; }
    await handle.close();
    try { await rename(temporary, this.manifestPath); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
}
