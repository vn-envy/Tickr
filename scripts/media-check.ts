import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { bundle } from "@remotion/bundler";
import { getCompositions, openBrowser, renderStill } from "@remotion/renderer";
import sharp from "sharp";
import {
  assertLocalRasterAssetPath,
  REEL_COMPOSITION_ID,
  REEL_DURATION_SECONDS,
  REEL_FPS,
  REEL_HEIGHT,
  REEL_WIDTH,
} from "../lib/rendering/reel-contract";
import { installLocalRenderGuard, isLocalRenderUrl } from "../lib/rendering/local-network";

const execFileAsync = promisify(execFile);

async function main() {
  const outputDirectory = path.resolve(".data/media-check");
  const browserExecutable = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
  await mkdir(outputDirectory, { recursive: true });

  assertLocalRasterAssetPath("media/owner/photo-01.png");
  for (const rejected of ["https://example.com/photo.png", "//example.com/a.png", "media/../secret.png", "media/photo.svg", "media/photo.png?token=value"]) {
    assert.throws(() => assertLocalRasterAssetPath(rejected));
  }
  assert.equal(isLocalRenderUrl("http://127.0.0.1:3000/index.html"), true);
  assert.equal(isLocalRenderUrl("https://example.com/photo.png"), false);
  assert.equal(isLocalRenderUrl("http://127.0.0.1.example.com/photo.png"), false);

  const { stdout: ffmpegVersion } = await execFileAsync("ffmpeg", ["-version"]);
  const { stdout: chromiumVersion } = await execFileAsync(browserExecutable, ["--version"]);
  const serveUrl = await bundle({
    entryPoint: path.resolve("remotion/index.ts"),
    outDir: path.join(outputDirectory, "bundle"),
    enableCaching: true,
  });

  const browser = await openBrowser("chrome", {
    browserExecutable,
    logLevel: "error",
  });
  const network = installLocalRenderGuard(browser);
  try {
    const compositions = await getCompositions(serveUrl, {
      puppeteerInstance: browser,
      logLevel: "error",
      timeoutInMilliseconds: 30_000,
    });
    const composition = compositions.find((item) => item.id === REEL_COMPOSITION_ID);
    assert.ok(composition, "TickrReel must be registered.");
    assert.equal(composition.fps, REEL_FPS);
    assert.equal(composition.durationInFrames, REEL_DURATION_SECONDS * REEL_FPS);
    assert.equal(composition.width, REEL_WIDTH);
    assert.equal(composition.height, REEL_HEIGHT);
    for (const scene of ["HookScene", "ProofScene", "OccasionScene", "ActionScene"]) {
      assert.ok(compositions.some((item) => item.id === scene), `${scene} must be registered.`);
    }

    // A single diagnostic image validates browser rendering without creating a
    // finished video or pretending this fixture is a generated business pack.
    const stillPath = path.join(outputDirectory, "diagnostic.png");
    await renderStill({
      serveUrl,
      composition,
      output: stillPath,
      frame: 30,
      imageFormat: "png",
      scale: 0.5,
      puppeteerInstance: browser,
      logLevel: "error",
      timeoutInMilliseconds: 30_000,
      isProduction: false,
    });
    const metadata = await sharp(await readFile(stillPath)).metadata();
    assert.equal(metadata.width, REEL_WIDTH / 2);
    assert.equal(metadata.height, REEL_HEIGHT / 2);
    await network.assertClean();

    const report = {
      checkedAt: new Date().toISOString(),
      fixture: "synthetic rendering diagnostic, not a generated business campaign",
      ffmpeg: ffmpegVersion.split("\n")[0],
      chromium: chromiumVersion.trim(),
      composition: { id: composition.id, fps: composition.fps, frames: composition.durationInFrames, width: composition.width, height: composition.height },
      registeredScenes: compositions.filter((item) => item.id !== REEL_COMPOSITION_ID).map((item) => item.id),
      still: { path: path.relative(process.cwd(), stillPath), width: metadata.width, height: metadata.height },
      observedBrowserOrigins: [...network.observedOrigins],
      blockedBrowserOrigins: [...network.blockedOrigins],
      mp4ExportTested: false,
    };
    await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await browser.close({ silent: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Media check failed."}\n`);
  process.exitCode = 1;
});
