import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { CRITIC_REEL_ASSET_ID, critiqueCampaign, getCriticDiagnostic, resolveCriticModel, type CritiqueReport } from "../lib/agents/critic";
import { CinemaEncodeError } from "../lib/campaign/cinema/encode";
import { renderSamOverlayVideo, SamOverlayError, type SamOverlayResult } from "../lib/campaign/cinema/overlay";
import { renderStillDepthReel, StillDepthError, type StillDepthInput } from "../lib/campaign/cinema/still-depth";
import { renderTrackedReel, TrackedCinemaError, type TrackedReelResult } from "../lib/campaign/cinema/tracked";
import { svgDocument } from "../lib/campaign/cinema/typography";
import type { NormalizedClip } from "../lib/media/cinema-types";
import { normalizeOwnerClip, OwnerClipError } from "../lib/media/clip";
import { MaskletStoreError } from "../lib/media/masklets";
import { composeObjectLayer } from "../lib/media/object-layers";
import type { MetaClient, MetaJsonRequest } from "../lib/meta/client";
import { MetaClientError } from "../lib/meta/config";
import { analyzeMediaAssets, getMediaAnalysisDiagnostic, type MediaAnalysisResult } from "../lib/meta/media-analysis";
import type { SamBox, SparkGridBox } from "../lib/meta/sam-prompts";
import { framesBilledFrom, getSamVideoDiagnostic, trackMetaVideo, type SamVideoResult } from "../lib/meta/sam-video";
import { getMetaSegmentationDiagnostic, segmentMetaImage, type MetaSegmentationResult } from "../lib/meta/segmentation";
import { resolveSparkModel, type SparkUsage } from "../lib/meta/spark-response";
import { analyzeClipShots, getShotLogDiagnostic, type ShotLog } from "../lib/meta/video-understanding";

/**
 * Autopilot live capability probe: one explicit run of every paid Meta operation the Autopilot
 * uses, on SYNTHETIC media drawn locally (sharp shapes, an FFmpeg lavfi clip). Nothing is
 * fetched from third parties and no business or owner data is involved.
 *
 *   npm run autopilot:check            live (needs META_API_KEY in the server environment)
 *   npm run autopilot:check -- --dry   offline: the same flow with injected fake Meta clients
 *
 * Every paid step uses its adapter's paid-response protocol in its own private directory under
 * .data/autopilot-live-check/<timestamp>/ (requested marker before the call, raw response
 * retained privately, never retried). report.json records only models, endpoints, timings,
 * response ids, usage numbers and fixed-code diagnostics: never raw bodies, prompts, headers
 * or keys. The cost figure is a clearly labelled list-price ESTIMATE, not an invoice.
 */

const run = promisify(execFile);
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export const LIVE_CHECK_VERSION = "autopilot-live-check-1" as const;
export const DEFAULT_LIVE_CHECK_ROOT = ".data/autopilot-live-check";
const SAM_MODEL = "sam-3.1";
const ENDPOINT = "POST https://api.meta.ai/v1/responses";

/** Dated list prices (BUILD_SPEC.md, verified 2026-11-04). Used only for the labelled estimate. */
export const LIVE_CHECK_LIST_PRICES = {
  pricesDated: "2026-11-04",
  currency: "USD",
  spark: { model: "muse-spark-1.3", inputPerMillionTokens: 1.25, outputPerMillionTokens: 4.25 },
  samImage: { model: SAM_MODEL, perThousandImages: 2.5 },
  samVideo: { model: SAM_MODEL, perThousandFrames: 0.2, minimumFramesPerRequest: 50 },
} as const;

// ------------------------------------------------------------------------------------------
// Synthetic media (drawn locally; never business media)
// ------------------------------------------------------------------------------------------

const IMAGE_WIDTH = 1080, IMAGE_HEIGHT = 1350;
const CLIP_WIDTH = 960, CLIP_HEIGHT = 540, CLIP_FPS = 30, CLIP_SECONDS = 4, DISK = 160;

interface SyntheticImage { assetId: string; filename: string; drawnBox: SamBox; fallbackConcept: string; svg: string }

const wood = (top: number, height: number, base: [number, number, number]) => Array.from({ length: 9 }, (_, index) => {
  const shade = (index * 37) % 23 - 11;
  const [r, g, b] = base.map((value) => Math.max(0, Math.min(255, value + shade)));
  return `<rect x="0" y="${top + index * Math.ceil(height / 9)}" width="${IMAGE_WIDTH}" height="${Math.ceil(height / 9)}" fill="rgb(${r},${g},${b})"/>`;
}).join("");

/** A cup of coffee on a saucer on a wooden table. Shapes and gradients only; no text. */
const CUP: SyntheticImage = {
  assetId: "synthetic-cup", filename: "synthetic-cup.png", drawnBox: { x1: 200, y1: 600, x2: 880, y2: 1085 }, fallbackConcept: "coffee cup",
  svg: svgDocument(IMAGE_WIDTH, IMAGE_HEIGHT, [
    `<rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#wall)"/>`, wood(900, 450, [128, 84, 52]),
    `<ellipse cx="560" cy="1060" rx="330" ry="36" fill="#3b2414" fill-opacity="0.35"/>`,
    `<ellipse cx="540" cy="1010" rx="330" ry="70" fill="url(#porcelain)" stroke="#cfc6bb" stroke-width="6"/>`,
    `<path d="M745 700 C890 690 890 905 712 900" stroke="#ece6df" stroke-width="40" fill="none" stroke-linecap="round"/>`,
    `<path d="M330 640 L750 640 L700 960 Q690 1000 650 1000 L430 1000 Q390 1000 380 960 Z" fill="url(#porcelain)" stroke="#d8d0c6" stroke-width="4"/>`,
    `<ellipse cx="540" cy="642" rx="208" ry="40" fill="#6b3f22"/>`,
    `<ellipse cx="540" cy="645" rx="86" ry="20" fill="#e8cfa8"/><ellipse cx="540" cy="645" rx="44" ry="10" fill="#6b3f22" fill-opacity="0.55"/>`,
    `<rect x="372" y="660" width="26" height="290" rx="13" fill="#ffffff" fill-opacity="0.45"/>`,
  ].join(""), [
    `<linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e3c39d"/><stop offset="1" stop-color="#9c6b45"/></linearGradient>`,
    `<linearGradient id="porcelain" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset="0.7" stop-color="#ece7e1"/><stop offset="1" stop-color="#c9c1b7"/></linearGradient>`,
  ].join("")),
};

/** A glass jar of orange preserve with a blank label on a shelf. Shapes and gradients only; no text. */
const JAR: SyntheticImage = {
  assetId: "synthetic-jar", filename: "synthetic-jar.png", drawnBox: { x1: 345, y1: 435, x2: 735, y2: 1065 }, fallbackConcept: "glass jar",
  svg: svgDocument(IMAGE_WIDTH, IMAGE_HEIGHT, [
    `<rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#cool)"/>`, wood(1050, 300, [185, 138, 94]),
    `<ellipse cx="560" cy="1062" rx="230" ry="22" fill="#2c3b40" fill-opacity="0.35"/>`,
    `<rect x="350" y="520" width="380" height="540" rx="60" fill="url(#preserve)" stroke="#ffffff" stroke-opacity="0.65" stroke-width="10"/>`,
    `<rect x="382" y="585" width="28" height="420" rx="14" fill="#ffffff" fill-opacity="0.35"/>`,
    `<rect x="370" y="440" width="340" height="92" rx="18" fill="#c9a227"/>`,
    ...[462, 486, 510].map((y) => `<rect x="378" y="${y}" width="324" height="5" fill="#8f7116"/>`),
    `<rect x="408" y="720" width="270" height="160" rx="14" fill="#fbf3e4"/>`,
    `<ellipse cx="543" cy="800" rx="58" ry="30" fill="#5f8f3e"/><ellipse cx="543" cy="800" rx="4" ry="30" fill="#3f6a27"/>`,
  ].join(""), [
    `<linearGradient id="cool" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d6e6e8"/><stop offset="1" stop-color="#7d9ea6"/></linearGradient>`,
    `<linearGradient id="preserve" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f7a53c"/><stop offset="0.6" stop-color="#e5781c"/><stop offset="1" stop-color="#b9540e"/></linearGradient>`,
  ].join("")),
};

/** Top-left of the red disk at time t (lavfi overlay expressions below use the same formula). */
export function syntheticDiskOrigin(seconds: number): { x: number; y: number } {
  return { x: Math.round(80 + 170 * seconds), y: Math.round(190 + 110 * Math.sin(Math.PI * seconds / 2)) };
}

const FFMPEG_TIMEOUT_MS = 120_000;

/** A 4 s moving red disk on a static textured background, built entirely from lavfi sources. */
async function writeSyntheticClip(path: string): Promise<void> {
  const graph = [
    `color=c=0x6e4b32:s=${CLIP_WIDTH}x${CLIP_HEIGHT}:r=${CLIP_FPS}:d=${CLIP_SECONDS},noise=alls=28:allf=u,drawgrid=w=160:h=90:t=3:c=0x3d2817@0.55[bg]`,
    `color=c=0xd62828:s=${DISK}x${DISK}:r=${CLIP_FPS}:d=${CLIP_SECONDS},format=rgba,geq=r='min(255,190+60*(1-hypot(X-60,Y-60)/120))':g='40':b='40':a='255*lte(hypot(X-${(DISK - 1) / 2},Y-${(DISK - 1) / 2}),${DISK / 2 - 2})'[disk]`,
    `[bg][disk]overlay=x='80+170*t':y='190+110*sin(PI*t/2)':eval=frame:shortest=1,format=yuv420p[v]`,
  ].join(";");
  try {
    await run("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-filter_complex", graph, "-map", "[v]",
      "-r", String(CLIP_FPS), "-frames:v", String(CLIP_FPS * CLIP_SECONDS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-an", "-map_metadata", "-1", "-movflags", "+faststart", "-n", path,
    ], { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 64 * 1024 });
  } catch { throw new LiveCheckError("SYNTHETIC_CLIP_FAILED", "FFmpeg could not generate the synthetic clip locally."); }
}

// ------------------------------------------------------------------------------------------
// Report shapes
// ------------------------------------------------------------------------------------------

export type LiveCheckStepId = "spark-media-analysis" | "sam-image-geometry" | "sam-image-concept" | "clip-shotlog" | "sam-video-tracking" | "reel-render" | "spark-critic";
export type LiveCheckStatus = "succeeded" | "failed" | "skipped";

export interface LiveCheckDiagnostic {
  phase: string;
  /** Fixed code from the adapter or this script. */
  code: string;
  /** Fixed, user-safe text; never provider bodies, prompts, paths or credentials. */
  detail: string;
  httpStatus: number | null;
  completedResponseStored: boolean;
}

export type LiveCheckBillable =
  | { kind: "spark_tokens"; model: string; inputTokens: number | null; outputTokens: number | null; basis: "reported" }
  | { kind: "sam_images"; model: string; images: number; basis: "reported" | "counted_requests" }
  | { kind: "sam_video_frames"; model: string; frames: number; basis: "reported" | "counted_clip_frames" };

export interface LiveCheckStep {
  index: number;
  id: LiveCheckStepId;
  title: string;
  status: LiveCheckStatus;
  model: string | null;
  endpoint: string | null;
  /** Provider request time as recorded by the adapter (null for local-only work). */
  elapsedMs: number | null;
  /** Wall-clock time of the whole step, including local preparation and rendering. */
  wallMs: number;
  responseId: string | null;
  /** Numeric usage fields exactly as reported (snake_case as on the wire). */
  usage: Record<string, number> | null;
  billable: LiveCheckBillable[];
  /**
   * True when a paid request may have been billed but no billable line could be recorded: the
   * request outcome is unknown, or a response arrived whose billable usage could not be derived.
   */
  paidOutcomeUnknown: boolean;
  diagnostic: LiveCheckDiagnostic | null;
  /** Small derived facts (counts, hashes, flags). Never raw model text beyond short labels. */
  facts: Record<string, unknown>;
  /** Private step directory, relative to the run directory. */
  directory: string;
}

export interface LiveCheckEstimateLine {
  step: LiveCheckStepId;
  kind: LiveCheckBillable["kind"];
  model: string;
  quantity: string;
  basis: string;
  usd: number | null;
  note: string | null;
}
export interface LiveCheckEstimate {
  label: string;
  pricesDated: string;
  currency: "USD";
  lines: LiveCheckEstimateLine[];
  /** Sum of the lines that have a price. */
  totalUsd: number;
  incomplete: boolean;
  notes: string[];
}

export interface LiveCheckReport {
  version: typeof LIVE_CHECK_VERSION;
  mode: "live" | "dry";
  startedAt: string;
  finishedAt: string;
  /** Run directory name under the live-check root. */
  run: string;
  syntheticMedia: Array<{ file: string; kind: "image" | "video"; sha256: string; bytes: number; width: number; height: number; note: string }>;
  steps: LiveCheckStep[];
  succeeded: boolean;
  estimate: LiveCheckEstimate;
  notes: string[];
}

export class LiveCheckError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "LiveCheckError"; }
}

// ------------------------------------------------------------------------------------------
// Diagnostics, usage and estimate
// ------------------------------------------------------------------------------------------

export type AdapterDiagnostic = { phase: string; code: string; detail: string; httpStatus: number | null; completedResponseStored: boolean; responseId: string | null; elapsedMs: number; usage: unknown };

const LOCAL_DETAIL: Record<string, string> = {
  OwnerClipError: "The synthetic clip could not be normalized locally.",
  CinemaEncodeError: "The local H.264 encoder failed.",
  StillDepthError: "The still-depth Reel could not be rendered locally.",
  TrackedCinemaError: "The tracked Reel could not be rendered locally.",
  SamOverlayError: "The SAM overlay preview could not be rendered locally.",
  MaskletStoreError: "The SAM masklet store could not be read or verified.",
};

/** Fixed-code diagnostic for any failure. Raw error messages are only used for this script's own fixed errors. */
export function diagnoseLiveCheckError(error: unknown, adapter?: (error: unknown) => AdapterDiagnostic): { diagnostic: LiveCheckDiagnostic; recorded: AdapterDiagnostic | null; paidOutcomeUnknown: boolean } {
  const local = (code: string, detail: string) => ({ diagnostic: { phase: "local", code, detail, httpStatus: null, completedResponseStored: false }, recorded: null, paidOutcomeUnknown: false });
  if (error instanceof LiveCheckError) return local(error.code, error.message);
  if (error instanceof OwnerClipError) return local(`CLIP_${error.code}`, LOCAL_DETAIL.OwnerClipError);
  if (error instanceof CinemaEncodeError) return local(`ENCODE_${error.code}`, LOCAL_DETAIL.CinemaEncodeError);
  if (error instanceof StillDepthError) return local("STILL_DEPTH_FAILED", LOCAL_DETAIL.StillDepthError);
  if (error instanceof TrackedCinemaError) return local("TRACKED_REEL_FAILED", LOCAL_DETAIL.TrackedCinemaError);
  if (error instanceof SamOverlayError) return local("SAM_OVERLAY_FAILED", LOCAL_DETAIL.SamOverlayError);
  if (error instanceof MaskletStoreError) return local(error.code, LOCAL_DETAIL.MaskletStoreError);
  if (adapter && error instanceof MetaClientError) {
    const recorded = adapter(error);
    return {
      diagnostic: { phase: recorded.phase, code: recorded.code, detail: recorded.detail, httpStatus: recorded.httpStatus, completedResponseStored: recorded.completedResponseStored },
      recorded,
      // A request-phase failure with an unknown outcome may still have been processed (and billed) by Meta.
      paidOutcomeUnknown: recorded.phase === "request" && error.outcome === "unknown",
    };
  }
  return local("LOCAL_STEP_FAILED", "The step failed locally; details are withheld from the report by design.");
}

function sparkUsageRecord(usage: SparkUsage | null | undefined): Record<string, number> | null {
  if (!usage) return null;
  const entries = Object.entries({ input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens }).filter((entry): entry is [string, number] => typeof entry[1] === "number");
  return entries.length ? Object.fromEntries(entries) : null;
}
function samImageUsageRecord(usage: MetaSegmentationResult["usage"] | null | undefined): Record<string, number> | null {
  if (!usage) return null;
  const entries = Object.entries({ input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens, images_processed: usage.imagesProcessed }).filter((entry): entry is [string, number] => typeof entry[1] === "number");
  return entries.length ? Object.fromEntries(entries) : null;
}
function numericRecord(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => /^[A-Za-z0-9_.]{1,80}$/.test(entry[0]) && typeof entry[1] === "number" && Number.isFinite(entry[1]));
  return entries.length ? Object.fromEntries(entries.slice(0, 64)) : null;
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** List-price arithmetic over the recorded billable units. An ESTIMATE, never an invoice. */
export function estimateLiveCheckCost(steps: readonly LiveCheckStep[], mode: "live" | "dry"): LiveCheckEstimate {
  const prices = LIVE_CHECK_LIST_PRICES;
  const lines: LiveCheckEstimateLine[] = [];
  const notes: string[] = [];
  let incomplete = false;
  for (const step of steps) {
    for (const unit of step.billable) {
      if (unit.kind === "spark_tokens") {
        const priced = unit.model === prices.spark.model;
        const known = unit.inputTokens !== null && unit.outputTokens !== null;
        const usd = priced && known ? round6(unit.inputTokens! / 1e6 * prices.spark.inputPerMillionTokens + unit.outputTokens! / 1e6 * prices.spark.outputPerMillionTokens) : null;
        if (usd === null) incomplete = true;
        lines.push({ step: step.id, kind: unit.kind, model: unit.model, quantity: `${unit.inputTokens ?? "?"} in / ${unit.outputTokens ?? "?"} out tokens`, basis: unit.basis, usd,
          note: !priced ? "No dated list price for this model." : known ? null : "Token usage was not reported." });
      } else if (unit.kind === "sam_images") {
        lines.push({ step: step.id, kind: unit.kind, model: unit.model, quantity: `${unit.images} image(s)`, basis: unit.basis, usd: round6(unit.images / 1000 * prices.samImage.perThousandImages),
          note: unit.basis === "counted_requests" ? "images_processed not reported; counted one image per request." : null });
      } else {
        const billed = Math.max(prices.samVideo.minimumFramesPerRequest, unit.frames);
        lines.push({ step: step.id, kind: unit.kind, model: unit.model, quantity: `${billed} frame(s)${billed !== unit.frames ? ` (minimum applied to ${unit.frames})` : ""}`, basis: unit.basis,
          usd: round6(billed / 1000 * prices.samVideo.perThousandFrames), note: unit.basis === "counted_clip_frames" ? "Billed frames not reported; counted the clip's frames." : null });
      }
    }
    if (step.paidOutcomeUnknown) {
      incomplete = true;
      const status = step.diagnostic?.httpStatus ?? null;
      const received = step.diagnostic !== null && step.diagnostic.phase !== "request" && step.diagnostic.phase !== "local";
      notes.push(received
        ? `${step.id}: a paid response was received but its billable usage could not be derived; it is not included.`
        : status !== null && status >= 400 && status < 500
          ? `${step.id}: Meta rejected the request (HTTP ${status}); billing was not confirmed by Meta and it is not included.`
          : `${step.id}: a paid request had an unknown outcome and may have been billed; it is not included.`);
    }
  }
  if (mode === "dry") notes.unshift("DRY RUN: usage numbers come from fake clients; this shows the arithmetic only. No request was made and nothing was billed.");
  return {
    label: "LIST-PRICE ESTIMATE ONLY: computed from dated list prices and recorded usage; not an invoice or a measured charge.",
    pricesDated: prices.pricesDated, currency: "USD", lines, totalUsd: round6(lines.reduce((sum, line) => sum + (line.usd ?? 0), 0)), incomplete, notes,
  };
}

// ------------------------------------------------------------------------------------------
// Dry-run fake Meta clients (no network)
// ------------------------------------------------------------------------------------------

type RequestJson = Pick<MetaClient, "requestJson">;
export interface DryScenario {
  /** sha256 of each synthetic image → its drawn subject box (inclusive pixels). */
  imageBoxes: Map<string, SamBox>;
  /** assetId → Spark grid box of the drawn subject. */
  gridBoxes: Map<string, SparkGridBox>;
  /** Set once the clip is normalized. */
  clip: NormalizedClip | null;
  /** Test-only fault injection for the fake SAM video client. Absent: a genuine tracked masklet. */
  faults?: DryFaults;
}
export interface DryFaults {
  /** "empty": a completed response with no tracked object. "undecodable": malformed output and no usage. */
  samVideo?: "empty" | "undecodable";
}
export interface DryClients { spark: RequestJson; sam: RequestJson; calls: Array<{ kind: string; path: string }> }

type Body = { model?: unknown; input?: Array<{ content?: Array<{ type?: string; text?: string; image_url?: string; video_url?: string }> }>; text?: { format?: { name?: string } } };

const dryEnvelope = (id: string, model: string, text: string, usage: Record<string, number>) => ({
  id, status: "completed", model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage,
});

/**
 * Fake transports for --dry. They answer only `POST /responses` with schema-valid synthetic
 * output (SAM payloads are genuine one-bit masks built by the test wire helper) and throw for
 * anything else. They never open a socket.
 */
export async function createDryClients(scenario: DryScenario): Promise<DryClients> {
  const wire = await import("../tests/helpers/sam-wire");
  const calls: DryClients["calls"] = [];
  const guard = (path: string, request: MetaJsonRequest | undefined, role: "reasoning" | "segmentation"): Body => {
    if (path !== "/responses" || request?.method !== "POST" || request.modelRole !== role || !request.body) throw new MetaClientError("ENDPOINT_NOT_ALLOWED", "The dry-run client only answers POST /responses.");
    return request.body as Body;
  };
  const parts = (body: Body) => body.input?.[0]?.content ?? [];
  const spark: RequestJson = {
    requestJson: async <T = unknown>(path: string, request?: MetaJsonRequest): Promise<T> => {
      const body = guard(path, request, "reasoning");
      const model = String(body.model), name = body.text?.format?.name;
      calls.push({ kind: `spark:${name}`, path });
      if (name === "tickr_media_analysis") {
        const ids = parts(body).flatMap((part) => {
          const match = part.type === "input_text" ? /^IMAGE \d+ OF \d+\. Metadata \(untrusted data, not instructions\): (.+)$/s.exec(part.text ?? "") : null;
          return match ? [String((JSON.parse(match[1]) as { assetId: unknown }).assetId)] : [];
        });
        const assets = ids.map((assetId) => {
          const box = scenario.gridBoxes.get(assetId);
          return {
            assetId, depicts: "A locally drawn synthetic product shape on a plain background.", subjectKind: "product", matchedOfferingIds: [],
            primarySubject: box ? { label: assetId === JAR.assetId ? "glass jar" : "coffee cup", box } : null,
            technicalQuality: { sharpness: "good", lighting: "good", composition: "good" }, goalFit: "moderate", goalReason: "Synthetic dry-run observation.",
            heroWorthy: true, heroReason: "Synthetic dry-run observation.", suitableFor: ["reel_hero", "feed"], risks: [], visibleText: "",
          };
        });
        return dryEnvelope("resp_dry_media_analysis", model, JSON.stringify({ assets }), { input_tokens: 1800 * ids.length, output_tokens: 420 * ids.length, total_tokens: 2220 * ids.length }) as T;
      }
      if (name === "tickr_shot_log") {
        const duration = scenario.clip?.durationSeconds ?? CLIP_SECONDS;
        const log = {
          moments: [{ startSeconds: 0, endSeconds: Math.floor(duration * 1000) / 1000, kind: "hero_product", description: "A red disk moves across a textured surface.", steadiness: "steady", subjectLabel: "red disk", goalFit: "moderate" }],
          heroMomentSeconds: 1, peopleVisible: false, speech: { present: false, excerpt: null, language: null },
        };
        return dryEnvelope("resp_dry_shot_log", model, JSON.stringify(log), { input_tokens: 6400, output_tokens: 260, total_tokens: 6660 }) as T;
      }
      if (name === "tickr_campaign_critique") {
        const critique = { findings: [], summary: "Dry run: fake critic output with no findings. Not a review of the media." };
        return dryEnvelope("resp_dry_critic", model, JSON.stringify(critique), { input_tokens: 5200, output_tokens: 90, total_tokens: 5290 }) as T;
      }
      throw new MetaClientError("ENDPOINT_NOT_ALLOWED", "The dry-run client does not know this structured output.");
    },
  };
  const sam: RequestJson = {
    requestJson: async <T = unknown>(path: string, request?: MetaJsonRequest): Promise<T> => {
      const body = guard(path, request, "segmentation");
      const content = parts(body);
      const text = content.find((part) => part.type === "input_text")?.text ?? "";
      const image = content.find((part) => part.type === "input_image")?.image_url;
      const video = content.find((part) => part.type === "input_video")?.video_url;
      if (image) {
        calls.push({ kind: "sam:image", path });
        const bytes = Buffer.from(image.slice(image.indexOf(",") + 1), "base64");
        const metadata = await sharp(bytes).metadata();
        const size = { width: metadata.width!, height: metadata.height! };
        const boxes = [...text.matchAll(/(\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=\d+;h=\d+\|>/g)]
          .map((match) => ({ id: Number(match[1]), box: { x1: Number(match[2]), y1: Number(match[3]), x2: Number(match[4]), y2: Number(match[5]) }, confidence: 0.93 }));
        const concept = scenario.imageBoxes.get(sha256(bytes));
        const objects = text.startsWith("<0f>") ? boxes : concept ? [{ id: 0, box: concept, confidence: 0.9 }] : [];
        return wire.samResponse(wire.samImageWire(objects, size), { images_processed: 1 }) as T;
      }
      if (video && scenario.clip) {
        calls.push({ kind: "sam:video", path });
        if (scenario.faults?.samVideo === "undecodable") {
          return { id: "resp_dry_sam_video", status: "completed", model: "sam-3.1", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "<0f>not-a-record" }] }] } as T;
        }
        if (scenario.faults?.samVideo === "empty") {
          return { ...wire.samResponse("", { frames_billed: Math.max(50, scenario.clip.frameCount) }), id: "resp_dry_sam_video" } as T;
        }
        const clip = scenario.clip, scaleX = clip.width / CLIP_WIDTH, scaleY = clip.height / CLIP_HEIGHT;
        const frames = Array.from({ length: clip.frameCount }, (_, frame) => {
          const origin = syntheticDiskOrigin(frame / clip.fps);
          const x1 = Math.max(0, Math.round(origin.x * scaleX)), y1 = Math.max(0, Math.round(origin.y * scaleY));
          const x2 = Math.min(clip.width - 1, Math.round((origin.x + DISK - 1) * scaleX)), y2 = Math.min(clip.height - 1, Math.round((origin.y + DISK - 1) * scaleY));
          return { frame, objects: [{ id: 0, box: { x1, y1, x2, y2 }, confidence: 0.91 }] };
        });
        return { ...wire.samResponse(wire.samVideoWire(frames, { width: clip.width, height: clip.height }), { frames_billed: Math.max(50, clip.frameCount) }), id: "resp_dry_sam_video" } as T;
      }
      throw new MetaClientError("ENDPOINT_NOT_ALLOWED", "The dry-run client received an unsupported SAM request.");
    },
  };
  return { spark, sam, calls };
}

// ------------------------------------------------------------------------------------------
// The run
// ------------------------------------------------------------------------------------------

export interface LiveCheckOptions {
  dry: boolean;
  /** Parent directory; a fresh `<timestamp>[-dry]` run directory is created inside it. */
  rootDirectory?: string;
  environment?: Record<string, string | undefined>;
  now?: () => Date;
  log?: (line: string) => void;
  /** Test-only fault injection for --dry; ignored for live runs. */
  dryFaults?: DryFaults;
}
export interface LiveCheckOutcome {
  /** 0 all steps succeeded · 1 a step failed · 2 refused (no key or a disallowed model; nothing was created or sent). */
  exitCode: 0 | 1 | 2;
  report: LiveCheckReport | null;
  runDirectory: string | null;
  reportPath: string | null;
}

export const MISSING_KEY_MESSAGE = [
  "Blocked: META_API_KEY is not set in this process environment. No directory was created and no request was made.",
  "Add it as a server-side secret (your environment's secret settings, or `export META_API_KEY=<your key>` in the shell that runs this command).",
  "Never commit it, write it to a file or paste it into chat. Then run `npm run autopilot:check` again,",
  "or run `npm run autopilot:check -- --dry` for the offline flow with fake clients.",
].join("\n");

const GOAL = "Bring more weekday morning visitors in for coffee (synthetic probe goal).";
const BUSINESS = { name: "Probe Cafe (synthetic)", category: "cafe" };
const OFFERINGS = [{ offeringId: "house-latte", name: "House latte" }, { offeringId: "orange-preserve", name: "Orange preserve jar" }];
const SCENES = [
  { kicker: "Morning ritual", headline: "Slow mornings, warm cups", body: "A quiet table, a fresh cup and a few minutes for yourself." },
  { kicker: "Made here", headline: "Poured with care", body: "Every cup is prepared at the counter while you wait." },
  { kicker: "Stay a while", headline: "Your weekday pause", body: "Bring a friend or a book and take a seat by the window." },
  { kicker: "See you soon", headline: "Drop by for a cup", body: "Open on weekday mornings." },
];
const CTA = "Drop by for a cup";
const REEL_CHANNEL = "instagram_reels";
/** Provenance chip for the synthetic probe still (still-depth Reel and the tracked Reel's end card). */
export const STILL_PROBE_PROVENANCE = "Synthetic probe image · SAM cutout";
/** Copy shared by both Reels. mode "synthetic" makes the renderers draw "SYNTHETIC DEMO · CONCEPT" on every frame. */
const RENDER_COPY = {
  scenes: SCENES, cta: CTA, businessName: BUSINESS.name, campaignName: "Synthetic live check", mode: "synthetic" as const,
  theme: { paper: "#f6efe6", ink: "#1d1712", accent: "#c8553d", soft: "#e9dccb" },
};

/** Paths inside the working directory print relative; anything else prints as given. */
function displayPath(path: string): string {
  const inside = relative(process.cwd(), path);
  return inside && !inside.startsWith("..") ? inside : path;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
const gridOf = (box: SamBox): SparkGridBox => ({
  x_min: Math.round(box.x1 / (IMAGE_WIDTH - 1) * 1000), y_min: Math.round(box.y1 / (IMAGE_HEIGHT - 1) * 1000),
  x_max: Math.round(box.x2 / (IMAGE_WIDTH - 1) * 1000), y_max: Math.round(box.y2 / (IMAGE_HEIGHT - 1) * 1000),
});

interface StepWork {
  model: string | null;
  endpoint: string | null;
  elapsedMs?: number | null;
  responseId?: string | null;
  usage?: Record<string, number> | null;
  billable?: LiveCheckBillable[];
  facts?: Record<string, unknown>;
  /** A sub-task failed after partial success: the step is failed with this diagnostic. */
  failure?: LiveCheckDiagnostic;
}

/** Runs the whole probe. Exported so the --dry path can be tested offline. */
export async function runAutopilotLiveCheck(options: LiveCheckOptions): Promise<LiveCheckOutcome> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.log(line));
  const mode = options.dry ? "dry" as const : "live" as const;
  if (mode === "live" && !environment.META_API_KEY?.trim()) {
    log(MISSING_KEY_MESSAGE);
    return { exitCode: 2, report: null, runDirectory: null, reportPath: null };
  }
  // In dry mode only the model-name variables are read, so a dry run never depends on live credentials.
  const sparkEnvironment = mode === "dry" ? { META_REASONING_MODEL: environment.META_REASONING_MODEL, META_CRITIC_MODEL: environment.META_CRITIC_MODEL } : environment;
  let sparkModel: string, criticModel: string;
  try { sparkModel = resolveSparkModel(undefined, sparkEnvironment); criticModel = resolveCriticModel(undefined, sparkEnvironment); }
  catch {
    log("Blocked: META_REASONING_MODEL or META_CRITIC_MODEL names a model that is not enabled for this check. No directory was created and no request was made.");
    return { exitCode: 2, report: null, runDirectory: null, reportPath: null };
  }
  const started = now();
  const root = resolve(options.rootDirectory ?? DEFAULT_LIVE_CHECK_ROOT);
  const runName = `${stamp(started)}${mode === "dry" ? "-dry" : ""}`;
  const runDirectory = join(root, runName);
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Exclusive: an existing run directory is never reused, so no earlier marker or response is touched.
  await mkdir(runDirectory, { mode: 0o700 });
  const mediaDirectory = join(runDirectory, "synthetic-media");
  await mkdir(mediaDirectory, { mode: 0o700 });

  // Synthetic media first: everything below is derived from these local files.
  const syntheticMedia: LiveCheckReport["syntheticMedia"] = [];
  const images = new Map<string, Buffer>();
  for (const image of [CUP, JAR]) {
    const png = await sharp(Buffer.from(image.svg)).flatten({ background: "#ffffff" }).png().toBuffer();
    await writeFile(join(mediaDirectory, image.filename), png, { mode: 0o600, flag: "wx" });
    images.set(image.assetId, png);
    syntheticMedia.push({ file: `synthetic-media/${image.filename}`, kind: "image", sha256: sha256(png), bytes: png.length, width: IMAGE_WIDTH, height: IMAGE_HEIGHT, note: "Drawn locally with sharp (SVG shapes). Synthetic; not business media." });
  }
  const clipSource = join(mediaDirectory, "synthetic-red-disk.mp4");
  let clipSourceReady = false;
  try {
    await writeSyntheticClip(clipSource);
    const bytes = await readFile(clipSource);
    syntheticMedia.push({ file: "synthetic-media/synthetic-red-disk.mp4", kind: "video", sha256: sha256(bytes), bytes: bytes.length, width: CLIP_WIDTH, height: CLIP_HEIGHT, note: "FFmpeg lavfi: moving red disk on a textured background. Synthetic; not business media." });
    clipSourceReady = true;
  } catch { /* Step 4 reports the failure with a fixed code. */ }

  const scenario: DryScenario = {
    imageBoxes: new Map([CUP, JAR].map((image) => [sha256(images.get(image.assetId)!), image.drawnBox])),
    gridBoxes: new Map([CUP, JAR].map((image) => [image.assetId, gridOf(image.drawnBox)])),
    clip: null,
    ...(mode === "dry" && options.dryFaults ? { faults: options.dryFaults } : {}),
  };
  const dry = mode === "dry" ? await createDryClients(scenario) : null;
  const steps: LiveCheckStep[] = [];

  const step = async (index: number, id: LiveCheckStepId, title: string, adapter: ((error: unknown) => AdapterDiagnostic) | undefined, meta: StepMeta, work: (directory: string) => Promise<StepWork>): Promise<LiveCheckStep> => {
    const directory = join(runDirectory, `${String(index).padStart(2, "0")}-${id}`);
    await mkdir(directory, { mode: 0o700 });
    const begun = Date.now();
    let record: LiveCheckStep;
    try {
      const result = await work(directory);
      record = {
        index, id, title, status: result.failure ? "failed" : "succeeded", model: result.model, endpoint: result.endpoint, elapsedMs: result.elapsedMs ?? null, wallMs: Date.now() - begun,
        responseId: result.responseId ?? null, usage: result.usage ?? null, billable: result.billable ?? [], paidOutcomeUnknown: false, diagnostic: result.failure ?? null,
        facts: result.facts ?? {}, directory: relative(runDirectory, directory),
      };
    } catch (error) {
      const { diagnostic, recorded, paidOutcomeUnknown } = diagnoseLiveCheckError(error, adapter);
      const usage = recorded ? numericRecord(recorded.usage) : null;
      const billing = billableFromFailure(meta, usage, recorded);
      record = {
        index, id, title, status: diagnostic.code === "DEPENDENCY_UNAVAILABLE" ? "skipped" : "failed", model: meta.model, endpoint: meta.endpoint,
        elapsedMs: recorded?.elapsedMs || null, wallMs: Date.now() - begun, responseId: recorded?.responseId ?? null, usage: usage && camelToWire(usage),
        billable: billing.billable, paidOutcomeUnknown: paidOutcomeUnknown || billing.unrecorded, diagnostic, facts: {}, directory: relative(runDirectory, directory),
      };
    }
    steps.push(record);
    log(`  ${record.status === "succeeded" ? "ok  " : record.status === "skipped" ? "skip" : "FAIL"} ${index}. ${title}${record.diagnostic ? ` [${record.diagnostic.code}]` : ""}`);
    return record;
  };
  const responses = async (directory: string) => { const path = join(directory, "responses"); await mkdir(path, { recursive: true, mode: 0o700 }); return path; };
  const dependency = (what: string) => new LiveCheckError("DEPENDENCY_UNAVAILABLE", `Skipped: ${what} is unavailable after an earlier step failed.`);

  log(`Tickr Autopilot ${mode === "dry" ? "DRY-RUN (fake clients, no network)" : "LIVE"} capability check → ${displayPath(runDirectory)}`);
  if (mode === "live") log("  Up to 6 paid Meta requests (3 Muse Spark, 3 SAM 3.1). None is retried.");

  // (1) Spark media analysis on both synthetic images.
  let analysis: MediaAnalysisResult | null = null;
  await step(1, "spark-media-analysis", "Muse Spark media analysis (2 synthetic images)", getMediaAnalysisDiagnostic as (error: unknown) => AdapterDiagnostic, { model: sparkModel, endpoint: ENDPOINT, billing: "spark" }, async (directory) => {
    analysis = await analyzeMediaAssets({
      assets: [CUP, JAR].map((image) => ({ assetId: image.assetId, bytes: images.get(image.assetId)!, mimeType: "image/png" as const, provenance: "owner_upload" as const })),
      goal: GOAL, business: BUSINESS, offerings: OFFERINGS, detectRisks: true,
    }, { responseDirectory: await responses(directory), client: dry?.spark, environment: sparkEnvironment });
    return {
      model: analysis.model, endpoint: ENDPOINT, elapsedMs: analysis.elapsedMs, responseId: analysis.responseId, usage: sparkUsageRecord(analysis.usage),
      billable: [{ kind: "spark_tokens", model: analysis.model, inputTokens: analysis.usage.inputTokens, outputTokens: analysis.usage.outputTokens, basis: "reported" }],
      facts: { assets: analysis.assets.map((asset) => ({ assetId: asset.assetId, subjectKind: asset.subjectKind, subjectLabel: asset.primarySubject?.label ?? null, located: Boolean(asset.primarySubject?.box), goalFit: asset.goalFit, riskKinds: [...new Set(asset.risks.map((risk) => risk.kind))], dropped: asset.dropped })) },
    };
  });
  const analyzed = (assetId: string) => (analysis as MediaAnalysisResult | null)?.assets.find((asset) => asset.assetId === assetId) ?? null;

  // (2) SAM geometry (box) segmentation on the cup, using Spark's located box.
  let geometry: MetaSegmentationResult | null = null;
  await step(2, "sam-image-geometry", "SAM 3.1 box segmentation (synthetic cup)", getMetaSegmentationDiagnostic as (error: unknown) => AdapterDiagnostic, { model: SAM_MODEL, endpoint: ENDPOINT, billing: "sam_image" }, async (directory) => {
    const located = analyzed(CUP.assetId)?.primarySubject;
    const box = located?.box ?? CUP.drawnBox;
    const origin = located?.box ? "spark_grounding" as const : "local_layout" as const;
    geometry = await segmentMetaImage({
      bytes: images.get(CUP.assetId)!, mimeType: "image/png", geometry: [{ objectId: 0, label: located?.label ?? CUP.fallbackConcept, origin, prompts: [{ frame: 0, box }] }],
      sourceAssetId: CUP.assetId, sourceProvenance: "owner_photo",
    }, { responseDirectory: await responses(directory), client: dry?.sam, model: SAM_MODEL });
    return samImageWork(geometry, { boxSource: origin === "spark_grounding" ? "spark_media_analysis" : "drawn_layout_fallback", box });
  });

  // (3) SAM concept segmentation on the jar, using Spark's subject label.
  let concept: MetaSegmentationResult | null = null;
  await step(3, "sam-image-concept", "SAM 3.1 concept segmentation (synthetic jar)", getMetaSegmentationDiagnostic as (error: unknown) => AdapterDiagnostic, { model: SAM_MODEL, endpoint: ENDPOINT, billing: "sam_image" }, async (directory) => {
    const label = analyzed(JAR.assetId)?.primarySubject?.label ?? null;
    concept = await segmentMetaImage({ bytes: images.get(JAR.assetId)!, mimeType: "image/png", prompt: label ?? JAR.fallbackConcept, sourceAssetId: JAR.assetId, sourceProvenance: "owner_photo" },
      { responseDirectory: await responses(directory), client: dry?.sam, model: SAM_MODEL });
    return samImageWork(concept, { conceptSource: label ? "spark_media_analysis" : "fixed_fallback", concept: label ?? JAR.fallbackConcept });
  });

  // (4) Normalize the synthetic clip, then a Spark shot log of it.
  let clip: NormalizedClip | null = null;
  let shotLog: ShotLog | null = null;
  await step(4, "clip-shotlog", "Clip normalization + Muse Spark shot log", getShotLogDiagnostic as (error: unknown) => AdapterDiagnostic, { model: sparkModel, endpoint: ENDPOINT, billing: "spark" }, async (directory) => {
    if (!clipSourceReady) throw new LiveCheckError("SYNTHETIC_CLIP_FAILED", "FFmpeg could not generate the synthetic clip locally.");
    const normalized = await normalizeOwnerClip({
      sourcePath: clipSource, outputDir: join(directory, "clip"), provenance: "owner_upload", maxSeconds: CLIP_SECONDS, id: "synthetic-red-disk",
      // The probe generated this clip itself; the attestation records that, not a business owner's consent.
      consent: { ownsOrLicensedMedia: true, peopleVisibleHaveConsented: "no_people", attestedAt: started.toISOString() },
    });
    clip = normalized;
    scenario.clip = normalized;
    shotLog = await analyzeClipShots({ clip: normalized, goal: GOAL, business: BUSINESS, offerings: OFFERINGS }, { responseDirectory: await responses(directory), client: dry?.spark, environment: sparkEnvironment });
    return {
      model: shotLog.model, endpoint: ENDPOINT, elapsedMs: shotLog.elapsedMs, responseId: shotLog.responseId, usage: sparkUsageRecord(shotLog.usage),
      billable: [{ kind: "spark_tokens", model: shotLog.model, inputTokens: shotLog.usage.inputTokens, outputTokens: shotLog.usage.outputTokens, basis: "reported" }],
      facts: {
        clip: { sha256: normalized.sha256, width: normalized.width, height: normalized.height, fps: normalized.fps, frameCount: normalized.frameCount, durationSeconds: normalized.durationSeconds },
        moments: shotLog.moments.length, droppedMoments: shotLog.droppedMoments, heroMomentFrame: shotLog.heroMomentFrame, subjectLabels: [...new Set(shotLog.moments.flatMap((moment) => moment.subjectLabel ? [moment.subjectLabel] : []))].slice(0, 6),
        peopleVisible: shotLog.peopleVisible, speechPresent: shotLog.speech.present,
      },
    };
  });

  // (5) SAM video tracking with the shot-log label (fallback: "red disk").
  let tracked: SamVideoResult | null = null;
  let trackedObjectId: string | null = null;
  await step(5, "sam-video-tracking", "SAM 3.1 video tracking (synthetic clip)", getSamVideoDiagnostic as (error: unknown) => AdapterDiagnostic, { model: SAM_MODEL, endpoint: ENDPOINT, billing: "sam_video", clipFrames: () => (clip as NormalizedClip | null)?.frameCount ?? null }, async (directory) => {
    const source = clip as NormalizedClip | null;
    if (!source) throw dependency("the normalized clip");
    const shots = shotLog as ShotLog | null;
    const heroFrame = shots?.heroMomentFrame ?? null;
    const hero = shots?.moments.find((moment) => moment.subjectLabel && heroFrame !== null && moment.startFrame <= heroFrame && heroFrame <= moment.endFrame) ?? shots?.moments.find((moment) => moment.subjectLabel);
    const phrase = hero?.subjectLabel ?? "red disk";
    const result = await trackMetaVideo({ clip: source, prompt: { kind: "concept", phrase, label: phrase }, propagation: "both" },
      { responseDirectory: await responses(directory), outputDirectory: join(directory, "masklets"), client: dry?.sam, model: SAM_MODEL });
    tracked = result;
    const best = [...result.set.objects].sort((a, b) => b.framesPresent - a.framesPresent || a.objectId.localeCompare(b.objectId))[0];
    trackedObjectId = best?.objectId ?? null;
    const framesBilled = framesBilledFrom(result.usage);
    return {
      model: SAM_MODEL, endpoint: ENDPOINT, elapsedMs: result.set.elapsedMs, responseId: result.set.responseId, usage: Object.keys(result.usage).length ? result.usage : null,
      billable: [{ kind: "sam_video_frames", model: SAM_MODEL, frames: framesBilled ?? source.frameCount, basis: framesBilled === null ? "counted_clip_frames" : "reported" }],
      facts: {
        concept: phrase, conceptSource: hero ? "spark_shot_log" : "fixed_fallback", source: result.source, objects: result.set.objects.length, framesBilled,
        trackedObject: best ? { objectId: best.objectId, framesPresent: best.framesPresent, firstFrame: best.firstFrame, lastFrame: best.lastFrame, meanCoverage: round6(best.meanCoverage), meanConfidence: best.meanConfidence === null ? null : round6(best.meanConfidence) } : null,
        clipFrames: source.frameCount,
      },
      failure: best ? undefined : { phase: "decode", code: "NO_TRACKED_OBJECT", detail: "SAM returned no tracked object for the synthetic clip.", httpStatus: null, completedResponseStored: true },
    };
  });

  // (6) Local renders: still-depth Reel, tracked Reel (still-depth CTA end card) and the SAM overlay.
  interface RenderedReel { path: string; filename: string; durationSeconds: number; width: number; height: number }
  let stillDepthCover: { path: string; width: number; height: number } | null = null;
  let stillDepthReel: RenderedReel | null = null;
  let trackedReel: RenderedReel | null = null;
  await step(6, "reel-render", "Still-depth Reel + tracked Reel + SAM overlay (local)", undefined, { model: null, endpoint: null, billing: null }, async (directory) => {
    const facts: Record<string, unknown> = {};
    let failure: LiveCheckDiagnostic | undefined;
    const fail = (error: unknown) => { failure ??= diagnoseLiveCheckError(error).diagnostic; };
    // Still-depth: prefer the box-prompted cup; fall back to the concept-segmented jar.
    const picks = [{ result: geometry as MetaSegmentationResult | null, image: CUP }, { result: concept as MetaSegmentationResult | null, image: JAR }];
    const pick = picks.find((candidate) => candidate.result?.objects.length);
    let endCard: { source: Buffer; subjectMask: Buffer; provenanceLabel: string } | undefined;
    if (!pick) { fail(dependency("a SAM image mask")); facts.stillDepth = { status: "skipped" }; }
    else {
      try {
        const source = images.get(pick.image.assetId)!;
        const object = [...pick.result!.objects].sort((a, b) => b.foregroundPixels - a.foregroundPixels)[0];
        const layer = await composeObjectLayer(source, pick.result!, object.id, { minConfidence: 0 });
        if (!layer) throw new LiveCheckError("NO_USABLE_MASK", "The SAM image mask was not usable for a still-depth Reel.");
        // The end card is the synthetic probe still, not owner media: it carries its own label.
        endCard = { source, subjectMask: layer.maskPng, provenanceLabel: STILL_PROBE_PROVENANCE };
        const input: StillDepthInput = {
          ...RENDER_COPY, source, subjectMask: layer.maskPng, provenanceLabel: STILL_PROBE_PROVENANCE,
          outputPath: join(directory, "synthetic-still-depth-reel.mp4"), coverPath: join(directory, "synthetic-still-depth-cover.png"),
        };
        const result = await renderStillDepthReel(input);
        stillDepthCover = { path: input.coverPath, width: result.cover.width, height: result.cover.height };
        stillDepthReel = { path: input.outputPath, filename: "synthetic-still-depth-reel.mp4", durationSeconds: result.reel.durationSeconds, width: result.reel.width, height: result.reel.height };
        facts.stillDepth = {
          status: "rendered", sourceAssetId: pick.image.assetId, maskObjectId: object.id, reel: result.reel, cover: result.cover, violations: result.qa.violations,
          provenanceLabel: result.layout.provenanceLabel, conceptLabel: result.layout.conceptLabel, generatedPixelsOnSubject: result.ledger.generatedPixelsOnSubject,
          framesWithoutSubject: result.ledger.framesWithoutSubject, maxSubjectOcclusion: round6(result.ledger.maxSubjectOcclusion),
        };
      } catch (error) { fail(error); facts.stillDepth = { status: "failed" }; }
    }
    const set = tracked as SamVideoResult | null, source = clip as NormalizedClip | null, heroObjectId = trackedObjectId as string | null;
    if (!set || !source || !heroObjectId) {
      fail(dependency("the SAM video masklets"));
      facts.trackedReel = { status: "skipped" }; facts.overlay = { status: "skipped" };
    } else {
      try {
        const outputPath = join(directory, "synthetic-tracked-reel.mp4");
        const result: TrackedReelResult = await renderTrackedReel({
          ...RENDER_COPY, clip: source, reader: set.reader, heroObjectId, provenanceLabel: "Synthetic probe clip + still · SAM selections",
          outputPath, coverPath: join(directory, "synthetic-tracked-cover.png"), ...(endCard ? { endCard } : {}),
        });
        trackedReel = { path: outputPath, filename: "synthetic-tracked-reel.mp4", durationSeconds: result.reel.durationSeconds, width: result.reel.width, height: result.reel.height };
        facts.trackedReel = {
          status: "rendered", reel: result.reel, cover: result.cover, violations: result.qa.violations, footageFrames: result.timeline.footageFrames, endCard: result.timeline.endCard.kind,
          footageFramesWithoutMask: result.qa.footageFramesWithoutMask, provenanceLabel: result.layout.provenanceLabel, conceptLabel: result.layout.conceptLabel,
          endCardProvenanceLabel: result.endCard.provenanceLabel,
          generatedPixelsOnSubject: result.ledger.generatedPixelsOnSubject, framesWithoutSubject: result.ledger.framesWithoutSubject, maxSubjectOcclusion: round6(result.ledger.maxSubjectOcclusion),
        };
      } catch (error) { fail(error); facts.trackedReel = { status: "failed" }; }
      try {
        const result: SamOverlayResult = await renderSamOverlayVideo({ clip: source, reader: set.reader, outputPath: join(directory, "synthetic-sam-overlay.mp4"), objectLabels: {} });
        facts.overlay = { status: "rendered", video: result.video, label: result.label, objects: result.objects.map(({ objectId, framesWithMask }) => ({ objectId, framesWithMask })) };
      } catch (error) { fail(error); facts.overlay = { status: "failed" }; }
    }
    return { model: null, endpoint: null, facts, failure };
  });

  // (7) Spark critic on one rendered still + the Reel.
  await step(7, "spark-critic", "Muse Spark critic (rendered still + Reel)", getCriticDiagnostic as (error: unknown) => AdapterDiagnostic, { model: criticModel, endpoint: ENDPOINT, billing: "spark" }, async (directory) => {
    const cover = stillDepthCover as { path: string; width: number; height: number } | null;
    if (!cover) throw dependency("a rendered still");
    const png = await readFile(cover.path);
    // The tracked Reel is the primary Autopilot output; the still-depth Reel stands in when tracking failed.
    const reelSource = (trackedReel as RenderedReel | null) ?? (stillDepthReel as RenderedReel | null);
    if (!reelSource) throw dependency("a rendered Reel");
    const mp4 = await readFile(reelSource.path);
    const report: CritiqueReport = await critiqueCampaign({
      assets: [{ assetId: "cover", filename: "synthetic-still-depth-cover.png", channel: REEL_CHANNEL, png, width: cover.width, height: cover.height, sha256: sha256(png) }],
      reel: { filename: reelSource.filename, sha256: sha256(mp4), mp4, durationSeconds: reelSource.durationSeconds, channel: REEL_CHANNEL, width: reelSource.width, height: reelSource.height },
      campaign: {
        name: "Synthetic live check", objective: GOAL, coreMessage: "A calm weekday coffee stop.", primaryCta: CTA, offerStatus: "none", supportedClaims: [],
        channels: [{ id: REEL_CHANNEL, headline: SCENES[0].headline, body: SCENES[0].body, caption: "Slow mornings, warm cups. Drop by for a cup.", cta: CTA }],
      },
      context: { businessName: BUSINESS.name, category: BUSINESS.category, goal: GOAL },
    }, { responseDirectory: await responses(directory), client: dry?.spark, model: criticModel, environment: sparkEnvironment });
    const severities = Object.fromEntries(["critical", "major", "minor"].map((severity) => [severity, report.findings.filter((finding) => finding.severity === severity).length]));
    return {
      model: report.responseModel ?? report.model, endpoint: ENDPOINT, elapsedMs: report.elapsedMs, responseId: report.responseId, usage: sparkUsageRecord(report.usage),
      billable: [{ kind: "spark_tokens", model: report.model, inputTokens: report.usage.inputTokens, outputTokens: report.usage.outputTokens, basis: "reported" }],
      facts: {
        verdict: report.verdict, findings: severities, rules: [...new Set(report.findings.map((finding) => finding.rule))], discardedFindings: report.discardedFindings.length,
        reelAsset: reelSource.filename, reelFindings: report.findings.filter((finding) => finding.assetId === CRITIC_REEL_ASSET_ID).length, diagnosticOnly: true,
      },
    };
  });

  const finished = now();
  const report: LiveCheckReport = {
    version: LIVE_CHECK_VERSION, mode, startedAt: started.toISOString(), finishedAt: finished.toISOString(), run: runName, syntheticMedia, steps,
    succeeded: steps.every((entry) => entry.status === "succeeded"), estimate: estimateLiveCheckCost(steps, mode),
    notes: [
      "All media is synthetic and generated locally by this probe; no third-party or business media was fetched or used.",
      "Synthetic media is passed with the owner_upload/owner_photo provenance classes only because the adapters require an owner class; nothing here is business media.",
      "Model outputs are observations and selections: no product identity, rights or campaign performance is verified.",
      ...(mode === "dry" ? ["DRY RUN: every Meta response came from an injected fake client. This verifies local wiring only, not live inference."] : ["A successful live step proves that one request of this shape completed; it is not a quality or reliability guarantee."]),
    ],
  };
  const reportPath = join(runDirectory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  log("");
  log(formatLiveCheckTable(report));
  log(`\nReport: ${displayPath(reportPath)}`);
  return { exitCode: report.succeeded ? 0 : 1, report, runDirectory, reportPath };
}

function samImageWork(result: MetaSegmentationResult, facts: Record<string, unknown>): StepWork {
  const imagesProcessed = result.usage.imagesProcessed;
  return {
    model: result.model, endpoint: ENDPOINT, elapsedMs: result.elapsedMs, responseId: result.responseId, usage: samImageUsageRecord(result.usage),
    billable: [{ kind: "sam_images", model: result.model, images: imagesProcessed ?? 1, basis: imagesProcessed === null ? "counted_requests" : "reported" }],
    facts: {
      ...facts, status: result.status, promptKind: result.promptKind ?? null, unmatchedPromptIds: result.unmatchedPromptIds ?? [],
      objects: result.objects.map((object) => ({ id: object.id, confidence: object.confidence, coverage: round6(object.coverageFraction), bounds: object.bounds })).slice(0, 16),
    },
    failure: result.objects.length ? undefined : { phase: "decode", code: "NO_MATCH", detail: "SAM returned no selection for the synthetic image.", httpStatus: null, completedResponseStored: true },
  };
}

/** Adapter usage on failures is camelCase for images/Spark; the report keeps wire-style names. */
function camelToWire(usage: Record<string, number>): Record<string, number> {
  const names: Record<string, string> = { inputTokens: "input_tokens", outputTokens: "output_tokens", totalTokens: "total_tokens", imagesProcessed: "images_processed" };
  return Object.fromEntries(Object.entries(usage).map(([name, value]) => [names[name] ?? name, value]));
}

/** What a step bills, so a failed step can still be counted with the success path's fallbacks. */
export interface StepMeta {
  model: string | null;
  endpoint: string | null;
  billing: "spark" | "sam_image" | "sam_video" | null;
  /** SAM video only: the normalized clip's frame count, the fallback when billed frames are not reported. */
  clipFrames?: () => number | null;
}

/** True when the adapter recorded that a paid response arrived (decode or post-response storage failures). */
function responseReceived(recorded: AdapterDiagnostic): boolean {
  if (recorded.completedResponseStored) return true;
  // Decode only ever follows a received response. ("output" is not used: the SAM video adapter also
  // relabels a pre-request masklet-store error as "output", and that one carries no response.)
  if (recorded.phase === "decode") return true;
  // A storage failure before the call (the requested marker) carries no record; one after it does.
  return recorded.phase === "storage" && (recorded.responseId !== null || recorded.elapsedMs > 0 || recorded.usage !== null);
}

/**
 * Billable units for a failed step whose paid response arrived, using the same fallbacks as the
 * success path. `unrecorded` marks a received paid response that yielded no billable line.
 */
export function billableFromFailure(meta: Pick<StepMeta, "model" | "billing" | "clipFrames">, usage: Record<string, number> | null, recorded: AdapterDiagnostic | null): { billable: LiveCheckBillable[]; unrecorded: boolean } {
  if (!meta.model || !meta.billing || !recorded || !responseReceived(recorded)) return { billable: [], unrecorded: false };
  const model = meta.model;
  const wire = usage ? camelToWire(usage) : {};
  const count = (name: string) => typeof wire[name] === "number" && Number.isSafeInteger(wire[name]) && wire[name] >= 0 ? wire[name] : null;
  if (meta.billing === "spark") {
    // Always a line: missing token counts leave it unpriced, which marks the estimate incomplete.
    return { billable: [{ kind: "spark_tokens", model, inputTokens: count("input_tokens"), outputTokens: count("output_tokens"), basis: "reported" }], unrecorded: false };
  }
  if (meta.billing === "sam_image") {
    const images = count("images_processed");
    return { billable: [{ kind: "sam_images", model, images: images ?? 1, basis: images === null ? "counted_requests" : "reported" }], unrecorded: false };
  }
  const reported = framesBilledFrom(wire);
  const frames = reported ?? meta.clipFrames?.() ?? null;
  if (frames === null) return { billable: [], unrecorded: true };
  return { billable: [{ kind: "sam_video_frames", model, frames, basis: reported === null ? "counted_clip_frames" : "reported" }], unrecorded: false };
}

// ------------------------------------------------------------------------------------------
// Console table
// ------------------------------------------------------------------------------------------

function usageSummary(step: LiveCheckStep): string {
  const usage = step.usage;
  if (!usage) return step.endpoint ? "not reported" : "local";
  const parts: string[] = [];
  if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) parts.push(`${usage.input_tokens ?? "?"} in / ${usage.output_tokens ?? "?"} out tok`);
  if (usage.images_processed !== undefined) parts.push(`${usage.images_processed} img`);
  const frames = framesBilledFrom(usage);
  if (frames !== null) parts.push(`${frames} frames`);
  return parts.join(", ") || Object.entries(usage).slice(0, 3).map(([name, value]) => `${name}=${value}`).join(", ");
}

const pad = (value: string, width: number) => value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);

export function formatLiveCheckTable(report: LiveCheckReport): string {
  const rows = report.steps.map((step) => [
    String(step.index), step.id, step.status === "succeeded" ? "ok" : step.status === "skipped" ? "skipped" : "FAILED", step.model ?? "local",
    step.elapsedMs === null ? "-" : `${(step.elapsedMs / 1000).toFixed(1)}s`, `${(step.wallMs / 1000).toFixed(1)}s`, step.responseId ?? "-", usageSummary(step), step.diagnostic?.code ?? "",
  ]);
  const header = ["#", "step", "status", "model", "request", "wall", "response id", "usage", "diagnostic"];
  const widths = [2, 20, 7, 15, 7, 6, 24, 26, 28];
  const lines = [header, ...rows].map((row) => row.map((cell, index) => pad(cell, widths[index])).join("  ").trimEnd());
  lines.splice(1, 0, widths.map((width) => "-".repeat(width)).join("  "));
  const estimate = report.estimate;
  lines.push("", `${report.mode === "dry" ? "[DRY RUN] " : ""}${estimate.label}`);
  lines.push(`  Prices dated ${estimate.pricesDated}: ~${estimate.currency} ${estimate.totalUsd.toFixed(4)}${estimate.incomplete ? " (incomplete; see notes)" : ""}`);
  for (const line of estimate.lines) lines.push(`  ${pad(line.step, 20)} ${pad(line.quantity, 34)} ${line.usd === null ? "no price" : `$${line.usd.toFixed(6)}`}${line.note ? `  (${line.note})` : ""}`);
  for (const note of estimate.notes) lines.push(`  note: ${note}`);
  lines.push("", report.succeeded ? "All steps succeeded." : `Failed or skipped: ${report.steps.filter((step) => step.status !== "succeeded").map((step) => step.id).join(", ")}.`);
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------------------------------

const USAGE = "Usage: npm run autopilot:check [-- --dry] [-- --out <directory>]\n  --dry   run the whole flow offline with fake Meta clients (no network, no key)\n  --out   parent directory for run folders (default .data/autopilot-live-check)";

export function parseLiveCheckArguments(argv: readonly string[]): { dry: boolean; rootDirectory?: string; help: boolean } {
  let dry = false, help = false, rootDirectory: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--dry") dry = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--out" && argv[index + 1] && !argv[index + 1].startsWith("--")) rootDirectory = argv[++index];
    else throw new LiveCheckError("INVALID_ARGUMENTS", `Unknown or incomplete argument.\n${USAGE}`);
  }
  return { dry, rootDirectory, help };
}

async function main() {
  let parsed: ReturnType<typeof parseLiveCheckArguments>;
  try { parsed = parseLiveCheckArguments(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof LiveCheckError ? error.message : USAGE); process.exitCode = 2; return; }
  if (parsed.help) { console.log(USAGE); return; }
  const outcome = await runAutopilotLiveCheck({ dry: parsed.dry, rootDirectory: parsed.rootDirectory });
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // Never print raw errors: they can contain local paths. This script's own errors are fixed text.
    console.error(error instanceof LiveCheckError ? error.message : "Autopilot live check stopped before completion. No paid request is ever retried automatically.");
    process.exitCode = 1;
  });
}
