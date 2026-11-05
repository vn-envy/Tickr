import { isIP } from "node:net";
import { pinnedHttpsRequest, PinnedHttpsError } from "../network/pinned-https";
export { createPinnedLookup, isPublicIPv4 } from "../network/pinned-https";

const MAX_PAGE_BYTES = 512 * 1024;
const MAX_ROBOTS_BYTES = 32 * 1024;
const MAX_TEXT_LENGTH = 12_000;
const USER_AGENT = "TickrResearch/0.1";
const BLOCKED_HOSTS = [
  "localhost", "google.com", "google.co.in", "googleapis.com", "googleusercontent.com", "gstatic.com",
  "goo.gl", "facebook.com", "fb.com", "fb.me", "instagram.com", "threads.net", "threads.com",
  "whatsapp.com", "wa.me", "tiktok.com", "twitter.com", "x.com", "linkedin.com", "youtube.com",
  "youtu.be", "bing.com", "duckduckgo.com", "yahoo.com", "brave.com", "yelp.com", "tripadvisor.com",
  "bit.ly", "tinyurl.com", "t.co", "linktr.ee", "api.meta.ai",
];

export class SourceReadError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SourceReadError";
  }
}

export function validateSourceUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new SourceReadError("INVALID_URL", "Use a public official website URL."); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || isIP(host.replace(/^\[|\]$/g, "")) || host.endsWith(".") || !host.includes(".")
    || !/^[a-z0-9.-]+$/.test(host) || host.split(".").some((part) => !part || part.startsWith("-") || part.endsWith("-"))
    || /\.(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)
    || BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))
    || /^(?:api|search|maps)\./.test(host)
    || /(?:^|\.)google\.[a-z.]+$/.test(host)
    // Google's own ".google" TLD (share.google, about.google...) is a listing/redirect surface, never an official business site.
    || /(?:^|\.)google$/.test(host)) {
    throw new SourceReadError("URL_NOT_ALLOWED", "Direct reading supports public official HTTPS websites only; listing, social, search and API URLs remain references.");
  }
  if (url.href.length > 2048) throw new SourceReadError("INVALID_URL", "Website URL is too long.");
  url.hash = "";
  return url;
}

export type RawSourceResponse = { status: number; headers: Record<string, string | undefined>; body: string };
export type SourceTransport = (url: URL, options: { signal: AbortSignal; maxBytes: number }) => Promise<RawSourceResponse>;

const officialRequest: SourceTransport = async (url, { signal, maxBytes }) => {
  try {
    const response = await pinnedHttpsRequest(url, { signal, maxBytes, accept: "text/html,application/xhtml+xml,text/plain" });
    return { ...response, body: response.body.toString("utf8") };
  } catch (error) {
    if (error instanceof PinnedHttpsError) throw new SourceReadError(error.code, error.message);
    throw new SourceReadError("CONNECTION_UNAVAILABLE", "A verified official website connection was unavailable.");
  }
};

function robotsPathMatches(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith("$");
  const glob = anchored ? pattern.slice(0, -1) : `${pattern}*`;
  // A greedy wildcard matcher avoids executing an untrusted robots pattern as a regex.
  let source = 0;
  let rule = 0;
  let star = -1;
  let retry = 0;
  while (source < path.length) {
    if (glob[rule] === path[source]) { source++; rule++; }
    else if (glob[rule] === "*") { star = rule++; retry = source; }
    else if (star >= 0) { rule = star + 1; source = ++retry; }
    else return false;
  }
  while (glob[rule] === "*") rule++;
  return rule === glob.length;
}

export function robotsAllows(text: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let group: typeof groups[number] | undefined;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, "").trim();
    const separator = clean.indexOf(":");
    if (separator < 0) continue;
    const name = clean.slice(0, separator).trim().toLowerCase();
    const value = clean.slice(separator + 1).trim();
    if (name === "user-agent") {
      if (!group || group.rules.length) { group = { agents: [], rules: [] }; groups.push(group); }
      group.agents.push(value.toLowerCase());
    } else if (group && ["allow", "disallow"].includes(name) && value) {
      if (value.length > 2048) return false;
      group.rules.push({ allow: name === "allow", path: value });
    }
  }
  const specific = groups.filter((entry) => entry.agents.some((agent) => agent !== "*" && USER_AGENT.toLowerCase().startsWith(agent)));
  const applicable = specific.length ? specific : groups.filter((entry) => entry.agents.includes("*"));
  const matching = applicable.flatMap((entry) => entry.rules).filter((rule) => robotsPathMatches(path, rule.path));
  matching.sort((a, b) => b.path.replace(/\*/g, "").length - a.path.replace(/\*/g, "").length || Number(b.allow) - Number(a.allow));
  return matching[0]?.allow ?? true;
}

function decodeEntities(input: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#")) {
      const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : " ";
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

/** Text only: no browser, script execution, asset downloads, or inferred claims. */
export function extractWebsiteText(html: string): { title: string; text: string } {
  const lower = html.toLowerCase();
  const titleStart = lower.indexOf("<title");
  const titleContent = titleStart < 0 ? -1 : html.indexOf(">", titleStart);
  const titleEnd = titleContent < 0 ? -1 : lower.indexOf("</title", titleContent);
  const title = decodeEntities(titleEnd < 0 ? "Official website" : html.slice(titleContent + 1, titleEnd).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 180);
  const hidden = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "head"]);
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    if (opening < 0) { parts.push(html.slice(cursor)); break; }
    parts.push(html.slice(cursor, opening), " ");
    if (html.startsWith("<!--", opening)) {
      const end = html.indexOf("-->", opening + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    const end = html.indexOf(">", opening + 1);
    if (end < 0) break;
    const tag = lower.slice(opening + 1, end);
    const name = tag.match(/^\s*([a-z][a-z0-9:-]*)/)?.[1];
    if (name && hidden.has(name)) {
      let close = lower.indexOf(`</${name}`, end + 1);
      while (close >= 0 && !/[\s/>]/.test(lower[close + name.length + 2] ?? "")) close = lower.indexOf(`</${name}`, close + name.length + 2);
      if (close < 0) break;
      const closingEnd = html.indexOf(">", close);
      if (closingEnd < 0) break;
      cursor = closingEnd + 1;
    } else cursor = end + 1;
  }
  const text = decodeEntities(parts.join(""))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
  return { title, text };
}

function rejectsAutomatedUse(headers: RawSourceResponse["headers"], body: string): boolean {
  const directives = `${headers["x-robots-tag"] ?? ""} ${[...body.matchAll(/<meta\b[^>]*>/gi)].filter((match) => /name\s*=\s*["']?(?:robots|tickrresearch)["'\s>]/i.test(match[0])).map((match) => match[0]).join(" ")}`;
  return /(?:^|[^a-z])(?:noindex|none|noai|noimageai|noarchive|nosnippet)(?:[^a-z]|$)/i.test(directives);
}

export async function readOfficialPage(input: string, options: { transport?: SourceTransport; timeoutMs?: number } = {}): Promise<{ url: string; title: string; text: string; retrievedAt: string }> {
  const start = validateSourceUrl(input);
  const transport = options.transport ?? officialRequest;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs ?? 10_000, 10_000));
  try {
    const fetchBounded = async (initial: URL, maxBytes: number, allowPath?: (url: URL) => boolean): Promise<{ response: RawSourceResponse; url: URL }> => {
      let url = initial;
      for (let redirects = 0; redirects <= 3; redirects++) {
        validateSourceUrl(url.href);
        if (allowPath && !allowPath(url)) throw new SourceReadError("ROBOTS_RESTRICTED", "The requested page is restricted by robots.txt.");
        if (controller.signal.aborted) throw new SourceReadError("READ_TIMEOUT", "The website read timed out.");
        const response = await transport(url, { signal: controller.signal, maxBytes });
        if (Buffer.byteLength(response.body, "utf8") > maxBytes) throw new SourceReadError("BODY_TOO_LARGE", "The website response exceeded the reading limit.");
        if (response.status >= 300 && response.status < 400) {
          if (!response.headers.location || redirects === 3) throw new SourceReadError("REDIRECT_LIMIT", "The website exceeded the redirect limit.");
          const next = validateSourceUrl(new URL(response.headers.location, url).href);
          if (next.origin !== start.origin) throw new SourceReadError("CROSS_ORIGIN_REDIRECT", "The website redirects to another origin; supply its confirmed official URL directly.");
          url = next;
          continue;
        }
        return { response, url };
      }
      throw new SourceReadError("REDIRECT_LIMIT", "The website exceeded the redirect limit.");
    };
    const robots = await fetchBounded(new URL("/robots.txt", start), MAX_ROBOTS_BYTES);
    if (robots.response.status !== 404 && robots.response.status !== 410) {
      if (robots.response.status !== 200 || !/^text\/plain\b/i.test(robots.response.headers["content-type"] ?? "")
        || !robotsAllows(robots.response.body, start.pathname + start.search)) {
        throw new SourceReadError("ROBOTS_RESTRICTED", "Website access restrictions could not be cleared for this page.");
      }
    }
    const { response, url } = await fetchBounded(start, MAX_PAGE_BYTES, (url) => robots.response.status !== 200 || robotsAllows(robots.response.body, url.pathname + url.search));
    if (response.status !== 200) throw new SourceReadError("HTTP_UNAVAILABLE", `The website returned HTTP ${response.status}; no content was used.`);
    const contentType = response.headers["content-type"] ?? "";
    if (!/^(?:text\/(?:html|plain)|application\/xhtml\+xml)\b/i.test(contentType)) {
      throw new SourceReadError("CONTENT_TYPE_NOT_ALLOWED", "Only public HTML and plain-text pages are supported.");
    }
    if (rejectsAutomatedUse(response.headers, response.body)) throw new SourceReadError("SOURCE_RESTRICTED", "The page declares a restriction on automated reuse; no content was used.");
    const extracted = /^text\/plain\b/i.test(contentType)
      ? { title: start.hostname, text: response.body.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH) }
      : extractWebsiteText(response.body);
    if (extracted.text.length < 30) throw new SourceReadError("NO_READABLE_TEXT", "The page did not expose enough readable text; supply an attributable excerpt.");
    return { url: url.href, ...extracted, retrievedAt: new Date().toISOString() };
  } finally { clearTimeout(timer); }
}
