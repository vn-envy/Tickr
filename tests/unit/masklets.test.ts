import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { FrameMask, MaskletSet } from "../../lib/media/cinema-types";
import { createMaskletWriter, MASKLET_INDEX_FILE, openMaskletStore, packMaskBits, readMaskletStore, summarizeTrack, trackPointOf, unpackMaskBits, type MaskletCommit } from "../../lib/media/masklets";
import { ellipseRaster } from "../helpers/sam-wire";

// SYNTHETIC fixtures only: generated rasters and invented labels; no real clip is read.
const clip: MaskletSet["clip"] = { sha256: "a".repeat(64), width: 40, height: 30, fps: 25, frameCount: 60 };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "tickr-masklets-")); directories.push(path); return path; }

const rect = (objectId: string, frame: number, left: number, top: number, width: number, height: number, confidence: number | null = null): FrameMask =>
  ({ objectId, frame, bounds: { left, top, right: left + width, bottom: top + height }, confidence, raster: new Uint8Array(width * height).fill(1) });
const ellipse = (objectId: string, frame: number, left: number, top: number, width: number, height: number, confidence: number | null = null): FrameMask =>
  ({ objectId, frame, bounds: { left, top, right: left + width, bottom: top + height }, confidence, raster: ellipseRaster(width, height) });
const commit = (overrides: Partial<MaskletCommit> = {}): MaskletCommit => ({
  identity: (objectId) => ({ label: `Synthetic object ${objectId}`, origin: objectId === "0" ? "owner_tap" : "spark_grounding" }),
  set: { responseId: "resp_synthetic_test", promptKind: "geometry", propagation: "both", framesBilled: 50, elapsedMs: 12, createdAt: new Date(0).toISOString() },
  binding: { inputHash: "b".repeat(64), usage: { frames_processed: 50 }, unmatchedPromptIds: [] },
  ...overrides,
});
async function writeSample(path: string) {
  const writer = await createMaskletWriter(path, clip);
  await writer.add(ellipse("0", 0, 2, 3, 13, 9, .9));
  await writer.add(rect("1", 0, 20, 10, 5, 4));
  // An empty mask is a frame without the object: nothing is stored.
  expect(await writer.add({ ...rect("1", 1, 0, 0, 3, 3), raster: new Uint8Array(9) })).toBeNull();
  await writer.add(ellipse("0", 4, 3, 3, 13, 9, .7));
  await writer.add(rect("1", 7, 21, 11, 5, 4, .5));
  return writer.commit(commit());
}

describe("masklet bit packing and track math", () => {
  test("packs most-significant-bit first and round-trips odd lengths with zero padding", () => {
    const raster = Uint8Array.from([1, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0]);
    const packed = packMaskBits(raster);
    expect([...packed]).toEqual([0b10110001, 0b11000000]);
    expect([...unpackMaskBits(packed, raster.length)]).toEqual([...raster]);
    expect(() => unpackMaskBits(Buffer.from([0b10110001, 0b11000001]), raster.length)).toThrow();
    expect(() => unpackMaskBits(packed, 17)).toThrow();
    expect(() => packMaskBits(Uint8Array.from([0, 2]))).toThrow("binary");
  });

  test("computes centroids in continuous clip pixels, area and coverage", () => {
    const point = trackPointOf(rect("3", 5, 10, 20, 4, 2, .25))!;
    expect(point).toEqual({ frame: 5, cx: 12, cy: 21, area: 8, bounds: { left: 10, top: 20, right: 14, bottom: 22 }, confidence: .25 });
    // An L shape: pixels (0,0), (0,1), (1,1) inside a box at (4, 6).
    const shape = trackPointOf({ objectId: "3", frame: 6, bounds: { left: 4, top: 6, right: 6, bottom: 8 }, confidence: null, raster: Uint8Array.from([1, 0, 1, 1]) })!;
    expect(shape.cx).toBeCloseTo(4 + 1 / 3 + .5); expect(shape.cy).toBeCloseTo(6 + 2 / 3 + .5); expect(shape.area).toBe(3);
    expect(trackPointOf({ ...rect("3", 1, 0, 0, 2, 2), raster: new Uint8Array(4) })).toBeNull();
    const summary = summarizeTrack({ objectId: "3", label: "Synthetic cup", origin: "owner_tap", clip: { width: 40, height: 30 }, points: [point, shape, { ...point, frame: 9, confidence: null }] });
    expect(summary).toMatchObject({ firstFrame: 5, lastFrame: 9, framesPresent: 3, meanConfidence: .25 });
    expect(summary.meanCoverage).toBeCloseTo((8 + 3 + 8) / 3 / 1200);
    expect(summarizeTrack({ objectId: "3", label: "x", origin: "owner_tap", clip, points: [shape] }).meanConfidence).toBeNull();
    expect(() => summarizeTrack({ objectId: "3", label: "x", origin: "owner_tap", clip, points: [point, point] })).toThrow();
  });
});

describe("masklet store", () => {
  test("round-trips packed masks, summaries and the binding with private file modes", async () => {
    const path = await directory();
    const written = await writeSample(path);
    expect(written.set).toMatchObject({ version: 1, model: "sam-3.1", clip, provenance: { kind: "meta_video_segmentation", semanticIdentityVerified: false, requiresReview: true } });
    expect(written.set.objects.map(({ objectId, label, origin, firstFrame, lastFrame, framesPresent, meanConfidence }) => ({ objectId, label, origin, firstFrame, lastFrame, framesPresent, meanConfidence }))).toEqual([
      { objectId: "0", label: "Synthetic object 0", origin: "owner_tap", firstFrame: 0, lastFrame: 4, framesPresent: 2, meanConfidence: expect.closeTo(.8) },
      { objectId: "1", label: "Synthetic object 1", origin: "spark_grounding", firstFrame: 0, lastFrame: 7, framesPresent: 2, meanConfidence: .5 },
    ]);
    expect((await readdir(path)).sort()).toEqual([MASKLET_INDEX_FILE, "masks-0.bin", "masks-1.bin"]);
    for (const name of await readdir(path)) expect((await stat(join(path, name))).mode & 0o777).toBe(0o600);

    const { reader, binding } = await readMaskletStore(path, { clipSha256: clip.sha256, inputHash: "b".repeat(64) });
    expect(binding).toEqual({ inputHash: "b".repeat(64), usage: { frames_processed: 50 }, unmatchedPromptIds: [] });
    expect(reader.set).toEqual(written.set);
    const mask = await reader.frameMask("0", 4);
    expect(mask).toEqual({ objectId: "0", frame: 4, bounds: { left: 3, top: 3, right: 16, bottom: 12 }, confidence: .7, raster: ellipseRaster(13, 9) });
    expect(await reader.frameMask("1", 7)).toMatchObject({ bounds: { left: 21, top: 11, right: 26, bottom: 15 }, confidence: .5 });
    expect(await reader.frameMask("1", 1)).toBeNull();
    expect(await reader.frameMask("0", 59)).toBeNull();
    await expect(reader.frameMask("9", 0)).rejects.toMatchObject({ code: "MASKLETS_INVALID" });
    await expect(reader.frameMask("0", 60)).rejects.toMatchObject({ code: "MASKLETS_INVALID" });
    await expect(reader.frameMask("0", 1.5)).rejects.toMatchObject({ code: "MASKLETS_INVALID" });
  });

  test("detects missing stores, foreign clips, request mismatches and tampered files", async () => {
    const path = await directory();
    await expect(openMaskletStore(path, clip.sha256)).rejects.toMatchObject({ code: "MASKLETS_MISSING" });
    await expect(openMaskletStore(join(path, "absent"), clip.sha256)).rejects.toMatchObject({ code: "MASKLETS_MISSING" });
    await writeSample(path);
    await expect(openMaskletStore(path, "c".repeat(64))).rejects.toMatchObject({ code: "MASKLETS_INVALID" });
    await expect(readMaskletStore(path, { clipSha256: clip.sha256, inputHash: "d".repeat(64) })).rejects.toMatchObject({ code: "MASKLETS_INVALID" });

    const bin = join(path, "masks-0.bin");
    const original = await readFile(bin);
    const flipped = Buffer.from(original); flipped[3] ^= 0xff;
    await writeFile(bin, flipped);
    await expect(openMaskletStore(path, clip.sha256)).rejects.toMatchObject({ code: "MASKLETS_INVALID" });
    await writeFile(bin, original.subarray(0, original.length - 1));
    await expect(openMaskletStore(path, clip.sha256)).rejects.toMatchObject({ code: "MASKLETS_INVALID" });
    await writeFile(bin, original);
    const reader = await openMaskletStore(path, clip.sha256);

    // Changes after a verified open are still caught per read (size and foreground count).
    const cleared = Buffer.from(original); cleared.fill(0, 0, 4);
    await writeFile(bin, cleared);
    await expect(reader.frameMask("0", 0)).rejects.toMatchObject({ code: "MASKLETS_INVALID" });
    await writeFile(bin, original);

    const index = join(path, MASKLET_INDEX_FILE);
    const document = JSON.parse(await readFile(index, "utf8"));
    for (const mutate of [
      (value: typeof document) => { value.set.objects[0].track[0].area += 1; },
      (value: typeof document) => { value.files[0].entries[0].bounds.right = 41; value.set.objects[0].track[0].bounds.right = 41; },
      (value: typeof document) => { value.files[1].file = "../masks-1.bin"; },
      (value: typeof document) => { value.set.provenance.semanticIdentityVerified = true; },
      (value: typeof document) => { value.extra = true; },
    ]) {
      const copy = structuredClone(document); mutate(copy);
      await writeFile(index, JSON.stringify(copy));
      await expect(openMaskletStore(path, clip.sha256)).rejects.toMatchObject({ code: "MASKLETS_INVALID" });
    }
    await writeFile(index, "{not json");
    await expect(openMaskletStore(path, clip.sha256)).rejects.toMatchObject({ code: "MASKLETS_INVALID" });
  });

  test("rejects out-of-order, out-of-bounds and unidentified masks and leaves no pending files", async () => {
    const path = await directory();
    const writer = await createMaskletWriter(path, clip);
    await writer.add(rect("2", 5, 0, 0, 4, 4));
    await expect(writer.add(rect("2", 5, 0, 0, 4, 4))).rejects.toThrow("ascending frame order");
    await expect(writer.add(rect("2", 3, 0, 0, 4, 4))).rejects.toThrow("ascending frame order");
    await expect(writer.add(rect("4", 60, 0, 0, 4, 4))).rejects.toThrow("outside the clip");
    await expect(writer.add(rect("4", 1, 38, 0, 4, 4))).rejects.toThrow("outside its clip");
    await expect(writer.add({ ...rect("4", 1, 0, 0, 2, 2), raster: new Uint8Array(3) })).rejects.toThrow("disagree");
    await expect(writer.add(rect("../x", 1, 0, 0, 2, 2))).rejects.toThrow("decimal");
    await expect(writer.add(rect("4", 1, 0, 0, 2, 2, 1.5))).rejects.toThrow("confidence");
    await expect(writer.commit(commit({ identity: () => undefined }))).rejects.toMatchObject({ code: "MASKLETS_INVALID" });
    expect(await readdir(path)).toEqual([]);
    await expect(writer.add(rect("2", 9, 0, 0, 4, 4))).rejects.toThrow("closed");
  });

  test("replaces an older set and removes its unreferenced binaries; an empty set is valid", async () => {
    const path = await directory();
    await writeSample(path);
    const writer = await createMaskletWriter(path, clip);
    await writer.add(rect("1", 2, 0, 0, 3, 3));
    const reader = await writer.commit(commit());
    expect(reader.set.objects.map((object) => object.objectId)).toEqual(["1"]);
    expect((await readdir(path)).sort()).toEqual([MASKLET_INDEX_FILE, "masks-1.bin"]);
    expect((await openMaskletStore(path, clip.sha256)).set.objects[0].track).toHaveLength(1);

    const empty = await directory();
    const none = await (await createMaskletWriter(empty, clip)).commit(commit());
    expect(none.set.objects).toEqual([]);
    expect((await openMaskletStore(empty, clip.sha256)).set.objects).toEqual([]);
  });
});
