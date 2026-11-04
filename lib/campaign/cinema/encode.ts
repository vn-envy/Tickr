import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Local H.264 encoder fed with raw RGBA frames over stdin. There is no shell, no
 * network protocol (file/pipe only) and no audio. The finished file is verified with
 * ffprobe before it replaces `outputPath`; nothing partial is left behind on failure.
 * Public errors are fixed strings: FFmpeg diagnostics can contain local paths.
 */

export type EncodeErrorCode = "INVALID_INPUT" | "ENCODER_UNAVAILABLE" | "FRAME_REJECTED" | "ENCODER_FAILED" | "CONTRACT_MISMATCH" | "TIMEOUT" | "ABORTED";

const MESSAGES: Record<EncodeErrorCode, string> = {
  INVALID_INPUT: "The local video encoder received an invalid request.",
  ENCODER_UNAVAILABLE: "The local video encoder could not be started. Check FFmpeg availability and retry this stage.",
  FRAME_REJECTED: "The local video encoder rejected a frame.",
  ENCODER_FAILED: "The local video encoder failed before the video was complete.",
  CONTRACT_MISMATCH: "The encoded video did not meet its output contract.",
  TIMEOUT: "The local video encoder timed out.",
  ABORTED: "The local video encode was cancelled.",
};

export class CinemaEncodeError extends Error {
  readonly code: EncodeErrorCode;
  constructor(code: EncodeErrorCode) { super(MESSAGES[code]); this.name = "CinemaEncodeError"; this.code = code; }
}

export interface H264EncoderOptions {
  /** Absolute .mp4 path. Written atomically after verification. */
  outputPath: string;
  width: number;
  height: number;
  /** Integer frames per second. */
  fps: number;
  /** finish() fails unless exactly this many frames were written and probed. */
  expectedFrames: number;
  /** Whole-encode wall-clock limit (default 240 s). The process is killed when it elapses. */
  timeoutMs?: number;
  /** libx264 CRF (default 18) and preset (default veryfast). */
  crf?: number;
  preset?: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium";
}

export interface EncodedVideo { frames: number; durationSeconds: number; sha256: string; bytes: number }

export interface H264Encoder {
  /** Writes one straight RGBA frame (width·height·4 bytes). Resolves when the pipe can take more. */
  writeFrame(rgba: Uint8Array): Promise<void>;
  /** Closes the stream, waits for FFmpeg, verifies the file with ffprobe and moves it into place. */
  finish(): Promise<EncodedVideo>;
  /** Kills the encoder and removes partial output. Safe to call more than once. */
  abort(): Promise<void>;
}

const MAX_STDERR = 16 * 1024;

export async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
  return { sha256: hash.digest("hex"), bytes };
}

/** Probes an MP4 and returns its first video stream facts, or throws CONTRACT_MISMATCH. */
export async function probeVideo(path: string): Promise<{ width: number; height: number; codec: string; frameRate: string; frames: number; durationSeconds: number; audioStreams: number }> {
  try {
    const result = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "stream=codec_type,width,height,codec_name,nb_frames,r_frame_rate:format=duration", "-of", "json", path], { timeout: 15_000, maxBuffer: 64_000 });
    const probe = JSON.parse(result.stdout) as { streams?: { codec_type?: string; width?: number; height?: number; codec_name?: string; nb_frames?: string; r_frame_rate?: string }[]; format?: { duration?: string } };
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    if (!video) throw new Error("no video");
    return {
      width: Number(video.width), height: Number(video.height), codec: String(video.codec_name), frameRate: String(video.r_frame_rate),
      frames: Number(video.nb_frames), durationSeconds: Number(probe.format?.duration), audioStreams: probe.streams?.filter((stream) => stream.codec_type === "audio").length ?? 0,
    };
  } catch { throw new CinemaEncodeError("CONTRACT_MISMATCH"); }
}

const PRESETS: ReadonlySet<string> = new Set<NonNullable<H264EncoderOptions["preset"]>>(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium"]);
const MAX_TIMEOUT_MS = 30 * 60_000;

export function openH264Encoder(options: H264EncoderOptions): H264Encoder {
  const { outputPath, width, height, fps, expectedFrames } = options;
  const crf = options.crf ?? 18, preset = options.preset ?? "veryfast", timeoutMs = options.timeoutMs ?? 240_000;
  // Runtime checks mirror the types: options may come from untyped configuration.
  if (typeof outputPath !== "string" || !isAbsolute(outputPath) || !/\.mp4$/i.test(outputPath)
    || ![width, height, fps, expectedFrames].every((value) => Number.isInteger(value) && value > 0)
    || width % 2 || height % 2 || width > 4096 || height > 4096 || fps > 120 || expectedFrames > 100_000
    || !Number.isInteger(crf) || crf < 0 || crf > 51 || typeof preset !== "string" || !PRESETS.has(preset)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new CinemaEncodeError("INVALID_INPUT");
  }
  const frameBytes = width * height * 4;
  const partialPath = join(dirname(outputPath), `.${basename(outputPath, ".mp4")}.${randomBytes(6).toString("hex")}.partial.mp4`);
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0",
    "-an", "-map_metadata", "-1", "-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-pix_fmt", "yuv420p",
    "-r", String(fps), "-movflags", "+faststart", "-protocol_whitelist", "file", "-f", "mp4", partialPath,
  ];

  let child: ChildProcessWithoutNullStreams;
  try { child = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }
  catch { throw new CinemaEncodeError("ENCODER_UNAVAILABLE"); }

  let failure: CinemaEncodeError | null = null;
  let exited = false, finishing = false, settled = false, frames = 0;
  let stderrBytes = 0;
  // Diagnostics are bounded and never surfaced; they exist only to keep the pipe drained.
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes = Math.min(MAX_STDERR, stderrBytes + chunk.length); });
  child.stdout.resume();
  child.stdin.on("error", () => { failure ??= new CinemaEncodeError("ENCODER_FAILED"); });
  const exit = new Promise<number | null>((resolve) => {
    // A spawn failure (e.g. FFmpeg missing) can surface after a stdin EPIPE; the root cause wins.
    child.on("error", () => { if (!failure || failure.code === "ENCODER_FAILED") failure = new CinemaEncodeError("ENCODER_UNAVAILABLE"); exited = true; resolve(null); });
    child.on("close", (code) => { exited = true; resolve(code); });
  });
  const timer = setTimeout(() => { failure ??= new CinemaEncodeError("TIMEOUT"); child.kill("SIGKILL"); }, timeoutMs);
  timer.unref();

  const cleanup = async () => { clearTimeout(timer); await rm(partialPath, { force: true }).catch(() => undefined); };
  const fail = async (error: CinemaEncodeError): Promise<never> => {
    failure ??= error;
    if (!exited) child.kill("SIGKILL");
    await exit; await cleanup(); settled = true;
    throw failure;
  };

  return {
    async writeFrame(rgba) {
      if (settled || finishing) throw new CinemaEncodeError("FRAME_REJECTED");
      if (failure || exited) return fail(failure ?? new CinemaEncodeError("ENCODER_FAILED"));
      if (!(rgba instanceof Uint8Array) || rgba.length !== frameBytes || frames >= expectedFrames) return fail(new CinemaEncodeError("FRAME_REJECTED"));
      frames++;
      if (child.stdin.write(rgba)) return;
      await new Promise<void>((resolve) => {
        const done = () => { child.stdin.off("drain", done); child.off("close", done); resolve(); };
        child.stdin.on("drain", done); child.on("close", done);
      });
      if (failure || exited) return fail(failure ?? new CinemaEncodeError("ENCODER_FAILED"));
    },
    async finish() {
      if (settled || finishing) throw new CinemaEncodeError("INVALID_INPUT");
      finishing = true;
      if (frames !== expectedFrames) return fail(new CinemaEncodeError("CONTRACT_MISMATCH"));
      child.stdin.end();
      const code = await exit;
      clearTimeout(timer);
      if (failure || code !== 0) return fail(failure ?? new CinemaEncodeError("ENCODER_FAILED"));
      const probe = await probeVideo(partialPath).catch(() => null);
      const expectedDuration = expectedFrames / fps;
      if (!probe || probe.width !== width || probe.height !== height || probe.codec !== "h264" || probe.frameRate !== `${fps}/1`
        || probe.frames !== expectedFrames || probe.audioStreams !== 0 || !(Math.abs(probe.durationSeconds - expectedDuration) <= Math.max(0.1, 1.5 / fps))) {
        return fail(new CinemaEncodeError("CONTRACT_MISMATCH"));
      }
      try {
        const digest = await sha256File(partialPath);
        await rename(partialPath, outputPath);
        const info = await stat(outputPath);
        if (info.size !== digest.bytes) throw new Error("size changed");
        settled = true;
        return { frames: probe.frames, durationSeconds: probe.durationSeconds, sha256: digest.sha256, bytes: digest.bytes };
      } catch { return fail(new CinemaEncodeError("ENCODER_FAILED")); }
    },
    async abort() {
      if (settled) return;
      failure ??= new CinemaEncodeError("ABORTED");
      if (!exited) child.kill("SIGKILL");
      child.stdin.destroy();
      await exit; await cleanup(); settled = true;
    },
  };
}
