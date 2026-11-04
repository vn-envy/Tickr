import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { probeVideo } from "../../lib/campaign/cinema/encode";
import { dilateMask, erodeMask, fillBehindSubject } from "../../lib/campaign/cinema/fill";
import { assertLedger, CompositionLedgerAccumulator, LedgerCanvas, LedgerInvariantError, measureLedgerFrame } from "../../lib/campaign/cinema/ledger";
import { measureText, svgDocument, textBlock, wrapText } from "../../lib/campaign/cinema/typography";
import {
  GENERATED_BACKDROP_LABEL, MAX_FOREGROUND_OCCLUSION, MAX_HEADLINE_LINE_OCCLUSION, MAX_HEADLINE_OCCLUSION, prepareStillDepth, renderStillDepthFrame, renderStillDepthReel,
  STILL_DEPTH_COVER_FRAME, STILL_DEPTH_FRAMES, STILL_DEPTH_LABEL_BANDS, type StillDepthComposer, type StillDepthInput,
} from "../../lib/campaign/cinema/still-depth";

const W = 1080, H = 1920;

/** A synthetic "product" (gradient mug) on a textured synthetic wall and counter. Not a business photo. */
async function syntheticStill(width: number, height: number, productScale = 1): Promise<{ source: Buffer; subjectMask: Buffer }> {
  const scale = Math.min(width, height) / 1080 * productScale;
  const shape = (fill: string) => `<g transform="translate(${width * 0.5} ${height * 0.55}) scale(${scale})"><path d="M -230 -260 L 230 -260 L 190 300 Q 0 360 -190 300 Z" fill="${fill}"/><ellipse cx="0" cy="-260" rx="230" ry="60" fill="${fill}"/><path d="M 225 -120 C 380 -120 380 140 205 140 L 210 80 C 300 80 300 -60 220 -60 Z" fill="${fill}"/></g>`;
  const scene = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>
<linearGradient id="wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6b8f71"/><stop offset="1" stop-color="#2f4858"/></linearGradient>
<pattern id="tex" width="${36 * scale}" height="${36 * scale}" patternUnits="userSpaceOnUse"><circle cx="${9 * scale}" cy="${9 * scale}" r="${5 * scale}" fill="#ffffff" fill-opacity="0.12"/><path d="M0 ${30 * scale} L${36 * scale} ${24 * scale}" stroke="#000" stroke-opacity="0.15" stroke-width="${3 * scale}"/></pattern>
<linearGradient id="product" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e8452c"/><stop offset="0.6" stop-color="#f29e38"/><stop offset="1" stop-color="#b8231a"/></linearGradient></defs>
<rect width="${width}" height="${height}" fill="url(#wall)"/><rect width="${width}" height="${height}" fill="url(#tex)"/><rect y="${height * 0.72}" width="${width}" height="${height * 0.28}" fill="#8a6a4a"/>${shape("url(#product)")}</svg>`;
  const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#000"/>${shape("#fff")}</svg>`;
  return { source: await sharp(Buffer.from(scene)).png().toBuffer(), subjectMask: await sharp(Buffer.from(mask)).greyscale().threshold(128).png().toBuffer() };
}

function input(still: { source: Buffer; subjectMask: Buffer }, dir: string, extra: Partial<StillDepthInput> = {}): StillDepthInput {
  return {
    ...still, mode: "synthetic", provenanceLabel: "Source cutout · synthetic fixture",
    scenes: [
      { kicker: "Synthetic hook", headline: "Pour-over, slowly", body: "Synthetic fixture copy for the hook scene." },
      { kicker: "Synthetic proof", headline: "Every cup weighed and timed", body: "Synthetic fixture copy <b>&amp;</b> escaped." },
      { kicker: "Synthetic value", headline: "Ten quiet minutes in a loud week", body: "A window seat and nobody rushing you out the door." },
      { kicker: "Synthetic CTA", headline: "Your table is waiting", body: "Synthetic fixture details, not a real address." },
    ],
    cta: "Reserve a seat", businessName: "Synthetic Fixture Cafe", campaignName: "Synthetic fixture campaign",
    theme: { paper: "#F5EEDF", ink: "#263A30", accent: "#BB4D2F", soft: "#E1C69E" },
    outputPath: join(dir, "reel.mp4"), coverPath: join(dir, "cover.png"),
    ...extra,
  };
}

async function raw(png: Buffer, channels: 1 | 3): Promise<Buffer> {
  const image = sharp(png).removeAlpha();
  return (channels === 1 ? image.greyscale().extractChannel(0) : image).raw().toBuffer();
}

describe("fillBehindSubject", () => {
  test("leaves pixels outside the dilated mask byte-identical and removes the subject colour inside", () => {
    const width = 160, height = 120;
    const rgba = Buffer.alloc(width * height * 4), mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x, subject = (x - 80) ** 2 + (y - 60) ** 2 < 30 ** 2;
      mask[i] = subject ? 255 : 0;
      // Textured blue/green synthetic background; pure red subject.
      rgba.set(subject ? [235, 20, 20, 255] : [20 + (x * 3 % 40), 90 + ((x + y) % 2) * 30, 150 + y % 50, 255], i * 4);
    }
    const filled = fillBehindSubject(rgba, mask, width, height, { dilatePx: 3, blurSigma: 4 });
    expect(fillBehindSubject(rgba, mask, width, height, { dilatePx: 3, blurSigma: 4 })).toEqual(filled);
    const hole = dilateMask(mask, width, height, 3);
    let inside = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!hole[i]) { expect(filled.subarray(i * 4, i * 4 + 4)).toEqual(rgba.subarray(i * 4, i * 4 + 4)); continue; }
      inside++;
      const [r, g, b] = filled.subarray(i * 4, i * 4 + 3);
      expect(r).toBeLessThan(90);
      expect(b).toBeGreaterThan(g * 0.8);
    }
    expect(inside).toBeGreaterThan(Math.PI * 30 ** 2 * 0.95);
  });

  test("rejects mismatched geometry and erodes/dilates symmetrically", () => {
    expect(() => fillBehindSubject(Buffer.alloc(16), new Uint8Array(3), 2, 2, { dilatePx: 1, blurSigma: 1 })).toThrow("Fill buffers do not match");
    const mask = new Uint8Array(21 * 21);
    mask[10 * 21 + 10] = 255;
    expect(dilateMask(mask, 21, 21, 3).reduce((sum, value) => sum + value, 0)).toBe(29);
    const disk = Uint8Array.from(dilateMask(mask, 21, 21, 5), (value) => value * 255);
    const eroded = erodeMask(disk, 21, 21, 2);
    expect(eroded.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(9);
    expect(eroded.every((value, i) => !value || disk[i] === 255)).toBe(true);
  });
});

describe("composition ledger", () => {
  test("tracks visible class weights, occlusion and cropping", () => {
    const canvas = new LedgerCanvas(10, 10);
    const full = new Float32Array(100).fill(1), half = new Float32Array(100), quarter = new Float32Array(100);
    for (let i = 0; i < 50; i++) half[i] = 1;
    for (let i = 0; i < 25; i++) quarter[i] = 1;
    canvas.over("generated", full);
    canvas.over("subject", half);
    canvas.addSubjectInstance({ insideArea: 50, totalArea: 60 });
    canvas.over("foreground_graphics", quarter, 0.5);
    const stats = measureLedgerFrame(canvas);
    expect(stats.generatedFraction).toBeCloseTo(0.5);
    expect(stats.subjectFraction).toBeCloseTo(0.375);
    expect(stats.foregroundFraction).toBeCloseTo(0.125);
    expect(stats.subjectOcclusion).toBeCloseTo(0.25);
    expect(stats.subjectCropped).toBe(true);
    expect(() => canvas.over("generated", full)).toThrow(LedgerInvariantError);

    const accumulator = new CompositionLedgerAccumulator();
    accumulator.addFrame(canvas);
    accumulator.addFrame(new LedgerCanvas(10, 10));
    // A deliberate full-frame wash hides the subject without counting as a lost subject.
    const washed = new LedgerCanvas(10, 10);
    washed.over("treated_source", full);
    washed.over("subject", half);
    washed.over("transition", full, 0.999);
    expect(measureLedgerFrame(washed)).toMatchObject({ withoutSubject: false, subjectHiddenByTransition: true });
    accumulator.addFrame(washed);
    const ledger = accumulator.finish();
    expect(ledger).toMatchObject({ frames: 3, framesSubjectCropped: 1, framesWithoutSubject: 1, generatedPixelsOnSubject: 0, maxSubjectOcclusion: 0.25 });
    expect(accumulator.framesSubjectHiddenByTransition).toBe(1);
    expect(() => assertLedger({ ...ledger, generatedPixelsOnSubject: 1 as 0 })).toThrow("Generated pixels were placed on the subject.");
  });

  test("mixes keep crop records only for subjects that stay visible", () => {
    const half = new Float32Array(100), rest = new Float32Array(100);
    for (let i = 0; i < 100; i++) (i < 50 ? half : rest)[i] = 1;
    const outgoing = () => { const canvas = new LedgerCanvas(10, 10); canvas.over("subject", half); canvas.addSubjectInstance({ insideArea: 50, totalArea: 50 }); return canvas };
    const incoming = new LedgerCanvas(10, 10);
    incoming.over("subject", rest);
    incoming.addSubjectInstance({ insideArea: 10, totalArea: 50 });
    // The mask reveals only background of the incoming scene: its cropped subject stays invisible.
    const early = outgoing();
    early.mix(incoming, Float32Array.from(half, (value) => value * 0.5));
    expect(measureLedgerFrame(early).subjectCropped).toBe(false);
    // Once the incoming subject is revealed, its crop counts; the fully masked outgoing draw is dropped.
    const late = outgoing();
    late.mix(incoming, new Float32Array(100).fill(1));
    expect(late.subjectInstances).toEqual([{ insideArea: 10, totalArea: 50 }]);
    expect(measureLedgerFrame(late).subjectCropped).toBe(true);
  });
});

describe("typography", () => {
  test("escapes text, wraps inside the column and measures real DejaVu advances", () => {
    const laid = textBlock({ text: `<script>alert("x")</script> & a very long headline that must wrap`, x: 40, top: 100, maxWidth: 400, maxLines: 4, preferredSize: 48, face: "serif", color: "#112233" });
    expect(laid.svg).not.toContain("<script>");
    expect(laid.svg).toContain("&lt;script&gt;");
    expect(laid.boxes.every((box) => box.width <= 400 && box.x === 40)).toBe(true);
    expect(laid.boxes[1].y).toBeGreaterThan(laid.boxes[0].y);
    expect(measureText("MW", 100, "sans")).toBeCloseTo((1767 + 2025) / 2048 * 100);
    expect(wrapText("one two three four five six", { face: "sans", size: 40, maxWidth: 120, maxLines: 2 }).truncated).toBe(true);
    // A word wider than the column is flagged when split, and fitting prefers a size that keeps words whole.
    expect(wrapText("Mornings", { face: "serif", size: 178, maxWidth: 500, maxLines: 3 })).toMatchObject({ truncated: false, brokenWords: true });
    const whole = textBlock({ text: "Slow mornings", x: 0, top: 0, maxWidth: 500, maxLines: 3, preferredSize: 178, minSize: 80, face: "serif", color: "#112233" });
    expect(whole).toMatchObject({ truncated: false, brokenWords: false, lines: ["Slow", "mornings"] });
    expect(textBlock({ text: "x", x: 0, top: 0, maxWidth: 100, maxLines: 1, preferredSize: 20, face: "sans", color: "url(#evil)" }).svg).toContain('fill="#000000"');
  });
});

describe("still-depth Reel", () => {
  let dir = "";
  let composer: StillDepthComposer;
  let still: { source: Buffer; subjectMask: Buffer };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tickr-still-depth-"));
    // 720×1280 is 9:16, so the base window is the whole photo scaled ×1.5.
    still = await syntheticStill(720, 1280);
    composer = await prepareStillDepth(input(still, dir));
  }, 60_000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test("hook frame 0 reproduces the source RGB inside the eroded mask (identity subject transform)", async () => {
    const frame = composer.renderFrame(0);
    const expected = await sharp(still.source).resize(W, H, { kernel: "lanczos3" }).removeAlpha().raw().toBuffer();
    const maskBig = await raw(await sharp(still.subjectMask).resize(W, H, { kernel: "nearest" }).png().toBuffer(), 1);
    const interior = erodeMask(maskBig, W, H, 6);
    let count = 0, total = 0, worst = 0;
    for (let y = STILL_DEPTH_LABEL_BANDS.top.bottom; y < STILL_DEPTH_LABEL_BANDS.bottom.top; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!interior[i]) continue;
      for (let c = 0; c < 3; c++) { const d = Math.abs(frame[i * 4 + c] - expected[i * 3 + c]); total += d; worst = Math.max(worst, d); }
      count++;
    }
    expect(count).toBeGreaterThan(100_000);
    expect(total / (count * 3)).toBeLessThan(2.5);
    expect(worst).toBeLessThan(24);
  });

  test("SAM specks and pin-holes never reach the cutout; the supplied mask is untouched and the refinement is reported", async () => {
    const mask = await raw(still.subjectMask, 1);
    expect(mask[704 * 720 + 360]).toBe(255);
    const noisy = Buffer.from(mask);
    // 3×3 specks on the wall and the counter, 2×2 pin-holes inside the product.
    for (const [x, y] of [[50, 300], [650, 200], [100, 1100]]) for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) noisy[(y + dy) * 720 + x + dx] = 255;
    for (const [x, y] of [[360, 700], [330, 650]]) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) noisy[(y + dy) * 720 + x + dx] = 0;
    const noisyPng = await sharp(noisy, { raw: { width: 720, height: 1280, channels: 1 } }).png().toBuffer();
    const pngBefore = Buffer.from(noisyPng);
    const refined = await prepareStillDepth(input({ ...still, subjectMask: noisyPng }, dir));
    expect(noisyPng.equals(pngBefore)).toBe(true);
    expect(refined.layout.subjectMask).toMatchObject({ removedComponents: 3, removedPixels: 27, filledHoles: 2, filledPixels: 8 });
    expect(refined.layout.subjectMask.edgeSigma).toBeGreaterThan(0);
    expect(composer.layout.subjectMask).toMatchObject({ removedComponents: 0, filledHoles: 0 });
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    for (const frame of [0, 100, 300]) expect(digest(refined.renderFrame(frame)), `frame ${frame}`).toBe(digest(composer.renderFrame(frame)));
  }, 120_000);

  test("every sampled frame keeps the concept and provenance chips on top", () => {
    for (const frame of [0, 45, 87, 90, 150, 179, 230, 266, 270, 359]) {
      const rgba = composer.renderFrame(frame);
      for (const band of [STILL_DEPTH_LABEL_BANDS.top, STILL_DEPTH_LABEL_BANDS.bottom]) {
        // A dark chip with light lettering: mostly dark pixels plus a share of high-contrast glyph pixels.
        let dark = 0, light = 0, n = 0;
        for (let y = band.top + 4; y < band.bottom - 4; y++) for (let x = 64; x < 300; x++) {
          const o = (y * W + x) * 4, luma = rgba[o] * 0.2126 + rgba[o + 1] * 0.7152 + rgba[o + 2] * 0.0722;
          if (luma < 100) dark++; if (luma > 170) light++; n++;
        }
        expect(dark / n, `frame ${frame}`).toBeGreaterThan(0.4);
        expect(light / n, `frame ${frame}`).toBeGreaterThan(0.02);
      }
    }
  });

  test("layout keeps the depth headline and the subject readable, and frames are deterministic", () => {
    expect(composer.layout.hookHeadline.placement).toBe("behind_subject");
    expect(composer.layout.hookHeadline.occlusion).toBeLessThanOrEqual(MAX_HEADLINE_OCCLUSION);
    expect(Math.max(...composer.layout.foregroundOcclusion)).toBeLessThanOrEqual(MAX_FOREGROUND_OCCLUSION);
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    expect(digest(composer.renderFrame(200))).toBe(digest(composer.renderFrame(200)));
    for (const frame of [0, 88, 180, 268, 359]) {
      const stats = measureLedgerFrame(composer.analyzeFrame(frame));
      expect(stats.generatedFraction).toBe(0);
      expect(stats.subjectOcclusion).toBeLessThanOrEqual(MAX_FOREGROUND_OCCLUSION);
    }
  });

  test("a generated backdrop is disclosed on every frame and stays underneath the real subject for the whole Reel", async () => {
    const backdrop = await sharp({ create: { width: 540, height: 960, channels: 3, background: "#4a3a6a" } }).png().toBuffer();
    const withPlate = await prepareStillDepth(input(still, dir, { backdrop }));
    expect(withPlate.layout.usesGeneratedBackdrop).toBe(true);
    // The caller's label says "source cutout" only; the renderer appends the fixed disclosure.
    expect(withPlate.layout.provenanceLabel).toBe(`Source cutout · synthetic fixture · ${GENERATED_BACKDROP_LABEL}`);
    expect(composer.layout.provenanceLabel).toBe("Source cutout · synthetic fixture");
    const stats = measureLedgerFrame(withPlate.analyzeFrame(225));
    expect(stats.generatedFraction).toBeGreaterThan(0.2);
    expect(stats.subjectFraction).toBeGreaterThan(0.02);
    expect(measureLedgerFrame(withPlate.analyzeFrame(30)).generatedFraction).toBe(0);
    // Full provenance replay: the generated plate never lands on subject pixels (the ledger throws if it does).
    const accumulator = new CompositionLedgerAccumulator();
    for (let frame = 0; frame < STILL_DEPTH_FRAMES; frame++) accumulator.addFrame(withPlate.analyzeFrame(frame));
    const ledger = accumulator.finish();
    expect(ledger.meanGeneratedFraction).toBeGreaterThan(0);
    expect(ledger.generatedPixelsOnSubject).toBe(0);
    expect(ledger.maxSubjectOcclusion).toBeLessThanOrEqual(MAX_FOREGROUND_OCCLUSION);
    expect(ledger.framesWithoutSubject).toBe(0);
    // A label that already discloses generation is kept as written.
    const labelled = await prepareStillDepth(input(still, dir, { backdrop, provenanceLabel: "Source cutout · generated backdrop" }));
    expect(labelled.layout.provenanceLabel).toBe("Source cutout · generated backdrop");
  }, 120_000);

  test("a landscape photo with a large centred product keeps the depth headline behind the subject", async () => {
    // 4:3 landscape with a product filling most of the 9:16 window: the typical listing/phone framing.
    const landscape = await prepareStillDepth(input(await syntheticStill(1600, 1200, 1.35), dir));
    const { hookHeadline } = landscape.layout;
    expect(hookHeadline.placement).toBe("behind_subject");
    expect(hookHeadline.occlusion).toBeLessThanOrEqual(MAX_HEADLINE_OCCLUSION);
    expect(hookHeadline.foregroundOcclusion).toBe(0);
    expect(hookHeadline.subjectScale).toBeLessThanOrEqual(1);
    expect(landscape.layout.truncatedText).not.toContain("hook.headline");
    const accumulator = new CompositionLedgerAccumulator();
    for (let frame = 0; frame < STILL_DEPTH_FRAMES; frame++) accumulator.addFrame(landscape.analyzeFrame(frame));
    const ledger = accumulator.finish();
    expect(ledger.maxSubjectOcclusion).toBeLessThanOrEqual(MAX_FOREGROUND_OCCLUSION);
    expect(ledger.framesWithoutSubject).toBe(0);
    // The fade through the accent colour hides the subject on purpose; that is reported separately.
    expect(accumulator.framesSubjectHiddenByTransition).toBeGreaterThan(0);
    expect(accumulator.framesSubjectHiddenByTransition).toBeLessThanOrEqual(4);
  }, 120_000);

  // Regression (live round 2): the cup hid "warm cups" in the hook because a line could lose up to half
  // its letters and the whole headline 35%. Measured independently on rendered frames: the headline's own
  // glyph raster at its reported place, against the (red/orange) synthetic product pixels in the frame.
  test("the hook headline stays readable in every rendered hook frame: no line loses its words behind the product", async () => {
    const LINE_CAP = 0.2, WHOLE_CAP = 0.25;
    expect(MAX_HEADLINE_OCCLUSION).toBeLessThanOrEqual(WHOLE_CAP);
    expect(MAX_HEADLINE_LINE_OCCLUSION).toBeLessThanOrEqual(LINE_CAP);
    const headline = "Slow mornings, warm cups";
    const scenesWith = input(still, dir).scenes.map((scene, index) => index === 0 ? { ...scene, headline } : scene);
    for (const fixture of [still, await syntheticStill(720, 1280, 1.25), await syntheticStill(1600, 1200, 1.35)]) {
      const reel = await prepareStillDepth(input(fixture, dir, { scenes: scenesWith }));
      const report = reel.layout.hookHeadline;
      if (report.placement === "in_front") { expect(report.occlusion).toBe(0); continue; }
      expect(report.occlusion).toBeLessThanOrEqual(WHOLE_CAP);
      expect(report.lineOcclusion).toBeLessThanOrEqual(LINE_CAP);
      const column = report.column === "full" ? { x: 60, width: W - 128, anchor: "start" as const, lines: 3 }
        : report.column === "left" ? { x: 60, width: Math.round(W * 0.58), anchor: "start" as const, lines: 4 } : { x: W - 60, width: Math.round(W * 0.58), anchor: "end" as const, lines: 4 };
      const laid = textBlock({ text: headline, x: column.x, top: report.top, maxWidth: column.width, maxLines: column.lines, preferredSize: report.fontSize, minSize: report.fontSize, face: "serif", color: "#F5EEDF", lineHeight: 1.02, anchor: column.anchor });
      const glyphs = await sharp(Buffer.from(svgDocument(W, H, laid.svg))).ensureAlpha().extractChannel(3).raw().toBuffer();
      // Every entrance frame once the headline is visible (opacity >= 0.25; it still rises up to 44 px
      // then), then frames to the end of the hook zoom (before the wipe). Mirrors appear(t, 0.22, 0.75, 44).
      const entrance = (frame: number) => { const e = 1 - (1 - Math.min(1, Math.max(0, (frame / 30 - 0.22) / 0.75))) ** 3; return { opacity: e, dy: Math.round((1 - e) * 44) }; };
      const frames = [...Array.from({ length: 31 }, (_, frame) => frame).filter((frame) => entrance(frame).opacity >= 0.25), 55, 83];
      expect(frames.length).toBeGreaterThan(20);
      for (const frame of frames) {
        const rgba = reel.renderFrame(frame);
        const { dy } = entrance(frame);
        laid.boxes.forEach((box, line) => {
          let total = 0, hidden = 0;
          for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(H, Math.ceil(box.y + box.height)); y++) for (let x = 0; x < W; x++) {
            if (glyphs[y * W + x] < 160 || y + dy >= H) continue;
            total++;
            const o = ((y + dy) * W + x) * 4;
            if (rgba[o] > 120 && rgba[o] - rgba[o + 2] > 90) hidden++;
          }
          expect(total, `line ${line}`).toBeGreaterThan(200);
          expect(hidden / total, `frame ${frame} (rise ${dy}), line ${line} "${box.text}"`).toBeLessThanOrEqual(LINE_CAP);
        });
      }
    }
  }, 180_000);

  test("rejects invalid inputs with fixed messages", async () => {
    const other = await syntheticStill(360, 640);
    const empty = await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#000" } }).png().toBuffer();
    await expect(prepareStillDepth(input({ source: still.source, subjectMask: other.subjectMask }, dir))).rejects.toThrow("The subject mask must match the source dimensions.");
    await expect(prepareStillDepth(input({ source: still.source, subjectMask: empty }, dir))).rejects.toThrow("The subject mask is empty");
    await expect(prepareStillDepth(input({ source: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), subjectMask: still.subjectMask }, dir))).rejects.toThrow("The source must be a PNG raster.");
    await expect(prepareStillDepth({ ...input(still, dir), scenes: [] })).rejects.toThrow("The still-depth Reel input is invalid.");
    await expect(prepareStillDepth({ ...input(still, dir), outputPath: "relative.mp4" })).rejects.toThrow("The still-depth Reel input is invalid.");
    await expect(renderStillDepthFrame(input(still, dir), STILL_DEPTH_FRAMES)).rejects.toThrow("Frame index is outside the Reel.");
  });

  test("an unusable output location fails with a fixed message and writes nothing", async () => {
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "synthetic");
    const error = await renderStillDepthReel(input(still, dir, { outputPath: join(blocker, "reel.mp4") })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The Reel output location could not be prepared.");
    expect((error as Error).message).not.toContain(dir);
    expect((await readdir(dir)).filter((name) => name.includes("partial") || name.endsWith(".mp4"))).toEqual([]);
  }, 60_000);

  test("renders the full Reel to the existing contract with a cover and an honest ledger", async () => {
    const full = await syntheticStill(1080, 1920);
    const result = await renderStillDepthReel(input(full, dir));
    const video = await readFile(join(dir, "reel.mp4"));
    expect(result.reel).toMatchObject({ frames: 360, durationSeconds: 12, width: 1080, height: 1920, fps: 30, bytes: video.length, sha256: createHash("sha256").update(video).digest("hex") });
    expect(await probeVideo(join(dir, "reel.mp4"))).toMatchObject({ width: 1080, height: 1920, codec: "h264", frameRate: "30/1", frames: 360, durationSeconds: 12, audioStreams: 0 });
    const cover = await readFile(join(dir, "cover.png"));
    expect(await sharp(cover).metadata()).toMatchObject({ format: "png", width: 1080, height: 1920 });
    expect(result.cover).toMatchObject({ frame: STILL_DEPTH_COVER_FRAME, bytes: cover.length, sha256: createHash("sha256").update(cover).digest("hex") });
    const { ledger } = result;
    assertLedger(ledger);
    expect(ledger.frames).toBe(360);
    expect(ledger.generatedPixelsOnSubject).toBe(0);
    expect(ledger.meanGeneratedFraction).toBe(0);
    expect(ledger.meanSubjectSourceFraction).toBeGreaterThan(0.05);
    expect(ledger.meanTreatedSourceFraction).toBeGreaterThan(0.2);
    expect(ledger.maxSubjectOcclusion).toBeLessThanOrEqual(MAX_FOREGROUND_OCCLUSION);
    expect(ledger.framesWithoutSubject).toBe(0);
    expect(result.qa.violations).toEqual([]);
    expect(result.qa.framesSubjectHiddenByTransition).toBeLessThanOrEqual(4);
    expect(result.layout.hookHeadline.placement).toBe("behind_subject");
  }, 300_000);
});
