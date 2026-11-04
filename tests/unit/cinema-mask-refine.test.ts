import { describe, expect, test } from "vitest";
import { MAX_HOLE_SHARE, MIN_COMPONENT_SHARE, refinedAlphaAt, refineMaskAlpha, refineMaskField } from "../../lib/campaign/cinema/mask-refine";

// SYNTHETIC rasters only: disks, rings and a drawn "cup" outline computed here.
function disk(width: number, height: number, cx: number, cy: number, radius: number, value = 1): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < radius) out[y * width + x] = value;
  return out;
}

/** A cup: a body disk plus a ring-shaped handle whose loop is a real opening (a large enclosed hole). */
function cup(width: number, height: number, value = 255): Uint8Array {
  const out = disk(width, height, 120, 130, 80, value);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const d = Math.hypot(x + 0.5 - 205, y + 0.5 - 130);
    if (d >= 22 && d < 34 && x + 0.5 > 190) out[y * width + x] = value;
  }
  return out;
}

/** Edge-radius roughness of a disk's alpha=0.5 contour sampled at `scale`× (output pixels). */
function roughness(field: ReturnType<typeof refineMaskField>, cx: number, cy: number, radius: number, scale: number): number {
  const radii: number[] = [];
  for (let k = 0; k < 720; k++) {
    const theta = (k / 720) * 2 * Math.PI;
    let r = (radius - 4) * scale;
    for (; r < (radius + 4) * scale; r += 0.05) if (refinedAlphaAt(field, cx + Math.cos(theta) * r / scale - 0.5, cy + Math.sin(theta) * r / scale - 0.5, 1.5 / scale) < 0.5) break;
    radii.push(r);
  }
  const residual = radii.map((r, i) => { let sum = 0; for (let d = -12; d <= 12; d++) sum += radii[(i + d + 720) % 720]; return r - sum / 25; });
  return Math.sqrt(residual.reduce((sum, value) => sum + value * value, 0) / residual.length);
}

describe("SAM mask refinement", () => {
  test("drops specks, fills pin-holes and keeps a real opening; the input raster is untouched", () => {
    const width = 260, height = 260, raster = cup(width, height);
    const clean = refineMaskAlpha(raster, width, height, { sigma: 1, threshold: 128 });
    const noisy = Uint8Array.from(raster);
    // Specks: isolated pixels and a 3×3 blob well under MIN_COMPONENT_SHARE of the selected area.
    for (const [x, y] of [[10, 10], [250, 20], [12, 240]]) noisy[y * width + x] = 255;
    for (let y = 230; y < 233; y++) for (let x = 230; x < 233; x++) noisy[y * width + x] = 255;
    // Pin-holes inside the body.
    for (const [x, y] of [[100, 120], [101, 120], [140, 150]]) noisy[y * width + x] = 0;
    const before = Uint8Array.from(noisy);
    const refined = refineMaskAlpha(noisy, width, height, { sigma: 1, threshold: 128 });
    expect(noisy).toEqual(before);
    expect(refined.report).toMatchObject({ removedComponents: 4, removedPixels: 12, filledHoles: 2, filledPixels: 3, edgeSigma: 1 });
    expect(Buffer.from(refined.alpha).equals(Buffer.from(clean.alpha))).toBe(true);
    // The handle's loop (≈ 1500 px, far above MAX_HOLE_SHARE of the area) stays open.
    expect(refined.alpha[130 * width + 205]).toBe(0);
    expect(refined.alpha[130 * width + 233]).toBe(255);
    expect(MIN_COMPONENT_SHARE).toBeLessThanOrEqual(0.005); expect(MAX_HOLE_SHARE).toBeLessThanOrEqual(0.005);
  });

  test("closes a ragged one-pixel notch and a one-pixel bump, and anti-aliases slanted outlines", () => {
    const width = 120, height = 120, raster = new Uint8Array(width * height);
    for (let y = 20; y < 100; y++) for (let x = 20; x < 100; x++) raster[y * width + x] = 255;
    // A 1-px-wide, 3-px-deep notch into the top edge and a 1-px bump on the left edge.
    for (let y = 20; y < 23; y++) raster[y * width + 60] = 0;
    raster[50 * width + 19] = 255;
    const { alpha } = refineMaskAlpha(raster, width, height, { sigma: 1.2, threshold: 128 });
    expect(alpha[21 * width + 60]).toBeGreaterThanOrEqual(128);
    expect(alpha[50 * width + 19]).toBeLessThan(128);
    // A pixel-aligned straight edge stays exactly where it was (the ramp is about one pixel wide).
    expect([18, 19, 20, 21].map((y) => alpha[y * width + 40])).toEqual([0, 0, 255, 255]);
    // A slanted edge gets partial alpha (anti-aliasing) instead of hard steps.
    const slanted = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (y > 0.37 * x + 30) slanted[y * width + x] = 255;
    const soft = refineMaskAlpha(slanted, width, height, { sigma: 1.2, threshold: 128 }).alpha;
    const partial = Array.from({ length: 80 }, (_, x) => x + 20).filter((x) => [...Array(height).keys()].some((y) => soft[y * width + x] > 0 && soft[y * width + x] < 255));
    expect(partial.length).toBeGreaterThan(60);
    // Inside the subject the alpha is opaque (source RGB is used as is); far outside it is zero.
    expect(alpha[60 * width + 60]).toBe(255);
    expect(alpha[5 * width + 5]).toBe(0);
  });

  test("smoothing removes the stair steps of an enlarged binary mask without moving the edge", () => {
    const width = 122, height = 122, cx = 60.3, cy = 60.7, radius = 50;
    const raster = disk(width, height, cx, cy, radius);
    const hard = refineMaskField(raster, width, height, { sigma: 0 });
    const smooth = refineMaskField(raster, width, height, { sigma: 1.33 });
    const scale = 5.33;
    const [before, after] = [roughness(hard, cx, cy, radius, scale), roughness(smooth, cx, cy, radius, scale)];
    expect(before).toBeGreaterThan(1);
    expect(after).toBeLessThan(0.6);
    expect(smooth.area).toBe(hard.area);
  });

  test("a subject thinner than the kernel keeps its hard edge instead of vanishing; empty masks stay empty", () => {
    const width = 40, height = 40, line = new Uint8Array(width * height);
    for (let x = 5; x < 35; x++) line[20 * width + x] = 1;
    const refined = refineMaskField(line, width, height, { sigma: 2 });
    expect(refined.report.edgeSigma).toBe(0);
    expect(refinedAlphaAt(refined, 20, 20, 0.5)).toBe(1);
    const empty = refineMaskField(new Uint8Array(width * height), width, height, { sigma: 1 });
    expect(empty).toMatchObject({ area: 0, width: 0 });
    expect(refinedAlphaAt(empty, 3, 3, 1)).toBe(0);
    expect(() => refineMaskField(new Uint8Array(3), 2, 2, { sigma: 1 })).toThrow();
  });
});
