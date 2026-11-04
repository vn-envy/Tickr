import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Owner access gate for a hosted (e.g. Modal) deployment.
 *
 * - No TICKR_ACCESS_CODE and no TICKR_DEPLOYMENT: the gate is off (local development, unchanged).
 * - TICKR_DEPLOYMENT=modal without a usable code: fail closed; everything except /api/health is 503.
 * - A usable code: requests need an HttpOnly cookie holding an HMAC-signed, expiring token. The
 *   signing key is derived from the code (and TICKR_SECRET_KEY when present), so changing either
 *   value signs every existing session out. The code itself never leaves the server.
 *
 * This module has no Next.js imports so the proxy, the /api/access route and tests share it.
 */

/** Plain-HTTP name (local runs only). Over HTTPS the `__Host-` name pins Path=/, Secure and no Domain. */
export const ACCESS_COOKIE = "tickr_access";
export const ACCESS_COOKIE_SECURE = "__Host-tickr_access";
export const ACCESS_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Shorter codes are treated as misconfiguration (fail closed), not as a weak gate. */
export const MIN_ACCESS_CODE_LENGTH = 16;
export const MAX_ACCESS_CODE_LENGTH = 256;
export const ACCESS_NOT_CONFIGURED = "Access is not configured.";
export const ACCESS_REQUIRED = "Access code required.";
export const ACCESS_INVALID = "That access code is not valid.";
export const ACCESS_THROTTLED = "Too many attempts. Try again later.";

type Environment = Record<string, string | undefined>;

export type AccessMode =
  | { kind: "open" }
  | { kind: "unconfigured" }
  | { kind: "gated"; signingKey: Buffer; codeKey: Buffer; codeDigest: Buffer };

let cached: { code: string; secret: string; mode: AccessMode } | null = null;
const reported = new Set<string>();

/** One log line per misconfiguration, naming the variable and never its value. */
function reportMisconfiguration(reason: string): void {
  if (reported.has(reason)) return;
  reported.add(reason);
  console.error(`access: TICKR_ACCESS_CODE ${reason}; the access gate stays closed.`);
}

/** Resolves the gate mode from the environment (memoized per code/secret pair). */
export function accessMode(env: Environment = process.env): AccessMode {
  const code = env.TICKR_ACCESS_CODE ?? "";
  const secret = env.TICKR_SECRET_KEY?.trim() ?? "";
  const deployed = Boolean(env.TICKR_DEPLOYMENT?.trim());
  if (!code.trim()) {
    if (deployed) reportMisconfiguration("is not set");
    return deployed ? { kind: "unconfigured" } : { kind: "open" };
  }
  // A Secret value with a stray newline or space would make the typed code never match; refuse it
  // visibly instead of leaving the owner unable to sign in.
  if (code !== code.trim()) { reportMisconfiguration("has leading or trailing whitespace"); return { kind: "unconfigured" }; }
  if (code.length < MIN_ACCESS_CODE_LENGTH || code.length > MAX_ACCESS_CODE_LENGTH) {
    reportMisconfiguration(`must be ${MIN_ACCESS_CODE_LENGTH}-${MAX_ACCESS_CODE_LENGTH} characters`);
    return { kind: "unconfigured" };
  }
  if (cached && cached.code === code && cached.secret === secret) return cached.mode;
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", Buffer.from(code, "utf8"), Buffer.from(secret, "utf8"), info, 32));
  const codeKey = derive("tickr-access-code-v1");
  const mode: AccessMode = {
    kind: "gated",
    signingKey: derive("tickr-access-cookie-v1"),
    codeKey,
    codeDigest: createHmac("sha256", codeKey).update(code, "utf8").digest(),
  };
  cached = { code, secret, mode };
  return mode;
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");
const sign = (key: Buffer, payload: string) => createHmac("sha256", key).update(payload, "utf8").digest();

/** `v1.<expiry seconds>.<nonce>.<hmac>`; the nonce keeps tokens distinct, not secret. */
export function issueAccessToken(signingKey: Buffer, nowMs = Date.now()): string {
  const expiry = Math.floor(nowMs / 1000) + ACCESS_TTL_SECONDS;
  const payload = `v1.${expiry}.${base64url(randomBytes(12))}`;
  return `${payload}.${base64url(sign(signingKey, payload))}`;
}

export function verifyAccessToken(token: string | null | undefined, signingKey: Buffer, nowMs = Date.now()): boolean {
  if (typeof token !== "string" || token.length > 256) return false;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !/^\d{1,12}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{16}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[3])) return false;
  const expected = sign(signingKey, parts.slice(0, 3).join("."));
  const supplied = Buffer.from(parts[3], "base64url");
  // Canonical encoding only: otherwise the unused trailing bits give each token sibling spellings.
  if (supplied.length !== expected.length || base64url(supplied) !== parts[3] || !timingSafeEqual(supplied, expected)) return false;
  const expiry = Number(parts[1]);
  const now = Math.floor(nowMs / 1000);
  // Also refuse expiries beyond one TTL from now: a token can never outlive the issued lifetime.
  return expiry > now && expiry <= now + ACCESS_TTL_SECONDS;
}

/** Constant-time code check: both sides are HMAC digests of equal length. */
export function verifyAccessCode(submitted: unknown, mode: AccessMode): boolean {
  if (mode.kind !== "gated" || typeof submitted !== "string" || submitted.length === 0 || submitted.length > MAX_ACCESS_CODE_LENGTH) return false;
  const digest = createHmac("sha256", mode.codeKey).update(submitted, "utf8").digest();
  return timingSafeEqual(digest, mode.codeDigest);
}

export function accessCookieName(secure: boolean): string {
  return secure ? ACCESS_COOKIE_SECURE : ACCESS_COOKIE;
}

export function accessCookieHeader(token: string, secure: boolean): string {
  return `${accessCookieName(secure)}=${token}; Path=/; Max-Age=${ACCESS_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Reads one cookie from a Cookie header (first occurrence wins, as browsers send the most specific first). */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** Secure cookies whenever the browser reached us over HTTPS (Modal terminates TLS in front). */
export function requestIsHttps(url: string, headers: Headers, env: Environment = process.env): boolean {
  if (env.TICKR_DEPLOYMENT?.trim()) return true;
  if ((headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase() === "https") return true;
  try { return new URL(url).protocol === "https:"; } catch { return false; }
}

/** Reachable without a session: the health probe, the access page/route and static build assets. */
export function isExemptPath(pathname: string): boolean {
  return pathname === "/api/health" || pathname === "/access" || pathname === "/api/access"
    || pathname === "/favicon.ico" || pathname.startsWith("/_next/static/");
}

/**
 * Only same-origin relative paths survive; anything else (absolute URLs, protocol-relative,
 * backslash tricks, control characters, the access page itself) becomes "/".
 */
export function sanitizeNextPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || /[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  let parsed: URL;
  try { parsed = new URL(raw, "http://tickr.invalid"); } catch { return "/"; }
  if (parsed.origin !== "http://tickr.invalid") return "/";
  if (parsed.pathname === "/access" || parsed.pathname.startsWith("/api/access")) return "/";
  // Dot-segment removal can turn "/.//evil.example" into "//evil.example": re-check the result,
  // because a Location starting with "//" (or "/\\") is protocol-relative to another host.
  const out = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return out.startsWith("/") && !out.startsWith("//") && !out.startsWith("/\\") && !/[\u0000-\u001f\u007f\\]/.test(parsed.pathname) ? out : "/";
}

export type AccessDecision =
  | { kind: "allow" }
  | { kind: "unconfigured" }
  | { kind: "unauthorized" }
  | { kind: "redirect"; location: string };

export interface AccessRequest {
  pathname: string;
  search?: string;
  method?: string;
  cookie?: string | null;
}

/** Pure gate decision shared by the proxy, routes the proxy does not cover, and tests. */
export function decideAccess(request: AccessRequest, env: Environment = process.env, nowMs = Date.now()): AccessDecision {
  const { pathname } = request;
  if (pathname === "/api/health") return { kind: "allow" };
  const mode = accessMode(env);
  if (mode.kind === "open") return { kind: "allow" };
  if (mode.kind === "unconfigured") return { kind: "unconfigured" };
  if (isExemptPath(pathname)) return { kind: "allow" };
  if (verifyAccessToken(request.cookie, mode.signingKey, nowMs)) return { kind: "allow" };
  const method = (request.method ?? "GET").toUpperCase();
  if (pathname === "/api" || pathname.startsWith("/api/") || (method !== "GET" && method !== "HEAD")) return { kind: "unauthorized" };
  const next = sanitizeNextPath(`${pathname}${request.search ?? ""}`);
  return { kind: "redirect", location: next === "/" ? "/access" : `/access?next=${encodeURIComponent(next)}` };
}

/**
 * In-memory failure throttle (per process).
 *
 * - Per client: after `perClient` failures in the window the client is refused (fixed message).
 * - Globally there is no hard block, because anyone with the URL could use one to lock the owner
 *   out. Once `globalSlowdownAfter` failures fall inside the window, every attempt is delayed by
 *   `globalDelayMs` instead. A random code of 16+ characters is what makes guessing infeasible.
 * Successful sign-in clears the client's failures. Memory is bounded (client map and global ring).
 */
export class AttemptThrottle {
  private readonly failures = new Map<string, number[]>();
  private global: number[] = [];
  private readonly options: Required<ThrottleOptions>;

  constructor(options: ThrottleOptions = {}) {
    this.options = { perClient: 5, windowMs: 10 * 60 * 1000, globalSlowdownAfter: 100, globalDelayMs: 1000, maxClients: 10_000, ...options };
  }

  private prune(nowMs: number) {
    const floor = nowMs - this.options.windowMs;
    this.global = this.global.filter((time) => time > floor);
    for (const [key, times] of this.failures) {
      const kept = times.filter((time) => time > floor);
      if (kept.length) this.failures.set(key, kept); else this.failures.delete(key);
    }
  }

  isBlocked(client: string, nowMs = Date.now()): boolean {
    this.prune(nowMs);
    return (this.failures.get(client)?.length ?? 0) >= this.options.perClient;
  }

  /** Delay to apply before checking a code: zero unless many failures arrived recently overall. */
  delayMs(nowMs = Date.now()): number {
    this.prune(nowMs);
    return this.global.length >= this.options.globalSlowdownAfter ? this.options.globalDelayMs : 0;
  }

  recordFailure(client: string, nowMs = Date.now()): void {
    this.prune(nowMs);
    // Only the newest `globalSlowdownAfter` timestamps matter, so the ring never grows past it.
    this.global.push(nowMs);
    if (this.global.length > this.options.globalSlowdownAfter) this.global.splice(0, this.global.length - this.options.globalSlowdownAfter);
    if (!this.failures.has(client) && this.failures.size >= this.options.maxClients) {
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
    this.failures.set(client, [...(this.failures.get(client) ?? []), nowMs].slice(-this.options.perClient));
  }

  recordSuccess(client: string): void { this.failures.delete(client); }
}

export interface ThrottleOptions {
  perClient?: number;
  windowMs?: number;
  globalSlowdownAfter?: number;
  globalDelayMs?: number;
  maxClients?: number;
}

/**
 * Client key for throttling: the right-most X-Forwarded-For entry (the hop added by the platform
 * proxy closest to us), else X-Real-IP, else a shared bucket. Whether the platform appends that hop
 * is checked on the first deploy (see clientKeySource and deploy/README.md); if it does not, the
 * key is client-chosen and only the global slowdown applies.
 */
export function clientKey(headers: Headers): string {
  const forwarded = (headers.get("x-forwarded-for") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const candidate = forwarded.at(-1) ?? headers.get("x-real-ip")?.trim() ?? "";
  return /^[0-9A-Fa-f:.]{2,45}$/.test(candidate) ? candidate : "unknown";
}

/** Shape of the client-key source for a one-time diagnostic log line; never includes addresses. */
export function clientKeySource(headers: Headers): string {
  const forwarded = (headers.get("x-forwarded-for") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (forwarded.length) return `x-forwarded-for with ${forwarded.length} ${forwarded.length === 1 ? "entry" : "entries"}`;
  return headers.get("x-real-ip")?.trim() ? "x-real-ip" : "no client address header";
}

/**
 * In-route gate for routes excluded from the proxy matcher (raw uploads), so the proxy never
 * buffers their bodies. Returns the refusal to send, or null to continue. Call it before reading
 * any request body bytes.
 */
export function accessDenial(request: Request, env: Environment = process.env, nowMs = Date.now()): Response | null {
  let url: URL;
  try { url = new URL(request.url); } catch { return Response.json({ error: ACCESS_REQUIRED }, { status: 401, headers: { "Cache-Control": "no-store" } }); }
  const secure = requestIsHttps(request.url, request.headers, env);
  const decision = decideAccess({
    pathname: url.pathname,
    search: url.search,
    method: request.method,
    cookie: readCookie(request.headers.get("cookie"), accessCookieName(secure)),
  }, env, nowMs);
  if (decision.kind === "allow") return null;
  const headers = { "Cache-Control": "no-store" };
  if (decision.kind === "unconfigured") return Response.json({ error: ACCESS_NOT_CONFIGURED }, { status: 503, headers });
  if (decision.kind === "redirect") return new Response(null, { status: 307, headers: { ...headers, Location: decision.location } });
  return Response.json({ error: ACCESS_REQUIRED }, { status: 401, headers });
}
