import { pinnedHttpsRequest, PinnedHttpsError } from "../network/pinned-https";
import { robotsAllows, validateSourceUrl } from "../research/source-reader";
import { extractOfficialMediaCandidates, MAX_MEDIA_HTML_BYTES } from "./extract";
import { MediaReadError, type MediaTransport, type RawMediaResponse } from "./contracts";
import { isApprovedStaticCdnAsset } from "./policy";

const MAX_ROBOTS_BYTES = 32 * 1024;
export const MAX_IMAGE_DOWNLOAD_BYTES = 5 * 1024 * 1024;

/** Uses the shared public-IP transport, including a verified proxy tunnel when configured. */
export const officialMediaTransport: MediaTransport = async (url, { signal, maxBytes, kind }) => {
  try {
    return await pinnedHttpsRequest(url, {
      signal, maxBytes,
      accept: kind === "image" ? "image/png,image/jpeg,image/webp" : kind === "robots" ? "text/plain" : "text/html,application/xhtml+xml",
    });
  } catch (error) {
    if (error instanceof PinnedHttpsError) throw new MediaReadError(error.code, error.message);
    throw new MediaReadError("CONNECTION_UNAVAILABLE", "A verified official media connection was unavailable.");
  }
};

function rejectsReuse(response: RawMediaResponse, html = ""): boolean {
  const metaTags = [...html.matchAll(/<meta\b[^>]*>/gi)]
    .filter((match) => /name\s*=\s*["']?(?:robots|tickrresearch)["'\s>]/i.test(match[0]))
    .map((match) => match[0]).join(" ");
  return /(?:^|[^a-z])(?:noindex|none|noai|noimageai|noimageindex|noarchive|nosnippet)(?:[^a-z]|$)/i.test(`${response.headers["x-robots-tag"] ?? ""} ${metaTags}`);
}

export function createOfficialMediaReader(officialWebsite: string, options: { transport?: MediaTransport; timeoutMs?: number; preferredProduct?: string } = {}) {
  const start = validateSourceUrl(officialWebsite);
  const transport = options.transport ?? officialMediaTransport;
  const controller = new AbortController();
  const timeoutMs = Math.min(12_000, Math.max(1, options.timeoutMs ?? 12_000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const robotsByOrigin = new Map<string, string | null>();
  const robotsFailures = new Map<string, unknown>();
  const referencedImages = new Set<string>();
  const imageAllowed = (url: URL) => url.origin === start.origin || isApprovedStaticCdnAsset(url) && referencedImages.has(url.href);

  async function request(url: URL, kind: "robots" | "page" | "image", maxBytes: number) {
    if (controller.signal.aborted) throw new MediaReadError("READ_TIMEOUT", "Official media acquisition timed out.");
    let abort: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      abort = () => reject(new MediaReadError("READ_TIMEOUT", "Official media acquisition timed out."));
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const response = await Promise.race([transport(url, { signal: controller.signal, maxBytes, kind }), timeout]);
      if (response.body.length > maxBytes || Number(response.headers["content-length"]) > maxBytes) throw new MediaReadError("BODY_TOO_LARGE", "Media acquisition exceeded its response size limit.");
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") throw new MediaReadError("ENCODING_NOT_SUPPORTED", "Compressed HTTP responses are not supported by the bounded media reader.");
      return response;
    } finally { if (abort) controller.signal.removeEventListener("abort", abort); }
  }

  async function fetchBounded(initial: URL, kind: "robots" | "page" | "image", maxBytes: number): Promise<{ url: URL; response: RawMediaResponse }> {
    let url = initial;
    for (let redirects = 0; redirects <= 2; redirects++) {
      validateSourceUrl(url.href);
      if (kind === "robots" ? url.origin !== initial.origin : kind === "image" ? !imageAllowed(url) : url.origin !== start.origin) throw new MediaReadError("CROSS_ORIGIN_MEDIA", "Automatic media requires the official origin or an exact official-page reference to an approved static CDN asset.");
      const robotsText = robotsByOrigin.get(url.origin);
      if (kind !== "robots" && (robotsText === undefined || robotsText !== null && !robotsAllows(robotsText, url.pathname + url.search))) throw new MediaReadError("ROBOTS_RESTRICTED", "Official media access is restricted by robots.txt.");
      const response = await request(url, kind, maxBytes);
      if (response.status >= 300 && response.status < 400) {
        if (!response.headers.location || redirects === 2) throw new MediaReadError("REDIRECT_LIMIT", "Official media exceeded its redirect limit.");
        url = validateSourceUrl(new URL(response.headers.location, url).href);
        continue;
      }
      return { url, response };
    }
    throw new MediaReadError("REDIRECT_LIMIT", "Official media exceeded its redirect limit.");
  }

  async function loadRobots(origin: URL) {
    if (robotsByOrigin.has(origin.origin)) return;
    if (robotsFailures.has(origin.origin)) throw robotsFailures.get(origin.origin);
    try {
      const robots = await fetchBounded(new URL("/robots.txt", origin), "robots", MAX_ROBOTS_BYTES);
      let robotsText: string | null = null;
      if (![404, 410].includes(robots.response.status)) {
        if (robots.response.status !== 200 || !/^text\/plain\b/i.test(robots.response.headers["content-type"] ?? "")) throw new MediaReadError("ROBOTS_RESTRICTED", "Official site access restrictions could not be cleared.");
        robotsText = robots.response.body.toString("utf8");
      }
      robotsByOrigin.set(origin.origin, robotsText);
    } catch (error) {
      robotsFailures.set(origin.origin, error);
      throw error;
    }
  }

  async function readPage() {
    await loadRobots(start);
    const page = await fetchBounded(start, "page", MAX_MEDIA_HTML_BYTES);
    if (page.response.status !== 200) throw new MediaReadError("HTTP_UNAVAILABLE", `Official media source returned HTTP ${page.response.status}.`);
    if (!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(page.response.headers["content-type"] ?? "")) throw new MediaReadError("CONTENT_TYPE_NOT_ALLOWED", "Media metadata discovery requires an official HTML page.");
    const html = page.response.body.toString("utf8");
    if (rejectsReuse(page.response, html)) throw new MediaReadError("SOURCE_RESTRICTED", "The official page restricts automated reuse; no media was used.");
    for (const candidate of extractOfficialMediaCandidates(html, page.url.href, { preferredProduct: options.preferredProduct })) if (candidate.eligible) referencedImages.add(candidate.imageUrl);
    return { url: page.url.href, html };
  }

  async function readImage(imageUrl: string) {
    const url = validateSourceUrl(imageUrl);
    if (!imageAllowed(url)) throw new MediaReadError("CROSS_ORIGIN_MEDIA", "A CDN image must be an exact reference extracted from the official page.");
    await loadRobots(url);
    const image = await fetchBounded(url, "image", MAX_IMAGE_DOWNLOAD_BYTES);
    if (image.response.status !== 200) throw new MediaReadError("HTTP_UNAVAILABLE", `Official image returned HTTP ${image.response.status}.`);
    if (!/^image\/(?:png|jpeg|webp)(?:\s*;|$)/i.test(image.response.headers["content-type"] ?? "")) throw new MediaReadError("IMAGE_TYPE_NOT_ALLOWED", "Only PNG, JPEG and WebP images can be acquired.");
    if (rejectsReuse(image.response)) throw new MediaReadError("SOURCE_RESTRICTED", "The image declares a restriction on automated reuse.");
    return { url: image.url.href, body: image.response.body, contentType: image.response.headers["content-type"]!.split(";")[0].trim().toLowerCase() };
  }

  return { readPage, readImage, close: () => { clearTimeout(timer); controller.abort(); } };
}
