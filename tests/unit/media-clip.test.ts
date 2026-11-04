import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { NormalizedClip, OwnerMediaConsent } from "../../lib/media/cinema-types";
import {
  chooseClipWindow, extractClipFramePng, normalizeOwnerClip, OwnerClipError, probeMedia, readClipFrames, verifyNormalizedClip, videoDynamicRange,
} from "../../lib/media/clip";

// Every input here is synthetic: FFmpeg lavfi test patterns and sine tones generated locally.
const run = promisify(execFile);
const consent: OwnerMediaConsent = { ownsOrLicensedMedia: true, peopleVisibleHaveConsented: "no_people", attestedAt: "2026-11-04T00:00:00.000Z" };
let root = "";
const fixture = (name: string) => join(root, "fixtures", name);

async function synth(name: string, args: string[]) {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args, fixture(name)], { timeout: 120_000 });
}
const pattern = (size: string, rate: number, seconds: number) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`];
const tone = (seconds: number) => ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${seconds}`];
const x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
/** 10-bit HEVC with HDR colour tags, like recent phone footage (synthetic pattern, not real HDR content). */
const hdrHevc = (transfer: "arib-std-b67" | "smpte2084") => [
  "-vf", "format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast", "-tag:v", "hvc1",
  "-x265-params", `log-level=error:colorprim=bt2020:transfer=${transfer}:colormatrix=bt2020nc`,
  "-color_primaries", "bt2020", "-color_trc", transfer, "-colorspace", "bt2020nc",
];
const SDR_709 = { colorPrimaries: "bt709", colorTransfer: "bt709", colorSpace: "bt709", colorRange: "tv" };
let outputCount = 0;
const outputDir = () => join(root, "out", String(outputCount++));

async function expectClipError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(OwnerClipError);
  expect((error as OwnerClipError).code).toBe(code);
  expect((error as Error).message).not.toContain(root);
  expect((error as Error).message).not.toMatch(/\/tmp|fixtures/);
}

/** Live ffmpeg children of this test process (Linux /proc). Zombies count too: they would be unreaped. */
async function ffmpegChildren(): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const statLine = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
    const match = /^\d+ \((.*)\) (\S) (\d+)/.exec(statLine);
    if (match && match[1] === "ffmpeg" && Number(match[3]) === process.pid) found.push(`${entry}:${match[2]}`);
  }
  return found;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tickr-clip-"));
  await run("mkdir", ["-p", join(root, "fixtures"), join(root, "out")]);
  await Promise.all([
    synth("synthetic-gps.mp4", [
      ...pattern("320x240", 25, 3), ...tone(3), ...x264, "-c:a", "aac",
      "-metadata", "location=+48.8584+002.2945/", "-metadata", "creation_time=2024-01-01T00:00:00Z", "-metadata", "title=Synthetic owner clip",
      "-metadata:s:v:0", "creation_time=2024-01-01T00:00:00Z", "-metadata:s:v:0", "location=+48.8584+002.2945/",
    ]),
    synth("synthetic-base.mp4", [...pattern("320x240", 30, 2), ...x264]),
    synth("synthetic-vp9.webm", [...pattern("256x144", 24, 2), "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k"]),
    synth("synthetic-long.mp4", [...pattern("160x120", 30, 30), ...x264]),
    synth("synthetic-too-long.mp4", [...pattern("64x64", 1, 181), ...x264]),
    synth("synthetic-large.mp4", [...pattern("1922x1082", 30, 1), ...x264]),
    synth("synthetic-still.png", [...pattern("128x128", 1, 1), "-frames:v", "1"]),
    synth("synthetic-anim.gif", [...pattern("96x96", 10, 1)]),
    synth("synthetic-audio.m4a", [...tone(2), "-c:a", "aac"]),
  ]);
  await Promise.all([
    synth("synthetic-hlg.mov", [...pattern("320x240", 30, 1), ...hdrHevc("arib-std-b67")]),
    synth("synthetic-pq.mp4", [...pattern("320x240", 30, 1), ...hdrHevc("smpte2084")]),
    synth("synthetic-bt2020-sdr.mp4", [
      ...pattern("320x240", 30, 1), "-vf", "format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast", "-tag:v", "hvc1",
      "-x265-params", "log-level=error:colorprim=bt2020:transfer=bt2020-10:colormatrix=bt2020nc",
      "-color_primaries", "bt2020", "-color_trc", "bt2020-10", "-colorspace", "bt2020nc",
    ]),
  ]);
  await synth("synthetic-rotated.mp4", ["-display_rotation", "90", "-i", fixture("synthetic-base.mp4"), "-c", "copy"]);
  // Browser MediaRecorder-style WebM: written to a non-seekable pipe, so no duration is recorded anywhere.
  const { stdout: live } = await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", ...pattern("256x144", 30, 2),
    "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k", "-f", "webm", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
  await writeFile(fixture("synthetic-live.webm"), live);
}, 180_000);

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("chooseClipWindow", () => {
  test("keeps short clips whole and starts at zero without a hero moment", () => {
    expect(chooseClipWindow(8, null, 12)).toEqual({ startSeconds: 0, durationSeconds: 8 });
    expect(chooseClipWindow(30, null, 12)).toEqual({ startSeconds: 0, durationSeconds: 12 });
  });

  test("centres the window on the hero moment and keeps it inside the clip", () => {
    expect(chooseClipWindow(30, 15, 12)).toEqual({ startSeconds: 9, durationSeconds: 12 });
    expect(chooseClipWindow(30, 2, 12)).toEqual({ startSeconds: 0, durationSeconds: 12 });
    expect(chooseClipWindow(30, 29, 12)).toEqual({ startSeconds: 18, durationSeconds: 12 });
    expect(chooseClipWindow(10.5, 5, 20)).toEqual({ startSeconds: 0, durationSeconds: 10.5 });
  });

  test("rejects invalid durations, windows and hero moments", () => {
    expect(() => chooseClipWindow(0, null, 12)).toThrow(OwnerClipError);
    expect(() => chooseClipWindow(10, null, 21)).toThrow(OwnerClipError);
    expect(() => chooseClipWindow(10, Number.NaN, 12)).toThrow(OwnerClipError);
    expect(() => chooseClipWindow(10, -1, 12)).toThrow(OwnerClipError);
  });
});

describe("normalizeOwnerClip", () => {
  test("rejects missing or incomplete consent before touching the file", async () => {
    const missing = join(root, "does-not-exist.mp4");
    await expectClipError(normalizeOwnerClip({ sourcePath: missing, outputDir: outputDir(), consent: { ...consent, ownsOrLicensedMedia: false } }), "CONSENT_REQUIRED");
    await expectClipError(normalizeOwnerClip({ sourcePath: missing, outputDir: outputDir(), consent: { ...consent, peopleVisibleHaveConsented: false } }), "CONSENT_REQUIRED");
    await expectClipError(normalizeOwnerClip({ sourcePath: missing, outputDir: outputDir(), consent: undefined as unknown as OwnerMediaConsent }), "CONSENT_REQUIRED");
    // With valid consent the same request reaches the file system and fails there instead.
    await expectClipError(normalizeOwnerClip({ sourcePath: missing, outputDir: outputDir(), consent }), "SOURCE_UNREADABLE");
    await expectClipError(normalizeOwnerClip({ sourcePath: "relative.mp4", outputDir: outputDir(), consent }), "INVALID_REQUEST");
  });

  test("strips location and creation-time metadata, normalizes to 30 fps H.264 and keeps owner audio privately", async () => {
    const source = await probeMedia(fixture("synthetic-gps.mp4"));
    expect(source.tags.location).toBeDefined();
    expect(source.tags.creation_time).toBeDefined();

    const dir = outputDir();
    const clip = await normalizeOwnerClip({ sourcePath: fixture("synthetic-gps.mp4"), outputDir: dir, consent, provenance: "owner_upload" });
    expect(clip).toMatchObject({
      version: 1, width: 320, height: 240, fps: 30, frameCount: 90, durationSeconds: 3, provenance: "owner_upload", consent,
      original: { container: "mp4", videoCodec: "h264", width: 320, height: 240 },
    });
    expect(clip.original.durationSeconds).toBeCloseTo(3, 1);
    expect(clip.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(clip.path.startsWith(dir)).toBe(true);
    expect((await stat(clip.path)).mode & 0o777).toBe(0o600);

    const output = await probeMedia(clip.path);
    expect(output.streams).toHaveLength(1);
    expect(output.video).toMatchObject({ codec: "h264", pixelFormat: "yuv420p", frameRate: "30/1", frameCount: 90, rotation: 0, hasRotationMetadata: false });
    for (const tags of [output.tags, output.video!.tags]) {
      expect(Object.keys(tags).filter((key) => /location|creation_time|title|gps/i.test(key))).toEqual([]);
    }
    const bytes = await readFile(clip.path);
    expect(bytes.includes(Buffer.from("+48.8584"))).toBe(false);
    expect(bytes.includes(Buffer.from("Synthetic owner clip"))).toBe(false);

    expect(clip.audioPath).not.toBeNull();
    const audio = await probeMedia(clip.audioPath!);
    expect(audio).toMatchObject({ formatName: "wav", audio: { codec: "pcm_s16le", sampleRate: 16000, channels: 1 } });
    expect(audio.durationSeconds).toBeCloseTo(3, 1);
    expect(Object.keys(audio.tags).filter((key) => key !== "encoder")).toEqual([]);

    const poster = await sharp(clip.posterPath).metadata();
    expect(poster).toMatchObject({ format: "png", width: 320, height: 240 });
    await expect(verifyNormalizedClip(clip)).resolves.toBeUndefined();
  }, 60_000);

  test("applies display rotation so the output is upright and carries no rotation side data", async () => {
    const source = await probeMedia(fixture("synthetic-rotated.mp4"));
    expect(source.video?.hasRotationMetadata).toBe(true);
    expect(source.video?.rotation).toBe(270);

    const clip = await normalizeOwnerClip({ sourcePath: fixture("synthetic-rotated.mp4"), outputDir: outputDir(), consent });
    expect(clip).toMatchObject({ width: 240, height: 320, frameCount: 60, audioPath: null, original: { width: 240, height: 320 } });
    const output = await probeMedia(clip.path);
    expect(output.video).toMatchObject({ width: 240, height: 320, rotation: 0, hasRotationMetadata: false });
    expect(await sharp(clip.posterPath).metadata()).toMatchObject({ width: 240, height: 320 });
    await verifyNormalizedClip(clip);
  }, 60_000);

  test("accepts WebM VP9 without audio", async () => {
    const clip = await normalizeOwnerClip({ sourcePath: fixture("synthetic-vp9.webm"), outputDir: outputDir(), consent, id: "owner-vp9" });
    expect(clip).toMatchObject({ id: "owner-vp9", width: 256, height: 144, fps: 30, frameCount: 60, audioPath: null, original: { container: "matroska_webm", videoCodec: "vp9" } });
    expect(clip.path.endsWith("owner-vp9.mp4")).toBe(true);
    await verifyNormalizedClip(clip);
  }, 60_000);

  test("downscales the long side to 1280 with even dimensions and never upscales", async () => {
    const clip = await normalizeOwnerClip({ sourcePath: fixture("synthetic-large.mp4"), outputDir: outputDir(), consent });
    expect(clip).toMatchObject({ width: 1280, height: 720, frameCount: 30, original: { width: 1922, height: 1082 } });
  }, 60_000);

  test("trims a long clip to the default 12 s window or a chosen start", async () => {
    const whole = await normalizeOwnerClip({ sourcePath: fixture("synthetic-long.mp4"), outputDir: outputDir(), consent });
    expect(whole).toMatchObject({ frameCount: 360, durationSeconds: 12 });
    expect(whole.original.durationSeconds).toBeCloseTo(30, 1);

    const tail = await normalizeOwnerClip({ sourcePath: fixture("synthetic-long.mp4"), outputDir: outputDir(), consent, startSeconds: 25, maxSeconds: 10 });
    expect(tail).toMatchObject({ frameCount: 150, durationSeconds: 5 });
    expect(tail.id).not.toBe(whole.id);
    await expectClipError(normalizeOwnerClip({ sourcePath: fixture("synthetic-long.mp4"), outputDir: outputDir(), consent, maxSeconds: 25 }), "INVALID_REQUEST");
    await expectClipError(normalizeOwnerClip({ sourcePath: fixture("synthetic-long.mp4"), outputDir: outputDir(), consent, startSeconds: 31 }), "INVALID_REQUEST");
  }, 90_000);

  test("rejects inputs longer than 180 s, still images, GIFs and audio-only files", async () => {
    const dir = outputDir();
    await expectClipError(normalizeOwnerClip({ sourcePath: fixture("synthetic-too-long.mp4"), outputDir: dir, consent }), "SOURCE_TOO_LONG");
    await expectClipError(normalizeOwnerClip({ sourcePath: fixture("synthetic-still.png"), outputDir: dir, consent }), "UNSUPPORTED_MEDIA");
    await expectClipError(normalizeOwnerClip({ sourcePath: fixture("synthetic-anim.gif"), outputDir: dir, consent }), "UNSUPPORTED_MEDIA");
    await expectClipError(normalizeOwnerClip({ sourcePath: fixture("synthetic-audio.m4a"), outputDir: dir, consent }), "NO_VIDEO_STREAM");
    await writeFile(join(root, "fixtures", "synthetic-garbage.mp4"), Buffer.from("not a video at all"));
    await expectClipError(normalizeOwnerClip({ sourcePath: fixture("synthetic-garbage.mp4"), outputDir: dir, consent }), "UNSUPPORTED_MEDIA");
    // Nothing is written for rejected inputs.
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  }, 60_000);

  test("tone-maps HLG and PQ HDR footage to BT.709 SDR and tags the output as BT.709", async () => {
    for (const name of ["synthetic-hlg.mov", "synthetic-pq.mp4"]) {
      const source = await probeMedia(fixture(name));
      expect(source.video).toMatchObject({ codec: "hevc", pixelFormat: "yuv420p10le", colorPrimaries: "bt2020", colorSpace: "bt2020nc" });
      expect(videoDynamicRange(source.video!)).toBe("hdr");

      const clip = await normalizeOwnerClip({ sourcePath: fixture(name), outputDir: outputDir(), consent });
      expect(clip).toMatchObject({ width: 320, height: 240, frameCount: 30, original: { videoCodec: "hevc" } });
      const output = await probeMedia(clip.path);
      expect(output.video).toMatchObject({ codec: "h264", pixelFormat: "yuv420p", ...SDR_709, sideDataTypes: [] });
      expect(videoDynamicRange(output.video!)).toBe("sdr");
      await verifyNormalizedClip(clip);
      // The tone-mapped poster is a normal, non-empty SDR picture.
      const stats = await sharp(clip.posterPath).stats();
      expect(stats.channels.slice(0, 3).every((channel) => channel.mean > 10 && channel.mean < 245 && channel.stdev > 10)).toBe(true);
    }
  }, 90_000);

  test("converts BT.2020 SDR to BT.709", async () => {
    const source = await probeMedia(fixture("synthetic-bt2020-sdr.mp4"));
    expect(videoDynamicRange(source.video!)).toBe("wide_gamut_sdr");
    const clip = await normalizeOwnerClip({ sourcePath: fixture("synthetic-bt2020-sdr.mp4"), outputDir: outputDir(), consent });
    expect((await probeMedia(clip.path)).video).toMatchObject(SDR_709);
    await verifyNormalizedClip(clip);
  }, 60_000);

  test("measures browser-recorded WebM without a recorded duration from its packets", async () => {
    const source = await probeMedia(fixture("synthetic-live.webm"));
    expect(source.durationSeconds).toBeNull();
    expect(source.video?.durationSeconds).toBeNull();
    const clip = await normalizeOwnerClip({ sourcePath: fixture("synthetic-live.webm"), outputDir: outputDir(), consent });
    expect(clip).toMatchObject({ width: 256, height: 144, frameCount: 60, original: { container: "matroska_webm", videoCodec: "vp9" } });
    expect(clip.original.durationSeconds).toBeCloseTo(2, 1);
    await verifyNormalizedClip(clip);
  }, 60_000);

  test("rejects a symlinked source", async () => {
    const link = join(root, "fixtures", "synthetic-link.mp4");
    await symlink(fixture("synthetic-base.mp4"), link);
    await expectClipError(normalizeOwnerClip({ sourcePath: link, outputDir: outputDir(), consent }), "SOURCE_UNREADABLE");
  });

  test("fails with OUTPUT_TOO_LARGE above the output cap and leaves no partial files", async () => {
    const dir = outputDir();
    await expectClipError(normalizeOwnerClip({ sourcePath: fixture("synthetic-gps.mp4"), outputDir: dir, consent }, { maxOutputBytes: 2_000 }), "OUTPUT_TOO_LARGE");
    expect(await readdir(dir)).toEqual([]);
    await expectClipError(normalizeOwnerClip({ sourcePath: fixture("synthetic-gps.mp4"), outputDir: dir, consent }, { maxOutputBytes: 25 * 1024 * 1024 }), "INVALID_REQUEST");
  }, 60_000);

  test("detects a source that changed during normalization and leaves no partial files", async () => {
    const source = join(root, "fixtures", "synthetic-changing.mp4");
    await copyFile(fixture("synthetic-gps.mp4"), source);
    const dir = outputDir();
    await expectClipError(normalizeOwnerClip({ sourcePath: source, outputDir: dir, consent }, {
      beforeCommit: async () => { await appendFile(source, Buffer.alloc(16)); },
    }), "SOURCE_CHANGED");
    expect(await readdir(dir)).toEqual([]);
  }, 60_000);

  test("a failed re-run never deletes or replaces a clip an earlier run wrote under the same id", async () => {
    const dir = outputDir();
    const first = await normalizeOwnerClip({ sourcePath: fixture("synthetic-gps.mp4"), outputDir: dir, consent });
    const files = (await readdir(dir)).sort();
    expect(files).toEqual([`${first.id}.mp4`, `${first.id}.owner-audio.wav`, `${first.id}.poster.png`]);

    let reached = false;
    await expectClipError(normalizeOwnerClip({ sourcePath: fixture("synthetic-gps.mp4"), outputDir: dir, consent }, {
      beforeCommit: async () => {
        reached = true;
        // Every new output exists only as a hidden temp file at this point.
        expect((await readdir(dir)).filter((name) => name.startsWith(`.${first.id}.`))).toHaveLength(3);
        throw new Error("synthetic failure /private/path");
      },
    }), "TRANSCODE_FAILED");
    expect(reached).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(files);
    await verifyNormalizedClip(first);

    // A successful re-run of the same request replaces the files with identical content.
    const again = await normalizeOwnerClip({ sourcePath: fixture("synthetic-gps.mp4"), outputDir: dir, consent });
    expect(again).toMatchObject({ id: first.id, path: first.path, posterPath: first.posterPath, audioPath: first.audioPath });
    expect((await readdir(dir)).sort()).toEqual(files);
    await verifyNormalizedClip(again);
  }, 90_000);
});

describe("clip frame access", () => {
  let clip: NormalizedClip;
  beforeAll(async () => {
    clip = await normalizeOwnerClip({ sourcePath: fixture("synthetic-long.mp4"), outputDir: outputDir(), consent, maxSeconds: 4 });
  }, 60_000);

  test("reads exactly frameCount RGBA frames of the exact size", async () => {
    expect(clip.frameCount).toBe(120);
    const indices: number[] = [];
    for await (const frame of readClipFrames(clip)) {
      expect(frame).toMatchObject({ width: 160, height: 120 });
      expect(frame.rgba.length).toBe(160 * 120 * 4);
      indices.push(frame.frame);
    }
    expect(indices).toEqual(Array.from({ length: 120 }, (_, index) => index));
  }, 60_000);

  test("reads a scaled sub-range", async () => {
    const frames = [];
    for await (const frame of readClipFrames(clip, { fromFrame: 10, toFrame: 14, width: 80, height: 60 })) frames.push(frame);
    expect(frames.map((frame) => frame.frame)).toEqual([10, 11, 12, 13, 14]);
    expect(frames.every((frame) => frame.rgba.length === 80 * 60 * 4)).toBe(true);
    // Distinct frames of an animated test pattern decode to distinct pixels.
    expect(frames[0].rgba.equals(frames[4].rgba)).toBe(false);
  }, 30_000);

  test("rejects out-of-range and oversized requests", async () => {
    const drain = async (options: Parameters<typeof readClipFrames>[1]) => { for await (const frame of readClipFrames(clip, options)) void frame; };
    await expectClipError(drain({ fromFrame: 0, toFrame: 120 }), "INVALID_REQUEST");
    await expectClipError(drain({ fromFrame: 5, toFrame: 4 }), "INVALID_REQUEST");
    await expectClipError(drain({ width: 5000, height: 10 }), "INVALID_REQUEST");
  });

  test("kills and reaps FFmpeg when the consumer stops early", async () => {
    let seen = 0;
    let runningDuringRead: string[] = [];
    for await (const frame of readClipFrames(clip, { width: 640, height: 480 })) {
      expect(frame.rgba.length).toBe(640 * 480 * 4);
      seen += 1;
      if (seen === 2) {
        runningDuringRead = await ffmpegChildren();
        break;
      }
    }
    expect(seen).toBe(2);
    if (process.platform === "linux") {
      expect(runningDuringRead.length).toBe(1);
      expect(await ffmpegChildren()).toEqual([]);
    }
  }, 30_000);

  test("times out, kills and reaps FFmpeg when decoding stalls", async () => {
    if (process.platform === "win32") return;
    // A FIFO with no writer blocks FFmpeg's open() indefinitely: a deterministic stalled decoder.
    const fifo = join(root, "stalled.fifo");
    await run("mkfifo", [fifo]);
    const started = Date.now();
    const drain = async () => { for await (const frame of readClipFrames({ ...clip, path: fifo }, { idleTimeoutMs: 150 })) void frame; };
    const error = await drain().then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(OwnerClipError);
    expect(error).toMatchObject({ code: "FRAME_READ_FAILED", message: "Clip frame decoding timed out." });
    expect(Date.now() - started).toBeLessThan(5_000);
    if (process.platform === "linux") expect(await ffmpegChildren()).toEqual([]);
  }, 30_000);

  test("extracts one frame as a PNG at the clip size or a bounded long side", async () => {
    const full = await sharp(await extractClipFramePng(clip, 0)).metadata();
    expect(full).toMatchObject({ format: "png", width: 160, height: 120, channels: 3 });
    const small = await sharp(await extractClipFramePng(clip, 119, { maxSide: 64 })).metadata();
    expect(small).toMatchObject({ width: 64, height: 48 });
    const noUpscale = await sharp(await extractClipFramePng(clip, 3, { maxSide: 1024 })).metadata();
    expect(noUpscale).toMatchObject({ width: 160, height: 120 });
    await expectClipError(extractClipFramePng(clip, 120), "INVALID_REQUEST");
  }, 30_000);

  test("verification detects changed clip bytes", async () => {
    await verifyNormalizedClip(clip);
    const copy = join(root, "tampered.mp4");
    await copyFile(clip.path, copy);
    const bytes = await readFile(copy);
    bytes[bytes.length - 10] ^= 0xff;
    await writeFile(copy, bytes);
    await expectClipError(verifyNormalizedClip({ ...clip, path: copy }), "VERIFICATION_FAILED");
    await expectClipError(verifyNormalizedClip({ ...clip, frameCount: clip.frameCount + 5 }), "VERIFICATION_FAILED");
  }, 30_000);

  test("verification rejects a clip tagged as HDR / BT.2020", async () => {
    // Same pixels, but the H.264 VUI now claims BT.2020 primaries, HLG transfer and the BT.2020 matrix.
    const remux = async (name: string, bsf: string[]) => {
      const path = join(root, name);
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", clip.path, "-map", "0:v:0", "-c", "copy", "-map_metadata", "-1", ...bsf, path], { timeout: 60_000 });
      return { ...clip, path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") };
    };
    // Control: a plain remux of the same stream still meets the contract.
    await verifyNormalizedClip(await remux("plain-remux.mp4", []));
    const tagged = await remux("hlg-tagged.mp4", ["-bsf:v", "h264_metadata=colour_primaries=9:transfer_characteristics=18:matrix_coefficients=9"]);
    expect((await probeMedia(tagged.path)).video).toMatchObject({ colorPrimaries: "bt2020", colorTransfer: "arib-std-b67" });
    await expectClipError(verifyNormalizedClip(tagged), "VERIFICATION_FAILED");
  }, 30_000);
});
