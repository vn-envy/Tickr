import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { NormalizedClip } from "../../lib/media/cinema-types";
import { openMaskletStore } from "../../lib/media/masklets";
import { MetaClientError } from "../../lib/meta/config";
import type { SamObjectPrompt } from "../../lib/meta/sam-prompts";
import { collectUsage, framesBilledFrom, getSamVideoDiagnostic, preflightSamVideoWire, trackMetaVideo, type SamVideoRequest } from "../../lib/meta/sam-video";
import { ellipseRaster, samRecord, samResponse, samVideoWire, type SyntheticSamObject } from "../helpers/sam-wire";

// SYNTHETIC fixtures only: the "clip" is arbitrary bytes behind an MP4 `ftyp` header (the adapter
// only hashes and sends bytes), labels are invented and SAM wire text is encoded locally.
const size = { width: 64, height: 48 };
const frameCount = 60;
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const directories: string[] = [];
const network = vi.fn(async () => { throw new Error("Network requests are forbidden in offline SAM video tests."); });
beforeEach(() => { network.mockClear(); vi.stubGlobal("fetch", network); });
afterEach(async () => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() { const path = await mkdtemp(join(tmpdir(), "tickr-sam-video-")); directories.push(path); return path; }

const clipBytes = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.from("synthetic tracking clip bytes, not a playable video")]);
async function syntheticClip(overrides: Partial<NormalizedClip> = {}): Promise<NormalizedClip> {
  const root = await directory();
  const path = join(root, "clip.mp4");
  await writeFile(path, clipBytes);
  return {
    version: 1, id: "synthetic-clip", sha256: sha256(clipBytes), path, width: size.width, height: size.height, fps: 30, frameCount, durationSeconds: 2,
    posterPath: join(root, "poster.png"), audioPath: null,
    original: { bytes: clipBytes.length, sha256: sha256(clipBytes), container: "mp4", videoCodec: "h264", durationSeconds: 2, width: size.width, height: size.height },
    provenance: "owner_upload", consent: { ownsOrLicensedMedia: true, peopleVisibleHaveConsented: "no_people", attestedAt: new Date(0).toISOString() }, createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}
async function dirs() { return { responseDirectory: await directory(), outputDirectory: await directory() }; }

const geometry: SamObjectPrompt[] = [
  { objectId: 0, label: "Synthetic cup", origin: "owner_tap", prompts: [{ frame: 10, box: { x1: 4, y1: 6, x2: 23, y2: 29 } }, { frame: 0, points: [{ x: 12, y: 15, polarity: "positive" }, { x: 2, y: 2, polarity: "negative" }] }] },
  { objectId: 3, label: "Synthetic plate", origin: "spark_grounding", prompts: [{ frame: 0, box: { x1: 30, y1: 20, x2: 50, y2: 40 } }] },
  { objectId: 5, label: "Synthetic sign", origin: "local_layout", prompts: [{ frame: 20, points: [{ x: 60, y: 4, polarity: "positive" }] }] },
];
const expectedWire = "<0f>0<|point;x=12;y=15;w=64;h=48|>-<|point;x=2;y=2;w=64;h=48|>,3<|box;x1=30;y1=20;x2=50;y2=40;w=64;h=48|>"
  + "<10f>0<|box;x1=4;y1=6;x2=23;y2=29;w=64;h=48|><20f>5<|point;x=60;y=4;w=64;h=48|>";
async function geometryRequest(overrides: Partial<SamVideoRequest> = {}): Promise<SamVideoRequest> {
  return { clip: await syntheticClip(), prompt: { kind: "geometry", objects: geometry }, propagation: "both", ...overrides };
}
const solid = (width: number, height: number) => new Uint8Array(width * height).fill(1);
const trackFrames = [
  { frame: 0, objects: [{ id: 0, box: { x1: 4, y1: 6, x2: 23, y2: 29 }, confidence: .9 }, { id: 3, box: { x1: 30, y1: 20, x2: 33, y2: 21 }, raster: solid(4, 2) }] },
  { frame: 1, objects: [{ id: 0, box: { x1: 5, y1: 6, x2: 24, y2: 29 }, confidence: .7 }] },
  { frame: 2, objects: [] },
  { frame: 9, objects: [{ id: 3, box: { x1: 31, y1: 20, x2: 34, y2: 21 }, raster: solid(4, 2) }] },
];
const usage = { frames_processed: 60, input_tokens: 11, output_tokens: 900, novel_metric: 2, nested: { video_seconds: 2 } };
// Usage field names for video are undocumented; a nested object checks the generic flattening.
const tracked = (options: { bareEmptyFrames?: boolean } = {}) => ({ ...samResponse(samVideoWire(trackFrames, size, options)), usage });

describe("SAM 3.1 video tracking adapter", () => {
  test("sends multi-frame geometry text, the inline MP4 and string metadata, never local labels", async () => {
    const request = await geometryRequest({ propagation: "forward" });
    const requestJson = vi.fn().mockResolvedValue(tracked());
    const run = await dirs();
    const result = await trackMetaVideo(request, { client: { requestJson }, ...run });
    expect(requestJson).toHaveBeenCalledTimes(1);
    const [path, options] = requestJson.mock.calls[0];
    expect(path).toBe("/responses");
    expect(options).toEqual({ method: "POST", modelRole: "segmentation", body: {
      model: "sam-3.1",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: expectedWire }, { type: "input_video", video_url: `data:video/mp4;base64,${clipBytes.toString("base64")}` }] }],
      stream: false, store: false, metadata: { mask_encoding: "one_bit", include_confidence: "true", propagation_direction: "forward" },
    } });
    expect(JSON.stringify(options)).not.toMatch(/Synthetic|owner_tap|spark_grounding|local_layout|clip\.mp4/);
    expect(result.source).toBe("request");
    expect(result.unmatchedPromptIds).toEqual([5]);
    expect(result.set).toMatchObject({ model: "sam-3.1", responseId: "resp_synthetic_test", promptKind: "geometry", propagation: "forward", framesBilled: 60,
      clip: { sha256: request.clip.sha256, width: 64, height: 48, fps: 30, frameCount: 60 }, provenance: { semanticIdentityVerified: false, requiresReview: true } });
    expect(result.usage).toEqual({ frames_processed: 60, input_tokens: 11, output_tokens: 900, novel_metric: 2, "nested.video_seconds": 2 });
    const [cup, plate] = result.set.objects;
    expect(cup).toMatchObject({ objectId: "0", label: "Synthetic cup", origin: "owner_tap", firstFrame: 0, lastFrame: 1, framesPresent: 2, meanConfidence: expect.closeTo(.8) });
    // A solid 4×2 box at (30, 20): centroid (32, 21) in continuous pixels, area 8.
    expect(plate).toMatchObject({ objectId: "3", label: "Synthetic plate", origin: "spark_grounding", firstFrame: 0, lastFrame: 9, framesPresent: 2, meanConfidence: null, meanCoverage: 8 / (64 * 48) });
    expect(plate.track).toEqual([
      { frame: 0, cx: 32, cy: 21, area: 8, bounds: { left: 30, top: 20, right: 34, bottom: 22 }, confidence: null },
      { frame: 9, cx: 33, cy: 21, area: 8, bounds: { left: 31, top: 20, right: 35, bottom: 22 }, confidence: null },
    ]);
    expect(await result.reader.frameMask("0", 1)).toEqual({ objectId: "0", frame: 1, bounds: { left: 5, top: 6, right: 25, bottom: 30 }, confidence: .7, raster: ellipseRaster(20, 24) });
    expect(await result.reader.frameMask("0", 2)).toBeNull();
    expect((await openMaskletStore(run.outputDirectory, request.clip.sha256)).set).toEqual(result.set);
  });

  test("treats bare frame-marker lines as frames without objects", async () => {
    const wire = samVideoWire(trackFrames, size, { bareEmptyFrames: true });
    expect(wire.split("\n")).toContain("<2f>");
    expect(preflightSamVideoWire(wire, { ...size, frameCount })).toMatchObject({ emptyFrames: [2], records: [{ frame: 0, objectId: "0" }, { frame: 0, objectId: "3" }, { frame: 1, objectId: "0" }, { frame: 9, objectId: "3" }] });
    const result = await trackMetaVideo(await geometryRequest(), { client: { requestJson: vi.fn().mockResolvedValue(tracked({ bareEmptyFrames: true })) }, ...await dirs() });
    expect(result.set.objects.map((object) => object.framesPresent)).toEqual([2, 2]);
    expect(await result.reader.frameMask("3", 2)).toBeNull();
    // Only the whole line may be bare: a bare marker with header fields still fails closed.
    expect(() => preflightSamVideoWire("<2f;x=1>", { ...size, frameCount })).toThrow("exceeds its bounds");
    // Zero matches anywhere: empty output text is a valid, empty masklet set.
    const empty = await trackMetaVideo(await geometryRequest(), { client: { requestJson: vi.fn().mockResolvedValue(samResponse("", {})) }, ...await dirs() });
    expect(empty.set.objects).toEqual([]); expect(empty.unmatchedPromptIds).toEqual([0, 3, 5]); expect(empty.set.framesBilled).toBeNull();
  });

  test("rejects out-of-range declared geometry before any mask payload is decoded", async () => {
    const clip = { ...size, frameCount };
    const broken = (record: string) => record.replace(/data=(\d+),(\d+),!.*\|>$/, "data=$1,$2,!!!!!|>"); // undecodable payload
    const good = (object: SyntheticSamObject, frame = 0) => `<${frame}f>${samRecord(object, size)}`;
    const cases = [
      broken(good({ id: 0, box: { x1: 1, y1: 1, x2: 4, y2: 4 } }, 60)), // frame outside the clip
      broken(samRecord({ id: 0, box: { x1: 1, y1: 1, x2: 4, y2: 4 } }, { width: 65, height: 48 })).replace(/^/, "<0f>"), // box w/h disagree with the clip
      broken(good({ id: 0, box: { x1: 1, y1: 1, x2: 4, y2: 4 } }).replace("x2=4", "x2=64")), // box outside the frame
      broken(good({ id: 0, box: { x1: 1, y1: 1, x2: 4, y2: 4 } }).replace("data=4,4", "data=5,4")), // mask dims disagree with box
      `${good({ id: 0, box: { x1: 1, y1: 1, x2: 4, y2: 4 } })}\n${broken(good({ id: 3, box: { x1: 1, y1: 1, x2: 4, y2: 4 } }))}`, // repeated frame line
      `<0f>${Array.from({ length: 17 }, (_, id) => broken(samRecord({ id, box: { x1: 1, y1: 1, x2: 2, y2: 2 } }, size))).join(",")}`, // 17 objects on one frame
      broken(good({ id: 0, box: { x1: 1, y1: 1, x2: 4, y2: 4 } }).replace("|><|mask", ";extra=1|><|mask")), // unsupported field
    ];
    for (const wire of cases) {
      expect(() => preflightSamVideoWire(wire, clip)).toThrow("SAM video geometry exceeds its bounds or contains unsupported fields.");
      const failure = await trackMetaVideo(await geometryRequest(), { client: { requestJson: vi.fn().mockResolvedValue(samResponse(wire)) }, ...await dirs() }).catch((error) => error);
      expect(getSamVideoDiagnostic(failure)).toMatchObject({ phase: "decode", code: "VIDEO_SEGMENTATION_INVALID", detail: "SAM video geometry exceeds its bounds or contains unsupported fields.", completedResponseStored: true });
    }
    // Aggregate declared mask pixels are bounded before decoding (a 1×1 clip-sized claim repeated is cheap to write).
    const big = { width: 8192, height: 8192 };
    const line = (frame: number) => `<${frame}f>0<|box;x1=0;y1=0;x2=8191;y2=8191;w=8192;h=8192|><|mask;x=0;y=0;data=8192,8192,!!|>`;
    expect(() => preflightSamVideoWire(Array.from({ length: 9 }, (_, frame) => line(frame)).join("\n"), { ...big, frameCount: 10 })).toThrow("exceeds its bounds");
    expect(() => preflightSamVideoWire(Array.from({ length: 8 }, (_, frame) => line(frame)).join("\n"), { ...big, frameCount: 10 })).not.toThrow();
  });

  test("rejects object ids that were not prompted and keeps the paid response", async () => {
    const { responseDirectory, outputDirectory } = await dirs();
    const foreign = samResponse(samVideoWire([{ frame: 0, objects: [{ id: 0, box: { x1: 1, y1: 1, x2: 9, y2: 9 } }] }, { frame: 4, objects: [{ id: 7, box: { x1: 1, y1: 1, x2: 9, y2: 9 } }] }], size));
    const requestJson = vi.fn().mockResolvedValue(foreign);
    const failure = await trackMetaVideo(await geometryRequest(), { client: { requestJson }, responseDirectory, outputDirectory }).catch((error) => error);
    expect(getSamVideoDiagnostic(failure)).toMatchObject({ phase: "decode", detail: "Video segmentation returned an object that was not prompted.", completedResponseStored: true, responseId: "resp_synthetic_test" });
    expect(await readdir(outputDirectory)).toEqual([]);
    // The stored response is decoded again offline (and fails again); it is never re-requested.
    await expect(trackMetaVideo(await geometryRequest(), { client: { requestJson }, responseDirectory, outputDirectory })).rejects.toMatchObject({ code: "VIDEO_SEGMENTATION_INVALID" });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  test("recovers offline from the stored response and reuses a verified masklet store", async () => {
    const { responseDirectory, outputDirectory } = await dirs();
    const request = await geometryRequest();
    const first = await trackMetaVideo(request, { client: { requestJson: vi.fn().mockResolvedValue(tracked()) }, responseDirectory, outputDirectory });
    const offline = vi.fn(async () => { throw new Error("must not be called"); });
    const reused = await trackMetaVideo(request, { client: { requestJson: offline }, responseDirectory, outputDirectory });
    expect(reused).toMatchObject({ source: "masklet_store", set: first.set, usage: first.usage, unmatchedPromptIds: [5] });
    // A different output directory rebuilds from the private response without network or credentials.
    const rebuilt = await trackMetaVideo(request, { responseDirectory, outputDirectory: await directory() });
    expect(rebuilt.source).toBe("stored_response");
    expect(rebuilt.set.objects).toEqual(first.set.objects);
    // Tampered derived output is rebuilt from the stored response, never re-requested.
    const bin = join(outputDirectory, "masks-0.bin");
    const bytes = await readFile(bin); bytes[0] ^= 1; await writeFile(bin, bytes);
    await expect(openMaskletStore(outputDirectory, request.clip.sha256)).rejects.toMatchObject({ code: "MASKLETS_INVALID" });
    expect((await trackMetaVideo(request, { client: { requestJson: offline }, responseDirectory, outputDirectory })).source).toBe("stored_response");
    expect((await openMaskletStore(outputDirectory, request.clip.sha256)).set.objects).toEqual(first.set.objects);
    // A different propagation is a different request: its binding does not match the stored attempt.
    await expect(trackMetaVideo({ ...request, propagation: "forward" }, { client: { requestJson: offline }, responseDirectory, outputDirectory: await directory() })).rejects.toMatchObject({ code: "VIDEO_SEGMENTATION_CHECKPOINT_INVALID" });
    expect(offline).not.toHaveBeenCalled();
  });

  test("an uncertain earlier attempt never authorizes a new paid request", async () => {
    const { responseDirectory, outputDirectory } = await dirs();
    const requestJson = vi.fn().mockRejectedValue(new MetaClientError("REQUEST_TIMEOUT", "Meta request timed out; no retry was attempted", { outcome: "unknown" }));
    const failure = await trackMetaVideo(await geometryRequest(), { client: { requestJson }, responseDirectory, outputDirectory }).catch((error) => error);
    expect(getSamVideoDiagnostic(failure)).toMatchObject({ phase: "request", completedResponseStored: false });
    expect(JSON.stringify(getSamVideoDiagnostic(failure))).not.toContain(responseDirectory);
    await expect(trackMetaVideo(await geometryRequest(), { client: { requestJson }, responseDirectory, outputDirectory })).rejects.toMatchObject({ code: "VIDEO_SEGMENTATION_PENDING" });
    expect(requestJson).toHaveBeenCalledTimes(1);
    // Without a stored attempt or credentials, the client fails before any marker is written.
    vi.stubEnv("META_API_KEY", "");
    const fresh = await dirs();
    await expect(trackMetaVideo(await geometryRequest(), fresh)).rejects.toMatchObject({ code: "API_KEY_MISSING" });
    expect(await readdir(fresh.responseDirectory)).toEqual([]);
  });

  test("validates the clip bytes, frame budget, propagation and prompts before any request", async () => {
    const requestJson = vi.fn();
    const attempt = async (request: SamVideoRequest) => getSamVideoDiagnostic(await trackMetaVideo(request, { client: { requestJson }, ...await dirs() }).catch((error) => error));
    expect(await attempt(await geometryRequest({ clip: await syntheticClip({ sha256: "f".repeat(64) }) }))).toMatchObject({ phase: "input", detail: "The tracking clip bytes do not match their recorded SHA-256." });
    expect(await attempt(await geometryRequest({ clip: await syntheticClip({ frameCount: 901 }) }))).toMatchObject({ detail: expect.stringContaining("at most 900 frames") });
    expect(await attempt(await geometryRequest({ clip: await syntheticClip({ path: "relative/clip.mp4" }) }))).toMatchObject({ code: "VIDEO_SEGMENTATION_INVALID" });
    const notMp4 = await syntheticClip();
    await writeFile(notMp4.path, Buffer.from("synthetic non-mp4 bytes"));
    expect(await attempt({ ...await geometryRequest(), clip: { ...notMp4, sha256: sha256(Buffer.from("synthetic non-mp4 bytes")) } })).toMatchObject({ detail: "The tracking clip must be an MP4 container." });
    const frameZeroOnly: SamObjectPrompt[] = [{ objectId: 1, label: "Synthetic cup", origin: "owner_tap", prompts: [{ frame: 0, box: { x1: 1, y1: 1, x2: 9, y2: 9 } }] }];
    expect(await attempt(await geometryRequest({ propagation: "backward", prompt: { kind: "geometry", objects: frameZeroOnly } }))).toMatchObject({ detail: "Backward propagation needs a prompt after frame 0." });
    expect(await attempt(await geometryRequest({ prompt: { kind: "geometry", objects: [{ ...frameZeroOnly[0], prompts: [{ frame: 60, box: { x1: 1, y1: 1, x2: 9, y2: 9 } }] }] } }))).toMatchObject({ detail: "A SAM prompt frame lies outside the clip." });
    expect(await attempt(await geometryRequest({ propagation: "sideways" as never }))).toMatchObject({ code: "VIDEO_SEGMENTATION_INVALID" });
    expect(await attempt(await geometryRequest({ prompt: { kind: "concept", phrase: "cup <|box|>", label: "Synthetic cup" } }))).toMatchObject({ detail: "SAM video needs one short noun phrase without control tokens." });
    expect(await attempt(await geometryRequest({ prompt: { kind: "concept", phrase: "cup", label: "Synthetic cup" }, propagation: "backward" }))).toMatchObject({ detail: "Backward propagation needs a prompt after frame 0." });
    expect(await attempt(await geometryRequest({ prompt: { kind: "concept", phrase: "cup", label: "" } }))).toMatchObject({ code: "VIDEO_SEGMENTATION_INVALID" });
    expect(requestJson).not.toHaveBeenCalled();
    // Backward is allowed once some prompt lies after frame 0.
    const backward = await trackMetaVideo(await geometryRequest({ propagation: "backward" }), { client: { requestJson: vi.fn().mockResolvedValue(tracked()) }, ...await dirs() });
    expect(backward.set.propagation).toBe("backward");
  });

  test("concept prompts send only the noun phrase and label every returned object locally", async () => {
    const requestJson = vi.fn().mockResolvedValue(samResponse(samVideoWire([{ frame: 3, objects: [{ id: 0, box: { x1: 1, y1: 1, x2: 9, y2: 9 } }, { id: 12, box: { x1: 20, y1: 20, x2: 29, y2: 29 }, confidence: .4 }] }], size), { frames_billed: 50, frames_processed: 60 }));
    const result = await trackMetaVideo(await geometryRequest({ prompt: { kind: "concept", phrase: "  latte cup ", label: "Synthetic latte" } }), { client: { requestJson }, ...await dirs() });
    expect(requestJson.mock.calls[0][1].body.input[0].content[0]).toEqual({ type: "input_text", text: "latte cup" });
    expect(JSON.stringify(requestJson.mock.calls[0][1])).not.toContain("Synthetic");
    expect(result.set).toMatchObject({ promptKind: "concept", framesBilled: 50 });
    expect(result.set.objects.map(({ objectId, label, origin }) => ({ objectId, label, origin }))).toEqual([
      { objectId: "0", label: "Synthetic latte", origin: "concept_prompt" }, { objectId: "12", label: "Synthetic latte", origin: "concept_prompt" },
    ]);
    expect(result.unmatchedPromptIds).toEqual([]);
  });

  test("fails closed on refusals, extra lanes, parser diagnostics and incomplete envelopes", async () => {
    const lines = samVideoWire(trackFrames, size);
    const responses = [
      { ...samResponse(lines), status: "incomplete" },
      { ...samResponse(lines), output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] },
      { ...samResponse(lines), output: [{ type: "message", content: [{ type: "output_text", text: lines }, { type: "output_text", text: "" }] }] },
      samResponse(`${lines}\nfree text the model added`),
      samResponse(lines.replace(/(data=\d+,\d+,)![^|;]+/, "$1!00")), // undecodable one-bit payload (parser diagnostic)
    ];
    for (const response of responses) {
      const failure = await trackMetaVideo(await geometryRequest(), { client: { requestJson: vi.fn().mockResolvedValue(response) }, ...await dirs() }).catch((error) => error);
      expect(failure).toMatchObject({ code: "VIDEO_SEGMENTATION_INVALID", outcome: "unknown" });
      expect(getSamVideoDiagnostic(failure)).toMatchObject({ phase: "decode", completedResponseStored: true });
    }
  });

  test("records numeric usage generically and never invents a billed frame count", () => {
    expect(collectUsage({ frames_processed: 75, weird: "x", negative: -1, nested: { a: 1, deeper: { b: 2 } }, "bad key": 3 })).toEqual({ frames_processed: 75, "nested.a": 1 });
    expect(collectUsage(null)).toEqual({});
    expect(framesBilledFrom({ video_frames_processed: 80, input_tokens: 4 })).toBe(80);
    expect(framesBilledFrom({ sam_frame_units: 51 })).toBe(51);
    expect(framesBilledFrom({ a_frames: 1, b_frames: 2 })).toBeNull();
    expect(framesBilledFrom({ frames_processed: 12.5 })).toBeNull();
    expect(framesBilledFrom({ input_tokens: 4 })).toBeNull();
  });
});
