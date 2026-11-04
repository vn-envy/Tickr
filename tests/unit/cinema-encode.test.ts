import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CinemaEncodeError, openH264Encoder, probeVideo } from "../../lib/campaign/cinema/encode";

// Synthetic frames only: a moving gradient bar drawn in memory. No third-party media.
function syntheticFrame(width: number, height: number, index: number): Buffer {
  const frame = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    const bar = Math.abs(x - (index * 4) % width) < 6;
    frame[o] = bar ? 240 : (x * 255 / width) | 0; frame[o + 1] = (y * 255 / height) | 0; frame[o + 2] = bar ? 40 : 128; frame[o + 3] = 255;
  }
  return frame;
}

describe("local H.264 encoder", () => {
  let dir = "";
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "tickr-encode-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test("encodes exactly the expected frames, verifies with ffprobe and reports the file hash", async () => {
    const outputPath = join(dir, "synthetic.mp4");
    const encoder = openH264Encoder({ outputPath, width: 96, height: 64, fps: 30, expectedFrames: 45 });
    for (let i = 0; i < 45; i++) await encoder.writeFrame(syntheticFrame(96, 64, i));
    const result = await encoder.finish();
    const bytes = await readFile(outputPath);
    expect(result).toEqual({ frames: 45, durationSeconds: 1.5, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
    const probe = await probeVideo(outputPath);
    expect(probe).toMatchObject({ width: 96, height: 64, codec: "h264", frameRate: "30/1", frames: 45, audioStreams: 0 });
    expect((await readdir(dir)).filter((name) => name.includes("partial"))).toEqual([]);
  });

  test("a short stream fails its contract and leaves no partial output", async () => {
    const outputPath = join(dir, "short.mp4");
    const encoder = openH264Encoder({ outputPath, width: 64, height: 64, fps: 30, expectedFrames: 10 });
    for (let i = 0; i < 9; i++) await encoder.writeFrame(syntheticFrame(64, 64, i));
    await expect(encoder.finish()).rejects.toMatchObject({ code: "CONTRACT_MISMATCH" });
    expect(await readdir(dir)).not.toContain("short.mp4");
    expect((await readdir(dir)).filter((name) => name.includes("partial"))).toEqual([]);
  });

  test("rejects wrong-sized and surplus frames with fixed messages", async () => {
    const encoder = openH264Encoder({ outputPath: join(dir, "bad.mp4"), width: 64, height: 64, fps: 30, expectedFrames: 1 });
    const error = await encoder.writeFrame(Buffer.alloc(10)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CinemaEncodeError);
    expect((error as Error).message).toBe("The local video encoder rejected a frame.");
    expect((error as Error).message).not.toContain(dir);
    await expect(encoder.writeFrame(syntheticFrame(64, 64, 0))).rejects.toMatchObject({ code: "FRAME_REJECTED" });

    const surplus = openH264Encoder({ outputPath: join(dir, "surplus.mp4"), width: 64, height: 64, fps: 30, expectedFrames: 1 });
    await surplus.writeFrame(syntheticFrame(64, 64, 0));
    await expect(surplus.writeFrame(syntheticFrame(64, 64, 1))).rejects.toMatchObject({ code: "FRAME_REJECTED" });
    expect((await readdir(dir)).filter((name) => name.startsWith("bad") || name.startsWith("surplus") || name.includes("partial"))).toEqual([]);
  });

  test("abort kills the encoder and removes partial output", async () => {
    const encoder = openH264Encoder({ outputPath: join(dir, "aborted.mp4"), width: 64, height: 64, fps: 30, expectedFrames: 30 });
    await encoder.writeFrame(syntheticFrame(64, 64, 0));
    await encoder.abort();
    await encoder.abort();
    await expect(encoder.writeFrame(syntheticFrame(64, 64, 1))).rejects.toMatchObject({ code: "FRAME_REJECTED" });
    expect((await readdir(dir)).filter((name) => name.startsWith("aborted") || name.includes("partial"))).toEqual([]);
  });

  test("a timeout kills the encoder with a fixed error and leaves no partial output", async () => {
    const encoder = openH264Encoder({ outputPath: join(dir, "slow.mp4"), width: 64, height: 64, fps: 30, expectedFrames: 30, timeoutMs: 50 });
    await encoder.writeFrame(syntheticFrame(64, 64, 0));
    await delay(250);
    const error = await encoder.writeFrame(syntheticFrame(64, 64, 1)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CinemaEncodeError);
    expect(error).toMatchObject({ code: "TIMEOUT", message: "The local video encoder timed out." });
    await expect(encoder.finish()).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await readdir(dir)).filter((name) => name.startsWith("slow") || name.includes("partial"))).toEqual([]);
  });

  test("reports a missing FFmpeg as ENCODER_UNAVAILABLE without leaking paths", async () => {
    const empty = await mkdtemp(join(tmpdir(), "tickr-no-ffmpeg-"));
    const path = process.env.PATH;
    let encoder;
    try { process.env.PATH = empty; encoder = openH264Encoder({ outputPath: join(dir, "missing.mp4"), width: 64, height: 64, fps: 30, expectedFrames: 1 }); }
    finally { process.env.PATH = path; await rm(empty, { recursive: true, force: true }); }
    const written = await encoder.writeFrame(syntheticFrame(64, 64, 0)).then(() => null, (caught: unknown) => caught);
    const error = written ?? await encoder.finish().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "ENCODER_UNAVAILABLE" });
    expect((error as Error).message).not.toContain(dir);
    expect((await readdir(dir)).filter((name) => name.startsWith("missing") || name.includes("partial"))).toEqual([]);
  });

  test("validates the request before spawning anything", () => {
    for (const options of [
      { outputPath: "relative.mp4", width: 64, height: 64, fps: 30, expectedFrames: 1 },
      { outputPath: join(dir, "odd.mp4"), width: 63, height: 64, fps: 30, expectedFrames: 1 },
      { outputPath: join(dir, "zero.mp4"), width: 64, height: 64, fps: 0, expectedFrames: 1 },
      { outputPath: join(dir, "wrong.mov"), width: 64, height: 64, fps: 30, expectedFrames: 1 },
      // Untyped configuration: only the fixed preset names reach FFmpeg.
      { outputPath: join(dir, "preset.mp4"), width: 64, height: 64, fps: 30, expectedFrames: 1, preset: "veryslow -x264opts" as never },
      { outputPath: join(dir, "timeout.mp4"), width: 64, height: 64, fps: 30, expectedFrames: 1, timeoutMs: 0 },
    ]) expect(() => openH264Encoder(options)).toThrow("The local video encoder received an invalid request.");
  });
});
