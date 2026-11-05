import type { PixelBounds } from "./cinema-types";

/**
 * Deterministic shape-quality metrics of a (refined) SAM selection, and the gate that decides
 * whether its cutout may be used as a subject layer.
 *
 * Why: a box-prompted SAM mask can stop mid-object — e.g. selecting a jar's lid and cream layer
 * but stopping at its paper label, with a ragged, torn-looking lower boundary — or split into
 * fragments (two objects, label pieces with jagged holes). Composited as a cutout that reads as a
 * torn product. A smooth, solid selection (a cupcake, a cup, a plate) is fine. The metrics are
 * computed once on a downsampled copy of the mask (long side ≤ METRIC_LONG_SIDE cells, majority
 * vote per cell, so pixel noise and the refinement's anti-aliasing do not move them):
 *
 * - solidity: mask area ÷ convex-hull area (the hull of the cells' corner points);
 * - roughness: mask perimeter ÷ convex-hull perimeter. The perimeter is the Cauchy–Crofton
 *   estimate from fg/bg transitions along four line directions (0°, 45°, 90°, 135°), so it counts
 *   hole boundaries and every jag of a torn edge, but a digitised smooth curve is not inflated the
 *   way a 4-connected crack length (×4/π on a disk) would be;
 * - component count (8-connected) and the largest component's share of the area;
 * - cut-through: with the grounded subject box (Spark's box the SAM prompt was built from), the
 *   mask's extreme profile toward each box side (e.g. the lowest selected cell of every column). A
 *   long contiguous run of that profile lying deep inside the box (≥ CUT_DEPTH of the box size
 *   from that side) and spanning most of the box (≥ CUT_SPAN) and of the mask itself
 *   (≥ CUT_MASK_SPAN) is a boundary running through the box interior rather than near its edge:
 *   the mask stopped mid-object. A round object inscribed in its box only has profile cells that
 *   deep in its outermost columns (an inscribed ellipse: ≈ 7% of the box per side, far below
 *   CUT_SPAN), and a triangle/diamond's deep profile covers at most half of the shape, so neither
 *   trips it.
 *
 * Nothing here changes the mask or any pixel; the report only decides whether the cutout is used.
 * No network, no model: a pure function of the raster and the box.
 */
export const MASK_QUALITY_VERSION = 1;
/** Long side (cells) of the metric grid; larger masks are majority-downsampled. */
export const METRIC_LONG_SIDE = 256;
/** Below this many selected cells the shape is too small to judge; the gate does not fail it. */
export const MIN_METRIC_CELLS = 64;

/**
 * Gate thresholds, calibrated on synthetic shapes (tests/unit/mask-quality.test.ts) that replicate
 * the 5 Nov 2026 incident and ordinary products:
 * - disk/cupcake/plate/rectangle: solidity ≥ 0.95, roughness 0.95–1.05, one component;
 * - a cup with a handle loop or a bottle with a neck: solidity ≈ 0.85–0.88 with a smooth edge
 *   (roughness ≈ 1.05–1.17), so smooth non-convex products keep a lower solidity floor;
 * - pixel noise (scattered bites/specks of a few px) moves solidity/roughness by < 0.01;
 * - the torn jar (solid lid/cream, ragged cut ending ~half way down its box): cut-through
 *   (depth ≈ 0.4, span ≈ 0.9) and roughness > 1.25; a cleanly straight cut is still cut-through;
 * - the fragmented two-jar mask: largest share ≈ 0.55, solidity < 0.8, roughness > 1.3.
 */
export const MIN_SOLIDITY = 0.88;
/** A smooth outline (roughness ≤ SMOOTH_ROUGHNESS) may be this non-convex: handles, necks, saucers. */
export const MIN_SMOOTH_SOLIDITY = 0.78;
export const SMOOTH_ROUGHNESS = 1.18;
export const MAX_ROUGHNESS = 1.25;
export const MIN_LARGEST_SHARE = 0.92;
/** A profile cell is "deep" when it lies at least this share of the box size inside the box side. */
export const CUT_DEPTH = 0.25;
/** A strong cut-through spans at least this share of the box side … */
export const CUT_SPAN = 0.5;
/** … and at least this share of the mask's own extent along that side. */
export const CUT_MASK_SPAN = 0.8;
/** Non-deep gaps up to this share of the box side do not split a cut (a ragged tear dips). */
const CUT_GAP = 0.05;

export type MaskQualityFailure = "low_solidity" | "rough_edge" | "fragmented" | "cut_through";
export type BoxSide = "top" | "bottom" | "left" | "right";

export interface MaskCutThrough {
  side: BoxSide;
  /** Mean depth of the run's profile inside the box, as a share of the box size across that side. */
  depth: number;
  /** Deep profile cells of the run ÷ box cells along that side. */
  span: number;
  /** Deep profile cells of the run ÷ the mask's own extent (within the box) along that side. */
  maskSpan: number;
  strong: boolean;
}

export interface MaskShapeQuality {
  version: typeof MASK_QUALITY_VERSION;
  /** Metric grid size and source pixels per cell. */
  grid: { width: number; height: number; scale: number };
  /** Selected cells of the metric grid. */
  area: number;
  solidity: number;
  roughness: number;
  components: number;
  largestComponentShare: number;
  /** Strongest cut-through candidate (null without a box, or when no profile lies deep inside it). */
  cutThrough: MaskCutThrough | null;
  /** False when the shape was too small to judge (the gate then does not fail it). */
  measured: boolean;
  clean: boolean;
  failures: MaskQualityFailure[];
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** Andrew's monotone chain; points as flat [x0, y0, x1, y1, …]. Returns the hull in CCW order. */
function convexHull(points: number[]): Array<[number, number]> {
  const list: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i += 2) list.push([points[i], points[i + 1]]);
  list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (list.length < 3) return list;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [], upper: Array<[number, number]> = [];
  for (const p of list) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = list.length - 1; i >= 0; i--) { const p = list[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Majority-vote downsampling of the region [left, right) × [top, bottom) by `scale` source pixels per cell. */
function downsample(mask: Uint8Array, width: number, region: PixelBounds, scale: number, threshold: number) {
  const gw = Math.ceil((region.right - region.left) / scale), gh = Math.ceil((region.bottom - region.top) / scale);
  const sum = new Uint32Array(gw * gh), hits = new Uint32Array(gw * gh);
  for (let y = region.top; y < region.bottom; y++) {
    const row = Math.floor((y - region.top) / scale) * gw, offset = y * width;
    for (let x = region.left; x < region.right; x++) {
      const cell = row + Math.floor((x - region.left) / scale);
      hits[cell]++;
      if (mask[offset + x] >= threshold) sum[cell]++;
    }
  }
  const cells = new Uint8Array(gw * gh);
  for (let i = 0; i < cells.length; i++) cells[i] = hits[i] && sum[i] * 2 >= hits[i] ? 1 : 0;
  return { cells, gw, gh };
}

/**
 * Connected components of cells equal to `value` (8- or 4-connected, BFS with an explicit queue).
 * Returns a label per cell (0 = not `value`), per-label sizes and whether the label touches the grid border.
 */
function label(cells: Uint8Array, gw: number, gh: number, value: 0 | 1, eight: boolean) {
  const labels = new Int32Array(cells.length), queue = new Int32Array(cells.length), sizes: number[] = [0], border: boolean[] = [false];
  for (let start = 0; start < cells.length; start++) {
    if (cells[start] !== value || labels[start]) continue;
    const id = sizes.length;
    let head = 0, tail = 0, size = 0, touches = false;
    queue[tail++] = start; labels[start] = id;
    while (head < tail) {
      const i = queue[head++], x = i % gw, y = (i - x) / gw;
      size++;
      if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) touches = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (!eight && dx && dy)) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh) { const n = ny * gw + nx; if (cells[n] === value && !labels[n]) { labels[n] = id; queue[tail++] = n; } }
      }
    }
    sizes.push(size); border.push(touches);
  }
  return { labels, sizes, border };
}

/**
 * 3×3 majority filter (≥ 5 of 9 cells, outside = background): one-cell jaggies of pixel noise are
 * not raggedness, while a torn edge's teeth span several cells and survive.
 */
function majority(cells: Uint8Array, gw: number, gh: number): Uint8Array {
  const out = new Uint8Array(cells.length);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < gw && ny < gh) sum += cells[ny * gw + nx];
    }
    out[y * gw + x] = sum >= 5 ? 1 : 0;
  }
  return out;
}

/** Cauchy–Crofton perimeter from fg/bg transitions along 0°, 90°, 45° and 135° lines (outside = background). */
function croftonPerimeter(cells: Uint8Array, gw: number, gh: number): number {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < gw && y < gh ? cells[y * gw + x] : 0;
  let axis = 0, diagonal = 0;
  for (let y = -1; y < gh; y++) for (let x = -1; x < gw; x++) {
    const here = at(x, y);
    if (here !== at(x + 1, y)) axis++;
    if (here !== at(x, y + 1)) axis++;
    if (here !== at(x + 1, y + 1)) diagonal++;
    if (at(x + 1, y) !== at(x, y + 1)) diagonal++;
  }
  return (Math.PI / 8) * (axis + diagonal / Math.SQRT2);
}

/**
 * The strongest run of the mask's extreme profile lying deep inside the box. Box in grid
 * coordinates (half-open, fractional allowed).
 */
function cutThrough(cells: Uint8Array, gw: number, gh: number, box: PixelBounds): MaskCutThrough | null {
  const bl = Math.max(0, Math.ceil(box.left - 0.5)), br = Math.min(gw, Math.ceil(box.right - 0.5));
  const bt = Math.max(0, Math.ceil(box.top - 0.5)), bb = Math.min(gh, Math.ceil(box.bottom - 0.5));
  const boxW = box.right - box.left, boxH = box.bottom - box.top;
  if (br - bl < 4 || bb - bt < 4 || !(boxW > 0 && boxH > 0)) return null;
  let best: MaskCutThrough | null = null;
  const sides: BoxSide[] = ["bottom", "top", "left", "right"];
  for (const side of sides) {
    const horizontal = side === "bottom" || side === "top";
    // Positions along the side (columns for top/bottom, rows for left/right) inside the box.
    const from = horizontal ? bl : bt, to = horizontal ? br : bb, along = horizontal ? boxW : boxH, across = horizontal ? boxH : boxW;
    const depths: Array<number | null> = [];
    for (let p = from; p < to; p++) {
      // Extreme selected cell of this column/row toward the side, over the whole grid.
      let extreme = -1;
      if (side === "bottom") { for (let y = gh - 1; y >= 0; y--) if (cells[y * gw + p]) { extreme = y + 1; break; } }
      else if (side === "top") { for (let y = 0; y < gh; y++) if (cells[y * gw + p]) { extreme = y; break; } }
      else if (side === "right") { for (let x = gw - 1; x >= 0; x--) if (cells[p * gw + x]) { extreme = x + 1; break; } }
      else { for (let x = 0; x < gw; x++) if (cells[p * gw + x]) { extreme = x; break; } }
      if (extreme < 0) { depths.push(null); continue; }
      const depth = side === "bottom" ? box.bottom - extreme : side === "top" ? extreme - box.top : side === "right" ? box.right - extreme : extreme - box.left;
      depths.push(depth / across);
    }
    const present = depths.filter((depth) => depth !== null).length;
    if (!present) continue;
    const maxGap = Math.max(1, Math.floor(along * CUT_GAP));
    let runCells = 0, runDepth = 0, gap = 0, bestCells = 0, bestDepth = 0;
    for (const depth of depths) {
      if (depth !== null && depth >= CUT_DEPTH) { runCells++; runDepth += depth; gap = 0; }
      else if (runCells && depth !== null && ++gap <= maxGap) { /* a dip of a ragged tear */ }
      else { runCells = 0; runDepth = 0; gap = 0; }
      if (runCells > bestCells) { bestCells = runCells; bestDepth = runDepth; }
    }
    if (!bestCells) continue;
    const span = bestCells / along, maskSpan = bestCells / present;
    const candidate: MaskCutThrough = { side, depth: round4(bestDepth / bestCells), span: round4(Math.min(1, span)), maskSpan: round4(Math.min(1, maskSpan)), strong: span >= CUT_SPAN && maskSpan >= CUT_MASK_SPAN };
    if (!best || Number(candidate.strong) > Number(best.strong) || (candidate.strong === best.strong && candidate.span > best.span)) best = candidate;
  }
  return best;
}

/**
 * Shape quality of a full-size mask raster (values ≥ `threshold` are selected; default 128, the
 * refined alpha's 0.5 level). `box` is the grounded subject box in raster pixels (half-open).
 */
export function maskShapeQuality(mask: Uint8Array, width: number, height: number, options: { box?: PixelBounds | null; threshold?: number } = {}): MaskShapeQuality {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || mask.length !== width * height) throw new Error("Mask dimensions do not match its raster.");
  const threshold = options.threshold ?? 128;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    const offset = y * width;
    for (let x = 0; x < width; x++) if (mask[offset + x] >= threshold) { if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; bottom = y; }
  }
  const empty: MaskShapeQuality = { version: MASK_QUALITY_VERSION, grid: { width: 0, height: 0, scale: 1 }, area: 0, solidity: 0, roughness: 0, components: 0, largestComponentShare: 0, cutThrough: null, measured: false, clean: false, failures: ["fragmented"] };
  if (right < 0) return empty;
  // Region: the selection's bounds united with the box (clipped to the raster), so the profile
  // toward every box side is measured on the same grid.
  const box = options.box && [options.box.left, options.box.top, options.box.right, options.box.bottom].every(Number.isFinite) && options.box.right > options.box.left && options.box.bottom > options.box.top ? options.box : null;
  const region: PixelBounds = {
    left: Math.max(0, Math.min(left, box ? Math.floor(box.left) : left)), top: Math.max(0, Math.min(top, box ? Math.floor(box.top) : top)),
    right: Math.min(width, Math.max(right + 1, box ? Math.ceil(box.right) : right + 1)), bottom: Math.min(height, Math.max(bottom + 1, box ? Math.ceil(box.bottom) : bottom + 1)),
  };
  const scale = Math.max(1, Math.ceil(Math.max(region.right - region.left, region.bottom - region.top) / METRIC_LONG_SIDE));
  const { cells, gw, gh } = downsample(mask, width, region, scale, threshold);
  let area = 0;
  for (let i = 0; i < cells.length; i++) area += cells[i];
  const grid = { width: gw, height: gh, scale };
  if (!area) return { ...empty, grid };
  // Solidity and roughness describe the main piece: the largest component, its holes included.
  // Other pieces are judged by the largest-component share, so a speck never inflates the hull.
  const fg = label(cells, gw, gh, 1, true);
  let main = 1;
  for (let id = 2; id < fg.sizes.length; id++) if (fg.sizes[id] > fg.sizes[main]) main = id;
  const mainArea = fg.sizes[main];
  const piece = new Uint8Array(cells.length);
  for (let i = 0; i < cells.length; i++) if (fg.labels[i] === main) piece[i] = 1;
  // Holes filled for the perimeter: roughness measures the outline (a torn edge), while holes —
  // real openings such as a cup handle's loop, or jagged gaps — count against solidity instead.
  const bg = label(piece, gw, gh, 0, false), outline = Uint8Array.from(piece);
  for (let i = 0; i < cells.length; i++) if (!piece[i] && !bg.border[bg.labels[i]]) outline[i] = 1;
  const corners: number[] = [];
  for (let y = 0; y < gh; y++) {
    let first = -1, last = -1;
    for (let x = 0; x < gw; x++) if (piece[y * gw + x]) { if (first < 0) first = x; last = x; }
    if (first >= 0) corners.push(first, y, first, y + 1, last + 1, y, last + 1, y + 1);
  }
  const hull = convexHull(corners);
  let hullArea = 0, hullPerimeter = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x0, y0] = hull[i], [x1, y1] = hull[(i + 1) % hull.length];
    hullArea += x0 * y1 - x1 * y0; hullPerimeter += Math.hypot(x1 - x0, y1 - y0);
  }
  hullArea = Math.abs(hullArea) / 2;
  const solidity = round4(Math.min(1, mainArea / Math.max(1, hullArea)));
  const roughness = round4(croftonPerimeter(majority(outline, gw, gh), gw, gh) / Math.max(1e-9, hullPerimeter));
  const largestComponentShare = round4(mainArea / area);
  const components = fg.sizes.length - 1;
  const cut = box ? cutThrough(cells, gw, gh, { left: (box.left - region.left) / scale, top: (box.top - region.top) / scale, right: (box.right - region.left) / scale, bottom: (box.bottom - region.top) / scale }) : null;
  const measured = area >= MIN_METRIC_CELLS;
  const failures: MaskQualityFailure[] = [];
  if (measured) {
    if (cut?.strong) failures.push("cut_through");
    if (largestComponentShare < MIN_LARGEST_SHARE) failures.push("fragmented");
    if (roughness > MAX_ROUGHNESS) failures.push("rough_edge");
    if (solidity < MIN_SOLIDITY && !(roughness <= SMOOTH_ROUGHNESS && solidity >= MIN_SMOOTH_SOLIDITY)) failures.push("low_solidity");
  }
  return { version: MASK_QUALITY_VERSION, grid, area, solidity, roughness, components, largestComponentShare, cutThrough: cut, measured, clean: failures.length === 0, failures };
}

/** Owner-facing reason a cutout was not used (most specific failure first). */
export function maskQualityReason(quality: Pick<MaskShapeQuality, "failures">): string {
  const failures = new Set(quality.failures);
  if (failures.has("cut_through")) return "its mask stopped mid-object";
  if (failures.has("fragmented")) return "its mask split into separate fragments";
  if (failures.has("rough_edge")) return "its mask edge is ragged";
  if (failures.has("low_solidity")) return "its mask has large bites or holes";
  return "its mask did not pass the shape check";
}

/** "SAM cutout for <asset> was not used: <reason>; the photo is shown uncut." */
export function maskQualityNote(assetId: string, quality: Pick<MaskShapeQuality, "failures">): string {
  return `SAM cutout for ${assetId} was not used: ${maskQualityReason(quality)}; the photo is shown uncut.`;
}
