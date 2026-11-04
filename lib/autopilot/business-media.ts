import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { z } from "zod";
import { db } from "../db";
import { RequestError } from "../http";
import { validRunId } from "../jobs/http";
import type { OwnerMediaConsent } from "../media/cinema-types";
import { MediaLibrary, MediaLibraryError, mediaLibraryIntegrityKey, type MediaAssetRecord } from "../media/library";
import { acceptOwnerUpload, MAX_OWNER_IMAGE_BYTES, MAX_OWNER_VIDEO_BYTES, OwnerUploadError } from "../media/uploads";
import { getMetaConnectorStatus, MetaGraphError, revokeMetaPermissions, type OwnerMediaSource } from "../meta/graph";
import { defaultConnectionsDirectory, deleteOwnerToken, GraphTokenError, isValidBusinessId, loadOwnerToken, TOKEN_KEY_ENV } from "../meta/graph-tokens";

/**
 * Server helpers behind the Autopilot HTTP routes: the per-business owner-upload library, raw-body
 * uploads streamed to a private temp file under a hard byte limit, JPEG thumbnails (video poster
 * frames via local FFmpeg), the owner's Meta connection status and the connection attestation.
 *
 * Everything lives under the ignored `.data/` directory. Private paths, tokens and secrets never
 * leave this module: route responses use the summaries built here and fixed error messages.
 */

type Environment = Record<string, string | undefined>;

export const MAX_BUSINESS_UPLOADS = 40;
export const THUMB_MAX_SIDE = 480;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const MAX_FILENAME_PARAM_CHARS = 1024;
const POSTER_TIMEOUT_MS = 20_000;
const POSTER_MAX_BUFFER = 16 * 1024 * 1024;
const DEMUXER_ALLOWLIST = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm";
const ASSET_ID = /^asset_[a-f0-9]{24}$/;
const execFileAsync = promisify(execFile);

export const UPLOAD_MIME_TYPES = {
  "image/png": "image", "image/jpeg": "image", "image/webp": "image",
  "video/mp4": "video", "video/quicktime": "video", "video/webm": "video",
} as const;
export type UploadMimeType = keyof typeof UPLOAD_MIME_TYPES;

// ---------------------------------------------------------------------------
// Request guards
// ---------------------------------------------------------------------------

/** Same rule as readLocalJson for writes without a JSON body, plus Fetch Metadata when the browser sends it. */
export function assertSameOriginWrite(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new RequestError("Cross-origin writes are not allowed.", 403);
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new RequestError("Cross-origin writes are not allowed.", 403);
}

/** Business ids are UUIDs; anything else, or a missing record, is a plain 404. */
export async function requireBusiness(id: string): Promise<void> {
  if (!validRunId(id) || !isValidBusinessId(id)) throw new RequestError("Business not found.", 404);
  const business = await db.business.findUnique({ where: { id }, select: { id: true } });
  if (!business) throw new RequestError("Business not found.", 404);
}

export async function requireRun(id: string): Promise<void> {
  if (!validRunId(id)) throw new RequestError("Record not found.", 404);
  const run = await db.run.findUnique({ where: { id }, select: { id: true } });
  if (!run) throw new RequestError("Record not found.", 404);
}

export function requireAssetId(assetId: string): void {
  if (!ASSET_ID.test(assetId)) throw new RequestError("Media not found.", 404);
}

// ---------------------------------------------------------------------------
// Private storage locations
// ---------------------------------------------------------------------------

/** `.data/businesses/<id>/media` (the directory the worker passes as businessMediaDir). */
export function businessMediaDir(businessId: string): string {
  if (!validRunId(businessId)) throw new RequestError("Business not found.", 404);
  return resolve(".data", "businesses", businessId, "media");
}

/** `.data/runs/<id>` after a realpath check, or null when the run has no output directory yet. */
export async function runOutputDir(runId: string): Promise<string | null> {
  if (!validRunId(runId)) throw new RequestError("Record not found.", 404);
  try {
    const root = await realpath(resolve(".data", "runs"));
    const directory = await realpath(resolve(root, runId));
    if (directory !== join(root, runId)) throw new RequestError("Run directory failed its path integrity check.", 409);
    return directory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    if (error instanceof RequestError) throw error;
    throw new RequestError("Run directory failed its path integrity check.", 409);
  }
}

/** Creates the private business media directory (0700) and refuses symlinked or relocated paths. */
async function ensureBusinessMediaDir(businessId: string): Promise<string> {
  const directory = businessMediaDir(businessId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(resolve(".data"));
  if ((await realpath(directory)) !== join(root, "businesses", businessId, "media")) throw new RequestError("Media storage failed its path integrity check.", 409);
  return directory;
}

async function ensurePrivateSubdir(parent: string, name: string): Promise<string> {
  const directory = join(parent, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RequestError("Media storage failed its path integrity check.", 409);
  return directory;
}

/**
 * Opens the business library with the server integrity key. A library first written while
 * TICKR_SECRET_KEY was unset carries a plain SHA-256 digest that a keyed open rejects; that normal
 * "upload first, configure the connector later" order is upgraded once to an HMAC manifest (see
 * upgradeUnkeyedManifest). Any other integrity failure is reported, never repaired.
 */
export async function openBusinessLibrary(businessId: string): Promise<MediaLibrary> {
  const directory = await ensureBusinessMediaDir(businessId);
  const key = mediaLibraryIntegrityKey();
  try {
    return await MediaLibrary.open(directory, { integrityKey: key });
  } catch (error) {
    if (!key || !(error instanceof MediaLibraryError) || error.code !== "MANIFEST_TAMPERED") throw error;
    const upgraded = await withLock(`upgrade:${businessId}`, () => upgradeUnkeyedManifest(directory, key));
    if (!upgraded) throw error;
    return MediaLibrary.open(directory, { integrityKey: key });
  }
}

const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(name) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  locks.set(name, next);
  try { return await next; } finally { if (locks.get(name) === next) locks.delete(name); }
}
const withBusinessLock = <T>(businessId: string, task: () => Promise<T>) => withLock(`business:${businessId}`, task);

// ---------------------------------------------------------------------------
// Manifest maintenance (delete and key upgrade) without copying media
// ---------------------------------------------------------------------------

/*
 * MediaLibrary has no removal or re-keying API yet. These helpers rewrite only the small manifest
 * and never trust their own format knowledge: before any write they (1) recompute the CURRENT
 * manifest's digest and require it to equal the stored one, which proves this digest
 * implementation matches the library's, and (2) open the candidate manifest with MediaLibrary
 * itself in a private scratch directory and require the expected asset ids. If the library's
 * format ever changes, the operation stops with a 409 and nothing on disk changes.
 * The replacement is one atomic rename, only after re-reading the manifest unchanged.
 */

const LIBRARY_FOLDER = "media-library";
const MANIFEST_FILE = "manifest.json";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MEDIA_FILE = /^asset_[a-f0-9]{24}\.(?:png|jpg|webp|mp4|mov|webm)$/;
const manifestEnvelopeSchema = z.object({
  body: z.object({
    version: z.literal(1),
    updatedAt: z.string(),
    assets: z.array(z.object({ id: z.string().regex(ASSET_ID), file: z.string().regex(MEDIA_FILE), provenance: z.string() }).passthrough()),
  }).passthrough(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  integrity: z.enum(["sha256", "hmac-sha256"]).optional(),
}).strict();
type ManifestEnvelope = z.infer<typeof manifestEnvelopeSchema>;
type ManifestBody = ManifestEnvelope["body"];

const removalUnavailable = () => new RequestError("Removing media is not available right now; nothing was removed. Try again, or ask the operator to check the media library.", 409);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function manifestDigest(body: ManifestBody, key: Buffer | null): string {
  const payload = `tickr-media-library-v1\n${canonicalJson(body)}`;
  return (key ? createHmac("sha256", key) : createHash("sha256")).update(payload).digest("hex");
}

/** The raw manifest text plus its parsed envelope (the parsed JSON itself, so unknown fields survive untouched). */
async function readManifest(libraryDir: string): Promise<{ text: string; manifest: ManifestEnvelope } | null> {
  const path = join(libraryDir, MANIFEST_FILE);
  let text: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) return null;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
  } catch { return null; }
  try {
    const json: unknown = JSON.parse(text);
    if (!manifestEnvelopeSchema.safeParse(json).success) return null;
    return { text, manifest: json as ManifestEnvelope };
  } catch { return null; }
}

/** True when the stored digest verifies under this module's digest implementation. */
function digestVerifies(manifest: ManifestEnvelope, key: Buffer | null): boolean {
  const actual = Buffer.from(manifest.digest, "hex");
  const expected = Buffer.from(manifestDigest(manifest.body, key), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Opens the candidate with MediaLibrary in a private scratch directory; true only when it loads with exactly the expected ids. */
async function libraryAcceptsManifest(mediaDir: string, text: string, key: Buffer | null, expectedIds: string[]): Promise<boolean> {
  const scratch = join(mediaDir, `.verify_${randomBytes(8).toString("hex")}`);
  try {
    await mkdir(join(scratch, LIBRARY_FOLDER), { recursive: true, mode: 0o700 });
    const handle = await open(join(scratch, LIBRARY_FOLDER, MANIFEST_FILE), "wx", 0o600);
    try { await handle.writeFile(text); } finally { await handle.close(); }
    const ids = (await (await MediaLibrary.open(scratch, { integrityKey: key })).listAssets()).map((asset) => asset.id);
    return ids.length === expectedIds.length && ids.every((id, index) => id === expectedIds[index]);
  } catch { return false; } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Atomically replaces the manifest, but only when it still holds exactly `expectedText`. */
async function replaceManifest(libraryDir: string, expectedText: string, nextText: string): Promise<void> {
  const current = await readManifest(libraryDir);
  if (!current || current.text !== expectedText) throw new RequestError("The media library changed while it was being updated; nothing was removed. Try again.", 409);
  const temporary = join(libraryDir, `.manifest-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(nextText); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(temporary).catch(() => undefined); throw error; }
  await handle.close();
  try { await rename(temporary, join(libraryDir, MANIFEST_FILE)); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

const envelopeText = (body: ManifestBody, key: Buffer | null) => JSON.stringify({ body, digest: manifestDigest(body, key), integrity: key ? "hmac-sha256" : "sha256" });

/**
 * One-time upgrade of an unkeyed business library to the server key. Only a manifest whose plain
 * SHA-256 digest verifies and that holds nothing but consented owner uploads (the only thing this
 * business library ever stores) is re-signed; its body is kept byte-for-byte. Returns false when
 * the manifest is not eligible, so the caller reports the original integrity error.
 */
async function upgradeUnkeyedManifest(mediaDir: string, key: Buffer): Promise<boolean> {
  const libraryDir = join(mediaDir, LIBRARY_FOLDER);
  const current = await readManifest(libraryDir);
  if (!current) return false;
  const { manifest } = current;
  if (manifest.integrity === "hmac-sha256") return digestVerifies(manifest, key); // A concurrent request already upgraded it.
  if (!digestVerifies(manifest, null)) return false;
  if (!manifest.body.assets.every((asset) => asset.provenance === "owner_upload")) return false;
  const nextText = envelopeText(manifest.body, key);
  if (!await libraryAcceptsManifest(mediaDir, nextText, key, manifest.body.assets.map((asset) => asset.id))) return false;
  try { await replaceManifest(libraryDir, current.text, nextText); } catch { return false; }
  return true;
}

/** Removes one asset from the manifest (one atomic rename), then deletes its private file. */
async function removeFromManifest(mediaDir: string, assetId: string, key: Buffer | null): Promise<void> {
  const libraryDir = join(mediaDir, LIBRARY_FOLDER);
  const current = await readManifest(libraryDir);
  if (!current) throw removalUnavailable();
  const { manifest } = current;
  const integrity = manifest.integrity ?? "sha256";
  if ((integrity === "hmac-sha256") !== Boolean(key) || !digestVerifies(manifest, integrity === "hmac-sha256" ? key : null)) throw removalUnavailable();
  const target = manifest.body.assets.find((asset) => asset.id === assetId);
  if (!target) throw new RequestError("Media not found.", 404);
  const body: ManifestBody = { ...manifest.body, updatedAt: new Date().toISOString(), assets: manifest.body.assets.filter((asset) => asset.id !== assetId) };
  const nextText = envelopeText(body, key);
  if (!await libraryAcceptsManifest(mediaDir, nextText, key, body.assets.map((asset) => asset.id))) throw removalUnavailable();
  await replaceManifest(libraryDir, current.text, nextText);
  // Content-addressed: the removed id owns its file alone. A leftover file is unreferenced, never served.
  await unlink(join(libraryDir, "files", target.file)).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Owner media summaries (the only shape that reaches a browser)
// ---------------------------------------------------------------------------

export interface OwnerMediaSummary {
  id: string;
  kind: "image" | "video";
  provenance: "owner_upload";
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number | null;
  bytes: number;
  addedAt: string;
  thumbUrl: string;
}

export function ownerMediaSummary(businessId: string, asset: MediaAssetRecord): OwnerMediaSummary {
  return {
    id: asset.id, kind: asset.kind, provenance: "owner_upload", mimeType: asset.mimeType, width: asset.width, height: asset.height,
    durationSeconds: asset.durationSeconds, bytes: asset.bytes, addedAt: asset.addedAt,
    thumbUrl: `/api/businesses/${encodeURIComponent(businessId)}/media/${encodeURIComponent(asset.id)}/thumb`,
  };
}

export async function listBusinessUploads(businessId: string): Promise<OwnerMediaSummary[]> {
  const library = await openBusinessLibrary(businessId);
  const assets = await library.listAssets({ provenance: "owner_upload" });
  return assets.sort((a, b) => a.addedAt.localeCompare(b.addedAt)).map((asset) => ownerMediaSummary(businessId, asset));
}

// ---------------------------------------------------------------------------
// Raw-body uploads
// ---------------------------------------------------------------------------

export interface UploadRequest {
  mimeType: UploadMimeType;
  kind: "image" | "video";
  maxBytes: number;
  consent: OwnerMediaConsent;
  originalName: string | null;
}

const sizeMessage = (kind: "image" | "video") => kind === "image" ? "Photos must be 20 MB or smaller." : "Videos must be 300 MB or smaller.";

/** Validates the declared type, the consent query parameters and any declared length before reading the body. */
export function parseUploadRequest(request: Request, now: Date = new Date()): UploadRequest {
  const declared = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!Object.hasOwn(UPLOAD_MIME_TYPES, declared)) throw new RequestError("Upload PNG, JPEG or WebP photos, or MP4, MOV or WebM videos, sent with the file's own Content-Type.", 400);
  const mimeType = declared as UploadMimeType;
  const kind = UPLOAD_MIME_TYPES[mimeType];
  const query = new URL(request.url).searchParams;
  const people = query.get("peopleVisible");
  if (query.get("ownsOrLicensedMedia") !== "true" || (people !== "consented" && people !== "no_people")) {
    throw new RequestError("Confirm that you own or are licensed to use this media and whether people shown in it have agreed to appear.", 400);
  }
  const filename = query.get("filename");
  if (filename !== null && filename.length > MAX_FILENAME_PARAM_CHARS) throw new RequestError("The file name is too long.", 400);
  const maxBytes = kind === "image" ? MAX_OWNER_IMAGE_BYTES : MAX_OWNER_VIDEO_BYTES;
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d{1,15}$/.test(length.trim())) throw new RequestError("The upload length is invalid.", 400);
    if (Number(length) > maxBytes) throw new RequestError(sizeMessage(kind), 413);
  }
  return {
    mimeType, kind, maxBytes, originalName: filename,
    consent: { ownsOrLicensedMedia: true, peopleVisibleHaveConsented: people === "no_people" ? "no_people" : true, attestedAt: now.toISOString() },
  };
}

/**
 * Streams a request body into a new randomized 0600 file, aborting as soon as the hard limit is
 * passed. Nothing is kept on failure. The caller owns (and must delete) the returned file.
 */
export async function streamBodyToPrivateFile(body: ReadableStream<Uint8Array> | null, directory: string, maxBytes: number, tooLarge = "The upload is too large."): Promise<{ path: string; bytes: number }> {
  if (!body) throw new RequestError("The upload is empty.", 400);
  const path = join(directory, `incoming_${randomBytes(16).toString("hex")}.part`);
  const file = await open(path, "wx", 0o600);
  const reader = body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch { throw new RequestError("The upload was interrupted. Try again.", 400); }
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestError(tooLarge, 413);
      }
      await file.write(chunk.value);
    }
    if (!bytes) throw new RequestError("The upload is empty.", 400);
    await file.sync();
    await file.close();
    return { path, bytes };
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    if (error instanceof RequestError) throw error;
    throw new RequestError("The upload could not be stored. Check local storage and try again.", 500);
  } finally { reader.releaseLock(); }
}

async function ownerUploadCount(library: MediaLibrary): Promise<number> {
  return (await library.listAssets({ provenance: "owner_upload" })).length;
}

const limitError = () => new RequestError(`This business already has ${MAX_BUSINESS_UPLOADS} uploaded photos and videos. Remove one before adding another.`, 409);

/**
 * One owner upload: limit check, bounded streaming, magic-byte validation and sanitizing
 * (acceptOwnerUpload), then the content-addressed library import. A duplicate returns the
 * existing asset with `created: false`. A thumbnail is prepared best-effort.
 */
export async function addBusinessUpload(businessId: string, request: Request, upload: UploadRequest): Promise<{ asset: OwnerMediaSummary; created: boolean }> {
  const mediaDir = await ensureBusinessMediaDir(businessId);
  if (await ownerUploadCount(await openBusinessLibrary(businessId)) >= MAX_BUSINESS_UPLOADS) throw limitError();
  const incoming = await ensurePrivateSubdir(mediaDir, "incoming");
  const staged = await streamBodyToPrivateFile(request.body, incoming, upload.maxBytes, sizeMessage(upload.kind));
  const accepted: { path: string | null } = { path: null };
  try {
    const result = await withBusinessLock(businessId, async () => {
      const library = await openBusinessLibrary(businessId);
      if (await ownerUploadCount(library) >= MAX_BUSINESS_UPLOADS) throw limitError();
      const record = await acceptOwnerUpload({
        tempPath: staged.path, declaredMimeType: upload.mimeType, originalName: upload.originalName, consent: upload.consent,
        libraryDir: await ensurePrivateSubdir(mediaDir, "accepted"),
      });
      accepted.path = record.path;
      return library.importUpload(record);
    });
    if (result.status === "rejected") {
      if (result.reason === "video_limit") throw new RequestError("This business already has the maximum of 12 uploaded videos. Remove one before adding another.", 409);
      if (result.reason === "asset_limit") throw limitError();
      throw new RequestError("The media could not be added to the library.", 400);
    }
    await businessThumbnail(businessId, result.asset.id).catch(() => undefined);
    return { asset: ownerMediaSummary(businessId, result.asset), created: result.status !== "duplicate" };
  } finally {
    await unlink(staged.path).catch(() => undefined);
    if (accepted.path) await unlink(accepted.path).catch(() => undefined);
  }
}

type RemovableLibrary = MediaLibrary & { removeAsset?: (id: string) => Promise<unknown> };

/**
 * Refuses removal while the durable worker (another process that opens this same library) has a
 * queued or running run for the business, so a campaign never loses an asset mid-production.
 */
async function assertNoActiveRun(businessId: string): Promise<void> {
  const active = await db.run.findFirst({ where: { businessId, status: { in: ["queued", "running"] } }, select: { id: true } });
  if (active) throw new RequestError("Removing media is not available while a campaign is being produced. Try again when it finishes.", 409);
}

/**
 * Removes one owner upload. Uses MediaLibrary.removeAsset when the library provides it; otherwise
 * rewrites only the manifest (removeFromManifest: no media is copied or re-hashed) and deletes the
 * asset's file. Refused with 409 while a run for the business is queued or running.
 */
export async function removeBusinessUpload(businessId: string, assetId: string): Promise<void> {
  requireAssetId(assetId);
  const mediaDir = await ensureBusinessMediaDir(businessId);
  await withBusinessLock(businessId, async () => {
    const library: RemovableLibrary = await openBusinessLibrary(businessId);
    const asset = await library.getAsset(assetId);
    if (!asset || asset.provenance !== "owner_upload") throw new RequestError("Media not found.", 404);
    await assertNoActiveRun(businessId);
    if (typeof library.removeAsset === "function") await library.removeAsset(assetId);
    else await removeFromManifest(mediaDir, assetId, mediaLibraryIntegrityKey());
  });
  await rm(join(mediaDir, "thumbs", `${assetId}.jpg`), { force: true });
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/** Minimal child environment: server credentials never reach FFmpeg. */
function toolEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
  if (process.env.LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH;
  return env;
}

/** One poster frame as PNG from a private local video (file protocol and allowlisted demuxers only). */
export async function videoPosterPng(path: string, durationSeconds: number | null, maxSide = THUMB_MAX_SIDE): Promise<Buffer> {
  const preferred = durationSeconds !== null && durationSeconds > 1.5 ? Math.min(1, durationSeconds / 3) : 0;
  for (const at of preferred > 0 ? [preferred, 0] : [0]) {
    try {
      const { stdout } = await execFileAsync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2",
        "-protocol_whitelist", "file,pipe", "-format_whitelist", DEMUXER_ALLOWLIST,
        "-ss", at.toFixed(3), "-i", `file:${path}`,
        "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1",
        "-vf", `scale=w=${maxSide}:h=${maxSide}:force_original_aspect_ratio=decrease`,
        "-f", "image2pipe", "-c:v", "png", "pipe:1",
      ], { encoding: "buffer", timeout: POSTER_TIMEOUT_MS, maxBuffer: POSTER_MAX_BUFFER, killSignal: "SIGKILL", windowsHide: true, env: toolEnv() });
      if (stdout.length > 8) return stdout;
    } catch { /* Try the first frame next; child errors carry local paths and are never forwarded. */ }
  }
  throw new RequestError("A preview frame could not be read from this video.", 422);
}

/** JPEG thumbnail, long side at most THUMB_MAX_SIDE, without metadata. */
export async function renderThumbnail(asset: Pick<MediaAssetRecord, "kind" | "localPath" | "durationSeconds">): Promise<Buffer> {
  const source = asset.kind === "video" ? await videoPosterPng(asset.localPath, asset.durationSeconds) : asset.localPath;
  try {
    return await sharp(source, { limitInputPixels: 50_000_000, failOn: "error", animated: false })
      .resize({ width: THUMB_MAX_SIDE, height: THUMB_MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
  } catch { throw new RequestError("A preview could not be generated for this media.", 422); }
}

async function readCachedThumb(path: string): Promise<Buffer | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > MAX_THUMB_BYTES) return null;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await handle.readFile();
      return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null;
    } finally { await handle.close(); }
  } catch { return null; }
}

/** Cached per content-addressed asset id; generated from hash-verified bytes on first use. */
export async function businessThumbnail(businessId: string, assetId: string): Promise<Buffer> {
  requireAssetId(assetId);
  const mediaDir = await ensureBusinessMediaDir(businessId);
  const library = await openBusinessLibrary(businessId);
  const listed = await library.getAsset(assetId);
  if (!listed || listed.provenance !== "owner_upload") throw new RequestError("Media not found.", 404);
  const thumbs = await ensurePrivateSubdir(mediaDir, "thumbs");
  const target = join(thumbs, `${assetId}.jpg`);
  const cached = await readCachedThumb(target);
  if (cached) return cached;
  const bytes = await renderThumbnail(await library.verifyAsset(assetId));
  const temporary = join(thumbs, `.${assetId}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    await rename(temporary, target);
  } catch { await unlink(temporary).catch(() => undefined); }
  return bytes;
}

// ---------------------------------------------------------------------------
// Meta connection: attestation record and status
// ---------------------------------------------------------------------------

export const META_CONNECTION_ATTESTATION = "I own or license the media on these accounts, and people shown have agreed to appear in my business's marketing." as const;
const ATTESTATION_KEY_INFO = "tickr/meta-graph/connection-attestation/v1";
const MAX_ATTESTATION_BYTES = 16 * 1024;
const isoDate = z.string().datetime({ offset: true });
const displayName = z.string().max(200).nullable();

const attestationSchema = z.object({
  version: z.literal(1),
  businessId: z.string().refine(isValidBusinessId),
  provider: z.literal("meta"),
  statement: z.literal(META_CONNECTION_ATTESTATION),
  attestedAt: isoDate,
  connectedAt: isoDate,
  accountName: displayName,
  pageName: displayName,
  instagramUsername: displayName,
  mediaSourceCount: z.number().int().nonnegative().max(1000).nullable(),
  tokenLongLived: z.boolean(),
}).strict();
export type MetaAttestationRecord = z.infer<typeof attestationSchema>;
const storedAttestationSchema = z.object({ record: attestationSchema, mac: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export interface ConnectionStoreOptions {
  /** Application-controlled private directory; defaults to `.data/connections`. */
  directory?: string;
  environment?: Environment;
  now?: () => Date;
}

function attestationKey(environment: Environment): Buffer | null {
  const raw = environment[TOKEN_KEY_ENV]?.trim();
  if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) return null;
  const material = Buffer.from(raw, "base64");
  if (material.length !== 32) return null;
  const key = Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), ATTESTATION_KEY_INFO, 32));
  material.fill(0);
  return key;
}

function attestationMac(record: MetaAttestationRecord, key: Buffer): string {
  return createHmac("sha256", key).update(`tickr-meta-attestation-v1\n${JSON.stringify(record)}`).digest("hex");
}

function attestationPath(businessId: string, directory?: string): string {
  if (!isValidBusinessId(businessId)) throw new RequestError("Business not found.", 404);
  return join(resolve(directory ?? defaultConnectionsDirectory()), "attestations", `${businessId}.json`);
}

const cleanName = (value: string | null | undefined) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || null : null;

/** Display names from the owner's connected accounts (DATA, never identity proof). */
export function connectionProfile(sources: OwnerMediaSource[] | null): Pick<MetaAttestationRecord, "accountName" | "pageName" | "instagramUsername" | "mediaSourceCount"> {
  if (!sources) return { accountName: null, pageName: null, instagramUsername: null, mediaSourceCount: null };
  const page = sources.find((source) => source.kind === "facebook_page");
  const instagram = sources.find((source) => source.kind === "instagram_account");
  const pageName = cleanName(page?.kind === "facebook_page" ? page.name : null);
  const instagramUsername = cleanName(instagram?.kind === "instagram_account" ? instagram.username : null);
  return { accountName: instagramUsername ? `@${instagramUsername}`.slice(0, 200) : pageName, pageName, instagramUsername, mediaSourceCount: Math.min(sources.length, 1000) };
}

/** Writes the owner's attestation (HMAC-authenticated, 0600, atomic) next to the encrypted token. */
export async function saveMetaAttestation(
  input: Omit<MetaAttestationRecord, "version" | "provider" | "statement" | "connectedAt"> & { connectedAt?: string },
  options: ConnectionStoreOptions = {},
): Promise<MetaAttestationRecord> {
  const key = attestationKey(options.environment ?? process.env);
  if (!key) throw new GraphTokenError("NOT_CONFIGURED", `${TOKEN_KEY_ENV} must be a 32-byte base64 server secret before Meta connections can be stored.`);
  try {
    const record = attestationSchema.parse({
      version: 1, provider: "meta", statement: META_CONNECTION_ATTESTATION, businessId: input.businessId,
      attestedAt: input.attestedAt, connectedAt: input.connectedAt ?? (options.now?.() ?? new Date()).toISOString(),
      accountName: cleanName(input.accountName), pageName: cleanName(input.pageName), instagramUsername: cleanName(input.instagramUsername),
      mediaSourceCount: input.mediaSourceCount, tokenLongLived: input.tokenLongLived,
    });
    const target = attestationPath(record.businessId, options.directory);
    const directory = resolve(target, "..");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${record.businessId}.${randomBytes(8).toString("hex")}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ record, mac: attestationMac(record, key) })); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
    return record;
  } finally { key.fill(0); }
}

/** The stored attestation, or null when absent, unreadable or not authenticated by the server key. */
export async function readMetaAttestation(businessId: string, options: ConnectionStoreOptions = {}): Promise<MetaAttestationRecord | null> {
  const key = attestationKey(options.environment ?? process.env);
  if (!key) return null;
  try {
    const handle = await open(attestationPath(businessId, options.directory), constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      if ((await handle.stat()).size > MAX_ATTESTATION_BYTES) return null;
      text = await handle.readFile("utf8");
    } finally { await handle.close(); }
    const parsed = storedAttestationSchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.record.businessId !== businessId) return null;
    const expected = Buffer.from(attestationMac(parsed.data.record, key), "hex");
    return timingSafeEqual(expected, Buffer.from(parsed.data.mac, "hex")) ? parsed.data.record : null;
  } catch { return null; } finally { key.fill(0); }
}

/** The consent record carried by owner-connected Instagram/Facebook media. */
export function metaAttestationConsent(record: MetaAttestationRecord): OwnerMediaConsent {
  return { ownsOrLicensedMedia: true, peopleVisibleHaveConsented: true, attestedAt: record.attestedAt };
}

export interface MetaConnectionView {
  status: "not_configured" | "disconnected" | "connected" | "expired";
  provider: "meta";
  accountName: string | null;
  instagramUsername: string | null;
  pageName: string | null;
  expiresAt: string | null;
  mediaCount: number | null;
}

/** Token-free connection status for the intake screen. A token without an authenticated attestation is not a usable connection. */
export async function getMetaConnectionView(businessId: string, options: ConnectionStoreOptions = {}): Promise<MetaConnectionView> {
  const environment = options.environment ?? process.env;
  const base: MetaConnectionView = { status: "not_configured", provider: "meta", accountName: null, instagramUsername: null, pageName: null, expiresAt: null, mediaCount: null };
  if (getMetaConnectorStatus(environment).status !== "ready") return base;
  let token: Awaited<ReturnType<typeof loadOwnerToken>>;
  try { token = await loadOwnerToken(businessId, { directory: options.directory, environment, now: options.now }); }
  catch { return { ...base, status: "expired" }; }
  if (token.status === "not_configured") return base;
  if (token.status === "not_connected") return { ...base, status: "disconnected" };
  const attestation = await readMetaAttestation(businessId, options);
  if (!attestation) return { ...base, status: "disconnected" };
  const profile = { accountName: attestation.accountName, instagramUsername: attestation.instagramUsername, pageName: attestation.pageName };
  if (token.status === "expired") return { ...base, ...profile, status: "expired", expiresAt: token.metadata.expiresAt };
  return { ...base, ...profile, status: "connected", expiresAt: token.record.expiresAt };
}

/** Local disconnect: best-effort Graph-side revoke while the token is usable, then the token and attestation are deleted. */
export async function deleteMetaConnection(businessId: string, options: ConnectionStoreOptions & { revoke?: typeof revokeMetaPermissions } = {}): Promise<{ deleted: boolean; revoked: boolean }> {
  const environment = options.environment ?? process.env;
  let revoked = false;
  if (getMetaConnectorStatus(environment).status === "ready") {
    try {
      const token = await loadOwnerToken(businessId, { directory: options.directory, environment, now: options.now });
      if (token.status === "connected") revoked = (await (options.revoke ?? revokeMetaPermissions)(token.record.accessToken, { environment })).revoked;
    } catch (error) {
      if (!(error instanceof MetaGraphError) && !(error instanceof GraphTokenError)) throw error;
    }
  }
  const { deleted } = await deleteOwnerToken(businessId, { directory: options.directory });
  await deleteMetaAttestation(businessId, options);
  return { deleted, revoked };
}

export async function deleteMetaAttestation(businessId: string, options: Pick<ConnectionStoreOptions, "directory"> = {}): Promise<void> {
  await rm(attestationPath(businessId, options.directory), { force: true });
}

// ---------------------------------------------------------------------------
// OAuth browser binding
// ---------------------------------------------------------------------------

export const META_OAUTH_COOKIE = "tickr_meta_oauth";
export const META_OAUTH_COOKIE_PATH = "/api/connections/meta";

/** HttpOnly nonce cookie that binds the signed state to the browser that started the flow. */
export function oauthNonceCookie(nonce: string | null, secure: boolean, maxAgeSeconds = 600): string {
  const value = nonce ?? "";
  return `${META_OAUTH_COOKIE}=${value}; Path=${META_OAUTH_COOKIE_PATH}; Max-Age=${nonce ? maxAgeSeconds : 0}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

const statePeekSchema = z.object({ b: z.string().refine(isValidBusinessId), i: z.number().int().nonnegative() }).passthrough();

/**
 * Reads the business id and issue time from a state payload WITHOUT authenticating it. Use the
 * business id only to call verifyOAuthState, and the issue time only after verification passed.
 */
export function peekOAuthState(state: unknown): { businessId: string; issuedAt: Date } | null {
  if (typeof state !== "string" || state.length > 1024) return null;
  const match = /^([A-Za-z0-9_-]{16,700})\.[A-Za-z0-9_-]{43}$/.exec(state);
  if (!match) return null;
  try {
    const parsed = statePeekSchema.safeParse(JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")));
    return parsed.success ? { businessId: parsed.data.b, issuedAt: new Date(parsed.data.i) } : null;
  } catch { return null; }
}

export function sameSecret(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * Fixed, honest messages for library-wide states. A key mismatch is far more often a changed or
 * removed TICKR_SECRET_KEY than an attack, so it is described as unverifiable, not as tampering.
 */
export function libraryStateMessage(error: unknown): string | null {
  if (!(error instanceof MediaLibraryError)) return null;
  switch (error.code) {
    case "MANIFEST_KEY_REQUIRED": return "Uploaded media for this business was saved while a server secret (TICKR_SECRET_KEY) was set, and it is not set now. Ask the operator to restore it; nothing was changed.";
    case "MANIFEST_TAMPERED": return "Uploaded media for this business could not be verified with the current server secret. If TICKR_SECRET_KEY was changed, ask the operator to restore the original; nothing was changed.";
    case "MANIFEST_INVALID": case "LIBRARY_INVALID": return "The uploaded-media library for this business could not be read. Ask the operator to check local storage; nothing was changed.";
    case "ASSET_TAMPERED": return "A stored upload no longer matches its recorded content. Remove it and upload the file again.";
    default: return null;
  }
}

/** Maps module errors to fixed, path-free JSON errors. */
export function businessMediaErrorResponse(error: unknown): Response {
  const json = (message: string, status: number) => Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  if (error instanceof RequestError) return json(error.message, error.status);
  if (error instanceof OwnerUploadError) {
    if (error.code === "FILE_TOO_LARGE") return json(error.message, 413);
    if (error.code === "STORAGE_INVALID" || error.code === "STORAGE_FAILED") return json("The media could not be stored. Check local storage and try again.", 500);
    return json(error.message, 400);
  }
  if (error instanceof MediaLibraryError) {
    if (error.code === "FILE_TOO_LARGE") return json(error.message, 413);
    if (error.code === "ASSET_NOT_FOUND") return json("Media not found.", 404);
    const libraryMessage = libraryStateMessage(error);
    if (libraryMessage) return json(libraryMessage, 409);
    return json(error.message, 400);
  }
  if (error instanceof GraphTokenError) return json("The stored Meta connection could not be read; reconnect the account.", 409);
  return json("The request could not be completed. Check local storage and database setup, then try again.", 500);
}

/** Inline bytes with no-store, nosniff, a sandbox CSP and single byte-range support (video scrubbing). */
export function servableBytesResponse(request: Request, bytes: Buffer, contentType: string, filename: string): Response {
  const headers = new Headers({
    "Content-Type": contentType, "Content-Length": String(bytes.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `inline; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    "Content-Security-Policy": "default-src 'none'; sandbox", "Accept-Ranges": "bytes",
  });
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(range.trim());
    const suffix = match && !match[1] && match[2] ? Number(match[2]) : null;
    const start = !match || (!match[1] && !match[2]) ? -1 : suffix !== null ? Math.max(0, bytes.length - suffix) : Number(match[1]);
    const end = suffix === null && match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    if (!match || start < 0 || start >= bytes.length || end < start || suffix === 0) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${bytes.length}`, "Cache-Control": "no-store" } });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers });
  }
  return new Response(new Uint8Array(bytes), { headers });
}
