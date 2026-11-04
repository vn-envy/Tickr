import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { FrameMask, MaskletReader, MaskletSet, PixelBounds, TrackPoint, TrackedObjectSummary } from "./cinema-types";

/**
 * Private, hash-verified storage for SAM video masklets.
 *
 * Layout inside one store directory (normally under ignored `.data/`):
 * - `masks-<objectId>.bin`: concatenated packed one-bit rasters for one object, one per present
 *   frame in ascending frame order. Bits are row-major over the mask's own bounds, most
 *   significant bit first; trailing pad bits are zero.
 * - `masklets.json`: the MaskletSet plus, per object, the file hash/size and a frame index
 *   (frame → byteOffset, byteLength, bounds, confidence, foreground pixel count).
 *
 * Binary files are published before the index (pending file → fsync → rename) and the index is
 * the commit point: a reader verifies the schema, the clip binding, every file's size and SHA-256
 * and the index/summary consistency before serving any mask, and fails closed on any mismatch.
 * Masks are selections of real clip pixels; nothing here verifies product identity.
 */
export const MASKLET_INDEX_FILE = "masklets.json";
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_FRAMES = 15_000;
const MAX_STORE_OBJECTS = 32;
const MAX_DIMENSION = 8192;
const objectIdPattern = /^\d{1,20}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const maskFileName = (objectId: string) => `masks-${objectId}.bin`;

export class MaskletStoreError extends Error {
  readonly code: "MASKLETS_MISSING" | "MASKLETS_INVALID";
  constructor(code: MaskletStoreError["code"], message: string) { super(message); this.name = "MaskletStoreError"; this.code = code; }
}
const invalid = (message = "The masklet store failed its integrity check.") => new MaskletStoreError("MASKLETS_INVALID", message);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

// ---------------------------------------------------------------- bit packing and track math

/** Pack a 0/1 raster into bytes, row-major, most significant bit first. Throws on nonbinary input. */
export function packMaskBits(raster: Uint8Array): Buffer {
  const packed = Buffer.alloc(Math.ceil(raster.length / 8));
  for (let index = 0; index < raster.length; index++) {
    const value = raster[index];
    if (value === 1) packed[index >> 3] |= 0x80 >> (index & 7);
    else if (value !== 0) throw invalid("Masks must be binary rasters.");
  }
  return packed;
}

/** Unpack `pixelCount` bits. Throws when the byte length disagrees or a pad bit is set. */
export function unpackMaskBits(packed: Uint8Array, pixelCount: number): Uint8Array {
  if (!Number.isSafeInteger(pixelCount) || pixelCount < 0 || packed.length !== Math.ceil(pixelCount / 8)) throw invalid();
  const raster = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index++) raster[index] = (packed[index >> 3] >> (7 - (index & 7))) & 1;
  const padBits = packed.length * 8 - pixelCount;
  if (padBits && packed[packed.length - 1] & ((1 << padBits) - 1)) throw invalid();
  return raster;
}

function checkBounds(bounds: PixelBounds, clip: { width: number; height: number }) {
  const { left, top, right, bottom } = bounds;
  if (![left, top, right, bottom].every(Number.isSafeInteger) || left < 0 || top < 0 || right > clip.width || bottom > clip.height || right <= left || bottom <= top) {
    throw invalid("A mask falls outside its clip or has no area.");
  }
}

/**
 * Track point of one frame mask: foreground area and centroid in continuous clip-pixel
 * coordinates (pixel (x, y) covers [x, x+1) × [y, y+1), so its centre is x + 0.5).
 * Returns null for an empty mask. Bounds are the mask's own half-open crop bounds.
 */
export function trackPointOf(mask: FrameMask): TrackPoint | null {
  const { left, top, right, bottom } = mask.bounds;
  const width = right - left, height = bottom - top;
  if (!Number.isSafeInteger(width * height) || width <= 0 || height <= 0 || mask.raster.length !== width * height) throw invalid("Mask raster dimensions disagree with its bounds.");
  let area = 0, sumX = 0, sumY = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = mask.raster[y * width + x];
    if (value === 1) { area++; sumX += x; sumY += y; }
    else if (value !== 0) throw invalid("Masks must be binary rasters.");
  }
  if (!area) return null;
  return { frame: mask.frame, cx: left + sumX / area + .5, cy: top + sumY / area + .5, area, bounds: { left, top, right, bottom }, confidence: mask.confidence };
}

/** Summarize one object's present frames. Points must be non-empty, distinct and ascending by frame. */
export function summarizeTrack(input: { objectId: string; label: string; origin: TrackedObjectSummary["origin"]; points: readonly TrackPoint[]; clip: { width: number; height: number } }): TrackedObjectSummary {
  const { points, clip } = input;
  if (!points.length || points.some((point, index) => index > 0 && point.frame <= points[index - 1].frame)) throw invalid("A track needs present frames in ascending order.");
  const frameArea = clip.width * clip.height;
  const confidences = points.map((point) => point.confidence).filter((value): value is number => value !== null);
  return {
    objectId: input.objectId, label: input.label, origin: input.origin,
    firstFrame: points[0].frame, lastFrame: points[points.length - 1].frame, framesPresent: points.length,
    meanCoverage: points.reduce((sum, point) => sum + point.area, 0) / points.length / frameArea,
    meanConfidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
    track: points.map((point) => ({ ...point, bounds: { ...point.bounds } })),
  };
}

// ---------------------------------------------------------------- schemas

const int = z.number().int();
const boundsSchema = z.object({ left: int.nonnegative(), top: int.nonnegative(), right: int.positive(), bottom: int.positive() }).strict();
const confidenceSchema = z.number().min(0).max(1).nullable();
const trackPointSchema = z.object({ frame: int.nonnegative(), cx: z.number().finite(), cy: z.number().finite(), area: int.positive(), bounds: boundsSchema, confidence: confidenceSchema }).strict();
const summarySchema = z.object({
  objectId: z.string().regex(objectIdPattern), label: z.string().min(1).max(200), origin: z.enum(["owner_tap", "spark_grounding", "concept_prompt", "local_layout"]),
  firstFrame: int.nonnegative(), lastFrame: int.nonnegative(), framesPresent: int.positive(), meanCoverage: z.number().min(0).max(1),
  meanConfidence: confidenceSchema, track: z.array(trackPointSchema).min(1).max(MAX_FRAMES),
}).strict();
const setSchema = z.object({
  version: z.literal(1), model: z.literal("sam-3.1"), responseId: z.string().min(1).max(200),
  clip: z.object({ sha256: z.string().regex(hashPattern), width: int.min(1).max(MAX_DIMENSION), height: int.min(1).max(MAX_DIMENSION), fps: z.number().finite().positive().max(1000), frameCount: int.min(1).max(MAX_FRAMES) }).strict(),
  promptKind: z.enum(["geometry", "concept"]), propagation: z.enum(["forward", "backward", "both"]),
  objects: z.array(summarySchema).max(MAX_STORE_OBJECTS), framesBilled: int.nonnegative().nullable(), elapsedMs: int.nonnegative(), createdAt: z.string().datetime(),
  provenance: z.object({ kind: z.literal("meta_video_segmentation"), semanticIdentityVerified: z.literal(false), requiresReview: z.literal(true) }).strict(),
}).strict();
const entrySchema = z.object({ frame: int.nonnegative(), byteOffset: int.nonnegative(), byteLength: int.positive(), bounds: boundsSchema, confidence: confidenceSchema, pixels: int.positive() }).strict();
const fileSchema = z.object({ objectId: z.string().regex(objectIdPattern), file: z.string(), bytes: int.positive(), sha256: z.string().regex(hashPattern), entries: z.array(entrySchema).min(1).max(MAX_FRAMES) }).strict();
/** Adapter-level binding stored next to the set so a completed store can be reused offline. */
const bindingSchema = z.object({
  inputHash: z.string().regex(hashPattern).nullable(),
  usage: z.record(z.string().regex(/^[A-Za-z0-9_.]{1,80}$/), z.number().finite().nonnegative()).refine((value) => Object.keys(value).length <= 64),
  unmatchedPromptIds: z.array(int.min(0).max(15)).max(16),
}).strict();
const documentSchema = z.object({ version: z.literal(1), kind: z.literal("tickr_masklets"), binding: bindingSchema, set: setSchema, files: z.array(fileSchema).max(MAX_STORE_OBJECTS) }).strict();
export type MaskletStoreBinding = z.infer<typeof bindingSchema>;
type MaskletDocument = z.infer<typeof documentSchema>;
type IndexEntry = z.infer<typeof entrySchema>;

/** Every structural invariant that does not need file contents. Throws MASKLETS_INVALID. */
function checkDocument(document: MaskletDocument) {
  const { clip } = document.set;
  if (document.files.length !== document.set.objects.length) throw invalid();
  const ids = new Set<string>();
  for (const [index, summary] of document.set.objects.entries()) {
    const file = document.files[index];
    if (ids.has(summary.objectId) || file.objectId !== summary.objectId || file.file !== maskFileName(summary.objectId)) throw invalid();
    ids.add(summary.objectId);
    if (summary.track.length !== file.entries.length || summary.framesPresent !== file.entries.length
      || summary.firstFrame !== file.entries[0].frame || summary.lastFrame !== file.entries[file.entries.length - 1].frame) throw invalid();
    let offset = 0;
    for (const [position, entry] of file.entries.entries()) {
      checkBounds(entry.bounds, clip);
      const pixelCount = (entry.bounds.right - entry.bounds.left) * (entry.bounds.bottom - entry.bounds.top);
      const point = summary.track[position];
      if (entry.frame >= clip.frameCount || (position > 0 && entry.frame <= file.entries[position - 1].frame) || entry.byteOffset !== offset
        || entry.byteLength !== Math.ceil(pixelCount / 8) || entry.pixels > pixelCount
        || point.frame !== entry.frame || point.area !== entry.pixels || point.confidence !== entry.confidence
        || (["left", "top", "right", "bottom"] as const).some((key) => point.bounds[key] !== entry.bounds[key])
        || point.cx < entry.bounds.left || point.cx > entry.bounds.right || point.cy < entry.bounds.top || point.cy > entry.bounds.bottom) throw invalid();
      offset += entry.byteLength;
    }
    if (offset !== file.bytes) throw invalid();
  }
}

// ---------------------------------------------------------------- file helpers

async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function openRegular(path: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!(await handle.stat()).isFile()) throw invalid(); return handle; }
  catch (error) { await handle.close(); throw error; }
}

async function createPending(path: string): Promise<FileHandle> {
  try { await unlink(path); } catch (error) { if (!missing(error)) throw error; }
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
}

async function hashFile(path: string, expectedBytes: number): Promise<string> {
  const handle = await openRegular(path);
  try {
    if ((await handle.stat()).size !== expectedBytes) throw invalid();
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > expectedBytes) throw invalid();
      hash.update(chunk.subarray(0, bytesRead));
    }
    if (total !== expectedBytes) throw invalid();
    return hash.digest("hex");
  } finally { await handle.close(); }
}

async function checkStoreDirectory(directory: string) {
  try { if (!(await lstat(directory)).isDirectory()) throw invalid(); }
  catch (error) {
    if (missing(error)) throw new MaskletStoreError("MASKLETS_MISSING", "No masklet store exists for this clip.");
    throw error instanceof MaskletStoreError ? error : invalid();
  }
}

// ---------------------------------------------------------------- reader

function createReader(root: string, document: MaskletDocument): MaskletReader {
  const index = new Map(document.files.map((file) => [file.objectId, { file, frames: new Map(file.entries.map((entry) => [entry.frame, entry])) }]));
  const set = document.set;
  return {
    set,
    async frameMask(objectId, frame) {
      const object = index.get(objectId);
      if (!object) throw new MaskletStoreError("MASKLETS_INVALID", "The requested object is not part of this masklet set.");
      if (!Number.isSafeInteger(frame) || frame < 0 || frame >= set.clip.frameCount) throw new MaskletStoreError("MASKLETS_INVALID", "The requested frame lies outside the clip.");
      const entry: IndexEntry | undefined = object.frames.get(frame);
      if (!entry) return null;
      checkBounds(entry.bounds, set.clip);
      let handle: FileHandle;
      try { handle = await openRegular(join(root, object.file.file)); }
      catch (error) { throw error instanceof MaskletStoreError ? error : invalid(); }
      try {
        if ((await handle.stat()).size !== object.file.bytes) throw invalid();
        const packed = Buffer.alloc(entry.byteLength);
        const { bytesRead } = await handle.read(packed, 0, entry.byteLength, entry.byteOffset);
        if (bytesRead !== entry.byteLength) throw invalid();
        const { left, top, right, bottom } = entry.bounds;
        const raster = unpackMaskBits(packed, (right - left) * (bottom - top));
        let pixels = 0;
        for (const value of raster) pixels += value;
        if (pixels !== entry.pixels) throw invalid();
        return { objectId, frame, bounds: { left, top, right, bottom }, confidence: entry.confidence, raster };
      } catch (error) { throw error instanceof MaskletStoreError ? error : invalid(); }
      finally { await handle.close(); }
    },
  };
}

/**
 * Open and fully verify a masklet store (schema, clip binding, file sizes and hashes, index and
 * summary consistency) and return it with its adapter binding. MASKLETS_MISSING means no index exists.
 */
export async function readMaskletStore(directory: string, expected: { clipSha256: string; inputHash?: string }): Promise<{ reader: MaskletReader; binding: MaskletStoreBinding }> {
  if (!hashPattern.test(expected.clipSha256) || (expected.inputHash !== undefined && !hashPattern.test(expected.inputHash))) throw invalid("A masklet store must be opened with a SHA-256 clip binding.");
  const root = resolve(directory);
  await checkStoreDirectory(root);
  let handle: FileHandle;
  try { handle = await openRegular(join(root, MASKLET_INDEX_FILE)); }
  catch (error) {
    if (missing(error)) throw new MaskletStoreError("MASKLETS_MISSING", "No masklet store exists for this clip.");
    throw error instanceof MaskletStoreError ? error : invalid();
  }
  let document: MaskletDocument;
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_INDEX_BYTES) throw invalid();
    const bytes = await handle.readFile();
    if (bytes.length > MAX_INDEX_BYTES) throw invalid();
    document = documentSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch { throw invalid(); }
  finally { await handle.close(); }
  checkDocument(document);
  if (document.set.clip.sha256 !== expected.clipSha256) throw invalid("The masklet store belongs to different clip bytes.");
  if (expected.inputHash !== undefined && document.binding.inputHash !== expected.inputHash) throw invalid("The masklet store belongs to a different segmentation request.");
  for (const file of document.files) {
    let digest: string;
    try { digest = await hashFile(join(root, file.file), file.bytes); }
    catch { throw invalid(); }
    if (digest !== file.sha256) throw invalid();
  }
  return { reader: createReader(root, document), binding: document.binding };
}

/** Open a verified masklet store bound to the exact clip bytes. */
export async function openMaskletStore(directory: string, expectedClipSha256: string): Promise<MaskletReader> {
  return (await readMaskletStore(directory, { clipSha256: expectedClipSha256 })).reader;
}

// ---------------------------------------------------------------- writer

export interface MaskletObjectIdentity { label: string; origin: TrackedObjectSummary["origin"] }
export interface MaskletCommit {
  /** Local label/origin for each written object id. Missing identities fail the commit. */
  identity: (objectId: string) => MaskletObjectIdentity | undefined;
  set: Omit<MaskletSet, "version" | "model" | "clip" | "objects" | "provenance">;
  binding: MaskletStoreBinding;
}
export interface MaskletWriter {
  /** Append one frame mask. Frames must ascend per object. Returns null (nothing stored) for an empty mask. */
  add(mask: FrameMask): Promise<TrackPoint | null>;
  /** Publish all binaries, then the index, and return a reader over the committed store. */
  commit(details: MaskletCommit): Promise<MaskletReader>;
  /** Discard unpublished pending files. Safe to call more than once. */
  abort(): Promise<void>;
}

interface PendingObject { objectId: string; handle: FileHandle | null; pending: string; hash: ReturnType<typeof createHash>; bytes: number; entries: IndexEntry[]; points: TrackPoint[] }

/** Start writing a masklet store for one clip into `directory` (created 0700 when absent). */
export async function createMaskletWriter(directory: string, clip: MaskletSet["clip"]): Promise<MaskletWriter> {
  const parsedClip = setSchema.shape.clip.safeParse(clip);
  if (!parsedClip.success) throw invalid("Masklet stores need a bounded clip description.");
  const bound = parsedClip.data;
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw invalid();
  const objects = new Map<string, PendingObject>();
  let state: "open" | "committed" | "aborted" = "open";
  const requireOpen = () => { if (state !== "open") throw invalid("This masklet writer is closed."); };
  const abort = async () => {
    if (state === "committed") return;
    state = "aborted";
    for (const object of objects.values()) {
      await object.handle?.close().catch(() => undefined);
      object.handle = null;
      await unlink(object.pending).catch(() => undefined);
    }
  };
  return {
    async add(mask) {
      requireOpen();
      if (typeof mask.objectId !== "string" || !objectIdPattern.test(mask.objectId)) throw invalid("Masklet object ids must be decimal strings.");
      if (!Number.isSafeInteger(mask.frame) || mask.frame < 0 || mask.frame >= bound.frameCount) throw invalid("A mask frame lies outside the clip.");
      if (mask.confidence !== null && !(Number.isFinite(mask.confidence) && mask.confidence >= 0 && mask.confidence <= 1)) throw invalid("Mask confidence must lie between 0 and 1.");
      checkBounds(mask.bounds, bound);
      let object = objects.get(mask.objectId);
      const last = object?.entries[object.entries.length - 1];
      if (last && mask.frame <= last.frame) throw invalid("Masks must be added in ascending frame order per object.");
      const point = trackPointOf(mask);
      if (!point) return null;
      if (!object) {
        if (objects.size >= MAX_STORE_OBJECTS) throw invalid("Too many tracked objects for one masklet store.");
        const pending = join(root, `${maskFileName(mask.objectId)}.pending`);
        object = { objectId: mask.objectId, handle: await createPending(pending), pending, hash: createHash("sha256"), bytes: 0, entries: [], points: [] };
        objects.set(mask.objectId, object);
      }
      if (object.entries.length >= MAX_FRAMES) throw invalid();
      const packed = packMaskBits(mask.raster);
      await object.handle!.write(packed, 0, packed.length, object.bytes);
      object.hash.update(packed);
      object.entries.push({ frame: mask.frame, byteOffset: object.bytes, byteLength: packed.length, bounds: { ...point.bounds }, confidence: mask.confidence, pixels: point.area });
      object.bytes += packed.length;
      object.points.push(point);
      return point;
    },
    async commit(details) {
      requireOpen();
      try {
        const ordered = [...objects.values()].sort((a, b) => a.objectId.length - b.objectId.length || (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0));
        const summaries = ordered.map((object) => {
          const identity = details.identity(object.objectId);
          if (!identity) throw invalid("Every tracked object needs a local label and origin.");
          return summarizeTrack({ objectId: object.objectId, label: identity.label, origin: identity.origin, points: object.points, clip: bound });
        });
        const set: MaskletSet = { ...details.set, version: 1, model: "sam-3.1", clip: { ...bound }, objects: summaries, provenance: { kind: "meta_video_segmentation", semanticIdentityVerified: false, requiresReview: true } };
        const document = documentSchema.parse({
          version: 1, kind: "tickr_masklets", binding: details.binding, set,
          files: ordered.map((object) => ({ objectId: object.objectId, file: maskFileName(object.objectId), bytes: object.bytes, sha256: object.hash.digest("hex"), entries: object.entries })),
        });
        checkDocument(document);
        const serialized = JSON.stringify(document);
        if (Buffer.byteLength(serialized) > MAX_INDEX_BYTES) throw invalid("The masklet index exceeded its size limit.");
        for (const object of ordered) {
          await object.handle!.sync();
          await object.handle!.close();
          object.handle = null;
          await rename(object.pending, join(root, maskFileName(object.objectId)));
        }
        await syncDirectory(root);
        const pendingIndex = join(root, `${MASKLET_INDEX_FILE}.pending`);
        const handle = await createPending(pendingIndex);
        try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
        await rename(pendingIndex, join(root, MASKLET_INDEX_FILE));
        await syncDirectory(root);
        state = "committed";
        // Binaries of an older, replaced set are unreferenced now; remove them best-effort.
        const keep = new Set(ordered.map((object) => maskFileName(object.objectId)));
        for (const name of await readdir(root).catch(() => [] as string[])) {
          if (/^masks-\d{1,20}\.bin$/.test(name) && !keep.has(name)) await unlink(join(root, name)).catch(() => undefined);
        }
        return createReader(root, document);
      } catch (error) {
        await abort();
        throw error instanceof MaskletStoreError ? error : invalid("The masklet store could not be written safely.");
      }
    },
    abort,
  };
}

