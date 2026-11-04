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
  const add = (rawUrl: string, data: Omit<MediaCandidate, "id" | "imageUrl" | "sourcePageUrl" | "eligible" | "exclusionReason" | "rights">) => {
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
    }
    if (!previous || ranks[candidate.kind] < ranks[previous.kind]) found.set(url.href, candidate);
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
    const paths = [attrs.src, attrs["data-src"]];
    const responsive = (attrs.srcset ?? "").split(",").slice(0, 6).map((item) => item.trim().split(/\s+/)[0]);
    for (const rawUrl of [...paths, ...responsive]) if (rawUrl) add(rawUrl, {
      kind: "page_image", discoveredVia: "html_image", productName: null,
      label: text(attrs.alt) ?? text(attrs.title), declaredWidth: dimension(attrs.width), declaredHeight: dimension(attrs.height),
    });
  }
  return [...found.values()].sort((a, b) => exactMatch(b) - exactMatch(a) || Number(b.eligible) - Number(a.eligible) || ranks[a.kind] - ranks[b.kind]).slice(0, MAX_CANDIDATES);
}
