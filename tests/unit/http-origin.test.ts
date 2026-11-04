import { afterEach, describe, expect, it } from "vitest";
import { assertSameOriginRequest, readLocalJson } from "../../lib/http";

// Next started with --hostname 0.0.0.0 derives request.url from the bind address.
const request = (origin: string | null, host: string, url = "http://0.0.0.0:3000/api/businesses") => new Request(url, {
  method: "POST", headers: { "content-type": "application/json", host, ...(origin ? { origin } : {}) }, body: "{}",
});

describe("same-origin write guard", () => {
  afterEach(() => { delete process.env.TICKR_ALLOWED_HOSTS; });
  it("accepts the browser's own loopback origin even when request.url names the bind address", async () => {
    for (const host of ["127.0.0.1:3000", "localhost:3000"]) {
      expect(() => assertSameOriginRequest(request(`http://${host}`, host))).not.toThrow();
      await expect(readLocalJson(request(`http://${host}`, host))).resolves.toEqual({});
    }
  });
  it("accepts requests without an Origin header (local tools), as before", () => {
    expect(() => assertSameOriginRequest(request(null, "127.0.0.1:3000"))).not.toThrow();
  });
  it("rejects foreign origins, scheme tricks and DNS-rebinding hosts", () => {
    expect(() => assertSameOriginRequest(request("https://example.org", "127.0.0.1:3000"))).toThrow("Cross-origin");
    expect(() => assertSameOriginRequest(request("http://127.0.0.1:3001", "127.0.0.1:3000"))).toThrow("Cross-origin");
    expect(() => assertSameOriginRequest(request("null", "127.0.0.1:3000"))).toThrow("Cross-origin");
    // Rebinding: attacker domain resolving to this machine; Origin and Host agree but the host is not allowed.
    expect(() => assertSameOriginRequest(request("http://attacker.example:3000", "attacker.example:3000"))).toThrow("Cross-origin");
  });
  it("allows explicitly configured hosts and the host Next derived for request.url", () => {
    process.env.TICKR_ALLOWED_HOSTS = "tickr.internal:3000";
    expect(() => assertSameOriginRequest(request("http://tickr.internal:3000", "tickr.internal:3000"))).not.toThrow();
    expect(() => assertSameOriginRequest(request("http://studio.lan:3000", "studio.lan:3000", "http://studio.lan:3000/api/businesses"))).not.toThrow();
  });
});
