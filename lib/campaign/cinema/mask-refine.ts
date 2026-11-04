/**
 * Deterministic, alpha-only refinement of SAM masks for compositing.
 *
 * SAM masks of real photos arrive as hard binary rasters with isolated specks, pin-holes and
 * bitten edges, and they are often decoded from a coarser model grid, so every slanted edge is a
 * staircase several source pixels tall. Enlarged into a 1080×1920 frame those read as dirt and
 * jagged, pixelated outlines. This module derives a compositing alpha from the mask:
 *
 * 1. foreground components (8-connected) smaller than MIN_COMPONENT_SHARE of the selected area are
 *    dropped; with a subject box (the Spark/SAM prompt box) components outside the box are dropped
 *    too. The largest (box-overlapping) component is always kept;
 * 2. enclosed background holes (4-connected, not touching the outside) smaller than MAX_HOLE_SHARE
 *    of the selected area are filled — real openings such as a cup handle's loop are larger and kept;
 * 3. the mask's native grid is estimated from its stair steps (runs of identical rows/columns). A
 *    mask enlarged from a coarser grid is area-averaged back onto that grid and re-enlarged with
 *    bilinear (not nearest) interpolation before it is thresholded again at 0.5;
 * 4. a morphological close then open with a disk whose radius scales with the subject size
 *    (MORPH_RADIUS_SHARE of √area, at least half a native cell, at most MAX_MORPH_RADIUS) fills
 *    edge bites and removes spurs; the open is skipped when it would remove more than
 *    MAX_OPEN_LOSS of the subject (thin parts), counting parts the open cuts off at a thin neck.
 *    New fragments/pin-holes are cleaned once more, without the box (step 1 applied it);
 * 5. the result may never extend more than a small margin (`maxGrowthPx`) past the cleaned SAM
 *    selection of steps 1–2, so no halo of background pixels is ever selected;
 * 6. the binary is smoothed by a small exact Gaussian (at least NATIVE_SIGMA_SHARE of a native cell)
 *    and re-thresholded at 0.5 with a narrow linear ramp (1–3 px, scaled to resolution;
 *    maskFeatherPx), giving an anti-aliased edge.
 *
 * Only alpha changes: callers keep the source RGB untouched and never write the refined alpha back
 * over the SAM mask they were given (that file stays the provenance record). Every step is
 * reported so the refinement is visible in layout/QA reports. No network, no model; the output is
 * a pure function of the raster and options.
 */

/** Foreground components below this share of the selected area are specks. */
export const MIN_COMPONENT_SHARE = 0.005;
/** Enclosed holes below this share of the selected area are mask noise and are filled. */
export const MAX_HOLE_SHARE = 0.005;
/**
 * Close/open disk radius as a share of √(subject area), rounded (0 below ~170 px subjects). Parts
 * thinner than 2r + 1 px (under ~0.7% of the subject's size) are treated as edge noise by the open.
 */
export const MORPH_RADIUS_SHARE = 0.003;
export const MAX_MORPH_RADIUS = 4;
/** The open is skipped when it would remove more than this share of the subject (thin parts, and parts it cuts off at a neck). */
export const MAX_OPEN_LOSS = 0.04;
/** Largest native grid step (source pixels per SAM mask cell) that is undone. */
export const MAX_NATIVE_FACTOR = 16;
/**
 * Edge smoothing sigma of a coarse-grid mask, in native cells: the mask holds no detail finer than
 * a cell, so its re-decoded staircase is smoothed on that scale.
 */
export const NATIVE_SIGMA_SHARE = 0.75;
/** Largest raster refined in one call (matches the still-depth input limit). */
const MAX_REFINE_PIXELS = 40_000_000;
/** Minimum runs of identical rows/columns before a native grid step is trusted. */
const MIN_NATIVE_RUNS = 8;

export interface MaskRefinementReport {
  /** Foreground pixels of the mask as supplied. */
  inputPixels: number;
  removedComponents: number;
  removedPixels: number;
  filledHoles: number;
  filledPixels: number;
  /** Gaussian sigma (mask pixels) of the edge smoothing; 0 when smoothing would have erased the subject. */
  edgeSigma: number;
  /** Estimated source pixels per native SAM mask cell along x and y (1 = the mask is native). */
  nativeFactor: { x: number; y: number };
  /** Disk radius (mask pixels) of the close-then-open pass; 0 when the subject is too small. */
  morphRadius: number;
  /** True when the open would have removed thin parts of the subject and only the close was kept. */
  openSkipped: boolean;
  /** Pixels the native resampling and close/open added to / removed from the cleaned selection. */
  edgeAddedPixels: number;
  edgeRemovedPixels: number;
  /** The refined mask never extends further than this (mask pixels) past the cleaned selection. */
  maxGrowthPx: number;
}

export interface RefineMaskOptions {
  /** Edge smoothing sigma in mask pixels (0 disables smoothing). */
  sigma: number;
  /** Raster values at or above this are foreground. Default 1 (any non-zero value). */
  threshold?: number;
  minComponentShare?: number;
  maxHoleShare?: number;
  /** Subject box in raster pixels (half-open), e.g. the Spark/SAM prompt box: components outside it are dropped. */
  keepBox?: { left: number; top: number; right: number; bottom: number };
  /** Close/open radius override in mask pixels (0 disables); default scales with the subject size. */
  morphRadius?: number;
  /** Estimate and undo a coarse native SAM grid (default true). */
  detectNative?: boolean;
}

/**
 * The smoothed coverage field of a refined mask. Field cell (i, j) is raster pixel (i + ox, j + oy);
 * cells outside the field are 0.
 */
export interface RefinedMaskField {
  field: Float32Array;
  width: number;
  height: number;
  ox: number;
  oy: number;
  /** Foreground pixels of the refined binary mask (before edge smoothing). */
  area: number;
  /** Field slope normaliser: alpha = clamp01((field − 0.5) · gain / rampPx + 0.5). */
  gain: number;
  report: MaskRefinementReport;
}

const clamp01 = (value: number) => value <= 0 ? 0 : value >= 1 ? 1 : value;

/** Anti-aliasing ramp width for a raster: about 1 px per 1200 px of the long side, 1–3 px. */
export function maskFeatherPx(width: number, height: number): number {
  return Math.min(3, Math.max(1, Math.max(width, height) / 1200));
}

/** Default edge smoothing sigma for a source-size mask: about 1 px per 900 px of the long side (0.8–2 px). */
export function maskSigmaFor(width: number, height: number): number {
  return Math.min(2, Math.max(0.8, Math.max(width, height) / 900));
}

function assertRaster(raster: Uint8Array, width: number, height: number, options: RefineMaskOptions): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_REFINE_PIXELS || !(raster instanceof Uint8Array) || raster.length !== width * height) {
    throw new Error("Mask dimensions do not match its raster.");
  }
  if (!(options.sigma >= 0 && options.sigma <= 16)) throw new Error("Mask refinement sigma is out of range.");
  if (options.morphRadius !== undefined && !(Number.isInteger(options.morphRadius) && options.morphRadius >= 0 && options.morphRadius <= MAX_MORPH_RADIUS)) throw new Error("Mask refinement radius is out of range.");
  const box = options.keepBox;
  if (box && ![box.left, box.top, box.right, box.bottom].every(Number.isFinite)) throw new Error("Mask refinement box is invalid.");
}

/** Normalised 1-D Gaussian kernel of radius ceil(3σ). */
function kernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3)), out = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) { const value = Math.exp(-(i * i) / (2 * sigma * sigma)); out[i + radius] = value; sum += value; }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

/**
 * Separable zero-padded convolution with a symmetric kernel, in place. Windows that are entirely 0,
 * or entirely 1 and inside the raster, take a precomputed value summed in the same order as the
 * full loop, so the result is bit-identical to convolving every cell; only the edge band of a
 * binary mask pays for the full kernel.
 */
function blur(data: Float32Array, width: number, height: number, k: Float32Array): void {
  const radius = (k.length - 1) / 2, span = k.length, tmp = new Float32Array(data.length);
  // Value of a window of constant v fully inside the raster, summed exactly like the loops below.
  const constant = (v: number) => { let sum = 0; for (let t = 0; t < span; t++) sum += v * k[t]; return Math.fround(sum); };
  const fullH = constant(1), fullV = constant(fullH);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    // Zeros and ones among the in-raster cells of the window [x − r, x + r].
    let zeros = 0, ones = 0;
    for (let xx = 0; xx < Math.min(width, radius); xx++) { const v = data[row + xx]; if (v === 0) zeros++; else if (v === 1) ones++; }
    for (let x = 0; x < width; x++) {
      const enter = x + radius, leave = x - radius - 1;
      if (enter < width) { const v = data[row + enter]; if (v === 0) zeros++; else if (v === 1) ones++; }
      if (leave >= 0) { const v = data[row + leave]; if (v === 0) zeros--; else if (v === 1) ones--; }
      const inside = Math.min(width - 1, enter) - Math.max(0, x - radius) + 1;
      if (zeros === inside) { tmp[row + x] = 0; continue; }
      if (ones === span) { tmp[row + x] = fullH; continue; }
      let sum = 0;
      for (let t = -radius; t <= radius; t++) { const xx = x + t; if (xx >= 0 && xx < width) sum += data[row + xx] * k[t + radius]; }
      tmp[row + x] = sum;
    }
  }
  // Vertical pass row by row, with per-column counts of zero and fullH cells in the window.
  const zeros = new Int32Array(width), fulls = new Int32Array(width);
  const tally = (y: number, sign: number) => {
    const row = y * width;
    for (let x = 0; x < width; x++) { const v = tmp[row + x]; if (v === 0) zeros[x] += sign; else if (v === fullH) fulls[x] += sign; }
  };
  for (let y = 0; y < Math.min(height, radius); y++) tally(y, 1);
  for (let y = 0; y < height; y++) {
    const enter = y + radius, leave = y - radius - 1;
    if (enter < height) tally(enter, 1);
    if (leave >= 0) tally(leave, -1);
    const inside = Math.min(height - 1, enter) - Math.max(0, y - radius) + 1, row = y * width;
    for (let x = 0; x < width; x++) {
      if (zeros[x] === inside) { data[row + x] = 0; continue; }
      if (fulls[x] === span) { data[row + x] = fullV; continue; }
      let sum = 0;
      for (let t = -radius; t <= radius; t++) { const yy = y + t; if (yy >= 0 && yy < height) sum += tmp[yy * width + x] * k[t + radius]; }
      data[row + x] = sum;
    }
  }
}

const count = (cells: Uint8Array) => { let n = 0; for (let i = 0; i < cells.length; i++) n += cells[i]; return n; };

interface Box { left: number; top: number; right: number; bottom: number }

/**
 * Connected components of cells equal to `value` (8- or 4-connected), labelled over horizontal
 * runs with union-find (linear in the raster, no per-cell label or stack buffers). Labels follow
 * the scan order of each component's first cell. Returns the runs (row, half-open [start, end) and
 * label) and per-label sizes, border contact and box overlap (index 0 unused).
 */
function components(cells: Uint8Array, width: number, height: number, value: 0 | 1, eight: boolean, box: Box | null = null) {
  const rows: number[] = [], starts: number[] = [], ends: number[] = [], parent: number[] = [];
  const find = (i: number): number => { let r = i; while (parent[r] !== r) r = parent[r]; while (parent[i] !== r) { const next = parent[i]; parent[i] = r; i = next; } return r; };
  const reach = eight ? 1 : 0;
  let prevFirst = 0, prevLast = 0;
  for (let y = 0; y < height; y++) {
    const rowStart = y * width, first = starts.length;
    let x = 0, p = prevFirst;
    while (x < width) {
      while (x < width && cells[rowStart + x] !== value) x++;
      if (x >= width) break;
      const s = x;
      while (x < width && cells[rowStart + x] === value) x++;
      const run = starts.length;
      rows.push(y); starts.push(s); ends.push(x); parent.push(run);
      // Previous-row runs touching [s − reach, x + reach).
      while (p < prevLast && ends[p] + reach <= s) p++;
      for (let q = p; q < prevLast && starts[q] < x + reach; q++) {
        const a = find(q), b = find(run);
        if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; }
      }
    }
    prevFirst = first; prevLast = starts.length;
  }
  const n = starts.length, labels = new Int32Array(n), sizes: number[] = [0], border: boolean[] = [false], inBox: boolean[] = [false];
  const boxLeft = box ? Math.ceil(box.left) : 0, boxTop = box ? Math.ceil(box.top) : 0;
  for (let run = 0; run < n; run++) {
    const root = find(run);
    let label = labels[root];
    if (run === root) { label = sizes.length; labels[run] = label; sizes.push(0); border.push(false); inBox.push(false); }
    else labels[run] = label;
    const y = rows[run], s = starts[run], e = ends[run];
    sizes[label] += e - s;
    if (y === 0 || y === height - 1 || s === 0 || e === width) border[label] = true;
    if (box && y >= boxTop && y < box.bottom) { const xMin = Math.max(s, boxLeft); if (xMin < e && xMin < box.right) inBox[label] = true; }
  }
  return { rows, starts, ends, labels, sizes, border, inBox };
}

/** Sets every cell of the runs whose label is flagged to `value`, in place. */
function paintRuns(cells: Uint8Array, width: number, runs: ReturnType<typeof components>, flagged: Uint8Array, value: 0 | 1): void {
  for (let run = 0; run < runs.labels.length; run++) if (flagged[runs.labels[run]]) cells.fill(value, runs.rows[run] * width + runs.starts[run], runs.rows[run] * width + runs.ends[run]);
}

/**
 * Drops foreground specks (and, with a box, components outside it) in place. The anchor — the
 * largest box-overlapping component, else the largest — is always kept.
 */
function dropSpecks(cells: Uint8Array, width: number, height: number, minComponent: number, box: Box | null): { components: number; pixels: number } {
  const fg = components(cells, width, height, 1, true, box);
  if (fg.sizes.length < 2) return { components: 0, pixels: 0 };
  const boxed = box !== null && fg.inBox.some((value) => value);
  let anchor = 0;
  for (let label = 1; label < fg.sizes.length; label++) if ((!boxed || fg.inBox[label]) && (!anchor || fg.sizes[label] > fg.sizes[anchor])) anchor = label;
  const drop = new Uint8Array(fg.sizes.length);
  let removed = 0, pixels = 0;
  for (let label = 1; label < fg.sizes.length; label++) {
    if (label !== anchor && (fg.sizes[label] < minComponent || (boxed && !fg.inBox[label]))) { drop[label] = 1; removed++; pixels += fg.sizes[label]; }
  }
  if (removed) paintRuns(cells, width, fg, drop, 0);
  return { components: removed, pixels };
}

/** Fills enclosed background holes smaller than `maxHole` in place. */
function fillHoles(cells: Uint8Array, width: number, height: number, maxHole: number): { holes: number; pixels: number } {
  const bg = components(cells, width, height, 0, false);
  const fill = new Uint8Array(bg.sizes.length);
  let holes = 0, pixels = 0;
  for (let label = 1; label < bg.sizes.length; label++) {
    if (!bg.border[label] && bg.sizes[label] < maxHole) { fill[label] = 1; holes++; pixels += bg.sizes[label]; }
  }
  if (holes) paintRuns(cells, width, bg, fill, 1);
  return { holes, pixels };
}

/**
 * Exact squared Euclidean distance (in cells) from every cell to the nearest cell where
 * `feature(i)` holds (Felzenszwalb–Huttenlocher). Cells with no feature anywhere get +∞.
 */
function squaredDistance(cells: Uint8Array, width: number, height: number, featureValue: 0 | 1): Float64Array {
  const INF = 1e20, out = new Float64Array(cells.length);
  for (let i = 0; i < cells.length; i++) out[i] = cells[i] === featureValue ? 0 : INF;
  const n = Math.max(width, height), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  /** 1-D lower envelope of parabolas over f[0..length) into d. */
  const envelope = (length: number) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < length; q++) {
      const fq = f[q] + q * q;
      let s = (fq - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = (fq - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < length; q++) { while (z[k + 1] < q) k++; const dq = q - v[k]; d[q] = dq * dq + f[v[k]]; }
  };
  for (let x = 0; x < width; x++) {
    for (let y = 0, i = x; y < height; y++, i += width) f[y] = out[i];
    envelope(height);
    for (let y = 0, i = x; y < height; y++, i += width) out[i] = d[y];
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) f[x] = out[row + x];
    envelope(width);
    for (let x = 0; x < width; x++) out[row + x] = d[x];
  }
  return out;
}

/**
 * Binary dilation (grow = true) or erosion by a Euclidean disk of `radius` cells (offsets with
 * dx² + dy² ≤ r²). Disks are stamped from boundary cells; a raster whose boundary is too long for
 * that to be cheap uses the exact distance transform instead (identical result).
 */
function morph(cells: Uint8Array, width: number, height: number, radius: number, grow: boolean): Uint8Array {
  const r2 = radius * radius, from = grow ? 1 : 0, offsets: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) if (dx * dx + dy * dy <= r2 && (dx || dy)) offsets.push(dx, dy);
  // Boundary cells of the growing value: `from` cells with a 4-neighbour of the other value.
  const boundary: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0, i = y * width; x < width; x++, i++) {
    if (cells[i] !== from) continue;
    if ((x > 0 && cells[i - 1] !== from) || (x < width - 1 && cells[i + 1] !== from) || (y > 0 && cells[i - width] !== from) || (y < height - 1 && cells[i + width] !== from)) boundary.push(i);
  }
  if (boundary.length * (offsets.length / 2) > cells.length * 4) {
    const distance = squaredDistance(cells, width, height, from), out = new Uint8Array(cells.length);
    for (let i = 0; i < cells.length; i++) out[i] = (distance[i] <= r2) === grow ? 1 : 0;
    return out;
  }
  const out = Uint8Array.from(cells);
  for (const i of boundary) {
    const x = i % width, y = (i - x) / width;
    for (let k = 0; k < offsets.length; k += 2) {
      const nx = x + offsets[k], ny = y + offsets[k + 1];
      if (nx >= 0 && ny >= 0 && nx < width && ny < height) out[ny * width + nx] = from;
    }
  }
  return out;
}

/**
 * Native grid step of one axis from runs of identical consecutive rows (or columns): a mask
 * enlarged `f`× from a coarser grid repeats every line at least ⌊f⌋ times. Returns the step and the
 * phase of the block boundaries, or a step of 1 when the evidence is weak.
 */
function nativeStep(changes: number[], first: number, last: number): { step: number; phase: number } {
  const bounds = [first, ...changes, last + 1], runs: number[] = [];
  for (let i = 1; i < bounds.length; i++) runs.push(bounds[i] - bounds[i - 1]);
  if (runs.length < MIN_NATIVE_RUNS) return { step: 1, phase: 0 };
  const sorted = [...runs].sort((a, b) => a - b), low = sorted[Math.floor(sorted.length * 0.2)];
  if (low < 2) return { step: 1, phase: 0 };
  let sum = 0, n = 0;
  for (const run of runs) if (run >= low && run < low * 2) { sum += run; n++; }
  const step = Math.min(MAX_NATIVE_FACTOR, sum / n);
  // Circular mean of the block boundaries modulo the step.
  let c = 0, s = 0;
  for (const position of bounds) { const angle = 2 * Math.PI * position / step; c += Math.cos(angle); s += Math.sin(angle); }
  const phase = ((Math.atan2(s, c) / (2 * Math.PI)) * step + step) % step;
  return { step, phase };
}

function detectNative(cells: Uint8Array, width: number, height: number) {
  let top = -1, bottom = -1, left = width, right = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (cells[y * width + x]) {
    if (top < 0) top = y; bottom = y; if (x < left) left = x; if (x > right) right = x;
  }
  if (top < 0) return { x: { step: 1, phase: 0 }, y: { step: 1, phase: 0 } };
  const rowChanges: number[] = [], colChanges: number[] = [];
  for (let y = top + 1; y <= bottom; y++) {
    const a = y * width, b = a - width;
    for (let x = left; x <= right; x++) if (cells[a + x] !== cells[b + x]) { rowChanges.push(y); break; }
  }
  for (let x = left + 1; x <= right; x++) {
    for (let y = top; y <= bottom; y++) if (cells[y * width + x] !== cells[y * width + x - 1]) { colChanges.push(x); break; }
  }
  const sx = nativeStep(colChanges, left, right), sy = nativeStep(rowChanges, top, bottom);
  // Both axes must show the coarse grid; one-axis evidence (e.g. a rotated rectangle) is not trusted.
  if (sx.step < 2 || sy.step < 2) return { x: { step: 1, phase: 0 }, y: { step: 1, phase: 0 } };
  return { x: sx, y: sy };
}

/** Separable area-average onto the native grid of one axis, as index/weight tables for bilinear re-enlargement. */
function axisPlan(length: number, step: number, phase: number) {
  const cellOf = new Int32Array(length);
  let minCell = Infinity, maxCell = -Infinity;
  for (let p = 0; p < length; p++) { const cell = Math.floor((p + 0.5 - phase) / step); cellOf[p] = cell; if (cell < minCell) minCell = cell; if (cell > maxCell) maxCell = cell; }
  const cells = maxCell - minCell + 1;
  for (let p = 0; p < length; p++) cellOf[p] -= minCell;
  // Bilinear sampling position of every pixel centre on the native grid (cell centres at integers).
  const lo = new Int32Array(length), t = new Float32Array(length);
  for (let p = 0; p < length; p++) { const u = (p + 0.5 - phase) / step - 0.5 - minCell, i = Math.floor(u); lo[p] = i; t[p] = u - i; }
  return { cells, cellOf, lo, t };
}

/**
 * Re-decodes a mask enlarged from a coarse native grid: area-average back onto that grid, then
 * bilinear enlargement to the source grid and a 0.5 threshold. Returns a new binary raster.
 */
function resampleNative(cells: Uint8Array, width: number, height: number, native: ReturnType<typeof detectNative>): Uint8Array {
  const px = axisPlan(width, native.x.step, native.x.phase), py = axisPlan(height, native.y.step, native.y.phase);
  const cw = px.cells, ch = py.cells, sum = new Float32Array(cw * ch), hits = new Float32Array(cw * ch);
  for (let y = 0; y < height; y++) {
    const row = py.cellOf[y] * cw;
    for (let x = 0; x < width; x++) { const c = row + px.cellOf[x]; sum[c] += cells[y * width + x]; hits[c]++; }
  }
  for (let i = 0; i < sum.length; i++) sum[i] = hits[i] ? sum[i] / hits[i] : 0;
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < cw && j < ch ? sum[j * cw + i] : 0;
  // Horizontal pass on every native row, then vertical.
  const wide = new Float32Array(width * ch);
  for (let j = 0; j < ch; j++) for (let x = 0; x < width; x++) { const i = px.lo[x], t = px.t[x]; wide[j * width + x] = at(i, j) * (1 - t) + at(i + 1, j) * t; }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const j = py.lo[y], t = py.t[y], r0 = j >= 0 && j < ch, r1 = j + 1 >= 0 && j + 1 < ch;
    for (let x = 0; x < width; x++) {
      const value = (r0 ? wide[j * width + x] : 0) * (1 - t) + (r1 ? wide[(j + 1) * width + x] : 0) * t;
      out[y * width + x] = value >= 0.5 ? 1 : 0;
    }
  }
  return out;
}

/**
 * Speck/outside-box removal, hole filling, native-grid re-decoding, close/open, margin clamp and
 * edge smoothing of a binary mask raster. The field covers the foreground's bounding box plus room
 * for the reshaping and the smoothing kernel; an empty mask yields an empty field.
 */
export function refineMaskField(raster: Uint8Array, width: number, height: number, options: RefineMaskOptions): RefinedMaskField {
  assertRaster(raster, width, height, options);
  const threshold = options.threshold ?? 1;
  const minShare = options.minComponentShare ?? MIN_COMPONENT_SHARE, holeShare = options.maxHoleShare ?? MAX_HOLE_SHARE;
  let left = width, right = -1, top = height, bottom = -1, inputPixels = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (raster[y * width + x] < threshold) continue;
    inputPixels++;
    if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
  }
  const report: MaskRefinementReport = {
    inputPixels, removedComponents: 0, removedPixels: 0, filledHoles: 0, filledPixels: 0, edgeSigma: 0,
    nativeFactor: { x: 1, y: 1 }, morphRadius: 0, openSkipped: false, edgeAddedPixels: 0, edgeRemovedPixels: 0, maxGrowthPx: 0,
  };
  if (right < 0) return { field: new Float32Array(0), width: 0, height: 0, ox: 0, oy: 0, area: 0, gain: 1, report };

  // Local grid: the foreground's bounding box with room for resampling, close/open, the growth
  // margin and the smoothing kernel. Cells outside the grid are background ("outside").
  const smoothingPad = Math.ceil(3 * Math.max(options.sigma, NATIVE_SIGMA_SHARE * MAX_NATIVE_FACTOR));
  const pad = MAX_NATIVE_FACTOR + MAX_MORPH_RADIUS + 4 + smoothingPad;
  const lw = right - left + 1 + pad * 2, lh = bottom - top + 1 + pad * 2, gx = left - pad, gy = top - pad;
  let cells: Uint8Array = new Uint8Array(lw * lh);
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) if (raster[y * width + x] >= threshold) cells[(y - gy) * lw + x - gx] = 1;
  const box = options.keepBox ? { left: options.keepBox.left - gx, top: options.keepBox.top - gy, right: options.keepBox.right - gx, bottom: options.keepBox.bottom - gy } : null;

  // 1–2. Specks and pin-holes of the mask as supplied (these are the reported counts).
  const specks = dropSpecks(cells, lw, lh, inputPixels * minShare, box);
  report.removedComponents = specks.components; report.removedPixels = specks.pixels;
  const holes = fillHoles(cells, lw, lh, (inputPixels - specks.pixels) * holeShare);
  report.filledHoles = holes.holes; report.filledPixels = holes.pixels;
  const cleaned: Uint8Array = Uint8Array.from(cells), cleanedArea = inputPixels - specks.pixels + holes.pixels;

  // 3. Undo a coarse native grid: area-average onto it, bilinear re-enlargement, re-threshold.
  const native = options.detectNative === false ? { x: { step: 1, phase: 0 }, y: { step: 1, phase: 0 } } : detectNative(cells, lw, lh);
  report.nativeFactor = { x: Number(native.x.step.toFixed(3)), y: Number(native.y.step.toFixed(3)) };
  const nativeStepMax = Math.max(native.x.step, native.y.step);
  if (nativeStepMax > 1) {
    cells = resampleNative(cells, lw, lh, native);
  }

  // 4. Close then open with a disk scaled to the subject size.
  // At least half a native cell, so one-cell bites and bumps of a coarse grid are closed/opened too.
  const radius = options.morphRadius ?? Math.min(MAX_MORPH_RADIUS, Math.max(Math.round(Math.sqrt(cleanedArea) * MORPH_RADIUS_SHARE), nativeStepMax > 1 ? Math.round(nativeStepMax / 2) : 0));
  // Resampling and the open can leave new fragments or pin-holes: clean once more (unreported).
  // Without the box: step 1 already applied it, and a part the open cuts off at a thin neck was
  // connected to the subject in the SAM mask — it may lie outside the box and is still the subject.
  const reclean = (mask: Uint8Array): Uint8Array => {
    dropSpecks(mask, lw, lh, cleanedArea * minShare, null);
    fillHoles(mask, lw, lh, cleanedArea * holeShare);
    return mask;
  };
  if (radius > 0) {
    const closed = morph(morph(cells, lw, lh, radius, true), lw, lh, radius, false);
    // The open-loss guard counts what the open erodes and what the re-clean then drops (parts cut
    // off at a neck), so a detached real part can never slip past it.
    const opened = reclean(morph(morph(closed, lw, lh, radius, false), lw, lh, radius, true));
    if (count(opened) >= count(closed) * (1 - MAX_OPEN_LOSS)) cells = opened;
    else { cells = reclean(closed); report.openSkipped = true; }
  } else if (nativeStepMax > 1) {
    cells = reclean(cells);
  }
  report.morphRadius = radius;

  // 5. Never grow past a small margin of the cleaned selection (no background halo).
  const margin = Math.max(2, radius + 1, Math.ceil(nativeStepMax / 2) + 1);
  report.maxGrowthPx = margin;
  const allowed = morph(cleaned, lw, lh, margin, true);
  let area = 0, added = 0, removed = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] && !allowed[i]) cells[i] = 0;
    if (cells[i]) { area++; if (!cleaned[i]) added++; } else if (cleaned[i]) removed++;
  }
  if (!area) { cells = cleaned; area = cleanedArea; added = 0; removed = 0; }
  report.edgeAddedPixels = added; report.edgeRemovedPixels = removed;

  // 6. Edge smoothing; the smoothed field is also kept inside the growth margin.
  const binary = new Float32Array(lw * lh);
  for (let i = 0; i < cells.length; i++) binary[i] = cells[i];
  let field = binary;
  const sigma = nativeStepMax > 1 ? Math.min(16, Math.max(options.sigma, NATIVE_SIGMA_SHARE * nativeStepMax)) : options.sigma;
  if (sigma > 0) {
    const smoothed = Float32Array.from(binary);
    blur(smoothed, lw, lh, kernel(sigma));
    let peak = 0;
    for (let i = 0; i < smoothed.length; i++) {
      if (!allowed[i]) smoothed[i] = 0;
      if (smoothed[i] > peak) peak = smoothed[i];
    }
    // A subject thinner than the kernel would vanish: keep its hard edge instead.
    if (peak >= 0.55) { field = smoothed; report.edgeSigma = sigma; }
  }
  return {
    field, width: lw, height: lh, ox: gx, oy: gy, area,
    gain: report.edgeSigma > 0 ? report.edgeSigma * Math.sqrt(2 * Math.PI) : 1,
    report,
  };
}

/**
 * Compositing alpha of the refined mask at raster position (u, v) (pixel centres at integers),
 * bilinearly sampled, with a linear edge ramp about `rampPx` raster pixels wide.
 */
export function refinedAlphaAt(mask: RefinedMaskField, u: number, v: number, rampPx: number): number {
  const fu = u - mask.ox, fv = v - mask.oy, i0 = Math.floor(fu), j0 = Math.floor(fv);
  if (i0 < -1 || j0 < -1 || i0 >= mask.width || j0 >= mask.height) return 0;
  const fx = fu - i0, fy = fv - j0, w = mask.width, h = mask.height, f = mask.field;
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < h ? f[j * w + i] : 0;
  const value = (at(i0, j0) * (1 - fx) + at(i0 + 1, j0) * fx) * (1 - fy) + (at(i0, j0 + 1) * (1 - fx) + at(i0 + 1, j0 + 1) * fx) * fy;
  return clamp01((value - 0.5) * mask.gain / Math.max(1e-6, rampPx) + 0.5);
}

/**
 * Full-size 8-bit compositing alpha for a still's SAM mask (0/255 or any values thresholded at
 * `threshold`), with an edge ramp about `rampPx` source pixels wide (default maskFeatherPx). The
 * input raster is not modified.
 */
export function refineMaskAlpha(raster: Uint8Array, width: number, height: number, options: RefineMaskOptions & { rampPx?: number }): { alpha: Uint8Array; area: number; report: MaskRefinementReport } {
  const refined = refineMaskField(raster, width, height, options);
  const alpha = new Uint8Array(width * height);
  const rampPx = options.rampPx ?? maskFeatherPx(width, height);
  if (!(rampPx > 0 && rampPx <= 8)) throw new Error("Mask refinement ramp is out of range.");
  const scale = refined.gain / rampPx;
  for (let j = 0; j < refined.height; j++) {
    const y = j + refined.oy;
    if (y < 0 || y >= height) continue;
    for (let i = 0; i < refined.width; i++) {
      const x = i + refined.ox;
      if (x < 0 || x >= width) continue;
      const a = clamp01((refined.field[j * refined.width + i] - 0.5) * scale + 0.5);
      if (a > 0) alpha[y * width + x] = Math.round(a * 255);
    }
  }
  return { alpha, area: refined.area, report: refined.report };
}
