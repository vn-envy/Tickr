import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { openH264Encoder, probeVideo } from "../../lib/campaign/cinema/encode";
import { extractVideoPosterPng } from "../../lib/media/poster";
import { MEDIA_DEMUXER_ALLOWLIST, mediaToolEnv } from "../../lib/media/tool-env";
import { acceptOwnerUpload, ownerVideoProbeArgs, probeOwnerVideo } from "../../lib/media/uploads";

// All media here is synthetic (FFmpeg lavfi test patterns). The secrets are fake placeholder strings.
const run = promisify(execFile);
const SECRETS = {
  META_API_KEY: "synthetic-meta-api-key-for-env-test",
  META_APP_SECRET: "synthetic-meta-app-secret-for-env-test",
  TICKR_SECRET_KEY: "c3ludGhldGljLXRpY2tyLXNlY3JldC1mb3ItZW52LXRlc3Q=",
};
let root = "";
let spyDir = "";
let logDir = "";
let video = "";

/** A PATH entry whose ffmpeg/ffprobe record their environment and arguments, then run the real tool. */
async function installSpies() {
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const real = (await run("sh", ["-c", `command -v ${tool}`])).stdout.trim();
    const script = [
      "#!/bin/sh",
      `env > "${logDir}/${tool}-$$.env"`,
      `printf '%s\\n' "$@" > "${logDir}/${tool}-$$.args"`,
      `exec "${real}" "$@"`,
      "",
    ].join("\n");
    await writeFile(join(spyDir, tool), script);
    await chmod(join(spyDir, tool), 0o755);
  }
}

async function recorded(tool: "ffmpeg" | "ffprobe"): Promise<{ env: string; args: string[] }[]> {
  const names = (await readdir(logDir)).filter((name) => name.startsWith(`${tool}-`) && name.endsWith(".env"));
  return Promise.all(names.map(async (name) => ({
    env: await readFile(join(logDir, name), "utf8"),
    args: (await readFile(join(logDir, name.replace(/\.env$/, ".args")), "utf8")).split("\n"),
  })));
}

function expectNoSecrets(env: string) {
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(env).not.toContain(name);
    expect(env).not.toContain(value);
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tickr-tool-env-"));
  spyDir = join(root, "bin");
  logDir = join(root, "log");
  await run("mkdir", ["-p", spyDir, logDir]);
  await installSpies();
  video = join(root, "synthetic.mp4");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video], { timeout: 60_000 });
}, 90_000);

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const name of await readdir(logDir)) await rm(join(logDir, name), { force: true });
});

function stubServerEnvironment() {
  for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
  vi.stubEnv("PATH", `${spyDir}:${process.env.PATH ?? "/usr/bin:/bin"}`);
}

describe("FFmpeg child environment", () => {
  test("mediaToolEnv keeps only what a child needs to start", () => {
    const env = mediaToolEnv({ ...SECRETS, PATH: "/opt/bin:/usr/bin", NODE_ENV: "test", LD_LIBRARY_PATH: "/opt/lib", HOME: "/root", META_APP_ID: "123" });
    expect(env).toEqual({ PATH: "/opt/bin:/usr/bin", NODE_ENV: "test", LD_LIBRARY_PATH: "/opt/lib" });
  });

  test("the owner-upload ffprobe gets no server credentials and only allowlisted demuxers", async () => {
    expect(ownerVideoProbeArgs("/private/clip.mp4")).toEqual(expect.arrayContaining(["-protocol_whitelist", "file", "-format_whitelist", MEDIA_DEMUXER_ALLOWLIST]));
    stubServerEnvironment();
    await expect(probeOwnerVideo(video, "mp4")).resolves.toMatchObject({ width: 320, height: 240, videoCodec: "h264" });
    const libraryDir = join(root, "library");
    await run("mkdir", ["-p", libraryDir]);
    const accepted = await acceptOwnerUpload({
      bytes: await readFile(video), declaredMimeType: "video/mp4", libraryDir,
      consent: { ownsOrLicensedMedia: true, peopleVisibleHaveConsented: "no_people", attestedAt: new Date().toISOString() },
    });
    expect(accepted).toMatchObject({ kind: "video", container: "mp4" });
    const calls = await recorded("ffprobe");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expectNoSecrets(call.env);
      const index = call.args.indexOf("-format_whitelist");
      expect(index).toBeGreaterThanOrEqual(0);
      expect(call.args[index + 1]).toBe(MEDIA_DEMUXER_ALLOWLIST);
    }
  }, 60_000);

  test("the cinema encoder and its verification probe get no server credentials", async () => {
    stubServerEnvironment();
    const outputPath = join(root, "encoded.mp4");
    const encoder = openH264Encoder({ outputPath, width: 32, height: 32, fps: 10, expectedFrames: 2, preset: "ultrafast" });
    for (let frame = 0; frame < 2; frame++) await encoder.writeFrame(Buffer.alloc(32 * 32 * 4, frame * 60));
    await expect(encoder.finish()).resolves.toMatchObject({ frames: 2 });
    await expect(probeVideo(outputPath)).resolves.toMatchObject({ width: 32, height: 32 });
    const calls = [...await recorded("ffmpeg"), ...await recorded("ffprobe")];
    expect((await recorded("ffmpeg")).length).toBeGreaterThanOrEqual(1);
    expect((await recorded("ffprobe")).length).toBeGreaterThanOrEqual(1);
    for (const call of calls) expectNoSecrets(call.env);
  }, 60_000);

  test("preview posters run with no server credentials", async () => {
    stubServerEnvironment();
    const poster = await extractVideoPosterPng(video, 1, 120);
    expect(poster?.subarray(1, 4).toString("latin1")).toBe("PNG");
    const calls = [...await recorded("ffmpeg"), ...await recorded("ffprobe")];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) expectNoSecrets(call.env);
  }, 60_000);
});
