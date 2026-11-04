import { createHash, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";
import { createPinnedLookup, isPublicIPv4, type PinnedHttpsDependencies, type PublicResolver } from "../network/pinned-https";

/**
 * Credential-free download of owner-authorized media from Meta's media CDNs.
 *
 * Graph API `media_url` / `source` / `images[].source` values are short-lived,
 * signed CDN URLs. The only hosts accepted are Meta media CDN suffixes observed
 * in Graph responses (scontent-*.cdninstagram.com, scontent.*.fbcdn.net,
 * video.*.fbcdn.net, instagram.*.fna.fbcdn.net). Within those suffixes only the
 * media-serving first labels scontent*, video* and instagram* are accepted, so
 * static.xx.fbcdn.net (web assets) and external*.fbcdn.net (Meta's proxy for
 * third-party images, safe_image) can never be labelled owner media. No Authorization header, cookie or Meta
 * credential is ever sent here: the signed URL is the only capability.
 *
 * Transport: the pinned-DNS/public-IPv4 and original-hostname-TLS rules of
 * lib/network/pinned-https.ts, in a streaming form so a video up to 300 MiB is
 * written to a private file instead of being buffered (the buffered transport
 * is capped at 32 MiB). Redirects are never followed automatically; each hop
 * is re-validated against the CDN allowlist.
 */

export const META_CDN_HOST_SUFFIXES = [".fbcdn.net", ".cdninstagram.com"] as const;
/** First DNS label of a media-serving CDN host: scontent, scontent-lhr8-1, video-iad3-1, instagram, ... */
const META_CDN_FIRST_LABEL = /^(?:scontent|video|instagram)(?:-[a-z0-9]+)*$/;
export const META_CDN_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const META_CDN_MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_URL_CHARS = 4096;
const DEFAULT_TIMEOUT_MS = { image: 30_000, video: 180_000 } as const;

export type MetaCdnMediaKind = "image" | "video";
export type MetaCdnMimeType = "image/jpeg" | "image/png" | "image/webp" | "video/mp4" | "video/quicktime";

export class MetaCdnError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "MetaCdnError"; }
}

/**
 * Host allowlist check with a dot boundary (evilfbcdn.net and fbcdn.net.example.com are rejected) and a
 * media-serving first label (static.xx.fbcdn.net and external.xx.fbcdn.net proxies are rejected).
 */
export function isMetaCdnUrl(value: string | URL): boolean {
  let url: URL;
  try { url = typeof value === "string" ? new URL(value) : value; } catch { return false; }
  if (url.href.length > MAX_URL_CHARS || url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase();
  if (!host || isIP(host.replace(/^\[|\]$/g, "")) || host.endsWith(".")) return false;
  if (!META_CDN_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)) return false;
  return META_CDN_FIRST_LABEL.test(host.split(".")[0]);
}

// ---------------------------------------------------------------------------
// Streaming pinned transport
// ---------------------------------------------------------------------------

export interface MetaCdnStreamResponse {
  status: number;
  headers: Record<string, string | undefined>;
  /** Raw body stream; the caller enforces byte limits while consuming. */
  body: AsyncIterable<Buffer>;
  /** Releases sockets/agents; idempotent. */
  close(): void;
}

export type MetaCdnTransport = (url: URL, options: { signal: AbortSignal; maxBytes: number; accept: string }) => Promise<MetaCdnStreamResponse>;

const resolveIPv4: PublicResolver = (hostname) => dnsLookup(hostname, { all: true, family: 4 });

async function publicAddress(hostname: string, resolver: PublicResolver): Promise<{ address: string; family: number }> {
  let addresses: { address: string; family: number }[];
  try { addresses = await resolver(hostname); }
  catch { throw new MetaCdnError("DNS_UNAVAILABLE", "The Meta media host could not be resolved safely."); }
  if (!addresses.length || addresses.some((entry) => entry.family !== 4 || !isPublicIPv4(entry.address))) {
    throw new MetaCdnError("DESTINATION_NOT_PUBLIC", "The Meta media host did not resolve exclusively to public IPv4 addresses.");
  }
  return addresses[0];
}

/**
 * One GET resolving at response headers. Same boundary as pinnedHttpsRequest:
 * a single validated public IPv4, CONNECT to IP:443 only through a configured
 * proxy, TLS verified for the original hostname, no credentials, no redirects,
 * no alternate addresses, no retries.
 */
export function pinnedHttpsStream(url: URL, options: { signal: AbortSignal; maxBytes: number; accept: string }, dependencies: PinnedHttpsDependencies = {}): Promise<MetaCdnStreamResponse> {
  return new Promise((resolvePromise, reject) => {
    const { signal, maxBytes } = options;
    const resources = new Set<{ destroy(): void }>();
    let settled = false;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", aborted);
      for (const resource of resources) resource.destroy();
    };
    const fail = (error: unknown) => {
      if (settled) { close(); return; }
      settled = true;
      close();
      reject(error instanceof MetaCdnError ? error : new MetaCdnError(signal.aborted ? "READ_TIMEOUT" : "CONNECTION_UNAVAILABLE", signal.aborted ? "The Meta media download timed out." : "A verified Meta media connection was unavailable; DNS and TLS checks were retained."));
    };
    const aborted = () => fail(new MetaCdnError("READ_TIMEOUT", "The Meta media download timed out."));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    if (!isMetaCdnUrl(url)) { fail(new MetaCdnError("URL_NOT_ALLOWED", "Only HTTPS Meta media CDN URLs can be downloaded.")); return; }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > META_CDN_MAX_VIDEO_BYTES) { fail(new MetaCdnError("INVALID_BYTE_LIMIT", "The download byte limit is invalid.")); return; }
    const receive = (response: IncomingMessage) => {
      resources.add(response);
      if (settled) { response.destroy(); return; }
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]));
      if (headers["content-encoding"] && headers["content-encoding"] !== "identity") { fail(new MetaCdnError("ENCODING_NOT_SUPPORTED", "Compressed media responses are not supported by the bounded downloader.")); return; }
      response.on("error", () => close());
      settled = true;
      resolvePromise({ status: response.statusCode ?? 0, headers, body: response, close });
    };
    const send = (agent: HttpsAgent) => {
      if (settled) { agent.destroy(); return; }
      resources.add(agent);
      const request = (dependencies.httpsRequest ?? httpsRequest)(url, {
        agent, signal, family: 4, method: "GET", rejectUnauthorized: true,
        // Deliberately no Authorization, Cookie or Referer: the signed CDN URL is the only capability.
        headers: { Host: url.host, "User-Agent": "TickrMedia/0.1", Accept: options.accept, "Accept-Encoding": "identity" },
      }, receive);
      resources.add(request);
      request.on("error", fail);
      request.end();
    };
    void (async () => {
      const pinned = await publicAddress(url.hostname, dependencies.resolver ?? resolveIPv4);
      if (settled) return;
      const environment = dependencies.environment ?? process.env;
      const configuredProxy = environment.HTTPS_PROXY || environment.https_proxy || environment.HTTP_PROXY || environment.http_proxy;
      if (!configuredProxy) { send(new HttpsAgent({ keepAlive: false, maxSockets: 1, lookup: createPinnedLookup(async () => [pinned]) })); return; }
      let proxy: URL;
      try {
        proxy = new URL(configuredProxy);
        if (!["http:", "https:"].includes(proxy.protocol) || proxy.pathname !== "/" || proxy.search || proxy.hash) throw new Error();
      } catch { throw new MetaCdnError("PROXY_CONFIGURATION_INVALID", "The configured outbound proxy is invalid."); }
      const proxyAgent = proxy.protocol === "https:" ? new HttpsAgent({ keepAlive: false, maxSockets: 1, rejectUnauthorized: true }) : new HttpAgent({ keepAlive: false, maxSockets: 1 });
      resources.add(proxyAgent);
      const authority = `${pinned.address}:443`;
      const headers: Record<string, string> = { Host: authority };
      try {
        if (proxy.username || proxy.password) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
      } catch { throw new MetaCdnError("PROXY_CONFIGURATION_INVALID", "The configured outbound proxy is invalid."); }
      const connectRequest = (proxy.protocol === "https:" ? dependencies.httpsRequest ?? httpsRequest : dependencies.httpRequest ?? httpRequest)({
        hostname: proxy.hostname, port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
        method: "CONNECT", path: authority, agent: proxyAgent, signal, rejectUnauthorized: true, headers,
      });
      resources.add(connectRequest);
      connectRequest.on("error", fail);
      connectRequest.once("connect", (response, socket, head: Buffer) => {
        resources.add(socket);
        if (settled) { socket.destroy(); return; }
        if (response.statusCode !== 200 || head.length) { fail(new MetaCdnError("PROXY_CONNECT_REJECTED", "The configured proxy did not establish a clean public-IP tunnel. No alternate route was attempted.")); return; }
        try {
          const secure = (dependencies.tlsConnect ?? tlsConnect)({ socket, servername: url.hostname, rejectUnauthorized: true, checkServerIdentity });
          resources.add(secure);
          secure.on("error", fail);
          secure.once("secureConnect", () => {
            if (!secure.authorized) { fail(new MetaCdnError("TLS_UNVERIFIED", "The Meta media host TLS identity could not be verified.")); return; }
            const originAgent = new HttpsAgent({ keepAlive: false, maxSockets: 1 });
            originAgent.createConnection = () => secure;
            try { send(originAgent); } catch (error) { fail(error); }
          });
        } catch (error) { fail(error); }
      });
      connectRequest.end();
    })().catch(fail);
  });
}

// ---------------------------------------------------------------------------
// Type checks
// ---------------------------------------------------------------------------

const ALLOWED_MIME: Record<MetaCdnMediaKind, readonly MetaCdnMimeType[]> = {
  image: ["image/jpeg", "image/png", "image/webp"],
  video: ["video/mp4", "video/quicktime"],
};
const EXTENSION: Record<MetaCdnMimeType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov" };

/** ISO-BMFF major brands accepted as MP4 video; HEIF/AVIF still-image brands (heic, mif1, avif, ...) are not. */
const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V "]);

/** Magic-byte sniffing over the first bytes; containers only, decoding happens downstream. */
export function sniffMetaCdnMime(head: Buffer): MetaCdnMimeType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") {
    const brand = head.toString("latin1", 8, 12);
    if (brand === "qt  ") return "video/quicktime";
    return MP4_BRANDS.has(brand) ? "video/mp4" : null;
  }
  return null;
}

function declaredMime(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export interface MetaCdnDownloadOptions {
  kind: MetaCdnMediaKind;
  /** Application-controlled private directory (normally under ignored .data/); never an owner/model-supplied path. */
  outputDir: string;
  /** Defaults to and is capped at 20 MiB for images and 300 MiB for videos. */
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface MetaCdnDownloadDependencies { transport?: MetaCdnTransport }

export interface MetaCdnDownloadResult {
  /** Private machine path; keep out of API responses and exports. */
  path: string;
  bytes: number;
  sha256: string;
  mimeType: MetaCdnMimeType;
}

/**
 * Streams one Meta CDN object to `<outputDir>/<sha256>.<ext>` (0600). The file is
 * written under a temporary name and only renamed after size, MIME and
 * magic-byte checks pass; failures leave no partial file behind.
 */
export async function downloadMetaCdnMedia(url: string, options: MetaCdnDownloadOptions, dependencies: MetaCdnDownloadDependencies = {}): Promise<MetaCdnDownloadResult> {
  const { kind } = options;
  if (kind !== "image" && kind !== "video") throw new MetaCdnError("INVALID_KIND", "The media kind must be image or video.");
  const ceiling = kind === "image" ? META_CDN_MAX_IMAGE_BYTES : META_CDN_MAX_VIDEO_BYTES;
  const maxBytes = options.maxBytes ?? ceiling;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ceiling) throw new MetaCdnError("INVALID_BYTE_LIMIT", "The download byte limit is invalid for this media kind.");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS[kind];
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new MetaCdnError("INVALID_TIMEOUT", "The download timeout is invalid.");
  if (typeof options.outputDir !== "string" || !options.outputDir) throw new MetaCdnError("INVALID_OUTPUT_DIRECTORY", "A private output directory is required.");
  let current: URL;
  try { current = new URL(url); } catch { throw new MetaCdnError("URL_NOT_ALLOWED", "Only HTTPS Meta media CDN URLs can be downloaded."); }
  if (!isMetaCdnUrl(current)) throw new MetaCdnError("URL_NOT_ALLOWED", "Only HTTPS Meta media CDN URLs can be downloaded.");

  const transport: MetaCdnTransport = dependencies.transport ?? ((target, transportOptions) => pinnedHttpsStream(target, transportOptions));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const accept = ALLOWED_MIME[kind].join(", ");
  const directory = resolve(options.outputDir);
  let temporary: string | null = null;
  let response: MetaCdnStreamResponse | null = null;
  try {
    for (let hop = 0; ; hop++) {
      response = await transport(current, { signal: controller.signal, maxBytes, accept });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location;
        response.close();
        response = null;
        if (hop >= MAX_REDIRECTS) throw new MetaCdnError("TOO_MANY_REDIRECTS", "The Meta media URL redirected too many times.");
        let next: URL;
        try { next = new URL(location ?? "", current); } catch { throw new MetaCdnError("REDIRECT_NOT_ALLOWED", "The Meta media URL redirected outside the media CDN allowlist."); }
        if (!location || !isMetaCdnUrl(next)) throw new MetaCdnError("REDIRECT_NOT_ALLOWED", "The Meta media URL redirected outside the media CDN allowlist.");
        current = next;
        continue;
      }
      break;
    }
    if (response.status === 403 || response.status === 410) throw new MetaCdnError("URL_EXPIRED", "The Meta media link has expired or is no longer authorized; refresh the media listing.");
    if (response.status !== 200) throw new MetaCdnError("HTTP_ERROR", `The Meta media download failed (HTTP ${response.status}).`);
    const declared = declaredMime(response.headers["content-type"]);
    if (!(ALLOWED_MIME[kind] as readonly string[]).includes(declared)) throw new MetaCdnError("MIME_NOT_ALLOWED", `The Meta media response was not an allowed ${kind} type.`);
    const declaredLength = response.headers["content-length"];
    if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength.trim()) || Number(declaredLength) > maxBytes)) throw new MetaCdnError("BODY_TOO_LARGE", "The Meta media exceeded its size limit.");

    await mkdir(directory, { recursive: true, mode: 0o700 });
    temporary = join(directory, `.meta-cdn-${randomBytes(12).toString("hex")}.part`);
    const handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    let head = Buffer.alloc(0);
    try {
      for await (const chunk of response.body) {
        if (controller.signal.aborted) throw new MetaCdnError("READ_TIMEOUT", "The Meta media download timed out.");
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) throw new MetaCdnError("BODY_TOO_LARGE", "The Meta media exceeded its size limit.");
        if (head.length < 16) head = Buffer.concat([head, buffer.subarray(0, 16 - head.length)]);
        hash.update(buffer);
        await handle.write(buffer);
      }
      if (controller.signal.aborted) throw new MetaCdnError("READ_TIMEOUT", "The Meta media download timed out.");
      await handle.sync();
    } finally { await handle.close(); }
    if (bytes === 0) throw new MetaCdnError("EMPTY_BODY", "The Meta media response was empty.");
    if (declaredLength !== undefined && Number(declaredLength) !== bytes) throw new MetaCdnError("INCOMPLETE_BODY", "The Meta media response ended before completion.");
    const sniffed = sniffMetaCdnMime(head);
    if (!sniffed || (sniffed !== declared && !(kind === "video" && sniffed.startsWith("video/")))) throw new MetaCdnError("TYPE_MISMATCH", "The Meta media bytes did not match the declared type.");
    // ISO-BMFF brands overlap between MP4 and QuickTime; the declared video type is kept when the container is ISO-BMFF.
    const mimeType = kind === "video" ? declared as MetaCdnMimeType : sniffed;
    const sha256 = hash.digest("hex");
    const path = join(directory, `${sha256}.${EXTENSION[mimeType]}`);
    await rename(temporary, path);
    temporary = null;
    return { path, bytes, sha256, mimeType };
  } catch (error) {
    if (error instanceof MetaCdnError) throw error;
    if (controller.signal.aborted) throw new MetaCdnError("READ_TIMEOUT", "The Meta media download timed out.");
    throw new MetaCdnError("DOWNLOAD_FAILED", "The Meta media download failed; no retry was attempted.");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
    response?.close();
    if (temporary) await rm(temporary, { force: true }).catch(() => { /* Best-effort removal of a rejected partial file. */ });
  }
}
