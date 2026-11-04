import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { SourceReadError } from "../research/source-reader";
import { normalizeOfficialImage } from "./acquire";
import { MediaReadError, type MediaCandidate, type MediaCandidateKind, type MediaTransport } from "./contracts";
import { extractGalleryPageLinks, extractOfficialGalleryReferences, type GalleryReference } from "./extract";
import { createOfficialMediaReader } from "./reader";

/**
 * Broader official-website gallery harvest for the Autopilot. It reuses the bounded official
 * media reader (origin, robots, reuse-restriction, redirect, size and timeout rules) and the
 * shared normalizer, then keeps distinct, decent-size photos. Page labels are untrusted data
 * and reuse rights stay unknown: everything is private concept material pending review.
 */
export const MAX_GALLERY_ASSETS = 12;
const MAX_GALLERY_ATTEMPTS = 24;
const MAX_GALLERY_PAGES = 3;
const MAX_SKIPPED_RECORDS = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 45_000;
const MIN_PHOTO_SHORT_EDGE = 200;
const MIN_LOGO_LONG_EDGE = 96;
const MAX_PHOTO_ASPECT = 3.2;
const MAX_LOGO_ASPECT = 6;
const MIN_DECLARED_EDGE = 100;
/** A new bounded reader is only started while at least this much of the overall budget remains. */
const MIN_READER_BUDGET_MS = 1_000;
const LOW_INFORMATION_STDEV = 6;
/** Hamming distance (of 64 bits) at or below which two dHashes are treated as the same picture. */
export const NEAR_DUPLICATE_DISTANCE = 6;

export type GalleryRole = "product" | "interior" | "storefront" | "social_preview" | "logo" | "page_image";
export type GallerySkipReason = "ineligible_reference" | "interface_asset" | "declared_too_small" | "too_small" | "extreme_aspect" | "low_information" | "duplicate" | "near_duplicate" | "logo_limit" | "fetch_failed" | "decode_failed";

export interface GalleryAsset {
  id: string;
  /** Hint from page metadata (JSON-LD type, Open Graph, alt text or file name). Not verified by vision. */
  role: GalleryRole;
  roleSource: "page_metadata";
  candidateKind: MediaCandidateKind;
  discoveredVia: MediaCandidate["discoveredVia"];
  /** Alt/caption/label text from the page, kept as data only. */
  label: string | null;
  productName: string | null;
  sourceUrl: string;
  sourcePageUrl: string;
  /** Other official URLs that resolved to the same or a near-identical picture. */
  duplicateSourceUrls: string[];
  retrievedAt: string;
  sourceMimeType: string;
  mimeType: "image/png";
  filename: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  sourceSha256: string;
  /** 64-bit difference hash (16 hex chars) of the normalized image. */
  dHash: string;
  normalization: "auto_orient_and_fit_1600_png";
  rights: "unknown_review_required";
  usage: "private_concept_review";
  requiresPublicationReview: true;
}

export interface OfficialGalleryResult {
  status: "acquired" | "partial" | "no_candidates" | "unavailable";
  officialWebsite: string;
  pagesRead: string[];
  candidatesFound: number;
  attempted: number;
  assets: GalleryAsset[];
  skipped: Array<{ imageUrl: string; reason: GallerySkipReason }>;
  /** Private machine paths. Omit this map from API responses and export manifests. */
  localFiles: Record<string, string>;
  warnings: string[];
  retrievedAt: string;
}

export function publicGalleryMetadata(result: OfficialGalleryResult): Omit<OfficialGalleryResult, "localFiles"> {
  const { localFiles: _privatePaths, ...metadata } = result;
  void _privatePaths;
  return metadata;
}

/** 64-bit difference hash: 9x8 greyscale, one bit per horizontal neighbour comparison. */
export async function imageDHash(input: Buffer | string): Promise<string> {
  const { data, info } = await sharp(input, { limitInputPixels: 50_000_000, failOn: "error", animated: false })
    .autoOrient().flatten({ background: "#ffffff" }).greyscale().resize(9, 8, { fit: "fill", kernel: "lanczos3" })
    .raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => data[(y * info.width + x) * info.channels];
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (at(x, y) > at(x + 1, y) ? 1n : 0n);
  return bits.toString(16).padStart(16, "0");
}

export function dHashDistance(a: string, b: string): number {
  if (!/^[a-f0-9]{16}$/.test(a) || !/^[a-f0-9]{16}$/.test(b)) throw new Error("Invalid perceptual hash.");
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (value) { count += Number(value & 1n); value >>= 1n; }
  return count;
}

/** Flat placeholders, blank frames and solid swatches carry no usable campaign picture. */
export async function isLowInformationImage(bytes: Buffer): Promise<boolean> {
  const stats = await sharp(bytes, { limitInputPixels: 50_000_000, failOn: "error" }).flatten({ background: "#ffffff" }).stats();
  return Math.max(...stats.channels.slice(0, 3).map((channel) => channel.stdev)) < LOW_INFORMATION_STDEV;
}

/** Unambiguous interface markers anywhere in the path (file name words or directory names). */
const INTERFACE_PATH = /(?:^|[/_.-])(?:favicons?|sprites?|spacer|placeholders?|loader|spinner|badges?|btn|emojis?|visa|mastercard|paypal|amex|captcha|tracking)(?:[/_.-]|$)/i;
const INTERFACE_DIRECTORY = /\/(?:icons?|emojis?|flags|ui|social-icons)\//i;
/**
 * Generic words (star, flag, arrow, pixel, ...) mark an interface graphic only as the whole file
 * stem, optionally with a size, direction or colour suffix, so "star-anise-latte.jpg" or
 * "flagship-store.jpg" stay photos. Real icons that slip through are removed by the size checks.
 */
const INTERFACE_STEM = /^(?:icons?|stars?|flags?|arrows?|chevrons?|pixel|blank|loading|buttons?|ratings?|avatars?|payments?|qr(?:-?code)?|close|menu|search|cart|hamburger)(?:[-_@.]?(?:\d+(?:x\d*)?|x\d+|left|right|up|down|prev|next|small|sm|xs|white|black|dark|light|grey|gray|half|full|empty|filled|outline))*$/i;

export function isInterfaceImagePath(pathname: string): boolean {
  let path = pathname;
  try { path = decodeURIComponent(pathname); } catch { /* keep the encoded path */ }
  const stem = (path.split("/").pop() ?? "").replace(/\.[a-z0-9]{2,5}$/i, "");
  return INTERFACE_PATH.test(path) || INTERFACE_DIRECTORY.test(path) || INTERFACE_STEM.test(stem);
}
const STOREFRONT = /\b(?:store ?front|shop ?front|exterior|outside|facade|façade|entrance|signage|street view|our (?:cafe|café|shop|store|bakery) from outside)\b/i;
const INTERIOR = /\b(?:interior|inside|seating|dining (?:area|room)|ambien[cs]e|our space|lounge|counter|decor|décor)\b/i;

function roleOf(candidate: MediaCandidate): GalleryRole {
  if (candidate.kind === "product") return "product";
  if (candidate.kind === "logo") return "logo";
  const hint = `${candidate.label ?? ""} ${new URL(candidate.imageUrl).pathname.replace(/[/_.-]+/g, " ")}`;
  if (STOREFRONT.test(hint)) return "storefront";
  if (INTERIOR.test(hint)) return "interior";
  return candidate.kind === "social_preview" ? "social_preview" : "page_image";
}

function attemptRank(candidate: MediaCandidate): number {
  if (candidate.kind === "product") return 0;
  if (candidate.kind === "social_preview") return 1;
  if (candidate.kind === "logo") return 2;
  return candidate.label ? 3 : 4;
}

function failureMessage(error: unknown): string {
  return error instanceof MediaReadError || error instanceof SourceReadError
    ? `${error.code}: ${error.message}`
    : "MEDIA_UNAVAILABLE: Official gallery acquisition failed; no unverified replacement was used.";
}

const CONNECTION_FAILURES = new Set(["DIRECT_CONNECTION_UNAVAILABLE", "CONNECTION_UNAVAILABLE", "PROXY_CONNECT_REJECTED", "TLS_UNVERIFIED"]);

type Reader = ReturnType<typeof createOfficialMediaReader>;
type Acquired = { candidate: MediaCandidate; source: Awaited<ReturnType<Reader["readImage"]>>; normalized: Awaited<ReturnType<typeof normalizeOfficialImage>> };

/**
 * Harvests up to 12 distinct official-website photos from the start page and at most two linked
 * same-origin gallery/menu/about pages. outputDir is an application-controlled private directory.
 * The existing collectOfficialMedia path is unchanged; this is an additional, broader reader.
 */
export async function collectOfficialGallery(
  input: { officialWebsite: string; outputDir: string; maxAssets?: number },
  options: { transport?: MediaTransport; timeoutMs?: number; maxPages?: number } = {},
): Promise<OfficialGalleryResult> {
  const result: OfficialGalleryResult = {
    status: "unavailable", officialWebsite: input.officialWebsite, pagesRead: [], candidatesFound: 0, attempted: 0,
    assets: [], skipped: [], localFiles: {}, warnings: [], retrievedAt: new Date().toISOString(),
  };
  const requested = typeof input.maxAssets === "number" && Number.isFinite(input.maxAssets) ? Math.floor(input.maxAssets) : MAX_GALLERY_ASSETS;
  const maxAssets = Math.min(MAX_GALLERY_ASSETS, Math.max(1, requested));
  const maxPages = Math.min(MAX_GALLERY_PAGES, Math.max(1, Math.floor(options.maxPages ?? MAX_GALLERY_PAGES)));
  const deadline = Date.now() + Math.min(MAX_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const readerTimeout = () => Math.max(1, Math.min(12_000, deadline - Date.now()));
  const readers: Reader[] = [];
  const skip = (imageUrl: string, reason: GallerySkipReason) => { if (result.skipped.length < MAX_SKIPPED_RECORDS) result.skipped.push({ imageUrl, reason }); };
  try {
    const main = createOfficialMediaReader(input.officialWebsite, { transport: options.transport, timeoutMs: readerTimeout() });
    readers.push(main);
    const page = await main.readPage();
    result.pagesRead.push(page.url);
    const queue: Array<GalleryReference & { page: number }> = [];
    const seen = new Set<string>();
    const enqueue = (references: GalleryReference[], pageIndex: number) => {
      for (const reference of references) {
        const urls = [reference.candidate, ...reference.alternates].map((item) => item.imageUrl);
        if (urls.some((url) => seen.has(url))) continue;
        for (const url of urls) seen.add(url);
        queue.push({ ...reference, page: pageIndex });
      }
    };
    enqueue(extractOfficialGalleryReferences(page.html, page.url), 0);
    for (const link of extractGalleryPageLinks(page.html, page.url, { max: maxPages - 1 })) {
      if (deadline - Date.now() < MIN_READER_BUDGET_MS) break;
      const reader = createOfficialMediaReader(link, { transport: options.transport, timeoutMs: readerTimeout() });
      readers.push(reader);
      try {
        const extra = await reader.readPage();
        if (new URL(extra.url).origin !== new URL(page.url).origin) continue;
        result.pagesRead.push(extra.url);
        enqueue(extractOfficialGalleryReferences(extra.html, extra.url), result.pagesRead.length - 1);
      } catch (error) {
        result.warnings.push(`Linked page skipped: ${failureMessage(error)}`);
        if (error instanceof MediaReadError && CONNECTION_FAILURES.has(error.code)) break;
      } finally { reader.close(); }
    }
    // Page readers carry one fixed timer each; image downloads get fresh readers bounded by the remaining budget.
    main.close();
    result.candidatesFound = queue.length;
    if (!queue.length) { result.status = "no_candidates"; return result; }

    const eligible = queue.filter(({ candidate }) => {
      if (!candidate.eligible) { skip(candidate.imageUrl, candidate.exclusionReason === "interface_asset" ? "interface_asset" : "ineligible_reference"); return false; }
      if (candidate.kind !== "logo" && isInterfaceImagePath(new URL(candidate.imageUrl).pathname)) { skip(candidate.imageUrl, "interface_asset"); return false; }
      const declared = [candidate.declaredWidth, candidate.declaredHeight].filter((value): value is number => value !== null);
      if (candidate.kind !== "logo" && declared.length && Math.min(...declared) < MIN_DECLARED_EDGE) { skip(candidate.imageUrl, "declared_too_small"); return false; }
      return true;
    }).map((entry, order) => ({ ...entry, alternates: entry.alternates.filter((item) => entry.candidate.kind === "logo" || !isInterfaceImagePath(new URL(item.imageUrl).pathname)), order }))
      .sort((a, b) => attemptRank(a.candidate) - attemptRank(b.candidate) || a.page - b.page
        || (b.candidate.declaredWidth ?? 0) * (b.candidate.declaredHeight ?? 0) - (a.candidate.declaredWidth ?? 0) * (a.candidate.declaredHeight ?? 0)
        || a.order - b.order);

    const directory = resolve(input.outputDir);
    const pageOrigin = new URL(page.url).origin;
    const pageStates = result.pagesRead.map(() => ({ reader: null as Reader | null, referencesLoaded: false, referencesFailed: false }));
    const bySha = new Map<string, GalleryAsset>();
    let failures = 0;
    let logos = 0;
    let connectionLost = false;
    const readerFor = (pageIndex: number): Reader | null => {
      const state = pageStates[pageIndex];
      if (state.reader) return state.reader;
      if (deadline - Date.now() < MIN_READER_BUDGET_MS) return null;
      state.reader = createOfficialMediaReader(result.pagesRead[pageIndex], { transport: options.transport, timeoutMs: readerTimeout() });
      state.referencesLoaded = false;
      readers.push(state.reader);
      return state.reader;
    };
    /** Tries the preferred rendition, then same-picture fallbacks after a fetch or decode failure. */
    const acquire = async (entry: (typeof eligible)[number]): Promise<Acquired | null> => {
      for (const option of [entry.candidate, ...entry.alternates]) {
        if (result.attempted >= MAX_GALLERY_ATTEMPTS) return null;
        const state = pageStates[entry.page];
        const crossOrigin = new URL(option.imageUrl).origin !== pageOrigin;
        if (crossOrigin && state.referencesFailed) { skip(option.imageUrl, "fetch_failed"); continue; }
        const reader = readerFor(entry.page);
        if (!reader) return null;
        result.attempted++;
        try {
          // Approved-CDN images must be exact references of the page as read by this same reader.
          if (crossOrigin && !state.referencesLoaded) {
            try { await reader.readPage(); state.referencesLoaded = true; }
            catch (error) { if (!(error instanceof MediaReadError && error.code === "READ_TIMEOUT")) state.referencesFailed = true; throw error; }
          }
          const source = await reader.readImage(option.imageUrl);
          return { candidate: option, source, normalized: await normalizeOfficialImage(source.body, source.contentType) };
        } catch (error) {
          failures++;
          result.warnings.push(`${option.id}: ${failureMessage(error)}`);
          const code = error instanceof MediaReadError || error instanceof SourceReadError ? error.code : "";
          skip(option.imageUrl, /^IMAGE_(?:DECODE|TYPE|DIMENSIONS)/.test(code) ? "decode_failed" : "fetch_failed");
          if (CONNECTION_FAILURES.has(code)) { connectionLost = true; return null; }
          // An expired reader is replaced on the next download while the overall budget lasts.
          if (code === "READ_TIMEOUT") { reader.close(); state.reader = null; return null; }
        }
      }
      return null;
    };
    for (const entry of eligible) {
      if (result.assets.length >= maxAssets || result.attempted >= MAX_GALLERY_ATTEMPTS || connectionLost) break;
      if (deadline - Date.now() < MIN_READER_BUDGET_MS) { result.warnings.push("The official gallery time budget ended before every image reference was read."); break; }
      if (entry.candidate.kind === "logo" && logos >= 1) { skip(entry.candidate.imageUrl, "logo_limit"); continue; }
      const acquired = await acquire(entry);
      if (!acquired) continue;
      const { candidate, source, normalized } = acquired;
      const { width, height } = normalized;
      const aspect = Math.max(width, height) / Math.min(width, height);
      if (candidate.kind === "logo" ? Math.max(width, height) < MIN_LOGO_LONG_EDGE : Math.min(width, height) < MIN_PHOTO_SHORT_EDGE) { skip(source.url, "too_small"); continue; }
      if (aspect > (candidate.kind === "logo" ? MAX_LOGO_ASPECT : MAX_PHOTO_ASPECT)) { skip(source.url, "extreme_aspect"); continue; }
      try {
        if (await isLowInformationImage(normalized.bytes)) { skip(source.url, "low_information"); continue; }
      } catch { skip(source.url, "decode_failed"); continue; }
      const sha256 = createHash("sha256").update(normalized.bytes).digest("hex");
      const exact = bySha.get(sha256);
      if (exact) { if (exact.duplicateSourceUrls.length < 8) exact.duplicateSourceUrls.push(source.url); skip(source.url, "duplicate"); continue; }
      const dHash = await imageDHash(normalized.bytes);
      const near = result.assets.find((asset) => dHashDistance(asset.dHash, dHash) <= NEAR_DUPLICATE_DISTANCE);
      const id = `gallery_${sha256.slice(0, 24)}`;
      const filename = `${id}.png`;
      if (near && width * height <= near.width * near.height * 1.25) {
        if (near.duplicateSourceUrls.length < 8) near.duplicateSourceUrls.push(source.url);
        skip(source.url, "near_duplicate");
        continue;
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const localPath = join(directory, filename);
      await writeFile(localPath, normalized.bytes, { mode: 0o600 });
      const asset: GalleryAsset = {
        id, role: roleOf(candidate), roleSource: "page_metadata", candidateKind: candidate.kind, discoveredVia: candidate.discoveredVia,
        label: candidate.label, productName: candidate.productName, sourceUrl: source.url, sourcePageUrl: candidate.sourcePageUrl,
        duplicateSourceUrls: [], retrievedAt: new Date().toISOString(), sourceMimeType: source.contentType, mimeType: "image/png",
        filename, width, height, bytes: normalized.bytes.length, sha256, sourceSha256: createHash("sha256").update(source.body).digest("hex"),
        dHash, normalization: "auto_orient_and_fit_1600_png", rights: "unknown_review_required", usage: "private_concept_review", requiresPublicationReview: true,
      };
      bySha.set(sha256, asset);
      if (near) {
        // A larger rendition of an already-kept picture replaces its pixels but keeps the earlier
        // (higher-priority) page metadata, and records the smaller rendition as a duplicate source.
        Object.assign(asset, {
          role: near.role, candidateKind: near.candidateKind, discoveredVia: near.discoveredVia,
          label: near.label ?? asset.label, productName: near.productName ?? asset.productName, sourcePageUrl: near.sourcePageUrl,
          duplicateSourceUrls: [near.sourceUrl, ...near.duplicateSourceUrls].slice(0, 8),
        });
        result.assets[result.assets.indexOf(near)] = asset;
        bySha.delete(near.sha256);
        await unlink(result.localFiles[near.id]).catch(() => undefined);
        delete result.localFiles[near.id];
      } else {
        result.assets.push(asset);
        if (candidate.kind === "logo") logos++;
      }
      result.localFiles[id] = localPath;
    }
    if (connectionLost) result.warnings.push("The official site connection was lost; remaining image references were not read.");
    const excluded = queue.length - eligible.length;
    if (excluded) result.warnings.push(`${excluded} referenced image(s) were not fetched because their origin, format, size or interface-only role is outside the automatic gallery boundary.`);
    result.status = result.assets.length ? failures || excluded ? "partial" : "acquired" : "unavailable";
    if (result.assets.length) result.warnings.push("Official-page references do not establish reuse rights or product identity. Gallery media is for private concept review; publication requires a separate rights and factual review.");
    else result.warnings.push("No usable official photo could be acquired. This is a media-access limitation, not proof that the business has no photos.");
    return result;
  } catch (error) {
    result.warnings.push(failureMessage(error));
    return result;
  } finally { for (const reader of readers) reader.close(); }
}
