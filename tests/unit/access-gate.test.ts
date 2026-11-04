import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ACCESS_COOKIE, ACCESS_COOKIE_SECURE, ACCESS_TTL_SECONDS, AttemptThrottle, accessCookieHeader, accessCookieName, accessDenial,
  accessMode, clientKey, clientKeySource, decideAccess, isExemptPath, issueAccessToken, readCookie, requestIsHttps,
  sanitizeNextPath, verifyAccessCode, verifyAccessToken,
} from "@/lib/access";
import { config as proxyConfig } from "@/proxy";

const CODE = "correct-horse-battery-staple-42";
const SECRET = Buffer.alloc(32, 7).toString("base64");
const gatedEnv = { TICKR_ACCESS_CODE: CODE, TICKR_SECRET_KEY: SECRET, TICKR_DEPLOYMENT: "modal" };
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

function gatedKey(env: Record<string, string | undefined> = gatedEnv): Buffer {
  const mode = accessMode(env);
  if (mode.kind !== "gated") throw new Error("expected gated mode");
  return mode.signingKey;
}

describe("access mode", () => {
  it("is open locally when neither a code nor a deployment is configured", () => {
    expect(accessMode({}).kind).toBe("open");
    expect(decideAccess({ pathname: "/" }, {})).toEqual({ kind: "allow" });
    expect(decideAccess({ pathname: "/api/runs/x", method: "POST" }, {})).toEqual({ kind: "allow" });
  });

  it("fails closed in a Modal deployment without a usable code, except for health", () => {
    for (const env of [{ TICKR_DEPLOYMENT: "modal" }, { TICKR_DEPLOYMENT: "modal", TICKR_ACCESS_CODE: "   " }, { TICKR_DEPLOYMENT: "modal", TICKR_ACCESS_CODE: "short" }]) {
      expect(accessMode(env).kind).toBe("unconfigured");
      for (const pathname of ["/", "/access", "/api/access", "/api/businesses", "/_next/static/chunk.js"]) {
        expect(decideAccess({ pathname }, env)).toEqual({ kind: "unconfigured" });
      }
      expect(decideAccess({ pathname: "/api/health" }, env)).toEqual({ kind: "allow" });
    }
  });

  it("treats a too-short code as misconfiguration even outside a deployment", () => {
    expect(accessMode({ TICKR_ACCESS_CODE: "12345" }).kind).toBe("unconfigured");
    expect(accessMode({ TICKR_ACCESS_CODE: CODE }).kind).toBe("gated");
  });

  it("fails closed, naming only the variable, when the code has surrounding whitespace", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const code of [`${CODE}\n`, ` ${CODE}`, `${CODE}\t`]) {
        expect(accessMode({ ...gatedEnv, TICKR_ACCESS_CODE: code }).kind).toBe("unconfigured");
        expect(decideAccess({ pathname: "/" }, { ...gatedEnv, TICKR_ACCESS_CODE: code })).toEqual({ kind: "unconfigured" });
      }
      const logged = errors.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("TICKR_ACCESS_CODE has leading or trailing whitespace");
      expect(logged).not.toContain(CODE);
    } finally { errors.mockRestore(); }
  });
});

describe("access tokens", () => {
  it("verifies a fresh token and rejects it after the 7-day expiry", () => {
    const key = gatedKey();
    const token = issueAccessToken(key, NOW);
    expect(verifyAccessToken(token, key, NOW)).toBe(true);
    expect(verifyAccessToken(token, key, NOW + (ACCESS_TTL_SECONDS - 1) * 1000)).toBe(true);
    expect(verifyAccessToken(token, key, NOW + ACCESS_TTL_SECONDS * 1000)).toBe(false);
  });

  it("rejects tampered, re-signed, malformed and over-long-lived tokens", () => {
    const key = gatedKey();
    const token = issueAccessToken(key, NOW);
    const [version, expiry, nonce, mac] = token.split(".");
    expect(verifyAccessToken(`${version}.${Number(expiry) + 60}.${nonce}.${mac}`, key, NOW)).toBe(false);
    expect(verifyAccessToken(`${version}.${expiry}.${nonce}.${mac.slice(0, 10)}${mac[10] === "A" ? "B" : "A"}${mac.slice(11)}`, key, NOW)).toBe(false);
    // Non-canonical base64url (different trailing padding bits, same bytes) is refused too.
    const last = mac.at(-1) ?? "A";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sibling = alphabet[alphabet.indexOf(last) ^ 1];
    expect(verifyAccessToken(`${version}.${expiry}.${nonce}.${mac.slice(0, -1)}${sibling}`, key, NOW)).toBe(false);
    expect(verifyAccessToken(`v2.${expiry}.${nonce}.${mac}`, key, NOW)).toBe(false);
    for (const bad of ["", "v1", "v1.1.2.3", `${token}.extra`, null, undefined]) expect(verifyAccessToken(bad, key, NOW)).toBe(false);
    // Issued "in the future" (expiry beyond one TTL from now) is refused even with a valid MAC.
    expect(verifyAccessToken(issueAccessToken(key, NOW + 3600_000), key, NOW)).toBe(false);
  });

  it("invalidates sessions when the code or TICKR_SECRET_KEY changes", () => {
    const token = issueAccessToken(gatedKey(), NOW);
    expect(verifyAccessToken(token, gatedKey({ ...gatedEnv, TICKR_ACCESS_CODE: `${CODE}-rotated` }), NOW)).toBe(false);
    expect(verifyAccessToken(token, gatedKey({ ...gatedEnv, TICKR_SECRET_KEY: Buffer.alloc(32, 9).toString("base64") }), NOW)).toBe(false);
    expect(verifyAccessToken(token, gatedKey({ TICKR_ACCESS_CODE: CODE, TICKR_DEPLOYMENT: "modal" }), NOW)).toBe(false);
  });

  it("checks the access code exactly", () => {
    const mode = accessMode(gatedEnv);
    expect(verifyAccessCode(CODE, mode)).toBe(true);
    for (const wrong of [`${CODE} `, CODE.toUpperCase(), CODE.slice(0, -1), "", null, 42, "x".repeat(1000)]) expect(verifyAccessCode(wrong, mode)).toBe(false);
    expect(verifyAccessCode(CODE, accessMode({}))).toBe(false);
  });

  it("builds an HttpOnly, SameSite=Lax cookie that is a Secure __Host- cookie over HTTPS", () => {
    const header = accessCookieHeader("v1.1.a.b", true);
    expect(header).toMatch(/^__Host-tickr_access=v1\.1\.a\.b; Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure$/);
    expect(header).not.toMatch(/Domain=/i);
    expect(accessCookieHeader("t", false)).toMatch(/^tickr_access=t; /);
    expect(accessCookieHeader("t", false)).not.toContain("Secure");
    expect(accessCookieName(true)).toBe(ACCESS_COOKIE_SECURE);
    expect(accessCookieName(false)).toBe(ACCESS_COOKIE);
    expect(readCookie("a=1; __Host-tickr_access=tok; tickr_access=plain", ACCESS_COOKIE_SECURE)).toBe("tok");
    expect(readCookie("a=1; xtickr_access=no", ACCESS_COOKIE)).toBeNull();
    expect(requestIsHttps("http://0.0.0.0:3000/api/access", new Headers(), { TICKR_DEPLOYMENT: "modal" })).toBe(true);
    expect(requestIsHttps("http://0.0.0.0:3000/api/access", new Headers({ "x-forwarded-proto": "https" }), {})).toBe(true);
    expect(requestIsHttps("http://localhost:3000/api/access", new Headers(), {})).toBe(false);
  });
});

describe("gate decisions", () => {
  it("allows the exempt paths without a session and nothing else", () => {
    for (const pathname of ["/api/health", "/access", "/api/access", "/favicon.ico", "/_next/static/chunks/app.js"]) {
      expect(isExemptPath(pathname)).toBe(true);
      expect(decideAccess({ pathname }, gatedEnv, NOW)).toEqual({ kind: "allow" });
    }
    for (const pathname of ["/", "/api/healthz", "/api/health/x", "/access/x", "/_next/image", "/_next/data/b/index.json", "/api/connections/meta/callback", "/api%2Fhealth"]) {
      expect(isExemptPath(pathname)).toBe(false);
      expect(decideAccess({ pathname }, gatedEnv, NOW).kind).not.toBe("allow");
    }
  });

  it("redirects pages to /access with a same-origin next path and answers APIs with 401", () => {
    expect(decideAccess({ pathname: "/", search: "" }, gatedEnv, NOW)).toEqual({ kind: "redirect", location: "/access" });
    expect(decideAccess({ pathname: "/", search: "?business=abc&connected=meta" }, gatedEnv, NOW))
      .toEqual({ kind: "redirect", location: `/access?next=${encodeURIComponent("/?business=abc&connected=meta")}` });
    expect(decideAccess({ pathname: "/api/businesses", method: "GET" }, gatedEnv, NOW)).toEqual({ kind: "unauthorized" });
    expect(decideAccess({ pathname: "/api/businesses/x/media", method: "POST" }, gatedEnv, NOW)).toEqual({ kind: "unauthorized" });
    expect(decideAccess({ pathname: "/", method: "POST" }, gatedEnv, NOW)).toEqual({ kind: "unauthorized" });
  });

  it("allows every route (including the Meta OAuth callback and uploads) with a valid cookie", () => {
    const cookie = issueAccessToken(gatedKey(), NOW);
    for (const [pathname, method] of [["/", "GET"], ["/api/connections/meta/callback", "GET"], ["/api/businesses/x/media", "POST"], ["/api/runs/x/files/a.png", "GET"]]) {
      expect(decideAccess({ pathname, method, cookie }, gatedEnv, NOW)).toEqual({ kind: "allow" });
    }
    expect(decideAccess({ pathname: "/", cookie }, gatedEnv, NOW + ACCESS_TTL_SECONDS * 1000).kind).toBe("redirect");
  });
});

describe("next-path sanitizing", () => {
  it("keeps same-origin relative paths", () => {
    expect(sanitizeNextPath("/")).toBe("/");
    expect(sanitizeNextPath("/?business=abc")).toBe("/?business=abc");
    expect(sanitizeNextPath("/api/runs/1/files/a.png#x")).toBe("/api/runs/1/files/a.png#x");
    expect(sanitizeNextPath("/a/../b")).toBe("/b");
  });

  it("drops absolute, protocol-relative, backslash, control-character and loop targets", () => {
    for (const bad of ["https://evil.example/", "//evil.example/x", "/\\evil.example", "\\\\evil", "/x\\y", "javascript:alert(1)", "evil", "/a\nb", "/a\u0000", "/access", "/access?next=/x", "/api/access", "", null, 7, `/${"a".repeat(3000)}`]) {
      expect(sanitizeNextPath(bad)).toBe("/");
    }
  });

  it("never yields a protocol-relative target after dot-segment removal", () => {
    for (const bad of ["/.//evil.example", "/a/..//evil.example", "/..//evil.example", "/%2e//evil.example", "/%2E%2E//evil.example", "/./%2e//evil.example/x?y#z", "/.///evil.example", "/a/b/../..//evil.example"]) {
      const out = sanitizeNextPath(bad);
      expect(out).toBe("/");
      expect(new URL(out, "https://tickr.example").host).toBe("tickr.example");
    }
    // The redirect built by the gate is sanitized the same way.
    expect(decideAccess({ pathname: "/.//evil.example" }, gatedEnv, NOW)).toEqual({ kind: "redirect", location: "/access" });
  });
});

describe("attempt throttle", () => {
  it("blocks a client after 5 failures in 10 minutes and recovers after the window", () => {
    const throttle = new AttemptThrottle({ perClient: 5, windowMs: 600_000 });
    for (let index = 0; index < 5; index += 1) {
      expect(throttle.isBlocked("203.0.113.9", NOW)).toBe(false);
      throttle.recordFailure("203.0.113.9", NOW + index);
    }
    expect(throttle.isBlocked("203.0.113.9", NOW + 10)).toBe(true);
    expect(throttle.isBlocked("198.51.100.1", NOW + 10)).toBe(false);
    expect(throttle.isBlocked("203.0.113.9", NOW + 600_010)).toBe(false);
  });

  it("clears a client on success and never hard-blocks other clients globally, only slows down", () => {
    const throttle = new AttemptThrottle({ perClient: 5, windowMs: 600_000, globalSlowdownAfter: 8, globalDelayMs: 750 });
    for (let index = 0; index < 4; index += 1) throttle.recordFailure("a", NOW);
    throttle.recordSuccess("a");
    expect(throttle.isBlocked("a", NOW)).toBe(false);
    expect(throttle.delayMs(NOW)).toBe(0);
    // A flood of failures under spoofed keys must not lock the owner out.
    for (let index = 0; index < 500; index += 1) throttle.recordFailure(`spoofed-${index}`, NOW);
    expect(throttle.isBlocked("owner", NOW)).toBe(false);
    expect(throttle.delayMs(NOW)).toBe(750);
    expect(throttle.delayMs(NOW + 600_001)).toBe(0);
  });

  it("derives the client key from the nearest proxy hop and describes its source without addresses", () => {
    expect(clientKey(new Headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientKey(new Headers({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientKey(new Headers({ "x-forwarded-for": "<script>" }))).toBe("unknown");
    expect(clientKey(new Headers())).toBe("unknown");
    const described = clientKeySource(new Headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" }));
    expect(described).toBe("x-forwarded-for with 2 entries");
    expect(described).not.toContain("203.0.113.7");
    expect(clientKeySource(new Headers())).toBe("no client address header");
  });
});

describe("raw uploads bypass the proxy and gate themselves", () => {
  // Next compiles the matcher source into an anchored regular expression over the pathname.
  const matcher = new RegExp(`^${proxyConfig.matcher[0]}$`);

  it("keeps the upload route out of the proxy matcher (no body buffering) and everything else in", () => {
    for (const pathname of ["/api/businesses/abc/media", "/api/businesses/c1x-9_z/media", "/_next/static/chunks/a.js", "/favicon.ico"]) {
      expect(matcher.test(pathname)).toBe(false);
    }
    for (const pathname of ["/", "/access", "/api/businesses", "/api/businesses/abc/media/asset1", "/api/businesses/abc/media/asset1/thumb", "/api/businesses/abc/media/", "/api/businesses/abc/media-x", "/api/businesses/abc/connection", "/api/runs/r1/files/a.png", "/api/connections/meta/callback"]) {
      expect(matcher.test(pathname)).toBe(true);
    }
  });

  it("refuses an upload without a valid cookie before reading the body", async () => {
    const body = new ReadableStream<Uint8Array>({ pull() { throw new Error("body must not be read"); } });
    const request = new Request("http://0.0.0.0:3000/api/businesses/abc/media?consent=1", { method: "POST", body, duplex: "half", headers: { "content-type": "video/mp4" } } as RequestInit);
    const denied = accessDenial(request, gatedEnv, NOW);
    expect(denied?.status).toBe(401);
    expect(await denied?.json()).toEqual({ error: "Access code required." });
    // A plain-HTTP cookie name or a forged token is refused over HTTPS; the __Host- token is accepted.
    const token = issueAccessToken(gatedKey(), NOW);
    const withCookie = (cookie: string) => new Request("http://0.0.0.0:3000/api/businesses/abc/media", { method: "POST", headers: { cookie } });
    expect(accessDenial(withCookie(`${ACCESS_COOKIE}=${token}`), gatedEnv, NOW)?.status).toBe(401);
    expect(accessDenial(withCookie(`${ACCESS_COOKIE_SECURE}=${token.slice(0, -2)}AA`), gatedEnv, NOW)?.status).toBe(401);
    expect(accessDenial(withCookie(`${ACCESS_COOKIE_SECURE}=${token}`), gatedEnv, NOW)).toBeNull();
    expect(accessDenial(withCookie(""), { TICKR_DEPLOYMENT: "modal" }, NOW)?.status).toBe(503);
    expect(accessDenial(withCookie(""), {}, NOW)).toBeNull();
  });

  it("is wired into both handlers of the upload route before any other work", () => {
    const source = readFileSync(join(process.cwd(), "app/api/businesses/[id]/media/route.ts"), "utf8");
    for (const method of ["GET", "POST"]) {
      const handler = source.slice(source.indexOf(`export async function ${method}(`));
      const firstStatement = handler.slice(handler.indexOf(") {\n") + 3).trimStart();
      expect(firstStatement.split("\n").find((line) => !line.trim().startsWith("//"))?.trim()).toBe("const denied = accessDenial(request);");
    }
  });
});
