export class RequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Hosts this private instance answers writes for: loopback names, the host Next derived for
 * request.url, and any explicit TICKR_ALLOWED_HOSTS entries (comma-separated host[:port]).
 * The allowlist blocks DNS-rebinding pages, whose Origin and Host both name the attacker's domain.
 */
function allowedWriteHost(host: string, request: Request): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  if (LOOPBACK_HOSTS.has(name) || host.toLowerCase() === new URL(request.url).host.toLowerCase()) return true;
  const extra = (process.env.TICKR_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return extra.includes(host.toLowerCase()) || extra.includes(name);
}

/**
 * Same-origin rule for writes. Next started with `--hostname 0.0.0.0` derives request.url from
 * its bind address, not from the browser's host, so the Origin is compared with the Host header
 * the browser actually used (and that host must be allowed). Requests without an Origin header
 * (non-browser local tools) remain accepted, as before.
 */
export function assertSameOriginRequest(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new RequestError("Cross-origin writes are not allowed.", 403); }
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.host.toLowerCase() !== host.toLowerCase() || !allowedWriteHost(host, request)) {
    throw new RequestError("Cross-origin writes are not allowed.", 403);
  }
}

export async function readLocalJson(request: Request, limit = 16_384): Promise<unknown> {
  assertSameOriginRequest(request);
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new RequestError("Send application/json.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError("A JSON body is required.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new RequestError("Request body is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestError("Invalid JSON.", 400); }
}
