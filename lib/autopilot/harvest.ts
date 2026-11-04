import { execFile } from "node:child_process";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { collectOfficialGallery, type OfficialGalleryResult } from "../media/gallery";
import { MediaLibrary, MediaLibraryError, mediaLibraryIntegrityKey, type MediaAssetRecord, type MetaGraphMediaItem } from "../media/library";
import type { OwnerMediaConsent } from "../media/cinema-types";
import { validateSourceUrl } from "../research/source-reader";
import type { BusinessContext, CollectedSource } from "../research/contracts";
import type { MediaProvenance, MediaRights } from "./contracts";

/**
 * Autopilot harvest: builds the run's private media library from the owner's uploads, the
 * official website gallery (permitted bounded reader) and owner-connected Instagram/Facebook
 * media (Meta Graph + Meta CDN only, with the owner's connection attestation). Maps, social and
 * listing URLs are never read. Captions and page labels are untrusted data.
 */
export const HARVEST_MAX_IMAGES = 40;
export const HARVEST_MAX_VIDEOS = 4;
export const THUMB_LONG_SIDE = 480;
const META_LIST_LIMIT = 25;
const POSTER_TIMEOUT_MS = 20_000;
const POSTER_MAX_BUFFER = 16 * 1024 * 1024;
const DEMUXERS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm";
const execFileAsync = promisify(execFile);

export interface HarvestedAsset {
  assetId: string;
  kind: "image" | "video";
  provenance: MediaProvenance;
  rights: MediaRights;
  sha256: string;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number | null;
  capturedAt: string | null;
  addedAt: string;
  /** Owner / Instagram caption or website label: untrusted DATA. */
  caption: string | null;
  consent: OwnerMediaConsent | null;
  sourcePageUrl: string | null;
}

export interface HarvestSources { officialWebsite: number; ownerUploads: number; ownerInstagram: number; ownerFacebook: number; connected: boolean }

export interface HarvestRecord {
  version: 1;
  website: string | null;
  assets: HarvestedAsset[];
  sources: HarvestSources;
  /** Media found but left out by the caps. */
  overflow: { images: number; videos: number };
  notes: string[];
}

export interface MetaHarvestOutcome { connected: boolean; imported: number; notes: string[] }

export interface HarvestDependencies {
  /** The owner's business upload library, or null when none exists yet. */
  openBusinessLibrary: (directory: string, businessId: string) => Promise<MediaLibrary | null>;
  collectGallery: (input: { officialWebsite: string; outputDir: string }) => Promise<OfficialGalleryResult>;
  /** Imports owner-connected Meta media into the run library; returns connected=false without an attested, valid connection. */
  harvestOwnerMeta: (input: { businessId: string; connectionsDir: string; library: MediaLibrary; workDir: string; maxImages: number; maxVideos: number }) => Promise<MetaHarvestOutcome>;
}

/** The first candidate that the official-site reader would accept (never Maps, social, listing or search URLs). */
export function officialWebsiteFor(business: Pick<BusinessContext, "website">, sources: readonly Pick<CollectedSource, "kind" | "url">[]): string | null {
  const candidates = [business.website, ...sources.filter((source) => source.kind === "official_website").map((source) => source.url)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { return validateSourceUrl(candidate).href; } catch { /* Not an official website: references only. */ }
  }
  return null;
}

const isOwner = (provenance: MediaProvenance) => provenance === "owner_upload" || provenance === "owner_instagram" || provenance === "owner_facebook";
const recency = (asset: Pick<MediaAssetRecord, "capturedAt" | "addedAt">) => asset.capturedAt ?? asset.addedAt;

/**
 * Deterministic selection under the caps: owner media first (most recent first), then website
 * images in the order the gallery found them. Generated illustrations never enter the harvest.
 */
export function selectHarvest(assets: readonly MediaAssetRecord[], caps = { images: HARVEST_MAX_IMAGES, videos: HARVEST_MAX_VIDEOS }): { selected: MediaAssetRecord[]; overflow: { images: number; videos: number } } {
  const usable = assets.filter((asset) => asset.provenance !== "meta_illustration");
  const ordered = (kind: "image" | "video") => {
    const owner = usable.filter((asset) => asset.kind === kind && isOwner(asset.provenance))
      .sort((a, b) => recency(b).localeCompare(recency(a)) || a.id.localeCompare(b.id));
    const website = usable.filter((asset) => asset.kind === kind && asset.provenance === "official_website")
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id));
    return [...owner, ...website];
  };
  const images = ordered("image"), videos = ordered("video");
  return {
    selected: [...images.slice(0, caps.images), ...videos.slice(0, caps.videos)],
    overflow: { images: Math.max(0, images.length - caps.images), videos: Math.max(0, videos.length - caps.videos) },
  };
}

export function toHarvestedAsset(asset: MediaAssetRecord): HarvestedAsset {
  return {
    assetId: asset.id, kind: asset.kind, provenance: asset.provenance, rights: asset.rights, sha256: asset.sha256, mimeType: asset.mimeType,
    width: asset.width, height: asset.height, durationSeconds: asset.durationSeconds, capturedAt: asset.capturedAt, addedAt: asset.addedAt,
    caption: asset.caption, consent: asset.consent, sourcePageUrl: asset.sourcePageUrl,
  };
}

/** Open (or create) the run's private media library under <outputDir>/media-library. */
export function openRunLibrary(outputDir: string): Promise<MediaLibrary> {
  return MediaLibrary.open(outputDir, { integrityKey: mediaLibraryIntegrityKey() });
}

/** Minimal child environment: server credentials never reach FFmpeg. */
function toolEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
  if (process.env.LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH;
  return env;
}

/** One PNG poster frame from a private local video (file protocol, allow-listed demuxers, bounded output). */
export async function videoPoster(path: string, durationSeconds: number | null, maxSide = THUMB_LONG_SIDE): Promise<Buffer> {
  const preferred = durationSeconds !== null && durationSeconds > 1.5 ? Math.min(1, durationSeconds / 3) : 0;
  for (const at of preferred > 0 ? [preferred, 0] : [0]) {
    try {
      const { stdout } = await execFileAsync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2", "-protocol_whitelist", "file,pipe", "-format_whitelist", DEMUXERS,
        "-ss", at.toFixed(3), "-i", `file:${path}`, "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1",
        "-vf", `scale=w=${maxSide}:h=${maxSide}:force_original_aspect_ratio=decrease`, "-f", "image2pipe", "-c:v", "png", "pipe:1",
      ], { encoding: "buffer", timeout: POSTER_TIMEOUT_MS, maxBuffer: POSTER_MAX_BUFFER, killSignal: "SIGKILL", windowsHide: true, env: toolEnv() });
      if (stdout.length > 8) return stdout;
    } catch { /* Try the first frame; child errors carry local paths and are never forwarded. */ }
  }
  throw new Error("A preview frame could not be read from a harvested video.");
}

/** ≤480 px JPEG thumbnail without metadata (video → poster frame). */
export async function harvestThumbnail(asset: Pick<MediaAssetRecord, "kind" | "localPath" | "durationSeconds">): Promise<Buffer> {
  const source = asset.kind === "video" ? await videoPoster(asset.localPath, asset.durationSeconds) : asset.localPath;
  return sharp(source, { limitInputPixels: 50_000_000, failOn: "error", animated: false })
    .rotate().resize({ width: THUMB_LONG_SIDE, height: THUMB_LONG_SIDE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
}

async function exists(path: string): Promise<boolean> {
  try { return (await lstat(path)).isDirectory(); } catch { return false; }
}

/** Default dependencies: the worker's real business library, official gallery reader and Meta Graph connection. */
export const defaultHarvestDependencies: HarvestDependencies = {
  openBusinessLibrary: async (directory, businessId) => {
    if (!(await exists(directory))) return null;
    const media = await import("./business-media");
    // The route helper upgrades an unkeyed manifest once; use it when the directory is the business's own.
    let own = false;
    try { own = media.businessMediaDir(businessId) === directory; } catch { own = false; }
    if (own) return media.openBusinessLibrary(businessId);
    return MediaLibrary.open(directory, { integrityKey: mediaLibraryIntegrityKey() });
  },
  collectGallery: (input) => collectOfficialGallery(input),
  harvestOwnerMeta: harvestOwnerMetaMedia,
};

/**
 * Owner-connected Instagram/Facebook media. Used ONLY with an authenticated attestation and a
 * valid stored token; bytes come from Meta CDNs only. Newest first, bounded per kind.
 */
export async function harvestOwnerMetaMedia(input: { businessId: string; connectionsDir: string; library: MediaLibrary; workDir: string; maxImages: number; maxVideos: number }): Promise<MetaHarvestOutcome> {
  const [{ readMetaAttestation, metaAttestationConsent }, graph, { loadOwnerToken }, { downloadMetaCdnMedia }] = await Promise.all([
    import("./business-media"), import("../meta/graph"), import("../meta/graph-tokens"), import("../media/meta-cdn"),
  ]);
  if (graph.getMetaConnectorStatus().status !== "ready") return { connected: false, imported: 0, notes: [] };
  const attestation = await readMetaAttestation(input.businessId, { directory: input.connectionsDir });
  if (!attestation) return { connected: false, imported: 0, notes: [] };
  let token: Awaited<ReturnType<typeof loadOwnerToken>>;
  try { token = await loadOwnerToken(input.businessId, { directory: input.connectionsDir }); }
  catch { return { connected: false, imported: 0, notes: ["The stored Meta connection could not be read; reconnect Instagram/Facebook to include that media."] }; }
  if (token.status === "expired") return { connected: false, imported: 0, notes: ["The Meta connection has expired; reconnect Instagram/Facebook to include that media."] };
  if (token.status !== "connected") return { connected: false, imported: 0, notes: [] };
  const consent = metaAttestationConsent(attestation);
  const notes: string[] = [];
  const items: Awaited<ReturnType<typeof graph.listOwnerMedia>>["items"] = [];
  try {
    const { sources } = await graph.listOwnerMediaSources(token.record.accessToken);
    for (const source of sources.slice(0, 4)) {
      try { items.push(...(await graph.listOwnerMedia(token.record.accessToken, source, { limit: META_LIST_LIMIT })).items); }
      catch { notes.push("One connected account's media could not be listed; it was skipped."); }
    }
  } catch {
    return { connected: true, imported: 0, notes: ["The connected Instagram/Facebook accounts could not be listed; Autopilot continued with the other media."] };
  }
  const newest = (a: { timestamp: string | null }, b: { timestamp: string | null }) => (b.timestamp ?? "").localeCompare(a.timestamp ?? "");
  const chosen = [
    ...items.filter((item) => item.kind === "image").sort(newest).slice(0, input.maxImages),
    ...items.filter((item) => item.kind === "video").sort(newest).slice(0, input.maxVideos),
  ];
  const downloads = join(input.workDir, "meta-cdn");
  await mkdir(downloads, { recursive: true, mode: 0o700 });
  let imported = 0, failed = 0;
  try {
    for (const item of chosen) {
      try {
        const file = await downloadMetaCdnMedia(item.mediaUrl, { kind: item.kind, outputDir: downloads });
        try {
          const graphItem: MetaGraphMediaItem = { sourceId: item.sourceId, kind: item.kind, caption: item.caption, permalink: item.permalink, timestamp: item.timestamp, provenance: item.provenance };
          const result = await input.library.importMetaGraphItem(graphItem, { path: file.path, mimeType: file.mimeType, sha256: file.sha256 }, consent);
          if (result.status === "added" || result.status === "replaced") imported++;
        } finally { await rm(file.path, { force: true }); }
      } catch (error) {
        if (error instanceof MediaLibraryError && ["MANIFEST_INVALID", "MANIFEST_TAMPERED", "MANIFEST_KEY_REQUIRED", "LIBRARY_INVALID"].includes(error.code)) throw error;
        failed++;
      }
    }
  } finally { await rm(downloads, { recursive: true, force: true }); }
  if (failed) notes.push(`${failed} connected-account media item${failed === 1 ? "" : "s"} could not be downloaded or validated and ${failed === 1 ? "was" : "were"} skipped.`);
  return { connected: true, imported, notes };
}

/**
 * Builds the run library and selects at most 40 images and 4 videos. Each source is optional:
 * a source that fails is reported in the notes and the others continue.
 */
export async function harvestMedia(input: {
  outputDir: string; workDir: string; businessId: string; businessMediaDir: string; connectionsDir: string; website: string | null;
}, dependencies: HarvestDependencies): Promise<{ record: HarvestRecord; library: MediaLibrary; selected: MediaAssetRecord[] }> {
  const library = await openRunLibrary(input.outputDir);
  const notes: string[] = [];
  let connected = false;

  let business: MediaLibrary | null = null;
  try { business = await dependencies.openBusinessLibrary(input.businessMediaDir, input.businessId); }
  catch { notes.push("The owner's uploaded media could not be verified, so it was not used. Re-upload it or ask the operator to check the server secret."); }
  if (business) {
    const uploads = (await business.listAssets({ provenance: "owner_upload" })).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    let skipped = 0;
    for (const upload of uploads) {
      try {
        const verified = await business.verifyAsset(upload.id);
        await library.addAsset({
          kind: verified.kind, provenance: "owner_upload", filePath: verified.localPath, mimeType: verified.mimeType, expectedSha256: verified.sha256,
          consent: verified.consent, capturedAt: verified.capturedAt, caption: verified.caption, hints: { originalName: verified.hints.originalName },
        });
      } catch (error) {
        if (error instanceof MediaLibraryError && ["MANIFEST_INVALID", "MANIFEST_TAMPERED", "MANIFEST_KEY_REQUIRED", "LIBRARY_INVALID"].includes(error.code)) throw error;
        skipped++;
      }
    }
    if (skipped) notes.push(`${skipped} uploaded file${skipped === 1 ? "" : "s"} failed verification and ${skipped === 1 ? "was" : "were"} skipped.`);
  }

  try {
    const outcome = await dependencies.harvestOwnerMeta({ businessId: input.businessId, connectionsDir: input.connectionsDir, library, workDir: input.workDir, maxImages: HARVEST_MAX_IMAGES, maxVideos: HARVEST_MAX_VIDEOS });
    connected = outcome.connected;
    notes.push(...outcome.notes);
  } catch (error) {
    if (error instanceof MediaLibraryError && error.code !== "ASSET_INVALID") throw error;
    notes.push("Connected Instagram/Facebook media could not be imported; Autopilot continued with the other media.");
  }

  if (input.website) {
    const galleryDir = join(input.workDir, "gallery");
    try {
      const gallery = await dependencies.collectGallery({ officialWebsite: input.website, outputDir: galleryDir });
      const outcomes = await library.importFromGallery(gallery);
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected").length;
      if (!gallery.assets.length) notes.push("The official website offered no usable photos.");
      if (rejected) notes.push(`${rejected} website image${rejected === 1 ? "" : "s"} could not be added to the media library.`);
    } catch (error) {
      if (error instanceof MediaLibraryError && error.code !== "ASSET_INVALID") throw error;
      notes.push("The official website gallery could not be read; Autopilot continued with the other media.");
    } finally { await rm(galleryDir, { recursive: true, force: true }).catch(() => undefined); }
  }

  const { selected, overflow } = selectHarvest(await library.listAssets());
  if (overflow.images || overflow.videos) notes.push(`Autopilot used the ${HARVEST_MAX_IMAGES} most relevant images and ${HARVEST_MAX_VIDEOS} most recent videos; ${overflow.images + overflow.videos} more item${overflow.images + overflow.videos === 1 ? " was" : "s were"} left out.`);
  const count = (provenance: MediaProvenance) => selected.filter((asset) => asset.provenance === provenance).length;
  return {
    library, selected,
    record: {
      version: 1, website: input.website, assets: selected.map(toHarvestedAsset),
      sources: { officialWebsite: count("official_website"), ownerUploads: count("owner_upload"), ownerInstagram: count("owner_instagram"), ownerFacebook: count("owner_facebook"), connected },
      overflow, notes,
    },
  };
}
