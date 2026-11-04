import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { artDirectedImageBox, CUTOUT_BOX_MARGIN, cutoutSubjectBounds, renderCampaignAssets, type RenderInput } from "../../lib/campaign/render";

/**
 * Regression (hosted live run, 4 Nov 2026): facebook_ads.png showed a wide crop through the middle of a
 * SAM-cut can, with cutout fragments spilling past its image box at both edges. Every art-directed
 * placement must contain the whole subject inside its image box, with a margin, and nothing outside it.
 */

const CW = 600, CH = 900;
/** A synthetic tall "can": magenta body, cyan top band, yellow bottom band. Not a business photo. */
const CAN = { left: 150, top: 100, width: 300, height: 700 };
const can = (fill: (part: "top" | "body" | "bottom") => string) => `<rect x="${CAN.left}" y="${CAN.top}" width="${CAN.width}" height="${CAN.height}" fill="${fill("body")}"/>`
  + `<rect x="${CAN.left}" y="${CAN.top}" width="${CAN.width}" height="40" fill="${fill("top")}"/><rect x="${CAN.left}" y="${CAN.top + CAN.height - 40}" width="${CAN.width}" height="40" fill="${fill("bottom")}"/>`;
const colours = { top: "#00ffff", body: "#ff00ff", bottom: "#ffff00" } as const;

async function fixture() {
  const source = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}"><rect width="${CW}" height="${CH}" fill="#304050"/>${can((part) => colours[part])}</svg>`)).png().toBuffer();
  // The SAM cutout: the can plus two stray fragments in opposite corners (the live failure widened the box).
  const fragments = `<rect x="4" y="4" width="10" height="10" fill="${colours.body}"/><rect x="${CW - 14}" y="${CH - 14}" width="10" height="10" fill="${colours.body}"/>`;
  const foreground = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}">${can((part) => colours[part])}${fragments}</svg>`)).png().toBuffer();
  return { source, foreground };
}

type Kind = "top" | "body" | "bottom" | "backdrop";
function classify(r: number, g: number, b: number): Kind | null {
  if (r > 200 && g < 60 && b > 200) return "body";
  if (r < 60 && g > 200 && b > 200) return "top";
  if (r > 200 && g > 200 && b < 60) return "bottom";
  if (r < 60 && g > 200 && b < 60) return "backdrop";
  return null;
}

async function scan(png: Buffer) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const found = new Map<Kind, { count: number; left: number; top: number; right: number; bottom: number }>();
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const o = (y * info.width + x) * 3, kind = classify(data[o], data[o + 1], data[o + 2]);
    if (!kind) continue;
    const box = found.get(kind) ?? { count: 0, left: x, top: y, right: x, bottom: y };
    box.count++; box.left = Math.min(box.left, x); box.right = Math.max(box.right, x); box.top = Math.min(box.top, y); box.bottom = Math.max(box.bottom, y);
    found.set(kind, box);
  }
  return { found, width: info.width, height: info.height };
}

const ROLE_BY_FILE: Record<string, { height: number; role: "hero" | "detail" | "story" | "action" }> = {
  "instagram_feed.png": { height: 1350, role: "hero" },
  "facebook_ads.png": { height: 1080, role: "detail" },
  "facebook_ads_portrait.png": { height: 1350, role: "detail" },
  "instagram_stories.png": { height: 1920, role: "hero" },
  "click_to_whatsapp.png": { height: 1350, role: "action" },
  "whatsapp_status.png": { height: 1920, role: "story" },
  "instagram_carousel_1.png": { height: 1350, role: "hero" },
  "instagram_carousel_2.png": { height: 1350, role: "detail" },
  "instagram_carousel_3.png": { height: 1350, role: "story" },
  "instagram_carousel_4.png": { height: 1350, role: "action" },
};

describe("art-directed channel stills", () => {
  test("the subject bounds ignore stray SAM fragments", async () => {
    const { foreground } = await fixture();
    const bounds = (await cutoutSubjectBounds(foreground))!;
    expect(bounds.left).toBeGreaterThanOrEqual(CAN.left - 3);
    expect(bounds.top).toBeGreaterThanOrEqual(CAN.top - 3);
    expect(bounds.left + bounds.width).toBeLessThanOrEqual(CAN.left + CAN.width + 3);
    expect(bounds.top + bounds.height).toBeLessThanOrEqual(CAN.top + CAN.height + 3);
  });

  test("every channel layout contains the whole cutout inside its image box, with a margin, and nothing outside it", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tickr-render-layout-"));
    try {
      const { source, foreground } = await fixture();
      const channels = ["instagram_feed", "instagram_carousel", "facebook_ads", "instagram_stories", "click_to_whatsapp", "whatsapp_status"].map((id) => ({
        id, title: id, headline: "A synthetic can, whole", body: "Synthetic layout fixture copy.", caption: "Synthetic caption.", cta: "Ask the team", evidenceIds: [],
      }));
      const backdrop = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#00ff00" } }).png().toBuffer();
      for (const withBackdrop of [false, true]) {
        const input: RenderInput = {
          businessName: "Synthetic layout fixture", vertical: "bakery", mode: "synthetic", campaignName: "Cutout containment check", channels, outputDir,
          image: { bytes: source, mimeType: "image/png", provenance: "source_photo", sourceIds: [], description: "Synthetic can fixture.", foregroundBytes: foreground, backgroundStyle: "palette_gradient", ...(withBackdrop ? { backgroundBytes: backdrop } : {}) },
        };
        const assets = await renderCampaignAssets(input);
        expect(assets.map((asset) => asset.filename).sort()).toEqual(Object.keys(ROLE_BY_FILE).sort());
        for (const asset of assets) {
          const { height, role } = ROLE_BY_FILE[asset.filename];
          const box = artDirectedImageBox({ width: 1080, height, variant: 0, role });
          const margin = Math.max(16, Math.round(Math.min(box.width, box.height) * CUTOUT_BOX_MARGIN)) - 2;
          const { found } = await scan(await readFile(join(outputDir, asset.filename)));
          const label = `${asset.filename}${withBackdrop ? " (backdrop)" : ""}`;
          // The whole can is visible: its top and bottom bands survive (no crop through its middle).
          for (const part of ["top", "body", "bottom"] as const) expect(found.get(part)?.count ?? 0, `${label}: ${part}`).toBeGreaterThan(50);
          const subject = { left: Math.min(...["top", "body", "bottom"].map((part) => found.get(part as Kind)!.left)), right: Math.max(...["top", "body", "bottom"].map((part) => found.get(part as Kind)!.right)), top: found.get("top")!.top, bottom: found.get("bottom")!.bottom };
          expect(subject.left, label).toBeGreaterThanOrEqual(box.x + margin);
          expect(subject.right, label).toBeLessThan(box.x + box.width - margin);
          expect(subject.top, label).toBeGreaterThanOrEqual(box.y + margin);
          expect(subject.bottom, label).toBeLessThan(box.y + box.height - margin);
          // Contained, not stretched or cropped: the can keeps its proportions.
          const aspect = (subject.right - subject.left + 1) / (subject.bottom - subject.top + 1);
          expect(Math.abs(aspect / (CAN.width / CAN.height) - 1), label).toBeLessThan(0.05);
          // No cutout fragment outside the can's own box, and the backdrop stays inside the image box.
          const body = found.get("body")!;
          expect(body.left >= subject.left && body.right <= subject.right && body.top >= subject.top && body.bottom <= subject.bottom, label).toBe(true);
          const plate = found.get("backdrop");
          if (withBackdrop) {
            expect(plate?.count ?? 0, label).toBeGreaterThan(1000);
            expect(plate!.left >= box.x && plate!.right < box.x + box.width && plate!.top >= box.y && plate!.bottom < box.y + box.height, label).toBe(true);
          } else expect(plate, label).toBeUndefined();
        }
      }
    } finally { await rm(outputDir, { recursive: true, force: true }); }
  }, 120_000);
});
