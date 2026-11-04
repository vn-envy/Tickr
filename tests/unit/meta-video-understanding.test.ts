import type { MetaClient } from "../../lib/meta/client";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { NormalizedClip } from "../../lib/media/cinema-types";
import { analyzeClipShots, frameIndexAt, getShotLogDiagnostic, secondsAtFrame, type ShotLogRequest } from "../../lib/meta/video-understanding";

// SYNTHETIC fixtures only: the "clip" is a minimal ftyp-headed byte buffer, never real footage.
const directories: string[] = [];
async function directory() { const value = await mkdtemp(join(tmpdir(), "tickr-spark-shotlog-")); directories.push(value); return value; }
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function syntheticMp4(size = 4096): Buffer {
  const bytes = Buffer.alloc(size, 7);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftypisom", 4, "latin1");
  return bytes;
}
async function clipRequest(overrides: Partial<NormalizedClip> = {}, bytes = syntheticMp4()): Promise<ShotLogRequest> {
  const root = await directory();
  const path = join(root, "synthetic-clip.mp4");
  await writeFile(path, bytes);
  const clip: NormalizedClip = {
    version: 1, id: "synthetic-clip", sha256: createHash("sha256").update(bytes).digest("hex"), path, width: 720, height: 1280, fps: 30, frameCount: 180, durationSeconds: 6,
    posterPath: join(root, "poster.png"), audioPath: null,
    original: { bytes: bytes.length, sha256: "0".repeat(64), container: "mp4", videoCodec: "h264", durationSeconds: 6, width: 720, height: 1280 },
    provenance: "owner_upload", consent: { ownsOrLicensedMedia: true, peopleVisibleHaveConsented: "no_people", attestedAt: "2026-11-04T08:00:00.000Z" },
    createdAt: "2026-11-04T08:00:00.000Z", ...overrides,
  };
  return { clip, goal: "Show our latte art to weekday commuters", business: { name: "Synthetic Cafe", category: "cafe" }, offerings: [{ offeringId: "latte", name: "Latte" }] };
}
type Moment = Record<string, unknown>;
const moment = (startSeconds: number, endSeconds: number, overrides: Moment = {}): Moment => ({
  startSeconds, endSeconds, kind: "hero_product", description: "A cup on a counter", steadiness: "steady", subjectLabel: "latte cup", goalFit: "strong", ...overrides,
});
function shotLog(overrides: Record<string, unknown> = {}) {
  return { moments: [moment(0.5, 2)], heroMomentSeconds: 1.2, peopleVisible: true, speech: { present: false, excerpt: null, language: null }, ...overrides };
}
function sparkResponse(output: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: "resp_synthetic_shotlog", model: "muse-spark-1.3", status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
    usage: { input_tokens: 9000, output_tokens: 400, total_tokens: 9400 }, ...extra,
  };
}
function client(response: unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  const requestJson = vi.fn(async (_path: string, init?: { body?: Record<string, unknown> }) => { bodies.push(init!.body!); return response; });
  // The fake returns whatever the test supplies; type it as the generic client method for the adapter seam.
  return { requestJson: requestJson as typeof requestJson & MetaClient["requestJson"], bodies };
}

describe("frame helpers", () => {
  test("round(t × fps) clamped to the clip, and the inverse", () => {
    expect(frameIndexAt(0, 30, 180)).toBe(0);
    expect(frameIndexAt(1.2, 30, 180)).toBe(36);
    expect(frameIndexAt(1.016, 30, 180)).toBe(30);
    expect(frameIndexAt(1.017, 30, 180)).toBe(31);
    expect(frameIndexAt(6, 30, 180)).toBe(179);
    expect(frameIndexAt(-1, 30, 180)).toBe(0);
    expect(secondsAtFrame(45, 30)).toBe(1.5);
    expect(() => frameIndexAt(Number.NaN, 30, 180)).toThrow();
    expect(() => frameIndexAt(1, 0, 180)).toThrow();
    expect(() => secondsAtFrame(-1, 30)).toThrow();
  });
});

describe("Muse Spark shot log", () => {
  test("sends the verified clip inline as input_video with strict structured output", async () => {
    const request = await clipRequest();
    const fake = client(sparkResponse(shotLog()));
    await analyzeClipShots(request, { client: fake, responseDirectory: await directory(), environment: {} });
    const body = fake.bodies[0] as { model: string; instructions: string; store: boolean; input: Array<{ content: Array<Record<string, string>> }>; text: { format: Record<string, unknown> } };
    expect(body).toMatchObject({ model: "muse-spark-1.3", store: false, text: { format: { type: "json_schema", name: "tickr_shot_log", strict: true } } });
    expect((body.text.format.schema as { additionalProperties: boolean }).additionalProperties).toBe(false);
    expect(body.instructions).toContain("UNTRUSTED DATA");
    const content = body.input[0].content;
    expect(content.map((part) => part.type)).toEqual(["input_text", "input_text", "input_video"]);
    expect(content[0].text).toContain("untrusted data");
    expect(content[1].text).toContain("6.000 seconds");
    expect(content[2].video_url.startsWith("data:video/mp4;base64,")).toBe(true);
    expect(Buffer.from(content[2].video_url.split(",")[1], "base64").equals(await readFile(request.clip.path))).toBe(true);
  });

  test("validates, clamps and sorts moment times and derives frame indices", async () => {
    const fake = client(sparkResponse(shotLog({
      moments: [
        moment(4, 6.03, { kind: "ambience", subjectLabel: null, steadiness: "moderate" }),
        moment(3, 2),
        moment(-0.5, 1),
        moment(2, 2),
        moment(5, 7),
        moment(0.5, 2, { subjectLabel: "cup <|point|>", description: `${"steam rising ".repeat(40)}` }),
        moment(0.5, 1.5, { kind: "hands", goalFit: "moderate" }),
        moment(2.5, 2.54),
      ],
      heroMomentSeconds: 9,
      speech: { present: true, excerpt: "  Welcome to   the cafe ", language: "en-GB" },
    })));
    const log = await analyzeClipShots(await clipRequest(), { client: fake, responseDirectory: await directory(), environment: {} });
    expect(log.moments.map(({ startSeconds, endSeconds, startFrame, endFrame, kind }) => ({ startSeconds, endSeconds, startFrame, endFrame, kind }))).toEqual([
      { startSeconds: 0.5, endSeconds: 1.5, startFrame: 15, endFrame: 45, kind: "hands" },
      { startSeconds: 0.5, endSeconds: 2, startFrame: 15, endFrame: 60, kind: "hero_product" },
      { startSeconds: 2.5, endSeconds: 2.54, startFrame: 75, endFrame: 76, kind: "hero_product" },
      { startSeconds: 4, endSeconds: 6, startFrame: 120, endFrame: 179, kind: "ambience" },
    ]);
    expect(log.droppedMoments).toBe(4);
    expect(log.moments[1].subjectLabel).toBeNull();
    expect(log.moments[1].description.length).toBeLessThanOrEqual(200);
    expect(log.moments[3]).toMatchObject({ steadiness: "moderate", subjectLabel: null });
    expect(log).toMatchObject({
      version: "spark-shotlog-1", clipId: "synthetic-clip", heroMomentSeconds: null, heroMomentFrame: null, peopleVisible: true,
      speech: { present: true, excerpt: "Welcome to the cafe", excerptKind: "owner_audio_model_transcription", verified: false, language: "en-GB" },
      responseId: "resp_synthetic_shotlog", usage: { inputTokens: 9000, outputTokens: 400, totalTokens: 9400 },
      provenance: { kind: "spark_media_observation", semanticIdentityVerified: false, requiresReview: true },
    });
  });

  test("keeps a valid hero moment, drops speech text when no speech is present and rejects odd language codes", async () => {
    const fake = client(sparkResponse(shotLog({ heroMomentSeconds: 1.2, speech: { present: false, excerpt: "invented", language: "en" } })));
    const log = await analyzeClipShots(await clipRequest(), { client: fake, responseDirectory: await directory(), environment: {} });
    expect(log).toMatchObject({ heroMomentSeconds: 1.2, heroMomentFrame: 36, speech: { present: false, excerpt: null, language: null } });
    const odd = client(sparkResponse(shotLog({ speech: { present: true, excerpt: "Hi", language: "english please" } })));
    expect((await analyzeClipShots(await clipRequest(), { client: odd, responseDirectory: await directory(), environment: {} })).speech.language).toBeNull();
  });

  test("rejects unverifiable clips before any paid request", async () => {
    const fake = client(sparkResponse(shotLog()));
    const responseDirectory = await directory();
    const tampered = await clipRequest();
    await writeFile(tampered.clip.path, syntheticMp4(4097));
    const linked = await clipRequest();
    const link = join(await directory(), "linked.mp4");
    await symlink(linked.clip.path, link);
    const big = syntheticMp4(20 * 1024 * 1024 + 1);
    const cases: ShotLogRequest[] = [
      tampered,
      { ...linked, clip: { ...linked.clip, path: link } },
      await clipRequest({}, big),
      await clipRequest({}, Buffer.alloc(64, 1)),
      await clipRequest({ consent: { ownsOrLicensedMedia: false, peopleVisibleHaveConsented: "no_people", attestedAt: "2026-11-04T08:00:00.000Z" } }),
      await clipRequest({ frameCount: 400 }),
      await clipRequest({ path: "relative/clip.mp4" }),
      { ...(await clipRequest()), goal: "" },
      { ...(await clipRequest()), offerings: Array.from({ length: 13 }, (_, index) => ({ offeringId: `o${index}`, name: "Item" })) },
    ];
    for (const request of cases) {
      const failure = await analyzeClipShots(request, { client: fake, responseDirectory, environment: {} }).catch((error: unknown) => error);
      expect(getShotLogDiagnostic(failure)).toMatchObject({ code: "SPARK_SHOTLOG_INVALID", completedResponseStored: false });
      expect(getShotLogDiagnostic(failure).detail).not.toContain(tmpdir());
    }
    await expect(analyzeClipShots(await clipRequest(), { client: fake, model: "muse-spark-1.3-contributor", responseDirectory, environment: {} })).rejects.toMatchObject({ code: "MODEL_NOT_ALLOWED" });
    expect(fake.requestJson).not.toHaveBeenCalled();
  });

  test("recovers offline without re-reading the clip and binds the record to the inputs", async () => {
    const responseDirectory = await directory();
    const request = await clipRequest();
    const fake = client(sparkResponse(shotLog()));
    const first = await analyzeClipShots(request, { client: fake, responseDirectory, environment: {} });
    await unlink(request.clip.path);
    expect(await analyzeClipShots(request, { responseDirectory, environment: {} })).toEqual(first);
    await expect(analyzeClipShots({ ...request, goal: "Different goal" }, { client: fake, responseDirectory, environment: {} })).rejects.toMatchObject({ code: "SPARK_SHOTLOG_CHECKPOINT_INVALID" });
    expect(fake.requestJson).toHaveBeenCalledTimes(1);
  });

  test("stores undecodable output, never re-requests, and an uncertain call stays pending", async () => {
    const responseDirectory = await directory();
    const raw = sparkResponse({ moments: "not an array" });
    const fake = client(raw);
    const failure = await analyzeClipShots(await clipRequest(), { client: fake, responseDirectory, environment: {} }).catch((error: unknown) => error);
    expect(getShotLogDiagnostic(failure)).toMatchObject({ phase: "decode", code: "SPARK_SHOTLOG_INVALID", completedResponseStored: true, responseId: "resp_synthetic_shotlog" });
    expect(JSON.parse(await readFile(join(responseDirectory, "spark-shotlog-response.json"), "utf8")).response).toEqual(raw);

    const pendingDirectory = await directory();
    const request = await clipRequest();
    const requestJson = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(analyzeClipShots(request, { client: { requestJson }, responseDirectory: pendingDirectory, environment: {} })).rejects.toBeDefined();
    await expect(analyzeClipShots(request, { client: { requestJson }, responseDirectory: pendingDirectory, environment: {} })).rejects.toMatchObject({ code: "SPARK_SHOTLOG_PENDING" });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });
});
