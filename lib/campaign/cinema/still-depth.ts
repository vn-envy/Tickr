import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { CompositionLedger } from "../../media/cinema-types";
import { REEL_DURATION_SECONDS, REEL_FPS, REEL_HEIGHT, REEL_WIDTH } from "../../rendering/reel-contract";
import { CinemaEncodeError, openH264Encoder } from "./encode";
import { dilateMask, fillBehindSubject, gaussianBlurZero, squaredDistanceTransform } from "./fill";
import { CompositionLedgerAccumulator, LedgerCanvas, type LedgerLayerClass } from "./ledger";
import { refineMaskAlpha, type MaskRefinementReport } from "./mask-refine";
import { cleanText, pill, svgDocument, textBlock, type Bounds, type FontFace, type TextBlock } from "./typography";

/**
 * Local cinematic "depth" Reel from one still photo and its SAM subject mask.
 *
 * Pixel provenance is structural: the subject layer is only ever the resized cutout
 * (source RGB × mask alpha) — it is never blurred, recoloured or generated. The
 * compositing alpha is the SAM mask after a deterministic alpha-only refinement (specks dropped,
 * pin-holes filled, ragged edges smoothed to a ~1 px anti-aliased ramp; see mask-refine.ts); the
 * supplied mask itself is never modified, and the refinement is reported in the layout. The
 * background is the same photo with the subject area filled from surrounding
 * background pixels (normalized convolution), then blurred/darkened, or an optional
 * generated Muse plate that always sits underneath the subject. Typography is local
 * SVG. Every frame is replayed at reduced resolution into a CompositionLedger.
 *
 * Output contract matches the existing Reel: 1080×1920, 30 fps, H.264, 360 frames,
 * 12.0 s, no audio, plus a 1080×1920 PNG cover. Nothing here calls a network service.
 */

const W = REEL_WIDTH, H = REEL_HEIGHT, FPS = REEL_FPS;
export const STILL_DEPTH_FRAMES = REEL_DURATION_SECONDS * REEL_FPS;
const SCENE_FRAMES = STILL_DEPTH_FRAMES / 4;
/** Ledger and layout analysis run at 1/4 resolution (270×480). */
export const LEDGER_FACTOR = 4;
const LW = W / LEDGER_FACTOR, LH = H / LEDGER_FACTOR;
/** Background plates extend this far beyond the base window to allow parallax. */
const PLATE_MARGIN = 120;
const SIDE = 64;
/** The frame index used for the cover PNG (2.0 s into the hook, after the treatment settles). */
export const STILL_DEPTH_COVER_FRAME = 60;
/**
 * Maximum share of a depth headline's glyph area the subject may cover in ANY single frame where the
 * headline is visible (its subject moves: the hook zoom here, the tracked footage in tracked.ts).
 */
export const MAX_HEADLINE_OCCLUSION = 0.25;
/** Maximum share of any single headline line the subject may cover in any single visible frame (a hidden word reads as a typo). */
export const MAX_HEADLINE_LINE_OCCLUSION = 0.2;
/** A depth headline counts as visible (and its occlusion is checked) from this opacity on. */
export const HEADLINE_VISIBLE_OPACITY = 0.25;
/** Maximum share of the subject that foreground graphics (text, chips) may hide. */
export const MAX_FOREGROUND_OCCLUSION = 0.10;
/** Appended to the provenance chip whenever a generated backdrop is composited and the caller's label does not say so. */
export const GENERATED_BACKDROP_LABEL = "AI backdrop";
const GENERATED_MARKER = /\b(generated|ai backdrop)\b/i;
/** Hook depth-headline search: sizes, subject pull-back scales, side-column width and the hook's slow zoom. */
const HOOK_SIZES = [178, 150, 124, 104, 88] as const;
const HOOK_PULLBACK = [1, 0.88, 0.76, 0.64, 0.54] as const;
const HOOK_SIDE_COLUMN = Math.round(W * 0.58);
const HOOK_ZOOM = 1.06;
/** The hook headline's entrance: it rises this many output pixels while fading in. */
const HOOK_HEADLINE_RISE = 44;
/** Ledger rows the hook headline still sits below its final place once it is visible (HEADLINE_VISIBLE_OPACITY). */
const HOOK_HEADLINE_VISIBLE_RISE_CELLS = Math.ceil((1 - HEADLINE_VISIBLE_OPACITY) * HOOK_HEADLINE_RISE / LEDGER_FACTOR);
/** Rows occupied by the concept (top) and provenance (bottom) chips in every frame. */
export const STILL_DEPTH_LABEL_BANDS = { top: { top: 44, bottom: 96 }, bottom: { top: H - 96, bottom: H - 44 } } as const;
/** Transition windows [start, end) in frames. */
export const STILL_DEPTH_TRANSITIONS = {
  silhouetteWipe: [SCENE_FRAMES - 6, SCENE_FRAMES + 6],
  motionSlide: [2 * SCENE_FRAMES - 6, 2 * SCENE_FRAMES + 6],
  accentFade: [3 * SCENE_FRAMES - 7, 3 * SCENE_FRAMES + 7],
} as const;

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const bytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array && value.length > 8 && value.length <= MAX_INPUT_BYTES, { message: "Invalid image bytes." });
const line = (max: number, min = 0) => z.string().max(max * 4).refine((value) => { const length = Array.from(value.trim()).length; return length >= min && length <= max; });
const sceneSchema = z.strictObject({ headline: line(140, 1), body: line(320), kicker: line(60) });
const inputSchema = z.strictObject({
  source: bytes,
  subjectMask: bytes,
  backdrop: bytes.optional(),
  scenes: z.array(sceneSchema).length(4),
  cta: line(48, 1),
  businessName: line(100, 1),
  campaignName: line(140, 1),
  mode: z.enum(["live", "synthetic"]),
  provenanceLabel: line(64, 1),
  theme: z.strictObject({ paper: hex, ink: hex, accent: hex, soft: hex }),
  outputPath: z.string().max(4096).refine((value) => isAbsolute(value) && /\.mp4$/i.test(value)),
  coverPath: z.string().max(4096).refine((value) => isAbsolute(value) && /\.png$/i.test(value)),
});

export interface StillDepthScene { headline: string; body: string; kicker: string }
export interface StillDepthTheme { paper: string; ink: string; accent: string; soft: string }
export interface StillDepthInput {
  /** PNG of the real photo. */
  source: Uint8Array;
  /** PNG, same dimensions, subject 255 / background 0 (thresholded at 128). */
  subjectMask: Uint8Array;
  /** Optional generated Muse plate (PNG). Labelled generated; never placed on the subject. */
  backdrop?: Uint8Array;
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
}

export interface StillDepthLayoutReport {
  hookHeadline: {
    placement: "behind_subject" | "in_front";
    /**
     * Worst share of the headline's glyph area covered by the subject in any visible hook frame
     * (≤ MAX_HEADLINE_OCCLUSION behind; 0 in front): measured against the subject's extent over its
     * whole hook zoom and the headline's whole visible rise.
     */
    occlusion: number;
    /** Worst share of any single line covered in any visible hook frame (≤ MAX_HEADLINE_LINE_OCCLUSION behind; 0 in front). */
    lineOcclusion: number;
    /** Share of the subject hidden by the headline itself (0 behind; the in-front fallback is measured here). */
    foregroundOcclusion: number;
    fontSize: number;
    top: number;
    /** Text column: full width, or a narrower column on one side of the subject. */
    column: "full" | "left" | "right";
    /** Hook start scale of the real subject (1 = the photo's own framing; < 1 pulls back to free headline room). */
    subjectScale: number;
  };
  /** Worst-case subject share hidden by foreground graphics, per scene (layout-time estimate). */
  foregroundOcclusion: [number, number, number, number];
  valueSubjectSide: "left" | "right";
  truncatedText: string[];
  usesGeneratedBackdrop: boolean;
  /** The provenance chip text as rendered (before upper-casing) on every frame. */
  provenanceLabel: string;
  /** The concept chip text rendered on every frame. */
  conceptLabel: string;
  /** Alpha-only refinement applied to the supplied SAM mask for compositing (the mask itself is unchanged). */
  subjectMask: MaskRefinementReport;
}

/**
 * Review flags a caller must surface or act on (withhold / re-render) — never silently drop:
 * - foreground_occlusion: some frame hides more than MAX_FOREGROUND_OCCLUSION of the subject.
 * - headline_in_front: no placement kept the hook headline behind the subject.
 * - subject_missing: some frames have no visible subject outside deliberate transition washes.
 */
export type StillDepthViolation = "foreground_occlusion" | "headline_in_front" | "subject_missing";

export interface StillDepthResult {
  reel: { sha256: string; bytes: number; frames: number; durationSeconds: number; width: number; height: number; fps: number };
  cover: { sha256: string; bytes: number; width: number; height: number; frame: number };
  ledger: CompositionLedger;
  layout: StillDepthLayoutReport;
  qa: { violations: StillDepthViolation[]; framesSubjectHiddenByTransition: number };
}

export class StillDepthError extends Error {
  constructor(message: string) { super(message); this.name = "StillDepthError"; }
}

// ---------------------------------------------------------------------------
// Geometry and rasters
// ---------------------------------------------------------------------------

/** Base output space: the source scaled to cover 1080×1920 and cropped around the subject. */
interface Placement { k: number; ax: number; ay: number; dx: number; dy: number }
interface Xform { sx: number; sy: number; tx: number; ty: number }
type Clip = readonly [number, number];
const FULL: Clip = [0, W];

/** Raster positioned in base output space: raster px = (base px − o) · scale. */
interface Positioned { width: number; height: number; ox: number; oy: number; scaleX: number; scaleY: number }
interface RgbRaster extends Positioned { data: Uint8Array }
/** Premultiplied RGBA (colour 0–255 × alpha, alpha 0–1) or a single alpha channel. */
interface AlphaRaster extends Positioned { data: Float32Array; stride: number; offset: number; alphaSum: number }

function xform(raster: Positioned, p: Placement): Xform {
  return { sx: p.k / raster.scaleX, sy: p.k / raster.scaleY, tx: p.k * (raster.ox - p.ax) + p.ax + p.dx, ty: p.k * (raster.oy - p.ay) + p.ay + p.dy };
}

function shifted(p: Placement, dx: number, dy = 0): Placement { return { ...p, dx: p.dx + dx, dy: p.dy + dy } }

/** Additional uniform scale g about an output-space point. */
function scaleAbout(p: Placement, g: number, px: number, py: number): Placement {
  return { k: p.k * g, ax: p.ax, ay: p.ay, dx: g * (p.ax + p.dx - px) + px - p.ax, dy: g * (p.ay + p.dy - py) + py - p.ay };
}

function apply(p: Placement, x: number, y: number): [number, number] { return [p.k * (x - p.ax) + p.ax + p.dx, p.k * (y - p.ay) + p.ay + p.dy] }

/** Grows scale and clamps translation so the whole frame samples inside the raster's extent. */
function fitPlacement(p: Placement, raster: Positioned): Placement {
  const ex0 = raster.ox + 1, ey0 = raster.oy + 1;
  const ex1 = raster.ox + raster.width / raster.scaleX - 1, ey1 = raster.oy + raster.height / raster.scaleY - 1;
  const k = Math.max(p.k, W / Math.max(1, ex1 - ex0), H / Math.max(1, ey1 - ey0));
  const clamp = (value: number, low: number, high: number) => low > high ? (low + high) / 2 : Math.min(high, Math.max(low, value));
  const dx = clamp(p.dx, W - p.ax - k * (ex1 - p.ax), k * (p.ax - ex0) - p.ax);
  const dy = clamp(p.dy, H - p.ay - k * (ey1 - p.ay), k * (p.ay - ey0) - p.ay);
  return { k, ax: p.ax, ay: p.ay, dx, dy };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeInOut = (value: number) => { const v = clamp01(value); return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2 };
const easeOut = (value: number) => 1 - (1 - clamp01(value)) ** 3;
const smoothstep = (a: number, b: number, value: number) => { const v = clamp01((value - a) / (b - a)); return v * v * (3 - 2 * v) };
function appear(t: number, start: number, duration = 0.55, rise = 34): { opacity: number; dy: number } {
  const e = easeOut((t - start) / duration);
  return { opacity: e, dy: Math.round((1 - e) * rise) };
}

// ---------------------------------------------------------------------------
// Sampling and compositing kernels
// ---------------------------------------------------------------------------

/** Column lookup for bilinear sampling with edge clamping (opaque plates). */
function clampedAxis(count: number, start: number, scale: number, translate: number, size: number, factor: number): { index: Int32Array; frac: Float32Array } {
  const index = new Int32Array(count), frac = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let u = (((start + i) + 0.5) * factor - translate) / scale - 0.5;
    u = Math.min(size - 1, Math.max(0, u));
    const i0 = Math.min(size - 2, Math.floor(u));
    index[i] = Math.max(0, i0); frac[i] = size === 1 ? 0 : u - Math.max(0, i0);
  }
  return { index, frac };
}

/** Opaque RGB plate, bilinear with clamped edges, blended at `opacity`. */
function drawPlatePixels(dst: Float32Array, raster: RgbRaster, t: Xform, opacity: number, clip: Clip): void {
  const [x0, x1] = clip;
  if (x1 <= x0 || opacity <= 0) return;
  const cols = clampedAxis(x1 - x0, x0, t.sx, t.tx, raster.width, 1);
  const rows = clampedAxis(H, 0, t.sy, t.ty, raster.height, 1);
  const data = raster.data, rowStride = raster.width * 3, step = raster.width > 1 ? 3 : 0;
  const nextRow = raster.height > 1 ? rowStride : 0;
  const identity = Math.abs(t.sx - 1) < 1e-9 && Math.abs(t.sy - 1) < 1e-9 && Number.isInteger(t.tx) && Number.isInteger(t.ty);
  for (let y = 0; y < H; y++) {
    const r0 = rows.index[y] * rowStride, fy = rows.frac[y];
    let o = (y * W + x0) * 3;
    for (let i = 0; i < x1 - x0; i++, o += 3) {
      const a = r0 + cols.index[i] * 3, fx = cols.frac[i];
      let r: number, g: number, b: number;
      if (identity && fx === 0 && fy === 0) { r = data[a]; g = data[a + 1]; b = data[a + 2]; }
      else {
        const c = a + nextRow;
        const t0r = data[a] + (data[a + step] - data[a]) * fx, t1r = data[c] + (data[c + step] - data[c]) * fx;
        const t0g = data[a + 1] + (data[a + step + 1] - data[a + 1]) * fx, t1g = data[c + 1] + (data[c + step + 1] - data[c + 1]) * fx;
        const t0b = data[a + 2] + (data[a + step + 2] - data[a + 2]) * fx, t1b = data[c + 2] + (data[c + step + 2] - data[c + 2]) * fx;
        r = t0r + (t1r - t0r) * fy; g = t0g + (t1g - t0g) * fy; b = t0b + (t1b - t0b) * fy;
      }
      if (opacity >= 1) { dst[o] = r; dst[o + 1] = g; dst[o + 2] = b; }
      else { dst[o] += (r - dst[o]) * opacity; dst[o + 1] += (g - dst[o + 1]) * opacity; dst[o + 2] += (b - dst[o + 2]) * opacity; }
    }
  }
}

/** Output-space bounds touched by a positioned raster under a transform, intersected with the clip. */
function footprint(raster: Positioned, t: Xform, clip: Clip, factor: number, width: number, height: number): [number, number, number, number] | null {
  const left = Math.floor((t.tx - t.sx) / factor) - 1, right = Math.ceil((t.tx + t.sx * (raster.width + 1)) / factor) + 1;
  const top = Math.floor((t.ty - t.sy) / factor) - 1, bottom = Math.ceil((t.ty + t.sy * (raster.height + 1)) / factor) + 1;
  const x0 = Math.max(left, Math.floor(clip[0] / factor), 0), x1 = Math.min(right, Math.ceil(clip[1] / factor), width);
  const y0 = Math.max(top, 0), y1 = Math.min(bottom, height);
  return x1 > x0 && y1 > y0 ? [x0, x1, y0, y1] : null;
}

/**
 * Bilinear sample of a premultiplied raster with transparent (zero) outside.
 * Calls `visit(outputIndex, a, r, g, b)` for every covered output pixel at `factor` resolution.
 */
function sampleRaster(raster: AlphaRaster, t: Xform, clip: Clip, factor: number, width: number, height: number, colour: boolean, visit: (index: number, a: number, r: number, g: number, b: number) => void): void {
  const box = footprint(raster, t, clip, factor, width, height);
  if (!box) return;
  const [x0, x1, y0, y1] = box;
  const { data, stride, offset, width: rw, height: rh } = raster;
  for (let y = y0; y < y1; y++) {
    const v = ((y + 0.5) * factor - t.ty) / t.sy - 0.5;
    const j0 = Math.floor(v), fy = v - j0;
    const row0 = j0 >= 0 && j0 < rh, row1 = j0 + 1 >= 0 && j0 + 1 < rh;
    if (!row0 && !row1) continue;
    for (let x = x0; x < x1; x++) {
      const u = ((x + 0.5) * factor - t.tx) / t.sx - 0.5;
      const i0 = Math.floor(u), fx = u - i0;
      const col0 = i0 >= 0 && i0 < rw, col1 = i0 + 1 >= 0 && i0 + 1 < rw;
      if (!col0 && !col1) continue;
      const w00 = row0 && col0 ? (1 - fx) * (1 - fy) : 0, w10 = row0 && col1 ? fx * (1 - fy) : 0;
      const w01 = row1 && col0 ? (1 - fx) * fy : 0, w11 = row1 && col1 ? fx * fy : 0;
      const p00 = (j0 * rw + i0) * stride, p10 = p00 + stride, p01 = p00 + rw * stride, p11 = p01 + stride;
      const a = (w00 ? data[p00 + offset] * w00 : 0) + (w10 ? data[p10 + offset] * w10 : 0) + (w01 ? data[p01 + offset] * w01 : 0) + (w11 ? data[p11 + offset] * w11 : 0);
      if (a <= 1e-5) continue;
      if (!colour) { visit(y * width + x, a, 0, 0, 0); continue; }
      let r = 0, g = 0, b = 0;
      if (w00) { r += data[p00] * w00; g += data[p00 + 1] * w00; b += data[p00 + 2] * w00; }
      if (w10) { r += data[p10] * w10; g += data[p10 + 1] * w10; b += data[p10 + 2] * w10; }
      if (w01) { r += data[p01] * w01; g += data[p01 + 1] * w01; b += data[p01 + 2] * w01; }
      if (w11) { r += data[p11] * w11; g += data[p11 + 1] * w11; b += data[p11 + 2] * w11; }
      visit(y * width + x, a, r, g, b);
    }
  }
}

function alphaMap(raster: AlphaRaster, t: Xform, clip: Clip, factor: number, width: number, height: number, out = new Float32Array(width * height)): Float32Array {
  out.fill(0);
  sampleRaster(raster, t, clip, factor, width, height, false, (index, a) => { out[index] = Math.min(1, a); });
  return out;
}

/** A pre-rendered local SVG graphic: premultiplied RGBA crop plus a ledger-resolution alpha map. */
interface Graphic { x: number; y: number; width: number; height: number; data: Float32Array; reduced: Float32Array }

function drawGraphicPixels(dst: Float32Array, g: Graphic, dx: number, dy: number, opacity: number, clip: Clip): void {
  if (opacity <= 0) return;
  const left = g.x + dx, top = g.y + dy;
  const x0 = Math.max(left, clip[0], 0), x1 = Math.min(left + g.width, clip[1], W);
  const y0 = Math.max(top, 0), y1 = Math.min(top + g.height, H);
  for (let y = y0; y < y1; y++) {
    let s = ((y - top) * g.width + (x0 - left)) * 4;
    let o = (y * W + x0) * 3;
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

/** Horizontal box blur (two passes) used for the motion-blurred slide; edges clamp. */
function horizontalBlur(rgb: Float32Array, radius: number): void {
  const r = Math.round(radius);
  if (r < 1) return;
  const line = new Float32Array(W * 3);
  const scale = 1 / (2 * r + 1);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) {
      const base = y * W * 3;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += rgb[base + Math.min(W - 1, Math.max(0, i)) * 3 + c];
        for (let x = 0; x < W; x++) {
          line[x * 3 + c] = sum * scale;
          sum += rgb[base + Math.min(W - 1, x + r + 1) * 3 + c] - rgb[base + Math.max(0, x - r) * 3 + c];
        }
      }
      rgb.set(line, base);
    }
  }
}

// ---------------------------------------------------------------------------
// Surfaces: the same scene code drives full-resolution pixels and the ledger replay
// ---------------------------------------------------------------------------

interface Surface {
  plate(raster: RgbRaster, p: Placement, opacity: number, layerClass: "treated_source" | "generated", clip: Clip): void;
  graphic(g: Graphic | null, dx: number, dy: number, opacity: number, layerClass: "foreground_graphics" | "background_graphics", clip: Clip): void;
  subject(p: Placement, opacity: number, clip: Clip): void;
  shadow(p: Placement, opacity: number, clip: Clip): void;
  wash(rgb: readonly [number, number, number], amount: number): void;
  motionBlur(radius: number): void;
  mix(other: this, mask: AlphaRaster, p: Placement, floor: number): void;
}

type Prepared = Awaited<ReturnType<typeof prepareAssets>>;

function chooseLevel(levels: readonly AlphaRaster[], k: number, factor: number): AlphaRaster {
  // Smallest raster that still has at least one raster pixel per output sample.
  const needed = k / factor * 0.999;
  let chosen = levels[0];
  for (const level of levels) if (level.scaleX >= needed && level.scaleX <= chosen.scaleX) chosen = level;
  return chosen;
}

const SHADOW_OFFSET = 22;
/** Horizontal parallax amplitude of the subject in the value scene (output px). */
const VALUE_DRIFT = 36;

class PixelSurface implements Surface {
  readonly rgb = new Float32Array(W * H * 3);
  constructor(private readonly assets: Prepared) {}
  plate(raster: RgbRaster, p: Placement, opacity: number, _layerClass: string, clip: Clip) { drawPlatePixels(this.rgb, raster, xform(raster, p), opacity, clip) }
  graphic(g: Graphic | null, dx: number, dy: number, opacity: number, _layerClass: string, clip: Clip) { if (g) drawGraphicPixels(this.rgb, g, dx, dy, opacity, clip) }
  subject(p: Placement, opacity: number, clip: Clip) {
    if (opacity <= 0) return;
    const level = chooseLevel(this.assets.subjectLevels, p.k, 1);
    const dst = this.rgb;
    sampleRaster(level, xform(level, p), clip, 1, W, H, true, (index, a, r, g, b) => {
      const o = index * 3, keep = 1 - Math.min(1, a) * opacity;
      dst[o] = dst[o] * keep + r * opacity; dst[o + 1] = dst[o + 1] * keep + g * opacity; dst[o + 2] = dst[o + 2] * keep + b * opacity;
    });
  }
  shadow(p: Placement, opacity: number, clip: Clip) {
    if (opacity <= 0) return;
    const dst = this.rgb, shadow = this.assets.shadow;
    sampleRaster(shadow, xform(shadow, shifted(p, 0, SHADOW_OFFSET * p.k)), clip, 1, W, H, false, (index, a) => {
      const keep = 1 - Math.min(1, a) * opacity, o = index * 3;
      dst[o] *= keep; dst[o + 1] *= keep; dst[o + 2] *= keep;
    });
  }
  wash(rgb: readonly [number, number, number], amount: number) {
    if (amount <= 0) return;
    const a = clamp01(amount), dst = this.rgb;
    for (let i = 0; i < dst.length; i += 3) { dst[i] += (rgb[0] - dst[i]) * a; dst[i + 1] += (rgb[1] - dst[i + 1]) * a; dst[i + 2] += (rgb[2] - dst[i + 2]) * a; }
  }
  motionBlur(radius: number) { horizontalBlur(this.rgb, radius) }
  mix(other: PixelSurface, mask: AlphaRaster, p: Placement, floor: number) {
    const map = alphaMap(mask, xform(mask, p), FULL, 1, W, H);
    const a = this.rgb, b = other.rgb;
    for (let i = 0, o = 0; i < map.length; i++, o += 3) {
      const m = Math.max(map[i], floor);
      if (m <= 0) continue;
      a[o] += (b[o] - a[o]) * m; a[o + 1] += (b[o + 1] - a[o + 1]) * m; a[o + 2] += (b[o + 2] - a[o + 2]) * m;
    }
  }
  toRgba(): Buffer {
    const out = Buffer.allocUnsafe(W * H * 4);
    const src = this.rgb;
    for (let i = 0, o = 0; i < src.length; i += 3, o += 4) {
      out[o] = src[i] <= 0 ? 0 : src[i] >= 255 ? 255 : Math.round(src[i]);
      out[o + 1] = src[i + 1] <= 0 ? 0 : src[i + 1] >= 255 ? 255 : Math.round(src[i + 1]);
      out[o + 2] = src[i + 2] <= 0 ? 0 : src[i + 2] >= 255 ? 255 : Math.round(src[i + 2]);
      out[o + 3] = 255;
    }
    return out;
  }
}

class LedgerSurface implements Surface {
  readonly canvas = new LedgerCanvas(LW, LH);
  private readonly scratch = new Float32Array(LW * LH);
  constructor(private readonly assets: Prepared) {}
  private clipMap(clip: Clip, value: number): Float32Array {
    const map = this.scratch, x0 = Math.round(clip[0] / LEDGER_FACTOR), x1 = Math.round(clip[1] / LEDGER_FACTOR);
    map.fill(0);
    for (let y = 0; y < LH; y++) map.fill(value, y * LW + x0, y * LW + x1);
    return map;
  }
  plate(_raster: RgbRaster, _p: Placement, opacity: number, layerClass: LedgerLayerClass, clip: Clip) { this.canvas.over(layerClass, this.clipMap(clip, 1), clamp01(opacity)) }
  graphic(g: Graphic | null, dx: number, dy: number, opacity: number, layerClass: LedgerLayerClass, clip: Clip) {
    if (!g || opacity <= 0) return;
    const map = this.scratch, cx = Math.round(dx / LEDGER_FACTOR), cy = Math.round(dy / LEDGER_FACTOR);
    const x0 = Math.round(clip[0] / LEDGER_FACTOR), x1 = Math.round(clip[1] / LEDGER_FACTOR);
    map.fill(0);
    for (let y = Math.max(0, cy); y < Math.min(LH, LH + cy); y++) {
      for (let x = Math.max(x0, cx); x < Math.min(x1, LW + cx); x++) map[y * LW + x] = g.reduced[(y - cy) * LW + (x - cx)];
    }
    this.canvas.over(layerClass, map, clamp01(opacity));
  }
  subject(p: Placement, opacity: number, clip: Clip) {
    if (opacity <= 0) return;
    const level = chooseLevel(this.assets.subjectLevels, p.k, LEDGER_FACTOR);
    const t = xform(level, p);
    const map = alphaMap(level, t, clip, LEDGER_FACTOR, LW, LH, this.scratch);
    let inside = 0;
    for (let i = 0; i < map.length; i++) inside += map[i];
    this.canvas.addSubjectInstance({ insideArea: inside * LEDGER_FACTOR * LEDGER_FACTOR, totalArea: level.alphaSum * t.sx * t.sy });
    this.canvas.over("subject", map, clamp01(opacity));
  }
  shadow(p: Placement, opacity: number, clip: Clip) {
    if (opacity <= 0) return;
    const shadow = this.assets.shadow;
    this.canvas.over("background_graphics", alphaMap(shadow, xform(shadow, shifted(p, 0, SHADOW_OFFSET * p.k)), clip, LEDGER_FACTOR, LW, LH, this.scratch), clamp01(opacity));
  }
  wash(_rgb: readonly [number, number, number], amount: number) { if (amount > 0) this.canvas.over("transition", this.clipMap(FULL, 1), clamp01(amount)) }
  motionBlur() { /* Blur moves pixels sideways within the same layers; class weights are unchanged. */ }
  mix(other: LedgerSurface, mask: AlphaRaster, p: Placement, floor: number) {
    const map = alphaMap(mask, xform(mask, p), FULL, LEDGER_FACTOR, LW, LH);
    for (let i = 0; i < map.length; i++) map[i] = Math.max(map[i], floor);
    this.canvas.mix(other.canvas, map);
  }
}

// ---------------------------------------------------------------------------
// Input decoding and asset preparation
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function decodePng(bytes: Uint8Array, kind: "source" | "mask" | "backdrop", background: string): Promise<{ data: Buffer; width: number; height: number }> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new StillDepthError(`The ${kind} must be a PNG raster.`);
  try {
    const image = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", animated: false });
    const metadata = await image.metadata();
    if (metadata.format !== "png" || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height || metadata.width < 64 || metadata.height < 64) throw new Error("metadata");
    const pipeline = image.flatten({ background });
    const { data, info } = kind === "mask"
      ? await pipeline.greyscale().extractChannel(0).raw().toBuffer({ resolveWithObject: true })
      : await pipeline.removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== (kind === "mask" ? 1 : 3)) throw new Error("channels");
    return { data, width: info.width, height: info.height };
  } catch { throw new StillDepthError(`The ${kind} PNG could not be safely decoded.`); }
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

/** Readable colour tokens derived from the proposed theme; unreadable pairs fall back to neutrals. */
function tokens(theme: StillDepthTheme) {
  let light = luminance(theme.paper) >= luminance(theme.ink) ? theme.paper : theme.ink;
  let dark = light === theme.paper ? theme.ink : theme.paper;
  if (contrast(light, dark) < 4.5) { light = "#F6F2EA"; dark = "#1E2A2E"; }
  const accent = theme.accent;
  return {
    light, dark, accent,
    accentText: contrast(accent, light) >= contrast(accent, dark) ? light : dark,
    kickerOnDark: contrast(theme.soft, "#202020") >= 4.5 ? theme.soft : light,
    kickerOnLight: contrast(accent, light) >= 3 ? accent : dark,
    darkRgb: hexRgb(dark), accentRgb: hexRgb(accent),
  };
}

function premultiply(raw: Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = raw[i + 3] / 255;
    out[i] = raw[i] * a; out[i + 1] = raw[i + 1] * a; out[i + 2] = raw[i + 2] * a; out[i + 3] = a;
  }
  return out;
}

function sumAlpha(data: Float32Array, stride: number, offset: number): number {
  let sum = 0;
  for (let i = offset; i < data.length; i += stride) sum += data[i];
  return sum;
}

async function renderGraphic(body: string, defs = ""): Promise<Graphic | null> {
  if (!body.trim()) return null;
  const { data, info } = await sharp(Buffer.from(svgDocument(W, H, body, defs))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== W || info.height !== H || info.channels !== 4) throw new StillDepthError("A typography layer could not be rendered.");
  let left = W, right = -1, top = H, bottom = -1;
  const reduced = new Float32Array(LW * LH);
  const cell = 1 / (LEDGER_FACTOR * LEDGER_FACTOR * 255);
  for (let y = 0; y < H; y++) {
    const rowCell = Math.floor(y / LEDGER_FACTOR) * LW;
    for (let x = 0; x < W; x++) {
      const a = data[(y * W + x) * 4 + 3];
      if (!a) continue;
      if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
      reduced[rowCell + Math.floor(x / LEDGER_FACTOR)] += a * cell;
    }
  }
  if (right < 0) return null;
  const width = right - left + 1, height = bottom - top + 1;
  const crop = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y++) data.copy(crop, y * width * 4, ((top + y) * W + left) * 4, ((top + y) * W + left + width) * 4);
  return { x: left, y: top, width, height, data: premultiply(crop, width, height), reduced };
}

/** Edge smoothing for a still's SAM mask: about 1 px per 900 px of the long side (0.8–2 px). */
export function stillMaskSigma(width: number, height: number): number {
  return Math.min(2, Math.max(0.8, Math.max(width, height) / 900));
}

async function prepareAssets(input: StillDepthInput) {
  const theme = tokens(input.theme);
  const source = await decodePng(input.source, "source", theme.dark);
  const maskImage = await decodePng(input.subjectMask, "mask", "#000000");
  if (maskImage.width !== source.width || maskImage.height !== source.height) throw new StillDepthError("The subject mask must match the source dimensions.");
  const sw = source.width, sh = source.height;
  // Compositing alpha: the SAM mask (thresholded at 128) without specks or pin-holes and with a
  // smoothed ~1 source-pixel edge ramp. Only alpha changes; the caller's mask bytes stay untouched.
  const refined = refineMaskAlpha(maskImage.data, sw, sh, { sigma: stillMaskSigma(sw, sh), threshold: 128 });
  const mask = Buffer.from(refined.alpha.buffer, refined.alpha.byteOffset, refined.alpha.length);
  let area = 0, sumX = 0, sumY = 0, left = sw, right = -1, top = sh, bottom = -1;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = y * sw + x;
    if (mask[i] < 128) continue;
    area++; sumX += x + 0.5; sumY += y + 0.5;
    if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
  }
  if (area < sw * sh * 0.002 || area > sw * sh * 0.97) throw new StillDepthError("The subject mask is empty or covers almost the whole image.");
  /** Photo borders the subject is cut by: a pulled-back subject keeps those edges pinned out of view. */
  const touches = { left: left <= 0, right: right >= sw - 1, top: top <= 0, bottom: bottom >= sh - 1 };

  // Base window: cover-fit the 9:16 frame, centred on the subject where the photo allows.
  const s0 = Math.max(W / sw, H / sh);
  const cx = sumX / area, cy = sumY / area;
  const winLeft = Math.round(Math.min(Math.max(0, cx * s0 - W / 2), sw * s0 - W));
  const winTop = Math.round(Math.min(Math.max(0, cy * s0 - H * 0.48), sh * s0 - H));
  const toBase = (x: number, y: number): [number, number] => [x * s0 - winLeft, y * s0 - winTop];
  const [bx0, by0] = toBase(left, top), [bx1, by1] = toBase(right + 1, bottom + 1);
  const subject = { left: bx0, top: by0, right: bx1, bottom: by1, cx: toBase(cx, cy)[0], cy: toBase(cx, cy)[1], width: bx1 - bx0, height: by1 - by0, area: area * s0 * s0 };

  // Pole of inaccessibility (deepest interior point) anchors the silhouette wipe.
  const poleScale = Math.min(1, 360 / Math.max(sw, sh));
  const pw = Math.max(1, Math.round(sw * poleScale)), ph = Math.max(1, Math.round(sh * poleScale));
  const small = await sharp(mask, { raw: { width: sw, height: sh, channels: 1 } }).resize(pw, ph, { fit: "fill", kernel: "linear" }).extractChannel(0).raw().toBuffer();
  const depth = squaredDistanceTransform((i) => small[i] < 128, pw, ph);
  let best = 0;
  for (let i = 1; i < depth.length; i++) if (depth[i] > depth[best]) best = i;
  const pole = { x: ((best % pw) + 0.5) / poleScale * s0 - winLeft, y: (Math.floor(best / pw) + 0.5) / poleScale * s0 - winTop, radius: Math.sqrt(depth[best]) / poleScale * s0 };

  // Background plate: base window plus margin, subject region filled from background only.
  const px0 = Math.max(0, Math.floor((winLeft - PLATE_MARGIN) / s0)), px1 = Math.min(sw, Math.ceil((winLeft + W + PLATE_MARGIN) / s0));
  const py0 = Math.max(0, Math.floor((winTop - PLATE_MARGIN) / s0)), py1 = Math.min(sh, Math.ceil((winTop + H + PLATE_MARGIN) / s0));
  const plateW = Math.max(2, Math.round((px1 - px0) * s0)), plateH = Math.max(2, Math.round((py1 - py0) * s0));
  const region = { left: px0, top: py0, width: px1 - px0, height: py1 - py0 };
  const plateRgba = await sharp(source.data, { raw: { width: sw, height: sh, channels: 3 } }).extract(region).resize(plateW, plateH, { fit: "fill", kernel: "lanczos3" }).ensureAlpha().raw().toBuffer();
  const plateMask = await sharp(mask, { raw: { width: sw, height: sh, channels: 1 } }).extract(region).resize(plateW, plateH, { fit: "fill", kernel: "linear" }).extractChannel(0).raw().toBuffer();
  // Lanczos upscaling spreads subject colour up to ~3 source pixels past the mask edge; the hole covers that halo too.
  const filled = fillBehindSubject(plateRgba, plateMask, plateW, plateH, { dilatePx: Math.max(Math.round(H * 0.014), Math.ceil(3 * s0) + 2), blurSigma: 8 });
  const platePosition = { width: plateW, height: plateH, ox: px0 * s0 - winLeft, oy: py0 * s0 - winTop, scaleX: plateW / ((px1 - px0) * s0), scaleY: plateH / ((py1 - py0) * s0) };
  const filledImage = () => sharp(filled, { raw: { width: plateW, height: plateH, channels: 4 } }).removeAlpha();
  const plateA: RgbRaster = { ...platePosition, data: await filledImage().blur(2.2).raw().toBuffer() };
  // Treated plates: blurred (depth of field), partly desaturated, darkened toward the theme's dark tone, vignetted.
  const treated = async (sigma: number, saturation: number, brightness: number, tint: number): Promise<RgbRaster> => {
    const data = await filledImage().blur(sigma).raw().toBuffer();
    const tone = theme.darkRgb.map((channel) => channel * tint);
    for (let y = 0; y < plateH; y++) {
      const ny = (y / plateH - 0.46) * 2;
      for (let x = 0; x < plateW; x++) {
        const nx = (x / plateW - 0.5) * 2, vignette = 1 - 0.38 * Math.min(1, (nx * nx + ny * ny) / 1.6);
        const o = (y * plateW + x) * 3, l = data[o] * 0.2126 + data[o + 1] * 0.7152 + data[o + 2] * 0.0722;
        for (let c = 0; c < 3; c++) data[o + c] = Math.round(((data[o + c] * saturation + l * (1 - saturation)) * brightness + tone[c]) * vignette);
      }
    }
    return { ...platePosition, data };
  };
  const plateB = await treated(11, 0.22, 0.5, 0.14);
  const plateC = await treated(22, 0.6, 0.62, 0.12);

  let backdrop: RgbRaster | null = null;
  if (input.backdrop) {
    const decoded = await decodePng(input.backdrop, "backdrop", theme.dark);
    const bw = W + PLATE_MARGIN * 2, bh = H + PLATE_MARGIN * 2;
    const data = await sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 3 } }).resize(bw, bh, { fit: "cover", position: "centre", kernel: "lanczos3" }).modulate({ brightness: 0.78 }).raw().toBuffer();
    backdrop = { width: bw, height: bh, ox: -PLATE_MARGIN, oy: -PLATE_MARGIN, scaleX: 1, scaleY: 1, data };
  }

  // Subject cutout mip chain: source RGB × mask alpha, cropped to the subject, never altered.
  const crop = { left: Math.max(0, left - 2), top: Math.max(0, top - 2), width: 0, height: 0 };
  crop.width = Math.min(sw, right + 3) - crop.left; crop.height = Math.min(sh, bottom + 3) - crop.top;
  const cutout = Buffer.alloc(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) {
    const s = (crop.top + y) * sw + crop.left + x, o = (y * crop.width + x) * 4;
    cutout[o] = source.data[s * 3]; cutout[o + 1] = source.data[s * 3 + 1]; cutout[o + 2] = source.data[s * 3 + 2]; cutout[o + 3] = mask[s];
  }
  const levels: AlphaRaster[] = [];
  for (const level of [1.3, 1, 0.72, 0.52, 0.37, 0.26]) {
    // Upscaled levels (tiny sources) are still plain resamples of the cutout, bounded in size.
    const r = Math.min(level * s0, Math.max(1, 2600 / Math.max(crop.width, crop.height)));
    const width = Math.max(1, Math.round(crop.width * r)), height = Math.max(1, Math.round(crop.height * r));
    if (levels.some((existing) => existing.width === width)) continue;
    const raw = width === crop.width && height === crop.height ? cutout
      : await sharp(cutout, { raw: { width: crop.width, height: crop.height, channels: 4 } }).resize(width, height, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer();
    const data = premultiply(raw, width, height);
    levels.push({ data, width, height, stride: 4, offset: 3, alphaSum: sumAlpha(data, 4, 3), ox: crop.left * s0 - winLeft, oy: crop.top * s0 - winTop, scaleX: width / (crop.width * s0), scaleY: height / (crop.height * s0) });
  }
  levels.sort((a, b) => b.scaleX - a.scaleX);
  const smallest = levels[levels.length - 1];

  // Soft contact shadow and dilated silhouette, both derived from the smallest mask level.
  const derived = (dilate: number, sigma: number, peak: number): AlphaRaster => {
    const pad = Math.ceil(dilate + sigma * 3 + 2);
    const width = smallest.width + pad * 2, height = smallest.height + pad * 2;
    const binary = new Uint8Array(width * height);
    for (let y = 0; y < smallest.height; y++) for (let x = 0; x < smallest.width; x++) binary[(y + pad) * width + x + pad] = smallest.data[(y * smallest.width + x) * 4 + 3] >= 0.5 ? 255 : 0;
    const grown = dilateMask(binary, width, height, dilate);
    const data = new Float32Array(width * height);
    for (let i = 0; i < data.length; i++) data[i] = grown[i] * peak;
    if (sigma > 0) gaussianBlurZero(data, width, height, sigma);
    return { data, width, height, stride: 1, offset: 0, alphaSum: sumAlpha(data, 1, 0), ox: smallest.ox - pad / smallest.scaleX, oy: smallest.oy - pad / smallest.scaleY, scaleX: smallest.scaleX, scaleY: smallest.scaleY };
  };
  const shadow = derived(0, 16 * smallest.scaleX, 0.62);
  const silhouette = derived(Math.max(1, 14 * smallest.scaleX), 1.2, 1);

  return { theme, subjectLevels: levels, shadow, silhouette, plateA, plateB, plateC, backdrop, subject, touches, pole, maskRefinement: refined.report };
}

// ---------------------------------------------------------------------------
// Layout: typography placement with occlusion checks
// ---------------------------------------------------------------------------

function subjectMap(assets: Prepared, p: Placement): Float32Array {
  const level = chooseLevel(assets.subjectLevels, p.k, LEDGER_FACTOR);
  return alphaMap(level, xform(level, p), FULL, LEDGER_FACTOR, LW, LH);
}

/** Share of the subject hidden by the union of foreground alpha maps. */
function foregroundOcclusion(subject: Float32Array, graphics: readonly (Graphic | null)[]): number {
  let total = 0, hidden = 0;
  for (let i = 0; i < subject.length; i++) {
    const s = subject[i];
    if (s <= 0) continue;
    let clear = 1;
    for (const g of graphics) if (g) clear *= 1 - Math.min(1, g.reduced[i]);
    total += s; hidden += s * (1 - clear);
  }
  return total > 0 ? hidden / total : 0;
}

/**
 * Share of a graphic's glyph area covered by the subject when shifted down by `dyCells` ledger rows,
 * optionally restricted to the graphic's own output rows [top, bottom) (one text line).
 */
function glyphOcclusion(graphic: Graphic, subject: Float32Array, dyCells = 0, rows?: readonly [number, number]): number {
  let total = 0, covered = 0;
  const top = Math.max(graphic.y, rows?.[0] ?? -Infinity), bottom = Math.min(graphic.y + graphic.height, rows?.[1] ?? Infinity);
  const x0 = Math.max(0, Math.floor(graphic.x / LEDGER_FACTOR)), x1 = Math.min(LW, Math.ceil((graphic.x + graphic.width) / LEDGER_FACTOR));
  const y0 = Math.max(0, Math.floor(top / LEDGER_FACTOR)), y1 = Math.min(LH, Math.ceil(bottom / LEDGER_FACTOR));
  for (let y = y0; y < y1; y++) {
    const sy = y + dyCells;
    for (let x = x0; x < x1; x++) {
      const a = graphic.reduced[y * LW + x];
      if (a <= 0) continue;
      total += a;
      if (sy >= 0 && sy < LH) covered += a * subject[sy * LW + x];
    }
  }
  return total > 0 ? covered / total : 0;
}

function shiftGraphic(g: Graphic, dy: number): Graphic {
  const cells = dy / LEDGER_FACTOR;
  if (!Number.isInteger(cells)) throw new StillDepthError("Graphic shifts must align with the ledger grid.");
  const reduced = new Float32Array(LW * LH);
  for (let y = Math.max(0, cells); y < Math.min(LH, LH + cells); y++) reduced.set(g.reduced.subarray((y - cells) * LW, (y - cells + 1) * LW), y * LW);
  return { ...g, y: g.y + dy, reduced };
}

interface TextSpec { text: string; face: FontFace; size: number; minSize?: number; maxLines: number; color: string; letterSpacing?: number; uppercase?: boolean; lineHeight?: number; opacity?: number }

function block(spec: TextSpec, x: number, top: number, maxWidth: number, anchor: "start" | "middle" | "end" = "start"): TextBlock {
  return textBlock({ text: spec.text, x, top, maxWidth, maxLines: spec.maxLines, preferredSize: spec.size, minSize: spec.minSize ?? Math.round(spec.size * 0.72), face: spec.face, color: spec.color, letterSpacing: spec.letterSpacing, uppercase: spec.uppercase, lineHeight: spec.lineHeight, opacity: spec.opacity, anchor });
}

/** A vertical stack of text blocks; returns blocks with tops assigned. */
function stack(specs: readonly (TextSpec | null)[], x: number, top: number, maxWidth: number, gaps: readonly number[], anchor: "start" | "middle" = "start"): (TextBlock | null)[] {
  let cursor = top;
  return specs.map((spec, index) => {
    if (!spec || !spec.text.trim()) return null;
    const laid = block(spec, x, cursor, maxWidth, anchor);
    cursor = laid.bounds.bottom + (gaps[index] ?? 0);
    return laid;
  });
}

function stackHeight(specs: readonly (TextSpec | null)[], maxWidth: number, gaps: readonly number[]): number {
  const laid = stack(specs, 0, 0, maxWidth, gaps);
  const last = laid.filter((item): item is TextBlock => Boolean(item)).at(-1);
  return last ? last.bounds.bottom : 0;
}

/**
 * The provenance chip text. A composited generated backdrop is always disclosed: the fixed
 * suffix is appended unless the caller's label already says so, and the caller's own text is
 * shortened (never the suffix) if the chip would otherwise truncate it.
 */
function provenanceText(label: string, generated: boolean, chip: (text: string) => { boxes: readonly { text: string }[] }): string {
  const own = Array.from(cleanText(label));
  if (!generated || GENERATED_MARKER.test(own.join(""))) return own.join("");
  for (let keep = own.length; ; keep--) {
    const text = `${own.slice(0, keep).join("").trimEnd()}${keep < own.length ? "…" : ""} · ${GENERATED_BACKDROP_LABEL}`;
    if (keep <= 1 || chip(text).boxes[0]?.text === cleanText(text).toLocaleUpperCase("en")) return text;
  }
}

/** A soft dark halo behind light lettering keeps it legible over any photo region. */
const SHADE_FILTER = `<filter id="shade" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur in="SourceAlpha" stdDeviation="7"/><feComponentTransfer><feFuncA type="linear" slope="0.5"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;

function shaded(svg: string): Promise<Graphic | null> {
  return renderGraphic(svg ? `<g filter="url(#shade)">${svg}</g>` : "", SHADE_FILTER);
}

async function graphicsFor(blocks: readonly (TextBlock | null)[], shade = false): Promise<(Graphic | null)[]> {
  return Promise.all(blocks.map((item) => item ? shade ? shaded(item.svg) : renderGraphic(item.svg) : Promise.resolve(null)));
}

async function prepareLayout(input: StillDepthInput, assets: Prepared) {
  const { theme, subject } = assets;
  const truncated: string[] = [];
  const note = (name: string, laid: (TextBlock | null)[]) => laid.forEach((item, index) => { if (item?.truncated) truncated.push(`${name}.${index}`); });
  const [hookScene, proofScene, valueScene, ctaScene] = input.scenes;
  const textWidth = W - SIDE * 2;
  const concept = input.mode === "synthetic" ? "SYNTHETIC DEMO · CONCEPT" : "CONCEPT · REVIEW REQUIRED";
  const bands = STILL_DEPTH_LABEL_BANDS;
  const chipStyle = { x: SIDE - 8, maxWidth: textWidth, face: "sansBold" as const, fill: theme.dark, fillOpacity: 0.86, color: theme.light };
  const provenanceChip = (text: string) => pill({ ...chipStyle, text, top: bands.bottom.top, height: bands.bottom.bottom - bands.bottom.top, size: 17, letterSpacing: 1.8, uppercase: true });
  const provenanceLabel = provenanceText(input.provenanceLabel, Boolean(assets.backdrop), provenanceChip);
  const chrome = await renderGraphic(
    pill({ ...chipStyle, text: concept, top: bands.top.top, height: bands.top.bottom - bands.top.top, size: 19, letterSpacing: 2.2 }).svg
    + provenanceChip(provenanceLabel).svg,
  );
  const chromeOnly = [chrome];

  // HOOK — giant serif headline set behind the real subject (depth typography). Placement search, in order of
  // preference: the photo's own framing with a full-width, then a side column; then the subject pulled back
  // (scaled about its base, photo-cut edges pinned) so the headline gets room above it. In front is a last resort.
  const hookAnchor = {
    ax: assets.touches.left && !assets.touches.right ? subject.left : assets.touches.right && !assets.touches.left ? subject.right : subject.cx,
    ay: assets.touches.bottom ? subject.bottom : subject.bottom - subject.height * 0.15,
  };
  const away: "left" | "right" = subject.cx >= W / 2 ? "left" : "right";
  const columnFor = (column: "full" | "left" | "right") => column === "full" ? { column, x: SIDE - 4, width: textWidth, anchor: "start" as const }
    : column === "left" ? { column, x: SIDE - 4, width: HOOK_SIDE_COLUMN, anchor: "start" as const } : { column, x: W - SIDE + 4, width: HOOK_SIDE_COLUMN, anchor: "end" as const };
  const columns = [columnFor("full"), columnFor(away), columnFor(away === "left" ? "right" : "left")];
  // The subject's extent over the whole hook (its slow zoom), widened upwards by the rows the headline
  // still has to rise once it is visible: the headline is then checked against every visible frame at once.
  const coverageAt = (k: number) => {
    const start = { k, ...hookAnchor, dx: 0, dy: 0 };
    const [a, b] = [subjectMap(assets, start), subjectMap(assets, { ...start, k: k * HOOK_ZOOM })];
    for (let i = 0; i < a.length; i++) a[i] = Math.max(a[i], b[i]);
    const swept = new Float32Array(a.length);
    for (let y = 0; y < LH; y++) for (let x = 0; x < LW; x++) {
      let value = 0;
      for (let s = 0; s <= HOOK_HEADLINE_VISIBLE_RISE_CELLS && y + s < LH; s++) value = Math.max(value, a[(y + s) * LW + x]);
      swept[y * LW + x] = value;
    }
    return { start, coverage: a, swept };
  };
  const headlines = new Map<string, { laid: TextBlock; graphic: Graphic | null } | null>();
  const headlineFor = async (column: ReturnType<typeof columnFor>, size: number) => {
    const key = `${column.column}:${size}`;
    if (!headlines.has(key)) {
      const laid = block({ text: hookScene.headline, face: "serif", size, minSize: size, maxLines: column.column === "full" ? 3 : 4, color: theme.light, lineHeight: 1.02 }, column.x, 0, column.width, column.anchor);
      headlines.set(key, laid.truncated && size > HOOK_SIZES.at(-1)! ? null : { laid, graphic: await renderGraphic(laid.svg) });
    }
    return headlines.get(key) ?? null;
  };
  let hookStart: Placement = { k: 1, ...hookAnchor, dx: 0, dy: 0 };
  let hookCoverage: Float32Array = new Float32Array(LW * LH);
  let hookHeadline: Graphic | null = null, hookKicker: Graphic | null = null;
  let hookReport: StillDepthLayoutReport["hookHeadline"] = { placement: "behind_subject", occlusion: 0, lineOcclusion: 0, foregroundOcclusion: 0, fontSize: 0, top: 0, column: "full", subjectScale: 1 };
  let hookFront = false;
  const kickerSpec = (color: string): TextSpec => ({ text: hookScene.kicker, face: "sansBold", size: 26, maxLines: 1, color, letterSpacing: 5, uppercase: true });
  // First pass never truncates the headline; only if nothing fits does the smallest size accept an ellipsis.
  search: for (const allowTruncation of [false, true]) for (const k of HOOK_PULLBACK) {
    const { start, coverage, swept } = coverageAt(k);
    for (const column of columns) for (const size of allowTruncation ? HOOK_SIZES.slice(-1) : HOOK_SIZES) {
      const headline = await headlineFor(column, size);
      const base = headline?.graphic;
      // A display headline never splits a word mid-way or drops text unless nothing else fits.
      if (!headline || !base || ((headline.laid.truncated || headline.laid.brokenWords) && !allowTruncation)) continue;
      const candidates: { dy: number; occlusion: number; line: number; score: number }[] = [];
      for (let dy = 176; dy + base.height + base.y <= H - 260; dy += LEDGER_FACTOR * 6) {
        const occlusion = glyphOcclusion(base, swept, dy / LEDGER_FACTOR);
        if (occlusion > MAX_HEADLINE_OCCLUSION) continue;
        // No single line may lose its letters behind the subject in any frame (a hidden word reads as a typo).
        const line = Math.max(0, ...headline.laid.boxes.map((box) => glyphOcclusion(base, swept, dy / LEDGER_FACTOR, [box.y, box.y + box.height])));
        if (line <= MAX_HEADLINE_LINE_OCCLUSION) candidates.push({ dy, occlusion, line, score: Math.max(occlusion, line) + 0.25 * dy / H });
      }
      candidates.sort((a, b) => a.score - b.score);
      const chosen = candidates[0];
      if (!chosen) continue;
      hookStart = start; hookCoverage = coverage;
      hookHeadline = shiftGraphic(base, chosen.dy);
      hookReport = { placement: "behind_subject", occlusion: Number(chosen.occlusion.toFixed(4)), lineOcclusion: Number(chosen.line.toFixed(4)), foregroundOcclusion: 0, fontSize: headline.laid.size, top: chosen.dy, column: column.column, subjectScale: k };
      if (headline.laid.truncated) truncated.push("hook.headline");
      const kicker = hookScene.kicker.trim() ? block(kickerSpec(theme.kickerOnDark), column.anchor === "end" ? W - SIDE : SIDE, chosen.dy - 64, column.width, column.anchor) : null;
      hookKicker = kicker ? await renderGraphic(kicker.svg) : null;
      break search;
    }
  }
  if (!hookHeadline) {
    // The subject fills the frame at every scale: the headline moves in front, in the band the subject covers least.
    hookFront = true;
    hookCoverage = coverageAt(1).coverage;
    const headline = block({ text: hookScene.headline, face: "serif", size: 96, minSize: 72, maxLines: 3, color: theme.light, lineHeight: 1.04 }, SIDE - 4, 0, textWidth);
    const base = await renderGraphic(headline.svg);
    if (base) {
      let best = { dy: 176, occlusion: Infinity };
      for (let dy = 176; dy + base.height + base.y <= H - 260; dy += LEDGER_FACTOR * 6) {
        const occlusion = foregroundOcclusion(hookCoverage, [shiftGraphic(base, dy), chrome]);
        if (occlusion < best.occlusion) best = { dy, occlusion };
      }
      hookHeadline = shiftGraphic(base, best.dy);
      if (headline.truncated) truncated.push("hook.headline");
      hookReport = { placement: "in_front", occlusion: 0, lineOcclusion: 0, foregroundOcclusion: Number(foregroundOcclusion(hookCoverage, [hookHeadline]).toFixed(4)), fontSize: headline.size, top: best.dy, column: "full", subjectScale: 1 };
    }
  }
  const headlineBottom = hookHeadline ? hookHeadline.y + hookHeadline.height : 0;
  let hookBody: Graphic | null = null;
  if (hookScene.body.trim()) {
    const spec: TextSpec = { text: hookScene.body, face: "sans", size: 36, maxLines: 3, color: theme.light, lineHeight: 1.3 };
    const height = block(spec, 0, 0, textWidth).bounds.bottom;
    let best: { graphic: Graphic | null; occlusion: number } = { graphic: null, occlusion: Infinity };
    for (const top of [H - 150 - height, H - 260 - height, headlineBottom + 48, 150]) {
      if (top < 120 || top + height > H - 120 || (hookHeadline && top < headlineBottom + 24 && top + height > (hookHeadline.y - 80))) continue;
      const laid = block(spec, SIDE, top, textWidth);
      const graphic = await shaded(laid.svg);
      const occlusion = foregroundOcclusion(hookCoverage, [graphic, chrome, hookFront ? hookHeadline : null]);
      if (occlusion < best.occlusion - 0.005) best = { graphic, occlusion };
      if (laid.truncated && best.graphic === graphic) truncated.push("hook.body");
      if (occlusion <= MAX_FOREGROUND_OCCLUSION * 0.5) break;
    }
    hookBody = best.occlusion <= MAX_FOREGROUND_OCCLUSION ? best.graphic : null;
    if (!hookBody) truncated.push("hook.body.omitted_for_subject_visibility");
  }
  const hookOcclusion = foregroundOcclusion(hookCoverage, [hookBody, chrome, hookFront ? hookHeadline : null]);

  // PROOF — slow push-in on the real photo, text stack in front in the lower third.
  const proofSpecs = (bodyLines: number): TextSpec[] => [
    { text: proofScene.kicker, face: "sansBold", size: 24, maxLines: 1, color: theme.kickerOnDark, letterSpacing: 4.5, uppercase: true },
    { text: proofScene.headline, face: "serif", size: 80, minSize: 58, maxLines: 3, color: theme.light, lineHeight: 1.06 },
    { text: proofScene.body, face: "sans", size: 34, minSize: 28, maxLines: bodyLines, color: theme.light, lineHeight: 1.32, opacity: 0.94 },
  ];
  const proofGaps = [22, 26, 0];
  let proof: { kEnd: number; target: [number, number]; graphics: (Graphic | null)[]; gradient: Graphic | null; occlusion: number } | null = null;
  for (const [kEnd, bodyLines] of [[1.22, 3], [1.14, 3], [1.08, 2], [1, 2], [0.94, 2]] as const) {
    const specs = proofSpecs(bodyLines);
    const height = stackHeight(specs, textWidth, proofGaps);
    const top = H - 150 - height;
    const camera = { k: kEnd, ax: subject.cx, ay: subject.cy, dx: (W / 2 - subject.cx) * 0.6, dy: Math.min(0, top - 40 - (subject.cy + kEnd * (subject.bottom - subject.cy))) };
    const fitted = fitPlacement(camera, assets.plateA);
    const laid = stack(specs, SIDE, top, textWidth, proofGaps);
    const graphics = await graphicsFor(laid, true);
    const occlusion = foregroundOcclusion(subjectMap(assets, fitted), [...graphics, chrome]);
    if (!proof || occlusion < proof.occlusion) {
      const gradientTop = Math.max(0, top - 300);
      const gradient = await renderGraphic(`<rect x="0" y="${gradientTop}" width="${W}" height="${H - gradientTop}" fill="url(#proofShade)"/>`, `<linearGradient id="proofShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${theme.dark}" stop-opacity="0"/><stop offset="0.55" stop-color="${theme.dark}" stop-opacity="0.62"/><stop offset="1" stop-color="${theme.dark}" stop-opacity="0.86"/></linearGradient>`);
      proof = { kEnd: fitted.k, target: [camera.dx, camera.dy], graphics, gradient, occlusion };
      note("proof", laid);
    }
    if (occlusion <= MAX_FOREGROUND_OCCLUSION) break;
  }

  // VALUE — parallax: background drifts one way, the real subject the other; story text on the free side.
  const side: "left" | "right" = subject.cx >= W / 2 ? "right" : "left";
  const columnWidth = Math.round(W * 0.46);
  const columnX = side === "right" ? SIDE : W - SIDE - columnWidth;
  const valueSpecs: TextSpec[] = [
    { text: valueScene.kicker, face: "sansBold", size: 23, maxLines: 2, color: theme.kickerOnDark, letterSpacing: 4, uppercase: true },
    { text: valueScene.headline, face: "serif", size: 68, minSize: 46, maxLines: 5, color: theme.light, lineHeight: 1.08 },
    { text: valueScene.body, face: "sans", size: 31, minSize: 26, maxLines: 6, color: theme.light, lineHeight: 1.34, opacity: 0.94 },
  ];
  const valueGaps = [20, 28, 0];
  const valueHeight = stackHeight(valueSpecs, columnWidth, valueGaps);
  const valueTop = Math.round(Math.max(170, Math.min(H * 0.5 - valueHeight / 2, H - 170 - valueHeight)));
  const valueLaid = stack(valueSpecs, columnX, valueTop, columnWidth, valueGaps);
  note("value", valueLaid);
  const valueGraphics = await graphicsFor(valueLaid, true);
  const sideGradient = await renderGraphic(`<rect width="${W}" height="${H}" fill="url(#sideShade)"/>`, `<linearGradient id="sideShade" x1="${side === "right" ? 0 : 1}" y1="0" x2="${side === "right" ? 1 : 0}" y2="0"><stop offset="0" stop-color="${theme.dark}" stop-opacity="0.78"/><stop offset="0.5" stop-color="${theme.dark}" stop-opacity="0.42"/><stop offset="0.8" stop-color="${theme.dark}" stop-opacity="0"/></linearGradient>`);
  const textBounds = valueLaid.reduce<Bounds | null>((bounds, item) => !item ? bounds : !bounds ? { ...item.bounds } : { left: Math.min(bounds.left, item.bounds.left), top: Math.min(bounds.top, item.bounds.top), right: Math.max(bounds.right, item.bounds.right), bottom: Math.max(bounds.bottom, item.bounds.bottom) }, null);
  const fitK = Math.min(1.15, (H * 0.56) / subject.height, (W * 0.5) / subject.width);
  let value = { k: fitK, center: [W / 2, H * 0.53] as [number, number], occlusion: Infinity, score: Infinity };
  for (const factor of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
    const k = fitK * factor, halfWidth = subject.width * k * 1.03 / 2;
    // Keep a clear gutter between the story column and the subject at the end of its drift.
    const gutter = 40 + VALUE_DRIFT;
    const preferred = side === "right" ? W * 0.71 : W * 0.29;
    const center: [number, number] = [
      side === "right" ? Math.max(preferred, (textBounds?.right ?? W / 2) + gutter + halfWidth) : Math.min(preferred, (textBounds?.left ?? W / 2) - gutter - halfWidth),
      H * 0.53,
    ];
    const overflow = side === "right" ? center[0] + halfWidth + VALUE_DRIFT - (W - 12) : 12 - (center[0] - halfWidth - VALUE_DRIFT);
    const worst = Math.max(...[-1, 1].map((drift) => foregroundOcclusion(subjectMap(assets, valuePlacement(subject, k * 1.03, center, side, drift)), [...valueGraphics, chrome])));
    const score = worst + Math.max(0, overflow) / W;
    if (score < value.score) value = { k, center, occlusion: worst, score };
    if (worst <= MAX_FOREGROUND_OCCLUSION && overflow <= 0) break;
  }

  // CTA — end card on paper: brand line, headline, real subject centred smaller, CTA pill.
  const brand = block({ text: input.businessName, face: "sansBold", size: 28, minSize: 20, maxLines: 1, color: theme.dark, letterSpacing: 5, uppercase: true }, W / 2, 150, textWidth, "middle");
  const ctaHeadline = block({ text: ctaScene.headline, face: "serif", size: 74, minSize: 52, maxLines: 3, color: theme.dark, lineHeight: 1.06 }, W / 2, brand.bounds.bottom + 30, textWidth, "middle");
  const bodySpec: TextSpec = { text: ctaScene.body, face: "sans", size: 30, minSize: 25, maxLines: 2, color: theme.dark, lineHeight: 1.3, opacity: 0.82 };
  const bodyHeight = ctaScene.body.trim() ? block(bodySpec, 0, 0, textWidth).bounds.bottom : 0;
  const pillHeight = 104;
  const bottomStack = pillHeight + (bodyHeight ? 34 + bodyHeight : 0);
  const boxTop = ctaHeadline.bounds.bottom + 56;
  const boxBottom = H - 150 - bottomStack - 56;
  const fitCtaK = Math.max(0.2, Math.min(1.3, (W * 0.7) / subject.width, Math.max(120, boxBottom - boxTop) / subject.height));
  const ctaCenter: [number, number] = [W / 2, boxTop + Math.max(120, boxBottom - boxTop) / 2];
  const [ctaBrandG, ctaHeadlineG] = await Promise.all([renderGraphic(brand.svg), renderGraphic(ctaHeadline.svg)]);
  // The end card shrinks the subject until the brand line, headline, pill and body hide at most 10% of it.
  let ctaLayout: { ctaK: number; subjectBottom: number; placement: Placement; pill: Graphic | null; body: Graphic | null; bodyBlock: TextBlock | null; occlusion: number } | null = null;
  for (const factor of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
    const ctaK = fitCtaK * factor;
    const subjectBottom = ctaCenter[1] + subject.height * ctaK / 2;
    const pillTop = Math.round(Math.min(subjectBottom + 56, H - 150 - bottomStack));
    const ctaPill = pill({ text: input.cta, x: W / 2, top: pillTop, height: pillHeight, maxWidth: textWidth, size: 38, minSize: 26, face: "sansBold", fill: theme.accent, color: theme.accentText, anchor: "middle", paddingX: 56 });
    const bodyBlock = ctaScene.body.trim() ? block(bodySpec, W / 2, pillTop + pillHeight + 34, textWidth, "middle") : null;
    const [pillG, bodyG] = await Promise.all([renderGraphic(ctaPill.svg), bodyBlock ? renderGraphic(bodyBlock.svg) : Promise.resolve(null)]);
    const placement = { k: ctaK, ax: (subject.left + subject.right) / 2, ay: (subject.top + subject.bottom) / 2, dx: ctaCenter[0] - (subject.left + subject.right) / 2, dy: ctaCenter[1] - (subject.top + subject.bottom) / 2 };
    // The end card settles from 96.5% to full scale; both ends are measured.
    const occlusion = Math.max(...[placement, { ...placement, k: ctaK * 0.965 }].map((p) => foregroundOcclusion(subjectMap(assets, p), [ctaBrandG, ctaHeadlineG, pillG, bodyG, chrome])));
    if (!ctaLayout || occlusion < ctaLayout.occlusion - 1e-4) ctaLayout = { ctaK, subjectBottom, placement, pill: pillG, body: bodyG, bodyBlock, occlusion };
    if (occlusion <= MAX_FOREGROUND_OCCLUSION) break;
  }
  const { ctaK, subjectBottom, placement: ctaPlacement, occlusion: ctaOcclusion } = ctaLayout!;
  note("cta", [brand, ctaHeadline, ctaLayout!.bodyBlock]);
  const halo = Math.max(subject.width, subject.height) * ctaK * 0.62;
  const ctaBackground = await renderGraphic(
    `<rect width="${W}" height="${H}" fill="url(#paperWash)"/><circle cx="${ctaCenter[0]}" cy="${ctaCenter[1]}" r="${Math.round(halo)}" fill="url(#halo)"/>`
    + `<ellipse cx="${ctaCenter[0]}" cy="${Math.round(subjectBottom + 10)}" rx="${Math.round(subject.width * ctaK * 0.46)}" ry="${Math.max(8, Math.round(subject.width * ctaK * 0.05))}" fill="${theme.dark}" fill-opacity="0.14"/>`
    + `<line x1="${SIDE}" y1="${H - 128}" x2="${W - SIDE}" y2="${H - 128}" stroke="${theme.dark}" stroke-opacity="0.16"/>`,
    `<linearGradient id="paperWash" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${theme.light}"/><stop offset="1" stop-color="${input.theme.soft}"/></linearGradient><radialGradient id="halo"><stop offset="0" stop-color="${theme.accent}" stop-opacity="0.26"/><stop offset="1" stop-color="${theme.accent}" stop-opacity="0"/></radialGradient>`,
  );

  const layout: StillDepthLayoutReport = {
    hookHeadline: hookReport,
    foregroundOcclusion: [hookOcclusion, proof?.occlusion ?? 0, value.occlusion, ctaOcclusion].map((value) => Number(value.toFixed(4))) as [number, number, number, number],
    valueSubjectSide: side,
    truncatedText: truncated,
    usesGeneratedBackdrop: Boolean(assets.backdrop),
    provenanceLabel,
    conceptLabel: concept,
    subjectMask: assets.maskRefinement,
  };
  return {
    chrome, chromeOnly, layout,
    hook: { start: hookStart, headline: hookHeadline, kicker: hookKicker, body: hookBody, headlineInFront: hookFront },
    proof: proof!,
    value: { ...value, side, graphics: valueGraphics, gradient: sideGradient },
    cta: { placement: ctaPlacement, background: ctaBackground, brand: ctaBrandG, headline: ctaHeadlineG, pill: ctaLayout!.pill, body: ctaLayout!.body },
  };
}

function valuePlacement(subject: Prepared["subject"], k: number, center: readonly [number, number], side: "left" | "right", drift: number): Placement {
  const ax = (subject.left + subject.right) / 2, ay = (subject.top + subject.bottom) / 2;
  const sign = side === "right" ? 1 : -1;
  return { k, ax, ay, dx: center[0] - ax - sign * drift * VALUE_DRIFT, dy: center[1] - ay };
}

// ---------------------------------------------------------------------------
// Scenes and transitions
// ---------------------------------------------------------------------------

type Layout = Awaited<ReturnType<typeof prepareLayout>>;
type Phase = "below" | "top";

class Director {
  constructor(private readonly assets: Prepared, private readonly layout: Layout) {}

  hookSubject(t: number): Placement { const start = this.layout.hook.start; return { ...start, k: start.k * (1 + (HOOK_ZOOM - 1) * easeInOut(t / 3)) } }

  private hook(s: Surface, t: number, phase: Phase, shift: number, clip: Clip) {
    const { hook } = this.layout;
    const subject = shifted(this.hookSubject(t), shift);
    const treat = easeInOut(t / 0.6);
    if (phase === "below") {
      const camera = shifted(fitPlacement({ ...hook.start, k: 1 + 0.02 * easeInOut(t / 3.2) }, this.assets.plateA), shift);
      if (treat < 1) s.plate(this.assets.plateA, camera, 1, "treated_source", clip);
      if (treat > 0) s.plate(this.assets.plateB, camera, treat, "treated_source", clip);
      const words = appear(t, 0.22, 0.75, HOOK_HEADLINE_RISE);
      s.graphic(hook.kicker, shift, words.dy, words.opacity, "background_graphics", clip);
      if (!hook.headlineInFront) s.graphic(hook.headline, shift, words.dy, words.opacity, "background_graphics", clip);
      s.shadow(subject, 0.55 * treat, clip);
      return;
    }
    s.subject(subject, 1, clip);
    if (hook.headlineInFront) { const words = appear(t, 0.22, 0.75, HOOK_HEADLINE_RISE); s.graphic(hook.headline, shift, words.dy, words.opacity, "foreground_graphics", clip); }
    const body = appear(t, 1.05);
    s.graphic(hook.body, shift, body.dy, body.opacity, "foreground_graphics", clip);
  }

  proofCamera(t: number): Placement {
    const { proof } = this.layout, subject = this.assets.subject;
    const e = easeInOut((t + 0.2) / 3.4);
    return fitPlacement({ k: 1.06 + (proof.kEnd - 1.06) * e, ax: subject.cx, ay: subject.cy, dx: proof.target[0] * e, dy: proof.target[1] * e }, this.assets.plateA);
  }

  private proof(s: Surface, t: number, phase: Phase, shift: number, clip: Clip) {
    const camera = shifted(this.proofCamera(t), shift);
    const { proof } = this.layout;
    if (phase === "below") {
      s.plate(this.assets.plateA, camera, 1, "treated_source", clip);
      s.graphic(proof.gradient, shift, 0, easeOut((t + 0.2) / 0.8), "background_graphics", clip);
      return;
    }
    s.subject(camera, 1, clip);
    proof.graphics.forEach((graphic, index) => { const a = appear(t, 0.15 + index * 0.12); s.graphic(graphic, shift, a.dy, a.opacity, "foreground_graphics", clip) });
  }

  private value(s: Surface, t: number, phase: Phase, shift: number, clip: Clip) {
    const { value } = this.layout, assets = this.assets;
    const drift = easeInOut((t + 0.2) / 3.4) * 2 - 1;
    const subject = shifted(valuePlacement(assets.subject, value.k * (1 + 0.03 * (drift + 1) / 2), value.center, value.side, drift), shift);
    if (phase === "below") {
      const plate = assets.backdrop ?? assets.plateC;
      const sign = value.side === "right" ? 1 : -1;
      const camera = shifted(fitPlacement({ k: 1.14, ax: W / 2, ay: H / 2, dx: sign * drift * 46, dy: 0 }, plate), shift);
      s.plate(plate, camera, 1, assets.backdrop ? "generated" : "treated_source", clip);
      s.graphic(value.gradient, shift, 0, 1, "background_graphics", clip);
      s.shadow(subject, 0.5, clip);
      return;
    }
    s.subject(subject, 1, clip);
    value.graphics.forEach((graphic, index) => { const a = appear(t, 0.18 + index * 0.12); s.graphic(graphic, shift, a.dy, a.opacity, "foreground_graphics", clip) });
  }

  ctaSubject(t: number): Placement { const p = this.layout.cta.placement; return { ...p, k: p.k * (0.965 + 0.035 * easeOut((t + 0.25) / 2.4)) } }

  private cta(s: Surface, t: number, phase: Phase, shift: number, clip: Clip) {
    const { cta } = this.layout;
    const subject = shifted(this.ctaSubject(t), shift);
    if (phase === "below") {
      s.graphic(cta.background, shift, 0, 1, "background_graphics", clip);
      s.shadow(subject, 0.32, clip);
      return;
    }
    s.subject(subject, 1, clip);
    const items: [Graphic | null, number][] = [[cta.brand, 0.0], [cta.headline, 0.12], [cta.pill, 0.42], [cta.body, 0.58]];
    for (const [graphic, start] of items) { const a = appear(t, start, 0.5, 28); s.graphic(graphic, shift, a.dy, a.opacity, "foreground_graphics", clip) }
  }

  private scene(index: number, s: Surface, t: number, phase: Phase, shift = 0, clip: Clip = FULL) {
    if (index === 0) this.hook(s, t, phase, shift, clip);
    else if (index === 1) this.proof(s, t, phase, shift, clip);
    else if (index === 2) this.value(s, t, phase, shift, clip);
    else this.cta(s, t, phase, shift, clip);
  }

  private full(index: number, s: Surface, frame: number) {
    const t = (frame - index * SCENE_FRAMES) / FPS;
    this.scene(index, s, t, "below"); this.scene(index, s, t, "top");
  }

  /** Draws one complete frame onto `main` (using `aux` for the silhouette wipe). */
  draw<S extends Surface>(frame: number, main: S, aux: S) {
    const { silhouetteWipe: wipe, motionSlide: slide, accentFade: fade } = STILL_DEPTH_TRANSITIONS;
    if (frame >= wipe[0] && frame < wipe[1]) {
      const p = (frame - wipe[0] + 0.5) / (wipe[1] - wipe[0]);
      this.full(0, main, frame); this.full(1, aux, frame);
      // The next scene is revealed through the dilated subject silhouette, scaling from its deepest interior point.
      const placement = this.hookSubject(frame / FPS);
      const [px, py] = apply(placement, this.assets.pole.x, this.assets.pole.y);
      const reach = Math.max(...[[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => Math.hypot(x - px, y - py)));
      const growth = Math.min(80, Math.max(4, reach / Math.max(8, this.assets.pole.radius * placement.k) * 1.15));
      const g = Math.exp(Math.log(growth) * easeInOut(p));
      main.mix(aux, this.assets.silhouette, scaleAbout(placement, g, px, py), smoothstep(0.78, 1, p));
    } else if (frame >= slide[0] && frame < slide[1]) {
      const span = slide[1] - slide[0], p = (frame - slide[0] + 0.5) / span;
      const e = easeInOut(p), velocity = Math.abs(easeInOut(p + 0.5 / span) - easeInOut(p - 0.5 / span)) * W;
      const split = Math.round(W * (1 - e));
      const tA = (frame - SCENE_FRAMES) / FPS, tB = (frame - 2 * SCENE_FRAMES) / FPS;
      const clipA: Clip = [0, split], clipB: Clip = [split, W];
      this.scene(1, main, tA, "below", split - W, clipA); this.scene(2, main, tB, "below", split, clipB);
      main.motionBlur(velocity * 0.35);
      this.scene(1, main, tA, "top", split - W, clipA); this.scene(2, main, tB, "top", split, clipB);
    } else if (frame >= fade[0] && frame < fade[1]) {
      const p = (frame - fade[0] + 0.5) / (fade[1] - fade[0]);
      if (p < 0.5) { this.full(2, main, frame); main.wash(this.assets.theme.accentRgb, easeInOut(p / 0.5)); }
      else { this.full(3, main, frame); main.wash(this.assets.theme.accentRgb, 1 - easeInOut((p - 0.5) / 0.5)); }
    } else {
      this.full(Math.min(3, Math.floor(frame / SCENE_FRAMES)), main, frame);
    }
    main.graphic(this.layout.chrome, 0, 0, 1, "foreground_graphics", FULL);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StillDepthComposer {
  readonly frames: number;
  readonly layout: StillDepthLayoutReport;
  /** Full-resolution straight RGBA (1080·1920·4 bytes, opaque). */
  renderFrame(frameIndex: number): Buffer;
  /** Reduced-resolution provenance replay of the same frame. */
  analyzeFrame(frameIndex: number): LedgerCanvas;
}

function parseInput(input: StillDepthInput): StillDepthInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new StillDepthError("The still-depth Reel input is invalid.");
  return parsed.data as StillDepthInput;
}

function assertFrame(frameIndex: number): void {
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= STILL_DEPTH_FRAMES) throw new StillDepthError("Frame index is outside the Reel.");
}

/** Decodes, segments-by-mask, fills and lays out once; frames are then cheap affine composites. */
export async function prepareStillDepth(input: StillDepthInput): Promise<StillDepthComposer> {
  const parsed = parseInput(input);
  const assets = await prepareAssets(parsed);
  const layout = await prepareLayout(parsed, assets);
  const director = new Director(assets, layout);
  const main = new PixelSurface(assets), aux = new PixelSurface(assets);
  return {
    frames: STILL_DEPTH_FRAMES,
    layout: layout.layout,
    renderFrame(frameIndex) { assertFrame(frameIndex); director.draw(frameIndex, main, aux); return main.toRgba() },
    analyzeFrame(frameIndex) { assertFrame(frameIndex); const a = new LedgerSurface(assets), b = new LedgerSurface(assets); director.draw(frameIndex, a, b); return a.canvas },
  };
}

/** Renders one frame as a 1080×1920 PNG (for previews, covers and tests). */
export async function renderStillDepthFrame(input: StillDepthInput, frameIndex: number): Promise<Buffer> {
  assertFrame(frameIndex);
  const composer = await prepareStillDepth(input);
  return sharp(composer.renderFrame(frameIndex), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

async function writeAtomic(path: string, bytes: Buffer): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.partial`);
  try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}

/**
 * Renders the 12 s depth Reel and its cover. The ledger is accumulated from the
 * exact frames that were encoded. Errors are fixed strings without local paths.
 */
export async function renderStillDepthReel(input: StillDepthInput, options: { timeoutMs?: number } = {}): Promise<StillDepthResult> {
  const parsed = parseInput(input);
  const composer = await prepareStillDepth(parsed);
  try {
    await mkdir(dirname(parsed.outputPath), { recursive: true });
    await mkdir(dirname(parsed.coverPath), { recursive: true });
  } catch { throw new StillDepthError("The Reel output location could not be prepared.") }
  const encoder = openH264Encoder({ outputPath: parsed.outputPath, width: W, height: H, fps: FPS, expectedFrames: STILL_DEPTH_FRAMES, timeoutMs: options.timeoutMs ?? 300_000 });
  const ledger = new CompositionLedgerAccumulator();
  let coverPng: Buffer | null = null;
  let reel, finished: CompositionLedger;
  try {
    for (let frame = 0; frame < STILL_DEPTH_FRAMES; frame++) {
      const rgba = composer.renderFrame(frame);
      const written = encoder.writeFrame(rgba);
      // Observed below; this only prevents an unhandled rejection if the replay throws first.
      written.catch(() => undefined);
      ledger.addFrame(composer.analyzeFrame(frame));
      if (frame === STILL_DEPTH_COVER_FRAME) coverPng = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
      await written;
    }
    finished = ledger.finish();
    // The cover lands first so a verified MP4 never exists without its cover.
    try { await writeAtomic(parsed.coverPath, coverPng!); }
    catch { throw new StillDepthError("The Reel cover could not be written.") }
    reel = await encoder.finish();
  } catch (error) {
    await encoder.abort();
    if (coverPng) await rm(parsed.coverPath, { force: true }).catch(() => undefined);
    if (error instanceof CinemaEncodeError || error instanceof StillDepthError) throw error;
    throw new StillDepthError("The still-depth Reel could not be composed.");
  }
  const layout = composer.layout;
  const violations: StillDepthViolation[] = [];
  if (finished.maxSubjectOcclusion > MAX_FOREGROUND_OCCLUSION) violations.push("foreground_occlusion");
  if (layout.hookHeadline.placement === "in_front") violations.push("headline_in_front");
  if (finished.framesWithoutSubject > 0) violations.push("subject_missing");
  return {
    reel: { sha256: reel.sha256, bytes: reel.bytes, frames: reel.frames, durationSeconds: reel.durationSeconds, width: W, height: H, fps: FPS },
    cover: { sha256: createHash("sha256").update(coverPng!).digest("hex"), bytes: coverPng!.length, width: W, height: H, frame: STILL_DEPTH_COVER_FRAME },
    ledger: finished,
    layout,
    qa: { violations, framesSubjectHiddenByTransition: ledger.framesSubjectHiddenByTransition },
  };
}
