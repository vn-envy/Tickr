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

// ---------------------------------------------------------------------------------------------
// Real-photo SAM noise (SYNTHETIC): a disk-shaped subject decoded from a coarse native grid
// (stair steps several source pixels tall), stray specks, pin-holes and a ragged, bitten left side.

/** Deterministic LCG in [0, 1). */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}

/**
 * Nearest-neighbour enlargement of a mask decided per native cell (`step` source pixels per cell),
 * as a coarse SAM grid decoded at source size looks. `inside` gets the cell index and centre.
 */
function coarse(width: number, height: number, step: number, inside: (i: number, j: number, cx: number, cy: number) => boolean): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = Math.floor((x + 0.5) / step), j = Math.floor((y + 0.5) / step);
    if (inside(i, j, (i + 0.5) * step, (j + 0.5) * step)) out[y * width + x] = 255;
  }
  return out;
}

const SIZE = 480, CX = 240.3, CY = 238.7, R = 150;
const inDisk = (x: number, y: number) => Math.hypot(x - CX, y - CY) < R;
const diskCells = (_i: number, _j: number, cx: number, cy: number) => inDisk(cx, cy);

/** The noisy SAM mask: native step 4 (or `step`), specks, pin-holes and a ragged left side of whole native cells. */
function noisyDiskMask(step = 4, seed = 7): { raster: Uint8Array; specks: Array<[number, number]>; holes: Array<[number, number]> } {
  const random = rng(seed);
  // Ragged left side: single native cells bitten out of (−1) or stuck onto (+1) the edge on every
  // other native row, as SAM does on busy backgrounds.
  const ragged = new Map<number, number>();
  for (let j = Math.ceil((CY - R * 0.8) / step); (j + 0.5) * step < CY + R * 0.8; j += 2) {
    const roll = random();
    if (roll < 0.3) ragged.set(j, roll < 0.15 ? -1 : 1);
  }
  const raster = coarse(SIZE, SIZE, step, (_i, j, cx, cy) => {
    if (inDisk(cx, cy)) return !(cx < CX && ragged.get(j) === -1 && !inDisk(cx - step, cy));
    return cx < CX && ragged.get(j) === 1 && inDisk(cx + step, cy);
  });
  const set = (x0: number, y0: number, size: number, value: number) => { for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) raster[y * SIZE + x] = value; };
  const specks: Array<[number, number]> = [], holes: Array<[number, number]> = [];
  while (specks.length < 14) {
    const x = Math.floor(random() * (SIZE - 8)), y = Math.floor(random() * (SIZE - 8));
    if (Math.hypot(x - CX, y - CY) < R + 14) continue;
    set(x, y, 1 + Math.floor(random() * 4), 255); specks.push([x, y]);
  }
  while (holes.length < 8) {
    const x = Math.floor(CX - R / 2 + random() * R), y = Math.floor(CY - R / 2 + random() * R);
    set(x, y, 2 + Math.floor(random() * 3), 0); holes.push([x + 1, y + 1]);
  }
  return { raster, specks, holes };
}

/** 8-connected components of alpha ≥ 128, and enclosed (non-border) holes of alpha < 128. */
function topology(alpha: Uint8Array, width: number, height: number) {
  const label = (wanted: (value: number) => boolean, eight: boolean) => {
    const seen = new Uint8Array(alpha.length), stack: number[] = [];
    let parts = 0, enclosed = 0;
    for (let start = 0; start < alpha.length; start++) {
      if (seen[start] || !wanted(alpha[start])) continue;
      parts++; seen[start] = 1; stack.push(start);
      let border = false;
      while (stack.length) {
        const i = stack.pop()!, x = i % width, y = (i - x) / width;
        if (!x || !y || x === width - 1 || y === height - 1) border = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (!eight && dx && dy)) continue;
          const nx = x + dx, ny = y + dy, j = ny * width + nx;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height && !seen[j] && wanted(alpha[j])) { seen[j] = 1; stack.push(j); }
        }
      }
      if (!border) enclosed++;
    }
    return { parts, enclosed };
  };
  return { components: label((value) => value >= 128, true).parts, softComponents: label((value) => value > 0, true).parts, holes: label((value) => value < 128, false).enclosed };
}

/** Bilinear alpha (0–1) of an 8-bit raster at continuous position (u, v), pixel centres at +0.5. */
function sample(alpha: Uint8Array, width: number, u: number, v: number): number {
  const x = u - 0.5, y = v - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < width && j < width ? alpha[j * width + i] / 255 : 0;
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

/**
 * Edge smoothness: the alpha = 0.5 contour radius along 720 rays, its rms residual against a ±12-ray
 * moving average (stair steps and bites; a smooth outline is ~0) and its mean.
 */
function contour(alpha: Uint8Array, width: number) {
  const radii: number[] = [];
  for (let k = 0; k < 720; k++) {
    const theta = (k / 720) * 2 * Math.PI;
    let r = R + 12;
    for (; r > R - 12; r -= 0.05) if (sample(alpha, width, CX + Math.cos(theta) * r, CY + Math.sin(theta) * r) >= 0.5) break;
    radii.push(r);
  }
  const residual = radii.map((r, i) => { let sum = 0; for (let d = -12; d <= 12; d++) sum += radii[(i + d + 720) % 720]; return r - sum / 25; });
  return { roughness: Math.sqrt(residual.reduce((sum, value) => sum + value * value, 0) / 720), meanRadius: radii.reduce((sum, value) => sum + value, 0) / 720 };
}

describe("real-photo SAM mask refinement", () => {
  test("drops every speck, fills pin-holes, re-decodes the coarse stair steps smoothly and keeps the true shape", () => {
    const { raster, specks, holes } = noisyDiskMask();
    const before = Uint8Array.from(raster);
    const raw = topology(raster, SIZE, SIZE);
    expect(raw.components).toBeGreaterThan(10);
    expect(raw.holes).toBeGreaterThanOrEqual(6);
    const refined = refineMaskAlpha(raster, SIZE, SIZE, { sigma: 1, threshold: 128 });
    expect(raster).toEqual(before);
    // Speck count 0 (also among faint alpha) and no enclosed holes left.
    expect(topology(refined.alpha, SIZE, SIZE)).toEqual({ components: 1, softComponents: 1, holes: 0 });
    for (const [x, y] of specks) expect(refined.alpha[y * SIZE + x], `speck ${x},${y}`).toBe(0);
    for (const [x, y] of holes) expect(refined.alpha[y * SIZE + x], `hole ${x},${y}`).toBe(255);
    expect(refined.report).toMatchObject({ removedComponents: specks.length, nativeFactor: { x: 4, y: 4 } });
    expect(refined.report.filledHoles).toBeGreaterThanOrEqual(6);
    // Edge smoothness: the coarse staircase and ragged left side are far smoother after refinement.
    const rawEdge = contour(raster, SIZE), refinedEdge = contour(refined.alpha, SIZE);
    expect(rawEdge.roughness).toBeGreaterThan(0.6);
    expect(refinedEdge.roughness).toBeLessThan(rawEdge.roughness * 0.5);
    expect(Math.abs(refinedEdge.meanRadius - R)).toBeLessThan(1);
    // Coverage within tolerance of the true shape, and no background halo beyond a small margin.
    let coverage = 0, truth = 0, intersection = 0, union = 0, halo = 0;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const a = refined.alpha[y * SIZE + x], inside = inDisk(x + 0.5, y + 0.5), selected = a >= 128;
      coverage += a / 255; if (inside) truth++;
      if (inside && selected) intersection++; if (inside || selected) union++;
      if (a > 0 && Math.hypot(x + 0.5 - CX, y + 0.5 - CY) > R + refined.report.maxGrowthPx) halo++;
    }
    expect(Math.abs(coverage - truth) / truth).toBeLessThan(0.01);
    expect(intersection / union).toBeGreaterThan(0.985);
    expect(halo).toBe(0);
    expect(refined.report.maxGrowthPx).toBeLessThanOrEqual(4);
  });

  test("handles a fractional native grid and a native-resolution mask without resampling it", () => {
    const fractional = refineMaskAlpha(noisyDiskMask(4.6, 11).raster, SIZE, SIZE, { sigma: 1, threshold: 128 });
    expect(fractional.report.nativeFactor.x).toBeGreaterThan(4.3);
    expect(fractional.report.nativeFactor.x).toBeLessThan(4.9);
    expect(topology(fractional.alpha, SIZE, SIZE)).toEqual({ components: 1, softComponents: 1, holes: 0 });
    expect(contour(fractional.alpha, SIZE).roughness).toBeLessThan(contour(noisyDiskMask(4.6, 11).raster, SIZE).roughness * 0.5);
    // A mask already at source resolution keeps its native grid (no resampling).
    const native = refineMaskAlpha(coarse(SIZE, SIZE, 1, diskCells), SIZE, SIZE, { sigma: 1, threshold: 128 });
    expect(native.report).toMatchObject({ nativeFactor: { x: 1, y: 1 }, removedComponents: 0, filledHoles: 0 });
    expect(Math.abs(contour(native.alpha, SIZE).meanRadius - R)).toBeLessThan(0.6);
  });

  test("keeps only components overlapping the subject box and is deterministic", () => {
    const raster = coarse(SIZE, SIZE, 1, diskCells);
    // A large second object (well above the speck share) away from the prompted subject.
    for (let y = 20; y < 70; y++) for (let x = 20; x < 70; x++) raster[y * SIZE + x] = 255;
    const loose = refineMaskAlpha(raster, SIZE, SIZE, { sigma: 1, threshold: 128 });
    expect(loose.alpha[45 * SIZE + 45]).toBe(255);
    const boxed = refineMaskAlpha(raster, SIZE, SIZE, { sigma: 1, threshold: 128, keepBox: { left: 120, top: 120, right: 360, bottom: 360 } });
    expect(boxed.alpha[45 * SIZE + 45]).toBe(0);
    expect(boxed.report).toMatchObject({ removedComponents: 1, removedPixels: 2500 });
    expect(boxed.alpha[240 * SIZE + 240]).toBe(255);
    // A box that misses everything falls back to the largest component.
    const missed = refineMaskAlpha(raster, SIZE, SIZE, { sigma: 1, threshold: 128, keepBox: { left: 0, top: 400, right: 10, bottom: 410 } });
    expect(missed.alpha[240 * SIZE + 240]).toBe(255);
    const again = refineMaskAlpha(noisyDiskMask().raster, SIZE, SIZE, { sigma: 1, threshold: 128 });
    expect(Buffer.from(again.alpha).equals(Buffer.from(refineMaskAlpha(noisyDiskMask().raster, SIZE, SIZE, { sigma: 1, threshold: 128 }).alpha))).toBe(true);
  });

  test("close/open scales with the subject, fills edge bites and keeps a real thin part", () => {
    const width = 1100, height = 1100, cx = 550, cy = 600, radius = 420;
    const raster = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < radius) raster[y * width + x] = 1;
    // A 3-px-wide, 6-px-deep bite into the edge (missing fragment) and a 2-px spur sticking out.
    for (let y = 600; y < 603; y++) for (let x = cx - radius + 1; x < cx - radius + 7; x++) raster[y * width + x] = 0;
    for (let y = 400; y < 402; y++) for (let x = cx + Math.ceil(Math.sqrt(radius ** 2 - (y + 0.5 - cy) ** 2)) - 1; x < cx + 395; x++) raster[y * width + x] = 1;
    // A real thin part: a 12-px-wide stick above the subject (e.g. a cake topper).
    for (let y = 60; y < 190; y++) for (let x = 544; x < 556; x++) raster[y * width + x] = 1;
    const refined = refineMaskAlpha(raster, width, height, { sigma: 1.2 });
    expect(refined.report.morphRadius).toBe(Math.round(Math.sqrt(refined.report.inputPixels) * 0.003));
    expect(refined.report.morphRadius).toBeGreaterThanOrEqual(2);
    expect(refined.report.openSkipped).toBe(false);
    expect(refined.alpha[601 * width + cx - radius + 3]).toBe(255);
    expect(refined.alpha[400 * width + cx + 392]).toBe(0);
    expect(refined.alpha[120 * width + 550]).toBe(255);
    expect(refined.report.maxGrowthPx).toBe(refined.report.morphRadius + 1);
  });
});
