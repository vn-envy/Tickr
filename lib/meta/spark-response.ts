import { createHash } from "node:crypto";
import { z } from "zod";
import { MetaClient } from "./client";
import { MetaClientError, getServerEnvironment } from "./config";
import type { PaidResponseStore, StoredPaidResponse } from "./paid-response-store";

/**
 * Shared Muse Spark `POST /responses` building blocks for paid adapters.
 *
 * Request/response handling mirrors lib/research/analyze.ts (the shape the account accepts):
 * a top-level `instructions` string, user input, `reasoning.effort`, `max_output_tokens`,
 * `store: false` and strict `text.format: { type: "json_schema", strict: true, schema }`.
 * Multimodal input is a single user message whose content lists `input_text`,
 * `input_image` (`image_url` data URL) and `input_video` (`video_url` data URL) parts.
 *
 * Nothing here retries. `runPaidSparkCall` implements the mandatory paid-response-store
 * protocol: read → (no record) construct client → mark → call → store → decode. A decode
 * failure after storing is terminal: the raw response stays retained and is never re-requested.
 */
export const SPARK_DEFAULT_MODEL = "muse-spark-1.3";
export const SPARK_MAX_REQUEST_BYTES = 42 * 1024 * 1024;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const RESPONSE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
export const sha256Hex = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export interface SparkUsage { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }
export interface SparkCompletedText { responseId: string | null; model: string | null; outputText: string; usage: SparkUsage }

/** Content parts of the single user message sent to Spark. Media is always inline. */
export type SparkInputPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "input_video"; video_url: string };

export interface SparkCallDiagnostic {
  phase: "input" | "request" | "storage" | "decode" | "recovery";
  code: string;
  /** Fixed, user-safe text: never provider bodies, model output, local paths or credentials. */
  detail: string;
  httpStatus: number | null;
  completedResponseStored: boolean;
  responseId: string | null;
  elapsedMs: number;
  usage: SparkUsage | null;
}

export class SparkCallFailure extends MetaClientError {
  constructor(readonly diagnostic: SparkCallDiagnostic, outcome: "unknown" | "not_applicable") {
    super(diagnostic.code, diagnostic.detail, { status: diagnostic.httpStatus ?? undefined, outcome });
    this.name = "SparkCallFailure";
  }
}

const safeErrors = new WeakSet<Error>();
const clientMessages: Record<string, string> = {
  API_KEY_MISSING: "META_API_KEY is required in the server environment.",
  MODEL_NOT_ALLOWED: "This Muse Spark model is not enabled for owner material.",
  MODEL_NOT_CONFIGURED: "The Muse Spark model is not configured.",
  MODEL_MISMATCH: "The request model did not match the configured model role.",
  REQUEST_TIMEOUT: "Meta request timed out; no retry was attempted.",
  NETWORK_ERROR: "Meta request failed; no retry was attempted.",
  HTTP_ERROR: "Meta rejected the request; no retry was attempted.",
  INVALID_RESPONSE: "Meta returned a response that was not valid JSON; no retry was attempted.",
  RESPONSE_TOO_LARGE: "Meta response exceeded the configured size limit; no retry was attempted.",
  REDIRECT_NOT_ALLOWED: "Meta API redirects are not allowed.",
};
// Store and adapter codes use fixed messages authored in this repository.
const familyCode = /^[A-Z][A-Z_]{0,39}_(INVALID|PENDING|CHECKPOINT_INVALID|REFUSED|INCOMPLETE)$/;

/** A fixed-message validation error that is safe to show. `paid` marks errors after a paid call. */
export function sparkInvalid(family: string, message: string, paid = false, kind: "INVALID" | "REFUSED" | "INCOMPLETE" = "INVALID"): MetaClientError {
  const error = new MetaClientError(`${family}_${kind}`, message, { outcome: paid ? "unknown" : "not_applicable" });
  safeErrors.add(error);
  return error;
}

/** Fixed descriptions and actual metering only; unknown errors collapse to a generic code. */
export function getSparkCallDiagnostic(error: unknown, family = "SPARK"): SparkCallDiagnostic {
  if (error instanceof SparkCallFailure) return error.diagnostic;
  const httpStatus = error instanceof MetaClientError && Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599 ? error.status! : null;
  if (error instanceof MetaClientError && (safeErrors.has(error) || familyCode.test(error.code))) {
    return { phase: "input", code: error.code, detail: error.message, httpStatus, completedResponseStored: false, responseId: null, elapsedMs: 0, usage: null };
  }
  if (error instanceof MetaClientError && clientMessages[error.code]) {
    return { phase: "input", code: error.code, detail: clientMessages[error.code], httpStatus, completedResponseStored: false, responseId: null, elapsedMs: 0, usage: null };
  }
  return { phase: "input", code: `${family}_FAILED`, detail: "The Muse Spark operation could not be completed safely.", httpStatus, completedResponseStored: false, responseId: null, elapsedMs: 0, usage: null };
}

/**
 * Model selection: explicit dependency, then META_REASONING_MODEL, then muse-spark-1.3.
 * Contributor variants are rejected because owner media and goals must not feed them.
 */
export function resolveSparkModel(explicit?: string, environment: Record<string, string | undefined> = getServerEnvironment()): string {
  const model = (explicit ?? environment.META_REASONING_MODEL ?? SPARK_DEFAULT_MODEL).trim() || SPARK_DEFAULT_MODEL;
  if (/contributor/i.test(model)) throw new MetaClientError("MODEL_NOT_ALLOWED", "Contributor model variants are not enabled for owner material.");
  if (!MODEL_PATTERN.test(model)) throw new MetaClientError("MODEL_NOT_ALLOWED", "The configured Muse Spark model name is invalid.");
  return model;
}

/** Strict structured-output format. Use strict zod objects and nullable (never optional) fields. */
export function sparkJsonTextFormat(name: string, schema: z.ZodType) {
  if (!/^[a-z0-9_]{1,64}$/.test(name)) throw new Error("Invalid structured-output name.");
  return { type: "json_schema" as const, name, strict: true as const, schema: z.toJSONSchema(schema) };
}

export interface SparkRequestOptions {
  model: string;
  instructions: string;
  content: readonly SparkInputPart[];
  format: ReturnType<typeof sparkJsonTextFormat>;
  maxOutputTokens: number;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

export function buildSparkResponsesBody(options: SparkRequestOptions): Record<string, unknown> {
  if (!options.content.length || !Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 256 || options.maxOutputTokens > 64_000) {
    throw new Error("Invalid Muse Spark request options.");
  }
  return {
    model: options.model,
    instructions: options.instructions,
    input: [{ type: "message", role: "user", content: options.content.map((part) => ({ ...part })) }],
    reasoning: { effort: options.reasoningEffort ?? "minimal" },
    max_output_tokens: options.maxOutputTokens,
    stream: false,
    store: false,
    text: { format: options.format },
  };
}

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
}).passthrough();
const envelopeSchema = z.object({ id: z.string().regex(RESPONSE_ID_PATTERN).optional(), usage: usageSchema.optional() }).passthrough();
const responseSchema = z.object({
  id: z.unknown().optional(),
  status: z.string().max(40),
  model: z.unknown().optional(),
  output: z.array(z.object({ type: z.string().max(80), content: z.array(z.object({ type: z.string().max(80), text: z.string().optional() }).passthrough()).max(64).optional() }).passthrough()).max(64).optional(),
  usage: z.unknown().optional(),
}).passthrough();

/** Actual metering reported by the provider. Missing fields stay null; costs are never invented. */
export function extractSparkUsage(response: unknown): SparkUsage {
  const usage = envelopeSchema.safeParse(response);
  const value = usage.success ? usage.data.usage : undefined;
  return { inputTokens: value?.input_tokens ?? null, outputTokens: value?.output_tokens ?? null, totalTokens: value?.total_tokens ?? null };
}

export function extractSparkResponseId(response: unknown): string | null {
  const envelope = envelopeSchema.safeParse(response);
  return envelope.success ? envelope.data.id ?? null : null;
}

/**
 * Extract the completed structured text. Refusals and incomplete responses fail closed with
 * fixed messages; the caller has already retained the raw response for offline inspection.
 */
export function extractSparkResponse(response: unknown, options: { family: string; maxOutputTextBytes: number }): SparkCompletedText {
  const parsed = responseSchema.safeParse(response);
  if (!parsed.success) throw sparkInvalid(options.family, "Meta returned an unrecognized Muse Spark response; no retry was attempted.", true);
  const content = (parsed.data.output ?? []).filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
  if (content.some((item) => item.type === "refusal")) throw sparkInvalid(options.family, "Muse Spark declined this request; no retry was attempted.", true, "REFUSED");
  if (parsed.data.status !== "completed") throw sparkInvalid(options.family, "Muse Spark did not complete the response; no retry was attempted.", true, "INCOMPLETE");
  const outputText = content.filter((item) => item.type === "output_text").map((item) => item.text ?? "").join("");
  if (!outputText.trim()) throw sparkInvalid(options.family, "Muse Spark returned no structured output; no retry was attempted.", true);
  if (Buffer.byteLength(outputText) > options.maxOutputTextBytes) throw sparkInvalid(options.family, "Muse Spark output exceeded its byte limit.", true);
  return {
    responseId: extractSparkResponseId(response),
    model: typeof parsed.data.model === "string" && MODEL_PATTERN.test(parsed.data.model) ? parsed.data.model : null,
    outputText,
    usage: extractSparkUsage(response),
  };
}

/** Parse structured output text against a zod schema; failures carry a fixed message. */
export function parseSparkJson<T>(outputText: string, schema: z.ZodType<T>, family: string): T {
  let value: unknown;
  try { value = JSON.parse(outputText); }
  catch { throw sparkInvalid(family, "Muse Spark returned output that was not valid JSON; no retry was attempted.", true); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw sparkInvalid(family, "Muse Spark output did not match the required structure; no retry was attempted.", true);
  return parsed.data;
}

export interface SparkClientLimits { timeoutMs: number; maxResponseBytes: number }

export interface PaidSparkCall<T> {
  family: string;
  store: PaidResponseStore;
  /** Private per-request directory, normally under ignored .data/. */
  responseDirectory: string;
  /** sha256 over a versioned binding of every request-defining input. */
  inputHash: string;
  model: string;
  client?: Pick<MetaClient, "requestJson">;
  limits: SparkClientLimits;
  /** Built lazily so offline recovery never re-encodes media. */
  body: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  decode: (response: unknown, record: { elapsedMs: number; receivedAt: string }) => T | Promise<T>;
}

function wrap(error: unknown, family: string, phase: SparkCallDiagnostic["phase"], completedResponseStored: boolean, record?: Pick<StoredPaidResponse, "response" | "elapsedMs">, elapsedMs = 0): SparkCallFailure {
  if (error instanceof SparkCallFailure) return error;
  const diagnostic = getSparkCallDiagnostic(error, family);
  return new SparkCallFailure({
    ...diagnostic, phase, completedResponseStored, elapsedMs: record?.elapsedMs ?? elapsedMs,
    responseId: record ? extractSparkResponseId(record.response) : null,
    usage: record ? extractSparkUsage(record.response) : null,
  }, error instanceof MetaClientError ? error.outcome : "unknown");
}

/**
 * One paid Spark call under the paid-response-store protocol. Never retried; a pending or
 * corrupt checkpoint never authorizes a new call. Errors are SparkCallFailure with diagnostics.
 */
export async function runPaidSparkCall<T>(call: PaidSparkCall<T>): Promise<T> {
  let saved: StoredPaidResponse | null;
  try { saved = await call.store.read(call.responseDirectory, call.inputHash); }
  catch (error) { throw wrap(error, call.family, "recovery", false); }
  if (saved) {
    try { return await call.decode(saved.response, { elapsedMs: saved.elapsedMs, receivedAt: saved.receivedAt }); }
    catch (error) { throw wrap(error, call.family, "decode", true, saved); }
  }
  let client: Pick<MetaClient, "requestJson">;
  let body: Record<string, unknown>;
  try {
    body = await call.body();
    if (body.model !== call.model) throw sparkInvalid(call.family, "The Muse Spark request model is inconsistent.");
    if (Buffer.byteLength(JSON.stringify(body)) > SPARK_MAX_REQUEST_BYTES) throw sparkInvalid(call.family, "The Muse Spark request exceeded its byte limit.");
    // Constructing the client validates credentials before a paid-attempt marker is written.
    client = call.client ?? new MetaClient({ models: { reasoning: call.model }, timeoutMs: call.limits.timeoutMs, maxResponseBytes: call.limits.maxResponseBytes });
  } catch (error) { throw wrap(error, call.family, "input", false); }
  try { await call.store.mark(call.responseDirectory, call.inputHash); }
  catch (error) { throw wrap(error, call.family, "storage", false); }
  const started = Date.now();
  let response: unknown;
  try { response = await client.requestJson("/responses", { method: "POST", modelRole: "reasoning", body }); }
  catch (error) { throw wrap(error, call.family, "request", false, undefined, Date.now() - started); }
  const record: StoredPaidResponse = { version: 1, inputHash: call.inputHash, receivedAt: new Date().toISOString(), elapsedMs: Date.now() - started, response };
  try { await call.store.store(call.responseDirectory, record); }
  catch (error) { throw wrap(error, call.family, "storage", false, record); }
  try { return await call.decode(response, { elapsedMs: record.elapsedMs, receivedAt: record.receivedAt }); }
  catch (error) { throw wrap(error, call.family, "decode", true, record); }
}

/** Untrusted free text (captions, goals, names): NFKC, no control characters, bounded. */
export function cleanDataText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/gu, " ").trim();
  return text.length <= maximum ? text : null;
}

/**
 * A short noun phrase usable as a SAM concept prompt (SAM output is a selection, never an identity check).
 * Returns null for anything that could carry SAM control tokens or is not a bounded phrase.
 */
export function cleanSamConceptLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!label || label.length > 80 || /[<>|;\\{}[\]\u0000-\u001f\u007f]/u.test(label) || label.split(" ").length > 8) return null;
  return label;
}

/**
 * Bound descriptive model text: NFKC, control characters removed, whitespace collapsed and,
 * when longer than `maximum`, cut at a word boundary with an ellipsis. Not for exact quotes.
 */
export function boundModelText(value: string, maximum: number): string {
  const text = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ").replace(/\s+/gu, " ").trim();
  if (text.length <= maximum) return text;
  const cut = text.slice(0, Math.max(1, maximum - 1));
  const space = cut.lastIndexOf(" ");
  return `${(space > maximum * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Inline media for Spark. Remote URLs are never sent to Meta. */
export function sparkDataUrl(mimeType: "image/jpeg" | "image/png" | "image/webp" | "video/mp4", bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")}`;
}

/** Input hash over a versioned JSON binding of every request-defining input. */
export function sparkInputHash(binding: { version: string } & Record<string, unknown>): string {
  return sha256Hex(JSON.stringify(binding));
}

/** Stable fingerprint of fixed prompt material (instructions, schema) for input bindings. */
export function sparkPromptFingerprint(instructions: string, format: ReturnType<typeof sparkJsonTextFormat>): string {
  return sha256Hex(JSON.stringify({ instructions, format }));
}
