import { describe, expect, test } from "vitest";
import {
  CUT_DEPTH, MAX_ROUGHNESS, MIN_LARGEST_SHARE, MIN_SOLIDITY, maskQualityNote, maskShapeQuality, type MaskShapeQuality,
} from "../../lib/media/mask-quality";
import type { PixelBounds } from "../../lib/media/cinema-types";

// SYNTHETIC masks only: geometric shapes drawn locally (no photos, no SAM responses). The torn and
// fragmented shapes replicate the 5 Nov 2026 incident from its description: a jar selected down to
// its label with a ragged cut, and a mask of two jars with jagged holes.
const W = 600, H = 800;
type Inside = (x: number, y: number) => boolean;
function draw(inside: Inside, width = W, height = H): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (inside(x + 0.5, y + 0.5)) mask[y * width + x] = 255;
  return mask;
}
const ellipse = (cx: number, cy: number, rx: number, ry: number): Inside => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const rect = (left: number, top: number, right: number, bottom: number): Inside => (x, y) => x >= left && x < right && y >= top && y < bottom;
/** Deterministic LCG in [0, 1). */
function lcg(seed: number) { let state = seed >>> 0; return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; }; }
/** A ragged tear profile: teeth of ±amplitude every `step` px plus a slow random walk. */
function tear(seed: number, amplitude: number, step: number): (x: number) => number {
  const random = lcg(seed), teeth: number[] = [], walk: number[] = [];
  let tooth = 0, drift = 0;
  for (let x = 0; x < W; x++) {
    if (x % step === 0) tooth = (random() - 0.5) * 2 * amplitude;
    drift = (drift + (random() - 0.5) * 12) * 0.97;
    teeth.push(tooth); walk.push(drift);
  }
  return (x) => teeth[Math.min(W - 1, Math.max(0, Math.floor(x)))] + walk[Math.min(W - 1, Math.max(0, Math.floor(x)))];
}

// A jar: lid ellipse and body inside the grounded box (half-open source pixels).
const jarBox: PixelBounds = { left: 140, top: 80, right: 460, bottom: 720 };
const jar = (bottom: (x: number) => number) => draw((x, y) => ellipse(300, 120, 155, 36)(x, y) || (x >= 150 && x < 450 && y >= 120 && y < bottom(x)));
const ragged = tear(7, 22, 9);
/** Solid lid and cream layer, then a ragged cut through the label about half way down the box, with a torn tail on the left. */
const tornJar = () => jar((x) => 400 + ragged(x) + (x < 180 ? 70 : 0) - (x - 150) * 0.12);
const disk = () => draw(ellipse(300, 400, 200, 200));
const diskBox: PixelBounds = { left: 95, top: 195, right: 505, bottom: 605 };
/** A cupcake: tapered liner under a wider frosting dome. */
const cupcake = () => draw((x, y) => (y >= 400 && y < 680 && Math.abs(x - 300) <= 190 - (y - 400) * 0.18) || (ellipse(300, 400, 210, 190)(x, y) && y < 430));
const cupcakeBox: PixelBounds = { left: 85, top: 205, right: 515, bottom: 685 };
/** A mug: body plus a handle whose loop is a real opening. */
const mug = () => draw((x, y) => rect(180, 240, 420, 620)(x, y) || (ellipse(420, 430, 110, 125)(x, y) && !ellipse(420, 430, 70, 85)(x, y) && x > 410));
const mugBox: PixelBounds = { left: 175, top: 235, right: 535, bottom: 625 };

describe("SAM mask shape quality", () => {
  test("a torn jar mask that stops mid-object, with a ragged cut through its box, is not clean", () => {
    const quality = maskShapeQuality(tornJar(), W, H, { box: jarBox });
    expect(quality.measured).toBe(true);
    expect(quality.clean).toBe(false);
    expect(quality.failures).toContain("cut_through");
    expect(quality.cutThrough).toMatchObject({ side: "bottom", strong: true });
    expect(quality.cutThrough!.depth).toBeGreaterThan(CUT_DEPTH);
    expect(quality.cutThrough!.span).toBeGreaterThan(0.8);
    // The ragged edge also reads as rough against its hull.
    expect(quality.roughness).toBeGreaterThan(MAX_ROUGHNESS);
    expect(maskQualityNote("asset_jar", quality)).toBe("SAM cutout for asset_jar was not used: its mask stopped mid-object; the photo is shown uncut.");
    // A clean straight cut half way down the box is still a cut-through; the whole jar is clean.
    const straight = maskShapeQuality(jar(() => 400), W, H, { box: jarBox });
    expect(straight.failures).toEqual(["cut_through"]);
    const whole = maskShapeQuality(jar(() => 712), W, H, { box: jarBox });
    expect(whole.clean).toBe(true);
    expect(whole.cutThrough?.strong ?? false).toBe(false);
  });

  test("a fragmented two-jar mask with jagged holes is not clean", () => {
    const random = lcg(3), holes: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 7; i++) holes.push([200 + random() * 300, 380 + random() * 260, 14 + random() * 30, 10 + random() * 24]);
    const edge = tear(5, 14, 7);
    const mask = draw((x, y) => {
      const left = x >= 60 + edge(y % W) && x < 250 + edge((y * 3) % W) && y >= 180 && y < 700 + edge(x);
      const right = x >= 370 + edge((y * 5) % W) && x < 560 + edge((y * 7) % W) && y >= 300 + edge(x + 11) && y < 650 + edge(x + 23);
      return (left || right) && !holes.some(([cx, cy, rx, ry]) => ellipse(cx, cy, rx, ry)(x, y)) && !ellipse(170, 690, 110, 60)(x, y);
    });
    const quality = maskShapeQuality(mask, W, H, { box: { left: 50, top: 170, right: 570, bottom: 710 } });
    expect(quality.clean).toBe(false);
    expect(quality.failures).toContain("fragmented");
    expect(quality.components).toBeGreaterThanOrEqual(2);
    expect(quality.largestComponentShare).toBeLessThan(MIN_LARGEST_SHARE);
    expect(maskQualityNote("asset_jars", { failures: ["fragmented", "rough_edge"] })).toBe("SAM cutout for asset_jars was not used: its mask split into separate fragments; the photo is shown uncut.");
    // Two separate smooth blobs are fragmented too.
    const blobs = maskShapeQuality(draw((x, y) => ellipse(180, 400, 110, 150)(x, y) || ellipse(440, 400, 100, 140)(x, y)), W, H, { box: { left: 60, top: 240, right: 550, bottom: 560 } });
    expect(blobs.failures).toContain("fragmented");
    expect(blobs.components).toBe(2);
  });

  test("smooth disk, cupcake, plate, mug and wedge shapes pass", () => {
    const cases: Array<[string, Uint8Array, PixelBounds | null]> = [
      ["disk", disk(), diskBox],
      ["disk without a box", disk(), null],
      ["cupcake", cupcake(), cupcakeBox],
      ["plate", draw(ellipse(300, 400, 280, 110)), { left: 15, top: 285, right: 585, bottom: 515 }],
      ["mug", mug(), mugBox],
      ["cake wedge", draw((x, y) => y >= 150 && y < 700 && Math.abs(x - 300) <= (y - 150) * 0.45), { left: 50, top: 140, right: 550, bottom: 710 }],
    ];
    for (const [name, mask, box] of cases) {
      const quality = maskShapeQuality(mask, W, H, { box });
      expect({ name, clean: quality.clean, failures: quality.failures }).toEqual({ name, clean: true, failures: [] });
      expect(quality.largestComponentShare).toBe(1);
    }
    const round = maskShapeQuality(disk(), W, H, { box: diskBox });
    expect(round.solidity).toBeGreaterThan(0.97);
    expect(round.roughness).toBeGreaterThan(0.95);
    expect(round.roughness).toBeLessThan(1.05);
    // Only the disk's outermost columns dip deep into the box: a short, weak candidate, never strong.
    expect(round.cutThrough?.strong ?? false).toBe(false);
    expect(round.cutThrough?.span ?? 0).toBeLessThan(0.15);
    expect(maskShapeQuality(cupcake(), W, H, { box: cupcakeBox }).solidity).toBeGreaterThanOrEqual(MIN_SOLIDITY);
  });

  test("small noise does not flip a clean mask", () => {
    const random = lcg(11);
    const jitter = Array.from({ length: 720 }, () => (random() - 0.5) * 4);
    // ±2 px boundary jitter, scattered 2×2 specks outside and 2×2 bites inside the disk.
    const mask = draw((x, y) => Math.hypot(x - 300, y - 400) <= 200 + jitter[Math.floor((Math.atan2(y - 400, x - 300) + Math.PI) / (2 * Math.PI) * 719)]);
    for (let i = 0; i < 40; i++) {
      const outside = i % 2 === 0, angle = random() * 2 * Math.PI, distance = outside ? 205 + random() * 8 : random() * 180;
      const x = Math.floor(300 + Math.cos(angle) * distance), y = Math.floor(400 + Math.sin(angle) * distance);
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) mask[(y + dy) * W + x + dx] = outside ? 255 : 0;
    }
    const clean = maskShapeQuality(disk(), W, H, { box: diskBox }), noisy = maskShapeQuality(mask, W, H, { box: diskBox });
    expect(noisy.clean).toBe(true);
    expect(Math.abs(noisy.solidity - clean.solidity)).toBeLessThan(0.02);
    expect(Math.abs(noisy.roughness - clean.roughness)).toBeLessThan(0.05);
    expect(noisy.largestComponentShare).toBeGreaterThan(0.99);
  });

  test("metrics are deterministic, downsampled for speed, and too-small shapes are not judged", () => {
    const first = maskShapeQuality(tornJar(), W, H, { box: jarBox }), second = maskShapeQuality(tornJar(), W, H, { box: jarBox });
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.grid.scale).toBe(Math.ceil(640 / 256));
    expect(Math.max(first.grid.width, first.grid.height)).toBeLessThanOrEqual(256);
    // A 6×6 selection is too small to judge: recorded, but the gate does not fail it.
    const tiny = new Uint8Array(40 * 30);
    for (let y = 5; y < 11; y++) for (let x = 5; x < 11; x++) tiny[y * 40 + x] = 255;
    expect(maskShapeQuality(tiny, 40, 30)).toMatchObject({ measured: false, clean: true, failures: [] });
    // Empty selections are never clean; mismatched rasters throw.
    expect(maskShapeQuality(new Uint8Array(40 * 30), 40, 30)).toMatchObject({ clean: false, area: 0 });
    expect(() => maskShapeQuality(new Uint8Array(5), 3, 2)).toThrow("Mask dimensions do not match its raster.");
  });

  test("the report is a plain record of the thresholds' inputs", () => {
    const quality: MaskShapeQuality = maskShapeQuality(cupcake(), W, H, { box: cupcakeBox });
    expect(Object.keys(quality).sort()).toEqual(["area", "clean", "components", "cutThrough", "failures", "grid", "largestComponentShare", "measured", "roughness", "solidity", "version"]);
    expect(quality.version).toBe(1);
  });
});
