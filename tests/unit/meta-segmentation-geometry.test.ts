import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SamObjectPrompt } from "../../lib/meta/sam-prompts";
import { decodeMetaSegmentationResponse, getMetaSegmentationDiagnostic, recoverMetaSegmentationResponse, segmentMetaImage, type MetaSegmentationRequest } from "../../lib/meta/segmentation";
import { markSegmentationRequested, storeSegmentationResponse } from "../../lib/meta/segmentation-response";
import { samImageWire, samResponse } from "../helpers/sam-wire";

// SYNTHETIC fixtures only: generated rasters, invented labels, locally encoded SAM wire text.
const size = { width: 64, height: 48 };
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const directories: string[] = [];
const network = vi.fn(async () => { throw new Error("Network requests are forbidden in offline SAM tests."); });
beforeEach(() => { network.mockClear(); vi.stubGlobal("fetch", network); });
afterEach(async () => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() { const path = await mkdtemp(join(tmpdir(), "tickr-sam-geometry-")); directories.push(path); return path; }

async function sourceBytes(): Promise<Buffer> {
  const rgba = Buffer.alloc(size.width * size.height * 4);
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    const offset = (y * size.width + x) * 4;
    rgba[offset] = (13 * x) % 256; rgba[offset + 1] = (29 * y) % 256; rgba[offset + 2] = (7 * x + 5 * y) % 256; rgba[offset + 3] = 255;
  }
  return sharp(rgba, { raw: { width: size.width, height: size.height, channels: 4 } }).png().toBuffer();
}

const geometry: SamObjectPrompt[] = [
  { objectId: 0, label: "Synthetic cup", origin: "owner_tap", prompts: [{ frame: 0, box: { x1: 4, y1: 6, x2: 23, y2: 29 }, points: [{ x: 12, y: 15, polarity: "positive" }, { x: 5, y: 7, polarity: "negative" }] }] },
  { objectId: 3, label: "Synthetic plate", origin: "spark_grounding", prompts: [{ frame: 0, points: [{ x: 40, y: 30, polarity: "positive" }] }] },
  { objectId: 5, label: "Synthetic sign", origin: "local_layout", prompts: [{ frame: 0, box: { x1: 50, y1: 2, x2: 62, y2: 12 } }] },
];
const expectedWire = "<0f>0<|box;x1=4;y1=6;x2=23;y2=29;w=64;h=48|><|point;x=12;y=15;w=64;h=48|>-<|point;x=5;y=7;w=64;h=48|>"
  + ",3<|point;x=40;y=30;w=64;h=48|>,5<|box;x1=50;y1=2;x2=62;y2=12;w=64;h=48|>";

async function geometryRequest(objects: readonly SamObjectPrompt[] = geometry): Promise<MetaSegmentationRequest> {
  return { bytes: await sourceBytes(), mimeType: "image/png", geometry: objects, sourceAssetId: "synthetic-owner-photo", sourceProvenance: "owner_photo" };
}
const returned = (objects: Parameters<typeof samImageWire>[0]) => samResponse(samImageWire(objects, size), { input_tokens: 9, output_tokens: 21, total_tokens: 30, images_processed: 1 });
const cupAndPlate = () => returned([{ id: 0, box: { x1: 4, y1: 6, x2: 23, y2: 29 }, confidence: .875 }, { id: 3, box: { x1: 30, y1: 22, x2: 50, y2: 40 } }]);

describe("SAM 3.1 image geometry prompts", () => {
  test("sends the exact geometry text, inline bytes and string metadata, never the local labels", async () => {
    const input = await geometryRequest();
    const requestJson = vi.fn().mockResolvedValue(cupAndPlate());
    const result = await segmentMetaImage(input, { client: { requestJson } });
    expect(requestJson).toHaveBeenCalledTimes(1);
    const [path, options] = requestJson.mock.calls[0];
    expect(path).toBe("/responses");
    expect(options).toEqual({ method: "POST", modelRole: "segmentation", body: {
      model: "sam-3.1",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: expectedWire }, { type: "input_image", image_url: `data:image/png;base64,${Buffer.from(input.bytes).toString("base64")}` }] }],
      stream: false, store: false, metadata: { mask_encoding: "one_bit", include_confidence: "true" },
    } });
    expect(JSON.stringify(options)).not.toMatch(/Synthetic|owner_tap|spark_grounding|local_layout/);
    expect(result).toMatchObject({ status: "segmented", promptKind: "geometry", unmatchedPromptIds: [5], width: 64, height: 48, usage: { inputTokens: 9, outputTokens: 21, imagesProcessed: 1 } });
    expect(result.objects.map(({ id, promptObjectId, label, regionOrigin, confidence }) => ({ id, promptObjectId, label, regionOrigin, confidence }))).toEqual([
      { id: "0", promptObjectId: 0, label: "Synthetic cup", regionOrigin: "owner_tap", confidence: .875 },
      { id: "3", promptObjectId: 3, label: "Synthetic plate", regionOrigin: "spark_grounding", confidence: null },
    ]);
    expect(result.objects[0].bounds).toEqual({ left: 4, top: 6, right: 24, bottom: 30 });
    expect(result.provenance).toMatchObject({ promptKind: "geometry", promptSha256: sha256(expectedWire), semanticIdentityVerified: false, requiresReview: true, sourceProvenance: "owner_photo" });
  });

  test("keeps concept requests on their unchanged version-1 binding so old checkpoints recover offline", async () => {
    const responseDirectory = await directory();
    const concept: MetaSegmentationRequest = { bytes: await sourceBytes(), mimeType: "image/png", prompt: "  coffee cup ", sourceAssetId: "synthetic-legacy-source", sourceProvenance: "source_photo" };
    // The exact JSON the adapter hashed before geometry prompts existed.
    const legacyHash = sha256(JSON.stringify({ version: 1, model: "sam-3.1", sourceSha256: sha256(Buffer.from(concept.bytes)), mimeType: "image/png", prompt: "coffee cup",
      sourceAssetId: "synthetic-legacy-source", sourceProvenance: "source_photo", maskEncoding: "one_bit", includeConfidence: true }));
    await markSegmentationRequested(responseDirectory, legacyHash);
    await storeSegmentationResponse(responseDirectory, { version: 1, inputHash: legacyHash, receivedAt: new Date(0).toISOString(), elapsedMs: 17, response: returned([{ id: 0, box: { x1: 2, y1: 3, x2: 20, y2: 25 } }, { id: 1, box: { x1: 30, y1: 10, x2: 40, y2: 20 }, confidence: .5 }]) });
    const requestJson = vi.fn();
    const recovered = await segmentMetaImage(concept, { responseDirectory, client: { requestJson } });
    expect(requestJson).not.toHaveBeenCalled();
    expect(recovered).toMatchObject({ status: "segmented", promptKind: "concept", unmatchedPromptIds: [], elapsedMs: 17, provenance: { promptKind: "concept", promptSha256: sha256("coffee cup") } });
    expect(recovered.objects.map(({ id, promptObjectId, label, regionOrigin }) => ({ id, promptObjectId, label, regionOrigin }))).toEqual([
      { id: "0", promptObjectId: null, label: null, regionOrigin: "concept_prompt" },
      { id: "1", promptObjectId: null, label: null, regionOrigin: "concept_prompt" },
    ]);
    expect(await recoverMetaSegmentationResponse(concept, responseDirectory)).toEqual(recovered);
    // A geometry request is a different paid input and never reuses the concept checkpoint.
    await expect(segmentMetaImage({ ...concept, prompt: undefined, geometry }, { responseDirectory, client: { requestJson } })).rejects.toMatchObject({ code: "SEGMENTATION_CHECKPOINT_INVALID" });
    expect(requestJson).not.toHaveBeenCalled();
  });

  test("recovers a stored geometry response without repeating the paid call and binds labels and origins", async () => {
    const responseDirectory = await directory();
    const input = await geometryRequest();
    const requestJson = vi.fn().mockResolvedValue(cupAndPlate());
    const first = await segmentMetaImage(input, { responseDirectory, client: { requestJson } });
    expect(await segmentMetaImage(input, { responseDirectory, client: { requestJson } })).toEqual(first);
    expect(await recoverMetaSegmentationResponse(input, responseDirectory)).toEqual(first);
    expect(requestJson).toHaveBeenCalledTimes(1);
    const relabelled = geometry.map((object) => object.objectId === 3 ? { ...object, label: "Synthetic saucer" } : object);
    const reorigined = geometry.map((object) => object.objectId === 0 ? { ...object, origin: "local_layout" as const } : object);
    const moved = geometry.map((object) => object.objectId === 5 ? { ...object, prompts: [{ frame: 0, box: { x1: 49, y1: 2, x2: 62, y2: 12 } }] } : object);
    for (const objects of [relabelled, reorigined, moved]) {
      await expect(segmentMetaImage({ ...input, geometry: objects }, { responseDirectory, client: { requestJson } })).rejects.toMatchObject({ code: "SEGMENTATION_CHECKPOINT_INVALID" });
    }
    await expect(segmentMetaImage({ ...input, geometry: undefined, prompt: "cup" }, { responseDirectory, client: { requestJson } })).rejects.toMatchObject({ code: "SEGMENTATION_CHECKPOINT_INVALID" });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  test("fails closed on returned ids that were never prompted, keeping the paid response", async () => {
    const input = await geometryRequest();
    for (const id of [7, "03", 15]) {
      await expect(decodeMetaSegmentationResponse(returned([{ id: 0, box: { x1: 4, y1: 6, x2: 23, y2: 29 } }, { id, box: { x1: 30, y1: 22, x2: 50, y2: 40 } }]), input))
        .rejects.toMatchObject({ code: "SEGMENTATION_INVALID", outcome: "unknown", message: "Segmentation returned an object that was not prompted." });
    }
    const responseDirectory = await directory();
    const requestJson = vi.fn().mockResolvedValue(returned([{ id: 9, box: { x1: 4, y1: 6, x2: 23, y2: 29 } }]));
    const failure = await segmentMetaImage(input, { responseDirectory, client: { requestJson } }).catch((error: unknown) => error);
    expect(getMetaSegmentationDiagnostic(failure)).toMatchObject({ phase: "decode", code: "SEGMENTATION_INVALID", completedResponseStored: true, responseId: "resp_synthetic_test" });
    await expect(segmentMetaImage(input, { responseDirectory, client: { requestJson } })).rejects.toMatchObject({ code: "SEGMENTATION_INVALID" });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  test("reports prompted ids without a usable mask, including empty masks and zero matches", async () => {
    const input = await geometryRequest();
    const empty = new Uint8Array(11 * 11);
    const partial = await decodeMetaSegmentationResponse(returned([{ id: 5, box: { x1: 50, y1: 2, x2: 60, y2: 12 }, raster: empty }, { id: 3, box: { x1: 30, y1: 22, x2: 50, y2: 40 } }]), input);
    expect(partial).toMatchObject({ status: "segmented", promptKind: "geometry", unmatchedPromptIds: [0, 5] });
    expect(partial.objects.map((object) => object.promptObjectId)).toEqual([3]);
    const none = await decodeMetaSegmentationResponse(samResponse(""), input);
    expect(none).toMatchObject({ status: "no_match", objects: [], promptKind: "geometry", unmatchedPromptIds: [0, 3, 5] });
  });

  test("rejects invalid or ambiguous geometry before any marker or model call", async () => {
    const input = await geometryRequest();
    const responseDirectory = await directory();
    const requestJson = vi.fn();
    const cup = geometry[0];
    const invalid: MetaSegmentationRequest[] = [
      { ...input, prompt: "cup" },
      { ...input, geometry: undefined },
      { ...input, geometry: [] },
      { ...input, geometry: [{ ...cup, prompts: [{ frame: 0, box: { x1: 4, y1: 6, x2: 64, y2: 29 } }] }] },
      { ...input, geometry: [{ ...cup, prompts: [{ frame: 1, box: { x1: 4, y1: 6, x2: 23, y2: 29 } }] }] },
      { ...input, geometry: [{ ...cup, prompts: [{ frame: 0, points: [{ x: 5, y: 7, polarity: "negative" }] }] }] },
      { ...input, geometry: [{ ...cup, objectId: 16 }] },
      { ...input, geometry: [cup, { ...geometry[1], objectId: 0 }] },
      { ...input, geometry: [{ ...cup, label: "  " }] },
      { ...input, geometry: [{ ...cup, label: "Synthetic\ncup" }] },
      { ...input, geometry: [{ ...cup, origin: "concept_prompt" as never }] },
      { ...input, geometry: Array.from({ length: 17 }, (_, objectId) => ({ ...cup, objectId })) },
    ];
    for (const request of invalid) {
      const failure = await segmentMetaImage(request, { responseDirectory, client: { requestJson } }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "SEGMENTATION_INVALID", outcome: "not_applicable" });
      expect(getMetaSegmentationDiagnostic(failure)).toMatchObject({ phase: "input", code: "SEGMENTATION_INVALID" });
    }
    expect(requestJson).not.toHaveBeenCalled();
    expect(await readdir(responseDirectory)).toEqual([]);
  });
});
