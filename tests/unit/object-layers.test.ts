import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { composeObjectLayer, composeObjectLayers, maskCentroid, subjectBoxesFromPrompts } from "../../lib/media/object-layers";
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
    // The raw binary contract (refinement off); refined alpha is covered below.
    const layer = await composeObjectLayer(bytes, result, 1, { refine: false });
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
      sha256s: { source: sha256(bytes), cutout: sha256(layer!.cutoutPng), mask: sha256(layer!.maskPng), samMask: sha256(result.objects[0].maskPng) }, refinement: null,
      provenance: { kind: "sam_object_layer", responseId: "resp_synthetic_test", promptKind: "geometry", sourceAssetId: "synthetic-owner-photo", sourceProvenance: "owner_photo", alphaRefinement: "none",
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

describe("refined SAM layers on real-photo-like masks", () => {
  // SYNTHETIC: a 240×180 photo with distinct RGB per pixel and a translucent corner, and a SAM
  // mask of a disk decoded from a 3-px native grid with stray specks, pin-holes and a second blob.
  const big = { width: 240, height: 180 }, CX = 120.4, CY = 92.6, R = 60;
  const photo = () => {
    const rgba = Buffer.alloc(big.width * big.height * 4);
    for (let y = 0; y < big.height; y++) for (let x = 0; x < big.width; x++) {
      const o = (y * big.width + x) * 4;
      rgba[o] = (13 * x + 5) % 256; rgba[o + 1] = (29 * y + 3) % 256; rgba[o + 2] = (7 * x + 17 * y) % 256; rgba[o + 3] = x > 150 && y > 120 ? 140 : 255;
    }
    return rgba;
  };
  const box = { x1: 40, y1: 20, x2: 219, y2: 169 };
  function noisyRaster(): Uint8Array {
    const width = box.x2 - box.x1 + 1, height = box.y2 - box.y1 + 1, raster = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sx = box.x1 + x, sy = box.y1 + y, cx = (Math.floor((sx + 0.5) / 3) + 0.5) * 3, cy = (Math.floor((sy + 0.5) / 3) + 0.5) * 3;
      if (Math.hypot(cx - CX, cy - CY) < R) raster[y * width + x] = 1;
    }
    // Stray specks, pin-holes and a separate 20×20 blob (a different object) in the bottom right.
    for (const [sx, sy] of [[45, 25], [46, 25], [210, 30], [50, 160], [51, 161]]) raster[(sy - box.y1) * width + sx - box.x1] = 1;
    for (const [sx, sy] of [[110, 90], [111, 90], [130, 100]]) raster[(sy - box.y1) * width + sx - box.x1] = 0;
    for (let sy = 140; sy < 160; sy++) for (let sx = 190; sx < 210; sx++) raster[(sy - box.y1) * width + sx - box.x1] = 1;
    return raster;
  }
  const bigGeometry: SamObjectPrompt[] = [{ objectId: 2, label: "Synthetic pastry", origin: "spark_grounding", prompts: [{ frame: 0, box: { x1: 60, y1: 30, x2: 180, y2: 150 } }] }];
  async function bigLayer(options: Parameters<typeof composeObjectLayer>[3] = {}) {
    const bytes = await sharp(photo(), { raw: { ...big, channels: 4 } }).png().toBuffer();
    const requestJson = vi.fn().mockResolvedValue(samResponse(samImageWire([{ id: 2, box, raster: noisyRaster(), confidence: .8 }], big)));
    const result = await segmentMetaImage({ bytes, mimeType: "image/png", geometry: bigGeometry, sourceAssetId: "synthetic-site-photo", sourceProvenance: "source_photo" }, { client: { requestJson } });
    return { bytes, result, layer: await composeObjectLayer(bytes, result, 2, options) };
  }
  const decode = async (png: Buffer, channels: 1 | 4) => (await (channels === 1 ? sharp(png).removeAlpha().greyscale() : sharp(png).ensureAlpha()).raw().toBuffer({ resolveWithObject: true })).data;
  /** 8-connected components of non-zero mask pixels. */
  function parts(mask: Buffer): number {
    const seen = new Uint8Array(mask.length); let count = 0;
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || seen[start]) continue;
      count++; const stack = [start]; seen[start] = 1;
      while (stack.length) {
        const i = stack.pop()!, x = i % big.width, y = (i - x) / big.width;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, j = ny * big.width + nx;
          if (nx >= 0 && ny >= 0 && nx < big.width && ny < big.height && mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    return count;
  }

  test("changes alpha only: source RGB is untouched everywhere and alpha never exceeds the source's", async () => {
    const { bytes, result, layer } = await bigLayer({ subjectBoxes: { "2": { left: 60, top: 30, right: 181, bottom: 151 } } });
    expect(layer).not.toBeNull();
    const source = photo(), cutout = await decode(layer!.cutoutPng, 4), mask = await decode(layer!.maskPng, 1);
    let partial = 0, halo = 0;
    for (let i = 0; i < big.width * big.height; i++) {
      expect(cutout[i * 4]).toBe(source[i * 4]); expect(cutout[i * 4 + 1]).toBe(source[i * 4 + 1]); expect(cutout[i * 4 + 2]).toBe(source[i * 4 + 2]);
      const a = cutout[i * 4 + 3], x = i % big.width, y = (i - x) / big.width, d = Math.hypot(x + 0.5 - CX, y + 0.5 - CY);
      expect(a).toBeLessThanOrEqual(source[i * 4 + 3]);
      if (d < R - 4) expect(a).toBe(source[i * 4 + 3]);
      if (a > 0 && a < source[i * 4 + 3]) partial++;
      if (a > 0 && d > R + layer!.refinement!.maxGrowthPx) halo++;
      expect(mask[i] === 0 || mask[i] === 255).toBe(true);
    }
    // Anti-aliased edge (partial alpha) and no background halo, specks or second blob.
    expect(partial).toBeGreaterThan(200);
    expect(halo).toBe(0);
    expect(parts(mask)).toBe(1);
    expect(mask[150 * big.width + 200]).toBe(0);
    for (const [x, y] of [[110, 90], [111, 90], [130, 100]]) expect(cutout[(y * big.width + x) * 4 + 3]).toBe(255);
    const selected = mask.reduce((sum, value) => sum + (value ? 1 : 0), 0);
    expect(Math.abs(selected - Math.PI * R * R) / (Math.PI * R * R)).toBeLessThan(0.03);
    expect(layer!.refinement).toMatchObject({ nativeFactor: { x: 3, y: 3 }, removedComponents: 4, removedPixels: 405 });
    expect(layer).toMatchObject({
      sha256s: { source: sha256(bytes), cutout: sha256(layer!.cutoutPng), mask: sha256(layer!.maskPng), samMask: sha256(result.objects[0].maskPng) },
      provenance: { alphaRefinement: "sam_mask_alpha_only_refinement", originalSubjectPixelsPreserved: true, generatedPixelsOnSubject: 0, semanticIdentityVerified: false, requiresReview: true },
    });
    // The SAM response's own mask is untouched and the output is deterministic.
    const again = await composeObjectLayer(bytes, result, 2, { subjectBoxes: { "2": { left: 60, top: 30, right: 181, bottom: 151 } } });
    expect(again!.sha256s).toEqual(layer!.sha256s);
  });

  test("subject boxes come from frame-0 geometry boxes as half-open bounds", () => {
    expect(subjectBoxesFromPrompts([...geometry, { objectId: 6, label: "Tapped", origin: "owner_tap", prompts: [{ frame: 0, points: [{ x: 3, y: 4, polarity: "positive" }] }] }]))
      .toEqual({ "1": { left: 1, top: 1, right: 15, bottom: 21 }, "4": { left: 20, top: 8, right: 36, bottom: 26 } });
  });

  test("without a subject box a sizeable second blob is kept; raw mode keeps every SAM pixel", async () => {
    const { layer } = await bigLayer();
    const mask = await decode(layer!.maskPng, 1);
    expect(parts(mask)).toBe(2);
    expect(mask[150 * big.width + 200]).toBe(255);
    const raw = (await bigLayer({ refine: false })).layer!;
    expect(parts(await decode(raw.maskPng, 1))).toBeGreaterThan(2);
    expect(raw.refinement).toBeNull();
  });

  test("each layer carries a deterministic shape-quality report: a smooth disk is clean, a mask that stops mid-object is not", async () => {
    const subjectBoxes = { "2": { left: 60, top: 30, right: 181, bottom: 151 } };
    const { layer } = await bigLayer({ subjectBoxes });
    expect(layer!.quality).toMatchObject({ clean: true, measured: true, failures: [], components: 1, largestComponentShare: 1 });
    expect(layer!.quality.solidity).toBeGreaterThan(0.95);
    // A torn selection: solid top of the subject box, then a ragged cut about half way down it.
    const width = box.x2 - box.x1 + 1, height = box.y2 - box.y1 + 1, torn = new Uint8Array(width * height);
    for (let x = 60; x <= 180; x++) {
      const cut = 85 + (Math.floor(x / 5) % 3 - 1) * 6;
      for (let y = 30; y < cut; y++) torn[(y - box.y1) * width + x - box.x1] = 1;
    }
    const bytes = await sharp(photo(), { raw: { ...big, channels: 4 } }).png().toBuffer();
    const requestJson = vi.fn().mockResolvedValue(samResponse(samImageWire([{ id: 2, box, raster: torn, confidence: .8 }], big)));
    const result = await segmentMetaImage({ bytes, mimeType: "image/png", geometry: bigGeometry, sourceAssetId: "synthetic-site-photo", sourceProvenance: "source_photo" }, { client: { requestJson } });
    const cut = await composeObjectLayer(bytes, result, 2, { subjectBoxes });
    expect(cut!.quality.clean).toBe(false);
    expect(cut!.quality.failures).toContain("cut_through");
    expect(cut!.quality.cutThrough).toMatchObject({ side: "bottom", strong: true });
    // Only the decision changes: the layer still selects real pixels and generates none.
    expect(cut!.provenance).toMatchObject({ originalSubjectPixelsPreserved: true, generatedPixelsOnSubject: 0 });
    expect((await composeObjectLayer(bytes, result, 2, { subjectBoxes }))!.quality).toEqual(cut!.quality);
  });
});
