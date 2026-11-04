import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { FrameMask, MaskletReader, NormalizedClip } from "../../media/cinema-types";
import { readClipFrames } from "../../media/clip";
import { CinemaEncodeError, openH264Encoder } from "./encode";
import { cleanText, pill, svgDocument, textBlock } from "./typography";

/**
 * "How SAM saw it": the owner's original footage with every tracked SAM 3.1 object drawn as a
 * tinted mask, a contour, its local label and id, and a fading centroid trail, plus a HUD. It is
 * an analysis preview for review — every frame carries "ANALYSIS PREVIEW · NOT CAMPAIGN
 * CREATIVE" — and never a campaign asset. Labels are local prompt labels, not verified identities.
 * Frames are streamed from the clip; nothing here calls a network service.
 */

export const SAM_OVERLAY_LABEL = "ANALYSIS PREVIEW · NOT CAMPAIGN CREATIVE";
/** Okabe–Ito colour-blind-safe palette (plus white), cycled for more objects. */
export const SAM_OVERLAY_PALETTE = ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#FFFFFF"] as const;
export const SAM_OVERLAY_MAX_LONG_SIDE = 1080;
/** Small clips are upscaled (within the long-side cap) so the short side reaches this; keeps the disclosure legible. */
export const SAM_OVERLAY_MIN_SHORT_SIDE = 360;
/** The disclosure and HUD wrap onto at most this many lines; beyond that the overlay is refused rather than truncated. */
const MAX_CHROME_LINES = 3;
export const SAM_OVERLAY_TINT_OPACITY = 0.45;
const TRAIL_FRAMES = 24;
/** Offsets within the 2 px contour width: an inside pixel with any of these outside is on the contour. */
const RING: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export interface SamOverlayInput {
  clip: NormalizedClip;
  reader: MaskletReader;
  outputPath: string;
  /** Display labels per object id; objects without one use their masklet label. Not verified identities. */
  objectLabels: Record<string, string>;
  /** Inclusive clip frame range; defaults to the whole clip. */
  window?: { fromFrame: number; toFrame: number };
}

export interface SamOverlayResult {
  video: { sha256: string; bytes: number; frames: number; durationSeconds: number; width: number; height: number; fps: number };
  /** The disclosure exactly as rendered on every frame (never truncated), and its font size in output pixels. */
  disclosure: { lines: string[]; fontSize: number };
  objects: Array<{ objectId: string; label: string; color: string; framesWithMask: number }>;
  label: typeof SAM_OVERLAY_LABEL;
  window: { fromFrame: number; toFrame: number };
}

export class SamOverlayError extends Error {
  constructor(message: string) { super(message); this.name = "SamOverlayError"; }
}

const frameIndex = z.number().int().nonnegative();
const inputSchema = z.strictObject({
  clip: z.custom<NormalizedClip>((value) => {
    const clip = value as NormalizedClip | null;
    return Boolean(clip) && typeof clip === "object" && typeof clip!.path === "string" && isAbsolute(clip!.path) && /^[a-f0-9]{64}$/.test(String(clip!.sha256))
      && [clip!.width, clip!.height, clip!.frameCount, clip!.fps].every((item) => Number.isInteger(item) && item > 0) && clip!.fps <= 120;
  }),
  reader: z.custom<MaskletReader>((value) => {
    const reader = value as MaskletReader | null;
    return Boolean(reader) && typeof reader === "object" && typeof reader!.frameMask === "function" && Boolean(reader!.set) && typeof reader!.set === "object";
  }),
  outputPath: z.string().max(4096).refine((value) => isAbsolute(value) && /\.mp4$/i.test(value)),
  objectLabels: z.record(z.string().regex(/^\d{1,20}$/), z.string().max(400)).refine((value) => Object.keys(value).length <= 64),
  window: z.strictObject({ fromFrame: frameIndex, toFrame: frameIndex }).optional(),
});

function hexRgb(value: string): [number, number, number] {
  return [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16)) as [number, number, number];
}

function relativeLuminance(value: string): number {
  const [r, g, b] = hexRgb(value).map((channel) => channel / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Near-black or white, whichever has the higher WCAG contrast on `fill`. */
export function samOverlayTextColor(fill: string): "#111111" | "#FFFFFF" {
  return contrastRatio(fill, "#111111") >= contrastRatio(fill, "#FFFFFF") ? "#111111" : "#FFFFFF";
}

/**
 * Even output size: the clip's own size, downscaled so the long side is at most
 * SAM_OVERLAY_MAX_LONG_SIDE, or upscaled so the short side reaches SAM_OVERLAY_MIN_SHORT_SIDE
 * when that keeps the long side within the cap.
 */
export function samOverlaySize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(SAM_OVERLAY_MAX_LONG_SIDE / Math.max(width, height), Math.max(1, SAM_OVERLAY_MIN_SHORT_SIDE / Math.min(width, height)));
  const even = (side: number) => Math.max(2, Math.floor(side * scale / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** Chip font size for an output size. */
function chromeSize(ow: number, oh: number): number {
  return Math.max(11, Math.min(28, Math.round(Math.min(ow, oh) / 26)));
}

interface ChromeText { lines: string[]; size: number; truncated: boolean }

/**
 * Fits fixed chrome text (disclosure, HUD) inside `maxWidth` on the fewest lines (1 … `maxLines`)
 * without truncation; `truncated` is true only when even `maxLines` lines cannot hold it.
 */
function fitChrome(text: string, maxWidth: number, size: number, maxLines = MAX_CHROME_LINES, minLines = 1): ChromeText {
  const paddingX = size * 0.6, minSize = Math.max(8, size * 0.7);
  let laid = null;
  for (let lines = minLines; lines <= maxLines; lines++) {
    laid = textBlock({ text, x: 0, top: 0, maxWidth: maxWidth - paddingX * 2, maxLines: lines, preferredSize: size, minSize, face: "sansBold", color: "#FFFFFF" });
    if (!laid.truncated) break;
  }
  return { lines: laid?.lines ?? [], size: laid?.size ?? size, truncated: laid?.truncated ?? true };
}

/** The disclosure as it is laid out on an overlay of this output size. */
export function samOverlayDisclosure(width: number, height: number): ChromeText {
  const size = chromeSize(width, height), margin = Math.max(6, Math.round(size * 0.6));
  return fitChrome(SAM_OVERLAY_LABEL, width - margin * 2, size);
}

interface ObjectStyle { objectId: string; label: string; color: string; rgb: [number, number, number]; text: string; trail: Array<{ x: number; y: number; frame: number }>; framesWithMask: number }

/**
 * Tints one mask into `rgba` (output size ow×oh, mask in clip pixels scaled by kx/ky, nearest),
 * draws its contour and returns the output-space box and centroid, or null when nothing is visible.
 */
function paintMask(rgba: Buffer, ow: number, oh: number, kx: number, ky: number, mask: FrameMask, rgb: readonly [number, number, number]): { left: number; top: number; right: number; bottom: number; cx: number; cy: number } | null {
  const { left, top, right, bottom } = mask.bounds, mw = right - left;
  const x0 = Math.max(0, Math.floor(left * kx) - 1), x1 = Math.min(ow, Math.ceil(right * kx) + 1);
  const y0 = Math.max(0, Math.floor(top * ky) - 1), y1 = Math.min(oh, Math.ceil(bottom * ky) + 1);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return null;
  const inside = new Uint8Array(bw * bh);
  let count = 0, sumX = 0, sumY = 0;
  for (let y = y0; y < y1; y++) {
    const sy = Math.floor((y + 0.5) / ky);
    if (sy < top || sy >= bottom) continue;
    for (let x = x0; x < x1; x++) {
      const sx = Math.floor((x + 0.5) / kx);
      if (sx < left || sx >= right || !mask.raster[(sy - top) * mw + sx - left]) continue;
      inside[(y - y0) * bw + x - x0] = 1;
      count++; sumX += x + 0.5; sumY += y + 0.5;
    }
  }
  if (!count) return null;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < bw && y < bh && inside[y * bw + x] === 1;
  let minX = bw, maxX = -1, minY = bh, maxY = -1;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (!inside[y * bw + x]) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const o = ((y + y0) * ow + x + x0) * 4;
    const edge = RING.some(([dx, dy]) => !at(x + dx, y + dy));
    if (edge) { rgba[o] = rgb[0]; rgba[o + 1] = rgb[1]; rgba[o + 2] = rgb[2]; continue; }
    for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(rgba[o + c] * (1 - SAM_OVERLAY_TINT_OPACITY) + rgb[c] * SAM_OVERLAY_TINT_OPACITY);
  }
  return { left: minX + x0, top: minY + y0, right: maxX + x0 + 1, bottom: maxY + y0 + 1, cx: sumX / count, cy: sumY / count };
}

/** Straight-alpha RGBA overlay composited in place over an opaque frame. */
function compositeOver(rgba: Buffer, overlay: Buffer): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = overlay[i + 3];
    if (!a) continue;
    if (a === 255) { rgba[i] = overlay[i]; rgba[i + 1] = overlay[i + 1]; rgba[i + 2] = overlay[i + 2]; continue; }
    const t = a / 255;
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(rgba[i + c] * (1 - t) + overlay[i + c] * t);
  }
}

/**
 * Renders the SAM analysis overlay MP4 at the clip's own size (long side ≤ 1080, even), one output
 * frame per clip frame in the window, at the clip's frame rate. Errors are fixed strings.
 */
export async function renderSamOverlayVideo(input: SamOverlayInput, options: { timeoutMs?: number } = {}): Promise<SamOverlayResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new SamOverlayError("The SAM overlay input is invalid.");
  const { clip, reader, outputPath, objectLabels } = parsed.data as SamOverlayInput;
  const bound = reader.set.clip;
  if (bound.sha256 !== clip.sha256 || bound.width !== clip.width || bound.height !== clip.height || bound.frameCount !== clip.frameCount || bound.fps !== clip.fps) {
    throw new SamOverlayError("The masklets belong to different clip bytes.");
  }
  const fromFrame = parsed.data.window?.fromFrame ?? 0, toFrame = parsed.data.window?.toFrame ?? clip.frameCount - 1;
  if (toFrame < fromFrame || toFrame >= clip.frameCount) throw new SamOverlayError("The overlay window lies outside the clip.");
  const frames = toFrame - fromFrame + 1;
  const { width: ow, height: oh } = samOverlaySize(clip.width, clip.height);
  const kx = ow / clip.width, ky = oh / clip.height;
  const styles: ObjectStyle[] = reader.set.objects.map((object, index) => {
    const color = SAM_OVERLAY_PALETTE[index % SAM_OVERLAY_PALETTE.length];
    const label = cleanText(objectLabels[object.objectId] ?? object.label, 48) || "Object";
    return { objectId: object.objectId, label, color, rgb: hexRgb(color), text: `${label} · #${object.objectId}`, trail: [], framesWithMask: 0 };
  });
  const size = chromeSize(ow, oh);
  const chipHeight = Math.round(size * 1.75), margin = Math.max(6, Math.round(size * 0.6));
  /** Object label chip: one line, ellipsized when long (labels are local prompt text, not disclosures). */
  const chip = (text: string, x: number, top: number, fill: string, maxWidth: number, opacity = 0.9) => {
    const color = samOverlayTextColor(fill);
    const probe = pill({ text, x: 0, top, height: chipHeight, maxWidth, size, minSize: Math.max(8, size * 0.7), face: "sansBold", fill, color, fillOpacity: opacity, paddingX: size * 0.6 });
    const width = probe.bounds.right - probe.bounds.left;
    return pill({ text, x: Math.max(margin / 2, Math.min(x, ow - width - margin / 2)), top, height: chipHeight, maxWidth, size, minSize: Math.max(8, size * 0.7), face: "sansBold", fill, color, fillOpacity: opacity, paddingX: size * 0.6 }).svg;
  };
  /** Fixed chrome (disclosure, HUD) at the left margin: wrapped, never truncated. */
  const chromeChip = (fitted: ChromeText, top: number, opacity: number): { svg: string; height: number } => {
    if (fitted.truncated) throw new SamOverlayError("The analysis preview label does not fit this video size.");
    const maxWidth = ow - margin * 2;
    if (fitted.lines.length === 1) {
      const laid = pill({ text: fitted.lines[0], x: margin, top, height: chipHeight, maxWidth, size: fitted.size, minSize: fitted.size, face: "sansBold", fill: "#111111", color: "#FFFFFF", fillOpacity: opacity, paddingX: size * 0.6 });
      return { svg: laid.svg, height: chipHeight };
    }
    const paddingX = size * 0.6, paddingY = size * 0.4;
    const lineAdvance = fitted.size * 1.18;
    const lines = fitted.lines.map((line, index) => textBlock({ text: line, x: margin + paddingX, top: top + paddingY + index * lineAdvance, maxWidth: maxWidth - paddingX * 2, maxLines: 1, preferredSize: fitted.size, minSize: fitted.size, face: "sansBold", color: "#FFFFFF" }));
    if (lines.some((line) => line.truncated)) throw new SamOverlayError("The analysis preview label does not fit this video size.");
    const width = Math.min(maxWidth, Math.max(...lines.map((line) => line.bounds.right - line.bounds.left)) + paddingX * 2);
    const height = Math.round(lines[lines.length - 1].bounds.bottom - top + paddingY);
    const rect = `<rect x="${margin}" y="${top}" width="${width.toFixed(1)}" height="${height}" rx="${Math.round(size * 0.6)}" fill="#111111" fill-opacity="${opacity}"/>`;
    return { svg: rect + lines.map((line) => line.svg).join(""), height };
  };
  const disclosure = fitChrome(SAM_OVERLAY_LABEL, ow - margin * 2, size);
  if (disclosure.truncated) throw new SamOverlayError("The analysis preview label does not fit this video size.");
  const bannerHeight = chromeChip(disclosure, 0, 0.86).height;
  const bannerTop = oh - margin - bannerHeight;
  const banner = chromeChip(disclosure, bannerTop, 0.86).svg;
  const hudText = (visible: number, position: number) => `SAM 3.1 · ${visible} object${visible === 1 ? "" : "s"} · frame ${position}/${frames}`;
  // HUD line count from its widest form, so the HUD does not jump between one and two lines.
  const widestHud = fitChrome(hudText(Math.max(2, styles.length), frames), ow - margin * 2, size);
  const hudLines = widestHud.lines.length, hudHeight = chromeChip(widestHud, 0, 0.8).height;

  try { await mkdir(dirname(outputPath), { recursive: true }); }
  catch { throw new SamOverlayError("The overlay output location could not be prepared."); }
  const encoder = openH264Encoder({ outputPath, width: ow, height: oh, fps: clip.fps, expectedFrames: frames, timeoutMs: options.timeoutMs ?? 300_000, crf: 20 });
  let video;
  try {
    let position = 0;
    for await (const decoded of readClipFrames(clip, { fromFrame, toFrame, width: ow, height: oh })) {
      if (position >= frames) throw new SamOverlayError("The footage stream did not match the overlay window.");
      const rgba = decoded.rgba;
      const labels: string[] = [];
      let visible = 0;
      for (const style of styles) {
        const mask = await reader.frameMask(style.objectId, decoded.frame);
        const painted = mask ? paintMask(rgba, ow, oh, kx, ky, mask, style.rgb) : null;
        style.trail = style.trail.filter((point) => decoded.frame - point.frame < TRAIL_FRAMES);
        if (!painted) continue;
        visible++; style.framesWithMask++;
        style.trail.push({ x: painted.cx, y: painted.cy, frame: decoded.frame });
        const above = painted.top - chipHeight - 4;
        labels.push(chip(style.text, painted.left, above >= margin * 2 + hudHeight ? above : Math.min(painted.top + 4, bannerTop - chipHeight - 4), style.color, Math.round(ow * 0.6)));
      }
      const radius = Math.max(2, size * 0.22);
      const trails = styles.flatMap((style) => style.trail.map((point) => {
        const age = decoded.frame - point.frame, opacity = (1 - age / TRAIL_FRAMES) * 0.9;
        return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${(radius * (age ? 0.8 : 1.4)).toFixed(1)}" fill="${style.color}" fill-opacity="${opacity.toFixed(3)}" stroke="#000000" stroke-opacity="${(opacity * 0.5).toFixed(3)}" stroke-width="1"/>`;
      })).join("");
      const hud = chromeChip(fitChrome(hudText(visible, position + 1), ow - margin * 2, size, MAX_CHROME_LINES, Math.max(1, Math.min(hudLines, MAX_CHROME_LINES))), margin, 0.8).svg;
      const overlay = await sharp(Buffer.from(svgDocument(ow, oh, trails + labels.join("") + hud + banner))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (overlay.info.width !== ow || overlay.info.height !== oh || overlay.info.channels !== 4) throw new SamOverlayError("The overlay graphics could not be rendered.");
      compositeOver(rgba, overlay.data);
      await encoder.writeFrame(rgba);
      position++;
    }
    if (position !== frames) throw new SamOverlayError("The footage stream did not match the overlay window.");
    video = await encoder.finish();
  } catch (error) {
    await encoder.abort();
    if (error instanceof SamOverlayError || error instanceof CinemaEncodeError) throw error;
    throw new SamOverlayError("The SAM overlay video could not be composed.");
  }
  return {
    video: { sha256: video.sha256, bytes: video.bytes, frames: video.frames, durationSeconds: video.durationSeconds, width: ow, height: oh, fps: clip.fps },
    disclosure: { lines: disclosure.lines, fontSize: disclosure.size },
    objects: styles.map(({ objectId, label, color, framesWithMask }) => ({ objectId, label, color, framesWithMask })),
    label: SAM_OVERLAY_LABEL,
    window: { fromFrame, toFrame },
  };
}
