import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { hashBytes } from "../../lib/campaign/archive";
import { composeSegmentedSubject, prepareCampaignLayers, type CampaignLayersInput } from "../../lib/campaign/layers";
import type { CampaignCopy } from "../../lib/campaign/copy";
import type { MetaImageResult } from "../../lib/meta/image";
import { segmentMetaImage, type MetaSegmentationDependencies, type MetaSegmentationRequest, type MetaSegmentationResult, type MetaSegmentedObject } from "../../lib/meta/segmentation";
import { ChannelSchema } from "../../lib/schemas/common";

const directories: string[] = [];
const network = vi.fn(async () => { throw new Error("Network requests are forbidden in offline layer tests."); });
beforeEach(() => { network.mockClear(); vi.stubGlobal("fetch", network); });
afterEach(async () => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tickr-layers-"));
  directories.push(path);
  return path;
}

interface Raster { bytes: Buffer; rgba: Buffer; width: number; height: number }
async function sourceRaster(width = 10, height = 10, transparentEdges = true): Promise<Raster> {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    rgba[offset] = (19 * x + 7 * y) % 256;
    rgba[offset + 1] = (31 * y + 11 * x) % 256;
    rgba[offset + 2] = (17 * x + 23 * y) % 256;
    rgba[offset + 3] = transparentEdges && x === 1 && y === 1 ? 0 : transparentEdges && x === 2 && y === 2 ? 128 : 255;
  }
  const bytes = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { bytes, rgba, width, height };
}

async function maskObject(source: Raster, bounds: MetaSegmentedObject["bounds"], id: string, confidence: number | null = .95): Promise<MetaSegmentedObject> {
  const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
  const mask = Buffer.alloc(width * height, 255);
  const maskPng = await sharp(mask, { raw: { width, height, channels: 1 } }).toColourspace("b-w").png().toBuffer();
  const cutoutPng = await sharp(source.bytes).extract({ left: bounds.left, top: bounds.top, width, height }).png().toBuffer();
  return { id, bounds, confidence, foregroundPixels: width * height, coverageFraction: width * height / (source.width * source.height), maskPng, cutoutPng, sha256: hashBytes(cutoutPng) };
}

function segmentation(source: Raster, objects: MetaSegmentedObject[]): MetaSegmentationResult {
  return {
    status: objects.length ? "segmented" : "no_match", model: "sam-3.1", endpoint: "/responses", responseId: "offline-sam-response",
    width: source.width, height: source.height, sourceSha256: hashBytes(source.bytes), elapsedMs: 23, objects,
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, imagesProcessed: 1 },
    provenance: { kind: "meta_segmentation", sourceAssetId: "campaign-source-image", sourceProvenance: "source_photo", originalSubjectPixelsPreserved: true, preservationScope: "decoded_source_rgb_and_original_alpha_multiplied_by_binary_mask", semanticIdentityVerified: false, requiresReview: true, promptSha256: hashBytes(Buffer.from("Fixture product")) },
  };
}

async function usefulSegmentation(source: Raster): Promise<MetaSegmentationResult> {
  return segmentation(source, [
    await maskObject(source, { left: 1, top: 1, right: 5, bottom: 5 }, "first"),
    await maskObject(source, { left: 3, top: 3, right: 7, bottom: 6 }, "second", null),
    await maskObject(source, { left: 8, top: 8, right: 10, bottom: 10 }, "low-confidence", .4),
  ]);
}

async function backdrop(): Promise<MetaImageResult> {
  const bytes = await sharp({ create: { width: 20, height: 30, channels: 3, background: "#f3e9d6" } }).png().toBuffer();
  return {
    bytes, mimeType: "image/png", width: 20, height: 30, sha256: hashBytes(bytes), model: "muse-image-1.0", endpoint: "/images/generations", createdAt: null,
    usage: { inputTokens: 13, outputTokens: 17, totalTokens: 30 },
    provenance: { kind: "meta_generated_illustration", originalBusinessPhoto: false, referencePreservationVerified: false, referenceAssetIds: [], promptSha256: hashBytes(Buffer.from("Fixture backdrop")), implicitSearchEnabled: false, externalImageDownloads: false, requiresOwnerReview: true },
  };
}

function copy(): CampaignCopy {
  return {
    name: "Offline product concept", objective: "Test local composition", audienceHypothesis: "Fictional demonstration", coreMessage: "A fixture product", primaryCta: "Ask about it", evidenceIds: ["e1"], reviewNotes: ["Synthetic test input only"],
    channels: ChannelSchema.options.map((id) => ({ id, title: id, headline: "Fixture product", body: "Local test only", caption: "Synthetic input", cta: "Ask", evidenceIds: ["e1"] })),
    conversation: { opener: "Ask", commonReplies: Array.from({ length: 3 }, () => ({ question: "A fixture?", answer: "For local tests." })), qualificationQuestion: "Which fixture?", nextAction: "Review" },
    creativeBrief: {
      focus: { offeringId: "fixture-product", name: "Fixture product", description: "Synthetic raster object", evidenceIds: ["e1"], sourceIds: ["s1"] },
      brandStory: { signalIds: [], narrative: "Synthetic story", evidenceIds: ["e1"], sourceIds: ["s1"] },
      visualDirection: { status: "proposed", description: "Warm editorial paper and restrained light", palette: ["#f3e9d6", "#332211", "#ba5533"], sourceIds: [] },
      scenes: ["hook", "proof", "occasion", "action"].map((role) => ({ role: role as "hook" | "proof" | "occasion" | "action", headline: "Fixture", body: "Synthetic" })),
    },
  };
}

function input(outputDir: string, source: Raster): CampaignLayersInput {
  return {
    outputDir, mode: "live", copy: copy(), reserveModelCall: vi.fn(async () => {}),
    image: { bytes: source.bytes, mimeType: "image/png", provenance: "source_photo", sourceIds: ["s1"], description: "Offline source photo fixture" },
    visual: { kind: "source_photo", filename: "source-fixture.png", description: "Offline source photo fixture", sourceIds: ["s1"], sourceUrls: ["https://fixture.example/image.png"], model: null, warnings: ["Publication rights unverified."] },
  };
}

describe("SAM subject composition", () => {
  test("unions overlapping eligible masks, keeps exact source RGB and multiplies original alpha", async () => {
    const source = await sourceRaster();
    const result = await composeSegmentedSubject(source.bytes, await usefulSegmentation(source));
    expect(result).not.toBeNull();
    const foreground = await sharp(result!.foreground).ensureAlpha().raw().toBuffer();
    const mask = await sharp(result!.mask).greyscale().raw().toBuffer();
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      const index = y * 10 + x, offset = index * 4;
      const selected = x >= 1 && x < 5 && y >= 1 && y < 5 || x >= 3 && x < 7 && y >= 3 && y < 6;
      expect(mask[index]).toBe(selected ? 255 : 0);
      expect(foreground.subarray(offset, offset + 3)).toEqual(source.rgba.subarray(offset, offset + 3));
      expect(foreground[offset + 3]).toBe(selected ? source.rgba[offset + 3] : 0);
    }
    expect(result!.objects).toBe(2);
    expect(result!.coverage).toBe(.23); // 24 union pixels, one originally transparent.
    expect(foreground[(2 * 10 + 2) * 4 + 3]).toBe(128);
    expect(await sharp(source.bytes).ensureAlpha().raw().toBuffer()).toEqual(source.rgba);
  });

  test("rejects mismatched source hashes, raster dimensions, out-of-bounds and mismatched mask geometry", async () => {
    const source = await sourceRaster();
    const result = await usefulSegmentation(source);
    await expect(composeSegmentedSubject(source.bytes, { ...result, sourceSha256: "0".repeat(64) })).rejects.toThrow("does not belong");
    await expect(composeSegmentedSubject(source.bytes, { ...result, width: 11 })).rejects.toThrow("dimensions differ");
    for (const bounds of [{ left: -1, top: 1, right: 5, bottom: 5 }, { left: 1, top: 1, right: 11, bottom: 5 }, { left: 1.5, top: 1, right: 5, bottom: 5 }]) {
      await expect(composeSegmentedSubject(source.bytes, { ...result, objects: [{ ...result.objects[0], bounds }] })).rejects.toThrow("invalid subject bounds");
    }
    await expect(composeSegmentedSubject(source.bytes, { ...result, objects: [{ ...result.objects[0], bounds: { left: 1, top: 1, right: 6, bottom: 5 } }] })).rejects.toThrow("mask dimensions");
  });

  test("requires a usable visible selection, including the documented coverage boundaries", async () => {
    const source = await sourceRaster(20, 20, false);
    expect(await composeSegmentedSubject(source.bytes, segmentation(source, []))).toBeNull();
    const tiny = await maskObject(source, { left: 0, top: 0, right: 5, bottom: 1 }, "tiny");
    expect(await composeSegmentedSubject(source.bytes, segmentation(source, [tiny]))).toBeNull();
    const minimum = await maskObject(source, { left: 0, top: 0, right: 3, bottom: 2 }, "minimum");
    expect((await composeSegmentedSubject(source.bytes, segmentation(source, [minimum])))?.coverage).toBe(.015);
    const maximum = await maskObject(source, { left: 0, top: 0, right: 18, bottom: 20 }, "maximum");
    expect((await composeSegmentedSubject(source.bytes, segmentation(source, [maximum])))?.coverage).toBe(.9);
    const full = await maskObject(source, { left: 0, top: 0, right: 20, bottom: 20 }, "full");
    expect(await composeSegmentedSubject(source.bytes, segmentation(source, [full]))).toBeNull();
    expect(await composeSegmentedSubject(source.bytes, segmentation(source, [{ ...minimum, confidence: .49 }]))).toBeNull();
  });
});

describe("persisted campaign art direction", () => {
  test("reserves SAM and backdrop once, saves exact layers and provenance, then replays with zero calls", async () => {
    const path = await directory(), source = await sourceRaster(), fixture = input(path, source);
    const sam = await usefulSegmentation(source), background = await backdrop(), order: string[] = [];
    const reserve = vi.fn(async () => { order.push("reserve"); });
    fixture.reserveModelCall = reserve;
    const segment = vi.fn(async () => { order.push("segment"); return sam; });
    const generateBackground = vi.fn(async () => { order.push("background"); return background; });
    const first = await prepareCampaignLayers(fixture, { segment, generateBackground });
    expect(order).toEqual(["reserve", "segment", "reserve", "background"]);
    expect(segment).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ bytes: source.bytes, prompt: "Fixture product", sourceProvenance: "source_photo" }), { responseDirectory: join(path, "sam-response") });
    expect(generateBackground).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ size: "1024x1536", prompt: expect.stringContaining("empty editorial advertising backdrop") }));
    expect(first.visual.artDirection).toMatchObject({ composition: "subject_layers", sourceSha256: hashBytes(source.bytes), background: "meta_generated", segmentation: { status: "segmented", model: "sam-3.1", coverageFraction: .23, objectCount: 2 } });
    expect(first.usage).toEqual([expect.objectContaining({ model: "sam-3.1", inputTokens: 11, outputTokens: 7 }), expect.objectContaining({ model: "muse-image-1.0", inputTokens: 13, outputTokens: 17 })]);
    expect(first.assets.map((asset) => asset.filename)).toEqual(["campaign-subject.png", "campaign-subject-mask.png", "campaign-backdrop.png"]);
    for (const asset of first.assets) {
      const bytes = await readFile(join(path, asset.filename));
      expect(bytes.length).toBe(asset.bytes);
      expect(hashBytes(bytes)).toBe(asset.sha256);
      const metadata = await sharp(bytes).metadata();
      expect([metadata.width, metadata.height]).toEqual([asset.width, asset.height]);
      expect((await stat(join(path, asset.filename))).mode & 0o777).toBe(0o600);
    }
    const checkpoint = JSON.parse(await readFile(join(path, "sam-layer-checkpoint.json"), "utf8"));
    expect(checkpoint).toMatchObject({ state: "completed", responseId: "offline-sam-response", usage: { model: "sam-3.1", inputTokens: 11, outputTokens: 7 } });
    reserve.mockClear(); segment.mockClear(); generateBackground.mockClear();
    const replay = await prepareCampaignLayers({ ...fixture, reuseCompletedOnly: true }, { segment, generateBackground });
    expect(replay.visual).toEqual(first.visual);
    expect(replay.assets).toEqual(first.assets);
    expect(replay.usage).toEqual(first.usage);
    expect(Buffer.from(replay.image!.bytes)).toEqual(source.bytes);
    expect(Buffer.from(replay.image!.foregroundBytes!)).toEqual(Buffer.from(first.image!.foregroundBytes!));
    expect(Buffer.from(replay.image!.backgroundBytes!)).toEqual(background.bytes);
    expect(reserve).not.toHaveBeenCalled(); expect(segment).not.toHaveBeenCalled(); expect(generateBackground).not.toHaveBeenCalled();
  });

  test("a failed SAM attempt saves an original-image crop and never retries or generates a backdrop", async () => {
    const path = await directory(), source = await sourceRaster(), fixture = input(path, source);
    const segment = vi.fn(async () => { throw new Error("Synthetic uncertain timeout"); });
    const generateBackground = vi.fn(backdrop);
    const first = await prepareCampaignLayers(fixture, { segment, generateBackground });
    expect(first.visual.artDirection).toMatchObject({ composition: "image_crop", background: "source", segmentation: { status: "failed" } });
    expect(first.visual.warnings.join(" ")).toContain("not retried");
    expect(Buffer.from(first.image!.bytes)).toEqual(source.bytes);
    expect(first.image!.foregroundBytes).toBeUndefined();
    expect(first.assets).toEqual([]);
    const second = await prepareCampaignLayers(fixture, { segment, generateBackground });
    expect(second.visual).toEqual(first.visual);
    expect(segment).toHaveBeenCalledTimes(1); expect(fixture.reserveModelCall).toHaveBeenCalledTimes(1); expect(generateBackground).not.toHaveBeenCalled();
  });

  test("an in-flight SAM checkpoint retains the source image without another reservation or model call", async () => {
    const path = await directory(), source = await sourceRaster(), fixture = input(path, source);
    const segment = vi.fn(async () => { throw new Error("Synthetic timeout"); });
    const generateBackground = vi.fn(backdrop);
    await prepareCampaignLayers(fixture, { segment, generateBackground });
    const checkpoint = JSON.parse(await readFile(join(path, "sam-layer-checkpoint.json"), "utf8"));
    checkpoint.state = "requested"; delete checkpoint.usage; checkpoint.warnings = [];
    await writeFile(join(path, "sam-layer-checkpoint.json"), JSON.stringify(checkpoint));
    await rm(join(path, "art-direction-checkpoint.json"));
    segment.mockClear(); vi.mocked(fixture.reserveModelCall!).mockClear();
    const resumed = await prepareCampaignLayers(fixture, { segment, generateBackground });
    expect(resumed.visual.artDirection).toMatchObject({ composition: "image_crop", segmentation: { status: "failed" } });
    expect(resumed.visual.warnings.join(" ")).toContain("uncertain outcome");
    expect(Buffer.from(resumed.image!.bytes)).toEqual(source.bytes);
    expect(segment).not.toHaveBeenCalled(); expect(fixture.reserveModelCall).not.toHaveBeenCalled(); expect(generateBackground).not.toHaveBeenCalled();
  });

  test("a pending layer checkpoint recovers a completed SAM response without another reservation or model call", async () => {
    const path = await directory(), source = await sourceRaster(), fixture = input(path, source);
    fixture.visual = { ...fixture.visual, kind: "meta_illustration", model: "muse-image-1.0" };
    fixture.image = { ...fixture.image!, provenance: "meta_illustration" };
    const segment = vi.fn(async () => { throw new Error("Synthetic interrupted layer step"); });
    const generateBackground = vi.fn(backdrop);
    await prepareCampaignLayers(fixture, { segment, generateBackground });
    const checkpoint = JSON.parse(await readFile(join(path, "sam-layer-checkpoint.json"), "utf8"));
    checkpoint.state = "requested";
    delete checkpoint.usage; delete checkpoint.outcome;
    checkpoint.warnings = [];
    await writeFile(join(path, "sam-layer-checkpoint.json"), JSON.stringify(checkpoint));
    await rm(join(path, "art-direction-checkpoint.json"));
    segment.mockClear(); vi.mocked(fixture.reserveModelCall!).mockClear();

    const sam = await usefulSegmentation(source);
    const recoverSegment = vi.fn(async () => sam);
    const resumed = await prepareCampaignLayers(fixture, { segment, recoverSegment, generateBackground });
    expect(recoverSegment).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ bytes: source.bytes, prompt: "Fixture product", sourceProvenance: "meta_illustration" }), join(path, "sam-response"));
    expect(resumed.visual.artDirection).toMatchObject({ composition: "subject_layers", background: "palette", segmentation: { status: "segmented", coverageFraction: .23, objectCount: 2 } });
    expect(resumed.assets.map((asset) => asset.filename)).toEqual(["campaign-subject.png", "campaign-subject-mask.png"]);
    expect(resumed.usage).toEqual([{ model: "sam-3.1", inputTokens: 11, outputTokens: 7, elapsedMs: 23, imagesProcessed: 1 }]);
    expect(JSON.parse(await readFile(join(path, "sam-layer-checkpoint.json"), "utf8"))).toMatchObject({ state: "completed", outcome: "segmented", responseId: sam.responseId });
    expect(segment).not.toHaveBeenCalled(); expect(fixture.reserveModelCall).not.toHaveBeenCalled(); expect(generateBackground).not.toHaveBeenCalled();

    recoverSegment.mockClear();
    expect((await prepareCampaignLayers(fixture, { segment, recoverSegment, generateBackground })).visual).toEqual(resumed.visual);
    expect(recoverSegment).not.toHaveBeenCalled(); expect(segment).not.toHaveBeenCalled(); expect(fixture.reserveModelCall).not.toHaveBeenCalled();
  });

  test("a malformed completed SAM response retains metering and failed status with a sanitized diagnostic", async () => {
    const path = await directory(), source = await sourceRaster(), fixture = input(path, source);
    const providerOutput = "private-provider-output-do-not-expose";
    const requestJson = vi.fn().mockResolvedValue({
      id: "sam-malformed-response", status: "completed", model: "sam-3.1",
      output: [{ type: "message", content: [{ type: "output_text", text: providerOutput }] }],
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, images_processed: 1 },
    });
    const segment = vi.fn((request: MetaSegmentationRequest, dependencies: MetaSegmentationDependencies = {}) => segmentMetaImage(request, { ...dependencies, model: "sam-3.1", client: { requestJson } }));
    const generateBackground = vi.fn(backdrop);
    const failed = await prepareCampaignLayers(fixture, { segment, generateBackground });
    expect(failed.visual.artDirection).toMatchObject({ composition: "image_crop", segmentation: { status: "failed" } });
    expect(failed.usage).toEqual([expect.objectContaining({ model: "sam-3.1", inputTokens: 11, outputTokens: 7, imagesProcessed: 1 })]);
    expect(failed.assets).toEqual([]);
    const checkpoint = JSON.parse(await readFile(join(path, "sam-layer-checkpoint.json"), "utf8"));
    expect(checkpoint).toMatchObject({ state: "completed", outcome: "failed", responseId: "sam-malformed-response", usage: { inputTokens: 11, outputTokens: 7, imagesProcessed: 1 } });
    const diagnosticPath = join(path, "sam-layer-diagnostic.json");
    const diagnosticText = await readFile(diagnosticPath, "utf8");
    expect(JSON.parse(diagnosticText)).toMatchObject({ phase: "decode", code: "SEGMENTATION_INVALID", completedResponseStored: true, responseId: "sam-malformed-response", usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, imagesProcessed: 1 } });
    expect((await stat(diagnosticPath)).mode & 0o777).toBe(0o600);
    expect(diagnosticText).not.toContain(providerOutput);
    expect(JSON.stringify(failed.visual)).not.toContain(providerOutput);
    expect(await readFile(join(path, "sam-response", "sam-response.json"), "utf8")).toContain(providerOutput);

    expect((await prepareCampaignLayers(fixture, { segment, generateBackground })).visual).toEqual(failed.visual);
    expect(segment).toHaveBeenCalledTimes(1); expect(requestJson).toHaveBeenCalledTimes(1);
    expect(fixture.reserveModelCall).toHaveBeenCalledTimes(1); expect(generateBackground).not.toHaveBeenCalled();
  });

  test("changed layer bytes and changed source bindings fail closed without replacement calls", async () => {
    const path = await directory(), source = await sourceRaster(), fixture = input(path, source);
    const sam = await usefulSegmentation(source);
    const segment = vi.fn(async () => sam), generateBackground = vi.fn(backdrop);
    const first = await prepareCampaignLayers(fixture, { segment, generateBackground });
    segment.mockClear(); generateBackground.mockClear(); vi.mocked(fixture.reserveModelCall!).mockClear();
    const changedSource = await sourceRaster(10, 10, false);
    await expect(prepareCampaignLayers({ ...fixture, image: { ...fixture.image!, bytes: changedSource.bytes } }, { segment, generateBackground })).rejects.toThrow("no longer match");
    await writeFile(join(path, first.visual.artDirection!.foregroundFilename!), "corrupt layer bytes");
    await expect(prepareCampaignLayers(fixture, { segment, generateBackground })).rejects.toThrow("changed");
    expect(segment).not.toHaveBeenCalled(); expect(generateBackground).not.toHaveBeenCalled(); expect(fixture.reserveModelCall).not.toHaveBeenCalled();
  });

  test("synthetic, missing-image and render-only execution never request models", async () => {
    const path = await directory(), source = await sourceRaster(), fixture = input(path, source);
    const segment = vi.fn(async () => usefulSegmentation(source)), generateBackground = vi.fn(backdrop);
    for (const request of [{ ...fixture, mode: "synthetic" as const }, { ...fixture, image: undefined }, { ...fixture, reuseCompletedOnly: true }]) {
      const result = await prepareCampaignLayers(request, { segment, generateBackground });
      expect(result.image).toEqual(request.image);
      expect(result.assets).toEqual([]); expect(result.usage).toEqual([]);
    }
    expect(await readdir(path)).toEqual([]);
    const local = await prepareCampaignLayers({ ...fixture, reserveModelCall: undefined }, { segment, generateBackground });
    expect(local.visual.artDirection).toMatchObject({ composition: "image_crop", segmentation: { status: "skipped" } });
    expect(Buffer.from(local.image!.bytes)).toEqual(source.bytes);
    expect(local.assets).toEqual([]); expect(local.usage).toEqual([]);
    expect(segment).not.toHaveBeenCalled(); expect(generateBackground).not.toHaveBeenCalled(); expect(fixture.reserveModelCall).not.toHaveBeenCalled();
  });
});
