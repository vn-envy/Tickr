import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { probeVideo } from "../../lib/campaign/cinema/encode";
import { assertLedger, measureLedgerFrame } from "../../lib/campaign/cinema/ledger";
import {
  renderSamOverlayVideo, SAM_OVERLAY_LABEL, SAM_OVERLAY_PALETTE, samOverlayDisclosure, samOverlaySize, samOverlayTextColor,
} from "../../lib/campaign/cinema/overlay";
import {
  backedContrast, backingOpacity, CALLOUT_SAFE, HEADLINE_MEASURE_TOLERANCE, MAX_FOOTAGE_UPSCALE, MIN_DISPLAY_CONTRAST, MIN_TEXT_CONTRAST, planTrackedReel, prepareTrackedReel, renderTrackedReel, renderTrackedReelFrame, smoothTrack, TRACKED_COVER_FRAME, TRACKED_LABEL_BANDS, TRACKED_REEL_FRAMES,
  TrackedCinemaError, trackedMaskSigma, type TrackedCrop, type TrackedReelInput,
} from "../../lib/campaign/cinema/tracked";
import type { ClipFrame, FrameMask, MaskletReader, MaskletSet, NormalizedClip, OwnerMediaConsent } from "../../lib/media/cinema-types";
import {
  normalizeOwnerClip, normalizeOwnerRenderClip, OwnerClipError, readClipFrames, readRenderClipFrames, renderClipMatches, renderClipSize, verifyRenderClip, type OwnerRenderClip,
} from "../../lib/media/clip";
import { createMaskletWriter } from "../../lib/media/masklets";
import { MAX_FOREGROUND_OCCLUSION, MAX_HEADLINE_LINE_OCCLUSION, MAX_HEADLINE_OCCLUSION } from "../../lib/campaign/cinema/still-depth";
import type { TrackedReelComposer } from "../../lib/campaign/cinema/tracked";

// SYNTHETIC fixtures only: an FFmpeg lavfi testsrc2 pattern with a drawn red disk, masks computed
// from the same disk geometry, invented labels and copy. No real business media, no network.
const run = promisify(execFile);
const W = 1080, H = 1920;
const consent: OwnerMediaConsent = { ownsOrLicensedMedia: true, peopleVisibleHaveConsented: "no_people", attestedAt: "2026-11-04T00:00:00.000Z" };
const CLIP_W = 640, CLIP_H = 360, SECONDS = 5, RADIUS = 50, DISK_Y = 180;
/** Disk centre in clip pixels for frame f (matches the geq expression: 120 + 80·T). */
const diskX = (frame: number) => 120 + 80 * frame / 30;
/** Hero masks removed on these frames (tracking lost). */
const LOST = new Set([40, 41, 42, 43, 44]);
const BEST = 120;

let root = "";
let clip: NormalizedClip;
let reader: MaskletReader;

/** Mask of a disk centred at (cx, cy) in a width×height clip (pixel centres, like the geq expression). */
function circleMask(objectId: string, frame: number, cx: number, cy: number, radius: number, width: number, height: number, confidence: number): FrameMask {
  const left = Math.max(0, Math.floor(cx - radius - 1)), right = Math.min(width, Math.ceil(cx + radius + 1));
  const top = Math.max(0, Math.floor(cy - radius - 1)), bottom = Math.min(height, Math.ceil(cy + radius + 1));
  const span = right - left, raster = new Uint8Array(span * (bottom - top));
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) raster[(y - top) * span + x - left] = Math.hypot(x - cx, y - cy) < radius ? 1 : 0;
  return { objectId, frame, bounds: { left, top, right, bottom }, confidence, raster };
}

function diskMask(objectId: string, frame: number): FrameMask {
  return circleMask(objectId, frame, diskX(frame), DISK_Y, RADIUS, CLIP_W, CLIP_H, frame === BEST ? 0.99 : 0.9);
}

/** A synthetic testsrc2 clip with a red disk whose centre x is `xExpr` (an FFmpeg expression in T). */
async function syntheticDiskClip(name: string, width: number, height: number, seconds: number, xExpr: string, y: number | string, radius: number): Promise<NormalizedClip> {
  const raw = join(root, `${name}.mp4`), inside = `lt(hypot(X-(${xExpr}),Y-(${y})),${radius})`;
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=30:duration=${seconds}`,
    "-vf", `format=gbrp,geq=r='if(${inside},235,r(X,Y))':g='if(${inside},60,g(X,Y))':b='if(${inside},40,b(X,Y))',format=yuv420p`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p", raw,
  ], { timeout: 120_000 });
  return normalizeOwnerClip({ sourcePath: raw, outputDir: join(root, `${name}-clip`), consent, provenance: "owner_upload" });
}

async function diskMasklets(name: string, target: NormalizedClip, centre: (frame: number) => number, y: number, radius: number): Promise<MaskletReader> {
  const writer = await createMaskletWriter(join(root, `${name}-masklets`), { sha256: target.sha256, width: target.width, height: target.height, fps: target.fps, frameCount: target.frameCount });
  for (let frame = 0; frame < target.frameCount; frame++) await writer.add(circleMask("1", frame, centre(frame), y, radius, target.width, target.height, 0.9));
  return writer.commit({
    identity: () => ({ label: "Synthetic red disk", origin: "owner_tap" }),
    set: { responseId: `resp_synthetic_${name}`, promptKind: "geometry", propagation: "both", framesBilled: target.frameCount, elapsedMs: 1, createdAt: new Date(0).toISOString() },
    binding: { inputHash: "e".repeat(64), usage: { frames_processed: target.frameCount }, unmatchedPromptIds: [] },
  });
}

/** A planning-only masklet set over a longer (virtual) clip with the hero moving 1 px per frame. */
function longSet(frameCount: number): MaskletSet {
  const hero = reader.set.objects.find((object) => object.objectId === "1")!;
  const track = Array.from({ length: frameCount }, (_, frame) => {
    const cx = 100 + frame;
    return { frame, cx, cy: 180, area: 7850, bounds: { left: cx - 50, top: 130, right: cx + 50, bottom: 230 }, confidence: 0.9 };
  });
  return { ...reader.set, clip: { ...reader.set.clip, frameCount }, objects: [{ ...hero, firstFrame: 0, lastFrame: frameCount - 1, framesPresent: frameCount, track }] };
}

async function endCardStill() {
  const svg = (body: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280">${body}</svg>`)).png().toBuffer();
  const source = await svg(`<rect width="720" height="1280" fill="#2f4858"/><rect y="900" width="720" height="380" fill="#8a6a4a"/><circle cx="360" cy="700" r="220" fill="#e8452c"/>`);
  const subjectMask = await svg(`<rect width="720" height="1280" fill="#000"/><circle cx="360" cy="700" r="220" fill="#fff"/>`);
  const empty = await svg(`<rect width="720" height="1280" fill="#000"/>`);
  return { source, subjectMask, empty };
}

function panelMask(objectId: string, frame: number): FrameMask {
  const bounds = { left: 470, top: 250, right: 600, bottom: 330 };
  return { objectId, frame, bounds, confidence: null, raster: new Uint8Array(130 * 80).fill(1) };
}

const scenes = [
  { kicker: "Synthetic hook", headline: "Watch it roll", body: "Synthetic fixture copy for the hook act." },
  { kicker: "Synthetic proof", headline: "Tracked frame by frame", body: "Synthetic fixture copy <b>&amp;</b> escaped." },
  { kicker: "Synthetic value", headline: "Real pixels only", body: "Nothing on the subject is generated." },
  { kicker: "Synthetic CTA", headline: "Come and see", body: "Synthetic fixture details, not a real address." },
];

function input(extra: Partial<TrackedReelInput> = {}): TrackedReelInput {
  return {
    clip, reader, heroObjectId: "1", scenes, cta: "Visit today", businessName: "Synthetic Fixture Cafe", campaignName: "Synthetic tracked campaign",
    mode: "synthetic", provenanceLabel: "Owner footage · SAM 3.1 selection", theme: { paper: "#F5EEDF", ink: "#263A30", accent: "#BB4D2F", soft: "#E1C69E" },
    outputPath: join(root, "out", "reel.mp4"), coverPath: join(root, "out", "cover.png"), ...extra,
  };
}

async function decodeFrame(frame: number): Promise<ClipFrame> {
  for await (const decoded of readClipFrames(clip, { fromFrame: frame, toFrame: frame })) return decoded;
  throw new Error("frame missing");
}

/** Per-frame caps from the live round-2 finding: the subject may hide ≤ 25% of a depth headline and ≤ 20% of any line in any frame. */
const FRAME_HEADLINE_CAP = 0.25, FRAME_LINE_CAP = 0.2;
test("the shared depth-headline caps are per-frame caps at the live round-2 limits", () => {
  expect(MAX_HEADLINE_OCCLUSION).toBeLessThanOrEqual(FRAME_HEADLINE_CAP);
  expect(MAX_HEADLINE_LINE_OCCLUSION).toBeLessThanOrEqual(FRAME_LINE_CAP);
});

/** Draws every hook and value frame and returns the rendered depth-headline occlusion per frame. */
async function headlineFrames(composer: TrackedReelComposer, source: NormalizedClip, masks: MaskletReader) {
  const out: { index: number; act: string; whole: number; line: number | null | undefined }[] = [];
  const frames: ClipFrame[] = [];
  for await (const decoded of readClipFrames(source, { fromFrame: 0, toFrame: composer.plan.footageFrames - 1 })) frames.push(decoded);
  for (const act of ["hook", "value"] as const) {
    const [start, end] = composer.plan.acts[act];
    for (let index = start; index < end; index++) {
      const frame = composer.plan.frames[index];
      const { stats } = composer.draw(index, frames[frame.sourceFrame!], await masks.frameMask("1", frame.sourceFrame!));
      if (stats.headlineOcclusion !== null) out.push({ index, act, whole: stats.headlineOcclusion, line: stats.headlineLineOcclusion });
    }
  }
  return out;
}

/** Independent bilinear reference of the reframed source (edge-clamped, pixel centres at +0.5). */
function reference(source: ClipFrame, crop: TrackedCrop, x: number, y: number, channel: number): number {
  const s = W / crop.width;
  const u = Math.min(source.width - 1, Math.max(0, crop.x + (x + 0.5) / s - 0.5)), v = Math.min(source.height - 1, Math.max(0, crop.y + (y + 0.5) / s - 0.5));
  const i0 = Math.max(0, Math.min(source.width - 2, Math.floor(u))), j0 = Math.max(0, Math.min(source.height - 2, Math.floor(v)));
  const fx = u - i0, fy = v - j0, p = (j0 * source.width + i0) * 4 + channel, row = source.width * 4;
  const top = source.rgba[p] * (1 - fx) + source.rgba[p + 4] * fx, bottom = source.rgba[p + row] * (1 - fx) + source.rgba[p + row + 4] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Compares output pixels inside the disk eroded by 3 clip pixels with the reframed source. */
function compareSubject(rgba: Buffer, source: ClipFrame, crop: TrackedCrop, diskCentre: number) {
  const s = W / crop.width, cx = (diskCentre - crop.x) * s, cy = (DISK_Y - crop.y) * s, r = (RADIUS - 3) * s;
  let count = 0, worst = 0, treatedDiff = 0;
  for (let y = Math.max(TRACKED_LABEL_BANDS.top.bottom, Math.floor(cy - r)); y < Math.min(TRACKED_LABEL_BANDS.bottom.top, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, Math.ceil(cx + r)); x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) >= r) continue;
      count++;
      for (let c = 0; c < 3; c++) {
        const expected = reference(source, crop, x, y, c), actual = rgba[(y * W + x) * 4 + c];
        worst = Math.max(worst, Math.abs(actual - Math.round(expected)));
        treatedDiff += Math.abs(actual - expected);
      }
    }
  }
  return { count, worst, meanDiff: treatedDiff / Math.max(1, count * 3) };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tickr-tracked-"));
  await mkdir(join(root, "out"), { recursive: true });
  const raw = join(root, "synthetic-disk.mp4");
  const inside = `lt(hypot(X-(120+80*T),Y-${DISK_Y}),${RADIUS})`;
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", `testsrc2=size=${CLIP_W}x${CLIP_H}:rate=30:duration=${SECONDS}`,
    "-vf", `format=gbrp,geq=r='if(${inside},235,r(X,Y))':g='if(${inside},60,g(X,Y))':b='if(${inside},40,b(X,Y))',format=yuv420p`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p", raw,
  ], { timeout: 120_000 });
  clip = await normalizeOwnerClip({ sourcePath: raw, outputDir: join(root, "clip"), consent, provenance: "owner_upload" });
  expect(clip).toMatchObject({ width: CLIP_W, height: CLIP_H, fps: 30, frameCount: SECONDS * 30 });
  const writer = await createMaskletWriter(join(root, "masklets"), { sha256: clip.sha256, width: clip.width, height: clip.height, fps: clip.fps, frameCount: clip.frameCount });
  for (let frame = 0; frame < clip.frameCount; frame++) {
    if (!LOST.has(frame)) await writer.add(diskMask("1", frame));
    await writer.add(panelMask("2", frame));
  }
  reader = await writer.commit({
    identity: (objectId) => objectId === "1" ? { label: "Synthetic red disk", origin: "owner_tap" } : { label: "Synthetic panel", origin: "spark_grounding" },
    set: { responseId: "resp_synthetic_test", promptKind: "geometry", propagation: "both", framesBilled: 150, elapsedMs: 1, createdAt: new Date(0).toISOString() },
    binding: { inputHash: "b".repeat(64), usage: { frames_processed: 150 }, unmatchedPromptIds: [] },
  });
}, 120_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("tracked Reel planning", () => {
  test("zero-phase smoothing follows a ramp without lag and damps jitter", () => {
    const ramp = Array.from({ length: 120 }, (_, i) => i * 2);
    const smoothed = smoothTrack(ramp, 0.16);
    for (let i = 30; i < 90; i++) expect(Math.abs(smoothed[i] - ramp[i])).toBeLessThan(0.05);
    const noisy = ramp.map((value, i) => value + (i % 2 ? 6 : -6));
    const cleaned = smoothTrack(noisy, 0.16);
    for (let i = 30; i < 90; i++) expect(Math.abs(cleaned[i] - ramp[i])).toBeLessThan(1);
  });

  test("the 9:16 crop follows the disk smoothly, stays inside the clip and marks lost frames", () => {
    const plan = planTrackedReel(reader.set, "1");
    expect(plan.footageFrames).toBe(150);
    expect(plan.acts).toEqual({ hook: [0, 50], proof: [50, 100], value: [100, 150], cta: [150, 360] });
    expect(plan.endCard).toEqual({ start: 150, frames: 210, kind: "freeze" });
    expect(plan.bestFrame).toBe(BEST);
    expect(plan.frames).toHaveLength(360);
    const footage = plan.frames.slice(0, 150);
    for (const frame of footage) {
      const crop = frame.crop!;
      expect(frame.kind).toBe("footage");
      expect(frame.sourceFrame).toBe(frame.index);
      expect(crop.width / crop.height).toBeCloseTo(W / H, 9);
      expect(crop.x).toBeGreaterThanOrEqual(0); expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(CLIP_W + 1e-9); expect(crop.y + crop.height).toBeLessThanOrEqual(CLIP_H + 1e-9);
      expect(frame.tracked).toBe(!LOST.has(frame.index));
      // Subject-aware reframing: the disk stays near the horizontal centre of the Reel.
      expect(Math.abs((diskX(frame.index) - crop.x) * W / crop.width - W / 2)).toBeLessThan(70);
    }
    const xs = footage.map((frame) => frame.crop!.x);
    expect(xs[149] - xs[0]).toBeGreaterThan(300);
    // No jitter: the crop path is smooth (bounded second differences).
    for (let i = 1; i < xs.length - 1; i++) expect(Math.abs(xs[i + 1] - 2 * xs[i] + xs[i - 1])).toBeLessThan(0.6);
    // The freeze end card holds the best tracked real frame.
    for (const frame of plan.frames.slice(150)) expect(frame).toMatchObject({ kind: "freeze", act: "cta", sourceFrame: BEST, tracked: true });
    expect(plan.frames[150].wash).toBeGreaterThan(0.9);
    expect(plan.frames[149].wash).toBeGreaterThan(0.9);
    expect(plan.frames[200].wash).toBe(0);
  });

  test("windows, still-depth end-card mapping and invalid references", () => {
    const windowed = planTrackedReel(reader.set, "1", { window: { fromFrame: 30, toFrame: 129 }, endCard: "still_depth" });
    expect(windowed.footageFrames).toBe(100);
    expect(windowed.frames[0].sourceFrame).toBe(30);
    expect(windowed.endCard).toEqual({ start: 100, frames: 260, kind: "still_depth" });
    expect(windowed.frames[100]).toMatchObject({ kind: "still_depth", endCardFrame: 270, sourceFrame: null });
    expect(windowed.frames[359].endCardFrame).toBe(359);
    expect(() => planTrackedReel(reader.set, "9")).toThrow(TrackedCinemaError);
    expect(() => planTrackedReel(reader.set, "1", { window: { fromFrame: 40, toFrame: 44 } })).toThrow("too short");
    expect(() => planTrackedReel(reader.set, "1", { window: { fromFrame: 0, toFrame: 13 } })).toThrow("too short");
    expect(planTrackedReel(reader.set, "1", { window: { fromFrame: 0, toFrame: 14 } }).acts.hook).toEqual([0, 5]);
    const untracked: MaskletSet = { ...reader.set, objects: reader.set.objects.map((object) => object.objectId === "1" ? { ...object, track: object.track.filter((point) => point.frame < 30) } : object) };
    expect(() => planTrackedReel(untracked, "1", { window: { fromFrame: 30, toFrame: 60 } })).toThrow("not tracked");
    expect(() => planTrackedReel(reader.set, "1", { window: { fromFrame: 10, toFrame: 150 } })).toThrow("outside the clip");
  });

  test("footage of 12 s or more fills the whole Reel; the CTA act plays over live footage", () => {
    const plan = planTrackedReel(longSet(400), "1");
    expect(plan.footageFrames).toBe(360);
    expect(plan.endCard).toEqual({ start: 360, frames: 0, kind: "none" });
    expect(plan.acts).toEqual({ hook: [0, 90], proof: [90, 180], value: [180, 270], cta: [270, 360] });
    expect(plan.frames.every((frame, index) => frame.kind === "footage" && frame.sourceFrame === index && frame.wash === 0)).toBe(true);
    expect(plan.frames[300]).toMatchObject({ act: "cta", actTime: 1, tracked: true });
    expect(plan.bestFrame).toBeGreaterThanOrEqual(0); expect(plan.bestFrame).toBeLessThan(360);
    // A still-depth end card is never requested when no end card is needed.
    expect(planTrackedReel(longSet(400), "1", { endCard: "still_depth" }).endCard.kind).toBe("none");
  });

  test("a window ending inside the CTA act splits the CTA across footage and the end card", () => {
    const still = planTrackedReel(longSet(400), "1", { window: { fromFrame: 0, toFrame: 299 }, endCard: "still_depth" });
    expect(still.footageFrames).toBe(300);
    expect(still.acts.cta).toEqual([270, 360]);
    expect(still.endCard).toEqual({ start: 300, frames: 60, kind: "still_depth" });
    expect(still.frames[285]).toMatchObject({ kind: "footage", act: "cta", sourceFrame: 285 });
    expect(still.frames[299].wash).toBeGreaterThan(0.9);
    expect(still.frames[300]).toMatchObject({ kind: "still_depth", act: "cta", endCardFrame: 270, actTime: 1 });
    expect(still.frames[359].endCardFrame).toBe(329);
    // Short end cards cut directly: no wash, and still-depth frames map to the end of its CTA scene.
    const short = planTrackedReel(longSet(400), "1", { window: { fromFrame: 0, toFrame: 329 }, endCard: "still_depth" });
    expect(short.endCard).toEqual({ start: 330, frames: 30, kind: "still_depth" });
    expect(short.frames[329].wash).toBe(0);
    expect(short.frames[330].endCardFrame).toBe(330);
    expect(short.frames[359].endCardFrame).toBe(359);
    const freeze = planTrackedReel(longSet(400), "1", { window: { fromFrame: 0, toFrame: 299 } });
    expect(freeze.frames[300]).toMatchObject({ kind: "freeze", act: "cta", sourceFrame: freeze.bestFrame, tracked: true });
    expect(freeze.bestFrame).toBeLessThanOrEqual(299);
  });

  test("rejects masklets bound to other clip bytes and non-30 fps clips with fixed messages", async () => {
    await expect(prepareTrackedReel(input({ clip: { ...clip, sha256: "c".repeat(64) } }))).rejects.toThrow("different clip bytes");
    await expect(prepareTrackedReel(input({ clip: { ...clip, fps: 25 } }))).rejects.toThrow("30 fps");
    await expect(prepareTrackedReel(input({ outputPath: "relative.mp4" }))).rejects.toThrow("The tracked Reel input is invalid.");
    await expect(prepareTrackedReel(input({ heroObjectId: "7" }))).rejects.toThrow("not part of this masklet set");
    await expect(prepareTrackedReel(input({ window: { fromFrame: 20, toFrame: 20 } }))).rejects.toThrow("too short");
    // Unexpected failures leave the public entry points only as fixed messages.
    const broken: MaskletReader = { set: reader.set, frameMask: async () => { throw new Error("/secret/local/path exploded"); } };
    await expect(renderTrackedReelFrame(input({ reader: broken }), 10)).rejects.toThrow(new TrackedCinemaError("The tracked Reel could not be composed."));
  });
});

describe("tracked Reel frames", () => {
  test("subject pixels equal the reframed source inside the eroded mask; the background is treated", async () => {
    const { rgba, frame, stats } = await renderTrackedReelFrame(input(), 30);
    expect(stats.maskPresent).toBe(true);
    const source = await decodeFrame(30);
    const subject = compareSubject(rgba, source, frame.crop!, diskX(30));
    expect(subject.count).toBeGreaterThan(150_000);
    expect(subject.worst).toBeLessThanOrEqual(1);
    // Away from the disk (dilated) and the label bands, the background is darkened relative to the source.
    const s = W / frame.crop!.width, cx = (diskX(30) - frame.crop!.x) * s, cy = (DISK_Y - frame.crop!.y) * s;
    let output = 0, original = 0;
    for (let y = 700; y < 1300; y += 3) for (let x = 0; x < W; x += 3) {
      if (Math.hypot(x - cx, y - cy) < (RADIUS + 12) * s) continue;
      for (let c = 0; c < 3; c++) { output += rgba[(y * W + x) * 4 + c]; original += reference(source, frame.crop!, x, y, c); }
    }
    expect(output / original).toBeLessThan(0.8);
  }, 60_000);

  test("a frame whose mask is missing shows the treated frame without a pop-out", async () => {
    const { rgba, frame, stats } = await renderTrackedReelFrame(input(), 42);
    expect(frame.tracked).toBe(false);
    expect(stats.maskPresent).toBe(false);
    const subject = compareSubject(rgba, await decodeFrame(42), frame.crop!, diskX(42));
    expect(subject.meanDiff).toBeGreaterThan(10);
  }, 60_000);

  test("the freeze end card shows the best tracked real frame with the subject popped", async () => {
    const { rgba, frame } = await renderTrackedReelFrame(input(), 300);
    expect(frame).toMatchObject({ kind: "freeze", sourceFrame: BEST, act: "cta" });
    const subject = compareSubject(rgba, await decodeFrame(BEST), frame.crop!, diskX(BEST));
    expect(subject.count).toBeGreaterThan(150_000);
    expect(subject.worst).toBeLessThanOrEqual(1);
  }, 60_000);

  test("the tracked callout stays inside the safe margins and near the subject", async () => {
    const composer = await prepareTrackedReel(input({ callout: "Synthetic offering" }));
    expect(composer.layout.calloutLabel).toBe("Synthetic offering");
    expect(composer.layout.conceptLabel).toBe("SYNTHETIC DEMO · CONCEPT");
    const [proofFrame, source] = [composer.plan.frames[75], await decodeFrame(75)];
    const mask = await reader.frameMask("1", 75);
    const withCallout = composer.draw(75, source, mask);
    const without = composer.draw(75, source, null);
    // The callout is drawn only while the subject is tracked; locate it by differences above/below the disk.
    const s = W / proofFrame.crop!.width, diskTop = (DISK_Y - RADIUS - proofFrame.crop!.y) * s, diskBottom = (DISK_Y + RADIUS - proofFrame.crop!.y) * s;
    let left = W, right = -1, top = H, bottom = -1;
    for (let y = 0; y < H; y++) {
      if (y >= diskTop - 4 && y < diskBottom + 4) continue;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (Math.abs(withCallout.rgba[i] - without.rgba[i]) + Math.abs(withCallout.rgba[i + 1] - without.rgba[i + 1]) > 60) {
          left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
      }
    }
    expect(right).toBeGreaterThan(left);
    expect(left).toBeGreaterThanOrEqual(CALLOUT_SAFE.left); expect(right).toBeLessThanOrEqual(CALLOUT_SAFE.right);
    expect(top).toBeGreaterThanOrEqual(CALLOUT_SAFE.top); expect(bottom).toBeLessThanOrEqual(CALLOUT_SAFE.bottom);
    expect(Math.abs((left + right) / 2 - (diskX(75) - proofFrame.crop!.x) * s)).toBeLessThan(40);
    expect(Math.min(Math.abs(bottom - diskTop), Math.abs(top - diskBottom))).toBeLessThan(60);
  }, 60_000);

  test("a still-depth end card is used when supplied; an unusable one falls back to the freeze", async () => {
    const { source, subjectMask, empty } = await endCardStill();
    const label = "Synthetic still · SAM cutout";
    const composer = await prepareTrackedReel(input({ endCard: { source, subjectMask, provenanceLabel: label } }));
    expect(composer.plan.endCard.kind).toBe("still_depth");
    expect(composer.endCardFallback).toBe(false);
    // The end card is a different source asset: it carries its own provenance, not the footage label.
    expect(composer.endCard).toMatchObject({ source: "owner_still", provenanceLabel: label });
    expect(composer.endCard.stillDepthLayout?.provenanceLabel).toBe(label);
    // There is no guessed default: an end card without its own provenance label is rejected.
    await expect(prepareTrackedReel(input({ endCard: { source, subjectMask } as unknown as TrackedReelInput["endCard"] }))).rejects.toThrow("The tracked Reel input is invalid.");
    const first = composer.draw(150, null, null), last = composer.draw(359, null, null);
    expect(first.rgba.length).toBe(W * H * 4);
    expect(last.canvas.subjectInstances.length).toBeGreaterThan(0);
    const fallback = await prepareTrackedReel(input({ endCard: { source, subjectMask: empty, provenanceLabel: label } }));
    expect(fallback.endCardFallback).toBe(true);
    expect(fallback.plan.endCard.kind).toBe("freeze");
    expect(fallback.endCard).toEqual({ source: "footage_freeze", provenanceLabel: "Owner footage · SAM 3.1 selection", stillDepthLayout: null });
    // Undecodable end-card bytes also fall back instead of failing the Reel.
    const garbage = await prepareTrackedReel(input({ endCard: { source: new Uint8Array(64).fill(7), subjectMask, provenanceLabel: label } }));
    expect(garbage.endCardFallback).toBe(true);
  }, 120_000);
});

describe("tracked Reel render", () => {
  test("renders the Reel contract with a freeze end card and an honest ledger", async () => {
    const result = await renderTrackedReel(input());
    const video = await readFile(join(root, "out", "reel.mp4"));
    expect(result.reel).toMatchObject({ frames: 360, durationSeconds: 12, width: 1080, height: 1920, fps: 30, bytes: video.length, sha256: createHash("sha256").update(video).digest("hex") });
    expect(await probeVideo(join(root, "out", "reel.mp4"))).toMatchObject({ width: 1080, height: 1920, codec: "h264", frameRate: "30/1", frames: 360, durationSeconds: 12, audioStreams: 0 });
    const cover = await readFile(join(root, "out", "cover.png"));
    expect(await sharp(cover).metadata()).toMatchObject({ format: "png", width: 1080, height: 1920 });
    expect(result.cover).toMatchObject({ frame: TRACKED_COVER_FRAME, bytes: cover.length, sha256: createHash("sha256").update(cover).digest("hex") });
    expect(result.timeline).toMatchObject({ footageFrames: 150, bestFrame: BEST, endCard: { start: 150, frames: 210, kind: "freeze" } });
    const { ledger } = result;
    assertLedger(ledger);
    expect(ledger.frames).toBe(360);
    expect(ledger.generatedPixelsOnSubject).toBe(0);
    expect(ledger.meanGeneratedFraction).toBe(0);
    expect(ledger.meanSubjectSourceFraction).toBeGreaterThan(0.05);
    expect(ledger.meanTreatedSourceFraction).toBeGreaterThan(0.3);
    // Exactly the frames whose hero mask was removed count as "without subject".
    expect(ledger.framesWithoutSubject).toBe(LOST.size);
    expect(result.qa.footageFramesWithoutMask).toBe(LOST.size);
    expect(result.qa.violations).toContain("tracking_lost");
    expect(result.qa.violations).not.toContain("subject_missing");
    expect(result.qa.violations).not.toContain("foreground_occlusion");
    expect(result.qa.framesSubjectHiddenByTransition).toBeLessThanOrEqual(8);
    expect(result.qa.headlineOcclusion.max).toBeLessThanOrEqual(1);
    expect(result.layout).toMatchObject({ provenanceLabel: "Owner footage · SAM 3.1 selection", calloutLabel: "Synthetic red disk" });
    expect(result.endCard).toEqual({ source: "footage_freeze", provenanceLabel: "Owner footage · SAM 3.1 selection", stillDepthLayout: null });
    // A 640×360 tracking clip is enlarged several times into the 1080×1920 Reel: that is a QA flag, never silent.
    expect(result.qa.footageUpscale).toMatchObject({ source: "tracking_clip", sourceWidth: CLIP_W, sourceHeight: CLIP_H });
    expect(result.qa.footageUpscale.mean).toBeGreaterThan(5);
    expect(result.qa.footageUpscale.framesOverLimit).toBe(360);
    expect(result.qa.violations).toContain("low_resolution_footage");
  }, 300_000);

  test("a failed re-render keeps the previous cover and MP4 paired and leaves no staged files", async () => {
    const [reelBefore, coverBefore] = await Promise.all([readFile(join(root, "out", "reel.mp4")), readFile(join(root, "out", "cover.png"))]);
    // Fails after the cover frame (60) has been composed (odd frames are not read while laying out).
    const failing: MaskletReader = { set: reader.set, frameMask: async (objectId, frame) => { if (frame === 101) throw new Error("synthetic read failure"); return reader.frameMask(objectId, frame); } };
    await expect(renderTrackedReel(input({ reader: failing }))).rejects.toThrow(new TrackedCinemaError("The tracked Reel could not be composed."));
    expect((await readFile(join(root, "out", "reel.mp4"))).equals(reelBefore)).toBe(true);
    expect((await readFile(join(root, "out", "cover.png"))).equals(coverBefore)).toBe(true);
    expect((await readdir(join(root, "out"))).filter((name) => name.includes(".partial"))).toEqual([]);
  }, 300_000);

  test("renders a still-depth owner-photo end card after a shorter footage window", async () => {
    const { source, subjectMask } = await endCardStill();
    const outputPath = join(root, "out", "end-card-reel.mp4"), coverPath = join(root, "out", "end-card-cover.png");
    const result = await renderTrackedReel(input({ window: { fromFrame: 0, toFrame: 119 }, endCard: { source, subjectMask, provenanceLabel: "Owner photo · synthetic still" }, outputPath, coverPath }));
    expect(await probeVideo(outputPath)).toMatchObject({ width: 1080, height: 1920, codec: "h264", frameRate: "30/1", frames: 360, durationSeconds: 12, audioStreams: 0 });
    expect(result.timeline).toMatchObject({ footageFrames: 120, endCard: { start: 120, frames: 240, kind: "still_depth" } });
    expect(result.endCard).toMatchObject({ source: "owner_still", provenanceLabel: "Owner photo · synthetic still" });
    expect(result.endCard.stillDepthLayout).not.toBeNull();
    assertLedger(result.ledger);
    expect(result.ledger.frames).toBe(360);
    expect(result.ledger.generatedPixelsOnSubject).toBe(0);
    expect(result.qa.violations).not.toContain("end_card_fallback");
    expect(result.qa.footageFramesWithoutMask).toBe(LOST.size);
  }, 300_000);
});

describe("SAM overlay video", () => {
  test("renders every tracked object tinted and labelled at the clip's own size", async () => {
    const outputPath = join(root, "out", "overlay.mp4");
    const result = await renderSamOverlayVideo({ clip, reader, outputPath, objectLabels: { 1: "Synthetic <disk> & co" } });
    expect(result.label).toBe(SAM_OVERLAY_LABEL);
    expect(result.video).toMatchObject({ width: CLIP_W, height: CLIP_H, frames: 150, fps: 30 });
    expect(await probeVideo(outputPath)).toMatchObject({ width: CLIP_W, height: CLIP_H, codec: "h264", frameRate: "30/1", frames: 150, audioStreams: 0 });
    expect(result.objects).toEqual([
      { objectId: "1", label: "Synthetic <disk> & co", color: SAM_OVERLAY_PALETTE[0], framesWithMask: 150 - LOST.size },
      { objectId: "2", label: "Synthetic panel", color: SAM_OVERLAY_PALETTE[1], framesWithMask: 150 },
    ]);
    const { stdout } = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", outputPath, "-vf", "select=eq(n\\,90)", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
    const pixel = (x: number, y: number) => Array.from(stdout.subarray((y * CLIP_W + x) * 3, (y * CLIP_W + x) * 3 + 3));
    // Disk interior: red (235,60,40) tinted 45% toward orange (230,159,0) → about (233,105,22).
    const [r, g, b] = pixel(Math.round(diskX(90)), DISK_Y + 20);
    expect(Math.abs(r - 233)).toBeLessThan(25); expect(Math.abs(g - 105)).toBeLessThan(25); expect(b).toBeLessThan(60);
    expect(samOverlaySize(1280, 720)).toEqual({ width: 1080, height: 606 });
    expect(samOverlaySize(720, 1280)).toEqual({ width: 606, height: 1080 });
    expect(result.disclosure.lines.join(" ")).toBe(SAM_OVERLAY_LABEL);
    await expect(renderSamOverlayVideo({ clip: { ...clip, sha256: "d".repeat(64) }, reader, outputPath, objectLabels: {} })).rejects.toThrow("different clip bytes");
    await expect(renderSamOverlayVideo({ clip: { ...clip, fps: 25 }, reader, outputPath, objectLabels: {} })).rejects.toThrow("different clip bytes");
    await expect(renderSamOverlayVideo({ clip, reader, outputPath, objectLabels: {}, window: { fromFrame: 10, toFrame: 5 } })).rejects.toThrow("outside the clip");
  }, 180_000);

  test("sizes, disclosure fitting and label contrast", () => {
    expect(samOverlaySize(1280, 720)).toEqual({ width: 1080, height: 606 });
    expect(samOverlaySize(160, 284)).toEqual({ width: 360, height: 638 });
    expect(samOverlaySize(64, 64)).toEqual({ width: 360, height: 360 });
    expect(samOverlaySize(200, 1280)).toEqual({ width: 168, height: 1080 });
    // The disclosure is never ellipsized: it wraps on narrow overlays, and only an impossible width reports truncation.
    for (const [width, height] of [[1080, 1920], [360, 638], [240, 1080], [168, 1080], [120, 1080]] as const) {
      const laid = samOverlayDisclosure(width, height);
      expect(laid.truncated).toBe(false);
      expect(laid.lines.join(" ")).toBe(SAM_OVERLAY_LABEL);
      expect(laid.lines.join("")).not.toContain("…");
    }
    expect(samOverlayDisclosure(168, 1080).lines.length).toBeGreaterThan(1);
    expect(samOverlayDisclosure(40, 1080).truncated).toBe(true);
    // Chip text takes the higher-contrast colour: dark on the mid-luminance Okabe–Ito greens and vermilion.
    expect(samOverlayTextColor("#009E73")).toBe("#111111");
    expect(samOverlayTextColor("#D55E00")).toBe("#111111");
    expect(samOverlayTextColor("#0072B2")).toBe("#FFFFFF");
    expect(samOverlayTextColor("#111111")).toBe("#FFFFFF");
  });

  test("downscales a 1280×720 clip to 1080×606 and keeps masks registered", async () => {
    const wide = await syntheticDiskClip("wide", 1280, 720, 1, "240+160*T", 360, 100);
    expect(wide).toMatchObject({ width: 1280, height: 720, fps: 30 });
    const wideReader = await diskMasklets("wide", wide, (frame) => 240 + 160 * frame / 30, 360, 100);
    const outputPath = join(root, "out", "overlay-wide.mp4");
    const result = await renderSamOverlayVideo({ clip: wide, reader: wideReader, outputPath, objectLabels: {}, window: { fromFrame: 10, toFrame: 14 } });
    expect(result.video).toMatchObject({ width: 1080, height: 606, frames: 5, fps: 30 });
    expect(await probeVideo(outputPath)).toMatchObject({ width: 1080, height: 606, codec: "h264", frames: 5 });
    const { stdout } = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", outputPath, "-vf", "select=eq(n\\,2)", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
    // Output frame 2 is clip frame 12; the disk centre scales by 1080/1280 and 606/720.
    const at = (x: number, y: number) => Array.from(stdout.subarray((y * 1080 + x) * 3, (y * 1080 + x) * 3 + 3));
    const [r, g, b] = at(Math.round((240 + 160 * 12 / 30) * 1080 / 1280), Math.round((360 + 30) * 606 / 720));
    expect(Math.abs(r - 233)).toBeLessThan(25); expect(Math.abs(g - 105)).toBeLessThan(25); expect(b).toBeLessThan(60);
    expect(result.objects[0].framesWithMask).toBe(5);
  }, 180_000);

  test("upscales a tiny 160×284 clip so the full disclosure stays legible", async () => {
    const tiny = await syntheticDiskClip("tiny", 160, 284, 1, "80", 142, 30);
    expect(tiny).toMatchObject({ width: 160, height: 284 });
    const tinyReader = await diskMasklets("tiny", tiny, () => 80, 142, 30);
    const outputPath = join(root, "out", "overlay-tiny.mp4");
    const result = await renderSamOverlayVideo({ clip: tiny, reader: tinyReader, outputPath, objectLabels: { 1: "Synthetic disk" }, window: { fromFrame: 0, toFrame: 3 } });
    expect(result.video).toMatchObject({ width: 360, height: 638, frames: 4 });
    expect(result.disclosure.lines.join(" ")).toBe(SAM_OVERLAY_LABEL);
    const { stdout } = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", outputPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
    const [r, g, b] = Array.from(stdout.subarray((Math.round(152 * 638 / 284) * 360 + 180) * 3, (Math.round(152 * 638 / 284) * 360 + 180) * 3 + 3));
    expect(Math.abs(r - 233)).toBeLessThan(30); expect(Math.abs(g - 105)).toBeLessThan(30); expect(b).toBeLessThan(70);
    await expect(renderSamOverlayVideo({ clip: tiny, reader: tinyReader, outputPath, objectLabels: {}, window: { fromFrame: 0, toFrame: 0 } })).resolves.toMatchObject({ video: { frames: 1 } });
  }, 180_000);
});

// SYNTHETIC: a 4K landscape testsrc2 pattern (the common phone default the 1280-px tracking cap shrinks).
describe("render-resolution footage", () => {
  const SOURCE_W = 3840, SOURCE_H = 2160;
  /** A textured hero region in tracking-clip pixels (1280×720), constant on every frame. */
  const HERO = { left: 560, top: 260, right: 760, bottom: 460 };
  let source = "", tracking: NormalizedClip, render: OwnerRenderClip, heroReader: MaskletReader;
  const heroMask = (frame: number): FrameMask => ({ objectId: "1", frame, bounds: HERO, confidence: 0.95, raster: new Uint8Array((HERO.right - HERO.left) * (HERO.bottom - HERO.top)).fill(1) });
  const fourK = (extra: Partial<TrackedReelInput> = {}) => input({ clip: tracking, reader: heroReader, ...extra });

  beforeAll(async () => {
    source = join(root, "synthetic-4k.mp4");
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", `testsrc2=size=${SOURCE_W}x${SOURCE_H}:rate=30:duration=2`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p", source,
    ], { timeout: 180_000 });
    tracking = await normalizeOwnerClip({ sourcePath: source, outputDir: join(root, "clip-4k"), consent, provenance: "owner_upload" });
    expect(tracking).toMatchObject({ width: 1280, height: 720, frameCount: 60 });
    const rendered = await normalizeOwnerRenderClip({ tracking, sourcePath: source, outputDir: join(root, "clip-4k"), consent, cover: { width: W, height: H } });
    expect(rendered).not.toBeNull();
    render = rendered!;
    const writer = await createMaskletWriter(join(root, "masklets-4k"), { sha256: tracking.sha256, width: tracking.width, height: tracking.height, fps: tracking.fps, frameCount: tracking.frameCount });
    for (let frame = 0; frame < tracking.frameCount; frame++) await writer.add(heroMask(frame));
    heroReader = await writer.commit({
      identity: () => ({ label: "Synthetic pattern", origin: "owner_tap" }),
      set: { responseId: "resp_synthetic_4k", promptKind: "geometry", propagation: "both", framesBilled: 60, elapsedMs: 1, createdAt: new Date(0).toISOString() },
      binding: { inputHash: "f".repeat(64), usage: { frames_processed: 60 }, unmatchedPromptIds: [] },
    });
  }, 300_000);

  test("the render source repeats the tracking frames at a size that covers the Reel 1:1", async () => {
    expect(renderClipSize(SOURCE_W, SOURCE_H, { width: W, height: H })).toEqual({ width: 3412, height: 1920 });
    expect(renderClipSize(1080, 1920, { width: W, height: H })).toEqual({ width: 1080, height: 1920 });
    expect(renderClipSize(7680, 4320, { width: W, height: H })).toEqual({ width: 3412, height: 1920 });
    expect(render).toMatchObject({ kind: "render_source", trackingSha256: tracking.sha256, width: 3412, height: 1920, fps: 30, frameCount: tracking.frameCount });
    await verifyRenderClip(render, tracking);
    expect(renderClipMatches(render, tracking)).toBe(true);
    expect(renderClipMatches({ ...render, trackingSha256: "a".repeat(64) }, tracking)).toBe(false);
    expect(renderClipMatches({ ...render, frameCount: 59 }, tracking)).toBe(false);
    expect(renderClipMatches({ ...render, width: 2400 }, tracking)).toBe(false);
    // Same frames: the render frame, downscaled to the tracking size, matches the tracking frame.
    let small: ClipFrame | null = null, large: ClipFrame | null = null;
    for await (const frame of readClipFrames(tracking, { fromFrame: 37, toFrame: 37 })) small = frame;
    for await (const frame of readRenderClipFrames(render, { fromFrame: 37, toFrame: 37, width: 1280, height: 720 })) large = frame;
    let diff = 0;
    for (let i = 0; i < small!.rgba.length; i += 4) for (let c = 0; c < 3; c++) diff += Math.abs(small!.rgba[i + c] - large!.rgba[i + c]);
    expect(diff / (1280 * 720 * 3)).toBeLessThan(4);
  });

  test("small sources need no render copy; other files, missing consent and tampering fail closed", async () => {
    expect(await normalizeOwnerRenderClip({ tracking: clip, sourcePath: join(root, "synthetic-disk.mp4"), outputDir: join(root, "clip"), consent, cover: { width: W, height: H } })).toBeNull();
    await expect(normalizeOwnerRenderClip({ tracking, sourcePath: join(root, "synthetic-disk.mp4"), outputDir: join(root, "clip-4k"), consent, cover: { width: W, height: H } }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(normalizeOwnerRenderClip({ tracking, sourcePath: source, outputDir: join(root, "clip-4k"), consent: { ...consent, ownsOrLicensedMedia: false }, cover: { width: W, height: H } }))
      .rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    const tampered = join(root, "clip-4k", "tampered-render.mp4");
    await copyFile(render.path, tampered);
    await writeFile(tampered, Buffer.from("x"), { flag: "a" });
    await expect(verifyRenderClip({ ...render, path: tampered }, tracking)).rejects.toBeInstanceOf(OwnerClipError);
    await expect(verifyRenderClip(render, clip)).rejects.toBeInstanceOf(OwnerClipError);
    // The Reel never guesses a mapping onto footage that is not the tracking clip's.
    await expect(prepareTrackedReel(fourK({ renderClip: { ...render, frameCount: 59 } }))).rejects.toThrow("render-resolution footage does not match");
    await expect(prepareTrackedReel(input({ renderClip: render }))).rejects.toThrow("render-resolution footage does not match");
  }, 120_000);

  test("hero pixels come from the render source, registered with the tracking crop, and are sharper", async () => {
    const index = 30;
    const sharp4k = await renderTrackedReelFrame(fourK({ renderClip: render }), index);
    const soft = await renderTrackedReelFrame(fourK(), index);
    const crop = sharp4k.frame.crop!;
    expect(soft.frame.crop).toEqual(crop);
    let frame: ClipFrame | null = null;
    for await (const decoded of readRenderClipFrames(render, { fromFrame: index, toFrame: index })) frame = decoded;
    const kx = render.width / tracking.width, ky = render.height / tracking.height;
    const sx = crop.width * kx / W, sy = crop.height * ky / H;
    const sample = (x: number, y: number, c: number) => {
      const u = Math.min(frame!.width - 1, Math.max(0, crop.x * kx + (x + 0.5) * sx - 0.5)), v = Math.min(frame!.height - 1, Math.max(0, crop.y * ky + (y + 0.5) * sy - 0.5));
      const i0 = Math.min(frame!.width - 2, Math.floor(u)), j0 = Math.min(frame!.height - 2, Math.floor(v)), fx = u - i0, fy = v - j0;
      const p = (j0 * frame!.width + i0) * 4 + c, row = frame!.width * 4, px = frame!.rgba;
      return (px[p] * (1 - fx) + px[p + 4] * fx) * (1 - fy) + (px[p + row] * (1 - fx) + px[p + row + 4] * fx) * fy;
    };
    // Output pixels of the eroded hero region (outside the label bands).
    const s = W / crop.width;
    const x0 = Math.ceil((HERO.left + 3 - crop.x) * s), x1 = Math.floor((HERO.right - 3 - crop.x) * s);
    const y0 = Math.max(TRACKED_LABEL_BANDS.top.bottom, Math.ceil((HERO.top + 3 - crop.y) * s)), y1 = Math.min(TRACKED_LABEL_BANDS.bottom.top, Math.floor((HERO.bottom - 3 - crop.y) * s));
    expect(x1 - x0).toBeGreaterThan(300); expect(y1 - y0).toBeGreaterThan(300);
    let worst = 0, energySharp = 0, energySoft = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        worst = Math.max(worst, Math.abs(sharp4k.rgba[o + c] - Math.round(sample(x, y, c))));
        if (x + 1 < x1) { energySharp += (sharp4k.rgba[o + 4 + c] - sharp4k.rgba[o + c]) ** 2; energySoft += (soft.rgba[o + 4 + c] - soft.rgba[o + c]) ** 2; }
      }
    }
    expect(worst).toBeLessThanOrEqual(1);
    expect(energySharp).toBeGreaterThan(energySoft * 1.5);
  }, 120_000);

  test("the Reel drawn from the render source is not flagged; the 1280-px tracking copy of 4K footage is", async () => {
    const composerSoft = await prepareTrackedReel(fourK());
    expect(composerSoft.footageUpscale).toMatchObject({ source: "tracking_clip", sourceWidth: 1280, sourceHeight: 720 });
    expect(composerSoft.footageUpscale.max).toBeGreaterThan(2.6);
    expect(composerSoft.footageUpscale.framesOverLimit).toBe(360);
    const outputPath = join(root, "out", "reel-4k.mp4"), coverPath = join(root, "out", "cover-4k.png");
    const result = await renderTrackedReel(fourK({ renderClip: render, outputPath, coverPath }));
    expect(await probeVideo(outputPath)).toMatchObject({ width: 1080, height: 1920, frames: 360, durationSeconds: 12 });
    expect(result.qa.footageUpscale).toMatchObject({ source: "render_clip", sourceWidth: 3412, sourceHeight: 1920, framesOverLimit: 0 });
    expect(result.qa.footageUpscale.max).toBeLessThanOrEqual(MAX_FOOTAGE_UPSCALE);
    expect(result.qa.violations).not.toContain("low_resolution_footage");
    expect(result.ledger.generatedPixelsOnSubject).toBe(0);
  }, 300_000);
});

// SYNTHETIC: masks rasterized from exact disks; live-run defects reproduced on generated footage only.
describe("tracked Reel edge quality and text legibility", () => {
  /** Per-pixel subject alpha recovered from frames drawn with and without the mask: with = without·(1−α) + source·α. */
  function alphaAt(withMask: Buffer, without: Buffer, source: ClipFrame, crop: TrackedCrop, x: number, y: number): number | null {
    let best = -1, alpha = 0;
    for (let c = 0; c < 3; c++) {
      const o = (y * W + x) * 4 + c, delta = reference(source, crop, x, y, c) - without[o];
      if (Math.abs(delta) > best) { best = Math.abs(delta); alpha = (withMask[o] - without[o]) / delta; }
    }
    return best >= 40 ? Math.min(1, Math.max(0, alpha)) : null;
  }

  test("the upsampled hero outline is smooth (no stair steps from the low-resolution SAM mask)", async () => {
    const composer = await prepareTrackedReel(input());
    const index = 30, frame = composer.plan.frames[index], crop = frame.crop!;
    const source = await decodeFrame(index), mask = (await reader.frameMask("1", index))!;
    const withMask = composer.draw(index, source, mask).rgba, without = composer.draw(index, source, null).rgba;
    const s = W / crop.width;
    expect(trackedMaskSigma(s)).toBeGreaterThan(1);
    // The mask disk is centred on pixel index diskX (pixel centres at +0.5 in clip coordinates).
    const cx = (diskX(index) + 0.5 - crop.x) * s, cy = (DISK_Y + 0.5 - crop.y) * s;
    const radii: number[] = [];
    for (let k = 0; k < 360; k++) {
      const theta = (k / 360) * 2 * Math.PI;
      let edge: number | null = null, previous: { r: number; a: number } | null = null;
      for (let r = (RADIUS - 5) * s; r <= (RADIUS + 5) * s; r += 0.25) {
        const x = Math.round(cx + Math.cos(theta) * r), y = Math.round(cy + Math.sin(theta) * r);
        if (y < TRACKED_LABEL_BANDS.top.bottom || y >= TRACKED_LABEL_BANDS.bottom.top) break;
        const a = alphaAt(withMask, without, source, crop, x, y);
        if (a === null) continue;
        if (previous && previous.a >= 0.5 && a < 0.5) { edge = previous.r + (r - previous.r) * (previous.a - 0.5) / (previous.a - a); break; }
        previous = { r, a };
      }
      if (edge !== null) radii.push(edge);
    }
    expect(radii.length).toBeGreaterThan(300);
    // Roughness: residual of the edge radius against its own ±12-sample moving average (a circle is constant).
    const residual = radii.map((r, i) => {
      let sum = 0;
      for (let d = -12; d <= 12; d++) sum += radii[(i + d + radii.length) % radii.length];
      return r - sum / 25;
    });
    const rms = Math.sqrt(residual.reduce((sum, value) => sum + value * value, 0) / residual.length);
    // A hard binary mask enlarged ~5.3× steps by about ±half a mask pixel (rms ≈ 1.1 output px here).
    expect(rms).toBeLessThan(0.75);
    // Smoothing does not shrink or grow the subject: the mean edge stays on the true disk radius.
    expect(Math.abs(radii.reduce((sum, value) => sum + value, 0) / radii.length / s - RADIUS)).toBeLessThan(0.6);
  }, 120_000);

  test("SAM specks and pin-holes never reach the Reel; the stored mask is untouched and the refinement is reported", async () => {
    const index = 30, clean = (await reader.frameMask("1", index))!;
    const noisy: FrameMask = { ...clean, raster: Uint8Array.from(clean.raster) };
    const span = clean.bounds.right - clean.bounds.left;
    // Two specks in the mask's empty corners and a 2×2 pin-hole inside the disk.
    for (const [x, y] of [[1, 1], [2, 1], [span - 2, 1], [span - 2, 2]]) noisy.raster[y * span + x] = 1;
    const centre = Math.floor((clean.bounds.bottom - clean.bounds.top) / 2) * span + Math.floor(span / 2);
    for (const offset of [0, 1, span, span + 1]) noisy.raster[centre + offset] = 0;
    const before = Uint8Array.from(noisy.raster);
    const composer = await prepareTrackedReel(input());
    const source = await decodeFrame(index);
    const a = composer.draw(index, source, clean), b = composer.draw(index, source, noisy);
    expect(b.rgba.equals(a.rgba)).toBe(true);
    expect(noisy.raster).toEqual(before);
    expect(a.stats.maskRefinement).toMatchObject({ removedPixels: 0, filledPixels: 0 });
    expect(b.stats.maskRefinement).toMatchObject({ removedPixels: 4, filledPixels: 4 });
  }, 120_000);

  describe("a subject moving down through the headline zone", () => {
    const VW = 640, VH = 360, VR = 70, VX = 320;
    /** Disk centre y for frame f: 30 + 60·T (it sweeps down the frame during the hook). */
    const diskY = (frame: number) => 30 + 60 * frame / 30;
    let vclip: NormalizedClip, vreader: MaskletReader;
    const copy = [
      { kicker: "Synthetic hook", headline: "Slow mornings start with warm cups", body: "Synthetic fixture copy for the hook act, long enough to read." },
      ...scenes.slice(1),
    ];
    const vinput = (extra: Partial<TrackedReelInput> = {}) => input({ clip: vclip, reader: vreader, scenes: copy, ...extra });

    beforeAll(async () => {
      const raw = join(root, "synthetic-vertical.mp4"), inside = `lt(hypot(X-${VX},Y-(30+60*T)),${VR})`;
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", `testsrc2=size=${VW}x${VH}:rate=30:duration=4`,
        "-vf", `format=gbrp,geq=r='if(${inside},235,r(X,Y))':g='if(${inside},60,g(X,Y))':b='if(${inside},40,b(X,Y))',format=yuv420p`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p", raw,
      ], { timeout: 120_000 });
      vclip = await normalizeOwnerClip({ sourcePath: raw, outputDir: join(root, "vertical-clip"), consent, provenance: "owner_upload" });
      const writer = await createMaskletWriter(join(root, "vertical-masklets"), { sha256: vclip.sha256, width: vclip.width, height: vclip.height, fps: vclip.fps, frameCount: vclip.frameCount });
      for (let frame = 0; frame < vclip.frameCount; frame++) await writer.add(circleMask("1", frame, VX, diskY(frame), VR, VW, VH, 0.9));
      vreader = await writer.commit({
        identity: () => ({ label: "Synthetic red disk", origin: "owner_tap" }),
        set: { responseId: "resp_synthetic_vertical", promptKind: "geometry", propagation: "both", framesBilled: vclip.frameCount, elapsedMs: 1, createdAt: new Date(0).toISOString() },
        binding: { inputHash: "d".repeat(64), usage: { frames_processed: vclip.frameCount }, unmatchedPromptIds: [] },
      });
    }, 180_000);

    test("the hook headline is placed against the whole act: the passing subject hides at most the planned share", async () => {
      const composer = await prepareTrackedReel(vinput());
      const [start, end] = composer.plan.acts.hook;
      const sources: ClipFrame[] = [];
      for await (const decoded of readClipFrames(vclip, { fromFrame: start, toFrame: end - 1 })) sources.push(decoded);
      const measured: number[] = [];
      for (let index = start; index < end; index++) {
        const { stats } = composer.draw(index, sources[index - start], await vreader.frameMask("1", index));
        if (stats.headlineOcclusion !== null) measured.push(stats.headlineOcclusion);
      }
      const report = composer.layout.hookHeadline;
      if (report.placement === "behind_subject") {
        expect(report.occlusion).toBeLessThanOrEqual(MAX_HEADLINE_OCCLUSION);
        // Regression (live round 2): the act mean passed while single frames hid whole words.
        expect(report.maxFrameOcclusion).toBeLessThanOrEqual(FRAME_HEADLINE_CAP);
        expect(report.maxFrameLineOcclusion).toBeLessThanOrEqual(FRAME_LINE_CAP);
        expect(Math.max(...measured)).toBeLessThanOrEqual(FRAME_HEADLINE_CAP + HEADLINE_MEASURE_TOLERANCE);
        expect(measured.length).toBeGreaterThan(10);
        const mean = measured.reduce((sum, value) => sum + value, 0) / measured.length;
        expect(mean).toBeLessThanOrEqual(MAX_HEADLINE_OCCLUSION + 0.05);
        expect(Math.abs(mean - report.occlusion)).toBeLessThan(0.1);
      } else {
        // In front, on its own backing: it is never hidden, and the choice is reported.
        expect(measured).toEqual([]);
        expect(report.foregroundOcclusion).toBeLessThan(1);
      }
    }, 180_000);

    test("every visible frame of the swept hook and value keeps each headline line readable", async () => {
      const composer = await prepareTrackedReel(vinput());
      const measured = await headlineFrames(composer, vclip, vreader);
      for (const report of [composer.layout.hookHeadline, composer.layout.valueHeadline]) {
        if (report.placement === "behind_subject") expect(report.framesChecked).toBeGreaterThan(0);
        expect(report.maxFrameOcclusion).toBeLessThanOrEqual(FRAME_HEADLINE_CAP);
        expect(report.maxFrameLineOcclusion).toBeLessThanOrEqual(FRAME_LINE_CAP);
      }
      for (const frame of measured) {
        expect(frame.whole, `${frame.act} frame ${frame.index}`).toBeLessThanOrEqual(FRAME_HEADLINE_CAP + HEADLINE_MEASURE_TOLERANCE);
        expect(frame.line, `${frame.act} frame ${frame.index}`).toBeLessThanOrEqual(FRAME_LINE_CAP + HEADLINE_MEASURE_TOLERANCE);
      }
    }, 180_000);

    test("text backings sit beneath the subject: the swept Reel renders without foreground_occlusion", async () => {
      // Regression: front-text backings drawn over the subject hid >10% of it in the CTA act (frame 137)
      // and the produced Reel was withheld. Backings are drawn beneath the subject; only glyphs are in front.
      const result = await renderTrackedReel(vinput({ outputPath: join(root, "out", "sweep.mp4"), coverPath: join(root, "out", "sweep.png") }));
      expect(result.qa.violations).not.toContain("foreground_occlusion");
      expect(result.ledger.maxSubjectOcclusion).toBeLessThanOrEqual(MAX_FOREGROUND_OCCLUSION / 2);
      // The rendered per-frame headline occlusion is recorded and stays within the per-frame caps.
      expect(result.qa.violations).not.toContain("headline_hidden");
      expect(result.qa.headlineOcclusion.max).toBeLessThanOrEqual(FRAME_HEADLINE_CAP + HEADLINE_MEASURE_TOLERANCE);
      expect(result.qa.headlineOcclusion.lineMax).toBeLessThanOrEqual(FRAME_LINE_CAP + HEADLINE_MEASURE_TOLERANCE);
      expect(result.layout.textContrast.backingLayer).toBe("beneath_subject");
      // Over the subject the front glyphs have no backing; how much of their area that is gets reported.
      expect(result.qa.frontTextOverSubject.max).toBeGreaterThanOrEqual(0);
      expect(result.qa.frontTextOverSubject.max).toBeLessThanOrEqual(1);
    }, 300_000);

    test("hook body copy keeps its contrast floor over bright footage", async () => {
      const theme = input().theme;
      // Worst case (pure white under the text) is covered by construction.
      const opacity = backingOpacity(theme.paper, theme.ink, MIN_TEXT_CONTRAST)!;
      expect(backedContrast(theme.paper, theme.ink, opacity)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      expect(backedContrast(theme.paper, theme.ink, Math.max(0, opacity - 0.05))).toBeLessThan(MIN_TEXT_CONTRAST);
      const composer = await prepareTrackedReel(vinput());
      expect(composer.layout.textContrast.body).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      expect(composer.layout.textContrast.display).toBeGreaterThanOrEqual(MIN_DISPLAY_CONTRAST);
      const bare = await prepareTrackedReel(vinput({ scenes: [{ ...copy[0], body: "" }, ...copy.slice(1)] }));
      // ~1.0 s: the hook body is fully shown over fully treated synthetic test-pattern footage.
      const index = 30;
      let source: ClipFrame | null = null;
      for await (const decoded of readClipFrames(vclip, { fromFrame: index, toFrame: index })) source = decoded;
      const mask = await vreader.frameMask("1", index);
      const withBody = composer.draw(index, source, mask).rgba, without = bare.draw(index, source, mask).rgba;
      const light = [0xF5, 0xEE, 0xDF];
      const lum = (rgba: Buffer, o: number) => {
        const [r, g, b] = [rgba[o], rgba[o + 1], rgba[o + 2]].map((v) => v / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      // Glyph cores: near the text colour and changed by the body text.
      const rows = [H - 320, TRACKED_LABEL_BANDS.bottom.top - 8];
      const glyph = new Uint8Array(W * H);
      let left = W, right = -1, top = H, bottom = -1;
      for (let y = rows[0]; y < rows[1]; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const near = Math.abs(withBody[o] - light[0]) + Math.abs(withBody[o + 1] - light[1]) + Math.abs(withBody[o + 2] - light[2]) < 45;
        const changed = Math.abs(withBody[o] - without[o]) + Math.abs(withBody[o + 1] - without[o + 1]) + Math.abs(withBody[o + 2] - without[o + 2]) > 60;
        if (near && changed) { glyph[y * W + x] = 1; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
      }
      expect(right - left).toBeGreaterThan(300);
      // The backdrop around the letters: inside the text box, at least 3 px from any glyph core.
      const backdrop: number[] = [];
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        let nearGlyph = false;
        for (let dy = -3; dy <= 3 && !nearGlyph; dy++) for (let dx = -3; dx <= 3; dx++) if (glyph[(y + dy) * W + x + dx]) { nearGlyph = true; break; }
        if (!nearGlyph) backdrop.push(lum(withBody, (y * W + x) * 4));
      }
      backdrop.sort((a, b) => a - b);
      const brightBackdrop = backdrop[Math.floor(backdrop.length * 0.95)];
      const textLum = lum(Buffer.from([...light, 255]), 0);
      expect((textLum + 0.05) / (brightBackdrop + 0.05)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }, 180_000);
  });

  // Regression (live round 2): the headline band was chosen on the act-mean subject cover, so a subject
  // that rose through the headline for a few frames mid-act (low mean) hid whole words in those frames.
  describe("a subject crossing the headline zone mid-act", () => {
    const CW = 640, CH = 360, CR = 52, CX = 320, LOW = 290, HIGH = 110;
    /** Low in the frame, rising into the headline zone for frames 10–19 (hook) and 70–79 (value). */
    const crossY = (frame: number) => (frame >= 10 && frame < 20) || (frame >= 70 && frame < 80) ? HIGH : LOW;
    let cclip: NormalizedClip, creader: MaskletReader;
    const copy = [
      { kicker: "Synthetic hook", headline: "Slow mornings, warm cups", body: "Synthetic fixture copy for the hook act." },
      scenes[1],
      { kicker: "Synthetic value", headline: "Your weekday pause", body: "Synthetic fixture copy for the value act." },
      scenes[3],
    ];
    const cinput = (extra: Partial<TrackedReelInput> = {}) => input({ clip: cclip, reader: creader, scenes: copy, ...extra });

    beforeAll(async () => {
      const yExpr = `if(between(N,10,19)+between(N,70,79),${HIGH},${LOW})`;
      cclip = await syntheticDiskClip("synthetic-crossing", CW, CH, 3, String(CX), yExpr, CR);
      const writer = await createMaskletWriter(join(root, "crossing-masklets"), { sha256: cclip.sha256, width: cclip.width, height: cclip.height, fps: cclip.fps, frameCount: cclip.frameCount });
      for (let frame = 0; frame < cclip.frameCount; frame++) await writer.add(circleMask("1", frame, CX, crossY(frame), CR, CW, CH, 0.9));
      creader = await writer.commit({
        identity: () => ({ label: "Synthetic red disk", origin: "owner_tap" }),
        set: { responseId: "resp_synthetic_crossing", promptKind: "geometry", propagation: "both", framesBilled: cclip.frameCount, elapsedMs: 1, createdAt: new Date(0).toISOString() },
        binding: { inputHash: "f".repeat(64), usage: { frames_processed: cclip.frameCount }, unmatchedPromptIds: [] },
      });
    }, 180_000);

    test("no single frame hides more than the per-frame caps of the hook or value headline", async () => {
      const composer = await prepareTrackedReel(cinput());
      expect(composer.plan.acts.hook).toEqual([0, 30]);
      expect(composer.plan.acts.value).toEqual([60, 90]);
      const measured = await headlineFrames(composer, cclip, creader);
      const { hookHeadline, valueHeadline } = composer.layout;
      for (const report of [hookHeadline, valueHeadline]) {
        expect(report.maxFrameOcclusion).toBeLessThanOrEqual(FRAME_HEADLINE_CAP);
        expect(report.maxFrameLineOcclusion).toBeLessThanOrEqual(FRAME_LINE_CAP);
        if (report.placement === "behind_subject") {
          expect(report.framesChecked).toBeGreaterThan(10);
          expect(report.occlusion).toBeLessThanOrEqual(report.maxFrameOcclusion);
        } else expect(report.occlusion).toBe(0);
      }
      // The headlines are behind the subject on frames it crosses, so those frames are measured too.
      const crossing = measured.filter((frame) => (frame.index >= 12 && frame.index < 20) || (frame.index >= 72 && frame.index < 80));
      if (hookHeadline.placement === "behind_subject" && valueHeadline.placement === "behind_subject") expect(crossing.length).toBeGreaterThan(8);
      for (const frame of measured) {
        expect(frame.whole, `${frame.act} frame ${frame.index}`).toBeLessThanOrEqual(FRAME_HEADLINE_CAP + HEADLINE_MEASURE_TOLERANCE);
        expect(frame.line, `${frame.act} frame ${frame.index}`).toBeLessThanOrEqual(FRAME_LINE_CAP + HEADLINE_MEASURE_TOLERANCE);
      }
    }, 180_000);
  });

  // Regression (live-4 follow-up): front-text backings drawn over the subject counted as hiding it and
  // pushed the ledger past MAX_FOREGROUND_OCCLUSION, so produce.ts withheld the Reel. A subject low in
  // the frame passes under the hook body copy; its backing must stay beneath the subject.
  describe("a subject low in the frame, under the body copy", () => {
    const LW_ = 640, LH_ = 360, LR = 60, LX = 320, LY = 290;
    let lclip: NormalizedClip, lreader: MaskletReader;
    const linput = (extra: Partial<TrackedReelInput> = {}) => input({ clip: lclip, reader: lreader, ...extra });

    beforeAll(async () => {
      lclip = await syntheticDiskClip("synthetic-low", LW_, LH_, 4, String(LX), LY, LR);
      lreader = await diskMasklets("synthetic-low", lclip, () => LX, LY, LR);
    }, 180_000);

    test("only glyphs, never their backing, cover the subject; the ledger stays under the occlusion cap", async () => {
      const composer = await prepareTrackedReel(linput());
      // Same Reel without the hook and CTA body copy (and so without their backings).
      const bare = await prepareTrackedReel(linput({ scenes: [{ ...scenes[0], body: "" }, scenes[1], scenes[2], { ...scenes[3], body: "" }] }));
      expect(composer.layout.textContrast.backingLayer).toBe("beneath_subject");
      const sources: ClipFrame[] = [];
      for await (const decoded of readClipFrames(lclip, { fromFrame: 0, toFrame: composer.plan.footageFrames - 1 })) sources.push(decoded);
      const worst: Record<string, number> = { hook: 0, proof: 0, value: 0, cta: 0 };
      let overSubject = 0, ctaBodyAdds = 0, farDarkened = 0, farCompared = 0;
      const [hookStart, hookEnd] = composer.plan.acts.hook;
      for (let index = 0; index < TRACKED_REEL_FRAMES; index++) {
        const frame = composer.plan.frames[index];
        if (frame.kind === "still_depth") continue;
        const source = sources[frame.sourceFrame!], mask = await lreader.frameMask("1", frame.sourceFrame!);
        const drawn = composer.draw(index, source, mask);
        const occlusion = measureLedgerFrame(drawn.canvas).subjectOcclusion;
        worst[frame.act] = Math.max(worst[frame.act], occlusion);
        overSubject = Math.max(overSubject, drawn.stats.frontTextOverSubject ?? 0);
        if (frame.act === "cta" && index % 4 === 0) ctaBodyAdds = Math.max(ctaBodyAdds, occlusion - measureLedgerFrame(bare.draw(index, source, mask).canvas).subjectOcclusion);
        // Hook body fully shown: subject pixels well away from any glyph are not darkened by the body's backing.
        if (frame.act !== "hook" || index < hookStart + 0.6 * (hookEnd - hookStart) || index > hookEnd - 8) continue;
        const without = bare.draw(index, source, mask).rgba, crop = frame.crop!, s = W / crop.width;
        const cx = (LX + 0.5 - crop.x) * s, cy = (LY + 0.5 - crop.y) * s, r = (LR - 4) * s;
        const glyph = new Uint8Array(W * H);
        for (let y = H - 420; y < TRACKED_LABEL_BANDS.bottom.top; y++) for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          if (drawn.rgba[o] + drawn.rgba[o + 1] + drawn.rgba[o + 2] > without[o] + without[o + 1] + without[o + 2] + 60) glyph[y * W + x] = 1;
        }
        for (let y = H - 400; y < TRACKED_LABEL_BANDS.bottom.top - 20; y += 2) for (let x = 20; x < W - 20; x += 2) {
          if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) >= r) continue;
          let near = false;
          for (let dy = -26; dy <= 26 && !near; dy += 2) for (let dx = -26; dx <= 26; dx += 2) if (glyph[(y + dy) * W + x + dx]) { near = true; break; }
          if (near) continue;
          const o = (y * W + x) * 4;
          farCompared++;
          if (without[o] + without[o + 1] + without[o + 2] - (drawn.rgba[o] + drawn.rgba[o + 1] + drawn.rgba[o + 2]) > 12) farDarkened++;
        }
      }
      // The scenario really puts body text over the subject…
      expect(overSubject).toBeGreaterThan(0.05);
      expect(farCompared).toBeGreaterThan(200);
      // …yet no backing darkens the subject away from the glyphs…
      expect(farDarkened / farCompared).toBeLessThan(0.02);
      // …and text over the subject hides only its glyph share (a front backing pushed the hook to ~0.08).
      expect(worst.hook).toBeLessThanOrEqual(0.04);
      expect(worst.proof).toBeLessThanOrEqual(0.04);
      expect(worst.value).toBeLessThanOrEqual(0.04);
      // In the CTA act the body copy adds only its glyphs on top of what the opaque CTA pill covers.
      expect(ctaBodyAdds).toBeLessThan(0.02);
    }, 300_000);
  });
});
