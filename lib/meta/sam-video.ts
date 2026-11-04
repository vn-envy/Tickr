import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { decodeMaskToRaster, formats, recordsOfKind, type SegmentationMaskRecord } from "@meta-sam/parser";
import { z } from "zod";
import type { MaskletReader, MaskletSet, NormalizedClip } from "../media/cinema-types";
import { createMaskletWriter, MaskletStoreError, readMaskletStore, type MaskletObjectIdentity, type MaskletWriter } from "../media/masklets";
import { MetaClient } from "./client";
import { MetaClientError, getMetaModelConfig } from "./config";
import { createPaidResponseStore, type StoredPaidResponse } from "./paid-response-store";
import { buildSamGeometryPrompt, SAM_MAX_OBJECTS, SamPromptError, type SamObjectPrompt } from "./sam-prompts";

/**
 * SAM 3.1 video tracking (POST /responses with an inline MP4 data URL), one paid request,
 * never retried. Follows the image adapter's protocol: strict input validation, an
 * input-bound "requested" marker before the call, the raw completed response stored privately
 * for offline recovery, declared-geometry preflight BEFORE the official parser decodes any
 * mask, and fixed safe error messages. Decoded masks are written to a hash-verified masklet
 * store; they SELECT real clip pixels and never verify what the tracked object is.
 */
const MAX_CLIP_BYTES = 24 * 1024 * 1024;
const MAX_CLIP_FRAMES = 900;
const MAX_DIMENSION = 8192;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_WIRE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_MASK_PIXELS = 600_000_000;
const MAX_TRACKED_OBJECTS = 32;
const REQUEST_TIMEOUT_MS = 300_000;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const videoResponseStore = createPaidResponseStore({ prefix: "sam-video", maxRecordBytes: 40 * 1024 * 1024, errorFamily: "VIDEO_SEGMENTATION", label: "SAM video" });

export type SamVideoPropagation = "forward" | "backward" | "both";
export type SamVideoPrompt =
  | { kind: "geometry"; objects: readonly SamObjectPrompt[] }
  /** A short concept noun phrase; `label` is local provenance only and never sent. */
  | { kind: "concept"; phrase: string; label: string };
export interface SamVideoRequest { clip: NormalizedClip; prompt: SamVideoPrompt; propagation: SamVideoPropagation }
export interface SamVideoDependencies {
  client?: Pick<MetaClient, "requestJson">;
  model?: string;
  /** Private per-attempt directory for the requested marker and raw response (offline recovery). */
  responseDirectory: string;
  /** Private masklet store directory for this clip and prompt. */
  outputDirectory: string;
}
export interface SamVideoResult {
  set: MaskletSet;
  reader: MaskletReader;
  /** Numeric usage fields exactly as Meta reported them (one level of nesting flattened with "."). */
  usage: Record<string, number>;
  /** Prompted geometry ids without any non-empty mask, ascending; [] for concept prompts. */
  unmatchedPromptIds: number[];
  /** Where the result came from: a new paid request, a stored response, or an existing verified store. */
  source: "request" | "stored_response" | "masklet_store";
}
export interface SamVideoDiagnostic {
  phase: "input" | "request" | "storage" | "decode" | "recovery" | "output";
  code: string;
  detail: string;
  httpStatus: number | null;
  completedResponseStored: boolean;
  responseId: string | null;
  elapsedMs: number;
  usage: Record<string, number> | null;
}

const safeValidationErrors = new WeakSet<Error>();
const safeCodes = new Set(["VIDEO_SEGMENTATION_INVALID", "VIDEO_SEGMENTATION_CHECKPOINT_INVALID", "VIDEO_SEGMENTATION_PENDING", "MASKLETS_INVALID", "MASKLETS_MISSING", "MODEL_NOT_ALLOWED", "API_KEY_MISSING", "REQUEST_TIMEOUT", "NETWORK_ERROR", "HTTP_ERROR", "INVALID_RESPONSE", "RESPONSE_TOO_LARGE", "REDIRECT_NOT_ALLOWED", "MODEL_MISMATCH", "MODEL_NOT_CONFIGURED"]);
class SamVideoFailure extends MetaClientError {
  constructor(readonly diagnostic: SamVideoDiagnostic, outcome: "unknown" | "not_applicable") {
    super(diagnostic.code, diagnostic.detail, { status: diagnostic.httpStatus ?? undefined, outcome });
    this.name = "SamVideoFailure";
  }
}

function invalid(message: string, paid = false): MetaClientError {
  const error = new MetaClientError("VIDEO_SEGMENTATION_INVALID", message, { outcome: paid ? "unknown" : "not_applicable" });
  safeValidationErrors.add(error);
  return error;
}
const preflightFailure = () => invalid("SAM video geometry exceeds its bounds or contains unsupported fields.", true);

/** Fixed error descriptions and actual response metering; never raw provider bodies, output text or paths. */
export function getSamVideoDiagnostic(error: unknown): SamVideoDiagnostic {
  if (error instanceof SamVideoFailure) return error.diagnostic;
  if (error instanceof MaskletStoreError) return { phase: "output", code: error.code, detail: error.message, httpStatus: null, completedResponseStored: false, responseId: null, elapsedMs: 0, usage: null };
  const code = error instanceof MetaClientError && safeCodes.has(error.code) ? error.code : "VIDEO_SEGMENTATION_FAILED";
  const status = error instanceof MetaClientError && Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599 ? error.status! : null;
  return { phase: "input", code, detail: error instanceof Error && safeValidationErrors.has(error) ? error.message : "The SAM video operation could not be completed safely.", httpStatus: status, completedResponseStored: false, responseId: null, elapsedMs: 0, usage: null };
}

function wrappedFailure(error: unknown, phase: SamVideoDiagnostic["phase"], completedResponseStored = false, record?: Pick<StoredPaidResponse, "response" | "elapsedMs">, elapsedMs = 0) {
  const diagnostic = getSamVideoDiagnostic(error);
  const envelope = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/).optional(), usage: z.unknown().optional() }).safeParse(record?.response);
  return new SamVideoFailure({
    ...diagnostic, phase: error instanceof MaskletStoreError ? "output" : phase, completedResponseStored, elapsedMs: record?.elapsedMs ?? elapsedMs,
    responseId: envelope.success ? envelope.data.id ?? null : null,
    usage: envelope.success && envelope.data.usage !== undefined ? collectUsage(envelope.data.usage) : null,
  }, error instanceof MetaClientError ? error.outcome : "unknown");
}

// ---------------------------------------------------------------- usage

/**
 * Numeric, non-negative usage fields as reported (field names are not yet documented for
 * video). One level of nested objects is flattened as `parent.child`. Nothing is estimated.
 */
export function collectUsage(usage: unknown): Record<string, number> {
  const fields: Record<string, number> = {};
  const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!plain(usage)) return fields;
  const key = /^[A-Za-z0-9_]{1,39}$/;
  const add = (name: string, value: unknown) => {
    if (Object.keys(fields).length < 64 && typeof value === "number" && Number.isFinite(value) && value >= 0) fields[name] = value;
  };
  for (const [name, value] of Object.entries(usage).slice(0, 64)) {
    if (!key.test(name)) continue;
    if (plain(value)) for (const [child, nested] of Object.entries(value).slice(0, 64)) { if (key.test(child)) add(`${name}.${child}`, nested); }
    else add(name, value);
  }
  return fields;
}

const billedFrameFields = ["frames_billed", "billed_frames", "video_frames_billed", "frames_processed", "video_frames_processed", "frames"];
/** The most plausible billed-frame count among reported fields, or null. Never derived from the clip. */
export function framesBilledFrom(usage: Record<string, number>): number | null {
  const integral = (name: string) => Number.isSafeInteger(usage[name]) ? usage[name] : undefined;
  for (const name of billedFrameFields) { const value = integral(name); if (value !== undefined) return value; }
  const candidates = Object.keys(usage).filter((name) => /frame/i.test(name) && integral(name) !== undefined);
  return candidates.length === 1 ? usage[candidates[0]] : null;
}

// ---------------------------------------------------------------- input

const pixel = z.number().int().nonnegative();
const labelSchema = z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/);
// Field-level validation; buildSamGeometryPrompt then enforces clip bounds, id uniqueness and grammar.
const geometrySchema = z.array(z.object({
  objectId: z.number().int().min(0).max(SAM_MAX_OBJECTS - 1),
  label: labelSchema,
  origin: z.enum(["owner_tap", "spark_grounding", "local_layout"]),
  prompts: z.array(z.object({
    frame: z.number().int().nonnegative(),
    box: z.object({ x1: pixel, y1: pixel, x2: pixel, y2: pixel }).optional(),
    points: z.array(z.object({ x: pixel, y: pixel, polarity: z.enum(["positive", "negative"]) })).max(64).optional(),
  })).min(1).max(32),
})).min(1).max(SAM_MAX_OBJECTS);
const clipSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().min(1).max(4096).refine(isAbsolute),
  width: z.number().int().min(1).max(MAX_DIMENSION), height: z.number().int().min(1).max(MAX_DIMENSION),
  fps: z.number().finite().positive().max(240), frameCount: z.number().int().min(1).max(MAX_CLIP_FRAMES),
});

interface PreparedVideo {
  clip: MaskletSet["clip"];
  bytes: Buffer;
  promptKind: "geometry" | "concept";
  text: string;
  propagation: SamVideoPropagation;
  /** Geometry: prompted ids → local identity. Concept: empty (every returned id uses `conceptIdentity`). */
  prompted: Map<string, MaskletObjectIdentity>;
  conceptIdentity: MaskletObjectIdentity | null;
  inputHash: string;
}

async function readClipBytes(path: string): Promise<Buffer> {
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw invalid("The tracking clip could not be read from private storage."); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 12 || stat.size > MAX_CLIP_BYTES) throw invalid("The tracking clip must be a regular MP4 file of at most 24 MiB.");
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw invalid("The tracking clip changed while it was read.");
    return bytes;
  } catch (error) {
    if (error instanceof MetaClientError) throw error;
    throw invalid("The tracking clip could not be read from private storage.");
  } finally { await handle.close(); }
}

async function prepare(request: SamVideoRequest, model: string): Promise<PreparedVideo> {
  const clip = clipSchema.safeParse(request?.clip);
  if (!clip.success) throw invalid(`SAM video tracking needs a normalized clip of at most ${MAX_CLIP_FRAMES} frames with bounded dimensions.`);
  const { sha256: clipSha256, path, width, height, fps, frameCount } = clip.data;
  if (!["forward", "backward", "both"].includes(request.propagation)) throw invalid("SAM video propagation must be forward, backward or both.");
  let promptKind: PreparedVideo["promptKind"], text: string, conceptIdentity: MaskletObjectIdentity | null = null;
  const prompted = new Map<string, MaskletObjectIdentity>();
  if (request.prompt?.kind === "geometry") {
    const geometry = geometrySchema.safeParse(request.prompt.objects);
    if (!geometry.success) throw invalid("SAM video geometry needs 1 to 16 labelled box or point prompts with explicit origins.");
    try { text = buildSamGeometryPrompt(geometry.data, { width, height }, { media: "video", frameCount }); }
    catch (error) { throw invalid(error instanceof SamPromptError ? error.message : "SAM video geometry could not be prepared safely."); }
    // Backward propagation needs a prompt after frame 0 (Meta docs); otherwise it tracks nothing.
    if (request.propagation === "backward" && !geometry.data.some((object) => object.prompts.some((prompt) => prompt.frame > 0))) throw invalid("Backward propagation needs a prompt after frame 0.");
    promptKind = "geometry";
    for (const object of geometry.data) prompted.set(String(object.objectId), { label: object.label, origin: object.origin });
  } else if (request.prompt?.kind === "concept") {
    const phrase = typeof request.prompt.phrase === "string" ? request.prompt.phrase.trim() : "";
    if (!phrase || phrase.length > 120 || /[<>\r\n\u0000-\u001f\u007f]/.test(phrase)) throw invalid("SAM video needs one short noun phrase without control tokens.");
    const label = labelSchema.safeParse(request.prompt.label);
    if (!label.success) throw invalid("SAM video concept prompts need a short local label.");
    if (request.propagation === "backward") throw invalid("Backward propagation needs a prompt after frame 0.");
    promptKind = "concept"; text = phrase; conceptIdentity = { label: label.data, origin: "concept_prompt" };
  } else throw invalid("SAM video needs exactly one concept noun phrase or one set of geometry prompts.");
  const bytes = await readClipBytes(path);
  if (sha256(bytes) !== clipSha256) throw invalid("The tracking clip bytes do not match their recorded SHA-256.");
  if (bytes.subarray(4, 8).toString("latin1") !== "ftyp") throw invalid("The tracking clip must be an MP4 container.");
  const bound = { sha256: clipSha256, width, height, fps, frameCount };
  // Binds every request-defining input plus the local identities and clip facts the result reports.
  const inputHash = sha256(JSON.stringify({ version: 1, kind: "sam-video", model, clip: bound, promptKind, text,
    identities: [...prompted.entries()], conceptIdentity, propagation: request.propagation, mimeType: "video/mp4", maskEncoding: "one_bit", includeConfidence: true }));
  return { clip: bound, bytes, promptKind, text, propagation: request.propagation, prompted, conceptIdentity, inputHash };
}

// ---------------------------------------------------------------- wire preflight

const integer = /^-?\d+$/;
const unsigned = /^\d+$/;
const confidencePattern = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const boxKeys = new Set(["x1", "y1", "x2", "y2", "w", "h", "c"]);
const maskKeys = new Set(["x", "y", "data", "c"]);

function tokenFields(body: string, allowed: ReadonlySet<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of body.split(";")) {
    const field = part.trim();
    if (!field) continue;
    const separator = field.indexOf("=");
    if (separator < 1) throw preflightFailure();
    const key = field.slice(0, separator).trim(), value = field.slice(separator + 1).trim();
    if (!allowed.has(key) || result.has(key) || !value) throw preflightFailure();
    result.set(key, value);
  }
  const score = result.get("c");
  if (score !== undefined && (!confidencePattern.test(score) || !Number.isFinite(Number(score)) || Number(score) < 0 || Number(score) > 1)) throw preflightFailure();
  return result;
}

export interface SamVideoWirePreflight {
  /** Wire text without bare frame-marker lines, ready for the official parser. */
  wire: string;
  /** Declared records in wire order. */
  records: Array<{ frame: number; objectId: string }>;
  /** Frames reported as a bare `<Nf>` marker (no objects on that frame). */
  emptyFrames: number[];
}

/**
 * Validate declared video geometry before any mask payload is decoded: frame markers inside
 * the clip and not repeated, box w/h equal to the clip size, boxes inside the frame, mask
 * dimensions equal to box dimensions, at most 16 distinct objects per frame and a bounded
 * aggregate of declared mask pixels. Lines that are exactly a bare frame marker are stripped
 * (parser 0.0.13 reports them as malformed; their live form is unverified).
 */
export function preflightSamVideoWire(text: string, clip: { width: number; height: number; frameCount: number }): SamVideoWirePreflight {
  if (![clip.width, clip.height, clip.frameCount].every((value) => Number.isSafeInteger(value) && value >= 1) || clip.width > MAX_DIMENSION || clip.height > MAX_DIMENSION
    || Buffer.byteLength(text) > MAX_WIRE_BYTES) throw preflightFailure();
  const recordStart = /,?([0-9]+)(?=<\|)/y;
  const token = /<\|([A-Za-z][A-Za-z0-9_.-]*)(?:;([^|]*))?\|>/y;
  const frames = new Set<number>();
  const records: SamVideoWirePreflight["records"] = [];
  const emptyFrames: number[] = [];
  const kept: string[] = [];
  let pixels = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const header = /^<(\d{1,9})f>/.exec(line);
    if (!header) throw preflightFailure();
    const frame = Number(header[1]);
    if (frame >= clip.frameCount || frames.has(frame)) throw preflightFailure();
    frames.add(frame);
    if (line.length === header[0].length) { emptyFrames.push(frame); continue; }
    kept.push(line);
    const seen = new Set<string>();
    let position = header[0].length;
    while (position < line.length) {
      recordStart.lastIndex = position;
      const start = recordStart.exec(line);
      if (!start || start[1].length > 20 || seen.has(start[1]) || seen.size >= SAM_MAX_OBJECTS) throw preflightFailure();
      seen.add(start[1]);
      position = recordStart.lastIndex;
      const tokens = new Map<string, Map<string, string>>();
      while (line.startsWith("<|", position)) {
        token.lastIndex = position;
        const match = token.exec(line);
        if (!match || (match[1] !== "box" && match[1] !== "mask") || tokens.has(match[1])) throw preflightFailure();
        tokens.set(match[1], tokenFields(match[2] ?? "", match[1] === "box" ? boxKeys : maskKeys));
        position = token.lastIndex;
      }
      const box = tokens.get("box"), mask = tokens.get("mask");
      if (!box || !mask || tokens.size !== 2) throw preflightFailure();
      const values = ["x1", "y1", "x2", "y2", "w", "h"].map((key) => box.get(key));
      if (!values.every((value, index) => value !== undefined && (index < 4 ? integer : unsigned).test(value))) throw preflightFailure();
      const [left, top, right, bottom, width, height] = values.map(Number);
      if (![left, top, right, bottom, width, height].every(Number.isSafeInteger) || width !== clip.width || height !== clip.height
        || left < 0 || top < 0 || right < left || bottom < top || right >= width || bottom >= height
        || mask.get("x") !== "0" || mask.get("y") !== "0") throw preflightFailure();
      const data = /^(\d{1,9}),(\d{1,9}),([!~][^|]+)$/.exec(mask.get("data") ?? "");
      if (!data || Number(data[1]) !== bottom - top + 1 || Number(data[2]) !== right - left + 1) throw preflightFailure();
      pixels += (bottom - top + 1) * (right - left + 1);
      if (pixels > MAX_TOTAL_MASK_PIXELS) throw preflightFailure();
      records.push({ frame, objectId: start[1] });
    }
  }
  return { wire: kept.join("\n"), records, emptyFrames };
}

// ---------------------------------------------------------------- decode

const responseSchema = z.object({
  id: z.string().min(1).max(200), status: z.literal("completed"), model: z.literal("sam-3.1").optional(),
  output: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().max(MAX_WIRE_BYTES).optional() }).passthrough()).max(8).optional() }).passthrough()).max(32),
  usage: z.unknown().optional(),
}).passthrough();

async function decodeResult(response: unknown, prepared: PreparedVideo, elapsedMs: number, outputDirectory: string, source: SamVideoResult["source"]): Promise<SamVideoResult> {
  const parsed = responseSchema.safeParse(response);
  if (!parsed.success) throw invalid("Meta did not return a completed bounded video segmentation response; no retry was attempted.", true);
  const content = parsed.data.output.filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
  if (content.some((item) => item.type === "refusal")) throw invalid("Meta declined this video segmentation request; no retry was attempted.", true);
  const lanes = content.filter((item) => item.type === "output_text");
  if (lanes.length > 1) throw invalid("Video segmentation returned more than one output-text lane.", true);
  const usage = collectUsage(parsed.data.usage);
  const { wire, records: declared } = preflightSamVideoWire(lanes[0]?.text ?? "", prepared.clip);
  if (prepared.promptKind === "geometry" && declared.some((record) => !prepared.prompted.has(record.objectId))) throw invalid("Video segmentation returned an object that was not prompted.", true);
  if (new Set(declared.map((record) => record.objectId)).size > MAX_TRACKED_OBJECTS) throw invalid("Video segmentation returned too many distinct objects.", true);
  let masks: readonly SegmentationMaskRecord[] = [];
  if (wire) {
    const parser = formats.segmentation.video().createParser();
    let result: ReturnType<typeof parser.finish>["result"];
    try { parser.push(wire, { emit: false }); result = parser.finish({ status: "completed" }).result; }
    catch { throw invalid("Meta video segmentation geometry could not be parsed safely.", true); }
    if (result.diagnostics.length || result.records.some((record) => record.kind === "text")) throw invalid("Meta video segmentation contains malformed or unexpected geometry.", true);
    masks = recordsOfKind(result.records, "mask");
    if (masks.length !== declared.length || new Set(masks.map((record) => `${record.frame?.frameIndex}:${record.objectId}`)).size !== masks.length) throw invalid("Video segmentation object identities were incomplete or duplicated.", true);
  }
  const ordered = [...masks].sort((a, b) => (a.frame?.frameIndex ?? -1) - (b.frame?.frameIndex ?? -1) || a.order - b.order);
  let writer: MaskletWriter | null = null;
  try {
    writer = await createMaskletWriter(outputDirectory, prepared.clip);
    const present = new Set<string>();
    // Decode frame by frame; each raster is packed to disk before the next is decoded.
    for (const record of ordered) {
      const frame = record.frame?.frameIndex;
      const { left, top, right, bottom } = record.bounds;
      const width = right - left, height = bottom - top;
      if (frame === undefined || !Number.isSafeInteger(frame) || frame < 0 || frame >= prepared.clip.frameCount || !/^\d{1,20}$/.test(record.objectId)
        || ![left, top, right, bottom].every(Number.isSafeInteger) || left < 0 || top < 0 || right > prepared.clip.width || bottom > prepared.clip.height || width <= 0 || height <= 0
        || record.mask.width !== width || record.mask.height !== height) throw invalid("A video segmentation mask falls outside its clip or disagrees with its box.", true);
      let raster: Uint8Array;
      try { raster = decodeMaskToRaster(record.mask); }
      catch { throw invalid("A video segmentation mask payload could not be decoded safely.", true); }
      if (raster.length !== width * height) throw invalid("Decoded video segmentation mask dimensions changed.", true);
      if (await writer.add({ objectId: record.objectId, frame, bounds: { left, top, right, bottom }, confidence: record.confidence ?? null, raster })) present.add(record.objectId);
    }
    const unmatchedPromptIds = [...prepared.prompted.keys()].filter((id) => !present.has(id)).map(Number).sort((a, b) => a - b);
    const reader = await writer.commit({
      identity: (objectId) => prepared.conceptIdentity ?? prepared.prompted.get(objectId),
      set: { responseId: parsed.data.id, promptKind: prepared.promptKind, propagation: prepared.propagation, framesBilled: framesBilledFrom(usage), elapsedMs, createdAt: new Date().toISOString() },
      binding: { inputHash: prepared.inputHash, usage, unmatchedPromptIds },
    });
    return { set: reader.set, reader, usage, unmatchedPromptIds, source };
  } catch (error) {
    await writer?.abort();
    throw error;
  }
}

async function reuseStore(prepared: PreparedVideo, outputDirectory: string): Promise<SamVideoResult | null> {
  try {
    const { reader, binding } = await readMaskletStore(outputDirectory, { clipSha256: prepared.clip.sha256, inputHash: prepared.inputHash });
    return { set: reader.set, reader, usage: binding.usage, unmatchedPromptIds: binding.unmatchedPromptIds, source: "masklet_store" };
  } catch {
    // Missing or unusable derived output is rebuilt from the stored response (or a new request).
    return null;
  }
}

function checkDependencies(dependencies: SamVideoDependencies) {
  for (const directory of [dependencies?.responseDirectory, dependencies?.outputDirectory]) {
    if (typeof directory !== "string" || !directory.trim() || directory.length > 4096) throw invalid("SAM video tracking needs private response and masklet directories.");
  }
}

/** Decode a saved paid response offline into the masklet store; makes no network request. */
export async function decodeSamVideoResponse(response: unknown, request: SamVideoRequest, outputDirectory: string, elapsedMs = 0): Promise<SamVideoResult> {
  return decodeResult(response, await prepare(request, "sam-3.1"), elapsedMs, outputDirectory, "stored_response");
}

/**
 * One bounded Meta-hosted SAM 3.1 video request with the clip inline, never retried.
 * Order: verified existing masklet store → stored response (offline) → marker → paid call →
 * stored raw response → decode. A failure after storing is terminal and keeps the response.
 */
export async function trackMetaVideo(request: SamVideoRequest, dependencies: SamVideoDependencies): Promise<SamVideoResult> {
  let prepared: PreparedVideo;
  try {
    checkDependencies(dependencies);
    const model = dependencies.model ?? getMetaModelConfig().segmentation ?? "sam-3.1";
    if (model !== "sam-3.1") throw new MetaClientError("MODEL_NOT_ALLOWED", "Only the verified SAM 3.1 adapter is supported.");
    prepared = await prepare(request, model);
  } catch (error) { throw wrappedFailure(error, "input"); }
  const existing = await reuseStore(prepared, dependencies.outputDirectory);
  if (existing) return existing;
  let stored: StoredPaidResponse | null;
  try { stored = await videoResponseStore.read(dependencies.responseDirectory, prepared.inputHash); }
  catch (error) { throw wrappedFailure(error, "recovery"); }
  if (stored) {
    try { return await decodeResult(stored.response, prepared, stored.elapsedMs, dependencies.outputDirectory, "stored_response"); }
    catch (error) { throw wrappedFailure(error, "decode", true, stored); }
  }
  // Constructing the client validates credentials before a paid-attempt marker is written.
  let client: Pick<MetaClient, "requestJson">;
  try { client = dependencies.client ?? new MetaClient({ models: { segmentation: "sam-3.1" }, timeoutMs: REQUEST_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES }); }
  catch (error) { throw wrappedFailure(error, "input"); }
  try { await videoResponseStore.mark(dependencies.responseDirectory, prepared.inputHash); }
  catch (error) { throw wrappedFailure(error, "storage"); }
  const started = Date.now();
  let response: unknown;
  try {
    response = await client.requestJson("/responses", { method: "POST", modelRole: "segmentation", body: {
      model: "sam-3.1",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prepared.text }, { type: "input_video", video_url: `data:video/mp4;base64,${prepared.bytes.toString("base64")}` }] }],
      stream: false, store: false, metadata: { mask_encoding: "one_bit", include_confidence: "true", propagation_direction: prepared.propagation },
    } });
  } catch (error) { throw wrappedFailure(error, "request", false, undefined, Date.now() - started); }
  const record: StoredPaidResponse = { version: 1, inputHash: prepared.inputHash, receivedAt: new Date().toISOString(), elapsedMs: Date.now() - started, response };
  try { await videoResponseStore.store(dependencies.responseDirectory, record); }
  catch (error) { throw wrappedFailure(error, "storage", false, record); }
  try { return await decodeResult(response, prepared, record.elapsedMs, dependencies.outputDirectory, "request"); }
  catch (error) { throw wrappedFailure(error, "decode", true, record); }
}
