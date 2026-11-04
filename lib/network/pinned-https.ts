import { lookup as dnsLookup } from "node:dns/promises";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";

export class PinnedHttpsError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "PinnedHttpsError"; }
}
type Address = { address: string; family: number };
export type PublicResolver = (hostname: string) => Promise<Address[]>;
const resolveIPv4: PublicResolver = (hostname) => dnsLookup(hostname, { all: true, family: 4 });

/** Public IPv4 only. Mixed public/private answers fail closed. */
export function isPublicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113));
}

async function publicAddresses(hostname: string, resolver: PublicResolver): Promise<Address[]> {
  let addresses: Address[];
  try { addresses = await resolver(hostname); }
  catch { throw new PinnedHttpsError("DNS_UNAVAILABLE", "The website address could not be resolved safely."); }
  if (!addresses.length || addresses.some((entry) => entry.family !== 4 || !isPublicIPv4(entry.address))) {
    throw new PinnedHttpsError("DESTINATION_NOT_PUBLIC", "The website did not resolve exclusively to public IPv4 addresses.");
  }
  return addresses;
}

export function createPinnedLookup(resolver: PublicResolver = resolveIPv4): LookupFunction {
  return (hostname, options, callback) => {
    void publicAddresses(hostname, resolver).then((addresses) => {
      if (typeof options === "object" && options.all) {
        (callback as unknown as (error: Error | null, addresses: Address[]) => void)(null, [addresses[0]]);
      } else callback(null, addresses[0].address, 4);
    }).catch((error: Error) => callback(error, "", 4));
  };
}

export interface PinnedHttpsResponse { status: number; headers: Record<string, string | undefined>; body: Buffer }
export interface PinnedHttpsDependencies {
  resolver?: PublicResolver;
  environment?: Record<string, string | undefined>;
  httpRequest?: typeof httpRequest;
  httpsRequest?: typeof httpsRequest;
  tlsConnect?: typeof tlsConnect;
}

/**
 * One credential-free origin GET. A trusted environment proxy receives only an
 * IP:443 CONNECT; original-hostname TLS verification remains inside the tunnel.
 * No hostname CONNECT, automatic redirects, alternate addresses or retries.
 */
export function pinnedHttpsRequest(url: URL, options: { signal: AbortSignal; maxBytes: number; accept: string }, dependencies: PinnedHttpsDependencies = {}): Promise<PinnedHttpsResponse> {
  return new Promise((resolve, reject) => {
    const { signal, maxBytes } = options;
    const resources = new Set<{ destroy(): void }>();
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", aborted);
      for (const resource of resources) resource.destroy();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof PinnedHttpsError ? error : new PinnedHttpsError(signal.aborted ? "READ_TIMEOUT" : "CONNECTION_UNAVAILABLE", signal.aborted ? "The official website read timed out." : "A verified official website connection was unavailable; DNS and TLS checks were retained."));
    };
    const aborted = () => fail(new PinnedHttpsError("READ_TIMEOUT", "The official website read timed out."));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
      fail(new PinnedHttpsError("URL_NOT_ALLOWED", "The transport requires a public hostname HTTPS URL without credentials.")); return;
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) {
      fail(new PinnedHttpsError("INVALID_BYTE_LIMIT", "The response byte limit is invalid.")); return;
    }
    const receive = (response: IncomingMessage) => {
      if (settled) { response.destroy(); return; }
      resources.add(response);
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]));
      if (Number(headers["content-length"]) > maxBytes) { fail(new PinnedHttpsError("BODY_TOO_LARGE", "The official website response exceeded its size limit.")); return; }
      if (headers["content-encoding"] && headers["content-encoding"] !== "identity") { fail(new PinnedHttpsError("ENCODING_NOT_SUPPORTED", "Compressed HTTP responses are not supported by the bounded reader.")); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > maxBytes) { fail(new PinnedHttpsError("BODY_TOO_LARGE", "The official website response exceeded its size limit.")); return; }
        chunks.push(chunk);
      });
      response.on("error", fail);
      response.on("aborted", () => fail(new PinnedHttpsError("CONNECTION_UNAVAILABLE", "The official website response ended before completion.")));
      response.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
      });
    };
    const send = (agent: HttpsAgent) => {
      if (settled) { agent.destroy(); return; }
      resources.add(agent);
      const request = (dependencies.httpsRequest ?? httpsRequest)(url, {
        agent, signal, family: 4, method: "GET", rejectUnauthorized: true,
        headers: { Host: url.host, "User-Agent": "TickrResearch/0.1", Accept: options.accept, "Accept-Encoding": "identity" },
      }, receive);
      resources.add(request);
      request.on("error", fail);
      request.end();
    };
    void (async () => {
      const addresses = await publicAddresses(url.hostname, dependencies.resolver ?? resolveIPv4);
      if (settled) return;
      const pinned = addresses[0];
      const environment = dependencies.environment ?? process.env;
      const configuredProxy = environment.HTTPS_PROXY || environment.https_proxy || environment.HTTP_PROXY || environment.http_proxy;
      if (!configuredProxy) { send(new HttpsAgent({ keepAlive: false, maxSockets: 1, lookup: createPinnedLookup(async () => [pinned]) })); return; }
      let proxy: URL;
      try {
        proxy = new URL(configuredProxy);
        if (!["http:", "https:"].includes(proxy.protocol) || proxy.pathname !== "/" || proxy.search || proxy.hash) throw new Error();
      } catch { throw new PinnedHttpsError("PROXY_CONFIGURATION_INVALID", "The configured official-read proxy is invalid."); }
      const proxyAgent = proxy.protocol === "https:" ? new HttpsAgent({ keepAlive: false, maxSockets: 1, rejectUnauthorized: true }) : new HttpAgent({ keepAlive: false, maxSockets: 1 });
      resources.add(proxyAgent);
      const authority = `${pinned.address}:443`;
      const headers: Record<string, string> = { Host: authority };
      try {
        if (proxy.username || proxy.password) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
      } catch { throw new PinnedHttpsError("PROXY_CONFIGURATION_INVALID", "The configured official-read proxy is invalid."); }
      const connectRequest = (proxy.protocol === "https:" ? dependencies.httpsRequest ?? httpsRequest : dependencies.httpRequest ?? httpRequest)({
        hostname: proxy.hostname, port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
        method: "CONNECT", path: authority, agent: proxyAgent, signal, rejectUnauthorized: true, headers,
      });
      resources.add(connectRequest);
      connectRequest.on("error", fail);
      connectRequest.once("connect", (response, socket, head: Buffer) => {
        resources.add(socket);
        if (settled) { socket.destroy(); return; }
        if (response.statusCode !== 200 || head.length) { fail(new PinnedHttpsError("PROXY_CONNECT_REJECTED", "The configured proxy did not establish a clean public-IP tunnel. No alternate route was attempted.")); return; }
        try {
          const secure = (dependencies.tlsConnect ?? tlsConnect)({ socket, servername: url.hostname, rejectUnauthorized: true, checkServerIdentity });
          resources.add(secure);
          secure.on("error", fail);
          secure.once("secureConnect", () => {
            if (!secure.authorized) { fail(new PinnedHttpsError("TLS_UNVERIFIED", "The official website TLS identity could not be verified.")); return; }
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
