/**
 * SAM 3.1 geometry prompts (box / positive point / negative point).
 *
 * Grammar per https://dev.meta.ai/docs/sam/segmenting (retrieved 2026-11-04):
 * - Text starts with a frame marker `<Nf>` (use `<0f>` for images); it applies to
 *   the prompts that follow until the next marker.
 * - After a marker, comma-separated objects; each is an integer id followed by tokens.
 * - Box: `<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>`, at most one per object per frame.
 * - Positive point: `<|point;x=..;y=..;w=..;h=..|>`; a negative point is prefixed with `-`.
 * - `w`/`h` must equal the media's displayed pixel size, otherwise the API returns 400.
 * - Geometry prompts cannot be mixed with a concept noun phrase; at most 16 objects.
 *
 * This module is pure: it builds and validates prompt text and converts Muse Spark's
 * normalized 0–1000 grounding grid into source pixels. It makes no network request.
 */
export const SAM_MAX_OBJECTS = 16;
export const SAM_MAX_POINTS_PER_FRAME = 12;
export const SAM_MAX_PROMPT_FRAMES = 32;
export const SPARK_GRID = 1000;

export interface SamMediaSize { width: number; height: number }
/** Inclusive integer source-pixel coordinates, matching SAM's own box tokens. */
export interface SamBox { x1: number; y1: number; x2: number; y2: number }
export interface SamPoint { x: number; y: number; polarity: "positive" | "negative" }
export interface SamFramePrompt { frame: number; box?: SamBox; points?: readonly SamPoint[] }
export interface SamObjectPrompt {
  /** Wire identity, 0–15. SAM echoes it as the object ordinal in its output. */
  objectId: number;
  /** Local label (for provenance/UI only). Never sent to the API. */
  label: string;
  /** Where the prompt came from; owner taps are the strongest region provenance. */
  origin: "owner_tap" | "spark_grounding" | "local_layout";
  prompts: readonly SamFramePrompt[];
}

export class SamPromptError extends Error {
  constructor(message: string) { super(message); this.name = "SamPromptError"; }
}

const fail = (message: string): never => { throw new SamPromptError(message); };
const isPixel = (value: number, limit: number) => Number.isSafeInteger(value) && value >= 0 && value < limit;

function checkSize(size: SamMediaSize) {
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1 || size.width > 8192 || size.height > 8192) {
    fail("SAM media dimensions must be positive integers no larger than 8192.");
  }
}

function boxToken(box: SamBox, size: SamMediaSize): string {
  if (![box.x1, box.x2].every((value) => isPixel(value, size.width)) || ![box.y1, box.y2].every((value) => isPixel(value, size.height)) || box.x2 <= box.x1 || box.y2 <= box.y1) {
    fail("A SAM box must lie inside the media and have positive area.");
  }
  return `<|box;x1=${box.x1};y1=${box.y1};x2=${box.x2};y2=${box.y2};w=${size.width};h=${size.height}|>`;
}

function pointToken(point: SamPoint, size: SamMediaSize): string {
  if (!isPixel(point.x, size.width) || !isPixel(point.y, size.height)) fail("A SAM point must lie inside the media.");
  if (point.polarity !== "positive" && point.polarity !== "negative") fail("A SAM point needs an explicit polarity.");
  return `${point.polarity === "negative" ? "-" : ""}<|point;x=${point.x};y=${point.y};w=${size.width};h=${size.height}|>`;
}

/**
 * Build one geometry prompt text. Frames are emitted in ascending order and each object
 * keeps one stable wire id across frames. For images every prompt must target frame 0.
 */
export function buildSamGeometryPrompt(objects: readonly SamObjectPrompt[], size: SamMediaSize, options: { media: "image" | "video"; frameCount?: number }): string {
  checkSize(size);
  if (!objects.length || objects.length > SAM_MAX_OBJECTS) fail(`SAM geometry prompts need between 1 and ${SAM_MAX_OBJECTS} objects.`);
  if (options.media === "video" && (!Number.isSafeInteger(options.frameCount) || options.frameCount! < 1)) fail("Video geometry prompts need the clip frame count.");
  const ids = new Set<number>();
  const frames = new Map<number, string[]>();
  for (const object of objects) {
    if (!Number.isSafeInteger(object.objectId) || object.objectId < 0 || object.objectId >= SAM_MAX_OBJECTS || ids.has(object.objectId)) fail("SAM object ids must be unique integers from 0 to 15.");
    ids.add(object.objectId);
    if (!object.prompts.length || object.prompts.length > SAM_MAX_PROMPT_FRAMES) fail("Each SAM object needs between 1 and 32 prompted frames.");
    const seenFrames = new Set<number>();
    const ordered = [...object.prompts].sort((a, b) => a.frame - b.frame);
    for (const [index, prompt] of ordered.entries()) {
      if (!Number.isSafeInteger(prompt.frame) || prompt.frame < 0 || seenFrames.has(prompt.frame)) fail("Each SAM object may be prompted once per distinct frame.");
      if (options.media === "image" && prompt.frame !== 0) fail("Image geometry prompts must use frame 0.");
      if (options.media === "video" && prompt.frame >= options.frameCount!) fail("A SAM prompt frame lies outside the clip.");
      seenFrames.add(prompt.frame);
      const points = prompt.points ?? [];
      if (points.length > SAM_MAX_POINTS_PER_FRAME) fail(`At most ${SAM_MAX_POINTS_PER_FRAME} points are allowed per object and frame.`);
      // An object's first appearance needs positive evidence; a negative-only prompt
      // would ask SAM to segment "not this", which is not a usable selection.
      if (index === 0 && !prompt.box && !points.some((point) => point.polarity === "positive")) fail("The first prompt for an object needs a box or a positive point.");
      if (!prompt.box && !points.length) fail("A SAM frame prompt needs a box or at least one point.");
      const tokens = `${object.objectId}${prompt.box ? boxToken(prompt.box, size) : ""}${points.map((point) => pointToken(point, size)).join("")}`;
      frames.set(prompt.frame, [...(frames.get(prompt.frame) ?? []), tokens]);
    }
  }
  return [...frames.entries()].sort(([a], [b]) => a - b).map(([frame, entries]) => `<${frame}f>${entries.join(",")}`).join("");
}

/** Muse Spark grounding box on its 0–1000 grid, relative to the image it received. */
export interface SparkGridBox { x_min: number; y_min: number; x_max: number; y_max: number }

/**
 * Convert a Spark 0–1000 grid box to inclusive source pixels. Spark may emit slightly
 * out-of-range values (e.g. 1001); they are clamped. Returns null for degenerate boxes.
 */
export function sparkGridBoxToPixels(box: SparkGridBox, size: SamMediaSize): SamBox | null {
  checkSize(size);
  const values = [box.x_min, box.y_min, box.x_max, box.y_max];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const clampGrid = (value: number) => Math.min(SPARK_GRID, Math.max(0, value));
  const [gx1, gy1, gx2, gy2] = values.map(clampGrid);
  const toPixel = (grid: number, limit: number) => Math.min(limit - 1, Math.max(0, Math.round(grid / SPARK_GRID * (limit - 1))));
  const result = { x1: toPixel(Math.min(gx1, gx2), size.width), y1: toPixel(Math.min(gy1, gy2), size.height), x2: toPixel(Math.max(gx1, gx2), size.width), y2: toPixel(Math.max(gy1, gy2), size.height) };
  return result.x2 - result.x1 >= 2 && result.y2 - result.y1 >= 2 ? result : null;
}

/** Convert a Spark 0–1000 grid point to a source pixel, clamped to the media. */
export function sparkGridPointToPixel(point: { x: number; y: number }, size: SamMediaSize): { x: number; y: number } | null {
  checkSize(size);
  if (![point.x, point.y].every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const toPixel = (grid: number, limit: number) => Math.min(limit - 1, Math.max(0, Math.round(Math.min(SPARK_GRID, Math.max(0, grid)) / SPARK_GRID * (limit - 1))));
  return { x: toPixel(point.x, size.width), y: toPixel(point.y, size.height) };
}

/** Scale an inclusive box between two rasters of the same media (e.g. preview → source). */
export function scaleSamBox(box: SamBox, from: SamMediaSize, to: SamMediaSize): SamBox {
  checkSize(from); checkSize(to);
  const sx = (to.width - 1) / Math.max(1, from.width - 1), sy = (to.height - 1) / Math.max(1, from.height - 1);
  const clampX = (value: number) => Math.min(to.width - 1, Math.max(0, Math.round(value * sx)));
  const clampY = (value: number) => Math.min(to.height - 1, Math.max(0, Math.round(value * sy)));
  return { x1: clampX(box.x1), y1: clampY(box.y1), x2: clampX(box.x2), y2: clampY(box.y2) };
}
