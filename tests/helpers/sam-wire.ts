/**
 * SYNTHETIC test helper: builds SAM 3.1 wire text with genuine one-bit mask payloads.
 * It uses the official parser's internal conformance encoder (not part of its public
 * exports) so fixtures round-trip through the real decoder. Never imported by application
 * code and never sent to Meta. Sanctioned consumers: vitest suites and the offline
 * `scripts/autopilot-live-check.ts --dry` path (fake clients only; the live path never loads it).
 */
// Internal conformance encoder (no public export path); test-only.
import { encodeSegmentationMask } from "../../node_modules/@meta-sam/parser/dist/mask-codec.js";

export interface SyntheticSamObject {
  id: number | string;
  /** Inclusive box in source pixels. */
  box: { x1: number; y1: number; x2: number; y2: number };
  /** Optional raster for the box region (0/1, row-major, (x2-x1+1)*(y2-y1+1)); defaults to an ellipse. */
  raster?: Uint8Array;
  confidence?: number;
}

/** A filled ellipse inscribed in a width×height box, as 0/1 bytes. */
export function ellipseRaster(width: number, height: number): Uint8Array {
  const raster = new Uint8Array(width * height);
  const cx = (width - 1) / 2, cy = (height - 1) / 2, rx = Math.max(.5, width / 2), ry = Math.max(.5, height / 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    raster[y * width + x] = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1 ? 1 : 0;
  }
  return raster;
}

export function samRecord(object: SyntheticSamObject, size: { width: number; height: number }): string {
  const { x1, y1, x2, y2 } = object.box;
  const width = x2 - x1 + 1, height = y2 - y1 + 1;
  const raster = object.raster ?? ellipseRaster(width, height);
  const mask = encodeSegmentationMask(raster, width, height) as { payload: string };
  const c = object.confidence === undefined ? "" : `;c=${object.confidence}`;
  // The conformance encoder's payload already starts with the one-bit `!` marker.
  return `${object.id}<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${size.width};h=${size.height}${c}|><|mask;x=0;y=0;data=${height},${width},${mask.payload}${c}|>`;
}

/** One image line: `<0f>` + comma-separated records. Empty objects → empty text (zero matches). */
export function samImageWire(objects: readonly SyntheticSamObject[], size: { width: number; height: number }): string {
  return objects.length ? `<0f>${objects.map((object) => samRecord(object, size)).join(",")}` : "";
}

/**
 * Video wire: one line per frame. Frames without objects are omitted by default; with
 * `bareEmptyFrames` they emit a bare `<Nf>` line, which the official parser 0.0.13 reports
 * as a malformed record — adapters must handle that shape explicitly (its live form is unverified).
 */
export function samVideoWire(frames: ReadonlyArray<{ frame: number; objects: readonly SyntheticSamObject[] }>, size: { width: number; height: number }, options: { bareEmptyFrames?: boolean } = {}): string {
  return frames.filter(({ objects }) => objects.length || options.bareEmptyFrames)
    .map(({ frame, objects }) => `<${frame}f>${objects.map((object) => samRecord(object, size)).join(",")}`).join("\n");
}

/** A completed Responses envelope as SAM returns it (stream:false). */
export function samResponse(text: string, usage: Record<string, number> = { images_processed: 1 }) {
  return { id: "resp_synthetic_test", status: "completed", model: "sam-3.1", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage };
}
