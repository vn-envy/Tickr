import { createHash } from "node:crypto";
import sharp from "sharp";
import type { SamObjectPrompt } from "../meta/sam-prompts";
import type { MetaSegmentationPromptKind, MetaSegmentationRegionOrigin, MetaSegmentationResult, MetaSegmentedObject } from "../meta/segmentation";
import { maskSigmaFor, refineMaskAlpha, type MaskRefinementReport } from "../campaign/cinema/mask-refine";
import type { PixelBounds } from "./cinema-types";

/**
 * Per-object SAM layers at full source size. A layer only SELECTS real pixels: decoded source
 * RGB is copied unchanged and its original alpha is multiplied by the SAM selection. By default
 * the selection is the SAM mask after a deterministic alpha-only refinement (mask-refine.ts:
 * specks and outside-box fragments dropped, pin-holes filled, coarse-grid stair steps re-decoded
 * smoothly, close/open, no growth past a small margin, anti-aliased edge), so real-photo cutouts
 * have clean edges; the SAM response's own mask is never modified. Nothing here verifies product
 * identity; the region origin and label are local provenance only.
 */
const MAX_SOURCE_PIXELS = 16_777_216;
const MAX_MASK_PNG_BYTES = 16 * 1024 * 1024;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface ObjectLayerOptions {
  /** Objects with a reported confidence below this are unusable. Null confidence is accepted. Default 0.5. */
  minConfidence?: number;
  /** Minimum visible selected fraction of the frame (exclusive of zero). Default 0. */
  minCoverage?: number;
  /** Maximum visible selected fraction of the frame. Default 1. */
  maxCoverage?: number;
  /** Alpha-only refinement of the SAM mask (default true). False keeps the raw binary selection. */
  refine?: boolean;
  /**
   * Subject boxes in source pixels (half-open), keyed by SAM object id — e.g. the Spark box a
   * geometry prompt was built from. Refinement keeps only mask components overlapping the box.
   */
  subjectBoxes?: Readonly<Record<string, PixelBounds>>;
}

export interface ObjectLayer {
  /** SAM's object id as returned (geometry ids equal the prompted id). */
  objectId: string;
  promptObjectId: number | null;
  label: string | null;
  regionOrigin: MetaSegmentationRegionOrigin;
  confidence: number | null;
  width: number;
  height: number;
  /** Tight half-open bounds of the selection (refined alpha ≥ 128, else the SAM mask) in source pixels. */
  bounds: PixelBounds;
  /** Selected pixels whose source alpha is non-zero, divided by the frame area. */
  coverage: number;
  selectedPixels: number;
  /** Mean foreground position in pixel-centre coordinates. */
  centroid: { x: number; y: number };
  /** Full-size RGBA PNG: unchanged source RGB, alpha = original alpha × refined (or binary) SAM alpha. */
  cutoutPng: Buffer;
  /** Full-size greyscale PNG of the selection: 255 selected, 0 elsewhere. */
  maskPng: Buffer;
  /** `samMask` is the SAM response's own cropped mask PNG, which stays the provenance record. */
  sha256s: { source: string; cutout: string; mask: string; samMask: string };
  /** What the alpha-only refinement changed; null when refinement was disabled. */
  refinement: MaskRefinementReport | null;
  provenance: {
    kind: "sam_object_layer";
    responseId: string;
    promptKind: MetaSegmentationPromptKind;
    sourceAssetId: string;
    sourceProvenance: MetaSegmentationResult["provenance"]["sourceProvenance"];
    /** How the SAM mask became the cutout alpha; RGB is never touched either way. */
    alphaRefinement: "sam_mask_alpha_only_refinement" | "none";
    originalSubjectPixelsPreserved: true;
    generatedPixelsOnSubject: 0;
    semanticIdentityVerified: false;
    requiresReview: true;
  };
}

/**
 * Half-open subject boxes keyed by SAM object id from geometry prompts (frame-0 boxes, inclusive
 * source pixels), for ObjectLayerOptions.subjectBoxes. Objects prompted without a box are omitted.
 */
export function subjectBoxesFromPrompts(geometry: readonly SamObjectPrompt[]): Record<string, PixelBounds> {
  const boxes: Record<string, PixelBounds> = {};
  for (const object of geometry) {
    const box = object.prompts.find((prompt) => prompt.frame === 0 && prompt.box)?.box;
    if (box) boxes[String(object.objectId)] = { left: box.x1, top: box.y1, right: box.x2 + 1, bottom: box.y2 + 1 };
  }
  return boxes;
}

interface DecodedSource { rgba: Buffer; width: number; height: number; sha256: string }

/**
 * Centroid of the non-zero pixels of a row-major single-channel mask, in pixel-centre
 * coordinates (a lone pixel at (0,0) has centroid (0.5,0.5)). Null when the mask is empty.
 */
export function maskCentroid(mask: Uint8Array, width: number, height: number): { x: number; y: number } | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || mask.length !== width * height) {
    throw new Error("Mask dimensions do not match its raster.");
  }
  let count = 0, sumX = 0, sumY = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (mask[y * width + x]) { count++; sumX += x; sumY += y; }
  }
  return count ? { x: sumX / count + .5, y: sumY / count + .5 } : null;
}

async function decodeSource(sourceBytes: Uint8Array, result: MetaSegmentationResult): Promise<DecodedSource> {
  const bytes = Buffer.from(sourceBytes);
  const digest = sha256(bytes);
  if (digest !== result.sourceSha256) throw new Error("SAM mask does not belong to this source image.");
  const source = await sharp(bytes, { limitInputPixels: MAX_SOURCE_PIXELS }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (source.info.width !== result.width || source.info.height !== result.height || source.info.channels !== 4) throw new Error("SAM dimensions differ from the unchanged source raster.");
  return { rgba: source.data, width: source.info.width, height: source.info.height, sha256: digest };
}

function checkOptions(options: ObjectLayerOptions) {
  const minConfidence = options.minConfidence ?? .5, minCoverage = options.minCoverage ?? 0, maxCoverage = options.maxCoverage ?? 1;
  if (![minConfidence, minCoverage, maxCoverage].every((value) => Number.isFinite(value) && value >= 0 && value <= 1) || minCoverage > maxCoverage) {
    throw new Error("Object layer thresholds must be fractions from 0 to 1.");
  }
  return { minConfidence, minCoverage, maxCoverage };
}

async function composeDecoded(source: DecodedSource, result: MetaSegmentationResult, object: MetaSegmentedObject, options: ObjectLayerOptions): Promise<ObjectLayer | null> {
  const { minConfidence, minCoverage, maxCoverage } = checkOptions(options);
  if (object.foregroundPixels <= 0 || object.confidence !== null && !(object.confidence >= minConfidence)) return null;
  const { left, top, right, bottom } = object.bounds;
  if (![left, top, right, bottom].every(Number.isSafeInteger) || left < 0 || top < 0 || right > source.width || bottom > source.height || right <= left || bottom <= top) {
    throw new Error("SAM returned invalid object bounds.");
  }
  if (object.maskPng.length > MAX_MASK_PNG_BYTES) throw new Error("SAM mask exceeds its byte limit.");
  const decoded = await sharp(object.maskPng, { limitInputPixels: MAX_SOURCE_PIXELS }).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== right - left || decoded.info.height !== bottom - top || decoded.info.channels !== 1) throw new Error("SAM mask dimensions differ from its bounds.");
  const sam = new Uint8Array(source.width * source.height);
  for (let y = 0; y < decoded.info.height; y++) for (let x = 0; x < decoded.info.width; x++) {
    const value = decoded.data[y * decoded.info.width + x];
    if (value !== 0 && value !== 255) throw new Error("SAM mask is not binary.");
    if (value) sam[(top + y) * source.width + left + x] = 1;
  }
  // Compositing alpha (0–255): the refined SAM mask, or the binary mask when refinement is off.
  let alpha: Uint8Array, refinement: MaskRefinementReport | null = null;
  if (options.refine === false) {
    alpha = sam.map((value) => value * 255);
  } else {
    const keepBox = options.subjectBoxes?.[object.id];
    const refined = refineMaskAlpha(sam, source.width, source.height, { sigma: maskSigmaFor(source.width, source.height), ...(keepBox ? { keepBox } : {}) });
    alpha = refined.alpha; refinement = refined.report;
  }
  const mask = Buffer.alloc(source.width * source.height);
  const cutout = Buffer.from(source.rgba);
  let minX = source.width, minY = source.height, maxX = -1, maxY = -1, selected = 0;
  // Only alpha changes: RGB bytes are copied from the decoded source everywhere.
  for (let index = 0; index < mask.length; index++) {
    const a = alpha[index], sourceAlpha = source.rgba[index * 4 + 3];
    cutout[index * 4 + 3] = a === 255 ? sourceAlpha : Math.round(sourceAlpha * a / 255);
    if (a < 128) continue;
    mask[index] = 255;
    if (sourceAlpha) selected++;
    const sx = index % source.width, sy = (index - sx) / source.width;
    if (sx < minX) minX = sx; if (sx > maxX) maxX = sx; if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
  }
  const coverage = selected / mask.length;
  if (!selected || coverage < minCoverage || coverage > maxCoverage) return null;
  const centroid = maskCentroid(mask, source.width, source.height);
  if (!centroid) return null;
  const [cutoutPng, maskPng] = await Promise.all([
    sharp(cutout, { raw: { width: source.width, height: source.height, channels: 4 } }).png().toBuffer(),
    sharp(mask, { raw: { width: source.width, height: source.height, channels: 1 } }).toColourspace("b-w").png().toBuffer(),
  ]);
  return {
    objectId: object.id, promptObjectId: object.promptObjectId ?? null, label: object.label ?? null, regionOrigin: object.regionOrigin ?? "concept_prompt", confidence: object.confidence,
    width: source.width, height: source.height, bounds: { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 }, coverage, selectedPixels: selected, centroid,
    cutoutPng, maskPng, sha256s: { source: source.sha256, cutout: sha256(cutoutPng), mask: sha256(maskPng), samMask: sha256(object.maskPng) }, refinement,
    provenance: { kind: "sam_object_layer", responseId: result.responseId, promptKind: result.promptKind ?? result.provenance.promptKind ?? "concept", sourceAssetId: result.provenance.sourceAssetId,
      sourceProvenance: result.provenance.sourceProvenance, alphaRefinement: refinement ? "sam_mask_alpha_only_refinement" : "none", originalSubjectPixelsPreserved: true, generatedPixelsOnSubject: 0, semanticIdentityVerified: false, requiresReview: true },
  };
}

/**
 * One object's full-size layer. Throws when the result does not belong to these exact source
 * bytes or carries malformed masks; returns null when the object is absent or unusable.
 * `objectId` matches the returned SAM id (geometry ids equal their prompted number).
 */
export async function composeObjectLayer(sourceBytes: Uint8Array, result: MetaSegmentationResult, objectId: string | number, options: ObjectLayerOptions = {}): Promise<ObjectLayer | null> {
  checkOptions(options);
  const source = await decodeSource(sourceBytes, result);
  const object = result.objects.find((candidate) => candidate.id === String(objectId));
  return object ? composeDecoded(source, result, object, options) : null;
}

/** Layers for every usable object, in result order; the source is decoded and verified once. */
export async function composeObjectLayers(sourceBytes: Uint8Array, result: MetaSegmentationResult, options: ObjectLayerOptions = {}): Promise<ObjectLayer[]> {
  checkOptions(options);
  if (result.objects.length > 16 || new Set(result.objects.map((object) => object.id)).size !== result.objects.length) throw new Error("SAM object identities are duplicated or exceed the object limit.");
  const source = await decodeSource(sourceBytes, result);
  const layers: ObjectLayer[] = [];
  for (const object of result.objects) {
    const layer = await composeDecoded(source, result, object, options);
    if (layer) layers.push(layer);
  }
  return layers;
}
