import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { probeMedia, videoDynamicRange, type MediaDynamicRange, type MediaProbeStream } from "./clip";
import { MEDIA_DEMUXER_ALLOWLIST, mediaToolEnv } from "./tool-env";

/**
 * One preview poster frame (PNG) from a private local video, for owner intake thumbnails and the
 * director's room. The source is untrusted: file protocol and allowlisted demuxers only, a minimal
 * child environment, bounded time and output. HDR (PQ/HLG) and BT.2020 sources are converted to
 * BT.709 SDR with the same zimg chain as clip normalization, so a phone's HDR footage is not
 * previewed as flat, washed-out BT.709 code values.
 */

const POSTER_TIMEOUT_MS = 20_000;
const POSTER_MAX_BUFFER = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

type ColourTags = Pick<MediaProbeStream, "colorPrimaries" | "colorSpace" | "colorTransfer">;

/**
 * The poster video filter. SDR keeps one swscale pass. BT.2020 SDR gets a gamut conversion; HDR is
 * linearized, converted to BT.709 primaries and Hable tone mapped. Both colour paths end in 8-bit
 * full-range BT.709 RGB, so the PNG encoder never reinterprets YCbCr with a guessed matrix.
 */
export function posterFilter(maxSide: number, dynamicRange: MediaDynamicRange, video: ColourTags | null): string {
  const scale = `scale=w=${maxSide}:h=${maxSide}:force_original_aspect_ratio=decrease`;
  if (dynamicRange === "sdr") return scale;
  // zimg needs a complete input description; fill only the properties the file leaves untagged.
  const inputs = [
    video?.colorPrimaries ? "" : "pin=bt2020",
    video?.colorSpace ? "" : "min=bt2020nc",
    video?.colorTransfer ? "" : "tin=bt709",
  ].filter(Boolean);
  const first = (options: string) => `zscale=${[...inputs, options].join(":")}`;
  const toRgb = ["format=gbrp", "format=rgb24", scale];
  if (dynamicRange === "wide_gamut_sdr") return [first("p=bt709:t=bt709:m=bt709:r=pc"), ...toRgb].join(",");
  return [
    first("t=linear:npl=100"),
    "format=gbrpf32le",
    "zscale=p=bt709",
    "tonemap=tonemap=hable:desat=0",
    "zscale=t=bt709:m=bt709:r=pc",
    ...toRgb,
  ].join(",");
}

/** Colour class of the first video stream; an unreadable probe is treated as SDR (the plain poster path). */
async function sourceColour(path: string): Promise<{ dynamicRange: MediaDynamicRange; video: ColourTags | null }> {
  try {
    const { video } = await probeMedia(path);
    return video ? { dynamicRange: videoDynamicRange(video), video } : { dynamicRange: "sdr", video: null };
  } catch { return { dynamicRange: "sdr", video: null }; }
}

function posterArgs(path: string, at: number, filter: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2",
    "-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_DEMUXER_ALLOWLIST,
    "-ss", at.toFixed(3), "-i", `file:${path}`,
    "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1",
    "-vf", filter,
    "-f", "image2pipe", "-c:v", "png", "pipe:1",
  ];
}

/**
 * PNG poster bytes, or null when no frame could be read. A frame about a third in (at most 1 s)
 * is preferred, then the first frame. If the colour conversion is unavailable (an FFmpeg build
 * without zscale), the plain SDR poster is used rather than no preview at all. Child errors carry
 * local paths and are never returned.
 */
export async function extractVideoPosterPng(path: string, durationSeconds: number | null, maxSide: number): Promise<Buffer | null> {
  if (!isAbsolute(path) || path.includes("\0") || !Number.isInteger(maxSide) || maxSide < 16 || maxSide > 4096) return null;
  const colour = await sourceColour(path);
  const filters = [posterFilter(maxSide, colour.dynamicRange, colour.video)];
  if (colour.dynamicRange !== "sdr") filters.push(posterFilter(maxSide, "sdr", null));
  const preferred = durationSeconds !== null && durationSeconds > 1.5 ? Math.min(1, durationSeconds / 3) : 0;
  for (const filter of filters) {
    for (const at of preferred > 0 ? [preferred, 0] : [0]) {
      try {
        const { stdout } = await execFileAsync("ffmpeg", posterArgs(path, at, filter), {
          encoding: "buffer", timeout: POSTER_TIMEOUT_MS, maxBuffer: POSTER_MAX_BUFFER, killSignal: "SIGKILL", windowsHide: true, env: mediaToolEnv(),
        });
        if (stdout.length > 8) return stdout;
      } catch { /* Try the next position or filter. */ }
    }
  }
  return null;
}
