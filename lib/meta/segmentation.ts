import { createHash } from "node:crypto";
import { decodeMaskToRaster, formats, recordsOfKind } from "@meta-sam/parser";
import sharp from "sharp";
import { z } from "zod";
import { MetaClient } from "./client";
import { MetaClientError, getMetaModelConfig } from "./config";
import { markSegmentationRequested, readStoredSegmentationResponse, storeSegmentationResponse, type StoredSegmentationResponse } from "./segmentation-response";
import { preflightSegmentationObjectIds, SegmentationPreflightError } from "./segmentation-preflight";
import { buildSamGeometryPrompt, SAM_MAX_OBJECTS, SamPromptError, type SamObjectPrompt } from "./sam-prompts";

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 16_777_216;
const MAX_TOTAL_MASK_PIXELS = 32_000_000;
const MAX_WIRE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/**
 * Exactly one of `prompt` (concept) or `geometry` (box/point prompts) is required; both are
 * optional in the type only so existing concept callers and spreads keep compiling. The
 * adapter rejects requests with neither or both before any model call.
 */
export interface MetaSegmentationRequest {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  /** A short noun phrase identifying one visible object type. */
  prompt?: string;
  /**
   * SAM 3.1 geometry prompts in decoded (oriented) source pixels, all on frame 0. Labels and
   * origins stay local: only the box/point text is sent. Cannot be combined with `prompt`.
   */
  geometry?: readonly SamObjectPrompt[];
  sourceAssetId: string;
  sourceProvenance: "source_photo" | "owner_photo" | "meta_illustration";
}
export type MetaSegmentationRegionOrigin = SamObjectPrompt["origin"] | "concept_prompt";
export type MetaSegmentationPromptKind = "concept" | "geometry";
/**
 * Fields marked "always set by the adapter" are optional in the type only so results recorded
 * before geometry prompts existed remain assignable; absent values mean a concept result.
 */
export interface MetaSegmentedObject {
  id: string;
  /** The prompted geometry object id SAM echoed; null for concept prompts. Always set by the adapter. */
  promptObjectId?: number | null;
  /** Local label of the prompted geometry object (never sent to Meta); null for concept prompts. Always set by the adapter. */
  label?: string | null;
  /** Where the selection request came from. Not a verified product identity. Always set by the adapter. */
  regionOrigin?: MetaSegmentationRegionOrigin;
  /** Half-open bounds in the unchanged source raster. */
  bounds: { left: number; top: number; right: number; bottom: number };
  confidence: number | null;
  foregroundPixels: number;
  coverageFraction: number;
  /** Binary grayscale PNG cropped to bounds: 0 background, 255 foreground. */
  maskPng: Buffer;
  /** RGBA PNG cropped to bounds; source RGB retained and alpha multiplied by mask. */
  cutoutPng: Buffer;
  sha256: string;
}
export interface MetaSegmentationResult {
  status: "segmented" | "no_match";
  model: "sam-3.1";
  endpoint: "/responses";
  /** Always set by the adapter. */
  promptKind?: MetaSegmentationPromptKind;
  /** Prompted geometry ids without a usable (non-empty) mask, ascending; [] for concept prompts. Always set by the adapter. */
  unmatchedPromptIds?: number[];
  responseId: string;
  width: number;
  height: number;
  sourceSha256: string;
  elapsedMs: number;
  objects: MetaSegmentedObject[];
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; imagesProcessed: number | null };
  provenance: {
    kind: "meta_segmentation";
    sourceAssetId: string;
    sourceProvenance: MetaSegmentationRequest["sourceProvenance"];
    originalSubjectPixelsPreserved: true;
    preservationScope: "decoded_source_rgb_and_original_alpha_multiplied_by_binary_mask";
    semanticIdentityVerified: false;
    requiresReview: true;
    /** SHA-256 of the exact input_text sent (noun phrase or geometry prompt text). */
    promptSha256: string;
    /** Always set by the adapter. */
    promptKind?: MetaSegmentationPromptKind;
  };
}
export interface MetaSegmentationDependencies {
  client?: Pick<MetaClient, "requestJson">;
  model?: string;
  /** Private per-attempt directory. Enables input-bound offline recovery without paid retries. */
  responseDirectory?: string;
}

export interface MetaSegmentationDiagnostic {
  phase: "input" | "request" | "storage" | "decode" | "recovery";
  code: string;
  detail: string;
  httpStatus: number | null;
  completedResponseStored: boolean;
  responseId: string | null;
  elapsedMs: number;
  usage: MetaSegmentationResult["usage"] | null;
}
const safeValidationErrors = new WeakSet<Error>();
const safeCodes = new Set(["SEGMENTATION_INVALID", "SEGMENTATION_CHECKPOINT_INVALID", "SEGMENTATION_PENDING", "MODEL_NOT_ALLOWED", "API_KEY_MISSING", "REQUEST_TIMEOUT", "NETWORK_ERROR", "HTTP_ERROR", "INVALID_RESPONSE", "RESPONSE_TOO_LARGE", "REDIRECT_NOT_ALLOWED", "MODEL_MISMATCH", "MODEL_NOT_CONFIGURED"]);
class SegmentationFailure extends MetaClientError {
  constructor(readonly diagnostic: MetaSegmentationDiagnostic, outcome: "unknown" | "not_applicable") {
    super(diagnostic.code, diagnostic.detail, { status: diagnostic.httpStatus ?? undefined, outcome });
    this.name = "SegmentationFailure";
  }
}

/** Fixed error descriptions and actual response metering; never raw provider errors or output text. */
export function getMetaSegmentationDiagnostic(error: unknown): MetaSegmentationDiagnostic {
  if (error instanceof SegmentationFailure) return error.diagnostic;
  const code = error instanceof MetaClientError && safeCodes.has(error.code) ? error.code : "SEGMENTATION_FAILED";
  return { phase: "input", code, detail: error instanceof Error && (safeValidationErrors.has(error) || error instanceof SegmentationPreflightError) ? error.message : "The SAM operation could not be completed safely.", httpStatus: error instanceof MetaClientError && Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599 ? error.status! : null, completedResponseStored: false, responseId: null, elapsedMs: 0, usage: null };
}

function wrappedFailure(error: unknown, phase: MetaSegmentationDiagnostic["phase"], completedResponseStored = false, record?: Pick<StoredSegmentationResponse, "response" | "elapsedMs">, elapsedMs = 0) {
  const diagnostic = getMetaSegmentationDiagnostic(error);
  const envelope = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/).optional(), usage: responseSchema.shape.usage }).safeParse(record?.response);
  return new SegmentationFailure({ ...diagnostic, phase, completedResponseStored, elapsedMs: record?.elapsedMs ?? elapsedMs,
    responseId: envelope.success ? envelope.data.id ?? null : null,
    usage: envelope.success && envelope.data.usage ? { inputTokens: envelope.data.usage.input_tokens ?? null, outputTokens: envelope.data.usage.output_tokens ?? null, totalTokens: envelope.data.usage.total_tokens ?? null, imagesProcessed: envelope.data.usage.images_processed ?? null } : null,
  }, error instanceof MetaClientError ? error.outcome : "unknown");
}

function invalid(message: string, paid = false): MetaClientError {
  const error = new MetaClientError("SEGMENTATION_INVALID", message, { outcome: paid ? "unknown" : "not_applicable" });
  safeValidationErrors.add(error);
  return error;
}
async function inspectSource(request: MetaSegmentationRequest) {
  const bytes = Buffer.from(request.bytes);
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) throw invalid("Segmentation source must contain at most 8 MiB of local image bytes.");
  const signature = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpeg"
      : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "webp" : null;
  if (!signature || request.mimeType !== `image/${signature}`) throw invalid("Segmentation accepts genuine PNG, JPEG or WebP bytes with matching MIME types.");
  const hasPrompt = request.prompt !== undefined, hasGeometry = request.geometry !== undefined;
  if (hasPrompt === hasGeometry) throw invalid("Segmentation needs exactly one concept noun phrase or one set of geometry prompts.");
  const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
  if (hasPrompt && (!prompt || prompt.length > 120 || /[<>\r\n\u0000-\u001f]/.test(prompt))) throw invalid("Segmentation needs one short noun phrase without control tokens.");
  const parsedGeometry = hasGeometry ? geometryRequestSchema.safeParse(request.geometry) : null;
  if (parsedGeometry && !parsedGeometry.success) throw invalid("Segmentation geometry needs 1 to 16 labelled box or point prompts with explicit origins.");
  if (!request.sourceAssetId.trim() || request.sourceAssetId.length > 200) throw invalid("Segmentation requires a bounded source asset ID.");
  if (!["source_photo", "owner_photo", "meta_illustration"].includes(request.sourceProvenance)) throw invalid("Segmentation requires explicit original image provenance.");
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_SOURCE_PIXELS, animated: false, failOn: "error" });
    const metadata = await image.metadata();
    if (metadata.format !== signature || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1 || metadata.depth !== "uchar" || metadata.orientation && metadata.orientation !== 1) {
      throw invalid("Normalize image orientation and supply a single-frame eight-bit raster before segmentation.");
    }
    const decoded = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.channels !== 4 || decoded.info.width !== metadata.width || decoded.info.height !== metadata.height) throw invalid("The segmentation source raster could not be normalized safely.");
    const geometry = parsedGeometry?.success ? parsedGeometry.data : null;
    const base = { bytes, width: metadata.width, height: metadata.height, rgba: decoded.data };
    if (!geometry) return { ...base, promptKind: "concept" as const, text: prompt, objects: [] as GeometryObject[] };
    // Orientation 1 is enforced above, so stored and displayed sizes are identical.
    let text: string;
    try { text = buildSamGeometryPrompt(geometry, { width: metadata.width, height: metadata.height }, { media: "image" }); }
    catch (error) { throw invalid(error instanceof SamPromptError ? error.message : "Segmentation geometry could not be prepared safely."); }
    return { ...base, promptKind: "geometry" as const, text, objects: geometry.map(({ objectId, label, origin }) => ({ objectId, label, origin })) };
  } catch (error) {
    if (error instanceof MetaClientError) throw error;
    throw invalid("The segmentation source could not be decoded within its pixel limit.");
  }
}
interface GeometryObject { objectId: number; label: string; origin: SamObjectPrompt["origin"] }
const pixel = z.number().int().nonnegative();
// Field-level validation; buildSamGeometryPrompt then enforces media bounds, id uniqueness and grammar.
const geometryRequestSchema = z.array(z.object({
  objectId: z.number().int().min(0).max(SAM_MAX_OBJECTS - 1),
  label: z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/),
  origin: z.enum(["owner_tap", "spark_grounding", "local_layout"]),
  prompts: z.array(z.object({
    frame: z.number().int().nonnegative(),
    box: z.object({ x1: pixel, y1: pixel, x2: pixel, y2: pixel }).optional(),
    points: z.array(z.object({ x: pixel, y: pixel, polarity: z.enum(["positive", "negative"]) })).max(64).optional(),
  })).min(1).max(32),
})).min(1).max(SAM_MAX_OBJECTS);

const responseSchema = z.object({
  id: z.string().min(1).max(200), status: z.literal("completed"), model: z.literal("sam-3.1").optional(),
  output: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().max(MAX_WIRE_BYTES).optional() }).passthrough()).max(8).optional() }).passthrough()).max(32),
  usage: z.object({ input_tokens: z.number().int().nonnegative().optional(), output_tokens: z.number().int().nonnegative().optional(), total_tokens: z.number().int().nonnegative().optional(), images_processed: z.number().int().nonnegative().optional() }).passthrough().optional(),
}).passthrough();

type SourceRaster = Awaited<ReturnType<typeof inspectSource>>;
async function decodeResult(response: unknown, request: MetaSegmentationRequest, source: SourceRaster, elapsedMs: number): Promise<MetaSegmentationResult> {
  const parsed = responseSchema.safeParse(response);
  if (!parsed.success) throw invalid("Meta did not return a completed bounded segmentation response; no retry was attempted.", true);
  const content = parsed.data.output.filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
  if (content.some((item) => item.type === "refusal")) throw invalid("Meta declined this segmentation request; no retry was attempted.", true);
  const lanes = content.filter((item) => item.type === "output_text");
  if (lanes.length > 1) throw invalid("Segmentation returned more than one output-text lane.", true);
  const text = lanes[0]?.text?.trim() ?? "";
  if (Buffer.byteLength(text) > MAX_WIRE_BYTES) throw invalid("Segmentation output exceeded its byte limit.", true);
  const objects: MetaSegmentedObject[] = [];
  const prompted = new Map(source.objects.map((object) => [String(object.objectId), object]));
  if (text) {
    // The official parser decodes payloads during finish(), so dimensions and
    // aggregate allocation must be bounded before handing it any mask tokens.
    const declaredIds = preflightSegmentationObjectIds(text, source.width, source.height);
    const objectCount = declaredIds.length;
    // Geometry ids are echoed verbatim; anything else (including "03" for 3) is not ours.
    if (source.promptKind === "geometry" && declaredIds.some((id) => !prompted.has(id))) throw invalid("Segmentation returned an object that was not prompted.", true);
    const parser = formats.segmentation.image().createParser();
    let result: ReturnType<typeof parser.finish>["result"];
    try { parser.push(text, { emit: false }); result = parser.finish({ status: "completed" }).result; }
    catch { throw invalid("Meta segmentation geometry could not be parsed safely.", true); }
    if (result.diagnostics.length || result.records.some((record) => record.kind === "text" && record.text.trim())) throw invalid("Meta segmentation contains malformed or unexpected geometry.", true);
    const records = recordsOfKind(result.records, "mask");
    if (records.length !== objectCount || new Set(records.map((record) => record.objectId)).size !== records.length) throw invalid("Segmentation object identities were incomplete or duplicated.", true);
    let totalPixels = 0; let totalBytes = 0;
    for (const record of records) {
      const { left, top, right, bottom } = record.bounds;
      const width = right - left; const height = bottom - top;
      if (!/^\d{1,20}$/.test(record.objectId) || ![left, top, right, bottom, width, height].every(Number.isSafeInteger) || left < 0 || top < 0 || right > source.width || bottom > source.height || width <= 0 || height <= 0
        || record.mask.width !== width || record.mask.height !== height || record.frame && record.frame.frameIndex !== 0) throw invalid("A segmentation mask falls outside its source or disagrees with its box.", true);
      totalPixels += width * height;
      if (totalPixels > MAX_TOTAL_MASK_PIXELS) throw invalid("Decoded segmentation masks exceed the total pixel limit.", true);
      let raster: Uint8Array;
      try { raster = decodeMaskToRaster(record.mask); }
      catch { throw invalid("A segmentation mask payload could not be decoded safely.", true); }
      if (raster.length !== width * height) throw invalid("Decoded segmentation mask dimensions changed.", true);
      const alpha = Buffer.alloc(raster.length); const rgba = Buffer.alloc(raster.length * 4);
      let foregroundPixels = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const maskIndex = y * width + x; const sourceIndex = ((top + y) * source.width + left + x) * 4; const outputIndex = maskIndex * 4;
        const selected = raster[maskIndex];
        if (selected !== 0 && selected !== 1) throw invalid("The segmentation decoder returned a nonbinary mask.", true);
        foregroundPixels += selected; alpha[maskIndex] = selected * 255;
        rgba[outputIndex] = source.rgba[sourceIndex]; rgba[outputIndex + 1] = source.rgba[sourceIndex + 1]; rgba[outputIndex + 2] = source.rgba[sourceIndex + 2]; rgba[outputIndex + 3] = source.rgba[sourceIndex + 3] * selected;
      }
      if (!foregroundPixels) continue;
      const [maskPng, cutoutPng] = await Promise.all([
        sharp(alpha, { raw: { width, height, channels: 1 } }).toColourspace("b-w").png().toBuffer(),
        sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer(),
      ]);
      totalBytes += maskPng.length + cutoutPng.length;
      if (totalBytes > MAX_OUTPUT_BYTES) throw invalid("Segmentation artifacts exceeded the total output byte limit.", true);
      const origin = prompted.get(record.objectId);
      objects.push({ id: record.objectId, promptObjectId: origin ? origin.objectId : null, label: origin ? origin.label : null, regionOrigin: origin ? origin.origin : "concept_prompt", bounds: { left, top, right, bottom }, confidence: record.confidence ?? null, foregroundPixels, coverageFraction: foregroundPixels / (source.width * source.height), maskPng, cutoutPng, sha256: sha256(cutoutPng) });
    }
  }
  const returned = new Set(objects.map((object) => object.id));
  return {
    status: objects.length ? "segmented" : "no_match", model: "sam-3.1", endpoint: "/responses", promptKind: source.promptKind,
    unmatchedPromptIds: source.objects.map((object) => object.objectId).filter((id) => !returned.has(String(id))).sort((a, b) => a - b), responseId: parsed.data.id,
    width: source.width, height: source.height, sourceSha256: sha256(source.bytes), elapsedMs, objects,
    usage: { inputTokens: parsed.data.usage?.input_tokens ?? null, outputTokens: parsed.data.usage?.output_tokens ?? null, totalTokens: parsed.data.usage?.total_tokens ?? null, imagesProcessed: parsed.data.usage?.images_processed ?? null },
    provenance: { kind: "meta_segmentation", sourceAssetId: request.sourceAssetId, sourceProvenance: request.sourceProvenance, originalSubjectPixelsPreserved: true,
      preservationScope: "decoded_source_rgb_and_original_alpha_multiplied_by_binary_mask", semanticIdentityVerified: false, requiresReview: true, promptSha256: sha256(source.text), promptKind: source.promptKind },
  };
}

/** Decode a saved paid response offline; this helper makes no network requests. */
export async function decodeMetaSegmentationResponse(response: unknown, request: MetaSegmentationRequest, elapsedMs = 0): Promise<MetaSegmentationResult> {
  return decodeResult(response, request, await inspectSource(request), elapsedMs);
}

/**
 * Concept bindings are byte-identical to the original version-1 JSON so previously saved
 * responses keep recovering. Geometry bindings use version 2 and cover the exact prompt
 * text plus the local labels/origins that the decoded result reports.
 */
function requestBinding(request: MetaSegmentationRequest, source: SourceRaster): string {
  if (source.promptKind === "concept") {
    return sha256(JSON.stringify({ version: 1, model: "sam-3.1", sourceSha256: sha256(source.bytes), mimeType: request.mimeType, prompt: source.text,
      sourceAssetId: request.sourceAssetId, sourceProvenance: request.sourceProvenance, maskEncoding: "one_bit", includeConfidence: true }));
  }
  return sha256(JSON.stringify({ version: 2, model: "sam-3.1", promptKind: "geometry", sourceSha256: sha256(source.bytes), mimeType: request.mimeType, geometry: source.text,
    objects: source.objects.map(({ objectId, label, origin }) => ({ objectId, label, origin })),
    sourceAssetId: request.sourceAssetId, sourceProvenance: request.sourceProvenance, maskEncoding: "one_bit", includeConfidence: true }));
}
async function recoverSource(request: MetaSegmentationRequest, source: SourceRaster, directory: string): Promise<MetaSegmentationResult | null> {
  let record: StoredSegmentationResponse | null;
  try { record = await readStoredSegmentationResponse(directory, requestBinding(request, source)); }
  catch (error) { throw wrappedFailure(error, "recovery"); }
  if (!record) return null;
  try { return await decodeResult(record.response, request, source, record.elapsedMs); }
  catch (error) { throw wrappedFailure(error, "decode", true, record); }
}

/** Offline recovery; null only means no prior request or response exists. */
export async function recoverMetaSegmentationResponse(request: MetaSegmentationRequest, responseDirectory: string): Promise<MetaSegmentationResult | null> {
  return recoverSource(request, await inspectSource(request), responseDirectory);
}

/**
 * One bounded Meta-hosted SAM request, with inline source bytes and no retries.
 * Official docs verified 2026-11-02: /docs/sam/overview, /segmenting and /reading-segmentation.
 * Segmentation changes alpha only. It never upgrades an illustration to business photography.
 */
export async function segmentMetaImage(request: MetaSegmentationRequest, dependencies: MetaSegmentationDependencies = {}): Promise<MetaSegmentationResult> {
  const source = await inspectSource(request);
  const model = dependencies.model ?? getMetaModelConfig().segmentation ?? "sam-3.1";
  if (model !== "sam-3.1") throw new MetaClientError("MODEL_NOT_ALLOWED", "Only the verified SAM 3.1 adapter is supported.");
  if (dependencies.responseDirectory) {
    const recovered = await recoverSource(request, source, dependencies.responseDirectory);
    if (recovered) return recovered;
  }
  // Constructing the client validates credentials before writing a paid-attempt
  // marker. Cached responses above never need credentials or a network client.
  const client = dependencies.client ?? new MetaClient({ models: { segmentation: model }, timeoutMs: 120000, maxResponseBytes: 8 * 1024 * 1024 });
  if (dependencies.responseDirectory) {
    try { await markSegmentationRequested(dependencies.responseDirectory, requestBinding(request, source)); }
    catch (error) { throw wrappedFailure(error, "storage"); }
  }
  const started = Date.now();
  let response: unknown;
  try {
    response = await client.requestJson("/responses", { method: "POST", modelRole: "segmentation", body: {
      model, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: source.text }, { type: "input_image", image_url: `data:${request.mimeType};base64,${source.bytes.toString("base64")}` }] }],
      stream: false, store: false, metadata: { mask_encoding: "one_bit", include_confidence: "true" },
    } });
  } catch (error) { throw wrappedFailure(error, "request", false, undefined, Date.now() - started); }
  const record: StoredSegmentationResponse = { version: 1, inputHash: requestBinding(request, source), receivedAt: new Date().toISOString(), elapsedMs: Date.now() - started, response };
  if (dependencies.responseDirectory) {
    try { await storeSegmentationResponse(dependencies.responseDirectory, record); }
    catch (error) { throw wrappedFailure(error, "storage", false, record); }
  }
  try { return await decodeResult(response, request, source, record.elapsedMs); }
  catch (error) { throw wrappedFailure(error, "decode", Boolean(dependencies.responseDirectory), record); }
}
