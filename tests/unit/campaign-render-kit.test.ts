import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { hashBytes } from "../../lib/campaign/archive";
import { campaignProvenanceLabel, normalizeCampaignImage, renderCampaignAssets, renderCampaignFrame, resolveCampaignTheme, type RenderImage, type RenderInput } from "../../lib/campaign/render";
import { CampaignRenderError, campaignInputHash, ensureCampaignCopy, renderCampaignKit, type CreateCampaignInput } from "../../lib/campaign";
import { generateCampaignCopy, type CampaignCopy } from "../../lib/campaign/copy";
import { writeCompletedCopyRecord, type CompletedCopyResponse } from "../../lib/campaign/completed-response";
import { ChannelSchema } from "../../lib/schemas/common";
import type { BusinessEnrichment, CampaignVisual, CollectedSource, ResearchOpportunity, ResearchReport } from "../../lib/research/contracts";

// Only the paid copy request is replaced; validation and checkpoint helpers stay real.
vi.mock("../../lib/campaign/copy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/campaign/copy")>();
  return { ...actual, generateCampaignCopy: vi.fn(async () => { throw new Error("Unexpected paid copy request in an offline test."); }) };
});

const run = promisify(execFile);
const score = { value: null, rationale: "Not measured in this synthetic fixture." };
const opportunity: ResearchOpportunity = {
  id: "op-1", title: "Introduce the weekend loaf", hypothesis: "Synthetic hypothesis.", whyNow: "Synthetic timing.", evidenceIds: ["fact-1"], comparison: "Not compared.", customerAction: "Ask about the loaf", test: "Count inquiries.", uncertainties: ["Synthetic."],
  scores: { impact: score, evidence: score, differentiation: score, feasibility: score, confidence: score },
};
const report: ResearchReport = {
  summary: "Synthetic test only.", evidence: [{ id: "fact-1", sourceId: "s1", claim: "The bakery makes a weekend loaf.", quote: "We make a weekend loaf.", subject: "business", kind: "fact" }],
  findings: [], opportunities: [opportunity], recommendedOpportunityId: "op-1", unknowns: [], ownerQuestions: [], coverage: { sources: 1, competitorSources: 0, customerSources: 0 }, generatedAt: "2026-11-01T00:00:00Z", mode: "synthetic",
};
function draft(): CampaignCopy {
  return {
    name: "Weekend loaf", objective: "Invite inquiries.", audienceHypothesis: "People interested in local baking.", coreMessage: "Meet the weekend loaf.", primaryCta: "Ask about the loaf", evidenceIds: ["fact-1"], reviewNotes: ["Confirm product availability."],
    channels: ChannelSchema.options.map((id) => ({ id, title: id, headline: "A loaf for the weekend", body: "Meet our weekend loaf.", caption: "Ask us about the weekend loaf.", cta: "Ask about the loaf", evidenceIds: ["fact-1"] })),
    conversation: { opener: "I would like to know about the loaf.", commonReplies: Array.from({ length: 3 }, () => ({ question: "Is it available?", answer: "The team can confirm availability." })), qualificationQuestion: "What would you like to know?", nextAction: "Ask the team to confirm details." },
  };
}
const productSource: CollectedSource = { id: "s1", kind: "owner_statement", title: "Synthetic owner product note", url: null, text: "We make a weekend loaf.", retrievedAt: "2026-11-02T00:00:00Z", acquisition: "owner_supplied" };
const enrichment: BusinessEnrichment = { status: "enriched", businessId: "b1", offerings: [{ id: "offering-1", name: "Weekend loaf", description: "A loaf offered by the bakery.", sourceIds: ["s1"] }], brandSignals: [], sourceIds: ["s1"], unknowns: [], warnings: [], queries: [], completedToolCalls: 0, enrichedAt: "2026-11-02T00:00:00Z" };
/** The current generated-copy schema (as a completed response must carry it). */
function generatedDraft(): CampaignCopy {
  return { ...draft(), creativeBrief: {
    focus: { offeringId: "offering-1", name: "Weekend loaf", description: "A loaf from the bakery.", evidenceIds: ["fact-1"], sourceIds: ["s1"] },
    brandStory: { signalIds: [], narrative: "", evidenceIds: [], sourceIds: [] },
    visualDirection: { status: "proposed", description: "Warm cream and forest ink.", palette: ["#F6EEDD", "#263A30", "#BB4D2F"], sourceIds: [] },
    scenes: (["hook", "proof", "occasion", "action"] as const).map((role) => ({ role, headline: "Meet the weekend loaf", body: "Ask the team about the weekend loaf." })),
    context: { insightIds: [], whyNow: "Explain the source-attributed offering.", seasonalTheme: { name: null, status: "none", sourceIds: [] } },
  } };
}
const usage = { model: "muse-spark-1.3", inputTokens: 10, outputTokens: 20, elapsedMs: 100 };
const typography: CampaignVisual = { kind: "typography", filename: null, description: "No image (synthetic fixture).", sourceIds: [], sourceUrls: [], model: null, warnings: [] };
const campaignInput = (outputDir: string): CreateCampaignInput => ({ business: { id: "b1", name: "Synthetic bakery", locality: "Fixture", vertical: "bakery", goal: "Synthetic render-kit test", website: null }, report, opportunityId: opportunity.id, sources: [], mode: "synthetic", outputDir });

const solid = (color: string, format: "png" | "jpeg" = "png") => {
  const raster = sharp({ create: { width: 320, height: 240, channels: 3, background: color } });
  return (format === "png" ? raster.png() : raster.jpeg({ quality: 95 })).toBuffer();
};
const photo = async (color: string, extra: Partial<RenderImage> = {}): Promise<RenderImage> => ({ bytes: await solid(color), mimeType: "image/png", provenance: "owner_photo", sourceIds: [], description: "Synthetic solid-color owner photo.", ...extra });
const pixel = async (bytes: Buffer, left: number, top: number) => [...await sharp(bytes).extract({ left, top, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];

/** Stored (uncompressed) ZIP entries, read via the central directory. */
function zipEntries(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const entries = new Map<string, Buffer>();
  let cursor = zip.readUInt32LE(end + 16);
  for (let index = 0; index < zip.readUInt16LE(end + 10); index++) {
    const nameLength = zip.readUInt16LE(cursor + 28), size = zip.readUInt32LE(cursor + 20), offset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    entries.set(name, zip.subarray(start, start + size));
    cursor += 46 + nameLength;
  }
  return entries;
}

let mediaDir: string;
let reelPath: string, coverPath: string, shortReelPath: string, wrongCoverPath: string, yuv444ReelPath: string, audioReelPath: string, movReelPath: string;

beforeAll(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "tickr-render-kit-media-"));
  reelPath = join(mediaDir, "synthetic-reel.mp4");
  shortReelPath = join(mediaDir, "synthetic-short-reel.mp4");
  coverPath = join(mediaDir, "synthetic-cover.png");
  wrongCoverPath = join(mediaDir, "synthetic-wrong-cover.png");
  yuv444ReelPath = join(mediaDir, "synthetic-yuv444-reel.mp4");
  audioReelPath = join(mediaDir, "synthetic-audio-reel.mp4");
  movReelPath = join(mediaDir, "synthetic-reel.mov");
  const encode = (path: string, size: string, seconds: string, options: { pixFmt?: string; audio?: boolean; format?: string } = {}) => run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30`,
    ...(options.audio ? ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-c:a", "aac"] : ["-an"]),
    "-t", seconds, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", options.pixFmt ?? "yuv420p", ...(options.format ? ["-f", options.format] : []), path,
  ], { timeout: 120_000 });
  await Promise.all([
    encode(reelPath, "1080x1920", "12"), encode(shortReelPath, "1080x1920", "2"),
    // Each of these differs from the contract in exactly one respect.
    encode(yuv444ReelPath, "1080x1920", "12", { pixFmt: "yuv444p" }), encode(audioReelPath, "1080x1920", "12", { audio: true }), encode(movReelPath, "1080x1920", "12", { format: "mov" }),
  ]);
  await writeFile(coverPath, await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#204060" } }).png().toBuffer());
  await writeFile(wrongCoverPath, await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#204060" } }).png().toBuffer());
}, 180_000);
afterAll(async () => { await rm(mediaDir, { recursive: true, force: true }); });

describe("campaign render routing", () => {
  test("provenance labels distinguish owner photos and bound caller labels", () => {
    expect(campaignProvenanceLabel({ provenance: "source_photo" })).toBe("SOURCE IMAGE");
    expect(campaignProvenanceLabel({ provenance: "source_photo" }, { cutout: true, backdrop: true })).toBe("SOURCE CUTOUT · AI BACKDROP");
    expect(campaignProvenanceLabel({ provenance: "meta_illustration" }, { cutout: true })).toBe("ILLUSTRATIVE IMAGE");
    expect(campaignProvenanceLabel({ provenance: "owner_photo" })).toBe("OWNER PHOTO");
    expect(campaignProvenanceLabel({ provenance: "owner_photo" }, { cutout: true })).toBe("OWNER PHOTO · SAM CUTOUT");
    expect(campaignProvenanceLabel({ provenance: "owner_photo" }, { cutout: true, backdrop: true })).toBe("OWNER PHOTO · SAM CUTOUT · AI BACKDROP");
    expect(campaignProvenanceLabel({ provenance: "owner_photo", provenanceLabel: "Owner Instagram\n<post>" })).toBe("OWNER INSTAGRAM <POST>");
    expect(campaignProvenanceLabel({ provenance: "owner_photo", provenanceLabel: "  " })).toBe("OWNER PHOTO");
    expect(Array.from(campaignProvenanceLabel({ provenance: "owner_photo", provenanceLabel: "x".repeat(500) }))).toHaveLength(60);
  });

  test("the shared theme matches the renderer palette rules", () => {
    expect(resolveCampaignTheme({ vertical: "bakery" }).accent).toBe("#BB4D2F");
    expect(resolveCampaignTheme({ vertical: "unlisted craft" }).paper).toBe("#F5F2EC");
  });

  test("caller labels are escaped in rendered SVG and change the visible footer", async () => {
    const image = await photo("#00ff00", { provenanceLabel: "Owner upload & <synthetic>" });
    const normalized = await normalizeCampaignImage(image);
    const base = { businessName: "Synthetic bakery", vertical: "bakery", mode: "synthetic" as const, campaignName: "Label check", channels: [], outputDir: "/tmp" };
    const layout = { width: 1080, height: 1350, headline: "Meet the weekend loaf", body: "Ask about the loaf.", cta: "Ask us", kicker: "Loaf", variant: 0 };
    const labelled = await renderCampaignFrame({ ...base, image }, layout, normalized);
    const plain = await renderCampaignFrame({ ...base, image: { ...image, provenanceLabel: undefined } }, layout, normalized);
    const source = await renderCampaignFrame({ ...base, image: { ...image, provenanceLabel: undefined, provenance: "source_photo" } }, layout, normalized);
    // The footer pill sits on the photo's lower-left corner (imageTop 390 + imageHeight 610 - 54).
    const footer = (bytes: Buffer) => sharp(bytes).extract({ left: 82, top: 946, width: 600, height: 34 }).raw().toBuffer();
    expect(hashBytes(await footer(labelled))).not.toBe(hashBytes(await footer(plain)));
    expect(hashBytes(await footer(plain))).not.toBe(hashBytes(await footer(source)));
    expect(await pixel(labelled, 540, 700)).toEqual([0, 255, 0]);
  });

  test("channels and carousel slides use their routed images, each decoded and labelled", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tickr-render-routing-"));
    try {
      const channels = draft().channels.filter((channel) => channel.id !== "instagram_reels");
      const base: RenderInput = { businessName: "Synthetic bakery", vertical: "bakery", mode: "synthetic", campaignName: "Routing check", channels, outputDir, image: await photo("#ff0000", { provenance: "source_photo" }) };
      const colors = { instagram_feed: "#0000ff", facebook_ads: "#00ff00", instagram_stories: "#ffff00", click_to_whatsapp: "#ff00ff", whatsapp_status: "#00ffff" } as const;
      const channelImages = Object.fromEntries(await Promise.all(Object.entries(colors).map(async ([id, color]) => [id, await photo(color, { provenanceLabel: `Owner upload ${id}` })]))) as RenderInput["channelImages"];
      const carouselColors = ["#101010", "#404040", "#808080", "#c0c0c0"];
      // One JPEG and a repeated image exercise type-keyed decoding and the content-hash cache.
      const carouselImages = [await photo(carouselColors[0]), { ...await photo(carouselColors[1]), bytes: await solid(carouselColors[1], "jpeg"), mimeType: "image/jpeg" as const }, await photo(carouselColors[2]), await photo(carouselColors[3])];
      const routed = await renderCampaignAssets({ ...base, channelImages, carouselImages });
      const files = new Map(await Promise.all(routed.map(async (asset) => [asset.filename, await readFile(join(outputDir, asset.filename))] as const)));
      expect([...files.keys()].sort()).toEqual(["click_to_whatsapp.png", "facebook_ads.png", "facebook_ads_portrait.png", "instagram_carousel_1.png", "instagram_carousel_2.png", "instagram_carousel_3.png", "instagram_carousel_4.png", "instagram_feed.png", "instagram_stories.png", "whatsapp_status.png"]);
      for (const asset of routed) expect(hashBytes(files.get(asset.filename)!)).toBe(asset.sha256);
      expect(new Set(routed.map((asset) => asset.sha256)).size).toBe(routed.length);
      // Plain (non-art-directed) layouts place the photo in a centred band.
      expect(await pixel(files.get("instagram_feed.png")!, 540, 700)).toEqual([0, 0, 255]);
      expect(await pixel(files.get("facebook_ads.png")!, 540, 550)).toEqual([0, 255, 0]);
      expect(await pixel(files.get("facebook_ads_portrait.png")!, 540, 700)).toEqual([0, 255, 0]);
      expect(await pixel(files.get("instagram_stories.png")!, 540, 900)).toEqual([255, 255, 0]);
      expect(await pixel(files.get("whatsapp_status.png")!, 540, 900)).toEqual([0, 255, 255]);
      for (const [index, color] of carouselColors.entries()) {
        const expected = [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16));
        const actual = await pixel(files.get(`instagram_carousel_${index + 1}.png`)!, 540, 700);
        actual.forEach((value, channel) => expect(Math.abs(value - expected[channel])).toBeLessThanOrEqual(2));
      }
      // The routed frame is exactly the frame for that image and its own footer label.
      const feed = channelImages!.instagram_feed!;
      const feedIndex = channels.findIndex((channel) => channel.id === "instagram_feed");
      const expectedFeed = await renderCampaignFrame({ ...base, image: feed }, { width: 1080, height: 1350, headline: channels[feedIndex].headline, body: channels[feedIndex].body, cta: channels[feedIndex].cta, kicker: channels[feedIndex].title, variant: feedIndex, role: "hero" }, await normalizeCampaignImage(feed));
      expect(hashBytes(files.get("instagram_feed.png")!)).toBe(hashBytes(expectedFeed));
      const relabelled = await renderCampaignFrame({ ...base, image: { ...feed, provenanceLabel: "A different label" } }, { width: 1080, height: 1350, headline: channels[feedIndex].headline, body: channels[feedIndex].body, cta: channels[feedIndex].cta, kicker: channels[feedIndex].title, variant: feedIndex, role: "hero" }, await normalizeCampaignImage(feed));
      expect(hashBytes(relabelled)).not.toBe(hashBytes(expectedFeed));

      // Unrouted placements keep the shared image; routing changes only the routed hashes.
      const feedOnly = await renderCampaignAssets({ ...base, channelImages: { instagram_feed: feed } });
      const hash = (assets: typeof routed, filename: string) => assets.find((asset) => asset.filename === filename)!.sha256;
      expect(hash(feedOnly, "instagram_feed.png")).toBe(hash(routed, "instagram_feed.png"));
      expect(await pixel(await readFile(join(outputDir, "instagram_stories.png")), 540, 900)).toEqual([255, 0, 0]);
      expect(hash(feedOnly, "instagram_carousel_1.png")).not.toBe(hash(routed, "instagram_carousel_1.png"));

      await expect(renderCampaignAssets({ ...base, carouselImages: carouselImages.slice(0, 3) })).rejects.toThrow("exactly four images");
      await expect(renderCampaignAssets({ ...base, channelImages: { instagram_reels: feed } as unknown as RenderInput["channelImages"] })).rejects.toThrow("known placements");
      await expect(renderCampaignAssets({ ...base, channelImages: { instagram_feed: { ...feed, bytes: Buffer.from("<svg/>") } } })).rejects.toThrow("genuine PNG");
    } finally { await rm(outputDir, { recursive: true, force: true }); }
  }, 120_000);
});

describe("prebuilt Reel adoption", () => {
  const reelChannels = () => draft().channels.filter((channel) => channel.id === "instagram_reels");

  test("a contract-valid Reel and cover are copied in without a zoompan render", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tickr-render-reel-"));
    try {
      const assets = await renderCampaignAssets({ businessName: "Synthetic bakery", vertical: "bakery", mode: "synthetic", campaignName: "Reel check", channels: reelChannels(), outputDir, reel: { kind: "prebuilt", videoPath: reelPath, coverPath } });
      expect(assets.map(({ filename, mediaType, width, height, channel }) => ({ filename, mediaType, width, height, channel }))).toEqual([
        { filename: "instagram_reel.mp4", mediaType: "video", width: 1080, height: 1920, channel: "instagram_reels" },
        { filename: "instagram_reel_cover.png", mediaType: "image", width: 1080, height: 1920, channel: "instagram_reels" },
      ]);
      expect(assets[0].sha256).toBe(hashBytes(await readFile(reelPath)));
      expect(assets[1].sha256).toBe(hashBytes(await readFile(coverPath)));
      expect((await readdir(outputDir)).sort()).toEqual(["instagram_reel.mp4", "instagram_reel_cover.png"]);
    } finally { await rm(outputDir, { recursive: true, force: true }); }
  }, 60_000);

  test("wrong-contract media, relative paths and a missing Reel channel are rejected without leaking paths", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tickr-render-reel-bad-"));
    const base: RenderInput = { businessName: "Synthetic bakery", vertical: "bakery", mode: "synthetic", campaignName: "Reel check", channels: reelChannels(), outputDir };
    try {
      for (const reel of [
        { kind: "prebuilt" as const, videoPath: shortReelPath, coverPath },
        { kind: "prebuilt" as const, videoPath: yuv444ReelPath, coverPath },
        { kind: "prebuilt" as const, videoPath: audioReelPath, coverPath },
        { kind: "prebuilt" as const, videoPath: movReelPath, coverPath },
        { kind: "prebuilt" as const, videoPath: reelPath, coverPath: wrongCoverPath },
        { kind: "prebuilt" as const, videoPath: coverPath, coverPath },
        { kind: "prebuilt" as const, videoPath: "synthetic-reel.mp4", coverPath },
        { kind: "prebuilt" as const, videoPath: join(mediaDir, "missing.mp4"), coverPath },
      ]) {
        const error = await renderCampaignAssets({ ...base, reel }).then(() => null, (caught: Error) => caught);
        expect(error?.message).toBe("The prebuilt Reel did not meet its output contract and was not adopted.");
        expect(error?.message).not.toContain(mediaDir);
      }
      expect(await readdir(outputDir)).toEqual([]);
      await expect(renderCampaignAssets({ ...base, channels: [], reel: { kind: "prebuilt", videoPath: reelPath, coverPath } })).rejects.toThrow("Instagram Reels channel");
      await expect(renderCampaignAssets({ ...base, reel: { kind: "zoompan" } as unknown as RenderInput["reel"] })).rejects.toThrow("Unsupported Reel source");
    } finally { await rm(outputDir, { recursive: true, force: true }); }
  }, 60_000);
});

describe("composable campaign kit export", () => {
  test("extra assets and documents are hashed into campaign.assets, manifest.json and the verified ZIP", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tickr-render-kit-"));
    try {
      const input = campaignInput(outputDir);
      const still = await sharp({ create: { width: 640, height: 800, channels: 3, background: "#336699" } }).png().toBuffer();
      await writeFile(join(outputDir, "cinema-still-1.png"), still);
      const video = await readFile(shortReelPath);
      await writeFile(join(outputDir, "cinema-tracked-preview.mp4"), video);
      const ledger = JSON.stringify({ synthetic: true, frames: 2 });
      const result = await renderCampaignKit(input, opportunity, draft(), usage, {
        visual: typography,
        render: { channelImages: { instagram_feed: await photo("#0000ff") }, reel: { kind: "prebuilt", videoPath: reelPath, coverPath } },
        extraAssets: [
          { filename: "cinema-still-1.png", mediaType: "image", channel: "instagram_feed" },
          { id: "tracked-preview", filename: "cinema-tracked-preview.mp4", mediaType: "video", channel: "instagram_reels", width: 1080, height: 1920 },
        ],
        extraDocuments: [{ filename: "composition-ledger.json", content: ledger }],
        extraReviewNotes: ["Synthetic extra review note."],
      });
      const { campaign } = result;
      expect(result.usage).toEqual(usage);
      expect(campaign.reviewNotes).toContain("Synthetic extra review note.");
      expect(campaign.reviewNotes.some((note) => note.startsWith("Different images are routed"))).toBe(true);
      const byName = new Map(campaign.assets.map((asset) => [asset.filename, asset]));
      expect(byName.get("cinema-still-1.png")).toMatchObject({ id: "cinema-still-1", channel: "instagram_feed", mediaType: "image", width: 640, height: 800, sha256: hashBytes(still), bytes: still.length });
      expect(byName.get("cinema-tracked-preview.mp4")).toMatchObject({ id: "tracked-preview", channel: "instagram_reels", mediaType: "video", width: 1080, height: 1920, sha256: hashBytes(video) });
      expect(byName.get("composition-ledger.json")).toMatchObject({ mediaType: "document", width: null, height: null, sha256: hashBytes(Buffer.from(ledger)) });
      expect(byName.get("instagram_reel.mp4")?.sha256).toBe(hashBytes(await readFile(reelPath)));

      const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")) as { inventory: Array<{ filename: string; sha256: string }> };
      for (const filename of ["cinema-still-1.png", "cinema-tracked-preview.mp4", "composition-ledger.json", "instagram_reel.mp4"]) {
        expect(manifest.inventory.find((item) => item.filename === filename)?.sha256).toBe(byName.get(filename)!.sha256);
      }
      const review = JSON.parse(await readFile(join(outputDir, "review-report.json"), "utf8")) as { checks: Array<{ id: string; reason: string }>; assets: Array<{ filename: string }> };
      expect(review.checks.find((check) => check.id === "local-media")?.reason).toContain("adopted Reel");
      expect(review.assets.map((asset) => asset.filename)).toContain("cinema-tracked-preview.mp4");

      const zip = await readFile(join(outputDir, "campaign-concept.zip"));
      expect(hashBytes(zip)).toBe(byName.get("campaign-concept.zip")!.sha256);
      const entries = zipEntries(zip);
      expect([...entries.keys()]).toEqual(campaign.assets.filter((asset) => asset.mediaType !== "archive").map((asset) => asset.filename));
      expect(hashBytes(entries.get("cinema-still-1.png")!)).toBe(hashBytes(still));
      expect(hashBytes(entries.get("cinema-tracked-preview.mp4")!)).toBe(hashBytes(video));
      expect(entries.get("composition-ledger.json")!.toString("utf8")).toBe(ledger);
      expect(entries.has("manifest.json")).toBe(true);
    } finally { await rm(outputDir, { recursive: true, force: true }); }
  }, 120_000);

  test("extra names that are unsafe or collide with standard kit files or private run records are rejected before rendering", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tickr-render-kit-names-"));
    try {
      const input = campaignInput(outputDir);
      await writeFile(join(outputDir, "extra.png"), await solid("#123456"));
      const budget = JSON.stringify({ synthetic: "budget ledger" });
      await writeFile(join(outputDir, "autopilot-budget.json"), budget);
      const layer = { filename: "campaign-layer-extra.png", sha256: hashBytes(Buffer.from("x")), bytes: 1, width: 1, height: 1 };
      const attempts: Array<Parameters<typeof renderCampaignKit>[4]> = [
        { visual: typography, extraDocuments: [{ filename: "manifest.json", content: "{}" }] },
        { visual: typography, extraAssets: [{ filename: "instagram_feed.png", mediaType: "image", channel: null }] },
        { visual: typography, extraAssets: [{ filename: "copy-checkpoint.json", mediaType: "document", channel: null }] },
        { visual: typography, extraAssets: [{ filename: "extra.png", mediaType: "image", channel: null }], extraDocuments: [{ filename: "extra.png", content: "duplicate" }] },
        { visual: typography, extraDocuments: [{ filename: "README.txt", content: "case" }] },
        { visual: typography, extraDocuments: [{ filename: "../escape.json", content: "{}" }] },
        { visual: typography, extraDocuments: [{ filename: "notes.json.pending", content: "{}" }] },
        { visual: typography, extraDocuments: [{ filename: `${"a".repeat(102)}.json`, content: "{}" }] },
        { visual: typography, layerAssets: [layer], extraDocuments: [{ filename: layer.filename, content: "{}" }] },
        { visual: { ...typography, filename: "owner-hero.png" }, extraDocuments: [{ filename: "owner-hero.png", content: "{}" }] },
        { visual: typography, extraAssets: [{ filename: "extra.png", mediaType: "archive" as "image", channel: null }] },
        { visual: typography, extraReviewNotes: ["x".repeat(601)] },
        // Private run records that share outputDir: the paid-call budget, the analysis record and paid-response-store files.
        { visual: typography, extraDocuments: [{ filename: "autopilot-budget.json", content: "{}" }] },
        { visual: typography, extraAssets: [{ filename: "autopilot-budget.json", mediaType: "document", channel: null }] },
        { visual: typography, extraDocuments: [{ filename: "analysis-response.json", content: "{}" }] },
        { visual: typography, extraDocuments: [{ filename: "analysis-response.pending.json", content: "{}" }] },
        { visual: typography, extraDocuments: [{ filename: "sam-request.json", content: "{}" }] },
        { visual: typography, extraDocuments: [{ filename: "spark-critic-response.pending.json", content: "{}" }] },
        { visual: typography, extraDocuments: [{ filename: "cinema-checkpoint.json", content: "{}" }] },
        { visual: typography, extraDocuments: [{ filename: "cinema.partial.mp4", content: "x" }] },
        { visual: typography, extraAssets: [{ filename: "autopilot-public", mediaType: "document", channel: null }] },
        // Effective asset ids must not clash with standard ids (including manifest and the ZIP) or each other.
        { visual: typography, extraDocuments: [{ filename: "captions.txt", content: "x" }] },
        { visual: typography, extraAssets: [{ filename: "instagram_feed.webp", mediaType: "image", channel: null }] },
        { visual: typography, extraAssets: [{ id: "manifest", filename: "extra.png", mediaType: "image", channel: null }] },
        { visual: typography, extraAssets: [{ id: "campaign-concept", filename: "extra.png", mediaType: "image", channel: null }] },
        { visual: typography, extraAssets: [{ filename: "extra.png", mediaType: "image", channel: null }], extraDocuments: [{ filename: "extra.json", content: "{}" }] },
        { visual: typography, layerAssets: [layer], extraDocuments: [{ filename: "campaign-layer-extra.json", content: "{}" }] },
      ];
      for (const production of attempts) await expect(renderCampaignKit(input, opportunity, draft(), usage, production)).rejects.toThrow(/invalid/);
      await expect(renderCampaignKit(input, opportunity, draft(), usage, attempts[0])).rejects.toThrow("collides with a standard kit file");
      await expect(renderCampaignKit(input, opportunity, draft(), usage, { visual: typography, extraDocuments: [{ filename: "captions.txt", content: "x" }] })).rejects.toThrow("collides with a standard kit asset");
      expect((await readdir(outputDir)).sort()).toEqual(["autopilot-budget.json", "extra.png"]);
      expect(await readFile(join(outputDir, "autopilot-budget.json"), "utf8")).toBe(budget);
      await expect(renderCampaignKit(input, { ...opportunity, id: "other" }, draft(), usage, { visual: typography })).rejects.toThrow("Select an opportunity");
    } finally { await rm(outputDir, { recursive: true, force: true }); }
  });

  test("routing and extra-file input errors are plain errors raised before anything is rendered", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tickr-render-kit-preflight-"));
    try {
      const input = campaignInput(outputDir);
      const reel = { kind: "prebuilt" as const, videoPath: reelPath, coverPath };
      const image = await photo("#0000ff");
      await writeFile(join(outputDir, "sized-extra.png"), await solid("#123456"));
      await writeFile(join(outputDir, "cinema-preview.mp4"), await readFile(shortReelPath));
      await symlink(join(mediaDir, "synthetic-cover.png"), join(outputDir, "linked-extra.png"));
      await mkdir(join(outputDir, "cinema-folder.json"));
      const noReels = { ...draft(), channels: draft().channels.filter((channel) => channel.id !== "instagram_reels") };
      const attempts: Array<[CampaignCopy, Parameters<typeof renderCampaignKit>[4], string]> = [
        [draft(), { visual: typography, render: { carouselImages: [image, image, image] } }, "exactly four images"],
        [draft(), { visual: typography, render: { channelImages: { instagram_reels: image } as unknown as RenderInput["channelImages"] } }, "known placements"],
        [noReels, { visual: typography, render: { reel } }, "Instagram Reels channel"],
        [draft(), { visual: typography, render: { reel }, extraAssets: [{ filename: "missing-extra.png", mediaType: "image", channel: null }] }, "missing"],
        [draft(), { visual: typography, extraAssets: [{ filename: "sized-extra.png", mediaType: "image", channel: null, width: 999 }] }, "declared size"],
        [draft(), { visual: typography, extraAssets: [{ filename: "sized-extra.png", mediaType: "video", channel: null }] }, "declared size"],
        [draft(), { visual: typography, extraAssets: [{ filename: "cinema-preview.mp4", mediaType: "video", channel: "instagram_reels", width: 720, height: 1280 }] }, "declared size"],
        [draft(), { visual: typography, extraAssets: [{ filename: "linked-extra.png", mediaType: "image", channel: null }] }, "not a regular file"],
        [draft(), { visual: typography, extraDocuments: [{ filename: "cinema-folder.json", content: "{}" }] }, "other than a regular file"],
      ];
      for (const [copy, production, message] of attempts) {
        const error = await renderCampaignKit(input, opportunity, copy, usage, production).then(() => null, (caught: Error) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(CampaignRenderError);
        expect(error?.message).toContain(message);
        expect(error?.message).not.toContain(outputDir);
      }
      expect((await readdir(outputDir)).sort()).toEqual(["cinema-folder.json", "cinema-preview.mp4", "linked-extra.png", "sized-extra.png"]);
    } finally { await rm(outputDir, { recursive: true, force: true }); }
  });

  test("local failures after validation become retry-safe render errors", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tickr-render-kit-missing-"));
    try {
      const input = campaignInput(outputDir);
      const reel = { kind: "prebuilt" as const, videoPath: reelPath, coverPath };
      await expect(renderCampaignKit(input, opportunity, draft(), usage, { visual: typography, render: { reel: { ...reel, videoPath: shortReelPath } } })).rejects.toBeInstanceOf(CampaignRenderError);
      await expect(renderCampaignKit(input, opportunity, draft(), usage, { visual: typography, render: { reel: { ...reel, videoPath: audioReelPath } } })).rejects.toBeInstanceOf(CampaignRenderError);
    } finally { await rm(outputDir, { recursive: true, force: true }); }
  }, 120_000);
});

describe("ensureCampaignCopy", () => {
  const generate = vi.mocked(generateCampaignCopy);

  test("reserves a paid call only immediately before a new copy request", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tickr-ensure-copy-"));
    const order: string[] = [];
    try {
      const input = campaignInput(outputDir);
      generate.mockImplementationOnce(async () => { order.push("generate"); return { copy: draft(), usage }; });
      const reserveCopyCall = vi.fn(async () => { order.push("reserve"); });
      const first = await ensureCampaignCopy(input, { reserveCopyCall });
      expect(order).toEqual(["reserve", "generate"]);
      expect(first.usage).toEqual(usage);
      const checkpoint = JSON.parse(await readFile(join(outputDir, "copy-checkpoint.json"), "utf8")) as { inputHash: string };
      expect(checkpoint.inputHash).toBe(campaignInputHash(input));

      const again = await ensureCampaignCopy(input, { reserveCopyCall });
      expect(again.copy.name).toBe(first.copy.name);
      expect(reserveCopyCall).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(1);
    } finally { generate.mockClear(); await rm(outputDir, { recursive: true, force: true }); }
  });

  test("a refused reservation stops before the paid request, and stored or required checkpoints never reserve", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tickr-ensure-copy-stored-"));
    try {
      const input = campaignInput(outputDir);
      await expect(ensureCampaignCopy(input, { reserveCopyCall: async () => { throw new Error("Synthetic budget exhausted."); } })).rejects.toThrow("Synthetic budget exhausted.");
      expect(generate).not.toHaveBeenCalled();

      const reserveCopyCall = vi.fn(async () => undefined);
      await expect(ensureCampaignCopy({ ...input, requireCompletedCopy: true }, { reserveCopyCall })).rejects.toThrow("completed copy checkpoint is required");
      const product: CreateCampaignInput = { ...input, sources: [productSource], enrichment };
      const response: CompletedCopyResponse = { version: 1, status: "completed", responseId: "response-synthetic", model: "muse-spark-1.3", requestHash: hashBytes(Buffer.from("synthetic request")), receivedAt: new Date().toISOString(), usage, outputText: JSON.stringify(generatedDraft()) };
      await writeCompletedCopyRecord(outputDir, campaignInputHash(product), response);
      const replayed = await ensureCampaignCopy(product, { reserveCopyCall });
      expect(replayed.origin).toBe("completed_response");
      expect(replayed.usage).toEqual(usage);
      expect(reserveCopyCall).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      expect(replayed.copy.creativeBrief?.focus.name).toBe("Weekend loaf");
      await expect(readFile(join(outputDir, "copy-checkpoint.json"), "utf8")).resolves.toContain(campaignInputHash(product));

      await writeFile(join(outputDir, "copy-checkpoint.json"), "corrupt");
      await expect(ensureCampaignCopy(product, { reserveCopyCall })).rejects.toThrow("no longer matches");
      expect(reserveCopyCall).not.toHaveBeenCalled();
    } finally { generate.mockClear(); await rm(outputDir, { recursive: true, force: true }); }
  });
});
