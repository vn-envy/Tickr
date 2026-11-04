/**
 * Deterministic, alpha-only refinement of SAM masks for compositing.
 *
 * SAM masks arrive as hard binary rasters: isolated speck pixels, pin-holes and single-pixel
 * stair steps along every slanted edge. Enlarged into a 1080×1920 frame those read as dirt and
 * jagged outlines. This module derives a compositing alpha from the mask:
 *
 * 1. foreground components (8-connected) smaller than MIN_COMPONENT_SHARE of the selected area are
 *    dropped (the largest component is always kept);
 * 2. enclosed background holes (4-connected, not touching the outside) smaller than MAX_HOLE_SHARE
 *    of the selected area are filled — real openings such as a cup handle's loop are larger and kept;
 * 3. the cleaned mask is smoothed by a small exact Gaussian and re-thresholded at 0.5 with a narrow
 *    linear ramp, which rounds off stair steps and one-pixel notches into an anti-aliased edge.
 *
 * Only alpha changes: callers keep the source RGB untouched and never write the refined alpha back
 * over the SAM mask they were given (that file stays the provenance record). Every step is
 * reported so the refinement is visible in layout/QA reports. No network, no model.
 */

/** Foreground components below this share of the selected area are specks. */
export const MIN_COMPONENT_SHARE = 0.002;
/** Enclosed holes below this share of the selected area are mask noise and are filled. */
export const MAX_HOLE_SHARE = 0.002;
/** Largest raster refined in one call (matches the still-depth input limit). */
const MAX_REFINE_PIXELS = 40_000_000;

export interface MaskRefinementReport {
  /** Foreground pixels of the mask as supplied. */
  inputPixels: number;
  removedComponents: number;
  removedPixels: number;
  filledHoles: number;
  filledPixels: number;
  /** Gaussian sigma (mask pixels) of the edge smoothing; 0 when smoothing would have erased the subject. */
  edgeSigma: number;
}

export interface RefineMaskOptions {
  /** Edge smoothing sigma in mask pixels (0 disables smoothing). */
  sigma: number;
  /** Raster values at or above this are foreground. Default 1 (any non-zero value). */
  threshold?: number;
  minComponentShare?: number;
  maxHoleShare?: number;
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
  /** Foreground pixels after speck removal and hole filling. */
  area: number;
  /** Field slope normaliser: alpha = clamp01((field − 0.5) · gain / rampPx + 0.5). */
  gain: number;
  report: MaskRefinementReport;
}

const clamp01 = (value: number) => value <= 0 ? 0 : value >= 1 ? 1 : value;

function assertRaster(raster: Uint8Array, width: number, height: number, options: RefineMaskOptions): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_REFINE_PIXELS || !(raster instanceof Uint8Array) || raster.length !== width * height) {
    throw new Error("Mask dimensions do not match its raster.");
  }
  if (!(options.sigma >= 0 && options.sigma <= 16)) throw new Error("Mask refinement sigma is out of range.");
}

/** Normalised 1-D Gaussian kernel of radius ceil(3σ). */
function kernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3)), out = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) { const value = Math.exp(-(i * i) / (2 * sigma * sigma)); out[i + radius] = value; sum += value; }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

/** Separable zero-padded convolution with a symmetric kernel, in place. */
function blur(data: Float32Array, width: number, height: number, k: Float32Array): void {
  const radius = (k.length - 1) / 2, tmp = new Float32Array(data.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let t = -radius; t <= radius; t++) { const xx = x + t; if (xx >= 0 && xx < width) sum += data[row + xx] * k[t + radius]; }
      tmp[row + x] = sum;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let t = -radius; t <= radius; t++) { const yy = y + t; if (yy >= 0 && yy < height) sum += tmp[yy * width + x] * k[t + radius]; }
      data[y * width + x] = sum;
    }
  }
}

/**
 * Connected components of cells equal to `value` (8- or 4-connected). Returns per-cell labels
 * (0 = other value) and per-label sizes and border contact (index 0 unused).
 */
function components(cells: Uint8Array, width: number, height: number, value: 0 | 1, eight: boolean) {
  const labels = new Int32Array(cells.length), sizes: number[] = [0], border: boolean[] = [false];
  const stack = new Int32Array(cells.length);
  let next = 0;
  for (let start = 0; start < cells.length; start++) {
    if (cells[start] !== value || labels[start]) continue;
    const label = ++next;
    let top = 0, size = 0, touches = false;
    stack[top++] = start; labels[start] = label;
    while (top) {
      const i = stack[--top], x = i % width, y = (i - x) / width;
      size++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touches = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (!eight && dx && dy)) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (cells[j] === value && !labels[j]) { labels[j] = label; stack[top++] = j; }
      }
    }
    sizes.push(size); border.push(touches);
  }
  return { labels, sizes, border };
}

/**
 * Speck removal, hole filling and edge smoothing of a binary mask raster. The field covers the
 * foreground's bounding box plus room for the smoothing kernel; an empty mask yields an empty field.
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
  const empty = (sigma: number): RefinedMaskField => ({
    field: new Float32Array(0), width: 0, height: 0, ox: 0, oy: 0, area: 0, gain: 1,
    report: { inputPixels, removedComponents: 0, removedPixels: 0, filledHoles: 0, filledPixels: 0, edgeSigma: sigma },
  });
  if (right < 0) return empty(0);

  // Local grid: the foreground's bounding box with a one-cell background margin (the "outside").
  const lw = right - left + 3, lh = bottom - top + 3;
  const cells = new Uint8Array(lw * lh);
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) if (raster[y * width + x] >= threshold) cells[(y - top + 1) * lw + x - left + 1] = 1;

  // 1. Specks: foreground components below the share of the selected area (never the largest one).
  const fg = components(cells, lw, lh, 1, true);
  let largest = 1;
  for (let label = 2; label < fg.sizes.length; label++) if (fg.sizes[label] > fg.sizes[largest]) largest = label;
  const minComponent = inputPixels * minShare;
  let removedComponents = 0, removedPixels = 0;
  const drop = new Uint8Array(fg.sizes.length);
  for (let label = 1; label < fg.sizes.length; label++) {
    if (label !== largest && fg.sizes[label] < minComponent) { drop[label] = 1; removedComponents++; removedPixels += fg.sizes[label]; }
  }
  if (removedComponents) for (let i = 0; i < cells.length; i++) if (drop[fg.labels[i]]) cells[i] = 0;

  // 2. Holes: enclosed background components below the share of the remaining area.
  const area0 = inputPixels - removedPixels, maxHole = area0 * holeShare;
  const bg = components(cells, lw, lh, 0, false);
  let filledHoles = 0, filledPixels = 0;
  const fill = new Uint8Array(bg.sizes.length);
  for (let label = 1; label < bg.sizes.length; label++) {
    if (!bg.border[label] && bg.sizes[label] < maxHole) { fill[label] = 1; filledHoles++; filledPixels += bg.sizes[label]; }
  }
  if (filledHoles) for (let i = 0; i < cells.length; i++) if (fill[bg.labels[i]]) cells[i] = 1;
  const area = area0 + filledPixels;

  // 3. Edge smoothing on a grid padded for the kernel.
  const sigma = options.sigma;
  const pad = sigma > 0 ? Math.ceil(sigma * 3) + 1 : 1;
  const fw = lw + pad * 2, fh = lh + pad * 2;
  const binary = new Float32Array(fw * fh);
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) binary[(y + pad) * fw + x + pad] = cells[y * lw + x];
  let field = binary, edgeSigma = 0;
  if (sigma > 0) {
    const smoothed = Float32Array.from(binary);
    blur(smoothed, fw, fh, kernel(sigma));
    let peak = 0;
    for (let i = 0; i < smoothed.length; i++) if (smoothed[i] > peak) peak = smoothed[i];
    // A subject thinner than the kernel would vanish: keep its hard edge instead.
    if (peak >= 0.55) { field = smoothed; edgeSigma = sigma; }
  }
  return {
    field, width: fw, height: fh, ox: left - 1 - pad, oy: top - 1 - pad, area,
    gain: edgeSigma > 0 ? edgeSigma * Math.sqrt(2 * Math.PI) : 1,
    report: { inputPixels, removedComponents, removedPixels, filledHoles, filledPixels, edgeSigma },
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
 * `threshold`), with an edge ramp about `rampPx` source pixels wide. The input raster is not modified.
 */
export function refineMaskAlpha(raster: Uint8Array, width: number, height: number, options: RefineMaskOptions & { rampPx?: number }): { alpha: Uint8Array; area: number; report: MaskRefinementReport } {
  const refined = refineMaskField(raster, width, height, options);
  const alpha = new Uint8Array(width * height);
  const scale = refined.gain / Math.max(1e-6, options.rampPx ?? 1);
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
