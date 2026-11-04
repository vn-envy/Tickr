import { MetaClientError } from "./config";

const MAX_WIRE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 16_777_216;
const MAX_TOTAL_MASK_PIXELS = 32_000_000;
const MAX_OBJECTS = 16;
const integer = /^-?\d+$/;
const unsigned = /^\d+$/;
const confidence = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export class SegmentationPreflightError extends MetaClientError {
  constructor() {
    super("SEGMENTATION_INVALID", "Segmentation geometry exceeds its bounds or contains unsupported fields.", { outcome: "unknown" });
    this.name = "SegmentationPreflightError";
  }
}

function invalid(): never { throw new SegmentationPreflightError(); }

function fields(body: string, allowed: ReadonlySet<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of body.split(";")) {
    const field = part.trim();
    if (!field) continue;
    const separator = field.indexOf("=");
    if (separator < 1) invalid();
    const key = field.slice(0, separator).trim();
    const value = field.slice(separator + 1).trim();
    if (!allowed.has(key) || result.has(key) || !value) invalid();
    result.set(key, value);
  }
  const score = result.get("c");
  if (score !== undefined && (!confidence.test(score) || !Number.isFinite(Number(score)) || Number(score) < 0 || Number(score) > 1)) invalid();
  return result;
}

const boxKeys = new Set(["x1", "y1", "x2", "y2", "w", "h", "c"]);
const maskKeys = new Set(["x", "y", "data", "c"]);

/**
 * Validate declared geometry before the official parser allocates decoded masks.
 * This accepts field/token ordering and confidence notation supported by Meta's
 * grammar, but rejects unsupported fields, duplicate identities and multi-frame data.
 */
export function preflightSegmentationWire(text: string, sourceWidth: number, sourceHeight: number): number {
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1
    || sourceWidth * sourceHeight > MAX_SOURCE_PIXELS || Buffer.byteLength(text) > MAX_WIRE_BYTES) invalid();
  const wire = text.trim();
  if (!wire) return 0;
  if (!wire.startsWith("<0f>")) invalid();
  const recordStart = /,?([0-9]+)(?=<\|)/y;
  const token = /<\|([A-Za-z][A-Za-z0-9_.-]*)(?:;([^|]*))?\|>/y;
  const seen = new Set<string>();
  let position = 4;
  let pixels = 0;
  while (position < wire.length) {
    recordStart.lastIndex = position;
    const start = recordStart.exec(wire);
    if (!start || start[1].length > 20 || seen.has(start[1]) || seen.size >= MAX_OBJECTS) invalid();
    seen.add(start[1]);
    position = recordStart.lastIndex;
    const tokens = new Map<string, Map<string, string>>();
    while (wire.startsWith("<|", position)) {
      token.lastIndex = position;
      const match = token.exec(wire);
      if (!match || (match[1] !== "box" && match[1] !== "mask") || tokens.has(match[1])) invalid();
      tokens.set(match[1], fields(match[2] ?? "", match[1] === "box" ? boxKeys : maskKeys));
      position = token.lastIndex;
    }
    const box = tokens.get("box"), mask = tokens.get("mask");
    if (!box || !mask || tokens.size !== 2) invalid();
    const values = ["x1", "y1", "x2", "y2", "w", "h"].map((key) => box.get(key));
    if (!values.every((value, index) => value !== undefined && (index < 4 ? integer : unsigned).test(value))) invalid();
    const [left, top, right, bottom, width, height] = values.map(Number);
    if (![left, top, right, bottom, width, height].every(Number.isSafeInteger)
      || width !== sourceWidth || height !== sourceHeight || left < 0 || top < 0
      || right < left || bottom < top || right >= width || bottom >= height
      || mask.get("x") !== "0" || mask.get("y") !== "0") invalid();
    const data = /^(\d+),(\d+),([!~][^|]+)$/.exec(mask.get("data") ?? "");
    if (!data) invalid();
    const maskHeight = Number(data[1]), maskWidth = Number(data[2]);
    if (!Number.isSafeInteger(maskWidth) || !Number.isSafeInteger(maskHeight)
      || maskWidth !== right - left + 1 || maskHeight !== bottom - top + 1) invalid();
    pixels += maskWidth * maskHeight;
    if (!Number.isSafeInteger(pixels) || pixels > MAX_TOTAL_MASK_PIXELS) invalid();
  }
  if (!seen.size) invalid();
  return seen.size;
}
