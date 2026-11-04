import { createHash } from "node:crypto";
import { validateSourceUrl } from "../research/source-reader";
import { MediaReadError, type MediaCandidate, type MediaCandidateKind } from "./contracts";
import { isApprovedStaticCdnAsset } from "./policy";

export const MAX_MEDIA_HTML_BYTES = 512 * 1024;
const MAX_CANDIDATES = 24;
const MAX_JSON_LD_BYTES = 128 * 1024;

function decode(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (!code.startsWith("#")) return named[code.toLowerCase()] ?? entity;
    const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : " ";
  });
}

function text(value: unknown, max = 180): string | null {
  return typeof value === "string" ? decode(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null : null;
}

function dimension(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,6}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 100000 ? n : null;
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  const body = tag.replace(/^<\s*[a-z][a-z0-9:-]*/i, "").replace(/\/?\s*>$/, "");
  for (const match of body.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const key = match[1].toLowerCase();
    if (!(key in result)) result[key] = decode(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function imageReferences(value: unknown): Array<{ url: string; label: string | null; width: number | null; height: number | null }> {
  const values = Array.isArray(value) ? value.slice(0, 12) : [value];
  return values.flatMap((entry) => {
    if (typeof entry === "string") return [{ url: entry, label: null, width: null, height: null }];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const url = typeof item.contentUrl === "string" ? item.contentUrl : typeof item.url === "string" ? item.url : null;
    return url ? [{ url, label: text(item.caption) ?? text(item.name), width: dimension(item.width), height: dimension(item.height) }] : [];
  });
}

/** Renditions wider than this add download cost without helping a 1600 px normalized frame. */
const PREFERRED_RENDITION_WIDTH = 2000;
const MAX_GALLERY_ALTERNATES = 2;
const MAX_SRCSET_CHARS = 16 * 1024;
const MAX_SRCSET_CANDIDATES = 16;
/**
 * Renditions of one <img srcset> recorded by the standard extractor (in rendition preference order):
 * the gallery's preferred download plus its fallbacks, so each is an exact reader reference.
 */
const MAX_STANDARD_SRCSET_RENDITIONS = 1 + MAX_GALLERY_ALTERNATES;

export interface Rendition { url: string; width: number; density: number }

const SRCSET_SPACE = /[\t\n\f\r ]/;

/**
 * Parses a srcset attribute with the HTML Standard's "parse a srcset attribute" algorithm: a URL
 * is a run of non-whitespace characters (so commas inside URLs, as in CDN image-resizing paths like
 * /cdn-cgi/image/format=auto,w=375/x.jpg, stay part of the URL), trailing commas end a URL with no
 * descriptors, and descriptors run until a comma outside parentheses. Candidates with invalid
 * descriptors are dropped, as are inline data:/blob: URLs. Bounded in input and output size.
 */
export function parseSrcset(value: string | undefined): Rendition[] {
  if (!value) return [];
  const truncated = value.length > MAX_SRCSET_CHARS;
  const input = value.slice(0, MAX_SRCSET_CHARS);
  const candidates: Rendition[] = [];
  let position = 0;
  while (position < input.length && candidates.length < MAX_SRCSET_CANDIDATES) {
    while (position < input.length && (SRCSET_SPACE.test(input[position]) || input[position] === ",")) position++;
    if (position >= input.length) break;
    const urlStart = position;
    while (position < input.length && !SRCSET_SPACE.test(input[position])) position++;
    let url = input.slice(urlStart, position);
    const descriptors: string[] = [];
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      // Descriptor tokenizer: whitespace separates descriptors; a comma outside parentheses ends the candidate.
      while (position < input.length && SRCSET_SPACE.test(input[position])) position++;
      let current = "";
      let state: "descriptor" | "parens" | "after" = "descriptor";
      for (; ;) {
        const c = position < input.length ? input[position] : null;
        if (state === "descriptor") {
          if (c === null) { if (current) descriptors.push(current); break; }
          if (SRCSET_SPACE.test(c)) { if (current) descriptors.push(current); current = ""; state = "after"; }
          else if (c === ",") { position++; if (current) descriptors.push(current); break; }
          else { current += c; if (c === "(") state = "parens"; }
        } else if (state === "parens") {
          if (c === null) { if (current) descriptors.push(current); break; }
          current += c;
          if (c === ")") state = "descriptor";
        } else {
          if (c === null) break;
          if (!SRCSET_SPACE.test(c)) { state = "descriptor"; continue; }
        }
        position++;
        if (current.length > 256) return candidates;
      }
    }
    let width: number | null = null, density: number | null = null, height: number | null = null, invalid = false;
    for (const descriptor of descriptors) {
      const number = descriptor.slice(0, -1);
      const unit = descriptor.slice(-1);
      if (unit === "w" && /^\d{1,6}$/.test(number) && width === null && density === null && Number(number) > 0) width = Number(number);
      else if (unit === "x" && /^(?:\d{1,4}(?:\.\d{1,6})?|\.\d{1,6})$/.test(number) && width === null && density === null && height === null && Number(number) > 0) density = Number(number);
      else if (unit === "h" && /^\d{1,6}$/.test(number) && height === null && density === null && Number(number) > 0) height = Number(number);
      else invalid = true;
    }
    if (height !== null && width === null) invalid = true;
    // A candidate cut off by the input bound may be a partial URL.
    if (truncated && position >= input.length) break;
    if (invalid || !url || /^(?:data|blob):/i.test(url)) continue;
    candidates.push({ url, width: width ?? 0, density: density ?? 1 });
  }
  return candidates;
}

/**
 * Orders the renditions of one picture: the widest at most 2000 px first, then narrower ones, then
 * oversize ones from the smallest; density-only entries follow, highest density first.
 */
function orderRenditions(entries: Rendition[]): string[] {
  const sized = entries.filter((entry) => entry.width > 0);
  const fitting = sized.filter((entry) => entry.width <= PREFERRED_RENDITION_WIDTH).sort((a, b) => b.width - a.width);
  const oversize = sized.filter((entry) => entry.width > PREFERRED_RENDITION_WIDTH).sort((a, b) => a.width - b.width);
  const density = entries.filter((entry) => entry.width === 0).sort((a, b) => b.density - a.density);
  return [...fitting, ...oversize, ...density].map((entry) => entry.url);
}

/** Parses inert metadata only. Does not execute HTML, infer unseen products or fetch images. */
export function extractOfficialMediaCandidates(html: string, sourcePageUrl: string, options: { preferredProduct?: string } = {}): MediaCandidate[] {
  if (Buffer.byteLength(html) > MAX_MEDIA_HTML_BYTES) throw new MediaReadError("PAGE_TOO_LARGE", "Official page exceeds the media-discovery limit.");
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  const page = validateSourceUrl(sourcePageUrl);
  const found = new Map<string, MediaCandidate>();
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const preferred = options.preferredProduct ? normalize(options.preferredProduct) : "";
  const exactMatch = (candidate: Pick<MediaCandidate, "productName" | "label">) => preferred && [candidate.productName, candidate.label].some((label) => label && normalize(label) === preferred) ? 1 : 0;
  const ranks: Record<MediaCandidateKind, number> = { product: 0, logo: 1, social_preview: 2, page_image: 3 };
  // Position of a URL among its picture's renditions (0 = preferred). Ordering by it keeps the
  // capped output broad: every picture's preferred rendition before any picture's fallbacks.
  const tiers = new Map<string, number>();
  const add = (rawUrl: string, data: Omit<MediaCandidate, "id" | "imageUrl" | "sourcePageUrl" | "eligible" | "exclusionReason" | "rights">, tier = 0) => {
    if (!rawUrl || rawUrl.length > 2048 || found.size >= 80 && !exactMatch(data)) return;
    let url: URL;
    try { url = new URL(decode(rawUrl.trim()), page); } catch { return; }
    // Inline and unsupported-scheme references are not useful source assets.
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return;
    url.hash = "";
    let exclusionReason: MediaCandidate["exclusionReason"] = null;
    try { validateSourceUrl(url.href); } catch { exclusionReason = "unsupported_url"; }
    if (!exclusionReason && url.origin !== page.origin && !isApprovedStaticCdnAsset(url)) exclusionReason = "cross_origin";
    if (/\.(?:svg|gif|avif|tiff?|pdf)(?:$)/i.test(url.pathname)) exclusionReason = "unsupported_url";
    if (data.kind === "page_image" && (/\b(?:icon|google play|app store)\b/i.test(data.label ?? "") || /(?:-badge|_ic)\.[a-z]+$/i.test(url.pathname))) exclusionReason = "interface_asset";
    const candidate: MediaCandidate = {
      ...data,
      id: `candidate_${createHash("sha256").update(`${page.href}\n${url.href}`).digest("hex").slice(0, 20)}`,
      imageUrl: url.href,
      sourcePageUrl: page.href,
      eligible: exclusionReason === null,
      exclusionReason,
      rights: "unknown",
    };
    const previous = found.get(url.href);
    if (!previous && found.size >= 80) {
      const replaceable = [...found.values()].reverse().find((item) => !exactMatch(item));
      if (!replaceable) return;
      found.delete(replaceable.imageUrl);
      tiers.delete(replaceable.imageUrl);
    }
    if (!previous || ranks[candidate.kind] < ranks[previous.kind]) found.set(url.href, candidate);
    tiers.set(url.href, Math.min(tier, tiers.get(url.href) ?? tier));
  };

  // JSON-LD is read as data. No eval, remote @context resolution or script execution.
  const lower = html.toLowerCase();
  let scriptCount = 0;
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    if (++scriptCount > 40) break;
    const attrs = attributes(match[0]);
    if (attrs.type?.toLowerCase() !== "application/ld+json") continue;
    const start = match.index! + match[0].length;
    const end = lower.indexOf("</script", start);
    if (end < 0 || end - start > MAX_JSON_LD_BYTES) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(html.slice(start, end)); } catch { continue; }
    const queue: unknown[] = [parsed];
    let visited = 0;
    while (queue.length && visited++ < 500) {
      const value = queue.shift();
      if (!value || typeof value !== "object") continue;
      if (Array.isArray(value)) { queue.push(...value.slice(0, 50)); continue; }
      const object = value as Record<string, unknown>;
      const types = (Array.isArray(object["@type"]) ? object["@type"] : [object["@type"]])
        .filter((item): item is string => typeof item === "string").map((item) => item.split(/[\/#]/).pop()?.toLowerCase());
      const productName = types.includes("product") ? text(object.name) : null;
      for (const ref of imageReferences(object.image)) add(ref.url, {
        kind: types.includes("product") ? "product" : "page_image", discoveredVia: "json_ld",
        productName, label: ref.label ?? productName ?? text(object.name), declaredWidth: ref.width, declaredHeight: ref.height,
      });
      for (const ref of imageReferences(object.logo)) add(ref.url, {
        kind: "logo", discoveredVia: "json_ld", productName: null, label: ref.label ?? text(object.name), declaredWidth: ref.width, declaredHeight: ref.height,
      });
      for (const entry of Object.values(object).slice(0, 50)) if (entry && typeof entry === "object") queue.push(entry);
    }
  }

  // Image-like strings embedded in executable scripts, styles or inert
  // templates are not image elements displayed by the official page.
  const hiddenRanges: Array<{ start: number; end: number }> = [];
  let hiddenUntil = -1;
  for (const match of html.matchAll(/<(script|style|template|noscript)\b[^>]*>/gi)) {
    if (match.index! < hiddenUntil) continue;
    const close = lower.indexOf(`</${match[1].toLowerCase()}`, match.index! + match[0].length);
    const end = close < 0 ? html.length : html.indexOf(">", close) + 1;
    hiddenRanges.push({ start: match.index!, end: end || html.length });
    hiddenUntil = end || html.length;
  }
  let lastOgUrl: string | null = null;
  let hiddenRangeIndex = 0;
  for (const match of html.matchAll(/<(?:meta|img)\b[^>]*>/gi)) {
    while (hiddenRanges[hiddenRangeIndex]?.end <= match.index!) hiddenRangeIndex++;
    const hidden = hiddenRanges[hiddenRangeIndex];
    if (hidden && match.index! >= hidden.start && match.index! < hidden.end) continue;
    const attrs = attributes(match[0]);
    if (/^<meta\b/i.test(match[0])) {
      const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
      if (["og:image", "og:image:url", "og:image:secure_url", "twitter:image"].includes(key) && attrs.content) {
        add(attrs.content, { kind: "social_preview", discoveredVia: "open_graph", productName: null, label: null, declaredWidth: null, declaredHeight: null });
        try { lastOgUrl = new URL(attrs.content, page).href; } catch { lastOgUrl = null; }
      } else if (lastOgUrl && found.has(lastOgUrl)) {
        const item = found.get(lastOgUrl)!;
        if (key === "og:image:alt" && !item.label) item.label = text(attrs.content);
        if (key === "og:image:width") item.declaredWidth ??= dimension(attrs.content);
        if (key === "og:image:height") item.declaredHeight ??= dimension(attrs.content);
      }
      continue;
    }
    // The same preference order as the gallery (responsive renditions, then lazy and plain sources),
    // so the gallery's preferred download and fallbacks for each picture are exact references here.
    const responsive = orderRenditions([...parseSrcset(attrs["data-srcset"]), ...parseSrcset(attrs.srcset)]).slice(0, MAX_STANDARD_SRCSET_RENDITIONS);
    const label = text(attrs.alt) ?? text(attrs.title);
    // Recorded in page-attribute order (src first); the tier follows the preference order.
    const preference = [...responsive, attrs["data-src"], attrs.src].filter((url): url is string => Boolean(url));
    for (const rawUrl of [attrs.src, attrs["data-src"], ...responsive]) if (rawUrl) add(rawUrl, {
      kind: "page_image", discoveredVia: "html_image", productName: null,
      label, declaredWidth: dimension(attrs.width), declaredHeight: dimension(attrs.height),
    }, preference.indexOf(rawUrl));
  }
  return [...found.values()].sort((a, b) => exactMatch(b) - exactMatch(a) || Number(b.eligible) - Number(a.eligible) || ranks[a.kind] - ranks[b.kind]
    || (tiers.get(a.imageUrl) ?? 0) - (tiers.get(b.imageUrl) ?? 0)).slice(0, MAX_CANDIDATES);
}

const MAX_GALLERY_CANDIDATES = 64;
const IMAGE_FILE = /\.(?:jpe?g|png|webp)$/i;

/** Ranges of script/style/template/noscript content, whose image-like strings are not displayed images. */
function hiddenRangesOf(html: string): Array<{ start: number; end: number }> {
  const lower = html.toLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  let hiddenUntil = -1;
  for (const match of html.matchAll(/<(script|style|template|noscript)\b[^>]*>/gi)) {
    if (match.index! < hiddenUntil) continue;
    const close = lower.indexOf(`</${match[1].toLowerCase()}`, match.index! + match[0].length);
    const end = close < 0 ? html.length : html.indexOf(">", close) + 1 || html.length;
    ranges.push({ start: match.index!, end });
    hiddenUntil = end;
  }
  return ranges;
}

function visibleTags(html: string, pattern: RegExp): RegExpMatchArray[] {
  const ranges = hiddenRangesOf(html);
  let index = 0;
  return [...html.matchAll(pattern)].filter((match) => {
    while (ranges[index]?.end <= match.index!) index++;
    const hidden = ranges[index];
    return !(hidden && match.index! >= hidden.start && match.index! < hidden.end);
  });
}

/** One displayed picture: the reference to download first and same-picture fallbacks for fetch/decode failures. */
export interface GalleryReference {
  candidate: MediaCandidate;
  alternates: MediaCandidate[];
}

/**
 * Broader gallery discovery for one official page: the structured (JSON-LD/Open Graph) candidates
 * plus one reference per displayed picture. All renditions of an element (src, lazy-load
 * attributes, srcset widths, <picture> sources and a wrapping full-size link) collapse into a single
 * reference so one photo costs one download; the other renditions are kept only as fallbacks.
 * Additional references are eligible only on the page's own origin (or an approved CDN asset the
 * standard extractor already accepts); labels are data.
 */
export function extractOfficialGalleryReferences(html: string, sourcePageUrl: string, options: { max?: number } = {}): GalleryReference[] {
  const base = extractOfficialMediaCandidates(html, sourcePageUrl);
  const max = Math.min(MAX_GALLERY_CANDIDATES, Math.max(1, Math.floor(options.max ?? 48)));
  const stripped = html.replace(/<!--[\s\S]*?-->/g, "");
  const page = validateSourceUrl(sourcePageUrl);
  // The official reader only fetches approved-CDN images that the standard extractor accepted.
  const readerReferenced = new Set(base.filter((candidate) => candidate.eligible).map((candidate) => candidate.imageUrl));
  const references: GalleryReference[] = base.filter((candidate) => candidate.discoveredVia !== "html_image").slice(0, max)
    .map((candidate) => ({ candidate, alternates: [] }));
  const byUrl = new Map(references.map((reference) => [reference.candidate.imageUrl, reference.candidate]));

  const build = (rawUrl: string, label: string | null, width: number | null, height: number | null): MediaCandidate | null => {
    if (!rawUrl || rawUrl.length > 2048 || /^\s*(?:data|blob|javascript):/i.test(rawUrl)) return null;
    let url: URL;
    try { url = new URL(decode(rawUrl.trim()), page); } catch { return null; }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return null;
    url.hash = "";
    let exclusionReason: MediaCandidate["exclusionReason"] = null;
    try { validateSourceUrl(url.href); } catch { exclusionReason = "unsupported_url"; }
    if (!exclusionReason && url.origin !== page.origin && !(isApprovedStaticCdnAsset(url) && readerReferenced.has(url.href))) exclusionReason = "cross_origin";
    if (/\.(?:svg|gif|avif|tiff?|pdf|ico)$/i.test(url.pathname)) exclusionReason = "unsupported_url";
    if (/\b(?:icon|google play|app store)\b/i.test(label ?? "") || /(?:-badge|_ic|favicon|sprite)[^/]*\.[a-z]+$/i.test(url.pathname)) exclusionReason ??= "interface_asset";
    return {
      id: `candidate_${createHash("sha256").update(`${page.href}\n${url.href}`).digest("hex").slice(0, 20)}`,
      imageUrl: url.href, sourcePageUrl: page.href, kind: "page_image", discoveredVia: "html_image",
      label, productName: null, declaredWidth: width, declaredHeight: height,
      eligible: exclusionReason === null, exclusionReason, rights: "unknown",
    };
  };
  /** Adds one picture from its renditions in preference order, unless any rendition is already listed. */
  const addPicture = (rawUrls: Array<string | undefined>, label: string | null, width: number | null = null, height: number | null = null) => {
    if (references.length >= max) return;
    const seen = new Set<string>();
    const renditions = rawUrls.slice(0, 24).flatMap((rawUrl) => {
      const candidate = rawUrl ? build(rawUrl, label, width, height) : null;
      if (!candidate || seen.has(candidate.imageUrl)) return [];
      seen.add(candidate.imageUrl);
      return [candidate];
    });
    const listed = renditions.map((candidate) => byUrl.get(candidate.imageUrl)).find(Boolean);
    if (listed) { listed.label ??= label; return; }
    const usable = renditions.filter((candidate) => candidate.eligible);
    const [primary, ...alternates] = usable.length ? usable : renditions;
    if (!primary) return;
    for (const candidate of renditions) byUrl.set(candidate.imageUrl, primary);
    references.push({ candidate: primary, alternates: usable.length ? alternates.slice(0, MAX_GALLERY_ALTERNATES) : [] });
  };

  const labelOf = (attrs: Record<string, string>) => text(attrs.alt) ?? text(attrs.title) ?? text(attrs["aria-label"]) ?? text(attrs["data-caption"]);
  let pictureSources: Rendition[] | null = null;
  let anchor: { href: string; label: string | null } | null = null;
  for (const match of visibleTags(stripped, /<\/?[a-z][a-z0-9-]*\b[^>]*>/gi)) {
    if (references.length >= max) break;
    const closing = match[0][1] === "/";
    const tag = /^<\/?([a-z][a-z0-9-]*)/i.exec(match[0])![1].toLowerCase();
    if (closing) {
      if (tag === "picture" && pictureSources) { addPicture(orderRenditions(pictureSources), null); pictureSources = null; }
      if (tag === "a" && anchor) { addPicture([anchor.href], anchor.label); anchor = null; }
      continue;
    }
    const attrs = attributes(match[0]);
    const label = labelOf(attrs);
    if (tag === "picture") pictureSources = [];
    else if (tag === "source") {
      if (!attrs.type || /^image\/(?:png|jpeg|webp)$/i.test(attrs.type)) {
        const entries = parseSrcset(attrs.srcset ?? attrs["data-srcset"]);
        if (pictureSources) pictureSources.push(...entries);
        else addPicture(orderRenditions(entries), label);
      }
    } else if (tag === "img") {
      const responsive = orderRenditions([...(pictureSources ?? []), ...parseSrcset(attrs["data-srcset"]), ...parseSrcset(attrs.srcset)]);
      addPicture([...responsive, anchor?.href, attrs["data-lazy-src"], attrs["data-src"], attrs["data-original"], attrs.src], label, dimension(attrs.width), dimension(attrs.height));
      pictureSources = null;
      anchor = null;
    } else if (tag === "a") {
      anchor = null;
      try { if (attrs.href && IMAGE_FILE.test(new URL(decode(attrs.href.trim()), page).pathname)) anchor = { href: attrs.href, label }; } catch { /* not a URL */ }
    }
    for (const url of [attrs["data-bg"], attrs["data-background"], attrs["data-background-image"]]) if (url) addPicture([url], label);
    const style = attrs.style ?? "";
    for (const css of style.slice(0, 2048).matchAll(/background(?:-image)?\s*:[^;]*?url\(\s*(["']?)([^"')\s]{1,2048})\1\s*\)/gi)) addPicture([css[2]], label);
  }
  if (pictureSources) addPicture(orderRenditions(pictureSources), null);
  if (anchor) addPicture([anchor.href], anchor.label);
  return references.slice(0, max);
}

/** The preferred reference of every picture on the page (see extractOfficialGalleryReferences). */
export function extractOfficialGalleryCandidates(html: string, sourcePageUrl: string, options: { max?: number } = {}): MediaCandidate[] {
  return extractOfficialGalleryReferences(html, sourcePageUrl, options).map((reference) => reference.candidate);
}

const GALLERY_LINK_PRIORITY: Array<[RegExp, number]> = [
  [/\b(?:gallery|galleries|photos?|pictures|images|instagram-feed)\b/i, 0],
  [/\b(?:menu|menus|food|drinks?|coffee|bakery|dishes|products?|shop|our-?space|interiors?|ambien[cs]e)\b/i, 1],
  [/\b(?:about|about-us|our-?story|story|visit)\b/i, 2],
];

/**
 * Same-origin pages on the official site that probably show the business's own photos.
 * Branch/location listings are excluded so another branch's material is not mixed in.
 */
export function extractGalleryPageLinks(html: string, sourcePageUrl: string, options: { max?: number } = {}): string[] {
  const page = validateSourceUrl(sourcePageUrl);
  const max = Math.min(4, Math.max(0, Math.floor(options.max ?? 2)));
  const stripped = html.replace(/<!--[\s\S]*?-->/g, "");
  const ranked = new Map<string, number>();
  for (const match of visibleTags(stripped, /<a\b[^>]*>/gi).slice(0, 400)) {
    const attrs = attributes(match[0]);
    if (!attrs.href || attrs.href.length > 2048 || /\bnofollow\b/i.test(attrs.rel ?? "")) continue;
    let url: URL;
    try { url = validateSourceUrl(new URL(decode(attrs.href.trim()), page).href); } catch { continue; }
    if (url.origin !== page.origin || url.search.length > 200 || IMAGE_FILE.test(url.pathname) || /\.(?:pdf|svg|gif|zip|docx?)$/i.test(url.pathname)) continue;
    url.hash = "";
    if (url.href === page.href) continue;
    const close = stripped.toLowerCase().indexOf("</a", match.index! + match[0].length);
    const anchor = text(close < 0 ? "" : stripped.slice(match.index! + match[0].length, Math.min(close, match.index! + match[0].length + 400)).replace(/<[^>]*>/g, " "), 120) ?? "";
    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep the encoded path */ }
    const haystack = `${path.replace(/[/_]+/g, " ")} ${anchor} ${attrs.title ?? ""}`;
    if (/\b(?:locations?|branches|branch|stores?-locator|find-us|franchise|careers?|jobs|login|cart|checkout|account|privacy|terms)\b/i.test(haystack)) continue;
    const priority = GALLERY_LINK_PRIORITY.find(([pattern]) => pattern.test(haystack))?.[1];
    if (priority === undefined) continue;
    if (!ranked.has(url.href) || ranked.get(url.href)! > priority) ranked.set(url.href, priority);
  }
  return [...ranked.entries()].sort((a, b) => a[1] - b[1]).slice(0, max).map(([href]) => href);
}
