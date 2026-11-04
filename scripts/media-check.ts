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
import { probeVideo } from "../lib/campaign/cinema/encode";
import { assertLedger } from "../lib/campaign/cinema/ledger";
import { MAX_FOREGROUND_OCCLUSION, MAX_HEADLINE_OCCLUSION, renderStillDepthReel } from "../lib/campaign/cinema/still-depth";

const execFileAsync = promisify(execFile);

/**
 * Still-depth contract check on a synthetic, locally drawn still (a gradient "product"
 * on a textured wall) and its exact mask. Fully offline: no Meta call, no remote asset.
 */
async function checkStillDepthContract(outputDirectory: string) {
  const width = 1080, height = 1920;
  const shape = (fill: string) => `<g transform="translate(${width * 0.5} ${height * 0.55})"><path d="M -230 -260 L 230 -260 L 190 300 Q 0 360 -190 300 Z" fill="${fill}"/><ellipse cx="0" cy="-260" rx="230" ry="60" fill="${fill}"/><path d="M 225 -120 C 380 -120 380 140 205 140 L 210 80 C 300 80 300 -60 220 -60 Z" fill="${fill}"/></g>`;
  const scene = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6b8f71"/><stop offset="1" stop-color="#2f4858"/></linearGradient><pattern id="tex" width="36" height="36" patternUnits="userSpaceOnUse"><circle cx="9" cy="9" r="5" fill="#ffffff" fill-opacity="0.12"/></pattern><linearGradient id="product" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e8452c"/><stop offset="1" stop-color="#f29e38"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#wall)"/><rect width="${width}" height="${height}" fill="url(#tex)"/><rect y="${height * 0.72}" width="${width}" height="${height * 0.28}" fill="#8a6a4a"/>${shape("url(#product)")}</svg>`;
  const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#000"/>${shape("#fff")}</svg>`;
  const outputPath = path.join(outputDirectory, "still-depth-diagnostic.mp4");
  const coverPath = path.join(outputDirectory, "still-depth-diagnostic-cover.png");
  const startedAt = Date.now();
  const result = await renderStillDepthReel({
    source: await sharp(Buffer.from(scene)).png().toBuffer(),
    subjectMask: await sharp(Buffer.from(mask)).greyscale().threshold(128).png().toBuffer(),
    scenes: [
      { kicker: "Synthetic diagnostic", headline: "Depth headline check", body: "Synthetic rendering diagnostic, not a business claim." },
      { kicker: "Synthetic diagnostic", headline: "Push-in proof scene", body: "Synthetic rendering diagnostic." },
      { kicker: "Synthetic diagnostic", headline: "Parallax value scene", body: "Synthetic rendering diagnostic." },
      { kicker: "Synthetic diagnostic", headline: "End card check", body: "Synthetic rendering diagnostic." },
    ],
    cta: "Diagnostic only", businessName: "Synthetic Diagnostic", campaignName: "Media check", mode: "synthetic",
    provenanceLabel: "Source cutout · synthetic diagnostic", theme: { paper: "#F5F2EC", ink: "#243B43", accent: "#B65A35", soft: "#CBD8D4" },
    outputPath, coverPath,
  });
  const elapsedMs = Date.now() - startedAt;
  const probe = await probeVideo(outputPath);
  assert.deepEqual([probe.width, probe.height, probe.codec, probe.frameRate, probe.frames, probe.audioStreams], [REEL_WIDTH, REEL_HEIGHT, "h264", `${REEL_FPS}/1`, REEL_DURATION_SECONDS * REEL_FPS, 0]);
  assert.ok(Math.abs(probe.durationSeconds - REEL_DURATION_SECONDS) <= 0.1, "Still-depth Reel duration must be 12.0 s.");
  const cover = await sharp(await readFile(coverPath)).metadata();
  assert.equal(cover.width, REEL_WIDTH);
  assert.equal(cover.height, REEL_HEIGHT);
  assertLedger(result.ledger);
  assert.equal(result.ledger.frames, REEL_DURATION_SECONDS * REEL_FPS);
  assert.equal(result.ledger.generatedPixelsOnSubject, 0);
  assert.ok(result.ledger.maxSubjectOcclusion <= MAX_FOREGROUND_OCCLUSION, "Foreground graphics must not hide more than 10% of the subject.");
  assert.equal(result.layout.hookHeadline.placement, "behind_subject", "The depth headline must sit behind the subject.");
  assert.ok(result.layout.hookHeadline.occlusion <= MAX_HEADLINE_OCCLUSION, "The depth headline must stay readable.");
  assert.deepEqual(result.qa.violations, [], "The still-depth Reel must not raise review violations.");
  return {
    fixture: "synthetic still-depth diagnostic, not a generated business campaign",
    video: { path: path.relative(process.cwd(), outputPath), ...probe, sha256: result.reel.sha256 },
    cover: { path: path.relative(process.cwd(), coverPath), width: cover.width, height: cover.height },
    ledger: result.ledger,
    layout: result.layout,
    qa: result.qa,
    elapsedMs,
  };
}

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
  const stillDepth = await checkStillDepthContract(outputDirectory);
  // Recorded on its own so the offline compositor evidence survives a missing browser below.
  await writeFile(path.join(outputDirectory, "still-depth-report.json"), `${JSON.stringify({ checkedAt: new Date().toISOString(), stillDepth }, null, 2)}\n`);
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
      stillDepth,
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
