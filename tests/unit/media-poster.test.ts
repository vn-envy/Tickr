import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { videoPosterPng } from "../../lib/autopilot/business-media";
import { videoPoster } from "../../lib/autopilot/harvest";
import { normalizeOwnerClip, probeMedia, videoDynamicRange } from "../../lib/media/clip";
import { posterFilter } from "../../lib/media/poster";
import { MEDIA_DEMUXER_ALLOWLIST } from "../../lib/media/tool-env";

// Every input is synthetic: static FFmpeg lavfi colour bars, encoded locally with HDR colour tags.
const run = promisify(execFile);
const consent = { ownsOrLicensedMedia: true as const, peopleVisibleHaveConsented: "no_people" as const, attestedAt: "2026-11-04T00:00:00.000Z" };
let root = "";
const fixture = (name: string) => join(root, name);

async function bars(name: string, codecArgs: string[]) {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "smptehdbars=size=320x240:rate=30:duration=1", ...codecArgs, fixture(name)], { timeout: 120_000 });
}
const hevc10 = (transfer: string) => [
  "-vf", "format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast", "-tag:v", "hvc1",
  "-x265-params", `log-level=error:colorprim=bt2020:transfer=${transfer}:colormatrix=bt2020nc`,
  "-color_primaries", "bt2020", "-color_trc", transfer, "-colorspace", "bt2020nc",
];

/** Mean absolute 8-bit RGB difference after both pictures are fitted to 320x240. */
async function meanDifference(a: Buffer | string, b: Buffer | string): Promise<number> {
  const pixels = (input: Buffer | string) => sharp(input).removeAlpha().resize(320, 240, { fit: "fill" }).raw().toBuffer();
  const [left, right] = await Promise.all([pixels(a), pixels(b)]);
  let total = 0;
  for (let index = 0; index < left.length; index++) total += Math.abs(left[index] - right[index]);
  return total / left.length;
}

/** The pre-fix poster: the same frame with one swscale pass and no colour conversion. */
async function untonemappedPoster(path: string): Promise<Buffer> {
  const { stdout } = await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_DEMUXER_ALLOWLIST,
    "-ss", "0.333", "-i", `file:${path}`, "-map", "0:v:0", "-an", "-frames:v", "1",
    "-vf", posterFilter(480, "sdr", null), "-f", "image2pipe", "-c:v", "png", "pipe:1",
  ], { encoding: "buffer", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tickr-poster-"));
  await Promise.all([
    bars("pq.mp4", hevc10("smpte2084")),
    bars("hlg.mov", hevc10("arib-std-b67")),
    bars("sdr.mp4", ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]),
  ]);
}, 180_000);

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("video preview posters", () => {
  test("the poster filter tone maps HDR, converts BT.2020 SDR and leaves SDR as one scale", () => {
    expect(posterFilter(480, "sdr", null)).toBe("scale=w=480:h=480:force_original_aspect_ratio=decrease");
    const hdr = posterFilter(480, "hdr", { colorPrimaries: "bt2020", colorSpace: "bt2020nc", colorTransfer: "smpte2084" });
    expect(hdr).toContain("tonemap=tonemap=hable");
    expect(hdr).toContain("zscale=p=bt709");
    expect(hdr).not.toMatch(/pin=|min=|tin=/);
    expect(hdr.endsWith("format=rgb24,scale=w=480:h=480:force_original_aspect_ratio=decrease")).toBe(true);
    const untagged = posterFilter(240, "wide_gamut_sdr", { colorPrimaries: "bt2020", colorSpace: null, colorTransfer: null });
    expect(untagged).toMatch(/^zscale=min=bt2020nc:tin=bt709:p=bt709:t=bt709:m=bt709:r=pc,/);
    expect(untagged).not.toContain("tonemap");
  });

  // Reference: the clip normalizer's own poster, which is already tone mapped to BT.709 SDR. The
  // absolute tolerances leave room for FFmpeg/zimg build differences; for HDR the relative check
  // (strictly closer to the reference than the unconverted poster) is what pins the fix.
  test.each([["pq.mp4", 10], ["hlg.mov", 8], ["sdr.mp4", 6]] as const)("intake and harvest thumbnails of %s match the tone-mapped clip poster", async (name, tolerance) => {
    const source = await probeMedia(fixture(name));
    const hdr = name !== "sdr.mp4";
    expect(videoDynamicRange(source.video!)).toBe(hdr ? "hdr" : "sdr");
    const clip = await normalizeOwnerClip({ sourcePath: fixture(name), outputDir: join(root, `out-${name}`), consent });
    const unconverted = hdr ? await meanDifference(await untonemappedPoster(fixture(name)), clip.posterPath) : null;
    for (const poster of [await videoPosterPng(fixture(name), 1), await videoPoster(fixture(name), 1)]) {
      const metadata = await sharp(poster).metadata();
      expect([metadata.format, metadata.width, metadata.height]).toEqual(["png", 480, 360]);
      const difference = await meanDifference(poster, clip.posterPath);
      expect(difference).toBeLessThan(tolerance);
      if (unconverted !== null) expect(difference).toBeLessThan(unconverted * 0.85);
    }
  }, 120_000);
});
