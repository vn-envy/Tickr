import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import sharp, { type Metadata } from "sharp";
import { z } from "zod";
import type { OwnerMediaConsent } from "./cinema-types";

/**
 * Owner media intake. Bytes are sniffed (never trusted from the declared type or filename),
 * stored under randomized private names, and images are decoded and re-encoded so EXIF/GPS,
 * XMP and IPTC never leave this step. Videos are kept as private originals; lib/media/clip.ts
 * normalizes them (and strips container metadata) before any analysis or rendering.
 */
export const MAX_OWNER_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_OWNER_VIDEO_BYTES = 300 * 1024 * 1024;
export const MAX_OWNER_VIDEO_SECONDS = 600;
const MAX_IMAGE_INPUT_PIXELS = 50_000_000;
const MAX_IMAGE_OUTPUT_EDGE = 4096;
const MIN_MEDIA_EDGE = 160;
const MAX_VIDEO_EDGE = 4096;
const MIN_VIDEO_SECONDS = 0.5;
const SNIFF_BYTES = 64;
const CONSENT_FUTURE_SKEW_MS = 5 * 60_000;
const CONSENT_MAX_AGE_MS = 24 * 60 * 60_000;
const run = promisify(execFile);

export type OwnerImageContainer = "png" | "jpeg" | "webp";
export type OwnerVideoContainer = "mp4" | "mov" | "webm";
export type SniffedMedia =
  | { kind: "image"; container: OwnerImageContainer; mimeType: "image/png" | "image/jpeg" | "image/webp" }
  | { kind: "video"; container: OwnerVideoContainer; mimeType: "video/mp4" | "video/quicktime" | "video/webm" };

export class OwnerUploadError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OwnerUploadError";
  }
}

export interface OwnerUploadInput {
  /** Exactly one of bytes or tempPath. tempPath must be an absolute, application-controlled staging file. */
  bytes?: Buffer;
  tempPath?: string;
  declaredMimeType: string;
  /** Display-only. Never used to build a storage path or to decide the media type. */
  originalName?: string | null;
  consent: OwnerMediaConsent;
  /** Application-controlled private directory (normally under ignored .data/). */
  libraryDir: string;
}

export interface OwnerUploadRecord {
  version: 1;
  id: string;
  kind: "image" | "video";
  container: OwnerImageContainer | OwnerVideoContainer;
  mimeType: SniffedMedia["mimeType"];
  /** SHA-256 of the stored bytes (the sanitized image, or the private video original). */
  sha256: string;
  bytes: number;
  originalSha256: string;
  originalBytes: number;
  width: number;
  height: number;
  durationSeconds: number | null;
  videoCodec: string | null;
  hasAudio: boolean | null;
  /** Absolute private path. Never exported or sent to a browser. */
  path: string;
  /** Sanitized display label from the owner's file name; data, not a caption or claim. */
  originalName: string | null;
  processing: "sanitized_reencoded_image" | "original_pending_normalization";
  provenance: "owner_upload";
  rights: "owner_attested";
  consent: OwnerMediaConsent;
  receivedAt: string;
}

const ISO_BMFF_MP4_BRANDS = /^(?:isom|iso[2-9]|mp41|mp42|avc1|M4V |M4VH|M4VP|mmp4|dash|MSNV|f4v )$/;
const HEIF_BRANDS = /^(?:heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/;

/** Magic-byte detection. Returns "heic"/"avif" for recognised but unsupported HEIF images, null otherwise. */
export function sniffMediaType(head: Buffer): SniffedMedia | "heic" | "avif" | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", container: "png", mimeType: "image/png" };
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "image", container: "jpeg", mimeType: "image/jpeg" };
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return { kind: "image", container: "webp", mimeType: "image/webp" };
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") {
    const brand = head.toString("latin1", 8, 12);
    if (brand === "qt  ") return { kind: "video", container: "mov", mimeType: "video/quicktime" };
    if (ISO_BMFF_MP4_BRANDS.test(brand)) return { kind: "video", container: "mp4", mimeType: "video/mp4" };
    if (HEIF_BRANDS.test(brand)) return "heic";
    if (brand === "avif" || brand === "avis") return "avif";
    return null;
  }
  // EBML header; the DocType must say webm (generic Matroska is not accepted).
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3 && head.subarray(0, SNIFF_BYTES).includes(Buffer.from("webm", "latin1"))) {
    return { kind: "video", container: "webm", mimeType: "video/webm" };
  }
  return null;
}

const DECLARED_TYPES: Record<string, SniffedMedia["mimeType"] | "heic" | "avif"> = {
  "image/png": "image/png", "image/jpeg": "image/jpeg", "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "image/webp": "image/webp",
  "video/mp4": "video/mp4", "video/quicktime": "video/quicktime", "video/webm": "video/webm",
  "image/heic": "heic", "image/heif": "heic", "image/heic-sequence": "heic", "image/heif-sequence": "heic", "image/avif": "avif",
};

/**
 * Generic types some Android share sheets and drag-and-drop paths send. They declare nothing, so
 * the sniffed type stands (still followed by the full decode or ffprobe validation).
 */
const UNDECLARED_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/x-binary", "application/unknown"]);

/** A specific declared MIME type must name the same format family as the bytes. MP4/MOV share ISO-BMFF framing. */
function assertDeclaredMatches(declaredMimeType: string, sniffed: SniffedMedia) {
  const normalized = declaredMimeType.split(";")[0].trim().toLowerCase();
  if (UNDECLARED_TYPES.has(normalized)) return;
  const declared = DECLARED_TYPES[normalized];
  if (declared === "heic" || declared === "avif") throw heicError();
  if (!declared) throw new OwnerUploadError("TYPE_NOT_ALLOWED", "Upload PNG, JPEG or WebP photos, or MP4, MOV or WebM videos.");
  const isoBmff = (type: string) => type === "video/mp4" || type === "video/quicktime";
  if (declared !== sniffed.mimeType && !(isoBmff(declared) && isoBmff(sniffed.mimeType))) {
    throw new OwnerUploadError("TYPE_MISMATCH", "The file contents do not match the declared file type.");
  }
}

function heicError() {
  return new OwnerUploadError("HEIC_NOT_SUPPORTED", "HEIC/HEIF and AVIF photos cannot be decoded by this build. Export the photo as JPEG (on iPhone: Settings > Camera > Formats > Most Compatible) and upload it again.");
}

const consentSchema = z.object({
  ownsOrLicensedMedia: z.literal(true),
  peopleVisibleHaveConsented: z.union([z.boolean(), z.literal("no_people")]),
  attestedAt: z.string().datetime({ offset: true }),
}).strict();

/** Validates the owner's attestation. It is a record of what the owner stated, not a legal review. */
export function validateOwnerConsent(consent: unknown, now = Date.now()): OwnerMediaConsent {
  const parsed = consentSchema.safeParse(consent);
  if (!parsed.success) throw new OwnerUploadError("CONSENT_REQUIRED", "Confirm that you own or are licensed to use this media and whether people shown in it have consented.");
  const attested = Date.parse(parsed.data.attestedAt);
  if (!Number.isFinite(attested) || attested > now + CONSENT_FUTURE_SKEW_MS || attested < now - CONSENT_MAX_AGE_MS) {
    throw new OwnerUploadError("CONSENT_REQUIRED", "The media consent confirmation is missing or expired; confirm it again with this upload.");
  }
  return { ...parsed.data, attestedAt: new Date(attested).toISOString() };
}

/** Display label only. Path separators, controls and bidi overrides are removed. */
export function sanitizeOriginalName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const cleaned = basename(name.replace(/\\/g, "/")).normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 120);
  return cleaned || null;
}

/** Resolves an application-controlled private directory and a randomized file inside it. */
export async function privateStoragePath(directory: string, prefix: string, extension: string): Promise<string> {
  if (typeof directory !== "string" || !isAbsolute(directory)) throw new OwnerUploadError("STORAGE_INVALID", "Media storage is not configured correctly.");
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(prefix) || !/^[a-z0-9]{2,5}$/.test(extension)) throw new OwnerUploadError("STORAGE_INVALID", "Media storage is not configured correctly.");
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new OwnerUploadError("STORAGE_INVALID", "Media storage is not configured correctly.");
  const path = join(root, `${prefix}_${randomBytes(16).toString("hex")}.${extension}`);
  if (!path.startsWith(root + sep)) throw new OwnerUploadError("STORAGE_INVALID", "Media storage is not configured correctly.");
  return path;
}

const EXTENSIONS: Record<SniffedMedia["container"], string> = { png: "png", jpeg: "jpg", webp: "webp", mp4: "mp4", mov: "mov", webm: "webm" };
export const mediaExtension = (container: SniffedMedia["container"]) => EXTENSIONS[container];

async function writePrivate(path: string, bytes: Buffer) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

/**
 * Decodes within a pixel limit, auto-orients, bounds the long edge and re-encodes in the same
 * format. Sharp writes no EXIF/XMP/IPTC unless asked to, so GPS and device metadata are dropped.
 */
export async function sanitizeOwnerImage(bytes: Buffer, container: OwnerImageContainer): Promise<{ bytes: Buffer; width: number; height: number }> {
  const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_INPUT_PIXELS, animated: false, failOn: "error" });
  let metadata: Metadata;
  try { metadata = await image.metadata(); } catch { throw new OwnerUploadError("IMAGE_DECODE_FAILED", "The photo could not be decoded within the size limit."); }
  if (metadata.format !== container) throw new OwnerUploadError("TYPE_MISMATCH", "The file contents do not match the declared file type.");
  if ((metadata.pages ?? 1) > 1) throw new OwnerUploadError("IMAGE_ANIMATED", "Animated images are not supported; upload a still photo or a video.");
  if (!metadata.width || !metadata.height || Math.min(metadata.width, metadata.height) < MIN_MEDIA_EDGE || metadata.width * metadata.height > MAX_IMAGE_INPUT_PIXELS) {
    throw new OwnerUploadError("IMAGE_DIMENSIONS_NOT_ALLOWED", `Photos must be at least ${MIN_MEDIA_EDGE} pixels on each side and at most 50 megapixels.`);
  }
  try {
    const pipeline = image.autoOrient().resize({ width: MAX_IMAGE_OUTPUT_EDGE, height: MAX_IMAGE_OUTPUT_EDGE, fit: "inside", withoutEnlargement: true });
    const encoded = container === "jpeg" ? pipeline.jpeg({ quality: 92, mozjpeg: true })
      : container === "png" ? pipeline.png({ compressionLevel: 9 })
        : pipeline.webp({ quality: 92 });
    const result = await encoded.toBuffer({ resolveWithObject: true });
    const check = await sharp(result.data).metadata();
    if (check.exif || check.xmp || check.iptc) throw new OwnerUploadError("IMAGE_METADATA_RETAINED", "The photo could not be stripped of private metadata.");
    if (result.data.length > MAX_OWNER_IMAGE_BYTES) throw new OwnerUploadError("FILE_TOO_LARGE", "The processed photo exceeded the 20 MB limit.");
    return { bytes: result.data, width: result.info.width, height: result.info.height };
  } catch (error) {
    if (error instanceof OwnerUploadError) throw error;
    throw new OwnerUploadError("IMAGE_DECODE_FAILED", "The photo could not be processed safely.");
  }
}

const probeSchema = z.object({
  streams: z.array(z.object({
    codec_type: z.string().optional(),
    codec_name: z.string().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    tags: z.record(z.string(), z.string()).optional(),
    side_data_list: z.array(z.object({ rotation: z.union([z.number(), z.string()]).optional() }).passthrough()).optional(),
  }).passthrough()).max(64),
  format: z.object({ format_name: z.string(), duration: z.string().optional() }).passthrough(),
}).passthrough();

const VIDEO_CODECS = new Set(["h264", "hevc", "mpeg4", "vp8", "vp9", "av1"]);

export interface OwnerVideoProbe { width: number; height: number; durationSeconds: number; videoCodec: string; hasAudio: boolean }

/** Local ffprobe (file protocol only, bounded output and time). Width/height are display orientation. */
export async function probeOwnerVideo(path: string, container: OwnerVideoContainer): Promise<OwnerVideoProbe> {
  if (!isAbsolute(path)) throw new OwnerUploadError("STORAGE_INVALID", "Media storage is not configured correctly.");
  let parsed: z.infer<typeof probeSchema>;
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-protocol_whitelist", "file",
      "-show_entries", "stream=codec_type,codec_name,width,height:stream_tags=rotate:stream_side_data=rotation:format=format_name,duration",
      "-of", "json", `file:${path}`,
    ], { timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true });
    parsed = probeSchema.parse(JSON.parse(stdout));
  } catch {
    throw new OwnerUploadError("VIDEO_DECODE_FAILED", "The video could not be read. Upload an MP4, MOV or WebM file.");
  }
  const formats = parsed.format.format_name.split(",");
  if (container === "webm" ? !formats.includes("webm") : !formats.includes("mp4") && !formats.includes("mov")) {
    throw new OwnerUploadError("TYPE_MISMATCH", "The file contents do not match the declared file type.");
  }
  const video = parsed.streams.find((stream) => stream.codec_type === "video");
  if (!video?.codec_name || !VIDEO_CODECS.has(video.codec_name) || !video.width || !video.height) {
    throw new OwnerUploadError("VIDEO_CODEC_NOT_ALLOWED", "The video must contain an H.264, HEVC, MPEG-4, VP8, VP9 or AV1 picture track.");
  }
  const durationSeconds = Number(parsed.format.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds < MIN_VIDEO_SECONDS || durationSeconds > MAX_OWNER_VIDEO_SECONDS) {
    throw new OwnerUploadError("VIDEO_DURATION_NOT_ALLOWED", `Videos must be between ${MIN_VIDEO_SECONDS} seconds and ${MAX_OWNER_VIDEO_SECONDS / 60} minutes long.`);
  }
  if (Math.min(video.width, video.height) < MIN_MEDIA_EDGE || Math.max(video.width, video.height) > MAX_VIDEO_EDGE) {
    throw new OwnerUploadError("VIDEO_DIMENSIONS_NOT_ALLOWED", `Videos must be between ${MIN_MEDIA_EDGE} and ${MAX_VIDEO_EDGE} pixels on each side.`);
  }
  const rotation = Number(video.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
  const quarterTurn = Number.isFinite(rotation) && Math.abs(Math.round(rotation / 90)) % 2 === 1;
  return {
    width: quarterTurn ? video.height : video.width,
    height: quarterTurn ? video.width : video.height,
    durationSeconds: Math.round(durationSeconds * 1000) / 1000,
    videoCodec: video.codec_name,
    hasAudio: parsed.streams.some((stream) => stream.codec_type === "audio"),
  };
}

/** Opens a regular, non-symlink staging file and returns its size and leading bytes. */
async function inspectTempFile(tempPath: string) {
  if (typeof tempPath !== "string" || !isAbsolute(tempPath)) throw new OwnerUploadError("UPLOAD_INVALID", "The upload could not be read.");
  let info;
  try { info = await lstat(tempPath); } catch { throw new OwnerUploadError("UPLOAD_INVALID", "The upload could not be read."); }
  if (!info.isFile() || info.isSymbolicLink()) throw new OwnerUploadError("UPLOAD_INVALID", "The upload could not be read.");
  const file = await open(tempPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new OwnerUploadError("UPLOAD_INVALID", "The upload could not be read."); });
  try {
    const head = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await file.read(head, 0, SNIFF_BYTES, 0);
    return { size: info.size, head: head.subarray(0, bytesRead) };
  } finally { await file.close(); }
}

async function readBounded(tempPath: string, maxBytes: number): Promise<Buffer> {
  const file = await open(tempPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw sizeError("image");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally { await file.close(); }
}

/** Streams a file into a new private destination while hashing, enforcing the byte limit throughout. */
export async function copyPrivateHashed(source: string, destination: string, maxBytes: number): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let total = 0;
  const target = await open(destination, "wx", 0o600);
  try {
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stream = handle.createReadStream({ highWaterMark: 1024 * 1024 });
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > maxBytes) { stream.destroy(); throw new OwnerUploadError("FILE_TOO_LARGE", "The file exceeded its size limit."); }
      hash.update(chunk);
      await target.write(chunk);
    }
    await target.sync();
  } catch (error) {
    await target.close().catch(() => undefined);
    await unlink(destination).catch(() => undefined);
    if (error instanceof OwnerUploadError) throw error;
    throw new OwnerUploadError("STORAGE_FAILED", "The media could not be stored.");
  }
  await target.close();
  return { sha256: hash.digest("hex"), bytes: total };
}

function sizeError(kind: "image" | "video") {
  return new OwnerUploadError("FILE_TOO_LARGE", kind === "image" ? "Photos must be 20 MB or smaller." : "Videos must be 300 MB or smaller.");
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * Accepts one owner photo or video. Consent is required, the type comes from magic bytes and must
 * match the declared type, storage names are random, and failures leave no stored file behind.
 */
export async function acceptOwnerUpload(input: OwnerUploadInput): Promise<OwnerUploadRecord> {
  const consent = validateOwnerConsent(input.consent);
  if ((input.bytes === undefined) === (input.tempPath === undefined)) throw new OwnerUploadError("UPLOAD_INVALID", "The upload could not be read.");
  if (input.bytes !== undefined && !Buffer.isBuffer(input.bytes)) throw new OwnerUploadError("UPLOAD_INVALID", "The upload could not be read.");
  const staged = input.bytes ? { size: input.bytes.length, head: input.bytes.subarray(0, SNIFF_BYTES) } : await inspectTempFile(input.tempPath!);
  if (!staged.size) throw new OwnerUploadError("UPLOAD_INVALID", "The upload is empty.");
  const sniffed = sniffMediaType(staged.head);
  if (sniffed === "heic" || sniffed === "avif") throw heicError();
  if (!sniffed) throw new OwnerUploadError("TYPE_NOT_ALLOWED", "Upload PNG, JPEG or WebP photos, or MP4, MOV or WebM videos.");
  assertDeclaredMatches(typeof input.declaredMimeType === "string" ? input.declaredMimeType : "", sniffed);
  if (staged.size > (sniffed.kind === "image" ? MAX_OWNER_IMAGE_BYTES : MAX_OWNER_VIDEO_BYTES)) throw sizeError(sniffed.kind);
  const base = { version: 1 as const, provenance: "owner_upload" as const, rights: "owner_attested" as const, consent, originalName: sanitizeOriginalName(input.originalName), receivedAt: new Date().toISOString() };

  if (sniffed.kind === "image") {
    const original = input.bytes ?? await readBounded(input.tempPath!, MAX_OWNER_IMAGE_BYTES);
    if (original.length > MAX_OWNER_IMAGE_BYTES) throw sizeError("image");
    const sanitized = await sanitizeOwnerImage(original, sniffed.container);
    const path = await privateStoragePath(input.libraryDir, "owner", mediaExtension(sniffed.container));
    try { await writePrivate(path, sanitized.bytes); } catch { await unlink(path).catch(() => undefined); throw new OwnerUploadError("STORAGE_FAILED", "The media could not be stored."); }
    const digest = sha256(sanitized.bytes);
    return {
      ...base, id: `upload_${digest.slice(0, 24)}`, kind: "image", container: sniffed.container, mimeType: sniffed.mimeType,
      sha256: digest, bytes: sanitized.bytes.length, originalSha256: sha256(original), originalBytes: original.length,
      width: sanitized.width, height: sanitized.height, durationSeconds: null, videoCodec: null, hasAudio: null,
      path, processing: "sanitized_reencoded_image",
    };
  }

  const path = await privateStoragePath(input.libraryDir, "owner", mediaExtension(sniffed.container));
  try {
    let stored: { sha256: string; bytes: number };
    if (input.bytes) { await writePrivate(path, input.bytes); stored = { sha256: sha256(input.bytes), bytes: input.bytes.length }; }
    else stored = await copyPrivateHashed(input.tempPath!, path, MAX_OWNER_VIDEO_BYTES);
    // Probe the stored copy, not the staging file, so validation covers exactly the kept bytes.
    const head = Buffer.alloc(SNIFF_BYTES);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.read(head, 0, SNIFF_BYTES, 0); } finally { await handle.close(); }
    const again = sniffMediaType(head);
    if (!again || typeof again === "string" || again.mimeType !== sniffed.mimeType) throw new OwnerUploadError("TYPE_MISMATCH", "The file contents do not match the declared file type.");
    const probe = await probeOwnerVideo(path, sniffed.container as OwnerVideoContainer);
    return {
      ...base, id: `upload_${stored.sha256.slice(0, 24)}`, kind: "video", container: sniffed.container, mimeType: sniffed.mimeType,
      sha256: stored.sha256, bytes: stored.bytes, originalSha256: stored.sha256, originalBytes: stored.bytes,
      width: probe.width, height: probe.height, durationSeconds: probe.durationSeconds, videoCodec: probe.videoCodec, hasAudio: probe.hasAudio,
      path, processing: "original_pending_normalization",
    };
  } catch (error) {
    await unlink(path).catch(() => undefined);
    if (error instanceof OwnerUploadError) throw error;
    throw new OwnerUploadError("STORAGE_FAILED", "The media could not be stored.");
  }
}
