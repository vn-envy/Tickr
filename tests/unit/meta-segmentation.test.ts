import sharp from "sharp";
import { describe, expect, test, vi } from "vitest";
import { decodeMetaSegmentationResponse, segmentMetaImage, type MetaSegmentationRequest } from "../../lib/meta/segmentation";
import { MetaClientError } from "../../lib/meta/config";

// Complete public documentation example, not a claimed business mask or live result.
const wire = "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";
const response = (text = wire) => ({ id: "sam-fixture", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46, images_processed: 1 } });
async function source(): Promise<MetaSegmentationRequest> {
  const data = Buffer.alloc(320 * 334 * 4);
  for (let y = 0; y < 334; y++) for (let x = 0; x < 320; x++) {
    const offset = (y * 320 + x) * 4;
    data[offset] = x % 256; data[offset + 1] = y % 256; data[offset + 2] = 71; data[offset + 3] = x % 2 ? 128 : 255;
  }
  return { bytes: await sharp(data, { raw: { width: 320, height: 334, channels: 4 } }).png().toBuffer(), mimeType: "image/png", prompt: "button", sourceAssetId: "fixture-source", sourceProvenance: "meta_illustration" };
}

describe("bounded Meta SAM 3.1 adapter", () => {
  test("uses one fixed Meta Responses request with inline bytes and explicit mask settings", async () => {
    const requestJson = vi.fn().mockResolvedValue(response());
    const result = await segmentMetaImage(await source(), { client: { requestJson } });
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson.mock.calls[0]).toMatchObject(["/responses", { method: "POST", modelRole: "segmentation", body: { model: "sam-3.1", stream: false, store: false, metadata: { mask_encoding: "one_bit", include_confidence: "true" } } }]);
    expect(requestJson.mock.calls[0][1].body.input[0].content[1].image_url).toMatch(/^data:image\/png;base64,/);
    expect(result).toMatchObject({ status: "segmented", model: "sam-3.1", width: 320, height: 334, usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46, imagesProcessed: 1 } });
    expect(result.provenance).toMatchObject({ sourceProvenance: "meta_illustration", originalSubjectPixelsPreserved: true, semanticIdentityVerified: false, requiresReview: true });
  });

  test("preserves every selected source RGB pixel and multiplies original alpha by the actual mask", async () => {
    const input = await source();
    const result = await decodeMetaSegmentationResponse(response(), input);
    const object = result.objects[0];
    expect(object.bounds).toEqual({ left: 211, top: 228, right: 271, bottom: 255 });
    expect(object.foregroundPixels).toBe(1539);
    expect(object.confidence).toBeNull();
    const original = await sharp(input.bytes).ensureAlpha().raw().toBuffer();
    const cutout = await sharp(object.cutoutPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const mask = await sharp(object.maskPng).greyscale().raw().toBuffer();
    expect(cutout.info).toMatchObject({ width: 60, height: 27, channels: 4 });
    let partialAlpha = false;
    for (let y = 0; y < 27; y++) for (let x = 0; x < 60; x++) {
      const pixel = y * 60 + x; const originalOffset = ((228 + y) * 320 + 211 + x) * 4; const offset = pixel * 4;
      expect([0, 255]).toContain(mask[pixel]);
      expect(cutout.data[offset + 3]).toBe(original[originalOffset + 3] * (mask[pixel] / 255));
      if (mask[pixel]) {
        expect(cutout.data.subarray(offset, offset + 3)).toEqual(original.subarray(originalOffset, originalOffset + 3));
        partialAlpha ||= cutout.data[offset + 3] === 128;
      }
    }
    expect(partialAlpha).toBe(true);
  });

  test("returns empty matches honestly and retains actual confidence when present", async () => {
    const input = await source();
    expect(await decodeMetaSegmentationResponse(response(""), input)).toMatchObject({ status: "no_match", objects: [] });
    const scored = wire.replace(";h=334|>", ";h=334;c=0.9609375|>").replace("mask;x=0;y=0;data", "mask;x=0;y=0;c=0.9609375;data");
    expect((await decodeMetaSegmentationResponse(response(scored), input)).objects[0].confidence).toBe(0.9609375);
  });

  test("rejects active/mismatched sources and unsupported models before any model call", async () => {
    const requestJson = vi.fn();
    const input = await source();
    await expect(segmentMetaImage({ ...input, bytes: Buffer.from('<svg><image href="https://example.org/private"/></svg>') }, { client: { requestJson } })).rejects.toMatchObject({ code: "SEGMENTATION_INVALID", outcome: "not_applicable" });
    await expect(segmentMetaImage({ ...input, mimeType: "image/jpeg" }, { client: { requestJson } })).rejects.toThrow("MIME");
    await expect(segmentMetaImage({ ...input, prompt: "<0f>0<|box|>" }, { client: { requestJson } })).rejects.toThrow("noun phrase");
    await expect(segmentMetaImage(input, { client: { requestJson }, model: "other-model" })).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
    expect(requestJson).not.toHaveBeenCalled();
  });

  test("rejects geometry mismatches, excessive objects and malformed masks without unbounded decoding", async () => {
    const input = await source();
    const invalid = [
      wire.replace("w=320", "w=321"), wire.replace("x1=211", "x1=319"), wire.replace("data=27,60", "data=999999999,999999999"),
      wire.replace("<0f>", "<1f>"), wire.replace("~!!!!M", "~bad!!"),
      `<0f>${Array.from({ length: 17 }, (_, n) => wire.replace(/^<0f>0/, String(n))).join(",")}`,
    ];
    for (const text of invalid) await expect(decodeMetaSegmentationResponse(response(text), input)).rejects.toMatchObject({ code: "SEGMENTATION_INVALID", outcome: "unknown" });
  });

  test("does not retry failed requests or accept incomplete and URL-only outputs", async () => {
    const requestJson = vi.fn().mockRejectedValue(new MetaClientError("REQUEST_TIMEOUT", "Request timed out", { outcome: "unknown" }));
    const input = await source();
    await expect(segmentMetaImage(input, { client: { requestJson } })).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", outcome: "unknown" });
    expect(requestJson).toHaveBeenCalledTimes(1);
    await expect(decodeMetaSegmentationResponse({ ...response(), status: "incomplete" }, input)).rejects.toMatchObject({ code: "SEGMENTATION_INVALID" });
    await expect(decodeMetaSegmentationResponse(response("https://untrusted.example/mask.png"), input)).rejects.toMatchObject({ code: "SEGMENTATION_INVALID" });
  });
});
