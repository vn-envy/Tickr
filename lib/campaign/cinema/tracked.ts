import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { ClipFrame, CompositionLedger, FrameMask, MaskletReader, MaskletSet, NormalizedClip, TrackPoint } from "../../media/cinema-types";
import { readClipFrames, readRenderClipFrames, renderClipMatches, type OwnerRenderClip } from "../../media/clip";
import { REEL_DURATION_SECONDS, REEL_FPS, REEL_HEIGHT, REEL_WIDTH } from "../../rendering/reel-contract";
import { CinemaEncodeError, openH264Encoder } from "./encode";
import { gaussianBlurZero } from "./fill";
import { CompositionLedgerAccumulator, LedgerCanvas } from "./ledger";
import { refineMaskField } from "./mask-refine";
import { HEADLINE_VISIBLE_OPACITY, MAX_FOREGROUND_OCCLUSION, MAX_HEADLINE_LINE_OCCLUSION, MAX_HEADLINE_OCCLUSION, prepareStillDepth, STILL_DEPTH_LABEL_BANDS, type StillDepthComposer, type StillDepthLayoutReport, type StillDepthScene, type StillDepthTheme } from "./still-depth";
import { cleanText, pill, svgDocument, textBlock, type Bounds, type FontFace, type TextBlock } from "./typography";

/**
 * Cinematic 12 s Reel driven by REAL owner footage and the hero object's SAM 3.1 masklets.
 *
 * Pixel provenance is structural. Every footage frame is the decoded clip frame reframed to 9:16
 * (one bilinear resample). Crops and masks live in tracking-clip pixels; output pixels come from the
 * optional render-resolution clip of the same frames when one is supplied (the tracking clip is
 * capped at 1280 px for SAM), and the source-to-output enlargement is reported in QA. The background is that same frame blurred, desaturated and darkened;
 * the hero subject is the untreated reframed frame selected by its upsampled SAM mask. The mask is
 * refined for compositing only (specks dropped, pin-holes filled, stair-stepped edges smoothed with a
 * trackedMaskSigma Gaussian; see mask-refine.ts) and its alpha is feathered only across the
 * outermost 1–2 output pixels; inside the mask the output RGB equals the reframed source RGB. Frames whose mask is missing (tracking lost) show the treated
 * frame without a pop-out and are counted in the ledger. Nothing is interpolated or invented:
 * when the footage window is shorter than 12 s, the remaining time is a CTA end card — the
 * still-depth CTA scene from an owner photo when one is supplied, else a freeze of the best
 * tracked frame (real pixels, subject popped). Frames are streamed; the clip is never held whole.
 *
 * Output contract matches the existing Reel: 1080×1920, 30 fps, H.264, 360 frames, 12.0 s, no
 * audio, plus a 1080×1920 PNG cover. Nothing here calls a network service.
 */

const W = REEL_WIDTH, H = REEL_HEIGHT, FPS = REEL_FPS;
export const TRACKED_REEL_FRAMES = REEL_DURATION_SECONDS * REEL_FPS;
export const TRACKED_COVER_FRAME = 60;
/** Shortest footage window that can carry the hook, proof and value acts (matches the clip normalizer's half second). */
export const MIN_TRACKED_FOOTAGE_FRAMES = 15;
/** The CTA act starts here (or earlier, when the footage ends sooner). */
export const TRACKED_CTA_START = TRACKED_REEL_FRAMES - 3 * FPS;
/** Rows occupied by the concept (top) and provenance (bottom) chips in every frame. */
export const TRACKED_LABEL_BANDS = STILL_DEPTH_LABEL_BANDS;
/** Output pixels across which the subject alpha ramps from 0 to 1 at the mask edge. */
export const SUBJECT_FEATHER_PX = 1.5;
/**
 * Edge smoothing of each SAM frame mask, in mask pixels, for a mask enlarged `scale`× into the
 * output. A mask pixel spans several output pixels, so a hard binary edge shows as stair steps of
 * about half a mask pixel; the smoothing grows with the enlargement to keep them sub-pixel, within
 * bounds that keep thin parts (≥ ~2 mask px) and corners.
 */
export const TRACKED_MASK_SIGMA = { min: 0.85, max: 2, perScale: 0.25 } as const;
export function trackedMaskSigma(scale: number): number {
  return Math.min(TRACKED_MASK_SIGMA.max, Math.max(TRACKED_MASK_SIGMA.min, TRACKED_MASK_SIGMA.perScale * scale));
}
/** The tracked callout stays inside these output-pixel margins. */
export const CALLOUT_SAFE = { left: 48, right: W - 48, top: TRACKED_LABEL_BANDS.top.bottom + 40, bottom: TRACKED_LABEL_BANDS.bottom.top - 40 } as const;
const LEDGER_FACTOR = 4;
const LW = W / LEDGER_FACTOR, LH = H / LEDGER_FACTOR;
const SIDE = 64;
const WASH_FRAMES = 7;
/** Shorter end cards cut directly (an accent wash would hide most of them). */
const MIN_WASHED_END_CARD = 45;
/** Still-depth's own CTA scene starts here, with its own accent wash fading out. */
const STILL_DEPTH_CTA_FRAME = 270;
const STILL_DEPTH_LAST_FRAME = 359;
/** The subject is kept at this share of the crop height from the top (headroom for depth type). */
const SUBJECT_VERTICAL_ANCHOR = 0.54;
/** Crop zoom never tightens beyond the smoothed subject box × this margin. */
const SUBJECT_FIT_MARGIN = 1.3;
const BACKGROUND_SIGMA = 3.2;
const CALLOUT_HEIGHT = 68, CALLOUT_POINTER = 16, CALLOUT_GAP = 22;
/** Depth headlines: mean share of their glyphs covered by the real subject above this is a review flag. */
export const MAX_TRACKED_HEADLINE_OCCLUSION = 0.5;
/**
 * Rendered depth-headline occlusion may exceed the planned per-frame caps (MAX_HEADLINE_OCCLUSION,
 * MAX_HEADLINE_LINE_OCCLUSION) by at most this much (feathered mask edges, ledger-cell rounding)
 * before the Reel is flagged headline_hidden.
 */
export const HEADLINE_MEASURE_TOLERANCE = 0.05;
/** Contrast floor for kickers, body copy and labels over footage (WCAG AA normal text), even over white. */
export const MIN_TEXT_CONTRAST = 4.5;
/** Contrast floor for the large serif display headlines over footage (WCAG AA large text), even over white. */
export const MIN_DISPLAY_CONTRAST = 3;
/** Depth-headline sizes tried for the hook (largest first). */
const HOOK_HEADLINE_SIZES = [150, 128, 110, 92] as const;
const VALUE_HEADLINE_SIZES = [124, 108, 92, 84] as const;
/** Footage enlarged by more than this (source pixels to output pixels) looks soft; see low_resolution_footage. */
export const MAX_FOOTAGE_UPSCALE = 1.5;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TrackedAct = "hook" | "proof" | "value" | "cta";
/** A 9:16 crop window in tracking-clip pixels (fractional). */
export interface TrackedCrop { x: number; y: number; width: number; height: number }
export interface TrackedBox { left: number; top: number; right: number; bottom: number }

export interface TrackedFramePlan {
  index: number;
  kind: "footage" | "freeze" | "still_depth";
  act: TrackedAct;
  /** Seconds since the act started. */
  actTime: number;
  /** Clip frame drawn (footage and freeze frames), else null. */
  sourceFrame: number | null;
  crop: TrackedCrop | null;
  /** The masklet summary has a hero track point for this source frame. */
  tracked: boolean;
  /** Smoothed hero centroid and box in clip pixels (zero-phase EMA: forward pass plus a look-ahead backward pass). */
  centroid: { x: number; y: number } | null;
  box: TrackedBox | null;
  /** Accent transition wash drawn over the frame (0–1). */
  wash: number;
  /** Still-depth frame index for still-depth end-card frames. */
  endCardFrame: number | null;
}

export interface TrackedReelPlan {
  window: { fromFrame: number; toFrame: number };
  /** Output frames driven by real footage (frames 0 … footageFrames − 1). */
  footageFrames: number;
  /** Half-open output frame ranges per act. */
  acts: Record<TrackedAct, [number, number]>;
  endCard: { start: number; frames: number; kind: "still_depth" | "freeze" | "none" };
  /** Clip frame frozen for a freeze end card (best tracked frame in the used footage). */
  bestFrame: number;
  frames: TrackedFramePlan[];
}

export interface TrackedReelInput {
  /** Tracking clip: the masklets, crops and plan are in its pixels. */
  clip: NormalizedClip;
  /**
   * Optional render-resolution copy of the same clip frames (normalizeOwnerRenderClip). When given,
   * output pixels are drawn from it instead of the 1280-px tracking clip; it must match `clip`.
   */
  renderClip?: OwnerRenderClip;
  reader: MaskletReader;
  heroObjectId: string;
  /** Inclusive clip frame range; defaults to the whole clip. At most 12 s of it is used. */
  window?: { fromFrame: number; toFrame: number };
  /** Hook, proof, value, CTA. */
  scenes: readonly StillDepthScene[];
  cta: string;
  businessName: string;
  campaignName: string;
  mode: "live" | "synthetic";
  provenanceLabel: string;
  theme: StillDepthTheme;
  outputPath: string;
  coverPath: string;
  /**
   * Owner photo (PNG) and its subject mask (PNG) for a still-depth CTA end card. The end card is a
   * different source asset than the footage, so it carries its own provenance chip: the caller must
   * name the still's own source (e.g. "Owner photo · SAM cutout"), never the footage label. There is
   * no default: an unlabelled end card is rejected rather than shown with a guessed provenance.
   */
  endCard?: { source: Uint8Array; subjectMask: Uint8Array; provenanceLabel: string };
  /** Callout text attached to the tracked subject; defaults to the hero object's local label. Not a verified identity. */
  callout?: string;
}

/**
 * Review flags a caller must surface or act on — never silently drop:
 * - foreground_occlusion: some frame hides more than MAX_FOREGROUND_OCCLUSION of the subject.
 * - subject_missing: more than 10% of frames show no subject outside deliberate transition washes.
 * - tracking_lost: some footage frames had no hero mask (shown treated, without pop-out).
 * - subject_cropped: more than 10% of frames crop the subject at the frame edge by over 5%.
 * - headline_hidden: in some rendered frame the real subject covers more of a depth headline (or one of
 *   its lines) than the per-frame caps allow, or most of it on average.
 * - end_card_fallback: the supplied still-depth end card could not be used; a freeze was rendered.
 * - low_resolution_footage: more than 10% of footage frames enlarge their source pixels by over MAX_FOOTAGE_UPSCALE.
 */
export type TrackedReelViolation = "foreground_occlusion" | "subject_missing" | "tracking_lost" | "subject_cropped" | "headline_hidden" | "end_card_fallback" | "low_resolution_footage";

/** How much the drawn footage pixels are enlarged into the 1080×1920 output (1 = 1:1). */
export interface TrackedFootageUpscale {
  /** Which file supplied the footage pixels. */
  source: "render_clip" | "tracking_clip";
  sourceWidth: number;
  sourceHeight: number;
  max: number;
  mean: number;
  /** Footage and freeze frames enlarged by more than MAX_FOOTAGE_UPSCALE. */
  framesOverLimit: number;
}

/**
 * Where a depth headline was placed against the subject's motion. Behind the subject, every frame of
 * the act where the headline is visible (opacity ≥ HEADLINE_VISIBLE_OPACITY, at its rise offset) keeps
 * the covered share ≤ MAX_HEADLINE_OCCLUSION overall and ≤ MAX_HEADLINE_LINE_OCCLUSION per line.
 */
export interface TrackedHeadlinePlacement {
  /** Behind the subject (depth typography) or, when no band keeps it readable in every frame, in front (on a backing that stays beneath the subject). */
  placement: "behind_subject" | "in_front";
  /** Planned mean share of the glyph area the tracked subject covers over the visible frames (0 in front). */
  occlusion: number;
  /** Worst single line's planned mean share (0 in front). */
  lineOcclusion: number;
  /** Planned worst single-frame share of the whole headline (0 in front). */
  maxFrameOcclusion: number;
  /** Planned worst single-frame share of any one line (0 in front). */
  maxFrameLineOcclusion: number;
  /** Act frames the placement was checked on (subject mask present, headline visible). */
  framesChecked: number;
  /** Planned mean share of the subject hidden by the headline glyphs (0 behind; its backing sits beneath the subject). */
  foregroundOcclusion: number;
  fontSize: number;
  top: number;
}

export interface TrackedLayoutReport {
  conceptLabel: string;
  provenanceLabel: string;
  calloutLabel: string;
  calloutSide: "above" | "below";
  truncatedText: string[];
  hookHeadline: TrackedHeadlinePlacement;
  valueHeadline: TrackedHeadlinePlacement;
  /**
   * Every text block over footage sits on a soft dark backing sized so the text keeps its contrast
   * floor even over a pure white backdrop: worst-case contrast ratios and the backing opacities.
   * Backings are composited beneath the hero subject (`backingLayer`), so they never hide it: where
   * front text crosses the subject, its glyphs (with their soft shade) are drawn over the real subject
   * pixels without a backing, and that share is reported per Reel in qa.frontTextOverSubject.
   */
  textContrast: { body: number; kicker: number; display: number; backingOpacity: { body: number; kicker: number; display: number }; backingLayer: "beneath_subject" };
}

/** Where the frames after the footage come from. */
export interface TrackedEndCardReport {
  /** owner_still: the still-depth CTA scene from the supplied owner photo; footage_freeze: a held real footage frame; none: footage fills the Reel. */
  source: "owner_still" | "footage_freeze" | "none";
  /** Provenance chip rendered on the end-card frames (the footage label on a freeze), or null without an end card. */
  provenanceLabel: string | null;
  /** Still-depth layout report of the owner-still end card (only its CTA scene is shown), else null. */
  stillDepthLayout: StillDepthLayoutReport | null;
}

export interface TrackedReelResult {
  reel: { sha256: string; bytes: number; frames: number; durationSeconds: number; width: number; height: number; fps: number };
  cover: { sha256: string; bytes: number; width: number; height: number; frame: number };
  ledger: CompositionLedger;
  timeline: { window: { fromFrame: number; toFrame: number }; footageFrames: number; acts: Record<TrackedAct, [number, number]>; endCard: TrackedReelPlan["endCard"]; bestFrame: number };
  layout: TrackedLayoutReport;
  endCard: TrackedEndCardReport;
  qa: {
    violations: TrackedReelViolation[];
    framesSubjectHiddenByTransition: number;
    /** Footage frames whose hero mask was missing (tracking lost). */
    footageFramesWithoutMask: number;
    /**
     * Share of the depth headlines' (hook and value, behind the subject) glyphs covered by the real
     * subject, per rendered frame where a headline is visible (opacity ≥ HEADLINE_VISIBLE_OPACITY):
     * mean and worst frame for the whole headline, and the worst single line in any frame.
     */
    headlineOcclusion: { mean: number; max: number; lineMax: number };
    /**
     * Share of the in-front text glyphs (body copy, proof stack, in-front headlines, CTA brand/body)
     * drawn over the real subject, where their backing is beneath the subject and only the glyph
     * shade separates them from it (frames where such text is shown).
     */
    frontTextOverSubject: { mean: number; max: number };
    footageUpscale: TrackedFootageUpscale;
    /**
     * Alpha-only compositing refinement of the hero's SAM frame masks (the stored masklets are
     * unchanged): edge smoothing sigma and the speck/pin-hole pixels dropped or filled, summed over drawn frames.
     */
    maskRefinement: { edgeSigma: { min: number; max: number }; framesRefined: number; framesWithSpecksRemoved: number; framesWithHolesFilled: number; removedPixels: number; filledPixels: number };
  };
}

export class TrackedCinemaError extends Error {
  constructor(message: string) { super(message); this.name = "TrackedCinemaError"; }
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const bytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array && value.length > 8 && value.length <= MAX_INPUT_BYTES);
const line = (max: number, min = 0) => z.string().max(max * 4).refine((value) => { const length = Array.from(value.trim()).length; return length >= min && length <= max; });
const frameIndex = z.number().int().nonnegative();
const clipSchema = z.custom<NormalizedClip>((value) => {
  const clip = value as NormalizedClip | null;
  return Boolean(clip) && typeof clip === "object" && typeof clip!.path === "string" && isAbsolute(clip!.path) && /^[a-f0-9]{64}$/.test(String(clip!.sha256))
    && [clip!.width, clip!.height, clip!.frameCount].every((item) => Number.isInteger(item) && item > 0);
});
const readerSchema = z.custom<MaskletReader>((value) => {
  const reader = value as MaskletReader | null;
  return Boolean(reader) && typeof reader === "object" && typeof reader!.frameMask === "function" && Boolean(reader!.set) && typeof reader!.set === "object";
});
const renderClipInputSchema = z.custom<OwnerRenderClip>((value) => Boolean(value) && typeof value === "object");
const inputSchema = z.strictObject({
  clip: clipSchema,
  renderClip: renderClipInputSchema.optional(),
  reader: readerSchema,
  heroObjectId: z.string().regex(/^\d{1,20}$/),
  window: z.strictObject({ fromFrame: frameIndex, toFrame: frameIndex }).optional(),
  scenes: z.array(z.strictObject({ headline: line(140, 1), body: line(320), kicker: line(60) })).length(4),
  cta: line(48, 1),
  businessName: line(100, 1),
  campaignName: line(140, 1),
  mode: z.enum(["live", "synthetic"]),
  provenanceLabel: line(64, 1),
  theme: z.strictObject({ paper: hex, ink: hex, accent: hex, soft: hex }),
  outputPath: z.string().max(4096).refine((value) => isAbsolute(value) && /\.mp4$/i.test(value)),
  coverPath: z.string().max(4096).refine((value) => isAbsolute(value) && /\.png$/i.test(value)),
  endCard: z.strictObject({ source: bytes, subjectMask: bytes, provenanceLabel: line(64, 1) }).optional(),
  callout: line(48, 1).optional(),
});

function parseInput(input: TrackedReelInput): TrackedReelInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new TrackedCinemaError("The tracked Reel input is invalid.");
  const value = parsed.data as TrackedReelInput;
  const { clip, reader } = value;
  const bound = reader.set.clip;
  if (bound.sha256 !== clip.sha256 || bound.width !== clip.width || bound.height !== clip.height || bound.frameCount !== clip.frameCount) {
    throw new TrackedCinemaError("The masklets belong to different clip bytes.");
  }
  // Footage plays at its own speed: one clip frame per Reel frame.
  if (clip.fps !== FPS || bound.fps !== FPS) throw new TrackedCinemaError("The tracked Reel needs a 30 fps normalized clip.");
  // A render source must repeat exactly these frames at a uniformly larger size; never guess a mapping.
  if (value.renderClip && !renderClipMatches(value.renderClip, clip)) throw new TrackedCinemaError("The render-resolution footage does not match the tracking clip.");
  return value;
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const clamp = (value: number, low: number, high: number) => low > high ? (low + high) / 2 : Math.min(high, Math.max(low, value));
const easeInOut = (value: number) => { const v = clamp01(value); return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2 };
const easeOut = (value: number) => 1 - (1 - clamp01(value)) ** 3;
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0 };

/**
 * Zero-phase exponential smoothing: the mean of a forward EMA and a backward (look-ahead) EMA.
 * The symmetric kernel removes mask jitter without the lag of a causal filter.
 */
export function smoothTrack(values: readonly number[], alpha: number): number[] {
  const n = values.length;
  if (!n) return [];
  const forward = new Array<number>(n), backward = new Array<number>(n);
  forward[0] = values[0];
  for (let i = 1; i < n; i++) forward[i] = forward[i - 1] + alpha * (values[i] - forward[i - 1]);
  backward[n - 1] = values[n - 1];
  for (let i = n - 2; i >= 0; i--) backward[i] = backward[i + 1] + alpha * (values[i] - backward[i + 1]);
  return forward.map((value, i) => (value + backward[i]) / 2);
}

/** Linear interpolation across gaps; edges hold the nearest known value. */
function fillGaps(known: readonly (number | null)[]): number[] {
  const n = known.length, out = new Array<number>(n);
  let previous = -1;
  for (let i = 0; i < n; i++) {
    if (known[i] === null) continue;
    if (previous < 0) for (let j = 0; j < i; j++) out[j] = known[i]!;
    else for (let j = previous + 1; j < i; j++) out[j] = known[previous]! + (known[i]! - known[previous]!) * (j - previous) / (i - previous);
    out[i] = known[i]!;
    previous = i;
  }
  for (let j = previous + 1; j < n; j++) out[j] = known[previous]!;
  return out;
}

// ---------------------------------------------------------------------------
// Planning: acts, reframing and the end card (pure; no pixels)
// ---------------------------------------------------------------------------

function baseCrop(width: number, height: number): { width: number; height: number } {
  return width / height >= W / H ? { width: height * W / H, height } : { width, height: width * H / W };
}

function cropAround(cx: number, cy: number, zoom: number, clip: { width: number; height: number }): TrackedCrop {
  const base = baseCrop(clip.width, clip.height);
  const width = base.width / zoom, height = base.height / zoom;
  return { x: clamp(cx - width / 2, 0, clip.width - width), y: clamp(cy - height * SUBJECT_VERTICAL_ANCHOR, 0, clip.height - height), width, height };
}

/**
 * Plans every output frame: which clip frame is drawn, the subject-following 9:16 crop, the act
 * and the end card. Crops follow the zero-phase smoothed hero track, scale to cover, stay inside
 * the clip and never tighten past the smoothed subject box.
 */
export function planTrackedReel(set: MaskletSet, heroObjectId: string, options: { window?: { fromFrame: number; toFrame: number }; endCard?: "still_depth" | "freeze" } = {}): TrackedReelPlan {
  const hero = set.objects.find((object) => object.objectId === heroObjectId);
  if (!hero) throw new TrackedCinemaError("The hero object is not part of this masklet set.");
  const fromFrame = options.window?.fromFrame ?? 0, toFrame = options.window?.toFrame ?? set.clip.frameCount - 1;
  if (![fromFrame, toFrame].every(Number.isInteger) || fromFrame < 0 || toFrame < fromFrame || toFrame >= set.clip.frameCount) throw new TrackedCinemaError("The footage window lies outside the clip.");
  const footage = Math.min(toFrame - fromFrame + 1, TRACKED_REEL_FRAMES);
  if (footage < MIN_TRACKED_FOOTAGE_FRAMES) throw new TrackedCinemaError("The footage window is too short for a tracked Reel.");
  const points = new Map<number, TrackPoint>(hero.track.map((point) => [point.frame, point]));
  const present = Array.from({ length: footage }, (_, i) => points.get(fromFrame + i) ?? null);
  if (!present.some(Boolean)) throw new TrackedCinemaError("The hero object is not tracked inside the footage window.");

  const pick = (read: (point: TrackPoint) => number) => fillGaps(present.map((point) => point ? read(point) : null));
  const cx = smoothTrack(pick((p) => p.cx), 0.16), cy = smoothTrack(pick((p) => p.cy), 0.16);
  const offLeft = smoothTrack(pick((p) => p.cx - p.bounds.left), 0.1), offRight = smoothTrack(pick((p) => p.bounds.right - p.cx), 0.1);
  const offTop = smoothTrack(pick((p) => p.cy - p.bounds.top), 0.1), offBottom = smoothTrack(pick((p) => p.bounds.bottom - p.cy), 0.1);

  const ctaStart = Math.min(TRACKED_CTA_START, footage);
  const b1 = Math.round(ctaStart / 3), b2 = Math.round(ctaStart * 2 / 3);
  const acts: Record<TrackedAct, [number, number]> = { hook: [0, b1], proof: [b1, b2], value: [b2, ctaStart], cta: [ctaStart, TRACKED_REEL_FRAMES] };
  const actOf = (index: number): TrackedAct => index < b1 ? "hook" : index < b2 ? "proof" : index < ctaStart ? "value" : "cta";
  const actTime = (index: number) => (index - acts[actOf(index)][0]) / FPS;

  // Per-act zoom targets (push-in on the hook, tighter proof, easing out for the CTA), smoothed across act cuts.
  const zoomTarget = Array.from({ length: footage }, (_, i) => {
    const act = actOf(i), [start, end] = acts[act], p = (i - start) / Math.max(1, Math.min(end, footage) - start);
    return act === "hook" ? 1 + 0.06 * easeInOut(p) : act === "proof" ? 1.12 : act === "value" ? 1.08 - 0.04 * p : 1;
  });
  const zoom = smoothTrack(zoomTarget, 0.06);
  const base = baseCrop(set.clip.width, set.clip.height);
  const fitZoom = (i: number) => Math.min(base.width / ((offLeft[i] + offRight[i]) * SUBJECT_FIT_MARGIN), base.height / ((offTop[i] + offBottom[i]) * SUBJECT_FIT_MARGIN));

  let best = -1, bestScore = -1;
  present.forEach((point, i) => {
    if (!point) return;
    const touches = point.bounds.left <= 0 || point.bounds.top <= 0 || point.bounds.right >= set.clip.width || point.bounds.bottom >= set.clip.height;
    const score = point.area * (point.confidence ?? 0.8) * (touches ? 0.6 : 1);
    if (score > bestScore) { best = i; bestScore = score; }
  });

  const endFrames = TRACKED_REEL_FRAMES - footage;
  const endKind: TrackedReelPlan["endCard"]["kind"] = endFrames === 0 ? "none" : options.endCard ?? "freeze";
  const washed = endFrames >= MIN_WASHED_END_CARD;
  const frames: TrackedFramePlan[] = [];
  for (let i = 0; i < footage; i++) {
    const z = Math.max(1, Math.min(zoom[i], fitZoom(i)));
    frames.push({
      index: i, kind: "footage", act: actOf(i), actTime: actTime(i), sourceFrame: fromFrame + i,
      crop: cropAround(cx[i], cy[i], z, set.clip), tracked: Boolean(present[i]),
      centroid: { x: cx[i], y: cy[i] }, box: { left: cx[i] - offLeft[i], top: cy[i] - offTop[i], right: cx[i] + offRight[i], bottom: cy[i] + offBottom[i] },
      wash: washed && i >= footage - WASH_FRAMES ? easeInOut((i - (footage - WASH_FRAMES) + 0.5) / WASH_FRAMES) : 0,
      endCardFrame: null,
    });
  }
  const frozen = present[best]!;
  const frozenFit = Math.max(1, Math.min(base.width / ((frozen.bounds.right - frozen.bounds.left) * SUBJECT_FIT_MARGIN), base.height / ((frozen.bounds.bottom - frozen.bounds.top) * SUBJECT_FIT_MARGIN)));
  for (let j = 0; j < endFrames; j++) {
    const index = footage + j;
    const common = { index, act: "cta" as const, actTime: actTime(index), tracked: endKind === "freeze" };
    if (endKind === "still_depth") {
      frames.push({ ...common, kind: "still_depth", sourceFrame: null, crop: null, centroid: null, box: null, wash: 0, endCardFrame: washed ? Math.min(STILL_DEPTH_CTA_FRAME + j, STILL_DEPTH_LAST_FRAME) : TRACKED_REEL_FRAMES - endFrames + j });
    } else {
      // A gentle push-in on the frozen real frame; the frozen pixels themselves are never altered.
      const z = Math.min(1 + 0.04 * easeInOut((j + 0.5) / endFrames), frozenFit);
      frames.push({
        ...common, kind: "freeze", sourceFrame: fromFrame + best, crop: cropAround(frozen.cx, frozen.cy, z, set.clip),
        centroid: { x: frozen.cx, y: frozen.cy }, box: { ...frozen.bounds },
        wash: washed && j < WASH_FRAMES ? 1 - easeInOut((j + 0.5) / WASH_FRAMES) : 0, endCardFrame: null,
      });
    }
  }
  return { window: { fromFrame, toFrame }, footageFrames: footage, acts, endCard: { start: footage, frames: endFrames, kind: endKind }, bestFrame: fromFrame + best, frames };
}

// ---------------------------------------------------------------------------
// Local SVG graphics (premultiplied crops plus ledger-resolution alpha maps)
// ---------------------------------------------------------------------------

interface Graphic { x: number; y: number; width: number; height: number; data: Float32Array; reduced: Float32Array }

async function renderGraphic(body: string, defs = ""): Promise<Graphic | null> {
  if (!body.trim()) return null;
  const { data, info } = await sharp(Buffer.from(svgDocument(W, H, body, defs))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== W || info.height !== H || info.channels !== 4) throw new TrackedCinemaError("A typography layer could not be rendered.");
  let left = W, right = -1, top = H, bottom = -1;
  const reduced = new Float32Array(LW * LH);
  const cell = 1 / (LEDGER_FACTOR * LEDGER_FACTOR * 255);
  for (let y = 0; y < H; y++) {
    const rowCell = Math.floor(y / LEDGER_FACTOR) * LW;
    for (let x = 0; x < W; x++) {
      const a = data[(y * W + x) * 4 + 3];
      if (!a) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      reduced[rowCell + Math.floor(x / LEDGER_FACTOR)] += a * cell;
    }
  }
  if (right < 0) return null;
  const width = right - left + 1, height = bottom - top + 1;
  const crop = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = ((top + y) * W + left + x) * 4, o = (y * width + x) * 4, a = data[s + 3] / 255;
    crop[o] = data[s] * a; crop[o + 1] = data[s + 1] * a; crop[o + 2] = data[s + 2] * a; crop[o + 3] = a;
  }
  return { x: left, y: top, width, height, data: crop, reduced };
}

function drawGraphicPixels(dst: Float32Array, g: Graphic, dx: number, dy: number, opacity: number): void {
  if (opacity <= 0) return;
  const left = g.x + dx, top = g.y + dy;
  const x0 = Math.max(left, 0), x1 = Math.min(left + g.width, W), y0 = Math.max(top, 0), y1 = Math.min(top + g.height, H);
  for (let y = y0; y < y1; y++) {
    let s = ((y - top) * g.width + (x0 - left)) * 4, o = (y * W + x0) * 3;
    for (let x = x0; x < x1; x++, s += 4, o += 3) {
      const a = g.data[s + 3] * opacity;
      if (a <= 0) continue;
      const keep = 1 - a;
      dst[o] = dst[o] * keep + g.data[s] * opacity;
      dst[o + 1] = dst[o + 1] * keep + g.data[s + 1] * opacity;
      dst[o + 2] = dst[o + 2] * keep + g.data[s + 2] * opacity;
    }
  }
}

/** The graphic's ledger alpha shifted by whole output pixels (rounded to ledger cells). */
function shiftedReduced(g: Graphic, dx: number, dy: number, out: Float32Array): Float32Array {
  const cx = Math.round(dx / LEDGER_FACTOR), cy = Math.round(dy / LEDGER_FACTOR);
  if (!cx && !cy) { out.set(g.reduced); return out; }
  out.fill(0);
  for (let y = Math.max(0, cy); y < Math.min(LH, LH + cy); y++) {
    for (let x = Math.max(0, cx); x < Math.min(LW, LW + cx); x++) out[y * LW + x] = g.reduced[(y - cy) * LW + (x - cx)];
  }
  return out;
}

function hexRgb(value: string): [number, number, number] {
  return [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16)) as [number, number, number];
}

function luminance(value: string): number {
  const [r, g, b] = hexRgb(value).map((channel) => channel / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function luminanceRgb(rgb: readonly number[]): number {
  const [r, g, b] = rgb.map((channel) => channel / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/** Lowest text opacity used over footage; the contrast floor is checked with the text this translucent. */
const MIN_TEXT_OPACITY = 0.9;

/**
 * Worst-case contrast of `text` (drawn at MIN_TEXT_OPACITY) on a `dark` backing of `opacity` over a
 * pure white backdrop — the brightest thing footage can put under it.
 */
export function backedContrast(text: string, dark: string, opacity: number): number {
  const d = hexRgb(dark), t = hexRgb(text);
  const backdrop = d.map((channel) => 255 * (1 - opacity) + channel * opacity);
  const glyph = t.map((channel, i) => channel * MIN_TEXT_OPACITY + backdrop[i] * (1 - MIN_TEXT_OPACITY));
  const [hi, lo] = [luminanceRgb(glyph), luminanceRgb(backdrop)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Smallest backing opacity (in 0.01 steps) that keeps `minimum` contrast for `text` over any
 * footage; null when even an opaque `dark` backing cannot (the caller then changes the text colour).
 */
export function backingOpacity(text: string, dark: string, minimum: number): number | null {
  for (let step = 0; step <= 100; step++) if (backedContrast(text, dark, step / 100) >= minimum) return step / 100;
  return null;
}

/** Readable colour tokens from the proposed theme (same rules as the still-depth Reel). */
function tokens(theme: StillDepthTheme) {
  let light = luminance(theme.paper) >= luminance(theme.ink) ? theme.paper : theme.ink;
  let dark = light === theme.paper ? theme.ink : theme.paper;
  if (contrast(light, dark) < 4.5) { light = "#F6F2EA"; dark = "#1E2A2E"; }
  return {
    light, dark, accent: theme.accent,
    accentText: contrast(theme.accent, light) >= contrast(theme.accent, dark) ? light : dark,
    kickerOnDark: contrast(theme.soft, "#202020") >= 4.5 ? theme.soft : light,
    darkRgb: hexRgb(dark), accentRgb: hexRgb(theme.accent),
  };
}
type Tokens = ReturnType<typeof tokens>;

/** Text backings: padded around the text bounds and blurred; the padding keeps ≥ BACKING_COVERAGE of the opacity under the text. */
const BACKING_PAD_X = 30, BACKING_PAD_Y = 24, BACKING_COVERAGE = 0.97;
const BACKING_FILTER = `<filter id="soft" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><feGaussianBlur stdDeviation="9"/></filter>`;

function unionBounds(blocks: readonly (TextBlock | null | undefined)[]): Bounds | null {
  return blocks.reduce<Bounds | null>((a, block) => !block ? a : !a ? { ...block.bounds }
    : { left: Math.min(a.left, block.bounds.left), top: Math.min(a.top, block.bounds.top), right: Math.max(a.right, block.bounds.right), bottom: Math.max(a.bottom, block.bounds.bottom) }, null);
}

/** Adds the mask's coverage of every ledger cell (cell centres, nearest mask pixel) under a 9:16 crop. */
function addMaskCoverage(map: Float32Array, mask: FrameMask, crop: TrackedCrop): void {
  const s = W / crop.width, { left, top, right, bottom } = mask.bounds, mw = right - left, mh = bottom - top;
  const cx0 = Math.max(0, Math.floor((left - crop.x) * s / LEDGER_FACTOR)), cx1 = Math.min(LW, Math.ceil((right - crop.x) * s / LEDGER_FACTOR));
  const cy0 = Math.max(0, Math.floor((top - crop.y) * s / LEDGER_FACTOR)), cy1 = Math.min(LH, Math.ceil((bottom - crop.y) * s / LEDGER_FACTOR));
  for (let cy = cy0; cy < cy1; cy++) {
    const j = Math.floor(crop.y + (cy + 0.5) * LEDGER_FACTOR / s) - top;
    if (j < 0 || j >= mh) continue;
    for (let cx = cx0; cx < cx1; cx++) {
      const i = Math.floor(crop.x + (cx + 0.5) * LEDGER_FACTOR / s) - left;
      if (i >= 0 && i < mw && mask.raster[j * mw + i]) map[cy * LW + cx] += 1;
    }
  }
}

/** Opacity and rise offset of a layout item `actTime` s into an act `actLength` s long (shared by the layout checks and the compositor). */
function itemMotion(item: HeadlineMotion, actTime: number, actLength: number): { opacity: number; dy: number } {
  const scale = Math.min(1, actLength / 3);
  const e = easeOut((actTime - item.start * scale) / (0.55 * Math.max(0.35, scale)));
  return { opacity: e * (item.fadeOut ? clamp01((actLength - actTime) / 0.2) : 1), dy: Math.round((1 - e) * item.rise) };
}
interface HeadlineMotion { start: number; rise: number; fadeOut: boolean }
/** Entrance of the hook and value depth headlines (also used to check their placement frame by frame). */
const HOOK_HEADLINE_MOTION: HeadlineMotion = { start: 0.2, rise: 44, fadeOut: true };
const VALUE_HEADLINE_MOTION: HeadlineMotion = { start: 0.16, rise: 44, fadeOut: true };

/** The subject's ledger cells on one act frame where a depth headline is visible, and the headline's rise offset then. */
interface FrameCover { index: number; cells: Int32Array; rowMin: number; rowMax: number; dy: number }
/** Per-frame subject cover over an act (visible-headline frames) plus the act-mean cover map. */
interface ActCoverage { frames: FrameCover[]; mean: Float32Array }

/** A glyph graphic's alpha: whole and per text line (rows whose ledger-cell centre lies inside the line box). */
interface GlyphProfile { total: number; lineTotals: number[]; rowLines: Uint8Array; rowTop: number; rowBottom: number }
function glyphProfile(g: Graphic, lines: readonly (readonly [number, number])[]): GlyphProfile {
  const rowLines = new Uint8Array(LH), lineTotals = lines.map(() => 0);
  const rowTop = Math.max(0, Math.floor(g.y / LEDGER_FACTOR)), rowBottom = Math.min(LH, Math.ceil((g.y + g.height) / LEDGER_FACTOR));
  let total = 0;
  for (let y = rowTop; y < rowBottom; y++) {
    const centre = y * LEDGER_FACTOR + LEDGER_FACTOR / 2;
    lines.forEach(([top, bottom], index) => { if (centre >= top && centre < bottom) rowLines[y] |= 1 << index; });
    for (let x = 0; x < LW; x++) {
      const a = g.reduced[y * LW + x];
      if (!(a > 0)) continue;
      total += a;
      for (let line = 0; line < lineTotals.length; line++) if (rowLines[y] & (1 << line)) lineTotals[line] += a;
    }
  }
  return { total, lineTotals, rowLines, rowTop, rowBottom };
}

/**
 * Share of a glyph graphic, moved down by `shift` ledger rows, that the subject covers on one frame;
 * each line's share is written to `lineShare`.
 */
function frameGlyphCover(g: Graphic, profile: GlyphProfile, frame: FrameCover, shift: number, lineShare: Float64Array): number {
  lineShare.fill(0);
  if (!(profile.total > 0) || frame.rowMax < profile.rowTop + shift || frame.rowMin >= profile.rowBottom + shift) return 0;
  const offset = shift * LW;
  let covered = 0;
  for (const cell of frame.cells) {
    const source = cell - offset;
    if (source < 0 || source >= g.reduced.length) continue;
    const a = g.reduced[source];
    if (!(a > 0)) continue;
    covered += a;
    const lines = profile.rowLines[(source / LW) | 0];
    if (lines) for (let line = 0; line < profile.lineTotals.length; line++) if (lines & (1 << line)) lineShare[line] += a;
  }
  for (let line = 0; line < profile.lineTotals.length; line++) lineShare[line] = profile.lineTotals[line] > 0 ? lineShare[line] / profile.lineTotals[line] : 0;
  return covered / profile.total;
}

/** Share of the (mean) subject coverage hidden by the union of graphics moved down by `dy`. */
function subjectHidden(cover: Float32Array, graphics: readonly (Graphic | null)[], dy: number): number {
  const shifted = graphics.filter((g): g is Graphic => Boolean(g)).map((g) => shiftedReduced(g, 0, dy, new Float32Array(LW * LH)));
  let total = 0, hidden = 0;
  for (let i = 0; i < cover.length; i++) {
    if (cover[i] <= 0) continue;
    let clear = 1;
    for (const map of shifted) clear *= 1 - Math.min(1, map[i]);
    total += cover[i]; hidden += cover[i] * (1 - clear);
  }
  return total > 0 ? hidden / total : 0;
}

const SHADE_FILTER = `<filter id="shade" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur in="SourceAlpha" stdDeviation="7"/><feComponentTransfer><feFuncA type="linear" slope="0.5"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
const shaded = (svg: string) => renderGraphic(svg ? `<g filter="url(#shade)">${svg}</g>` : "", SHADE_FILTER);

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

type ItemRole = "depth_headline" | "front_text";
/** `lines`: output rows [top, bottom) of each text line of a depth headline, before its rise offset. */
interface ActItem { g: Graphic | null; layer: "behind" | "front"; start: number; rise: number; fadeOut: boolean; role?: ItemRole; lines?: readonly (readonly [number, number])[] }
interface SubjectStats { top: number; bottom: number; cy: number }

function subjectStats(plan: TrackedReelPlan, act: TrackedAct): SubjectStats | null {
  const [start, end] = plan.acts[act];
  const rows = plan.frames.slice(start, end).filter((frame) => frame.crop && frame.box && frame.centroid);
  if (!rows.length) return null;
  const out = (frame: TrackedFramePlan, value: number) => (value - frame.crop!.y) * H / frame.crop!.height;
  return { top: median(rows.map((f) => out(f, f.box!.top))), bottom: median(rows.map((f) => out(f, f.box!.bottom))), cy: median(rows.map((f) => out(f, f.centroid!.y))) };
}

interface TextSpec { text: string; face: FontFace; size: number; minSize?: number; maxLines: number; color: string; letterSpacing?: number; uppercase?: boolean; lineHeight?: number; opacity?: number }
function block(spec: TextSpec, x: number, top: number, maxWidth: number, anchor: "start" | "middle" = "start"): TextBlock {
  return textBlock({ text: spec.text, x, top, maxWidth, maxLines: spec.maxLines, preferredSize: spec.size, minSize: spec.minSize ?? Math.round(spec.size * 0.72), face: spec.face, color: spec.color, letterSpacing: spec.letterSpacing, uppercase: spec.uppercase, lineHeight: spec.lineHeight, opacity: spec.opacity, anchor });
}

async function prepareLayout(input: TrackedReelInput, plan: TrackedReelPlan, calloutText: string) {
  const theme = tokens(input.theme);
  const textWidth = W - SIDE * 2;
  const truncated: string[] = [];
  const note = (name: string, laid: TextBlock | null) => { if (laid?.truncated) truncated.push(name); };
  const [hookScene, proofScene, valueScene, ctaScene] = input.scenes;
  const concept = input.mode === "synthetic" ? "SYNTHETIC DEMO · CONCEPT" : "CONCEPT · REVIEW REQUIRED";
  const provenanceLabel = cleanText(input.provenanceLabel, 64);
  const bands = TRACKED_LABEL_BANDS;
  const chipStyle = { x: SIDE - 8, maxWidth: textWidth, face: "sansBold" as const, fill: theme.dark, fillOpacity: 0.86, color: theme.light };
  const chrome = await renderGraphic(
    pill({ ...chipStyle, text: concept, top: bands.top.top, height: bands.top.bottom - bands.top.top, size: 19, letterSpacing: 2.2 }).svg
    + pill({ ...chipStyle, text: provenanceLabel, top: bands.bottom.top, height: bands.bottom.bottom - bands.bottom.top, size: 17, letterSpacing: 1.8, uppercase: true }).svg,
  );
  const gradient = async (id: string, top: number, height: number, fromTop: boolean) => renderGraphic(
    `<rect x="0" y="${Math.round(top)}" width="${W}" height="${Math.round(height)}" fill="url(#${id})"/>`,
    `<linearGradient id="${id}" x1="0" y1="${fromTop ? 1 : 0}" x2="0" y2="${fromTop ? 0 : 1}"><stop offset="0" stop-color="${theme.dark}" stop-opacity="0"/><stop offset="0.55" stop-color="${theme.dark}" stop-opacity="0.6"/><stop offset="1" stop-color="${theme.dark}" stop-opacity="0.84"/></linearGradient>`,
  );
  /** A large serif headline set behind the real subject, overlapping the top of its typical box (CTA). */
  const depthHeadline = (text: string, stats: SubjectStats, size: number, minSize: number, anchor: "start" | "middle", minTop: number) => {
    const spec: TextSpec = { text, face: "serif", size, minSize, maxLines: 3, color: theme.light, lineHeight: 1.02 };
    const x = anchor === "middle" ? W / 2 : SIDE - 4;
    const height = block(spec, x, 0, textWidth, anchor).bounds.bottom;
    const top = Math.round(clamp(stats.top - height * 0.62, minTop, H - 300 - height));
    return block(spec, x, top, textWidth, anchor);
  };

  // Every text block over footage gets a soft dark backing that keeps its contrast floor over white.
  const kickerColor = backingOpacity(theme.kickerOnDark, theme.dark, MIN_TEXT_CONTRAST) === null ? theme.light : theme.kickerOnDark;
  const opacity = {
    body: backingOpacity(theme.light, theme.dark, MIN_TEXT_CONTRAST) ?? 1,
    kicker: backingOpacity(kickerColor, theme.dark, MIN_TEXT_CONTRAST) ?? 1,
    display: backingOpacity(theme.light, theme.dark, MIN_DISPLAY_CONTRAST) ?? 1,
  };
  const textContrast = {
    body: Number(backedContrast(theme.light, theme.dark, opacity.body).toFixed(2)),
    kicker: Number(backedContrast(kickerColor, theme.dark, opacity.kicker).toFixed(2)),
    display: Number(backedContrast(theme.light, theme.dark, opacity.display).toFixed(2)),
    backingOpacity: opacity,
    backingLayer: "beneath_subject" as const,
  };
  /** Soft-edged backing under text bounds; the blur falloff is compensated so the text area gets the full opacity. */
  const backing = (boxes: readonly (Bounds | null | undefined)[], alpha: number) => {
    const rects = boxes.filter((box): box is Bounds => Boolean(box)).map((box) => {
      const x = Math.max(0, Math.floor(box.left - BACKING_PAD_X)), y = Math.floor(box.top - BACKING_PAD_Y);
      const width = Math.min(W, Math.ceil(box.right + BACKING_PAD_X)) - x, height = Math.ceil(box.bottom + BACKING_PAD_Y) - y;
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="28" fill="${theme.dark}" fill-opacity="${Math.min(1, alpha / BACKING_COVERAGE).toFixed(3)}"/>`;
    }).join("");
    return renderGraphic(rects ? `<g filter="url(#soft)">${rects}</g>` : "", BACKING_FILTER);
  };
  /**
   * Text on its backing. The backing is always composited beneath the hero subject (it never hides
   * it); text set in front of the subject keeps its glyphs in front and is tagged front_text.
   */
  const backed = async (items: ActItem[], laid: readonly (TextBlock | null)[], alpha: number, item: Omit<ActItem, "g">, shade = true) => {
    const present = laid.filter((value): value is TextBlock => Boolean(value));
    if (!present.length) return;
    items.push({ ...item, layer: "behind", role: undefined, lines: undefined, g: await backing([unionBounds(present)], alpha) });
    const role = item.layer === "front" ? "front_text" : item.role;
    for (const value of present) items.push({ ...item, role, g: shade ? await shaded(value.svg) : await renderGraphic(value.svg) });
  };

  // Depth headlines are placed against the subject's mask in every frame of the act where they are
  // visible (it moves): an act mean would let a passing subject hide whole words in single frames.
  const coverage = async (act: TrackedAct, motion: HeadlineMotion): Promise<ActCoverage> => {
    const [start, end] = plan.acts[act];
    const length = (end - start) / FPS;
    const map = new Float32Array(LW * LH), mean = new Float32Array(LW * LH);
    const frames: FrameCover[] = [];
    let counted = 0;
    for (let index = start; index < end; index++) {
      const frame = plan.frames[index];
      if (frame.kind !== "footage" || !frame.crop || frame.sourceFrame === null) continue;
      const mask = await input.reader.frameMask(input.heroObjectId, frame.sourceFrame);
      if (!mask) continue;
      counted++;
      map.fill(0);
      addMaskCoverage(map, mask, frame.crop);
      const cells: number[] = [];
      let rowMin = LH, rowMax = -1;
      for (let i = 0; i < map.length; i++) {
        if (!(map[i] > 0)) continue;
        mean[i] += map[i];
        cells.push(i);
        const row = (i / LW) | 0;
        if (row < rowMin) rowMin = row;
        if (row > rowMax) rowMax = row;
      }
      const { opacity, dy } = itemMotion(motion, frame.actTime, length);
      if (opacity >= HEADLINE_VISIBLE_OPACITY) frames.push({ index, cells: Int32Array.from(cells), rowMin, rowMax, dy });
    }
    if (counted) for (let i = 0; i < mean.length; i++) mean[i] /= counted;
    return { frames, mean };
  };
  const placeHeadline = async (name: string, text: string, cover: ActCoverage, sizes: readonly number[], minTop: number, maxBottom: number) => {
    const round = (value: number) => Number(value.toFixed(4));
    for (const [index, size] of sizes.entries()) {
      const last = index === sizes.length - 1;
      const spec: TextSpec = { text, face: "serif", size, minSize: last ? Math.round(size * 0.85) : size, maxLines: 3, color: theme.light, lineHeight: 1.02 };
      const probe = block(spec, SIDE - 4, minTop, textWidth);
      if ((probe.truncated || probe.brokenWords) && !last) continue;
      const glyphs = await shaded(probe.svg);
      if (!glyphs) continue;
      const profile = glyphProfile(glyphs, probe.boxes.map((box) => [box.y, box.y + box.height] as const));
      const lineShare = new Float64Array(profile.lineTotals.length);
      let best: { top: number; mean: number; lineMean: number; worst: number; worstLine: number; score: number } | null = null;
      band: for (let top = minTop; top + probe.bounds.bottom - minTop <= maxBottom; top += LEDGER_FACTOR * 6) {
        let sum = 0, worst = 0, worstLine = 0;
        const lineSums = new Float64Array(profile.lineTotals.length);
        // Every visible frame, at that frame's rise offset, must keep the whole headline and each line readable.
        for (const frame of cover.frames) {
          const whole = frameGlyphCover(glyphs, profile, frame, Math.round((top - minTop + frame.dy) / LEDGER_FACTOR), lineShare);
          const line = Math.max(0, ...lineShare);
          if (whole > MAX_HEADLINE_OCCLUSION || line > MAX_HEADLINE_LINE_OCCLUSION) continue band;
          sum += whole; worst = Math.max(worst, whole); worstLine = Math.max(worstLine, line);
          lineShare.forEach((value, i) => { lineSums[i] += value; });
        }
        const count = Math.max(1, cover.frames.length);
        // The band that hides the least in its worst frame; ties go to the higher band.
        const score = Math.max(worst, worstLine) + 0.25 * top / H;
        if (!best || score < best.score) best = { top, mean: sum / count, lineMean: Math.max(0, ...Array.from(lineSums, (value) => value / count)), worst, worstLine, score };
      }
      if (!best) continue;
      const laid = block(spec, SIDE - 4, best.top, textWidth);
      note(name, laid);
      const report: TrackedHeadlinePlacement = {
        placement: "behind_subject", occlusion: round(best.mean), lineOcclusion: round(best.lineMean), maxFrameOcclusion: round(best.worst), maxFrameLineOcclusion: round(best.worstLine),
        framesChecked: cover.frames.length, foregroundOcclusion: 0, fontSize: laid.size, top: best.top,
      };
      return { laid, report, layer: "behind" as const, lines: laid.boxes.map((box) => [box.y, box.y + box.height] as const) };
    }
    // No band keeps the moving subject off the headline in every frame: it goes in front (its backing
    // stays beneath the subject), where its glyphs hide the subject least over the act.
    const spec: TextSpec = { text, face: "serif", size: 96, minSize: 72, maxLines: 3, color: theme.light, lineHeight: 1.04 };
    const probe = block(spec, SIDE - 4, minTop, textWidth);
    const glyphs = await shaded(probe.svg);
    let best = { top: minTop, hidden: Infinity };
    for (let top = minTop; top + probe.bounds.bottom - minTop <= maxBottom; top += LEDGER_FACTOR * 6) {
      const hidden = subjectHidden(cover.mean, [glyphs], top - minTop);
      if (hidden < best.hidden - 1e-6) best = { top, hidden };
    }
    const laid = block(spec, SIDE - 4, best.top, textWidth);
    note(name, laid);
    const report: TrackedHeadlinePlacement = {
      placement: "in_front", occlusion: 0, lineOcclusion: 0, maxFrameOcclusion: 0, maxFrameLineOcclusion: 0, framesChecked: cover.frames.length,
      foregroundOcclusion: round(Number.isFinite(best.hidden) ? best.hidden : 0), fontSize: laid.size, top: best.top,
    };
    return { laid, report, layer: "front" as const, lines: undefined };
  };
  const acts: Record<TrackedAct, ActItem[]> = { hook: [], proof: [], value: [], cta: [] };

  // HOOK — kicker and giant headline behind the subject (placed against its motion over the act); body in front at the bottom.
  const hookBodySpec: TextSpec = { text: hookScene.body, face: "sans", size: 36, maxLines: 3, color: theme.light, lineHeight: 1.3 };
  const hookBodyTop = H - 150 - block(hookBodySpec, 0, 0, textWidth).bounds.bottom;
  const hookPlaced = await placeHeadline("hook.headline", hookScene.headline, await coverage("hook", HOOK_HEADLINE_MOTION), HOOK_HEADLINE_SIZES, 176, Math.min(H - 300, hookScene.body.trim() ? hookBodyTop - 40 : H - 300));
  if (hookScene.kicker.trim()) {
    const kicker = block({ text: hookScene.kicker, face: "sansBold", size: 26, maxLines: 1, color: kickerColor, letterSpacing: 5, uppercase: true }, SIDE, Math.max(140, hookPlaced.laid.bounds.top - 60), textWidth);
    await backed(acts.hook, [kicker], opacity.kicker, { layer: "behind", start: 0.12, rise: 40, fadeOut: true }, false);
  }
  await backed(acts.hook, [hookPlaced.laid], opacity.display, { layer: hookPlaced.layer, ...HOOK_HEADLINE_MOTION, role: hookPlaced.layer === "behind" ? "depth_headline" : undefined, lines: hookPlaced.lines });
  if (hookScene.body.trim()) {
    const laid = block(hookBodySpec, SIDE, hookBodyTop, textWidth);
    note("hook.body", laid);
    await backed(acts.hook, [laid], opacity.body, { layer: "front", start: 0.9, rise: 30, fadeOut: true });
  }

  // PROOF — kicker/headline/body stack in front on the side the subject leaves free.
  const hookStats = subjectStats(plan, "hook")!;
  const proofStats = subjectStats(plan, "proof") ?? hookStats;
  const stackSide: "top" | "bottom" = proofStats.cy > H * 0.5 ? "top" : "bottom";
  const proofSpecs: TextSpec[] = [
    { text: proofScene.kicker, face: "sansBold", size: 24, maxLines: 1, color: kickerColor, letterSpacing: 4.5, uppercase: true },
    { text: proofScene.headline, face: "serif", size: 78, minSize: 56, maxLines: 3, color: theme.light, lineHeight: 1.06 },
    { text: proofScene.body, face: "sans", size: 33, minSize: 27, maxLines: 3, color: theme.light, lineHeight: 1.32, opacity: 0.94 },
  ];
  const gaps = [22, 26, 0];
  const layStack = (top: number) => {
    let cursor = top;
    return proofSpecs.map((spec, index) => {
      if (!spec.text.trim()) return null;
      const laid = block(spec, SIDE, cursor, textWidth);
      cursor = laid.bounds.bottom + gaps[index];
      return laid;
    });
  };
  const stackHeight = Math.max(0, ...layStack(0).map((laid) => laid?.bounds.bottom ?? 0));
  const stackTop = stackSide === "top" ? 176 : H - 150 - stackHeight;
  acts.proof.push({ g: await gradient("proofShade", stackSide === "top" ? 0 : stackTop - 260, stackHeight + 260 + (stackSide === "top" ? stackTop : 150), stackSide === "top"), layer: "behind", start: 0, rise: 0, fadeOut: true });
  const proofStack = layStack(stackTop);
  // The stack's backing sits beneath the subject; the stacked text is in front.
  acts.proof.push({ g: await backing([unionBounds(proofStack)], Math.max(opacity.body, opacity.kicker)), layer: "behind", start: 0.1, rise: 34, fadeOut: true });
  for (const [index, laid] of proofStack.entries()) {
    if (!laid) continue;
    note(`proof.${index}`, laid);
    acts.proof.push({ g: await shaded(laid.svg), layer: "front", start: 0.1 + index * 0.12, rise: 34, fadeOut: true, role: "front_text" });
  }

  // VALUE — a second depth headline behind the subject (placed against its motion); body in front at the bottom.
  const valueBodySpec: TextSpec = { text: valueScene.body, face: "sans", size: 33, minSize: 27, maxLines: 3, color: theme.light, lineHeight: 1.32, opacity: 0.94 };
  const valueBodyHeight = valueScene.body.trim() ? block(valueBodySpec, 0, 0, textWidth).bounds.bottom : 0;
  const valueBodyTop = H - 150 - valueBodyHeight;
  const valuePlaced = await placeHeadline("value.headline", valueScene.headline, await coverage("value", VALUE_HEADLINE_MOTION), VALUE_HEADLINE_SIZES, 176, Math.min(H - 300, valueBodyHeight ? valueBodyTop - 40 : H - 300));
  if (valueScene.kicker.trim()) {
    const kicker = block({ text: valueScene.kicker, face: "sansBold", size: 24, maxLines: 1, color: kickerColor, letterSpacing: 4.5, uppercase: true }, SIDE, Math.max(140, valuePlaced.laid.bounds.top - 56), textWidth);
    await backed(acts.value, [kicker], opacity.kicker, { layer: "behind", start: 0.1, rise: 36, fadeOut: true }, false);
  }
  await backed(acts.value, [valuePlaced.laid], opacity.display, { layer: valuePlaced.layer, ...VALUE_HEADLINE_MOTION, role: valuePlaced.layer === "behind" ? "depth_headline" : undefined, lines: valuePlaced.lines });
  if (valueBodyHeight) {
    const laid = block(valueBodySpec, SIDE, valueBodyTop, textWidth);
    note("value.body", laid);
    acts.value.push({ g: await gradient("valueShade", valueBodyTop - 240, valueBodyHeight + 390, false), layer: "behind", start: 0, rise: 0, fadeOut: true });
    await backed(acts.value, [laid], opacity.body, { layer: "front", start: 0.45, rise: 30, fadeOut: true });
  }

  // CTA — brand line and CTA pill in front; the CTA headline behind the subject. Only drawn on real frames.
  const ctaStats = subjectStats(plan, "cta");
  if (ctaStats) {
    const brand = block({ text: input.businessName, face: "sansBold", size: 30, minSize: 22, maxLines: 1, color: theme.light, letterSpacing: 5, uppercase: true }, W / 2, 172, textWidth, "middle");
    note("cta.brand", brand);
    const headline = depthHeadline(ctaScene.headline, ctaStats, 104, 72, "middle", Math.round(brand.bounds.bottom + 36));
    note("cta.headline", headline);
    const bodySpec: TextSpec = { text: ctaScene.body, face: "sans", size: 30, minSize: 25, maxLines: 2, color: theme.light, lineHeight: 1.3, opacity: 0.9 };
    const bodyHeight = ctaScene.body.trim() ? block(bodySpec, 0, 0, textWidth, "middle").bounds.bottom : 0;
    const pillHeight = 104, pillTop = Math.round(H - 150 - pillHeight - (bodyHeight ? bodyHeight + 30 : 0));
    const ctaPill = pill({ text: input.cta, x: W / 2, top: pillTop, height: pillHeight, maxWidth: textWidth, size: 38, minSize: 26, face: "sansBold", fill: theme.accent, color: theme.accentText, anchor: "middle", paddingX: 56 });
    const body = bodyHeight ? block(bodySpec, W / 2, pillTop + pillHeight + 30, textWidth, "middle") : null;
    note("cta.body", body);
    acts.cta.push({ g: await gradient("ctaTop", 0, Math.max(headline.bounds.bottom, brand.bounds.bottom) + 120, true), layer: "behind", start: 0, rise: 0, fadeOut: false });
    acts.cta.push({ g: await gradient("ctaBottom", pillTop - 260, H - pillTop + 260, false), layer: "behind", start: 0, rise: 0, fadeOut: false });
    await backed(acts.cta, [headline], opacity.display, { layer: "behind", start: 0.12, rise: 34, fadeOut: false });
    await backed(acts.cta, [brand], opacity.body, { layer: "front", start: 0, rise: 28, fadeOut: false });
    acts.cta.push({ g: await renderGraphic(ctaPill.svg), layer: "front", start: 0.4, rise: 28, fadeOut: false });
    await backed(acts.cta, [body], opacity.body, { layer: "front", start: 0.55, rise: 28, fadeOut: false });
  }

  // CALLOUT — the focus/offering name attached to the tracked subject through the proof and value acts.
  const label = pill({ text: calloutText, x: 0, top: CALLOUT_POINTER, height: CALLOUT_HEIGHT, maxWidth: Math.round(W * 0.72), size: 30, minSize: 22, face: "sansBold", fill: theme.light, color: theme.dark, fillOpacity: 0.95, paddingX: 30 });
  const calloutWidth = Math.round(label.bounds.right - label.bounds.left);
  const mid = calloutWidth / 2, tip = 12;
  const pointerDown = `<path d="M ${mid - tip} ${CALLOUT_POINTER + CALLOUT_HEIGHT} L ${mid + tip} ${CALLOUT_POINTER + CALLOUT_HEIGHT} L ${mid} ${CALLOUT_POINTER * 2 + CALLOUT_HEIGHT} Z" fill="${theme.light}" fill-opacity="0.95"/>`;
  const pointerUp = `<path d="M ${mid - tip} ${CALLOUT_POINTER} L ${mid + tip} ${CALLOUT_POINTER} L ${mid} 0 Z" fill="${theme.light}" fill-opacity="0.95"/>`;
  const [calloutAbove, calloutBelow] = await Promise.all([renderGraphic(label.svg + pointerDown), renderGraphic(label.svg + pointerUp)]);
  // One side for the whole span (no flipping): opposite the proof stack when it fits for most frames.
  const span = plan.frames.slice(plan.acts.proof[0], plan.acts.value[1]).filter((frame) => frame.crop && frame.box);
  const fits = (side: "above" | "below") => span.filter((frame) => {
    const s = H / frame.crop!.height;
    return side === "above" ? (frame.box!.top - frame.crop!.y) * s - CALLOUT_GAP - CALLOUT_HEIGHT - CALLOUT_POINTER * 2 >= CALLOUT_SAFE.top
      : (frame.box!.bottom - frame.crop!.y) * s + CALLOUT_GAP + CALLOUT_HEIGHT + CALLOUT_POINTER * 2 <= CALLOUT_SAFE.bottom;
  }).length >= span.length * 0.8;
  const preferred: "above" | "below" = stackSide === "bottom" ? "above" : "below";
  const calloutSide = fits(preferred) ? preferred : fits(preferred === "above" ? "below" : "above") ? (preferred === "above" ? "below" : "above") : preferred;

  return {
    theme, chrome, acts, conceptLabel: concept, provenanceLabel, truncated, hookHeadline: hookPlaced.report, valueHeadline: valuePlaced.report, textContrast,
    callout: { above: calloutAbove, below: calloutBelow, width: calloutWidth, side: calloutSide, text: label.boxes[0]?.text ?? calloutText },
  };
}

// ---------------------------------------------------------------------------
// Per-frame compositor
// ---------------------------------------------------------------------------

interface DrawOp { g: Graphic; dx: number; dy: number; opacity: number; role?: ItemRole; lines?: readonly (readonly [number, number])[] }
export interface TrackedFrameStats {
  maskPresent: boolean;
  /** Share of the visible behind-subject depth headline's glyph area covered by the subject; null when none is visible or no mask. */
  headlineOcclusion: number | null;
  /** Worst single line's share of that headline covered by the subject on this frame; null as above. */
  headlineLineOcclusion: number | null;
  /** Share of the shown in-front text glyph area drawn over the real subject (no backing there); null when no front text is shown. */
  frontTextOverSubject: number | null;
  /** Mask pixels the compositing refinement dropped (specks) or filled (pin-holes) on this frame; null without a footage mask. */
  maskRefinement: { removedPixels: number; filledPixels: number; edgeSigma: number } | null;
}

class FootageCompositor {
  private readonly reframed = new Float32Array(W * H * 3);
  private readonly out = new Float32Array(W * H * 3);
  private readonly low = new Float32Array(LW * LH * 3);
  private readonly channel = new Float32Array(LW * LH);
  private readonly scratch = new Float32Array(LW * LH);
  private readonly support: Float32Array;
  private readonly subjectReduced = new Float32Array(LW * LH);
  private readonly ledgerScratch = new Float32Array(LW * LH);
  private readonly ones = new Float32Array(LW * LH).fill(1);
  private readonly cols = { index: new Int32Array(W), frac: new Float32Array(W) };
  private readonly rows = { index: new Int32Array(H), frac: new Float32Array(H) };
  private readonly upCols = { index: new Int32Array(W), frac: new Float32Array(W) };
  private readonly upRows = { index: new Int32Array(H), frac: new Float32Array(H) };

  constructor(private readonly theme: Tokens) {
    this.support = gaussianBlurZero(new Float32Array(LW * LH).fill(1), LW, LH, BACKGROUND_SIGMA);
    const lookup = (count: number, size: number, target: { index: Int32Array; frac: Float32Array }) => {
      for (let i = 0; i < count; i++) {
        const u = clamp((i + 0.5) / LEDGER_FACTOR - 0.5, 0, size - 1), i0 = Math.min(size - 2, Math.floor(u));
        target.index[i] = i0; target.frac[i] = u - i0;
      }
    };
    lookup(W, LW, this.upCols); lookup(H, LH, this.upRows);
  }

  /**
   * One bilinear resample of the footage frame into the 9:16 crop (edge-clamped). `crop` is in
   * tracking-clip pixels; `k` maps it per axis onto a larger render-source frame.
   */
  private reframe(frame: ClipFrame, crop: TrackedCrop, k: { x: number; y: number } | null): void {
    const sw = frame.width, sh = frame.height, src = frame.rgba;
    const sourceCrop = k ? { x: crop.x * k.x, y: crop.y * k.y, width: crop.width * k.x, height: crop.height * k.y } : crop;
    const scaleX = sourceCrop.width / W, scaleY = k ? sourceCrop.height / H : scaleX;
    const axis = (count: number, origin: number, size: number, scale: number, target: { index: Int32Array; frac: Float32Array }) => {
      for (let i = 0; i < count; i++) {
        const u = clamp(origin + (i + 0.5) * scale - 0.5, 0, size - 1), i0 = Math.max(0, Math.min(size - 2, Math.floor(u)));
        target.index[i] = i0; target.frac[i] = size > 1 ? u - i0 : 0;
      }
    };
    axis(W, sourceCrop.x, sw, scaleX, this.cols); axis(H, sourceCrop.y, sh, scaleY, this.rows);
    const dst = this.reframed, rowStride = sw * 4, step = sw > 1 ? 4 : 0, next = sh > 1 ? rowStride : 0;
    for (let y = 0; y < H; y++) {
      const r0 = this.rows.index[y] * rowStride, fy = this.rows.frac[y];
      let o = y * W * 3;
      for (let x = 0; x < W; x++, o += 3) {
        const a = r0 + this.cols.index[x] * 4, b = a + step, c = a + next, d = c + step, fx = this.cols.frac[x];
        for (let k = 0; k < 3; k++) {
          const top = src[a + k] + (src[b + k] - src[a + k]) * fx, bottom = src[c + k] + (src[d + k] - src[c + k]) * fx;
          dst[o + k] = top + (bottom - top) * fy;
        }
      }
    }
  }

  /** Blurred, desaturated, darkened copy of the reframed frame (computed at 1/4 scale), blended in by `amount`. */
  private treat(amount: number): void {
    const src = this.reframed, out = this.out;
    if (amount <= 0) { out.set(src); return; }
    const low = this.low;
    low.fill(0);
    const cell = 1 / (LEDGER_FACTOR * LEDGER_FACTOR);
    for (let y = 0; y < H; y++) {
      const row = (y >> 2) * LW;
      for (let x = 0, i = y * W * 3; x < W; x++, i += 3) {
        const o = (row + (x >> 2)) * 3;
        low[o] += src[i] * cell; low[o + 1] += src[i + 1] * cell; low[o + 2] += src[i + 2] * cell;
      }
    }
    for (let k = 0; k < 3; k++) {
      const channel = this.channel;
      for (let i = 0; i < channel.length; i++) channel[i] = low[i * 3 + k];
      gaussianBlurZero(channel, LW, LH, BACKGROUND_SIGMA, this.scratch);
      for (let i = 0; i < channel.length; i++) low[i * 3 + k] = channel[i] / this.support[i];
    }
    const tone = this.theme.darkRgb.map((value) => value * 0.14);
    for (let y = 0; y < LH; y++) {
      const ny = (y / LH - 0.46) * 2;
      for (let x = 0; x < LW; x++) {
        const nx = (x / LW - 0.5) * 2, vignette = 1 - 0.34 * Math.min(1, (nx * nx + ny * ny) / 1.6);
        const o = (y * LW + x) * 3, l = low[o] * 0.2126 + low[o + 1] * 0.7152 + low[o + 2] * 0.0722;
        for (let k = 0; k < 3; k++) low[o + k] = ((low[o + k] * 0.3 + l * 0.7) * 0.55 + tone[k]) * vignette;
      }
    }
    const { upCols, upRows } = this;
    for (let y = 0; y < H; y++) {
      const r0 = upRows.index[y] * LW * 3, r1 = r0 + LW * 3, fy = upRows.frac[y];
      for (let x = 0, o = y * W * 3; x < W; x++, o += 3) {
        const a = r0 + upCols.index[x] * 3, c = r1 + upCols.index[x] * 3, fx = upCols.frac[x];
        for (let k = 0; k < 3; k++) {
          const top = low[a + k] + (low[a + 3 + k] - low[a + k]) * fx, bottom = low[c + k] + (low[c + 3 + k] - low[c + k]) * fx;
          out[o + k] = src[o + k] + (top + (bottom - top) * fy - src[o + k]) * amount;
        }
      }
    }
  }

  /**
   * Pops the real subject on top: output = background·(1−α) + reframed·α, with α the refined SAM
   * mask (smoothed coverage field, bilinearly upsampled) whose edge ramp spans SUBJECT_FEATHER_PX
   * output pixels. Returns the subject's inside and full (transformed) areas for crop accounting and
   * what the refinement removed/filled; fills `subjectReduced` for the ledger.
   */
  private popSubject(mask: FrameMask, crop: TrackedCrop): { insideArea: number; totalArea: number; refined: { removedPixels: number; filledPixels: number; edgeSigma: number } } {
    const s = W / crop.width, { left, top, right, bottom } = mask.bounds;
    const refined = refineMaskField(mask.raster, right - left, bottom - top, { sigma: trackedMaskSigma(s) });
    const field = refined.field, fw = refined.width, fh = refined.height;
    // Clip position of field cell (0, 0)'s pixel centre is (gx + 0.5, gy + 0.5).
    const gx = left + refined.ox, gy = top + refined.oy;
    const x0 = Math.max(0, Math.floor((gx - crop.x) * s) - 2), x1 = Math.min(W, Math.ceil((gx + fw - crop.x) * s) + 2);
    const y0 = Math.max(0, Math.floor((gy - crop.y) * s) - 2), y1 = Math.min(H, Math.ceil((gy + fh - crop.y) * s) + 2);
    const reduced = this.subjectReduced, cell = 1 / (LEDGER_FACTOR * LEDGER_FACTOR);
    reduced.fill(0);
    let inside = 0;
    const ramp = refined.gain * s / SUBJECT_FEATHER_PX, src = this.reframed, out = this.out;
    for (let y = y0; y < y1 && fw > 0; y++) {
      const v = crop.y + (y + 0.5) / s - 0.5 - gy, j0 = Math.floor(v), fy = v - j0;
      const row0 = j0 >= 0 && j0 < fh, row1 = j0 + 1 >= 0 && j0 + 1 < fh;
      if (!row0 && !row1) continue;
      const reducedRow = (y >> 2) * LW;
      for (let x = x0; x < x1; x++) {
        const u = crop.x + (x + 0.5) / s - 0.5 - gx, i0 = Math.floor(u), fx = u - i0;
        const col0 = i0 >= 0 && i0 < fw, col1 = i0 + 1 >= 0 && i0 + 1 < fw;
        if (!col0 && !col1) continue;
        const p = j0 * fw + i0;
        const value = (row0 && col0 ? field[p] * (1 - fx) * (1 - fy) : 0) + (row0 && col1 ? field[p + 1] * fx * (1 - fy) : 0)
          + (row1 && col0 ? field[p + fw] * (1 - fx) * fy : 0) + (row1 && col1 ? field[p + fw + 1] * fx * fy : 0);
        const a = clamp01((value - 0.5) * ramp + 0.5);
        if (a <= 0) continue;
        const o = (y * W + x) * 3;
        if (a >= 1) { out[o] = src[o]; out[o + 1] = src[o + 1]; out[o + 2] = src[o + 2]; }
        else { const keep = 1 - a; out[o] = out[o] * keep + src[o] * a; out[o + 1] = out[o + 1] * keep + src[o + 1] * a; out[o + 2] = out[o + 2] * keep + src[o + 2] * a; }
        inside += a;
        reduced[reducedRow + (x >> 2)] += a * cell;
      }
    }
    return { insideArea: inside, totalArea: refined.area * s * s, refined: { removedPixels: refined.report.removedPixels, filledPixels: refined.report.filledPixels, edgeSigma: refined.report.edgeSigma } };
  }

  private wash(amount: number): void {
    if (amount <= 0) return;
    const a = clamp01(amount), dst = this.out, [r, g, b] = this.theme.accentRgb;
    for (let i = 0; i < dst.length; i += 3) { dst[i] += (r - dst[i]) * a; dst[i + 1] += (g - dst[i + 1]) * a; dst[i + 2] += (b - dst[i + 2]) * a; }
  }

  private toRgba(): Buffer {
    const out = Buffer.allocUnsafe(W * H * 4), src = this.out;
    for (let i = 0, o = 0; i < src.length; i += 3, o += 4) {
      out[o] = src[i] <= 0 ? 0 : src[i] >= 255 ? 255 : Math.round(src[i]);
      out[o + 1] = src[i + 1] <= 0 ? 0 : src[i + 1] >= 255 ? 255 : Math.round(src[i + 1]);
      out[o + 2] = src[i + 2] <= 0 ? 0 : src[i + 2] >= 255 ? 255 : Math.round(src[i + 2]);
      out[o + 3] = 255;
    }
    return out;
  }

  compose(frame: ClipFrame, k: { x: number; y: number } | null, mask: FrameMask | null, crop: TrackedCrop, treatment: number, behind: readonly DrawOp[], front: readonly DrawOp[], wash: number, chrome: Graphic | null): { rgba: Buffer; canvas: LedgerCanvas; stats: TrackedFrameStats } {
    const canvas = new LedgerCanvas(LW, LH);
    this.reframe(frame, crop, k);
    this.treat(treatment);
    canvas.over("treated_source", this.ones, 1);
    for (const op of behind) {
      drawGraphicPixels(this.out, op.g, op.dx, op.dy, op.opacity);
      canvas.over("background_graphics", shiftedReduced(op.g, op.dx, op.dy, this.ledgerScratch), clamp01(op.opacity));
    }
    let headlineOcclusion: number | null = null, headlineLineOcclusion: number | null = null, frontTextOverSubject: number | null = null, maskRefinement: TrackedFrameStats["maskRefinement"] = null;
    if (mask) {
      const popped = this.popSubject(mask, crop);
      maskRefinement = popped.refined;
      canvas.addSubjectInstance({ insideArea: popped.insideArea, totalArea: popped.totalArea });
      canvas.over("subject", this.subjectReduced, 1);
      const headline = behind.find((op) => op.role === "depth_headline" && op.opacity >= HEADLINE_VISIBLE_OPACITY);
      if (headline) {
        const glyphs = shiftedReduced(headline.g, headline.dx, headline.dy, this.ledgerScratch);
        const lines = headline.lines ?? [], lineTotal = lines.map(() => 0), lineCovered = lines.map(() => 0);
        let total = 0, covered = 0;
        for (let i = 0; i < glyphs.length; i++) {
          if (!(glyphs[i] > 0)) continue;
          const c = glyphs[i] * Math.min(1, this.subjectReduced[i]);
          total += glyphs[i]; covered += c;
          const centre = ((i / LW) | 0) * LEDGER_FACTOR + LEDGER_FACTOR / 2 - headline.dy;
          lines.forEach(([top, bottom], line) => { if (centre >= top && centre < bottom) { lineTotal[line] += glyphs[i]; lineCovered[line] += c; } });
        }
        headlineOcclusion = total > 0 ? covered / total : null;
        if (headlineOcclusion !== null) headlineLineOcclusion = Math.max(0, ...lineTotal.map((value, line) => value > 0 ? lineCovered[line] / value : 0));
      }
    }
    const text = front.filter((op) => op.role === "front_text");
    if (text.length) {
      let total = 0, over = 0;
      for (const op of text) {
        const glyphs = shiftedReduced(op.g, op.dx, op.dy, this.ledgerScratch), weight = clamp01(op.opacity);
        for (let i = 0; i < glyphs.length; i++) {
          if (!(glyphs[i] > 0)) continue;
          const a = Math.min(1, glyphs[i]) * weight;
          total += a;
          if (mask) over += a * Math.min(1, this.subjectReduced[i]);
        }
      }
      frontTextOverSubject = total > 0 ? over / total : null;
    }
    for (const op of front) {
      drawGraphicPixels(this.out, op.g, op.dx, op.dy, op.opacity);
      canvas.over("foreground_graphics", shiftedReduced(op.g, op.dx, op.dy, this.ledgerScratch), clamp01(op.opacity));
    }
    if (wash > 0) { this.wash(wash); canvas.over("transition", this.ones, clamp01(wash)); }
    if (chrome) { drawGraphicPixels(this.out, chrome, 0, 0, 1); canvas.over("foreground_graphics", chrome.reduced, 1); }
    return { rgba: this.toRgba(), canvas, stats: { maskPresent: Boolean(mask), headlineOcclusion, headlineLineOcclusion, frontTextOverSubject, maskRefinement } };
  }
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export interface TrackedReelComposer {
  readonly plan: TrackedReelPlan;
  readonly layout: TrackedReelResult["layout"];
  readonly endCardFallback: boolean;
  readonly endCard: TrackedEndCardReport;
  /** Source-to-output enlargement of the planned footage and freeze frames. */
  readonly footageUpscale: TrackedFootageUpscale;
  /**
   * Draws output frame `index`. Footage and freeze frames need the decoded footage frame named by
   * the plan (from the render clip when one was supplied, else the tracking clip) and the hero
   * mask for it (null when tracking was lost); still-depth frames ignore both.
   */
  draw(index: number, source: ClipFrame | null, mask: FrameMask | null): { rgba: Buffer; canvas: LedgerCanvas; stats: TrackedFrameStats };
}

function treatmentAt(frame: TrackedFramePlan, plan: TrackedReelPlan): number {
  if (frame.act !== "hook") return 1;
  const [start, end] = plan.acts.hook;
  return easeInOut(frame.actTime / Math.min(0.8, (end - start) / FPS * 0.5));
}

/** Enlargement of every planned footage/freeze crop when drawn from a sourceWidth×sourceHeight frame. */
function measureUpscale(plan: TrackedReelPlan, source: TrackedFootageUpscale["source"], sourceWidth: number, sourceHeight: number, k: { x: number; y: number }): TrackedFootageUpscale {
  const factors = plan.frames.filter((frame) => frame.crop).map((frame) => Math.max(W / (frame.crop!.width * k.x), H / (frame.crop!.height * k.y)));
  const round = (value: number) => Number(value.toFixed(3));
  return {
    source, sourceWidth, sourceHeight,
    max: round(factors.length ? Math.max(...factors) : 0),
    mean: round(factors.length ? factors.reduce((sum, value) => sum + value, 0) / factors.length : 0),
    framesOverLimit: factors.filter((value) => value > MAX_FOOTAGE_UPSCALE).length,
  };
}

/** Footage frames of the input: the render clip when supplied, else the tracking clip. */
function footageFrames(input: TrackedReelInput, fromFrame: number, toFrame: number): AsyncGenerator<ClipFrame, void, undefined> {
  return input.renderClip ? readRenderClipFrames(input.renderClip, { fromFrame, toFrame }) : readClipFrames(input.clip, { fromFrame, toFrame });
}

/** Only this module's and the encoder's fixed-message errors leave the public entry points. */
function fixedError(error: unknown): Error {
  return error instanceof TrackedCinemaError || error instanceof CinemaEncodeError ? error : new TrackedCinemaError("The tracked Reel could not be composed.");
}

/** Validates the input, plans the Reel and lays out every graphic once; frames are then drawn on demand. */
export async function prepareTrackedReel(input: TrackedReelInput): Promise<TrackedReelComposer> {
  try { return await composeTrackedReel(input); }
  catch (error) { throw fixedError(error); }
}

async function composeTrackedReel(input: TrackedReelInput): Promise<TrackedReelComposer> {
  const parsed = parseInput(input);
  const hero = parsed.reader.set.objects.find((object) => object.objectId === parsed.heroObjectId);
  if (!hero) throw new TrackedCinemaError("The hero object is not part of this masklet set.");
  let still: StillDepthComposer | null = null, endCardFallback = false;
  const footageLength = parsed.window ? parsed.window.toFrame - parsed.window.fromFrame + 1 : parsed.clip.frameCount;
  const stillLabel = cleanText(parsed.endCard?.provenanceLabel ?? "", 64);
  if (parsed.endCard && footageLength >= MIN_TRACKED_FOOTAGE_FRAMES && footageLength < TRACKED_REEL_FRAMES) {
    try {
      still = await prepareStillDepth({
        source: parsed.endCard.source, subjectMask: parsed.endCard.subjectMask, scenes: parsed.scenes, cta: parsed.cta, businessName: parsed.businessName,
        campaignName: parsed.campaignName, mode: parsed.mode, provenanceLabel: stillLabel, theme: parsed.theme, outputPath: parsed.outputPath, coverPath: parsed.coverPath,
      });
    } catch {
      // Any failure of the optional owner-still end card (invalid still, empty mask, undecodable
      // bytes) falls back to the footage freeze and is reported as end_card_fallback.
      endCardFallback = true;
    }
  }
  const plan = planTrackedReel(parsed.reader.set, parsed.heroObjectId, { window: parsed.window, endCard: still ? "still_depth" : "freeze" });
  const calloutText = cleanText(parsed.callout ?? hero.label, 48) || "Tracked subject";
  const layout = await prepareLayout(parsed, plan, calloutText);
  const compositor = new FootageCompositor(layout.theme);
  const { width: clipWidth, height: clipHeight } = parsed.clip;
  const render = parsed.renderClip ?? null;
  const sourceWidth = render?.width ?? clipWidth, sourceHeight = render?.height ?? clipHeight;
  const k = render ? { x: render.width / clipWidth, y: render.height / clipHeight } : null;
  const footageUpscale = measureUpscale(plan, render ? "render_clip" : "tracking_clip", sourceWidth, sourceHeight, k ?? { x: 1, y: 1 });

  const opsFor = (frame: TrackedFramePlan, maskPresent: boolean) => {
    const [start, end] = plan.acts[frame.act];
    const length = (end - start) / FPS;
    const behind: DrawOp[] = [], front: DrawOp[] = [];
    for (const item of layout.acts[frame.act]) {
      if (!item.g) continue;
      const { opacity, dy } = itemMotion(item, frame.actTime, length);
      if (opacity <= 0) continue;
      (item.layer === "behind" ? behind : front).push({ g: item.g, dx: 0, dy, opacity, role: item.role, lines: item.lines });
    }
    // The callout follows the smoothed track; it is hidden whenever this frame has no hero mask.
    if (maskPresent && frame.crop && frame.box && frame.centroid && (frame.act === "proof" || frame.act === "value")) {
      const g = layout.callout.side === "above" ? layout.callout.above : layout.callout.below;
      const t = (frame.index - plan.acts.proof[0]) / FPS, remaining = (plan.acts.value[1] - frame.index) / FPS;
      const opacity = easeOut((t - 0.1) / 0.4) * clamp01(remaining / 0.2);
      if (g && opacity > 0) {
        const s = H / frame.crop.height, totalHeight = CALLOUT_HEIGHT + CALLOUT_POINTER * 2;
        const ax = (frame.centroid.x - frame.crop.x) * s;
        const y = layout.callout.side === "above" ? (frame.box.top - frame.crop.y) * s - CALLOUT_GAP - totalHeight : (frame.box.bottom - frame.crop.y) * s + CALLOUT_GAP;
        const left = clamp(ax - layout.callout.width / 2, CALLOUT_SAFE.left, CALLOUT_SAFE.right - layout.callout.width);
        const top = clamp(y, CALLOUT_SAFE.top, CALLOUT_SAFE.bottom - totalHeight);
        front.push({ g, dx: Math.round(left - g.x), dy: Math.round(top - g.y), opacity });
      }
    }
    return { behind, front };
  };

  const endCard: TrackedEndCardReport = plan.endCard.kind === "still_depth"
    ? { source: "owner_still", provenanceLabel: still!.layout.provenanceLabel, stillDepthLayout: still!.layout }
    : plan.endCard.kind === "freeze" ? { source: "footage_freeze", provenanceLabel: layout.provenanceLabel, stillDepthLayout: null }
      : { source: "none", provenanceLabel: null, stillDepthLayout: null };
  return {
    plan,
    endCardFallback,
    endCard,
    footageUpscale,
    layout: {
      conceptLabel: layout.conceptLabel, provenanceLabel: layout.provenanceLabel, calloutLabel: layout.callout.text, calloutSide: layout.callout.side, truncatedText: layout.truncated,
      hookHeadline: layout.hookHeadline, valueHeadline: layout.valueHeadline, textContrast: layout.textContrast,
    },
    draw(index, source, mask) {
      if (!Number.isInteger(index) || index < 0 || index >= TRACKED_REEL_FRAMES) throw new TrackedCinemaError("Frame index is outside the Reel.");
      const frame = plan.frames[index];
      if (frame.kind === "still_depth") {
        const k = frame.endCardFrame!;
        return { rgba: still!.renderFrame(k), canvas: still!.analyzeFrame(k), stats: { maskPresent: true, headlineOcclusion: null, headlineLineOcclusion: null, frontTextOverSubject: null, maskRefinement: null } };
      }
      if (!source || source.frame !== frame.sourceFrame || source.width !== sourceWidth || source.height !== sourceHeight || source.rgba.length !== sourceWidth * sourceHeight * 4) {
        throw new TrackedCinemaError("A decoded footage frame does not match the plan.");
      }
      if (mask) {
        const { left, top, right, bottom } = mask.bounds;
        if (mask.objectId !== parsed.heroObjectId || mask.frame !== frame.sourceFrame || left < 0 || top < 0 || right > clipWidth || bottom > clipHeight || right <= left || bottom <= top
          || mask.raster.length !== (right - left) * (bottom - top)) throw new TrackedCinemaError("A hero mask does not match its footage frame.");
      }
      const { behind, front } = opsFor(frame, Boolean(mask));
      return compositor.compose(source, k, mask, frame.crop!, treatmentAt(frame, plan), behind, front, frame.wash, layout.chrome);
    },
  };
}

/**
 * Renders one output frame (straight RGBA 1080×1920) for previews and tests, reading only the
 * single clip frame and mask it needs.
 */
export async function renderTrackedReelFrame(input: TrackedReelInput, index: number): Promise<{ rgba: Buffer; frame: TrackedFramePlan; stats: TrackedFrameStats }> {
  if (!Number.isInteger(index) || index < 0 || index >= TRACKED_REEL_FRAMES) throw new TrackedCinemaError("Frame index is outside the Reel.");
  try {
    const composer = await composeTrackedReel(input);
    const frame = composer.plan.frames[index];
    let source: ClipFrame | null = null, mask: FrameMask | null = null;
    if (frame.sourceFrame !== null) {
      for await (const decoded of footageFrames(input, frame.sourceFrame, frame.sourceFrame)) source = decoded;
      mask = await input.reader.frameMask(input.heroObjectId, frame.sourceFrame);
    }
    const { rgba, stats } = composer.draw(index, source, mask);
    return { rgba, frame, stats };
  } catch (error) { throw fixedError(error); }
}

function temporarySibling(path: string): string {
  return join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.partial`);
}

/**
 * Renders the 12 s tracked Reel and its cover by streaming the footage window once. The ledger is
 * accumulated from the exact frames that were encoded. Errors are fixed strings without local paths.
 *
 * Output pairing: the new cover is staged beside its final path and moved into place only after the
 * MP4 has been verified and placed; if that move fails the new MP4 is removed. A failed render
 * therefore leaves any previous cover/MP4 pair untouched and never pairs a new file with an old one.
 */
export async function renderTrackedReel(input: TrackedReelInput, options: { timeoutMs?: number } = {}): Promise<TrackedReelResult> {
  const composer = await prepareTrackedReel(input);
  const parsed = parseInput(input);
  const { plan } = composer;
  const stagedCover = temporarySibling(parsed.coverPath);
  try {
    await mkdir(dirname(parsed.outputPath), { recursive: true });
    await mkdir(dirname(parsed.coverPath), { recursive: true });
  } catch { throw new TrackedCinemaError("The Reel output location could not be prepared.") }
  const encoder = openH264Encoder({ outputPath: parsed.outputPath, width: W, height: H, fps: FPS, expectedFrames: TRACKED_REEL_FRAMES, timeoutMs: options.timeoutMs ?? 420_000 });
  const ledger = new CompositionLedgerAccumulator();
  let coverPng: Buffer | null = null, missingMasks = 0;
  const occlusions: number[] = [], lineOcclusions: number[] = [], frontText: number[] = [];
  const refinement = { edgeSigma: { min: 0, max: 0 }, framesRefined: 0, framesWithSpecksRemoved: 0, framesWithHolesFilled: 0, removedPixels: 0, filledPixels: 0 };
  let held: { source: ClipFrame; mask: FrameMask | null } | null = null;
  const emit = async (index: number, source: ClipFrame | null, mask: FrameMask | null) => {
    const { rgba, canvas, stats } = composer.draw(index, source, mask);
    const written = encoder.writeFrame(rgba);
    // Observed below; this only prevents an unhandled rejection if the ledger throws first.
    written.catch(() => undefined);
    ledger.addFrame(canvas);
    if (stats.headlineOcclusion !== null) occlusions.push(stats.headlineOcclusion);
    if (stats.headlineLineOcclusion !== null) lineOcclusions.push(stats.headlineLineOcclusion);
    if (stats.frontTextOverSubject !== null) frontText.push(stats.frontTextOverSubject);
    if (stats.maskRefinement) {
      const sigma = Number(stats.maskRefinement.edgeSigma.toFixed(3));
      refinement.edgeSigma = refinement.framesRefined ? { min: Math.min(refinement.edgeSigma.min, sigma), max: Math.max(refinement.edgeSigma.max, sigma) } : { min: sigma, max: sigma };
      refinement.framesRefined++;
      if (stats.maskRefinement.removedPixels) { refinement.framesWithSpecksRemoved++; refinement.removedPixels += stats.maskRefinement.removedPixels; }
      if (stats.maskRefinement.filledPixels) { refinement.framesWithHolesFilled++; refinement.filledPixels += stats.maskRefinement.filledPixels; }
    }
    if (index === TRACKED_COVER_FRAME) coverPng = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
    await written;
  };
  let reel, finished: CompositionLedger;
  try {
    let index = 0;
    const from = plan.window.fromFrame;
    for await (const source of footageFrames(parsed, from, from + plan.footageFrames - 1)) {
      if (index >= plan.footageFrames) throw new TrackedCinemaError("The footage stream did not match the plan.");
      const mask = await parsed.reader.frameMask(parsed.heroObjectId, source.frame);
      if (!mask) missingMasks++;
      if (source.frame === plan.bestFrame) held = { source, mask };
      await emit(index, source, mask);
      index++;
    }
    if (index !== plan.footageFrames) throw new TrackedCinemaError("The footage stream did not match the plan.");
    for (; index < TRACKED_REEL_FRAMES; index++) {
      const kind = plan.frames[index].kind;
      if (kind === "freeze" && !held?.mask) throw new TrackedCinemaError("The frozen end-card frame has no hero mask.");
      await emit(index, kind === "freeze" ? held!.source : null, kind === "freeze" ? held!.mask : null);
    }
    finished = ledger.finish();
    try { await writeFile(stagedCover, coverPng!, { flag: "wx" }); }
    catch { throw new TrackedCinemaError("The Reel cover could not be written.") }
    reel = await encoder.finish();
  } catch (error) {
    await encoder.abort();
    await rm(stagedCover, { force: true }).catch(() => undefined);
    throw fixedError(error);
  }
  try { await rename(stagedCover, parsed.coverPath); }
  catch {
    // The verified MP4 is already in place; without its new cover it must not stay.
    await rm(stagedCover, { force: true }).catch(() => undefined);
    await rm(parsed.outputPath, { force: true }).catch(() => undefined);
    throw new TrackedCinemaError("The Reel cover could not be written.");
  }
  const violations: TrackedReelViolation[] = [];
  const headlineMean = occlusions.length ? occlusions.reduce((sum, value) => sum + value, 0) / occlusions.length : 0;
  const headlineMax = occlusions.length ? Math.max(...occlusions) : 0, headlineLineMax = lineOcclusions.length ? Math.max(...lineOcclusions) : 0;
  if (finished.maxSubjectOcclusion > MAX_FOREGROUND_OCCLUSION) violations.push("foreground_occlusion");
  if (finished.framesWithoutSubject > TRACKED_REEL_FRAMES * 0.1) violations.push("subject_missing");
  if (missingMasks > 0) violations.push("tracking_lost");
  if (finished.framesSubjectCropped > TRACKED_REEL_FRAMES * 0.1) violations.push("subject_cropped");
  // Fail closed on single frames, not only on average: one frame hiding a word is an illegible hook.
  if (headlineMean > MAX_TRACKED_HEADLINE_OCCLUSION || headlineMax > MAX_HEADLINE_OCCLUSION + HEADLINE_MEASURE_TOLERANCE
    || headlineLineMax > MAX_HEADLINE_LINE_OCCLUSION + HEADLINE_MEASURE_TOLERANCE) violations.push("headline_hidden");
  if (composer.endCardFallback) violations.push("end_card_fallback");
  const drawnFootage = plan.frames.filter((frame) => frame.crop).length;
  if (composer.footageUpscale.framesOverLimit > drawnFootage * 0.1) violations.push("low_resolution_footage");
  return {
    reel: { sha256: reel.sha256, bytes: reel.bytes, frames: reel.frames, durationSeconds: reel.durationSeconds, width: W, height: H, fps: FPS },
    cover: { sha256: createHash("sha256").update(coverPng!).digest("hex"), bytes: coverPng!.length, width: W, height: H, frame: TRACKED_COVER_FRAME },
    ledger: finished,
    timeline: { window: plan.window, footageFrames: plan.footageFrames, acts: plan.acts, endCard: plan.endCard, bestFrame: plan.bestFrame },
    layout: composer.layout,
    endCard: composer.endCard,
    qa: {
      violations, framesSubjectHiddenByTransition: ledger.framesSubjectHiddenByTransition, footageFramesWithoutMask: missingMasks,
      headlineOcclusion: { mean: Number(headlineMean.toFixed(4)), max: Number(headlineMax.toFixed(4)), lineMax: Number(headlineLineMax.toFixed(4)) },
      frontTextOverSubject: {
        mean: Number((frontText.length ? frontText.reduce((sum, value) => sum + value, 0) / frontText.length : 0).toFixed(4)),
        max: Number((frontText.length ? Math.max(...frontText) : 0).toFixed(4)),
      },
      footageUpscale: composer.footageUpscale,
      maskRefinement: refinement,
    },
  };
}
