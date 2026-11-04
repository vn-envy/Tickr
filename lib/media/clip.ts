import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { z } from "zod";
import type { ClipFrame, NormalizedClip, OwnerMediaConsent } from "./cinema-types";
import { MAX_OWNER_VIDEO_SECONDS } from "./uploads";

/**
 * Owner clip normalization and frame access. Everything here is local FFmpeg/ffprobe
 * work run with execFile/spawn (never a shell), file/pipe protocols only and an
 * explicit demuxer allowlist. Nothing is sent over the network, and nothing here
 * verifies product identity or publication rights: consent is the owner's record.
 */

const execFileAsync = promisify(execFile);

export const MAX_OWNER_CLIP_INPUT_BYTES = 300 * 1024 * 1024;
/**
 * Same as the owner-upload duration limit: normalization only ever decodes a ≤20 s window with
 * input seeking, so any video intake accepted can be prepared (no accepted-but-unusable range).
 */
export const MAX_OWNER_CLIP_INPUT_SECONDS = MAX_OWNER_VIDEO_SECONDS;
export const DEFAULT_CLIP_WINDOW_SECONDS = 12;
export const MAX_CLIP_WINDOW_SECONDS = 20;
export const MAX_NORMALIZED_CLIP_BYTES = 24 * 1024 * 1024;
export const NORMALIZED_CLIP_FPS = 30;
export const MAX_NORMALIZED_LONG_SIDE = 1280;
const MIN_WINDOW_FRAMES = 15;
const MIN_SOURCE_SIDE = 64;
const MAX_SOURCE_SIDE = 8192;
const MAX_READ_SIDE = 4096;
const MAX_READ_PIXELS = 3840 * 2160;
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_MAX_BUFFER = 1024 * 1024;
const TRANSCODE_TIMEOUT_MS = 180_000;
const AUDIO_TIMEOUT_MS = 90_000;
const FRAME_IDLE_TIMEOUT_MS = 30_000;
const CHILD_CLOSE_GRACE_MS = 5_000;
const TOOL_MAX_BUFFER = 256_000;
const PACKET_SCAN_TIMEOUT_MS = 60_000;
/** ~20 bytes per packet line: room for 600 s even at 240 fps (~2.9 MB). */
const PACKET_SCAN_MAX_BUFFER = 4 * 1024 * 1024;

/** Demuxers FFmpeg may open at all. WAV is only accepted for the extracted owner audio. */
const DEMUXER_ALLOWLIST = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,wav";
const ISOBMFF_FORMAT = "mov,mp4,m4a,3gp,3g2,mj2";
const MATROSKA_FORMAT = "matroska,webm";
const ACCEPTED_VIDEO_CODECS = new Set(["h264", "hevc", "vp8", "vp9", "av1", "mpeg4"]);
const ALLOWED_OUTPUT_FORMAT_TAGS = new Set(["major_brand", "minor_version", "compatible_brands", "encoder"]);
const ALLOWED_OUTPUT_STREAM_TAGS = new Set(["language", "handler_name", "vendor_id", "encoder"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type OwnerClipErrorCode =
  | "CONSENT_REQUIRED" | "INVALID_REQUEST" | "SOURCE_UNREADABLE" | "SOURCE_TOO_LARGE" | "UNSUPPORTED_MEDIA"
  | "NO_VIDEO_STREAM" | "SOURCE_TOO_LONG" | "SOURCE_TOO_SHORT" | "DIMENSIONS_NOT_ALLOWED" | "SOURCE_CHANGED"
  | "TRANSCODE_FAILED" | "OUTPUT_TOO_LARGE" | "VERIFICATION_FAILED" | "FRAME_READ_FAILED" | "PROBE_FAILED";

/** Fixed, path-free messages. Child-process errors are never forwarded because they contain local paths. */
export class OwnerClipError extends Error {
  constructor(readonly code: OwnerClipErrorCode, message: string) {
    super(message);
    this.name = "OwnerClipError";
  }
}

function fail(code: OwnerClipErrorCode, message: string): never {
  throw new OwnerClipError(code, message);
}

// ---------------------------------------------------------------------------
// ffprobe summary

const tagsSchema = z.record(z.string(), z.unknown()).optional();
const ffprobeStreamSchema = z.object({
  index: z.number().int().nonnegative(),
  codec_type: z.string().max(32).optional(),
  codec_name: z.string().max(64).optional(),
  pix_fmt: z.string().max(64).optional(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  sample_aspect_ratio: z.string().max(32).optional(),
  r_frame_rate: z.string().max(32).optional(),
  avg_frame_rate: z.string().max(32).optional(),
  nb_frames: z.string().max(32).optional(),
  duration: z.string().max(32).optional(),
  sample_rate: z.string().max(32).optional(),
  channels: z.number().int().nonnegative().optional(),
  color_range: z.string().max(32).optional(),
  color_space: z.string().max(32).optional(),
  color_transfer: z.string().max(32).optional(),
  color_primaries: z.string().max(32).optional(),
  disposition: z.object({ attached_pic: z.number().optional() }).optional(),
  tags: tagsSchema,
  side_data_list: z.array(z.object({ side_data_type: z.string().max(128).optional(), rotation: z.number().optional() })).max(64).optional(),
});
const ffprobeSchema = z.object({
  streams: z.array(ffprobeStreamSchema).max(64).default([]),
  format: z.object({
    format_name: z.string().max(128),
    duration: z.string().max(32).optional(),
    size: z.string().max(32).optional(),
    tags: tagsSchema,
  }),
});

export type MediaStreamKind = "video" | "audio" | "subtitle" | "data" | "attachment" | "other";

export interface MediaProbeStream {
  index: number;
  kind: MediaStreamKind;
  codec: string | null;
  pixelFormat: string | null;
  /** Coded size before any display rotation. */
  width: number | null;
  height: number | null;
  sampleAspectRatio: { num: number; den: number } | null;
  frameRate: string | null;
  avgFrameRate: string | null;
  frameCount: number | null;
  durationSeconds: number | null;
  /** Clockwise display rotation in degrees, normalized to 0–359 (display matrix or legacy rotate tag). */
  rotation: number;
  /** True when any display-matrix side data or rotate tag exists, even an identity one. */
  hasRotationMetadata: boolean;
  attachedPicture: boolean;
  sampleRate: number | null;
  channels: number | null;
  /** FFmpeg colour description names (e.g. "bt709", "arib-std-b67", "bt2020"); null when untagged. */
  colorRange: string | null;
  colorSpace: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  /** Stream side-data types (display matrix, HDR mastering/light-level, Dolby Vision, …). */
  sideDataTypes: string[];
  tags: Record<string, string>;
}

export interface MediaProbeSummary {
  formatName: string;
  durationSeconds: number | null;
  sizeBytes: number | null;
  tags: Record<string, string>;
  streams: MediaProbeStream[];
  /** The first video stream (FFmpeg's 0:v:0), or null. */
  video: MediaProbeStream | null;
  /** The first audio stream (0:a:0), or null. */
  audio: MediaProbeStream | null;
}

function finiteNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringTags(tags: Record<string, unknown> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {}).slice(0, 128)) {
    if (typeof value === "string" || typeof value === "number") output[key.toLowerCase()] = String(value).slice(0, 512);
  }
  return output;
}

function streamKind(value: string | undefined): MediaStreamKind {
  return value === "video" || value === "audio" || value === "subtitle" || value === "data" || value === "attachment" ? value : "other";
}

/** FFmpeg reports untagged colour properties as "unknown" (or "unspecified"); both mean "not tagged". */
function colorName(value: string | undefined): string | null {
  return value && value !== "unknown" && value !== "unspecified" ? value : null;
}

/** Transfer functions that carry high-dynamic-range code values (PQ / HDR10 / Dolby Vision 8.1, and HLG). */
const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);
const WIDE_GAMUT_PRIMARIES = new Set(["bt2020"]);
const WIDE_GAMUT_MATRICES = new Set(["bt2020nc", "bt2020c"]);

export type MediaDynamicRange = "sdr" | "wide_gamut_sdr" | "hdr";

/**
 * Colour class of a video stream. HDR (PQ/HLG) needs tone mapping before any SDR use;
 * BT.2020 SDR needs a gamut conversion. Both are converted to BT.709 by normalization.
 */
export function videoDynamicRange(stream: Pick<MediaProbeStream, "colorTransfer" | "colorPrimaries" | "colorSpace">): MediaDynamicRange {
  if (stream.colorTransfer && HDR_TRANSFERS.has(stream.colorTransfer)) return "hdr";
  if ((stream.colorPrimaries && WIDE_GAMUT_PRIMARIES.has(stream.colorPrimaries)) || (stream.colorSpace && WIDE_GAMUT_MATRICES.has(stream.colorSpace))) return "wide_gamut_sdr";
  return "sdr";
}

function summarizeStream(stream: z.infer<typeof ffprobeStreamSchema>): MediaProbeStream {
  const tags = stringTags(stream.tags);
  const displayMatrices = (stream.side_data_list ?? []).filter((entry) => entry.side_data_type === "Display Matrix" || typeof entry.rotation === "number");
  // ffprobe reports the display matrix angle counter-clockwise; express it clockwise.
  const matrixRotation = displayMatrices.find((entry) => typeof entry.rotation === "number")?.rotation;
  const legacyRotation = finiteNumber(tags.rotate);
  const rawRotation = typeof matrixRotation === "number" ? -matrixRotation : legacyRotation ?? 0;
  const sar = /^(\d{1,6}):(\d{1,6})$/.exec(stream.sample_aspect_ratio ?? "");
  const num = sar ? Number(sar[1]) : 0;
  const den = sar ? Number(sar[2]) : 0;
  return {
    index: stream.index,
    kind: streamKind(stream.codec_type),
    codec: stream.codec_name ?? null,
    pixelFormat: stream.pix_fmt ?? null,
    width: stream.width ?? null,
    height: stream.height ?? null,
    sampleAspectRatio: num > 0 && den > 0 ? { num, den } : null,
    frameRate: stream.r_frame_rate ?? null,
    avgFrameRate: stream.avg_frame_rate ?? null,
    frameCount: finiteNumber(stream.nb_frames),
    durationSeconds: finiteNumber(stream.duration),
    rotation: ((Math.round(rawRotation) % 360) + 360) % 360,
    hasRotationMetadata: displayMatrices.length > 0 || legacyRotation !== null,
    attachedPicture: stream.disposition?.attached_pic === 1,
    sampleRate: finiteNumber(stream.sample_rate),
    channels: stream.channels ?? null,
    colorRange: colorName(stream.color_range),
    colorSpace: colorName(stream.color_space),
    colorTransfer: colorName(stream.color_transfer),
    colorPrimaries: colorName(stream.color_primaries),
    sideDataTypes: (stream.side_data_list ?? []).map((entry) => entry.side_data_type ?? "unknown"),
    tags,
  };
}

/** Child processes get only what they need; server credentials never reach them. */
function toolEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
  if (process.env.LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH;
  return env;
}

const INPUT_OPTIONS = ["-protocol_whitelist", "file,pipe", "-format_whitelist", DEMUXER_ALLOWLIST] as const;
const inputArgs = (path: string): string[] => [...INPUT_OPTIONS, "-i", `file:${path}`];

async function runTool(command: "ffmpeg" | "ffprobe", args: string[], timeout: number, maxBuffer = TOOL_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { timeout, maxBuffer, killSignal: "SIGKILL", windowsHide: true, env: toolEnv(), encoding: "utf8" });
  return stdout;
}

function assertAbsolutePath(path: unknown, label: string): string {
  if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0") || !isAbsolute(path)) {
    fail("INVALID_REQUEST", `The ${label} must be an absolute private path.`);
  }
  return resolve(path as string);
}

/** Validated ffprobe summary of a local media file (allowlisted demuxers only). */
export async function probeMedia(path: string): Promise<MediaProbeSummary> {
  const file = assertAbsolutePath(path, "media file");
  let raw: unknown;
  try {
    const stdout = await runTool("ffprobe", ["-hide_banner", "-v", "error", ...INPUT_OPTIONS, "-show_format", "-show_streams", "-of", "json", `file:${file}`], PROBE_TIMEOUT_MS, PROBE_MAX_BUFFER);
    raw = JSON.parse(stdout);
  } catch {
    return fail("PROBE_FAILED", "The media file could not be inspected as a supported video container.");
  }
  const parsed = ffprobeSchema.safeParse(raw);
  if (!parsed.success) return fail("PROBE_FAILED", "The media inspection result did not match its expected shape.");
  const streams = parsed.data.streams.map(summarizeStream);
  return {
    formatName: parsed.data.format.format_name,
    durationSeconds: finiteNumber(parsed.data.format.duration),
    sizeBytes: finiteNumber(parsed.data.format.size),
    tags: stringTags(parsed.data.format.tags),
    streams,
    video: streams.find((stream) => stream.kind === "video") ?? null,
    audio: streams.find((stream) => stream.kind === "audio") ?? null,
  };
}

// ---------------------------------------------------------------------------
// Window selection

const roundDownMs = (seconds: number) => Math.floor(seconds * 1000 + 1e-6) / 1000;

/**
 * Pure helper: pick at most maxSeconds of a clip. With a hero moment the window is
 * centred on it and shifted to stay inside the clip; without one it starts at 0.
 */
export function chooseClipWindow(durationSeconds: number, heroMomentSeconds: number | null, maxSeconds: number): { startSeconds: number; durationSeconds: number } {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) fail("INVALID_REQUEST", "The clip duration must be a positive number of seconds.");
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > MAX_CLIP_WINDOW_SECONDS) fail("INVALID_REQUEST", `The clip window must be between 0 and ${MAX_CLIP_WINDOW_SECONDS} seconds.`);
  if (heroMomentSeconds !== null && (!Number.isFinite(heroMomentSeconds) || heroMomentSeconds < 0)) fail("INVALID_REQUEST", "The hero moment must be a non-negative number of seconds.");
  const length = Math.min(durationSeconds, maxSeconds);
  const start = heroMomentSeconds === null ? 0 : Math.min(Math.max(heroMomentSeconds - length / 2, 0), durationSeconds - length);
  const startSeconds = Math.max(0, roundDownMs(start));
  return { startSeconds, durationSeconds: roundDownMs(Math.min(length, durationSeconds - startSeconds)) };
}

// ---------------------------------------------------------------------------
// Normalization

const consentSchema = z.object({
  ownsOrLicensedMedia: z.literal(true),
  peopleVisibleHaveConsented: z.union([z.literal(true), z.literal("no_people")]),
  attestedAt: z.string().max(64).refine((value) => !Number.isNaN(Date.parse(value)), "attestedAt"),
});

export interface NormalizeOwnerClipInput {
  /** Absolute private path of the owner's original upload. */
  sourcePath: string;
  /** Absolute private directory (normally under ignored .data/). Created with 0700 if missing. */
  outputDir: string;
  consent: OwnerMediaConsent;
  /** Owner uploads and owner-connected Instagram/Facebook media; all still require the consent attestation. */
  provenance?: "owner_upload" | "owner_instagram" | "owner_facebook";
  startSeconds?: number;
  /** Window length; default 12 s, maximum 20 s. */
  maxSeconds?: number;
  id?: string;
}

/**
 * Internal overrides for tests and operations. They can only tighten limits; beforeCommit runs
 * after every output exists as a private temp file and before the source re-check and commit.
 */
export interface NormalizeOwnerClipInternals {
  maxOutputBytes?: number;
  beforeCommit?: () => Promise<void>;
}

function evenFit(displayWidth: number, displayHeight: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_NORMALIZED_LONG_SIDE / Math.max(displayWidth, displayHeight));
  const fit = (side: number) => {
    const limit = Math.min(side, MAX_NORMALIZED_LONG_SIDE);
    let even = Math.round((side * scale) / 2) * 2;
    while (even > limit) even -= 2;
    return Math.max(2, even);
  };
  return { width: fit(displayWidth), height: fit(displayHeight) };
}

function containerLabel(probe: MediaProbeSummary): string {
  if (probe.formatName === MATROSKA_FORMAT) return "matroska_webm";
  const brand = (probe.tags.major_brand ?? "").trim().toLowerCase();
  if (brand === "qt") return "mov";
  if (brand === "m4v") return "m4v";
  if (brand.startsWith("3g")) return "3gp";
  return "mp4";
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Duration of the first video stream from its packet timestamps. Used only when neither the
 * container nor the stream records a duration (browser MediaRecorder / live WebM). Bounded by
 * a timeout and an output cap; a packet list too large for the cap is necessarily too long.
 */
async function scanVideoDurationSeconds(path: string): Promise<number | null> {
  let stdout: string;
  try {
    stdout = await runTool("ffprobe", [
      "-hide_banner", "-v", "error", ...INPUT_OPTIONS, "-select_streams", "v:0",
      "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", `file:${path}`,
    ], PACKET_SCAN_TIMEOUT_MS, PACKET_SCAN_MAX_BUFFER);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return Number.POSITIVE_INFINITY;
    return null;
  }
  let first = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const line of stdout.split("\n")) {
    const [ptsText, durationText] = line.trim().split(",");
    const pts = Number(ptsText);
    if (!ptsText || !Number.isFinite(pts)) continue;
    const duration = Number(durationText);
    first = Math.min(first, pts);
    end = Math.max(end, pts + (durationText && Number.isFinite(duration) && duration > 0 ? duration : 0));
  }
  return Number.isFinite(first) && Number.isFinite(end) && end > first ? end - first : null;
}

type SourceContract = {
  video: MediaProbeStream; codec: string; displayWidth: number; displayHeight: number; quarterTurn: boolean;
  durationSeconds: number; dynamicRange: MediaDynamicRange;
};

/** Validates an owner upload's probe against the accepted input contract. */
async function assertSourceContract(probe: MediaProbeSummary, sourcePath: string): Promise<SourceContract> {
  if (probe.formatName !== ISOBMFF_FORMAT && probe.formatName !== MATROSKA_FORMAT) {
    fail("UNSUPPORTED_MEDIA", "Only MP4, MOV, M4V, 3GP, Matroska or WebM video files are accepted.");
  }
  const video = probe.video;
  if (!video || video.attachedPicture) return fail("NO_VIDEO_STREAM", "The file does not contain a video stream.");
  if (!video.codec || !ACCEPTED_VIDEO_CODECS.has(video.codec)) return fail("UNSUPPORTED_MEDIA", "The video codec is not supported. Use H.264, HEVC, VP8, VP9, AV1 or MPEG-4 video.");
  if (!video.width || !video.height || Math.min(video.width, video.height) < MIN_SOURCE_SIDE || Math.max(video.width, video.height) > MAX_SOURCE_SIDE) {
    return fail("DIMENSIONS_NOT_ALLOWED", `The video must be between ${MIN_SOURCE_SIDE} and ${MAX_SOURCE_SIDE} pixels on each side.`);
  }
  if (video.rotation % 90 !== 0) fail("UNSUPPORTED_MEDIA", "The video uses an unsupported display rotation.");
  const durations = [probe.durationSeconds, video.durationSeconds].filter((value): value is number => value !== null && value > 0);
  if (!durations.length) {
    const scanned = await scanVideoDurationSeconds(sourcePath);
    if (scanned === null) fail("UNSUPPORTED_MEDIA", "The video duration could not be determined.");
    durations.push(scanned);
  }
  if (Math.max(...durations) > MAX_OWNER_CLIP_INPUT_SECONDS) fail("SOURCE_TOO_LONG", `The video is longer than ${MAX_OWNER_CLIP_INPUT_SECONDS} seconds.`);
  // Display size: non-square pixels are resolved horizontally, then quarter-turn rotation swaps the axes.
  const sar = video.sampleAspectRatio;
  const sarWidth = sar && sar.num !== sar.den ? Math.round((video.width * sar.num) / sar.den) : video.width;
  if (sarWidth < MIN_SOURCE_SIDE || sarWidth > MAX_SOURCE_SIDE) fail("DIMENSIONS_NOT_ALLOWED", `The video must be between ${MIN_SOURCE_SIDE} and ${MAX_SOURCE_SIDE} pixels on each side.`);
  const quarterTurn = video.rotation === 90 || video.rotation === 270;
  return {
    video, codec: video.codec, quarterTurn,
    displayWidth: quarterTurn ? video.height : sarWidth,
    displayHeight: quarterTurn ? sarWidth : video.height,
    // The playable picture ends with the shorter of the container and video-stream durations.
    durationSeconds: Math.min(...durations),
    dynamicRange: videoDynamicRange(video),
  };
}

/**
 * The normalization video filter. Rotation is applied by -autorotate before this chain, so the
 * target is in display orientation. Every path ends in BT.709 limited-range 8-bit 4:2:0:
 * - SDR: one swscale pass that also converts the YCbCr matrix (e.g. BT.601) to BT.709;
 * - BT.2020 SDR: a zimg gamut conversion to BT.709;
 * - HDR (PQ/HLG): linearize, convert primaries, Hable tone map, re-encode as BT.709 SDR.
 *   Without that, HLG/PQ code values would later be shown and analyzed as if they were SDR.
 */
function normalizationFilter(target: { width: number; height: number }, video: MediaProbeStream, dynamicRange: MediaDynamicRange): string {
  const fps = `fps=${NORMALIZED_CLIP_FPS}`;
  const size = `w=${target.width}:h=${target.height}`;
  if (dynamicRange === "sdr") {
    return `${fps},scale=${target.width}:${target.height}:flags=bicubic:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p`;
  }
  // zimg needs a complete input description; fill only the properties the file leaves untagged.
  const inputs = [
    video.colorPrimaries ? "" : ":pin=bt2020",
    video.colorSpace ? "" : ":min=bt2020nc",
    video.colorTransfer ? "" : ":tin=bt709",
  ].join("");
  if (dynamicRange === "wide_gamut_sdr") {
    return `${fps},zscale=${size}:f=bicubic${inputs}:p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p,setsar=1`;
  }
  return [
    fps,
    `zscale=${size}:f=bicubic${inputs}:t=linear:npl=100`,
    "format=gbrpf32le",
    "zscale=p=bt709",
    "tonemap=tonemap=hable:desat=0",
    "zscale=t=bt709:m=bt709:r=tv",
    "format=yuv420p",
    "setsar=1",
  ].join(",");
}

type FileIdentity = { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number };
const sameFile = (a: FileIdentity, b: FileIdentity) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.dev === b.dev;

/**
 * Normalize one owner clip into a private, metadata-free tracking MP4 (H.264, BT.709 SDR,
 * 30 fps CFR, long side <= 1280, no audio, no rotation), a poster PNG and optional 16 kHz
 * mono owner audio. Consent is checked before the file system or FFmpeg is touched.
 *
 * Every output is first written as a private temp file; final names are only replaced in a
 * last commit step, after the source was re-checked. A failed run therefore never deletes or
 * half-replaces a clip that an earlier run wrote under the same (content-derived) id.
 */
export async function normalizeOwnerClip(input: NormalizeOwnerClipInput, internals: NormalizeOwnerClipInternals = {}): Promise<NormalizedClip> {
  if (!input || typeof input !== "object") return fail("INVALID_REQUEST", "The clip normalization request is invalid.");
  const consent = consentSchema.safeParse(input.consent);
  if (!consent.success) fail("CONSENT_REQUIRED", "The owner must confirm they own or license this clip and that any visible people have consented.");
  if (input.provenance !== undefined && !["owner_upload", "owner_instagram", "owner_facebook"].includes(input.provenance)) fail("INVALID_REQUEST", "Only the owner's own media can be normalized as owner clips.");
  const sourcePath = assertAbsolutePath(input.sourcePath, "source clip");
  const outputDir = assertAbsolutePath(input.outputDir, "output directory");
  const maxSeconds = input.maxSeconds ?? DEFAULT_CLIP_WINDOW_SECONDS;
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > MAX_CLIP_WINDOW_SECONDS) fail("INVALID_REQUEST", `The clip window must be between 0 and ${MAX_CLIP_WINDOW_SECONDS} seconds.`);
  if (input.startSeconds !== undefined && (!Number.isFinite(input.startSeconds) || input.startSeconds < 0)) fail("INVALID_REQUEST", "The clip start must be a non-negative number of seconds.");
  if (input.id !== undefined && !ID_PATTERN.test(input.id)) fail("INVALID_REQUEST", "The clip id must be 1–64 letters, digits, dashes or underscores.");
  const maxOutputBytes = internals.maxOutputBytes ?? MAX_NORMALIZED_CLIP_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_NORMALIZED_CLIP_BYTES) fail("INVALID_REQUEST", "The normalized clip size limit is invalid.");

  const before = await lstat(sourcePath).catch(() => fail("SOURCE_UNREADABLE", "The uploaded clip could not be read."));
  if (!before.isFile()) fail("SOURCE_UNREADABLE", "The uploaded clip must be a regular file.");
  if (before.size <= 0) fail("SOURCE_UNREADABLE", "The uploaded clip is empty.");
  if (before.size > MAX_OWNER_CLIP_INPUT_BYTES) fail("SOURCE_TOO_LARGE", "The uploaded clip is larger than 300 MiB.");
  const originalSha256 = await sha256File(sourcePath).catch(() => fail("SOURCE_UNREADABLE", "The uploaded clip could not be read."));

  const probe = await probeMedia(sourcePath).catch((error: unknown) => {
    if (error instanceof OwnerClipError && error.code === "PROBE_FAILED") fail("UNSUPPORTED_MEDIA", "Only MP4, MOV, M4V, 3GP, Matroska or WebM video files are accepted.");
    throw error;
  });
  const source = await assertSourceContract(probe, sourcePath);
  const sourceDuration = source.durationSeconds;

  const window = input.startSeconds === undefined
    ? chooseClipWindow(sourceDuration, null, maxSeconds)
    : (() => {
      if (input.startSeconds >= sourceDuration) fail("INVALID_REQUEST", "The clip start is beyond the end of the video.");
      return { startSeconds: roundDownMs(input.startSeconds), durationSeconds: roundDownMs(Math.min(maxSeconds, sourceDuration - input.startSeconds)) };
    })();
  const windowFrames = Math.floor(window.durationSeconds * NORMALIZED_CLIP_FPS + 1e-6);
  if (windowFrames < MIN_WINDOW_FRAMES) fail("SOURCE_TOO_SHORT", "The selected clip window is shorter than half a second.");
  const windowSeconds = windowFrames / NORMALIZED_CLIP_FPS;

  const target = evenFit(source.displayWidth, source.displayHeight);

  const id = input.id ?? `clip-${createHash("sha256").update(JSON.stringify({ v: 1, originalSha256, window })).digest("hex").slice(0, 24)}`;
  await mkdir(outputDir, { recursive: true, mode: 0o700 }).catch(() => fail("INVALID_REQUEST", "The private clip directory could not be prepared."));
  const finalPath = join(outputDir, `${id}.mp4`);
  const posterPath = join(outputDir, `${id}.poster.png`);
  const audioFinalPath = join(outputDir, `${id}.owner-audio.wav`);
  const nonce = randomBytes(6).toString("hex");
  const tempVideo = join(outputDir, `.${id}.${nonce}.partial.mp4`);
  const tempPoster = join(outputDir, `.${id}.${nonce}.partial.png`);
  const tempAudio = join(outputDir, `.${id}.${nonce}.partial.wav`);

  try {
    const filter = normalizationFilter(target, source.video, source.dynamicRange);
    try {
      await runTool("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-autorotate", "1",
        "-ss", window.startSeconds.toFixed(3), "-t", windowSeconds.toFixed(6), ...inputArgs(sourcePath),
        "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
        "-vf", filter, "-r", String(NORMALIZED_CLIP_FPS), "-frames:v", String(windowFrames),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-maxrate", "8M", "-bufsize", "16M", "-profile:v", "high",
        "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
        "-g", String(NORMALIZED_CLIP_FPS), "-threads", "2",
        // -fs is only a disk-usage backstop well above the cap: a truncated file is still over the cap.
        "-movflags", "+faststart", "-fs", String(2 * maxOutputBytes), "-f", "mp4", `file:${tempVideo}`,
      ], TRANSCODE_TIMEOUT_MS);
    } catch {
      if (source.dynamicRange !== "sdr") fail("TRANSCODE_FAILED", "This HDR or wide-colour clip could not be converted to standard range locally. Check the FFmpeg build (zscale/tonemap) or export the clip as SDR.");
      fail("TRANSCODE_FAILED", "The clip could not be normalized locally. Check FFmpeg availability or try a different file.");
    }
    const encoded = await stat(tempVideo).catch(() => fail("TRANSCODE_FAILED", "The clip could not be normalized locally."));
    if (encoded.size > maxOutputBytes) fail("OUTPUT_TOO_LARGE", `The normalized clip exceeded ${formatMiB(maxOutputBytes)}. Choose a shorter or simpler segment.`);

    const output = assertTrackingContract(await probeMedia(tempVideo).catch(() => fail("VERIFICATION_FAILED", "The normalized clip did not meet its output contract.")));
    if (output.width !== target.width || output.height !== target.height) fail("VERIFICATION_FAILED", "The normalized clip did not meet its output contract.");
    await chmod(tempVideo, 0o600);
    const sha256 = await sha256File(tempVideo);

    const clip: NormalizedClip = {
      version: 1, id, sha256, path: tempVideo, width: output.width, height: output.height, fps: NORMALIZED_CLIP_FPS,
      frameCount: output.frameCount, durationSeconds: output.frameCount / NORMALIZED_CLIP_FPS, posterPath: tempPoster, audioPath: null,
      original: {
        bytes: before.size, sha256: originalSha256, container: containerLabel(probe), videoCodec: source.codec,
        durationSeconds: sourceDuration, width: source.displayWidth, height: source.displayHeight, dynamicRange: source.dynamicRange,
      },
      provenance: input.provenance ?? "owner_upload", consent: { ...consent.data }, createdAt: new Date().toISOString(),
    };

    await writeFile(tempPoster, await extractClipFramePng(clip, 0), { mode: 0o600 });
    const hasAudio = probe.audio ? await extractOwnerAudio(sourcePath, window.startSeconds, windowSeconds, tempAudio) : false;
    await internals.beforeCommit?.();

    // Every output came from the bytes hashed as original.sha256 only if the source is unchanged now.
    const after = await lstat(sourcePath).catch(() => fail("SOURCE_CHANGED", "The uploaded clip changed while it was being normalized."));
    if (!after.isFile() || !sameFile(before, after)) fail("SOURCE_CHANGED", "The uploaded clip changed while it was being normalized.");

    await rename(tempVideo, finalPath);
    await rename(tempPoster, posterPath);
    if (hasAudio) await rename(tempAudio, audioFinalPath);
    return { ...clip, path: finalPath, posterPath, audioPath: hasAudio ? audioFinalPath : null };
  } catch (error) {
    await Promise.all([tempVideo, tempPoster, tempAudio].map((path) => rm(path, { force: true }).catch(() => undefined)));
    if (error instanceof OwnerClipError) throw error;
    throw new OwnerClipError("TRANSCODE_FAILED", "The clip could not be normalized locally.");
  }
}

const formatMiB = (bytes: number) => bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${bytes} bytes`;

/**
 * Owner audio is optional evidence for later transcription. A decode failure or an
 * empty track drops it (no file, audioPath null) rather than failing the whole clip.
 */
async function extractOwnerAudio(sourcePath: string, startSeconds: number, durationSeconds: number, tempPath: string): Promise<boolean> {
  try {
    await runTool("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-ss", startSeconds.toFixed(3), "-t", durationSeconds.toFixed(6), ...inputArgs(sourcePath),
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-fflags", "+bitexact", "-flags:a", "+bitexact",
      "-f", "wav", `file:${tempPath}`,
    ], AUDIO_TIMEOUT_MS);
    assertOwnerAudioContract(await probeMedia(tempPath));
    await chmod(tempPath, 0o600);
    return true;
  } catch {
    await rm(tempPath, { force: true }).catch(() => undefined);
    return false;
  }
}

function assertOwnerAudioContract(audio: MediaProbeSummary) {
  const stream = audio.audio;
  if (audio.formatName !== "wav" || audio.streams.length !== 1 || !stream || stream.codec !== "pcm_s16le" || stream.sampleRate !== 16000 || stream.channels !== 1
    || (audio.durationSeconds ?? 0) < 0.1 || Object.keys(audio.tags).some((key) => key !== "encoder")) {
    fail("VERIFICATION_FAILED", "The owner audio did not meet its output contract.");
  }
}

/** Output colour tags: BT.709 limited range, or untagged. Never BT.2020, PQ or HLG. */
const allowedColor = (value: string | null, allowed: string) => value === null || value === allowed;

/** The tracking-clip contract shared by normalization and later verification. */
function assertTrackingContract(probe: MediaProbeSummary, maxLongSide = MAX_NORMALIZED_LONG_SIDE): { width: number; height: number; frameCount: number } {
  const bad = () => fail("VERIFICATION_FAILED", "The normalized clip did not meet its output contract.");
  const video = probe.video;
  if (probe.formatName !== ISOBMFF_FORMAT || probe.streams.length !== 1 || !video) return bad();
  if (video.codec !== "h264" || video.pixelFormat !== "yuv420p" || video.frameRate !== `${NORMALIZED_CLIP_FPS}/1`) bad();
  if (!video.width || !video.height || video.width % 2 || video.height % 2 || Math.max(video.width, video.height) > maxLongSide) return bad();
  if (video.hasRotationMetadata || video.rotation !== 0 || video.sideDataTypes.length) bad();
  if (!allowedColor(video.colorPrimaries, "bt709") || !allowedColor(video.colorTransfer, "bt709") || !allowedColor(video.colorSpace, "bt709") || !allowedColor(video.colorRange, "tv")) bad();
  const frameCount = video.frameCount;
  const duration = video.durationSeconds ?? probe.durationSeconds;
  if (frameCount === null || !Number.isInteger(frameCount) || frameCount < MIN_WINDOW_FRAMES || duration === null) return bad();
  if (Math.abs(frameCount - duration * NORMALIZED_CLIP_FPS) > 1) bad();
  if (Object.keys(probe.tags).some((key) => !ALLOWED_OUTPUT_FORMAT_TAGS.has(key))) bad();
  if (Object.keys(video.tags).some((key) => !ALLOWED_OUTPUT_STREAM_TAGS.has(key))) bad();
  return { width: video.width, height: video.height, frameCount };
}

// ---------------------------------------------------------------------------
// Clip record validation and verification

const clipSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(ID_PATTERN),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  path: z.string().min(1).max(4096).refine(isAbsolute),
  width: z.number().int().min(2).max(MAX_NORMALIZED_LONG_SIDE),
  height: z.number().int().min(2).max(MAX_NORMALIZED_LONG_SIDE),
  fps: z.literal(NORMALIZED_CLIP_FPS),
  frameCount: z.number().int().min(1).max(MAX_CLIP_WINDOW_SECONDS * NORMALIZED_CLIP_FPS + 1),
  durationSeconds: z.number().positive(),
  posterPath: z.string().min(1).max(4096).refine(isAbsolute),
  audioPath: z.string().min(1).max(4096).refine(isAbsolute).nullable(),
});

function validClip(clip: NormalizedClip): z.infer<typeof clipSchema> {
  const parsed = clipSchema.safeParse(clip);
  if (!parsed.success) return fail("INVALID_REQUEST", "The clip record is not a valid normalized clip.");
  return parsed.data;
}

/** Re-hash the tracking MP4 and re-check its ffprobe contract, poster and owner audio. Throws on any mismatch. */
export async function verifyNormalizedClip(clip: NormalizedClip): Promise<void> {
  const record = validClip(clip);
  const bad = () => fail("VERIFICATION_FAILED", "The normalized clip no longer matches its recorded contract.");
  const info = await lstat(record.path).catch(() => bad());
  if (!info.isFile() || info.size > MAX_NORMALIZED_CLIP_BYTES) bad();
  if ((await sha256File(record.path).catch(() => bad())) !== record.sha256) bad();
  const output = assertTrackingContract(await probeMedia(record.path).catch(() => bad()));
  if (output.width !== record.width || output.height !== record.height || output.frameCount !== record.frameCount) bad();
  if (Math.abs(record.durationSeconds - record.frameCount / NORMALIZED_CLIP_FPS) > 1e-6) bad();
  const poster = await sharp(record.posterPath, { limitInputPixels: MAX_READ_PIXELS }).metadata().catch(() => bad());
  if (poster.format !== "png" || poster.width !== record.width || poster.height !== record.height) bad();
  if (record.audioPath) {
    try { assertOwnerAudioContract(await probeMedia(record.audioPath)); } catch { bad(); }
  }
}

// ---------------------------------------------------------------------------
// Render source
//
// The tracking clip is capped at MAX_NORMALIZED_LONG_SIDE so SAM and Spark payloads stay small.
// Output pixels may instead come from a local render source: the same source window, frame
// selection, rotation and colour/tone mapping as the tracking clip, at a larger size. It is never
// sent to Meta, carries no poster or audio and is bound to its tracking clip by hash and frame count.

export const MAX_RENDER_CLIP_BYTES = 192 * 1024 * 1024;
const RENDER_TRANSCODE_TIMEOUT_MS = 300_000;
/** Allowed per-axis scale mismatch between the render source and its tracking clip (even rounding). */
export const MAX_RENDER_ASPECT_DRIFT = 0.02;

export interface OwnerRenderClip {
  version: 1;
  kind: "render_source";
  /** SHA-256 of the tracking clip whose window and frames this file repeats at a larger size. */
  trackingSha256: string;
  sha256: string;
  /** Absolute private path under .data/. Never exported, shown to the browser or sent to Meta. */
  path: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
}

export interface NormalizeOwnerRenderClipInput {
  /** The tracking clip normalized from the same source with the same window options. */
  tracking: NormalizedClip;
  sourcePath: string;
  outputDir: string;
  consent: OwnerMediaConsent;
  startSeconds?: number;
  maxSeconds?: number;
  /** Output frame size (e.g. 1080×1920) that the largest centred crop of its aspect should cover 1:1. */
  cover: { width: number; height: number };
}

/**
 * Render-source size for a display-oriented source: just large enough that the largest crop of the
 * cover's aspect is cover-sized (never upscaled), within the frame-read bounds. Even sides.
 */
export function renderClipSize(displayWidth: number, displayHeight: number, cover: { width: number; height: number }): { width: number; height: number } {
  if (![displayWidth, displayHeight, cover.width, cover.height].every((value) => Number.isInteger(value) && value >= 2 && value <= MAX_SOURCE_SIDE)) {
    fail("INVALID_REQUEST", "The render size request is invalid.");
  }
  const cropHeight = displayWidth / displayHeight >= cover.width / cover.height ? displayHeight : (displayWidth * cover.height) / cover.width;
  const scale = Math.min(1, cover.height / cropHeight, MAX_READ_SIDE / Math.max(displayWidth, displayHeight), Math.sqrt(MAX_READ_PIXELS / (displayWidth * displayHeight)));
  const even = (side: number) => Math.max(2, Math.floor((side * scale) / 2) * 2);
  return { width: even(displayWidth), height: even(displayHeight) };
}

const renderClipSchema = z.object({
  version: z.literal(1),
  kind: z.literal("render_source"),
  trackingSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  path: z.string().min(1).max(4096).refine(isAbsolute),
  width: z.number().int().min(2).max(MAX_READ_SIDE),
  height: z.number().int().min(2).max(MAX_READ_SIDE),
  fps: z.literal(NORMALIZED_CLIP_FPS),
  frameCount: z.number().int().min(1).max(MAX_CLIP_WINDOW_SECONDS * NORMALIZED_CLIP_FPS + 1),
}).refine((clip) => clip.width * clip.height <= MAX_READ_PIXELS);

/**
 * True when `render` repeats `tracking` at a uniformly larger size: same tracking hash, frame
 * count and frame rate, at least as large on both axes and the same aspect within rounding.
 */
export function renderClipMatches(render: OwnerRenderClip, tracking: Pick<NormalizedClip, "sha256" | "width" | "height" | "fps" | "frameCount">): boolean {
  if (!renderClipSchema.safeParse(render).success) return false;
  if (render.trackingSha256 !== tracking.sha256 || render.frameCount !== tracking.frameCount || render.fps !== tracking.fps) return false;
  if (render.width < tracking.width || render.height < tracking.height || (render.width === tracking.width && render.height === tracking.height)) return false;
  const kx = render.width / tracking.width, ky = render.height / tracking.height;
  return Math.abs(kx / ky - 1) <= MAX_RENDER_ASPECT_DRIFT;
}

/**
 * Normalize the render source for an already normalized tracking clip. Returns null when the
 * source is not larger than the tracking clip (nothing to gain). The source must still be the
 * exact file the tracking clip was made from, and consent is re-checked first.
 */
export async function normalizeOwnerRenderClip(input: NormalizeOwnerRenderClipInput, internals: Pick<NormalizeOwnerClipInternals, "maxOutputBytes"> = {}): Promise<OwnerRenderClip | null> {
  if (!input || typeof input !== "object") return fail("INVALID_REQUEST", "The render clip request is invalid.");
  const consent = consentSchema.safeParse(input.consent);
  if (!consent.success) fail("CONSENT_REQUIRED", "The owner must confirm they own or license this clip and that any visible people have consented.");
  const tracking = input.tracking;
  validClip(tracking);
  if (!tracking.original || !/^[0-9a-f]{64}$/.test(String(tracking.original.sha256))) fail("INVALID_REQUEST", "The clip record is not a valid normalized clip.");
  const sourcePath = assertAbsolutePath(input.sourcePath, "source clip");
  const outputDir = assertAbsolutePath(input.outputDir, "output directory");
  const maxSeconds = input.maxSeconds ?? DEFAULT_CLIP_WINDOW_SECONDS;
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > MAX_CLIP_WINDOW_SECONDS) fail("INVALID_REQUEST", `The clip window must be between 0 and ${MAX_CLIP_WINDOW_SECONDS} seconds.`);
  if (input.startSeconds !== undefined && (!Number.isFinite(input.startSeconds) || input.startSeconds < 0)) fail("INVALID_REQUEST", "The clip start must be a non-negative number of seconds.");
  const cover = input.cover;
  if (!cover || ![cover.width, cover.height].every((value) => Number.isInteger(value) && value >= 2 && value <= MAX_READ_SIDE)) fail("INVALID_REQUEST", "The render size request is invalid.");
  const maxOutputBytes = internals.maxOutputBytes ?? MAX_RENDER_CLIP_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_RENDER_CLIP_BYTES) fail("INVALID_REQUEST", "The render clip size limit is invalid.");

  const before = await lstat(sourcePath).catch(() => fail("SOURCE_UNREADABLE", "The uploaded clip could not be read."));
  if (!before.isFile() || before.size <= 0) fail("SOURCE_UNREADABLE", "The uploaded clip must be a non-empty regular file.");
  if (before.size > MAX_OWNER_CLIP_INPUT_BYTES) fail("SOURCE_TOO_LARGE", "The uploaded clip is larger than 300 MiB.");
  const originalSha256 = await sha256File(sourcePath).catch(() => fail("SOURCE_UNREADABLE", "The uploaded clip could not be read."));
  if (originalSha256 !== tracking.original.sha256) fail("SOURCE_CHANGED", "The uploaded clip is not the file the tracking clip was made from.");

  const probe = await probeMedia(sourcePath).catch(() => fail("UNSUPPORTED_MEDIA", "Only MP4, MOV, M4V, 3GP, Matroska or WebM video files are accepted."));
  const source = await assertSourceContract(probe, sourcePath);
  if (source.displayWidth !== tracking.original.width || source.displayHeight !== tracking.original.height) fail("SOURCE_CHANGED", "The uploaded clip is not the file the tracking clip was made from.");
  // The same window arithmetic as normalizeOwnerClip, so the same source frames are selected.
  const window = input.startSeconds === undefined
    ? chooseClipWindow(source.durationSeconds, null, maxSeconds)
    : (() => {
      if (input.startSeconds >= source.durationSeconds) fail("INVALID_REQUEST", "The clip start is beyond the end of the video.");
      return { startSeconds: roundDownMs(input.startSeconds), durationSeconds: roundDownMs(Math.min(maxSeconds, source.durationSeconds - input.startSeconds)) };
    })();
  const windowFrames = Math.floor(window.durationSeconds * NORMALIZED_CLIP_FPS + 1e-6);
  if (windowFrames < MIN_WINDOW_FRAMES) fail("SOURCE_TOO_SHORT", "The selected clip window is shorter than half a second.");
  const windowSeconds = windowFrames / NORMALIZED_CLIP_FPS;

  const target = renderClipSize(source.displayWidth, source.displayHeight, cover);
  if (target.width <= tracking.width && target.height <= tracking.height) return null;

  await mkdir(outputDir, { recursive: true, mode: 0o700 }).catch(() => fail("INVALID_REQUEST", "The private clip directory could not be prepared."));
  const stem = `render-${tracking.sha256.slice(0, 32)}-${target.width}x${target.height}`;
  const finalPath = join(outputDir, `${stem}.mp4`);
  const tempVideo = join(outputDir, `.${stem}.${randomBytes(6).toString("hex")}.partial.mp4`);
  try {
    try {
      await runTool("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-autorotate", "1",
        "-ss", window.startSeconds.toFixed(3), "-t", windowSeconds.toFixed(6), ...inputArgs(sourcePath),
        "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
        "-vf", normalizationFilter(target, source.video, source.dynamicRange), "-r", String(NORMALIZED_CLIP_FPS), "-frames:v", String(windowFrames),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-maxrate", "40M", "-bufsize", "80M", "-profile:v", "high",
        "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
        "-g", String(NORMALIZED_CLIP_FPS), "-threads", "2",
        "-movflags", "+faststart", "-fs", String(2 * maxOutputBytes), "-f", "mp4", `file:${tempVideo}`,
      ], RENDER_TRANSCODE_TIMEOUT_MS);
    } catch {
      fail("TRANSCODE_FAILED", "The render-resolution clip could not be prepared locally.");
    }
    const encoded = await stat(tempVideo).catch(() => fail("TRANSCODE_FAILED", "The render-resolution clip could not be prepared locally."));
    if (encoded.size > maxOutputBytes) fail("OUTPUT_TOO_LARGE", `The render-resolution clip exceeded ${formatMiB(maxOutputBytes)}.`);
    const output = assertTrackingContract(await probeMedia(tempVideo).catch(() => fail("VERIFICATION_FAILED", "The render-resolution clip did not meet its output contract.")), MAX_READ_SIDE);
    if (output.width !== target.width || output.height !== target.height || output.frameCount !== tracking.frameCount) fail("VERIFICATION_FAILED", "The render-resolution clip does not repeat the tracking clip's frames.");
    await chmod(tempVideo, 0o600);
    const record: OwnerRenderClip = {
      version: 1, kind: "render_source", trackingSha256: tracking.sha256, sha256: await sha256File(tempVideo), path: finalPath,
      width: output.width, height: output.height, fps: NORMALIZED_CLIP_FPS, frameCount: output.frameCount,
    };
    if (!renderClipMatches(record, tracking)) fail("VERIFICATION_FAILED", "The render-resolution clip does not repeat the tracking clip's frames.");
    const after = await lstat(sourcePath).catch(() => fail("SOURCE_CHANGED", "The uploaded clip changed while it was being normalized."));
    if (!after.isFile() || !sameFile(before, after)) fail("SOURCE_CHANGED", "The uploaded clip changed while it was being normalized.");
    await rename(tempVideo, finalPath);
    return record;
  } catch (error) {
    await rm(tempVideo, { force: true }).catch(() => undefined);
    if (error instanceof OwnerClipError) throw error;
    throw new OwnerClipError("TRANSCODE_FAILED", "The render-resolution clip could not be prepared locally.");
  }
}

/** Re-hash the render source and re-check its contract against its tracking clip. Throws on any mismatch. */
export async function verifyRenderClip(render: OwnerRenderClip, tracking: NormalizedClip): Promise<void> {
  const bad = () => fail("VERIFICATION_FAILED", "The render-resolution clip no longer matches its recorded contract.");
  validClip(tracking);
  if (!renderClipMatches(render, tracking)) bad();
  const info = await lstat(render.path).catch(() => bad());
  if (!info.isFile() || info.size > MAX_RENDER_CLIP_BYTES) bad();
  if ((await sha256File(render.path).catch(() => bad())) !== render.sha256) bad();
  const output = assertTrackingContract(await probeMedia(render.path).catch(() => bad()), MAX_READ_SIDE);
  if (output.width !== render.width || output.height !== render.height || output.frameCount !== render.frameCount) bad();
}

// ---------------------------------------------------------------------------
// Frame access

export interface ReadClipFramesOptions {
  /** First frame (inclusive, default 0). */
  fromFrame?: number;
  /** Last frame (inclusive, default frameCount - 1). */
  toFrame?: number;
  /** Output size; defaults to the clip size. Uniform scaling is the caller's responsibility. */
  width?: number;
  height?: number;
  /** Maximum wait for the next decoded bytes while the consumer is waiting (default 30 s). */
  idleTimeoutMs?: number;
}

function framePlan(record: { path: string; width: number; height: number; frameCount: number }, options: ReadClipFramesOptions) {
  const fromFrame = options.fromFrame ?? 0;
  const toFrame = options.toFrame ?? record.frameCount - 1;
  const width = options.width ?? record.width;
  const height = options.height ?? record.height;
  const idleTimeoutMs = options.idleTimeoutMs ?? FRAME_IDLE_TIMEOUT_MS;
  if (![fromFrame, toFrame, width, height].every(Number.isInteger) || fromFrame < 0 || toFrame < fromFrame || toFrame >= record.frameCount) {
    fail("INVALID_REQUEST", "The requested frame range is outside the clip.");
  }
  if (width < 1 || height < 1 || width > MAX_READ_SIDE || height > MAX_READ_SIDE || width * height > MAX_READ_PIXELS) {
    fail("INVALID_REQUEST", "The requested frame size is outside the supported bounds.");
  }
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 100 || idleTimeoutMs > 600_000) fail("INVALID_REQUEST", "The frame read timeout is outside the supported bounds.");
  return { path: record.path, fromFrame, toFrame, width, height, idleTimeoutMs, count: toFrame - fromFrame + 1 };
}

/**
 * Decode frames as raw RGBA through an FFmpeg pipe. Each yielded buffer is exactly
 * width*height*4 bytes and owned by the consumer. FFmpeg is killed and reaped when
 * the consumer stops early, on error and on idle timeout. The file is not re-hashed
 * here; call verifyNormalizedClip at stage boundaries.
 */
export async function* readClipFrames(clip: NormalizedClip, options: ReadClipFramesOptions = {}): AsyncGenerator<ClipFrame, void, undefined> {
  yield* decodeFrames(framePlan(validClip(clip), options));
}

/** readClipFrames for a render source; frames default to the render source's own size. */
export async function* readRenderClipFrames(clip: OwnerRenderClip, options: ReadClipFramesOptions = {}): AsyncGenerator<ClipFrame, void, undefined> {
  const parsed = renderClipSchema.safeParse(clip);
  if (!parsed.success) fail("INVALID_REQUEST", "The clip record is not a valid render-resolution clip.");
  yield* decodeFrames(framePlan(parsed.data, options));
}

async function* decodeFrames(plan: ReturnType<typeof framePlan>): AsyncGenerator<ClipFrame, void, undefined> {
  const frameBytes = plan.width * plan.height * 4;
  const child = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2", ...inputArgs(plan.path),
    "-map", "0:v:0", "-an", "-sn", "-dn",
    // Normalized clips are BT.709 limited range by contract; decode them as such, not by swscale's BT.601 default.
    "-vf", `trim=start_frame=${plan.fromFrame}:end_frame=${plan.toFrame + 1},scale=${plan.width}:${plan.height}:flags=bicubic:in_color_matrix=bt709:in_range=tv,format=rgba`,
    "-fps_mode", "passthrough", "-frames:v", String(plan.count), "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ], { stdio: ["ignore", "pipe", "ignore"], env: toolEnv(), windowsHide: true });
  let spawnFailed = false;
  let rejectSpawn: (error: OwnerClipError) => void = () => undefined;
  const spawnError = new Promise<never>((_, reject) => { rejectSpawn = reject; });
  spawnError.catch(() => undefined);
  const closed = new Promise<{ code: number | null }>((resolveClose) => {
    child.once("error", () => {
      spawnFailed = true;
      rejectSpawn(new OwnerClipError("FRAME_READ_FAILED", "Clip frames could not be decoded locally. Check FFmpeg availability."));
      resolveClose({ code: null });
    });
    child.once("close", (code) => resolveClose({ code }));
  });
  const iterator = child.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const nextChunk = async (): Promise<IteratorResult<Buffer>> => {
    let timer: NodeJS.Timeout | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OwnerClipError("FRAME_READ_FAILED", "Clip frame decoding timed out.")), plan.idleTimeoutMs);
    });
    try {
      return await Promise.race([iterator.next(), spawnError, idle]);
    } catch (error) {
      if (error instanceof OwnerClipError) throw error;
      return fail("FRAME_READ_FAILED", "Clip frames could not be decoded locally.");
    } finally {
      clearTimeout(timer);
    }
  };

  let emitted = 0;
  let current = Buffer.allocUnsafe(frameBytes);
  let filled = 0;
  try {
    for (;;) {
      const next = await nextChunk();
      if (next.done) break;
      const chunk = next.value;
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(frameBytes - filled, chunk.length - offset);
        chunk.copy(current, filled, offset, offset + take);
        filled += take;
        offset += take;
        if (filled === frameBytes) {
          if (emitted >= plan.count) fail("FRAME_READ_FAILED", "The decoder produced more frames than requested.");
          const frame: ClipFrame = { frame: plan.fromFrame + emitted, width: plan.width, height: plan.height, rgba: current };
          emitted += 1;
          current = Buffer.allocUnsafe(frameBytes);
          filled = 0;
          yield frame;
        }
      }
    }
    const { code } = await closed;
    if (spawnFailed || code !== 0 || filled !== 0 || emitted !== plan.count) fail("FRAME_READ_FAILED", "Clip frames could not be decoded completely.");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.stdout.destroy();
    await Promise.race([closed, new Promise((resolveWait) => setTimeout(resolveWait, CHILD_CLOSE_GRACE_MS).unref())]);
  }
}

/** One frame as an RGB PNG, uniformly downscaled so its long side is at most maxSide (never upscaled). */
export async function extractClipFramePng(clip: NormalizedClip, frame: number, options: { maxSide?: number } = {}): Promise<Buffer> {
  const record = validClip(clip);
  const longSide = Math.max(record.width, record.height);
  const maxSide = options.maxSide ?? longSide;
  if (!Number.isInteger(maxSide) || maxSide < 16 || maxSide > MAX_READ_SIDE) fail("INVALID_REQUEST", "The poster size must be between 16 and 4096 pixels.");
  const scale = Math.min(1, maxSide / longSide);
  const width = Math.max(1, Math.round(record.width * scale));
  const height = Math.max(1, Math.round(record.height * scale));
  for await (const decoded of readClipFrames(clip, { fromFrame: frame, toFrame: frame, width, height })) {
    return sharp(decoded.rgba, { raw: { width, height, channels: 4 } }).removeAlpha().png().toBuffer();
  }
  return fail("FRAME_READ_FAILED", "The clip frame could not be decoded.");
}
