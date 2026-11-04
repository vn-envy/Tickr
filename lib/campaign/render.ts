import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { renderReel } from "./reel";
import type { CampaignCreativeBrief } from "../research/contracts";

export interface RenderChannel {
  id: string;
  title: string;
  headline: string;
  body: string;
  caption: string;
  cta: string;
  evidenceIds: string[];
}

export interface RenderInput {
  businessName: string;
  vertical: string;
  mode: "live" | "synthetic";
  campaignName: string;
  channels: RenderChannel[];
  outputDir: string;
  creativeBrief?: CampaignCreativeBrief;
  image?: {
    bytes: Uint8Array;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    provenance: "owner_photo" | "source_photo" | "meta_illustration";
    sourceIds: string[];
    description: string;
    /** Optional SAM cutout and Meta backdrop; both are local PNG rasters. */
    foregroundBytes?: Uint8Array;
    backgroundBytes?: Uint8Array;
    backgroundStyle?: "palette_gradient" | "source_image";
  };
}

export interface RenderedAsset {
  id: string;
  channel: string;
  filename: string;
  mediaType: "image" | "video";
  width: number;
  height: number;
  sha256: string;
  bytes: number;
}

type Theme = { paper: string; ink: string; accent: string; soft: string; dark: string };
const themes: Record<string, Theme> = {
  bakery: { paper: "#F5EEDF", ink: "#263A30", accent: "#BB4D2F", soft: "#E1C69E", dark: "#263A30" },
  dentist: { paper: "#F0F3EE", ink: "#173C40", accent: "#247C79", soft: "#B7D3CC", dark: "#173C40" },
  gym: { paper: "#F2F0E8", ink: "#292D27", accent: "#D54C29", soft: "#D4DE9B", dark: "#292D27" },
  salon: { paper: "#F4EBE7", ink: "#432C38", accent: "#9A4F62", soft: "#DAC3CB", dark: "#432C38" },
};
const genericTheme: Theme = { paper: "#F5F2EC", ink: "#243B43", accent: "#B65A35", soft: "#CBD8D4", dark: "#243B43" };

function luminance(color: string): number {
  const rgb = [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}

function campaignTheme(input: Pick<RenderInput, "vertical" | "creativeBrief">): Theme {
  const fallback = Object.hasOwn(themes, input.vertical) ? themes[input.vertical] : genericTheme;
  const palette = input.creativeBrief?.visualDirection.palette;
  if (!palette || palette.length !== 3 || palette.some((color) => !/^#[0-9a-fA-F]{6}$/.test(color))) return fallback;
  const [paper, ink, accent] = palette;
  // A proposed palette may not compromise readable text.
  if (luminance(paper) < .5 || (luminance(paper) + .05) / (luminance(ink) + .05) < 7) return fallback;
  return { paper, ink, accent, soft: fallback.soft, dark: ink };
}

/** Raster-only entry point: SVG/XML bytes are rejected before any image parser runs. */
export async function normalizeCampaignImage(image: NonNullable<RenderInput["image"]>): Promise<Buffer> {
  const bytes = Buffer.from(image.bytes);
  if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw new Error("Campaign image exceeds the local image size limit.");
  const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png" : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpeg" : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "webp" : null;
  if (!format || image.mimeType !== `image/${format}`) throw new Error("Campaign images must be genuine PNG, JPEG or WebP rasters.");
  try {
    const raster = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error", animated: false });
    const metadata = await raster.metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height) throw new Error("Invalid raster metadata");
    return await raster.rotate().resize({ width: 3000, height: 3000, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  } catch { throw new Error("The campaign image could not be safely decoded."); }
}

/** Segmented pixels stay local and transparent; no SVG, remote URL or opaque substitute. */
export async function normalizeCampaignForeground(bytes: Uint8Array): Promise<Buffer> {
  const normalized = await normalizeCampaignImage({ bytes, mimeType: "image/png", provenance: "source_photo", sourceIds: [], description: "Local segmented foreground." });
  const metadata = await sharp(normalized).metadata();
  const stats = await sharp(normalized).stats();
  const alpha = stats.channels.at(-1);
  if (!metadata.hasAlpha || !alpha || alpha.min >= 250 || alpha.max <= 5) throw new Error("The campaign foreground needs visible pixels and a transparent background.");
  return sharp(normalized).trim({ background: "#00000000", threshold: 1 }).png().toBuffer();
}

/** All model/owner text is data. SVG markup never contains unescaped source text. */
export function escapeSvg(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

function cleanText(value: string, limit: number): string {
  const clean = value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
}

function wrapText(value: string, columns: number, maxLines: number): string[] {
  const words = cleanText(value, columns * maxLines).split(" ");
  const units = (value: string) => Array.from(value).reduce((width, char) => width + (/[MW@%&]/.test(char) ? 1 : /[mw]/.test(char) ? .9 : /[ilI.,' :;]/.test(char) ? .32 : /[A-Z]/.test(char) ? .72 : /[^\x00-\x7F]/.test(char) ? .95 : .56), 0);
  const available = columns * .58;
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && units(`${current} ${word}`) > available) { lines.push(current); current = ""; }
    if (units(word) > available) {
      if (current) { lines.push(current); current = ""; }
      let fragment = "";
      for (const char of word) {
        if (fragment && units(fragment + char) > available) { lines.push(fragment); fragment = ""; }
        fragment += char;
      }
      current = fragment;
    } else current += `${current ? " " : ""}${word}`;
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, -1)}…`;
  return lines.slice(0, maxLines);
}

function textBlock(value: string, x: number, y: number, columns: number, maxLines: number, fontSize: number, lineHeight: number, color: string, serif = false): string {
  const lines = wrapText(value, columns, maxLines);
  return `<text fill="${color}" font-family="${serif ? "DejaVu Serif,serif" : "DejaVu Sans,sans-serif"}" font-size="${fontSize}" font-weight="${serif ? "400" : "500"}">${lines.map((line, index) => `<tspan x="${x}" y="${y + index * lineHeight}">${escapeSvg(line)}</tspan>`).join("")}</text>`;
}

/** Fit the full headline to its physical column before resorting to a visible ellipsis. */
function fittedHeadline(value: string, x: number, y: number, width: number, maxLines: number, preferredSize: number, color: string): string {
  let size = preferredSize;
  const linesAt = (fontSize: number) => wrapText(value, width / (fontSize * .58), 1000);
  while (size > preferredSize * .60 && linesAt(size).length > maxLines) size -= 2;
  const allLines = linesAt(size);
  const lines = allLines.slice(0, maxLines);
  if (allLines.length > maxLines) lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, -1)}…`;
  return `<text fill="${color}" font-family="DejaVu Serif,serif" font-size="${size}" font-weight="400">${lines.map((line, index) => `<tspan x="${x}" y="${y + index * size * 1.12}">${escapeSvg(line)}</tspan>`).join("")}</text>`;
}

type ArtRole = "hero" | "detail" | "story" | "action";
type Layout = { width: number; height: number; headline: string; body: string; cta: string; kicker: string; variant: number; page?: string; role?: ArtRole };
const ART_ROLES: ArtRole[] = ["hero", "detail", "story", "action"];
const hasArtDirection = (input: RenderInput) => Boolean(input.image?.foregroundBytes || input.image?.backgroundBytes || input.image?.backgroundStyle);

/** Four visual roles share one truthful subject, rather than repeating one poster layout. */
async function artDirectedFrame(input: RenderInput, layout: Layout, original: Buffer, foreground?: Buffer, background?: Buffer): Promise<Buffer> {
  const { width: w, height: h } = layout;
  const role = layout.role ?? ART_ROLES[layout.variant % 4];
  const theme = campaignTheme(input);
  const square = h === w, tall = h > 1500;
  const dark = role === "detail" || role === "action";
  const paper = dark ? theme.ink : theme.paper, ink = dark ? theme.paper : theme.ink;
  const margin = 64;
  const headlineSize = role === "story" ? square ? 48 : tall ? 70 : 62 : square ? 54 : tall ? 86 : 74;
  const titleY = square ? 210 : tall ? 272 : 244;
  const story = role === "story";
  const action = role === "action";
  const stage = story
    ? { x: 500, y: square ? 300 : tall ? 560 : 360, width: w - 500, height: square ? 470 : tall ? 920 : 620 }
    : action
      ? { x: 180, y: square ? 164 : tall ? 190 : 170, width: w - 360, height: square ? 385 : tall ? 800 : 580 }
      : { x: role === "detail" ? 0 : 64, y: square ? 358 : tall ? 550 : 445, width: role === "detail" ? w : w - 128, height: square ? 390 : tall ? 810 : 525 };
  const bodyY = story ? square ? 560 : tall ? 1060 : 710 : action ? square ? 790 : tall ? 1480 : 1060 : square ? 812 : tall ? 1470 : 1040;
  const ctaY = square ? 910 : tall ? 1738 : 1178;
  const focus = cleanText(input.creativeBrief?.focus.name || layout.kicker, 62);
  const concept = input.mode === "synthetic" ? "SYNTHETIC DEMO · CONCEPT" : "CONCEPT · REVIEW REQUIRED";
  const provenance = input.image!.provenance === "meta_illustration" ? "ILLUSTRATIVE IMAGE" : foreground ? background ? "SOURCE CUTOUT · AI BACKDROP" : "SOURCE CUTOUT" : "SOURCE IMAGE";
  const circleX = story ? w - 20 : role === "detail" ? w / 2 : w * .56;
  const circleY = stage.y + stage.height * .54;
  const backgroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<defs><linearGradient id="wash" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${paper}"/><stop offset="1" stop-color="${dark ? theme.ink : theme.soft}"/></linearGradient><radialGradient id="halo"><stop stop-color="${theme.accent}" stop-opacity=".24"/><stop offset="1" stop-color="${theme.accent}" stop-opacity="0"/></radialGradient></defs>
<rect width="${w}" height="${h}" fill="${paper}"/>
<rect y="${stage.y - 50}" width="${w}" height="${stage.height + 130}" fill="url(#wash)" opacity="${dark ? .6 : .55}"/>
<ellipse cx="${circleX}" cy="${circleY}" rx="${story ? 520 : 620}" ry="${stage.height * .62}" fill="url(#halo)"/>
${story ? `<circle cx="${circleX}" cy="${circleY}" r="${Math.min(420, stage.height * .49)}" fill="${theme.soft}" opacity=".45"/>` : `<ellipse cx="${w / 2}" cy="${stage.y + stage.height - 10}" rx="${action ? 250 : 350}" ry="20" fill="${theme.ink}" opacity=".10"/>`}
<path d="M ${margin} ${h - 150} H ${w - margin}" stroke="${ink}" opacity=".16"/>
</svg>`;
  const layers: OverlayOptions[] = [];
  if (background && foreground) {
    const backdrop = await sharp(background).resize(stage.width, stage.height, { fit: "cover", position: "centre" }).png().toBuffer();
    layers.push({ input: backdrop, left: stage.x, top: stage.y });
  }
  if (foreground) {
    const subject = await sharp(foreground).resize(stage.width, stage.height, { fit: role === "detail" ? "cover" : "contain", position: "centre", background: "#00000000" }).png().toBuffer();
    layers.push({ input: subject, left: stage.x, top: stage.y });
  } else {
    let photo = sharp(original);
    if (role === "detail") {
      const metadata = await photo.metadata();
      const width = Math.max(1, Math.round(metadata.width! * .76)), height = Math.max(1, Math.round(metadata.height! * .76));
      photo = photo.extract({ left: Math.floor((metadata.width! - width) / 2), top: Math.floor((metadata.height! - height) / 2), width, height });
    }
    const mask = Buffer.from(`<svg width="${stage.width}" height="${stage.height}"><rect width="${stage.width}" height="${stage.height}" rx="${role === "detail" ? 0 : story ? 120 : 32}" fill="white"/></svg>`);
    const photoBytes = await photo.resize(stage.width, stage.height, { fit: "cover", position: role === "hero" ? sharp.strategy.attention : "centre" }).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
    layers.push({ input: photoBytes, left: stage.x, top: stage.y });
  }
  const headingX = margin;
  const headingY = action ? square ? 625 : tall ? 1130 : 850 : titleY;
  const headingWidth = story ? 410 : w - margin * 2;
  const headingLines = story ? 6 : 3;
  const cta = cleanText(layout.cta, 43);
  const bodyColumns = story ? 25 : 56;
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<text x="${margin}" y="42" fill="${ink}" font-family="DejaVu Sans,sans-serif" font-size="15" letter-spacing="1.7">${escapeSvg(concept)}</text>
<text x="${w - margin}" y="42" text-anchor="end" fill="${ink}" font-family="DejaVu Sans,sans-serif" font-size="16">${escapeSvg(layout.page || "01")}</text>
<line x1="${margin}" y1="64" x2="${w - margin}" y2="64" stroke="${ink}" opacity=".2"/>
${textBlock(input.businessName, margin, 108, 61, 1, 28, 38, ink)}
${action ? "" : `<text x="${margin}" y="${titleY - 73}" fill="${dark ? theme.soft : theme.accent}" font-family="DejaVu Sans,sans-serif" font-size="17" letter-spacing="2">${escapeSvg(focus.toUpperCase())}</text>`}
${fittedHeadline(layout.headline, headingX - 3, headingY, headingWidth, headingLines, headlineSize, ink)}
<rect x="${margin}" y="${bodyY - 39}" width="44" height="4" fill="${theme.accent}"/>
${textBlock(layout.body, margin, bodyY, bodyColumns, story ? 5 : tall ? 4 : 3, square ? 26 : 28, square ? 38 : 42, ink)}
<rect x="${margin}" y="${ctaY}" width="${Math.min(w - 128, Math.max(350, cta.length * 16 + 76))}" height="74" rx="37" fill="${ink}"/>
<text x="${margin + 29}" y="${ctaY + 47}" fill="${paper}" font-family="DejaVu Sans,sans-serif" font-size="25">${escapeSvg(cta)}</text>
<text x="${margin}" y="${h - 66}" fill="${ink}" opacity=".8" font-family="DejaVu Sans,sans-serif" font-size="13" letter-spacing="1.4">${provenance}</text>
<text x="${margin}" y="${h - 32}" fill="${ink}" font-family="DejaVu Sans,sans-serif" font-size="13" letter-spacing="1.2">${escapeSvg(cleanText(input.campaignName.toUpperCase(), 75))}</text>
</svg>`;
  return sharp(Buffer.from(backgroundSvg)).composite([...layers, { input: Buffer.from(overlay), left: 0, top: 0 }]).png().toBuffer();
}

export function campaignSvg(input: Pick<RenderInput, "businessName" | "vertical" | "mode" | "campaignName" | "creativeBrief">, layout: Layout): string {
  const { width: w, height: h } = layout;
  const theme = campaignTheme(input);
  const dark = layout.variant % 3 === 1;
  const bg = dark ? theme.dark : theme.paper;
  const fg = dark ? theme.paper : theme.ink;
  const decorative = dark ? theme.accent : theme.soft;
  const isSquare = h === w;
  const isTall = h > 1500;
  const margin = 82;
  const headlineY = isSquare ? 328 : isTall ? 508 : 370;
  const fontSize = isSquare ? 76 : 86;
  const columns = isSquare ? 20 : 19;
  const headlineLines = isSquare ? 3 : 4;
  const bodyY = isSquare ? 632 : isTall ? 1030 : 830;
  const ctaY = h - 220;
  const concept = input.mode === "synthetic" ? "SYNTHETIC DEMO · CONCEPT" : "CONCEPT · REVIEW REQUIRED";
  const motifY = isTall ? 1370 : h - 140;
  const motif = layout.variant % 2 === 0
    ? `<g stroke="${decorative}" fill="none" stroke-width="2" opacity=".68">${[0,1,2,3,4,5,6].map((n) => `<circle cx="${w - 110}" cy="${motifY}" r="${170 + n * 28}"/>`).join("")}</g>`
    : `<g fill="none" stroke="${decorative}" stroke-width="3" opacity=".75">${[0,1,2,3,4].map((n) => `<path d="M ${w - 340 + n * 32} ${isTall ? 1390 : h - 240} v -105 a 95 95 0 0 1 190 0 v 105"/>`).join("")}</g>`;
  const ctaText = cleanText(layout.cta, 36);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${bg}"/>
${motif}
<rect x="${margin}" y="74" width="8" height="38" rx="4" fill="${theme.accent}"/>
<text x="${margin + 27}" y="100" fill="${fg}" font-family="DejaVu Sans,sans-serif" font-size="20" letter-spacing="2.1">${escapeSvg(concept)}</text>
<line x1="${margin}" y1="145" x2="${w - margin}" y2="145" stroke="${fg}" opacity=".22"/>
${textBlock(input.businessName, margin, 201, 42, 2, 30, 41, fg)}
<text x="${margin}" y="${headlineY - 65}" fill="${dark ? theme.soft : theme.accent}" font-family="DejaVu Sans,sans-serif" font-size="21" letter-spacing="3">${escapeSvg(cleanText(layout.kicker.toUpperCase(), 38))}</text>
${textBlock(layout.headline, margin - 4, headlineY + 18, columns, headlineLines, fontSize, fontSize * 1.19, fg, true)}
<rect x="${margin}" y="${bodyY - 55}" width="62" height="5" fill="${theme.accent}"/>
${textBlock(layout.body, margin, bodyY, 46, isSquare ? 3 : 4, 29, 44, fg)}
<rect x="${margin}" y="${ctaY}" width="${Math.min(916, Math.max(380, ctaText.length * 18 + 110))}" height="79" rx="39.5" fill="${dark ? theme.paper : theme.ink}"/>
<text x="${margin + 31}" y="${ctaY + 49}" fill="${dark ? theme.ink : theme.paper}" font-family="DejaVu Sans,sans-serif" font-size="27">${escapeSvg(ctaText)}</text>
<line x1="${margin}" y1="${h - 93}" x2="${w - margin}" y2="${h - 93}" stroke="${fg}" opacity=".22"/>
<text x="${margin}" y="${h - 51}" fill="${fg}" font-family="DejaVu Sans,sans-serif" font-size="17" letter-spacing="1.7">TICKR / CAMPAIGN STUDY</text>
<text x="${w - margin}" y="${h - 51}" text-anchor="end" fill="${fg}" font-family="DejaVu Sans,sans-serif" font-size="18">${escapeSvg(layout.page ?? "01")}</text>
</svg>`;
}

/** Local pixels are composed below text, never interpolated into an SVG URL. */
export async function renderCampaignFrame(input: RenderInput, layout: Layout, normalizedImage?: Buffer, normalizedForeground?: Buffer, normalizedBackground?: Buffer): Promise<Buffer> {
  if (!normalizedImage || !input.image) return sharp(Buffer.from(campaignSvg(input, layout))).png().toBuffer();
  if (hasArtDirection(input)) {
    const foreground = normalizedForeground ?? (input.image.foregroundBytes ? await normalizeCampaignForeground(input.image.foregroundBytes) : undefined);
    const background = normalizedBackground ?? (input.image.backgroundBytes ? await normalizeCampaignImage({ ...input.image, bytes: input.image.backgroundBytes, mimeType: "image/png" }) : undefined);
    return artDirectedFrame(input, layout, normalizedImage, foreground, background);
  }
  const { width: w, height: h } = layout;
  const theme = campaignTheme(input);
  const dark = layout.variant % 3 === 1;
  const paper = dark ? theme.ink : theme.paper;
  const ink = dark ? theme.paper : theme.ink;
  const square = h === w;
  const tall = h > 1500;
  const imageTop = square ? 365 : tall ? 490 : 390;
  const imageHeight = square ? 385 : tall ? 920 : 610;
  const imageWidth = w - 128;
  const titleY = tall ? 240 : square ? 188 : 210;
  const headlineSize = square ? 58 : tall ? 76 : 66;
  const bodyY = square ? 815 : tall ? 1500 : 1070;
  const ctaY = square ? 935 : tall ? 1737 : 1205;
  const image = await sharp(normalizedImage).resize(imageWidth, imageHeight, { fit: "cover", position: sharp.strategy.attention }).composite([{ input: Buffer.from(`<svg width="${imageWidth}" height="${imageHeight}"><rect width="${imageWidth}" height="${imageHeight}" rx="24" fill="white"/></svg>`), blend: "dest-in" }]).png().toBuffer();
  const concept = input.mode === "synthetic" ? "SYNTHETIC DEMO · CONCEPT" : "CONCEPT · REVIEW REQUIRED";
  const provenance = input.image.provenance === "meta_illustration" ? "ILLUSTRATIVE IMAGE" : "SOURCE IMAGE";
  const focus = input.creativeBrief?.focus.name || layout.kicker;
  const label = cleanText(focus, 48).toUpperCase();
  const cta = cleanText(layout.cta, 43);
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<text x="64" y="48" fill="${ink}" font-family="DejaVu Sans,sans-serif" font-size="16" letter-spacing="2">${escapeSvg(concept)}</text>
<text x="${w - 64}" y="48" text-anchor="end" fill="${ink}" font-family="DejaVu Sans,sans-serif" font-size="16">${escapeSvg(layout.page || "01")}</text>
<line x1="64" y1="70" x2="${w - 64}" y2="70" stroke="${ink}" opacity=".2"/>
${textBlock(input.businessName, 64, 111, 60, 1, 29, 36, ink)}
<rect x="64" y="${titleY - 68}" width="6" height="24" fill="${theme.accent}"/>
<text x="84" y="${titleY - 49}" fill="${ink}" font-family="DejaVu Sans,sans-serif" font-size="17" letter-spacing="2">${escapeSvg(label)}</text>
${textBlock(layout.headline, 61, titleY + 22, square ? 28 : tall ? 22 : 25, 3, headlineSize, headlineSize * 1.15, ink, true)}
<rect x="82" y="${imageTop + imageHeight - 54}" width="${provenance.length * 9 + 34}" height="34" rx="17" fill="${theme.paper}" opacity=".96"/>
<text x="99" y="${imageTop + imageHeight - 31}" fill="${theme.ink}" font-family="DejaVu Sans,sans-serif" font-size="14" letter-spacing="1">${provenance}</text>
${textBlock(layout.body, 64, bodyY, tall ? 52 : 57, tall ? 4 : 3, 28, 41, ink)}
<rect x="64" y="${ctaY}" width="${Math.min(w - 128, Math.max(350, cta.length * 16 + 76))}" height="72" rx="36" fill="${ink}"/>
<text x="92" y="${ctaY + 46}" fill="${paper}" font-family="DejaVu Sans,sans-serif" font-size="25">${escapeSvg(cta)}</text>
<text x="64" y="${h - 34}" fill="${ink}" font-family="DejaVu Sans,sans-serif" font-size="14" letter-spacing="1.4">${escapeSvg(cleanText(input.campaignName.toUpperCase(), 72))}</text>
</svg>`;
  return sharp({ create: { width: w, height: h, channels: 4, background: paper } }).composite([{ input: image, left: 64, top: imageTop }, { input: Buffer.from(overlay), left: 0, top: 0 }]).png().toBuffer();
}

export async function renderCampaignAssets(input: RenderInput): Promise<RenderedAsset[]> {
  const outputDir = resolve(input.outputDir);
  await mkdir(outputDir, { recursive: true });
  const assets: RenderedAsset[] = [];
  const normalizedImage = input.image ? await normalizeCampaignImage(input.image) : undefined;
  const normalizedForeground = input.image?.foregroundBytes ? await normalizeCampaignForeground(input.image.foregroundBytes) : undefined;
  const normalizedBackground = input.image?.backgroundBytes ? await normalizeCampaignImage({ ...input.image, bytes: input.image.backgroundBytes, mimeType: "image/png" }) : undefined;
  const record = async (filename: string, channel: string, width: number, height: number, mediaType: "image" | "video") => {
    const bytes = await readFile(join(outputDir, filename));
    assets.push({ id: filename.replace(/\.[a-z0-9]+$/i, ""), channel, filename, mediaType, width, height, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  };
  const image = async (filename: string, channel: string, layout: Layout) => {
    const bytes = await renderCampaignFrame(input, layout, normalizedImage, normalizedForeground, normalizedBackground);
    await writeFile(join(outputDir, filename), bytes);
    await record(filename, channel, layout.width, layout.height, "image");
  };

  for (const [index, channel] of input.channels.entries()) {
    if (channel.id === "instagram_reels") continue;
    const tall = ["instagram_stories", "whatsapp_status"].includes(channel.id);
    const square = channel.id === "facebook_ads";
    const height = tall ? 1920 : square ? 1080 : 1350;
    const role: ArtRole = channel.id === "click_to_whatsapp" ? "action" : channel.id === "facebook_ads" ? "detail" : channel.id === "whatsapp_status" ? "story" : "hero";
    const layout: Layout = { width: 1080, height, headline: channel.headline, body: channel.body, cta: channel.cta, kicker: channel.title, variant: index, role };
    const allowed = new Set(["instagram_feed", "instagram_carousel", "facebook_ads", "instagram_stories", "click_to_whatsapp", "whatsapp_status"]);
    if (!allowed.has(channel.id)) throw new Error("Unknown creative channel.");
    if (channel.id === "instagram_carousel") {
      const slides = input.creativeBrief ? input.creativeBrief.scenes.map((scene) => ({ headline: scene.headline, body: scene.body, kicker: input.creativeBrief!.focus.name })) : [
        { headline: channel.headline, body: channel.body, kicker: "A reason to look closer" },
        { headline: channel.body, body: channel.caption, kicker: "The detail that matters" },
        { headline: channel.caption.split(/[.!?]\s/)[0] || channel.headline, body: channel.body, kicker: "Make it part of your day" },
        { headline: channel.cta, body: channel.headline, kicker: "Your next step" },
      ];
      for (const [slideIndex, slide] of slides.entries()) await image(`instagram_carousel_${slideIndex + 1}.png`, channel.id, { ...layout, ...slide, role: ART_ROLES[slideIndex], variant: slideIndex, page: `${slideIndex + 1} / 4` });
    } else {
      await image(`${channel.id}.png`, channel.id, layout);
      if (square) await image("facebook_ads_portrait.png", channel.id, { ...layout, height: 1350, variant: index + 1 });
    }
  }

  const reel = input.channels.find((channel) => channel.id === "instagram_reels");
  if (reel) {
    const sceneDir = join(outputDir, ".reel-scenes");
    await mkdir(sceneDir, { recursive: true });
    const scenes = input.creativeBrief ? input.creativeBrief.scenes.map((scene) => ({ headline: scene.headline, body: scene.body, kicker: input.creativeBrief!.focus.name })) : [
      { headline: reel.headline, body: reel.body, kicker: "A little closer" },
      { headline: reel.body, body: reel.headline, kicker: "The story in the details" },
      { headline: reel.caption.split(/[.!?]\s/)[0] || reel.headline, body: reel.body, kicker: "Something to remember" },
      { headline: reel.cta, body: reel.headline, kicker: "Take the next step" },
    ];
    const scenePaths: string[] = [];
    try {
      for (const [index, scene] of scenes.entries()) {
        const scenePath = join(sceneDir, `scene-${index + 1}.png`);
        await writeFile(scenePath, await renderCampaignFrame(input, { width: 1080, height: 1920, ...scene, cta: reel.cta, role: ART_ROLES[index], variant: index, page: `${index + 1} / 4` }, normalizedImage, normalizedForeground, normalizedBackground));
        scenePaths.push(scenePath);
      }
      await renderReel(scenePaths, join(outputDir, "instagram_reel.mp4"), { artDirected: hasArtDirection(input) });
      await record("instagram_reel.mp4", reel.id, 1080, 1920, "video");
      const cover = await readFile(scenePaths[0]);
      await writeFile(join(outputDir, "instagram_reel_cover.png"), cover);
      await record("instagram_reel_cover.png", reel.id, 1080, 1920, "image");
    } finally { await rm(sceneDir, { recursive: true, force: true }); }
  }
  return assets;
}
