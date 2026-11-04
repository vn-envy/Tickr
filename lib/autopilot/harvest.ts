import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { extractVideoPosterPng } from "../media/poster";
import { collectOfficialGallery, type OfficialGalleryResult } from "../media/gallery";
import { MAX_LIBRARY_ASSETS, MAX_LIBRARY_VIDEOS, MediaLibrary, MediaLibraryError, mediaLibraryIntegrityKey, type MediaAssetRecord, type MetaGraphMediaItem } from "../media/library";
import { MAX_OWNER_VIDEO_SECONDS } from "../media/uploads";
import type { OwnerMediaSource } from "../meta/graph";
import type { MetaAttestationRecord } from "./business-media";
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

/**
 * The connected Page (and its linked Instagram account) this business's media may come from.
 * Nothing at connect time records which Page belongs to which business, and one Meta login's
 * grants cover every business that login connected, so media is used only when the token grants
 * exactly one Page and that Page (and Instagram account) is the one shown when the owner connected.
 * Otherwise another branch's or business's media would be presented as this business's own.
 */
export function boundMetaSources(
  listing: { sources: readonly OwnerMediaSource[]; truncated: boolean },
  attestation: Pick<MetaAttestationRecord, "pageName" | "instagramUsername">,
  profile: (sources: OwnerMediaSource[]) => Pick<MetaAttestationRecord, "pageName" | "instagramUsername">,
): { sources: OwnerMediaSource[]; note: null } | { sources: []; note: string | null } {
  const pages = listing.sources.filter((source) => source.kind === "facebook_page");
  if (!pages.length && !listing.truncated) return { sources: [], note: null };
  if (pages.length !== 1 || listing.truncated) {
    return { sources: [], note: `The Meta connection gives access to ${listing.truncated ? "many" : pages.length} Facebook Pages, so Autopilot cannot tell which one is this business; connected media was not used. Reconnect and grant access only to this business's Page.` };
  }
  const page = pages[0];
  const bound = [page, ...listing.sources.filter((source) => source.kind === "instagram_account" && source.pageId === page.id)];
  const current = profile(bound);
  if ((attestation.pageName !== null && current.pageName !== attestation.pageName) || (attestation.instagramUsername !== null && current.instagramUsername !== attestation.instagramUsername)) {
    return { sources: [], note: "The connected Facebook Page or Instagram account no longer matches the one recorded when you connected, so its media was not used. Reconnect Instagram/Facebook for this business." };
  }
  return { sources: bound, note: null };
}

const isOwner = (provenance: MediaProvenance) => provenance === "owner_upload" || provenance === "owner_instagram" || provenance === "owner_facebook";
const recency = (asset: Pick<MediaAssetRecord, "capturedAt" | "addedAt">) => asset.capturedAt ?? asset.addedAt;
const newestFirst = (a: MediaAssetRecord, b: MediaAssetRecord) => recency(b).localeCompare(recency(a)) || a.id.localeCompare(b.id);

/**
 * Deterministic selection under the caps: owner media first (most recent first), then website
 * images in the order the gallery found them. Generated illustrations never enter the harvest.
 */
export function selectHarvest(assets: readonly MediaAssetRecord[], caps = { images: HARVEST_MAX_IMAGES, videos: HARVEST_MAX_VIDEOS }): { selected: MediaAssetRecord[]; overflow: { images: number; videos: number } } {
  const usable = assets.filter((asset) => asset.provenance !== "meta_illustration");
  const ordered = (kind: "image" | "video") => {
    const owner = usable.filter((asset) => asset.kind === kind && isOwner(asset.provenance)).sort(newestFirst);
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

/** One PNG poster frame from a private local video (shared hardened helper; HDR/BT.2020 tone mapped to BT.709 SDR). */
export async function videoPoster(path: string, durationSeconds: number | null, maxSide = THUMB_LONG_SIDE): Promise<Buffer> {
  const poster = await extractVideoPosterPng(path, durationSeconds, maxSide);
  if (!poster) throw new Error("A preview frame could not be read from a harvested video.");
  return poster;
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

/**
 * Owner-facing note for a gallery that yielded no photos. A site Tickr could not reach (or whose
 * images could not be downloaded) is a media-access limitation, never "the website has no photos".
 */
export function emptyGalleryNote(gallery: Pick<OfficialGalleryResult, "status" | "assets" | "pagesRead" | "skipped">): string | null {
  if (gallery.assets.length) return null;
  // No page read at all, or every photo download failed: the site was not readable this time.
  const unreadable = !gallery.pagesRead.length || (gallery.status !== "no_candidates" && gallery.skipped.some((item) => item.reason === "fetch_failed"));
  return unreadable ? "Tickr could not read the official website this time; no website photos were used." : "The official website offered no usable photos.";
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
  const [{ readMetaAttestation, metaAttestationConsent, connectionProfile }, graph, { loadOwnerToken }, { downloadMetaCdnMedia }] = await Promise.all([
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
  let bound: OwnerMediaSource[];
  try {
    const binding = boundMetaSources(await graph.listOwnerMediaSources(token.record.accessToken), attestation, connectionProfile);
    if (binding.note) return { connected: true, imported: 0, notes: [binding.note] };
    bound = binding.sources;
  } catch {
    return { connected: true, imported: 0, notes: ["The connected Instagram/Facebook accounts could not be listed; Autopilot continued with the other media."] };
  }
  for (const source of bound) {
    try { items.push(...(await graph.listOwnerMedia(token.record.accessToken, source, { limit: META_LIST_LIMIT })).items); }
    catch { notes.push("One connected account's media could not be listed; it was skipped."); }
  }
  const boundIds = new Set(bound.map((source) => source.id));
  const newest = (a: { timestamp: string | null }, b: { timestamp: string | null }) => (b.timestamp ?? "").localeCompare(a.timestamp ?? "");
  const usable = items.filter((item) => boundIds.has(item.sourceAccountId) && !(item.kind === "video" && item.durationSeconds !== null && item.durationSeconds > MAX_OWNER_VIDEO_SECONDS));
  const chosen = [
    ...usable.filter((item) => item.kind === "image").sort(newest).slice(0, Math.max(0, input.maxImages)),
    ...usable.filter((item) => item.kind === "video").sort(newest).slice(0, Math.max(0, input.maxVideos)),
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
 * a source that fails is reported in the notes and the others continue. The caps apply BEFORE
 * anything is copied: only the newest uploads that can still make the selection are verified and
 * copied, connected-account downloads stop at the library's remaining room, and copies the final
 * selection leaves out are removed from the run library.
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
  const uploadOverflow = { images: 0, videos: 0 };
  if (business) {
    const uploads = (await business.listAssets({ provenance: "owner_upload" })).sort(newestFirst);
    let skipped = 0;
    // Owner media ranks newest first, so uploads past the per-kind cap can never be selected: they
    // are neither re-hashed nor copied. A failed upload lets the next newest one take its place.
    const accepted: MediaAssetRecord[] = [];
    for (const kind of ["image", "video"] as const) {
      const cap = kind === "image" ? HARVEST_MAX_IMAGES : HARVEST_MAX_VIDEOS;
      const ofKind = uploads.filter((upload) => upload.kind === kind);
      let taken = 0, index = 0;
      for (; index < ofKind.length && taken < cap; index++) {
        try { accepted.push(await business.verifyAsset(ofKind[index].id)); taken++; }
        catch (error) {
          if (error instanceof MediaLibraryError && ["MANIFEST_INVALID", "MANIFEST_TAMPERED", "MANIFEST_KEY_REQUIRED", "LIBRARY_INVALID"].includes(error.code)) throw error;
          skipped++;
        }
      }
      uploadOverflow[kind === "image" ? "images" : "videos"] += ofKind.length - index;
    }
    // Oldest first, so the run library's own added-at order keeps the owner's newest upload newest.
    for (const verified of accepted.reverse()) {
      try {
        const result = await library.addAsset({
          kind: verified.kind, provenance: "owner_upload", filePath: verified.localPath, mimeType: verified.mimeType, expectedSha256: verified.sha256,
          consent: verified.consent, capturedAt: verified.capturedAt, caption: verified.caption, hints: { originalName: verified.hints.originalName },
        });
        if (result.status === "rejected") skipped++;
      } catch (error) {
        if (error instanceof MediaLibraryError && ["MANIFEST_INVALID", "MANIFEST_TAMPERED", "MANIFEST_KEY_REQUIRED", "LIBRARY_INVALID"].includes(error.code)) throw error;
        skipped++;
      }
    }
    if (skipped) notes.push(`${skipped} uploaded file${skipped === 1 ? "" : "s"} failed verification and ${skipped === 1 ? "was" : "were"} skipped.`);
  }

  try {
    // Never download what the run library has no room for (owner uploads outrank connected media).
    const held = await library.listAssets();
    const videosHeld = held.filter((asset) => asset.kind === "video").length;
    const maxVideos = Math.max(0, Math.min(HARVEST_MAX_VIDEOS, MAX_LIBRARY_VIDEOS - videosHeld, MAX_LIBRARY_ASSETS - held.length));
    const maxImages = Math.max(0, Math.min(HARVEST_MAX_IMAGES, MAX_LIBRARY_ASSETS - held.length - maxVideos));
    const outcome = await dependencies.harvestOwnerMeta({ businessId: input.businessId, connectionsDir: input.connectionsDir, library, workDir: input.workDir, maxImages, maxVideos });
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
      const emptyNote = emptyGalleryNote(gallery);
      if (emptyNote) notes.push(emptyNote);
      if (rejected) notes.push(`${rejected} website image${rejected === 1 ? "" : "s"} could not be added to the media library.`);
    } catch (error) {
      if (error instanceof MediaLibraryError && error.code !== "ASSET_INVALID") throw error;
      notes.push("The official website gallery could not be read; Autopilot continued with the other media.");
    } finally { await rm(galleryDir, { recursive: true, force: true }).catch(() => undefined); }
  }

  const held = await library.listAssets();
  const { selected, overflow: libraryOverflow } = selectHarvest(held);
  // Copies the selection leaves out are private duplicates nothing uses: remove them now.
  const keep = new Set(selected.map((asset) => asset.id));
  const unused = held.filter((asset) => !keep.has(asset.id) && asset.provenance !== "meta_illustration").map((asset) => asset.id);
  if (unused.length) await library.removeAssets(unused);
  const overflow = { images: libraryOverflow.images + uploadOverflow.images, videos: libraryOverflow.videos + uploadOverflow.videos };
  const leftOut = overflow.images + overflow.videos;
  if (leftOut) notes.push(`Autopilot used the ${HARVEST_MAX_IMAGES} most relevant images and ${HARVEST_MAX_VIDEOS} most recent videos; ${leftOut} more item${leftOut === 1 ? " was" : "s were"} left out.`);
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
