import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { analyzeHarvest, chooseAnalysisVideos, MAX_ANALYZED_CLIPS, type AnalyzeDependencies } from "../../lib/autopilot/analyze";
import { boundMetaSources, emptyGalleryNote, HARVEST_MAX_VIDEOS, harvestMedia, type HarvestedAsset, type HarvestDependencies } from "../../lib/autopilot/harvest";
import type { OfficialGalleryResult } from "../../lib/media/gallery";
import type { NormalizedClip, OwnerMediaConsent } from "../../lib/media/cinema-types";
import { MAX_OWNER_CLIP_INPUT_SECONDS, OwnerClipError } from "../../lib/media/clip";
import { MediaLibrary } from "../../lib/media/library";
import { MAX_OWNER_VIDEO_SECONDS } from "../../lib/media/uploads";
import type { MediaAnalysisRequest } from "../../lib/meta/media-analysis";
import type { OwnerMediaSource } from "../../lib/meta/graph";

// Every page, account, clip and photo here is SYNTHETIC; no Meta request is made.
const run = promisify(execFile);
const consent: OwnerMediaConsent = { ownsOrLicensedMedia: true, peopleVisibleHaveConsented: "no_people", attestedAt: "2026-11-04T00:00:00.000Z" };
let root = "";

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "tickr-autopilot-harvest-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
beforeEach(() => { vi.stubEnv("TICKR_SECRET_KEY", ""); });

const page = (id: string, name: string): OwnerMediaSource => ({ kind: "facebook_page", id, name, provenance: "owner_facebook" }) as OwnerMediaSource;
const instagram = (id: string, pageId: string, username: string): OwnerMediaSource => ({ kind: "instagram_account", id, pageId, username, provenance: "owner_instagram" }) as OwnerMediaSource;
const profile = (sources: OwnerMediaSource[]) => ({
  pageName: sources.find((source) => source.kind === "facebook_page")?.name ?? null,
  instagramUsername: (sources.find((source) => source.kind === "instagram_account") as { username?: string } | undefined)?.username ?? null,
});

describe("connected-account binding", () => {
  const recorded = { pageName: "Synthetic Cafe Branch A", instagramUsername: "synthetic_branch_a" };

  test("several granted Pages are never pooled into one business's media", () => {
    const listing = { sources: [page("101", "Synthetic Cafe Branch A"), instagram("201", "101", "synthetic_branch_a"), page("102", "Synthetic Cafe Branch B"), instagram("202", "102", "synthetic_branch_b"), page("103", "Synthetic side business")], truncated: false };
    const bound = boundMetaSources(listing, recorded, profile);
    expect(bound.sources).toEqual([]);
    expect(bound.note).toMatch(/3 Facebook Pages/);
  });

  test("a truncated listing cannot prove a single Page", () => {
    const bound = boundMetaSources({ sources: [page("101", "Synthetic Cafe Branch A")], truncated: true }, recorded, profile);
    expect(bound.sources).toEqual([]);
    expect(bound.note).toMatch(/many Facebook Pages/);
  });

  test("exactly one Page, matching the one shown at connect time, is used with its own Instagram account only", () => {
    const listing = { sources: [page("101", "Synthetic Cafe Branch A"), instagram("201", "101", "synthetic_branch_a")], truncated: false };
    expect(boundMetaSources(listing, recorded, profile)).toEqual({ sources: listing.sources, note: null });
  });

  test("a Page or Instagram account that changed since connecting is not used", () => {
    const renamed = { sources: [page("105", "Synthetic Cafe Branch B"), instagram("205", "105", "synthetic_branch_b")], truncated: false };
    expect(boundMetaSources(renamed, recorded, profile).sources).toEqual([]);
    const relinked = { sources: [page("101", "Synthetic Cafe Branch A"), instagram("299", "101", "synthetic_other")], truncated: false };
    expect(boundMetaSources(relinked, recorded, profile).note).toMatch(/no longer matches/);
  });

  test("no Pages means no connected media and nothing to report", () => {
    expect(boundMetaSources({ sources: [], truncated: false }, recorded, profile)).toEqual({ sources: [], note: null });
  });
});

async function syntheticVideo(path: string, color: string) {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=160x160:r=10:d=1`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path], { timeout: 60_000 });
}

describe("harvest caps before copying", () => {
  test("only uploads that can make the selection are verified and copied, Meta downloads respect the room left, and unselected copies are removed", async () => {
    const base = join(root, "caps");
    const staging = join(base, "staging"), businessDir = join(base, "business"), outputDir = join(base, "run");
    await mkdir(staging, { recursive: true });
    const business = await MediaLibrary.open(businessDir);
    const colors = ["0x112233", "0x223344", "0x334455", "0x445566", "0x556677", "0x667788"];
    for (const [index, color] of colors.entries()) {
      const path = join(staging, `upload-${index}.mp4`);
      await syntheticVideo(path, color);
      await business.addAsset({ kind: "video", provenance: "owner_upload", filePath: path, mimeType: "video/mp4", consent, capturedAt: `2026-10-0${index + 1}T10:00:00.000Z`, hints: { originalName: `upload-${index}.mp4` } });
    }
    const verified: string[] = [];
    const verify = business.verifyAsset.bind(business);
    business.verifyAsset = async (id: string) => { verified.push(id); return verify(id); };

    const metaPath = join(staging, "meta-old.mp4");
    await syntheticVideo(metaPath, "0x778899");
    let metaRequest: { maxImages: number; maxVideos: number } | null = null;
    const dependencies: HarvestDependencies = {
      openBusinessLibrary: async () => business,
      collectGallery: async () => { throw new Error("No website in this fixture."); },
      harvestOwnerMeta: async (input) => {
        metaRequest = { maxImages: input.maxImages, maxVideos: input.maxVideos };
        // An older connected-account video the newest-first selection leaves out.
        await input.library.importMetaGraphItem({ sourceId: "17890000000000001", kind: "video", caption: null, permalink: null, timestamp: "2026-09-01T10:00:00+0000", provenance: "owner_instagram" }, { path: metaPath, mimeType: "video/mp4" }, consent);
        return { connected: true, imported: 1, notes: [] };
      },
    };
    const result = await harvestMedia({ outputDir, workDir: join(base, "work"), businessId: "synthetic-business", businessMediaDir: businessDir, connectionsDir: join(base, "connections"), website: null }, dependencies);

    // The two oldest uploads can never be selected, so they are neither re-hashed nor copied.
    expect(verified).toHaveLength(HARVEST_MAX_VIDEOS);
    expect(metaRequest).toEqual({ maxImages: expect.any(Number), maxVideos: HARVEST_MAX_VIDEOS });
    expect(result.selected).toHaveLength(HARVEST_MAX_VIDEOS);
    expect(result.selected.every((asset) => asset.provenance === "owner_upload")).toBe(true);
    expect(result.selected.map((asset) => asset.capturedAt).sort()).toEqual(["2026-10-03T10:00:00.000Z", "2026-10-04T10:00:00.000Z", "2026-10-05T10:00:00.000Z", "2026-10-06T10:00:00.000Z"]);
    expect(result.record.overflow).toEqual({ images: 0, videos: 3 });
    // The run library keeps only the selection: the unselected Meta copy is gone from the manifest and disk.
    expect((await result.library.listAssets()).map((asset) => asset.id).sort()).toEqual(result.selected.map((asset) => asset.id).sort());
    expect(await readdir(join(result.library.directory, "files"))).toHaveLength(HARVEST_MAX_VIDEOS);
  }, 120_000);
});

describe("website gallery notes", () => {
  const gallery = (overrides: Partial<OfficialGalleryResult>): OfficialGalleryResult => ({
    status: "unavailable", officialWebsite: "https://synthetic-cafe.example/", pagesRead: [], candidatesFound: 0, attempted: 0,
    assets: [], skipped: [], localFiles: {}, warnings: [], retrievedAt: "2026-11-04T00:00:00.000Z", ...overrides,
  });
  const unreadable = "Tickr could not read the official website this time; no website photos were used.";
  const noPhotos = "The official website offered no usable photos.";
  const downloadsFailed = "Tickr read your website, but its photos could not be downloaded (for example the image host blocks automated access); no website photos were used.";

  async function notesFor(result: OfficialGalleryResult, name: string) {
    const base = join(root, `gallery-${name}`);
    const dependencies: HarvestDependencies = {
      openBusinessLibrary: async () => MediaLibrary.open(join(base, "business")),
      collectGallery: async () => result,
      harvestOwnerMeta: async () => ({ connected: false, imported: 0, notes: [] }),
    };
    const harvested = await harvestMedia({ outputDir: join(base, "run"), workDir: join(base, "work"), businessId: "synthetic-business", businessMediaDir: join(base, "business"), connectionsDir: join(base, "connections"), website: "https://synthetic-cafe.example/" }, dependencies);
    return harvested.record.notes;
  }

  test("a site that could not be reached is not reported as having no photos", async () => {
    const notes = await notesFor(gallery({ warnings: ["CONNECTION_UNAVAILABLE: The official site could not be reached."] }), "unreachable");
    expect(notes).toContain(unreadable);
    expect(notes).not.toContain(noPhotos);
  });

  test("a read page whose photo downloads all failed says the site was read but its photos could not be downloaded", async () => {
    const failed = gallery({ pagesRead: ["https://synthetic-cafe.example/"], candidatesFound: 2, attempted: 2, skipped: [
      { imageUrl: "https://synthetic-cafe.example/a.jpg", reason: "fetch_failed" }, { imageUrl: "https://synthetic-cafe.example/b.jpg", reason: "fetch_failed" },
    ] });
    expect(emptyGalleryNote(failed)).toBe(downloadsFailed);
    const notes = await notesFor(failed, "downloads-failed");
    expect(notes).toContain(downloadsFailed);
    expect(notes).not.toContain(unreadable);
    expect(notes).not.toContain(noPhotos);
    // Mixed: some photos were too small, the rest could not be downloaded.
    expect(emptyGalleryNote(gallery({ pagesRead: ["https://synthetic-cafe.example/"], candidatesFound: 2, attempted: 2, skipped: [
      { imageUrl: "https://synthetic-cafe.example/icon.png", reason: "too_small" }, { imageUrl: "https://synthetic-cafe.example/a.jpg", reason: "fetch_failed" },
    ] }))).toBe(downloadsFailed);
  });

  test("any harvested photo means no empty-gallery note", () => {
    expect(emptyGalleryNote({ status: "partial", pagesRead: [], assets: [{} as OfficialGalleryResult["assets"][number]], skipped: [] })).toBeNull();
  });

  test("a read page with no candidate photos keeps the no-usable-photos wording", async () => {
    const notes = await notesFor(gallery({ status: "no_candidates", pagesRead: ["https://synthetic-cafe.example/"] }), "empty");
    expect(notes).toContain(noPhotos);
    expect(notes).not.toContain(unreadable);
    expect(emptyGalleryNote(gallery({ pagesRead: ["https://synthetic-cafe.example/"], candidatesFound: 3, skipped: [{ imageUrl: "https://synthetic-cafe.example/icon.png", reason: "too_small" }] }))).toBe(noPhotos);
  });
});

const video = (id: string, addedAt: string, durationSeconds: number | null, provenance: HarvestedAsset["provenance"] = "owner_upload"): HarvestedAsset => ({
  assetId: id, kind: "video", provenance, rights: "owner_attested", sha256: "a".repeat(64), mimeType: "video/mp4", width: 640, height: 360,
  durationSeconds, capturedAt: null, addedAt, caption: null, consent, sourcePageUrl: null,
});

describe("analysis clip selection", () => {
  test("the clip normalizer accepts every duration owner intake accepts", () => {
    expect(MAX_OWNER_CLIP_INPUT_SECONDS).toBe(MAX_OWNER_VIDEO_SECONDS);
  });

  test("candidates are not cut to two before preparation, and over-long footage is never a candidate", () => {
    const assets = [video("short", "2026-10-01T00:00:00.000Z", 15), video("walk-1", "2026-10-02T00:00:00.000Z", 240), video("walk-2", "2026-10-03T00:00:00.000Z", 300), video("huge", "2026-10-04T00:00:00.000Z", MAX_OWNER_CLIP_INPUT_SECONDS + 1)];
    expect(chooseAnalysisVideos(assets).map((asset) => asset.assetId)).toEqual(["walk-2", "walk-1", "short"]);
  });

  test("a clip that fails local preparation gives its slot to the next candidate, and every clip's frames are risk-checked", async () => {
    const directory = join(root, "analyze");
    await mkdir(directory, { recursive: true });
    const clipPath = join(directory, "fake-clip.mp4");
    await writeFile(clipPath, Buffer.alloc(1024));
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#808080" } }).png().toBuffer();
    const assets = [video("newest", "2026-10-03T00:00:00.000Z", 120), video("middle", "2026-10-02T00:00:00.000Z", 90), video("oldest", "2026-10-01T00:00:00.000Z", 15)];
    const normalized: string[] = [];
    const sentIds: string[] = [];
    const clipFor = (sourcePath: string): NormalizedClip => ({ path: clipPath, sha256: "b".repeat(64), width: 320, height: 180, fps: 30, frameCount: 90, durationSeconds: 3, original: { sha256: "c".repeat(64), width: 640, height: 360, durationSeconds: 15 }, sourcePath } as unknown as NormalizedClip);
    const dependencies: AnalyzeDependencies = {
      normalizeClip: (async (input: { sourcePath: string }) => {
        normalized.push(input.sourcePath);
        if (input.sourcePath.endsWith("newest")) throw new OwnerClipError("TRANSCODE_FAILED", "The clip could not be prepared locally.");
        return clipFor(input.sourcePath);
      }) as unknown as AnalyzeDependencies["normalizeClip"],
      extractFrame: (async () => png) as unknown as AnalyzeDependencies["extractFrame"],
      analyzeMedia: (async (request: MediaAnalysisRequest) => {
        sentIds.push(...request.assets.map((asset) => asset.assetId));
        return {
          model: "muse-spark-1.3", usage: { inputTokens: 1, outputTokens: 1 }, elapsedMs: 1,
          assets: request.assets.map((asset) => ({ assetId: asset.assetId, subjectKind: "product", risks: asset.assetId.startsWith("middle:") ? [{ kind: "possible_minor", box: null }] : [] })),
        };
      }) as unknown as AnalyzeDependencies["analyzeMedia"],
      analyzeShots: (async () => ({ model: "muse-spark-1.3", usage: { inputTokens: 1, outputTokens: 1 }, elapsedMs: 1, heroMomentSeconds: 1, peopleVisible: false, moments: [] })) as unknown as AnalyzeDependencies["analyzeShots"],
    };
    const library = { verifyAsset: async (id: string) => ({ localPath: join(directory, id) }) } as unknown as MediaLibrary;
    const record = await analyzeHarvest({
      directory, binding: "synthetic-binding", assets, library, goal: "Synthetic goal", business: { name: "Synthetic", category: "cafe" }, offerings: [],
      gate: async () => "reserved", dependencies,
    });
    // The failed newest clip does not cost the oldest, usable one its analysis slot.
    expect(normalized.map((path) => path.split("/").at(-1))).toEqual(["newest", "middle", "oldest"]);
    expect(Object.keys(record.clips).sort()).toEqual(["middle", "oldest"]);
    expect(Object.keys(record.clips)).toHaveLength(MAX_ANALYZED_CLIPS);
    expect(sentIds.some((id) => id.startsWith("middle:f")) && sentIds.some((id) => id.startsWith("oldest:f"))).toBe(true);
    const byId = new Map(record.assets.map((asset) => [asset.assetId, asset]));
    expect(byId.get("middle")?.frameRisks?.risks.map((risk) => risk.kind)).toContain("possible_minor");
    // Always-excluded footage is not sent for a paid shot log.
    expect(byId.get("middle")?.shotLog).toBeNull();
    expect(byId.get("oldest")?.frameRisks).toEqual({ framesChecked: expect.any(Number), risks: [] });
    expect(byId.get("oldest")?.shotLog).not.toBeNull();
    expect(byId.get("newest")?.frameRisks).toBeNull();
  });
});
