import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { composeObjectLayer, composeObjectLayers, maskCentroid } from "../../lib/media/object-layers";
import type { SamObjectPrompt } from "../../lib/meta/sam-prompts";
import { segmentMetaImage, type MetaSegmentationResult } from "../../lib/meta/segmentation";
import { ellipseRaster, samImageWire, samResponse, type SyntheticSamObject } from "../helpers/sam-wire";

// SYNTHETIC fixtures only: generated rasters, invented labels, locally encoded SAM wire text.
const size = { width: 40, height: 30 };
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const network = vi.fn(async () => { throw new Error("Network requests are forbidden in offline layer tests."); });
beforeEach(() => { network.mockClear(); vi.stubGlobal("fetch", network); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

/** Distinct RGB per pixel; a translucent band and a fully transparent patch exercise alpha multiplication. */
function sourceRgba(): Buffer {
  const rgba = Buffer.alloc(size.width * size.height * 4);
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    const offset = (y * size.width + x) * 4;
    rgba[offset] = (17 * x + 3) % 256; rgba[offset + 1] = (41 * y + 7) % 256; rgba[offset + 2] = (11 * x + 23 * y) % 256;
    rgba[offset + 3] = x >= 2 && x <= 4 && y >= 2 && y <= 4 ? 0 : y >= 12 && y <= 14 ? 128 : 255;
  }
  return rgba;
}
const sourcePng = () => sharp(sourceRgba(), { raw: { ...size, channels: 4 } }).png().toBuffer();

const geometry: SamObjectPrompt[] = [
  { objectId: 1, label: "Synthetic cup", origin: "owner_tap", prompts: [{ frame: 0, box: { x1: 1, y1: 1, x2: 14, y2: 20 }, points: [{ x: 3, y: 3, polarity: "negative" }] }] },
  { objectId: 4, label: "Synthetic plate", origin: "spark_grounding", prompts: [{ frame: 0, box: { x1: 20, y1: 8, x2: 35, y2: 25 } }] },
];
const rectangle = (width: number, height: number) => new Uint8Array(width * height).fill(1);
const objects: SyntheticSamObject[] = [
  // A filled 14x20 rectangle: covers the transparent patch and part of the translucent band.
  { id: 1, box: { x1: 1, y1: 1, x2: 14, y2: 20 }, raster: rectangle(14, 20), confidence: .9 },
  { id: 4, box: { x1: 20, y1: 8, x2: 35, y2: 25 }, raster: ellipseRaster(16, 18), confidence: .75 },
];

async function segmented(bytes: Buffer, returned: SyntheticSamObject[] = objects): Promise<MetaSegmentationResult> {
  const requestJson = vi.fn().mockResolvedValue(samResponse(samImageWire(returned, size)));
  const result = await segmentMetaImage({ bytes, mimeType: "image/png", geometry, sourceAssetId: "synthetic-owner-photo", sourceProvenance: "owner_photo" }, { client: { requestJson } });
  expect(requestJson).toHaveBeenCalledTimes(1);
  return result;
}
async function raw(png: Buffer, channels: 1 | 4) {
  const image = sharp(png);
  const decoded = await (channels === 1 ? image.removeAlpha().greyscale() : image.ensureAlpha()).raw().toBuffer({ resolveWithObject: true });
  expect(decoded.info).toMatchObject({ width: size.width, height: size.height, channels });
  return decoded.data;
}

describe("per-object SAM layers", () => {
  test("keeps exact source RGB, multiplies original alpha inside the mask and clears it outside", async () => {
    const bytes = await sourcePng();
    const result = await segmented(bytes);
    const layer = await composeObjectLayer(bytes, result, 1);
    expect(layer).not.toBeNull();
    const source = sourceRgba();
    const cutout = await raw(layer!.cutoutPng, 4), mask = await raw(layer!.maskPng, 1);
    let inside = 0, selected = 0;
    for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
      const index = y * size.width + x, offset = index * 4;
      const selectedHere = x >= 1 && x <= 14 && y >= 1 && y <= 20;
      expect(mask[index]).toBe(selectedHere ? 255 : 0);
      expect([...cutout.subarray(offset, offset + 3)]).toEqual([...source.subarray(offset, offset + 3)]);
      expect(cutout[offset + 3]).toBe(selectedHere ? source[offset + 3] : 0);
      if (selectedHere) { inside++; if (source[offset + 3]) selected++; }
    }
    expect(inside).toBe(14 * 20);
    expect(selected).toBe(14 * 20 - 9);
    expect(layer).toMatchObject({
      objectId: "1", promptObjectId: 1, label: "Synthetic cup", regionOrigin: "owner_tap", confidence: .9, width: 40, height: 30,
      bounds: { left: 1, top: 1, right: 15, bottom: 21 }, selectedPixels: selected, coverage: selected / (40 * 30), centroid: { x: 8, y: 11 },
      sha256s: { source: sha256(bytes), cutout: sha256(layer!.cutoutPng), mask: sha256(layer!.maskPng) },
      provenance: { kind: "sam_object_layer", responseId: "resp_synthetic_test", promptKind: "geometry", sourceAssetId: "synthetic-owner-photo", sourceProvenance: "owner_photo",
        originalSubjectPixelsPreserved: true, generatedPixelsOnSubject: 0, semanticIdentityVerified: false, requiresReview: true },
    });
  });

  test("composes every usable object in result order with tight half-open bounds", async () => {
    const bytes = await sourcePng();
    const result = await segmented(bytes);
    const layers = await composeObjectLayers(bytes, result);
    expect(layers.map(({ objectId, label, regionOrigin }) => ({ objectId, label, regionOrigin }))).toEqual([
      { objectId: "1", label: "Synthetic cup", regionOrigin: "owner_tap" },
      { objectId: "4", label: "Synthetic plate", regionOrigin: "spark_grounding" },
    ]);
    const plate = layers[1];
    const mask = await raw(plate.maskPng, 1);
    const ellipse = ellipseRaster(16, 18);
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = 0; y < 18; y++) for (let x = 0; x < 16; x++) if (ellipse[y * 16 + x]) {
      minX = Math.min(minX, x + 20); minY = Math.min(minY, y + 8); maxX = Math.max(maxX, x + 20); maxY = Math.max(maxY, y + 8);
    }
    expect(plate.bounds).toEqual({ left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 });
    expect(mask.reduce((count, value) => count + (value ? 1 : 0), 0)).toBe(ellipse.reduce((count, value) => count + value, 0));
    expect(await composeObjectLayer(bytes, result, "4")).toEqual(plate);
  });

  test("returns null for absent, low-confidence or out-of-range selections", async () => {
    const bytes = await sourcePng();
    const result = await segmented(bytes, [{ ...objects[0], confidence: .4 }, objects[1]]);
    expect(await composeObjectLayer(bytes, result, 7)).toBeNull();
    expect(await composeObjectLayer(bytes, result, 1)).toBeNull();
    expect(await composeObjectLayer(bytes, result, 1, { minConfidence: .3 })).not.toBeNull();
    expect(await composeObjectLayer(bytes, result, 4, { minCoverage: .5 })).toBeNull();
    expect(await composeObjectLayer(bytes, result, 4, { maxCoverage: .01 })).toBeNull();
    expect((await composeObjectLayers(bytes, result)).map((layer) => layer.objectId)).toEqual(["4"]);
    // A mask that only selects fully transparent source pixels has nothing visible to layer.
    const hidden = await segmented(bytes, [{ id: 1, box: { x1: 2, y1: 2, x2: 4, y2: 4 }, raster: rectangle(3, 3) }]);
    expect(hidden.objects).toHaveLength(1);
    expect(await composeObjectLayer(bytes, hidden, 1)).toBeNull();
    await expect(composeObjectLayer(bytes, result, 1, { minCoverage: .5, maxCoverage: .2 })).rejects.toThrow("Object layer thresholds must be fractions from 0 to 1.");
  });

  test("refuses results that are not bound to these exact source bytes and dimensions", async () => {
    const bytes = await sourcePng();
    const result = await segmented(bytes);
    const changed = sourceRgba(); changed[0] ^= 1;
    const other = await sharp(changed, { raw: { ...size, channels: 4 } }).png().toBuffer();
    await expect(composeObjectLayer(other, result, 1)).rejects.toThrow("SAM mask does not belong to this source image.");
    await expect(composeObjectLayers(other, result)).rejects.toThrow("SAM mask does not belong to this source image.");
    await expect(composeObjectLayer(bytes, { ...result, width: 41 }, 1)).rejects.toThrow("SAM dimensions differ from the unchanged source raster.");
    const [cup, plate] = result.objects;
    await expect(composeObjectLayer(bytes, { ...result, objects: [{ ...cup, bounds: { ...cup.bounds, right: 41 } }] }, 1)).rejects.toThrow("SAM returned invalid object bounds.");
    await expect(composeObjectLayer(bytes, { ...result, objects: [{ ...cup, maskPng: plate.maskPng }] }, 1)).rejects.toThrow("SAM mask dimensions differ from its bounds.");
    const grey = await sharp(Buffer.alloc(14 * 20, 128), { raw: { width: 14, height: 20, channels: 1 } }).png().toBuffer();
    await expect(composeObjectLayer(bytes, { ...result, objects: [{ ...cup, maskPng: grey }] }, 1)).rejects.toThrow("SAM mask is not binary.");
    await expect(composeObjectLayers(bytes, { ...result, objects: [cup, cup] })).rejects.toThrow("SAM object identities are duplicated or exceed the object limit.");
  });

  test("computes pixel-centre mask centroids", () => {
    expect(maskCentroid(new Uint8Array([1]), 1, 1)).toEqual({ x: .5, y: .5 });
    expect(maskCentroid(new Uint8Array([0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 0]), 4, 3)).toEqual({ x: 3, y: 1 });
    expect(maskCentroid(new Uint8Array(6), 3, 2)).toBeNull();
    expect(() => maskCentroid(new Uint8Array(5), 3, 2)).toThrow("Mask dimensions do not match its raster.");
    expect(() => maskCentroid(new Uint8Array(0), 0, 0)).toThrow("Mask dimensions do not match its raster.");
  });
});
