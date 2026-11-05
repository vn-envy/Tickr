import { describe, expect, it, vi } from "vitest";
import { resolveBusinessReference } from "../../lib/research/reference";

describe("business reference routing", () => {
  it("extracts the routed name without fetching the Maps page or sending credentials", async () => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://www.google.com/maps/place/Grandma+Daphne%27s+Bakehouse/@17,78,16z" } }));
    const result = await resolveBusinessReference("https://maps.app.goo.gl/nNy6iYx9r4GaU7YY8", { fetch: transport as typeof fetch });
    expect(result.nameHint).toBe("Grandma Daphne's Bakehouse");
    expect(result.coordinatesHint).toEqual({ latitude: 17, longitude: 78, kind: "map_view" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]).toEqual(["https://maps.app.goo.gl/nNy6iYx9r4GaU7YY8", expect.objectContaining({ redirect: "manual", credentials: "omit", headers: { Accept: "text/html" } })]);
  });
  it("does not fetch arbitrary sources, lookalike hosts, embedded credentials or API paths", async () => {
    const transport = vi.fn();
    for (const value of ["https://example.com", "https://maps.app.goo.gl.evil.test/abcde", "https://user:password@maps.app.goo.gl/abcde", "https://maps.app.goo.gl/api/resolve", "https://maps.app.goo.gl:8443/abcde"]) await resolveBusinessReference(value, { fetch: transport });
    expect(transport).not.toHaveBeenCalled();
  });
  it("never follows a private, unrelated or credential-bearing redirect", async () => {
    for (const destination of ["http://127.0.0.1/private", "https://evil.test/maps", "https://secret@www.google.com/maps/place/Name", "https://www.google.com.evil.test/maps/place/Name", "https://www.google.com/mapsapi/place/Name"]) {
      const transport = vi.fn(async () => new Response(null, { status: 302, headers: { Location: destination } }));
      const result = await resolveBusinessReference("https://maps.app.goo.gl/abcde", { fetch: transport as typeof fetch });
      expect(result.nameHint).toBeNull();
      expect(result.resolvedUrl).toBe(result.inputUrl);
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it("bounds redirect loops and tolerates an unavailable redirect", async () => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://maps.app.goo.gl/abcde" } }));
    const result = await resolveBusinessReference("https://maps.app.goo.gl/abcde", { fetch: transport as typeof fetch });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.warnings).toHaveLength(1);
  });
  it("preserves a place pin separately from the map viewport and opaque feature identifier", async () => {
    const target = "https://www.google.com/maps/place/Orchard+Coffee+%26+Bistro/@17.4,78.3,16z/data=!4m6!3m5!1s0x123:0x456!8m2!3d17.4121811!4d78.3418891";
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { Location: target } }));
    const result = await resolveBusinessReference("https://maps.app.goo.gl/fixtureRoute", { fetch: transport as typeof fetch });
    expect(result).toMatchObject({ resolvedUrl: target, nameHint: "Orchard Coffee & Bistro", contextHint: "Orchard Coffee & Bistro", coordinatesHint: { latitude: 17.4121811, longitude: 78.3418891, kind: "place" }, featureIdHint: "0x123:0x456", placeIdHint: null });
    expect(transport).toHaveBeenCalledOnce();
    expect(result).not.toHaveProperty("locality");
  });
  it("reads direct Maps query hints without any fetch and never geocodes them", async () => {
    const transport = vi.fn();
    const result = await resolveBusinessReference("https://www.google.com/maps/search/?api=1&query=Orchard%20Bistro%20Riverside&query_place_id=ChIJ_fixtureIdentifier", { fetch: transport });
    expect(result).toMatchObject({ nameHint: null, contextHint: "Orchard Bistro Riverside", placeIdHint: "ChIJ_fixtureIdentifier", coordinatesHint: null });
    const pin = await resolveBusinessReference("https://maps.google.com/maps?q=17.4121811,78.3418891", { fetch: transport });
    expect(pin.coordinatesHint).toEqual({ latitude: 17.4121811, longitude: 78.3418891, kind: "place" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects invalid and conflicting place coordinates instead of using a plausible viewport", async () => {
    const transport = vi.fn();
    for (const suffix of ["!3d999!4d78", "!3d17!4d181", "!3d17!4d78!3d18!4d79"]) {
      const result = await resolveBusinessReference(`https://www.google.com/maps/place/Orchard/@17,78,16z/data=${suffix}`, { fetch: transport });
      expect(result.coordinatesHint).toBeNull();
      expect(result.warnings.join(" ")).toContain("invalid or conflicting");
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("trims only a trailing sentence period on a valid Maps short-link token", async () => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://www.google.com/maps/place/Orchard/" } }));
    const input = "https://maps.app.goo.gl/fixtureRoute.";
    const result = await resolveBusinessReference(input, { fetch: transport as typeof fetch });
    expect(result.inputUrl).toBe(input);
    expect(transport).toHaveBeenCalledWith("https://maps.app.goo.gl/fixtureRoute", expect.objectContaining({ redirect: "manual" }));
    expect(result.warnings.join(" ")).toContain("trailing sentence period");
    transport.mockClear();
    for (const value of ["https://example.com/fixtureRoute.", "https://maps.app.goo.gl/fixtureRoute..?x=1", "https://maps.app.goo.gl/fixtureRoute.#fragment", "https://maps.app.goo.gl/fixtureRoute.?x=1"]) {
      await resolveBusinessReference(value, { fetch: transport as typeof fetch });
    }
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("Google share-link routing", () => {
  const input = "https://share.google/FVjbnawViHJw2GdDg";
  const hop = "https://www.google.com/share.google?q=FVjbnawViHJw2GdDg";
  const terminal = "https://www.google.com/search?sca_esv=fixtureEsv&sxsrf=fixtureSxsrf&kgmid=/g/11yfky_f64&q=Katha+Coffee+%26+Bakehouse+%7C+Financial+District&shem=fixtureShem&source=sh/x/loc/uni/m1/1&kgs=fixtureKgs&utm_source=fixtureUtm";
  type Step = { status: number; location?: string; body?: string };
  /** A header-only fake transport: it records whether any response body was read and never serves /search. */
  function chain(steps: Record<string, Step>) {
    const bodyReads: string[] = [];
    const cancelled: string[] = [];
    const transport = vi.fn<(target: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (target) => {
      const href = String(target);
      if (new URL(href).pathname === "/search") throw new Error("The search destination must never be requested.");
      const step = steps[href];
      if (!step) throw new Error(`Unexpected request ${href}`);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) { bodyReads.push(href); controller.enqueue(new TextEncoder().encode(step.body ?? "<html>fixture</html>")); controller.close(); },
        cancel() { cancelled.push(href); },
      }, { highWaterMark: 0 });
      const response = new Response(stream, { status: step.status, headers: step.location ? { Location: step.location } : {} });
      for (const method of ["text", "json", "arrayBuffer", "blob", "formData", "bytes"] as const) {
        if (method in response) vi.spyOn(response, method as "text").mockImplementation(async () => { bodyReads.push(href); throw new Error("body read"); });
      }
      return response;
    });
    return { transport: transport as unknown as typeof fetch & typeof transport, bodyReads, cancelled };
  }
  const noHints = { nameHint: null, contextHint: null, placeIdHint: null, coordinatesHint: null, featureIdHint: null };

  it("follows the observed header-only chain and stops before the search page", async () => {
    const { transport, bodyReads, cancelled } = chain({ [input]: { status: 302, location: hop }, [hop]: { status: 301, location: terminal } });
    const result = await resolveBusinessReference(input, { fetch: transport });
    expect(result).toMatchObject({ inputUrl: input, nameHint: "Katha Coffee & Bakehouse", contextHint: "Financial District", placeIdHint: "/g/11yfky_f64", coordinatesHint: null, featureIdHint: null, warnings: [] });
    expect(result.resolvedUrl).toBe("https://www.google.com/search?q=Katha+Coffee+%26+Bakehouse+%7C+Financial+District&kgmid=%2Fg%2F11yfky_f64");
    expect(result.resolvedUrl).not.toMatch(/sxsrf|sca_esv|kgs|shem|utm_/);
    expect(transport.mock.calls.map((call) => String(call[0]))).toEqual([input, hop]);
    for (const call of transport.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", headers: { Accept: "text/html" } }));
      expect(JSON.stringify(call[1]?.headers)).not.toMatch(/authorization|cookie/i);
    }
    expect(bodyReads).toEqual([]);
    expect(cancelled).toEqual([input, hop]);
  });

  it("refuses malformed share links without any request", async () => {
    const { transport } = chain({});
    for (const value of ["http://share.google/FVjbnawViHJw2GdDg", "https://share.google/abc", "https://share.google/FVjbnawViHJw2GdDg?x=1", "https://share.google/FVjbnawViHJw2GdDg?", "https://share.google/FVjbnawViHJw2GdDg#frag",
      "https://user:pw@share.google/FVjbnawViHJw2GdDg", "https://share.google:8443/FVjbnawViHJw2GdDg", "https://share.google/FVjb/nawViHJw2GdDg", "https://share.google.evil.test/FVjbnawViHJw2GdDg", `https://share.google/${"a".repeat(65)}`]) {
      const result = await resolveBusinessReference(value, { fetch: transport });
      expect(result).toMatchObject(noHints);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("fails closed on any deviation in the redirect chain", async () => {
    const cases: { name: string; steps: Record<string, Step>; requests: number }[] = [
      { name: "other host", steps: { [input]: { status: 302, location: "https://evil.test/share.google?q=FVjbnawViHJw2GdDg" } }, requests: 1 },
      { name: "lookalike host", steps: { [input]: { status: 302, location: "https://www.google.com.evil.test/share.google?q=FVjbnawViHJw2GdDg" } }, requests: 1 },
      { name: "other Google host", steps: { [input]: { status: 302, location: hop }, [hop]: { status: 301, location: terminal.replace("www.google.com", "www.google.co.in") } }, requests: 2 },
      { name: "http terminal", steps: { [input]: { status: 302, location: hop }, [hop]: { status: 301, location: terminal.replace("https:", "http:") } }, requests: 2 },
      { name: "http hop", steps: { [input]: { status: 302, location: hop.replace("https:", "http:") } }, requests: 1 },
      { name: "unexpected path", steps: { [input]: { status: 302, location: "https://www.google.com/maps/place/Katha" } }, requests: 1 },
      { name: "token mismatch", steps: { [input]: { status: 302, location: "https://www.google.com/share.google?q=OtherToken123" } }, requests: 1 },
      { name: "extra hop parameter", steps: { [input]: { status: 302, location: `${hop}&next=https://evil.test` } }, requests: 1 },
      { name: "different share token", steps: { [input]: { status: 302, location: "https://share.google/OtherToken123" } }, requests: 1 },
      { name: "credentials in redirect", steps: { [input]: { status: 302, location: "https://user@www.google.com/share.google?q=FVjbnawViHJw2GdDg" } }, requests: 1 },
      { name: "body-only 200", steps: { [input]: { status: 200, body: `<a href="${terminal}">Katha</a>` } }, requests: 1 },
      { name: "200 with Location", steps: { [input]: { status: 200, location: terminal } }, requests: 1 },
      { name: "missing Location", steps: { [input]: { status: 302 } }, requests: 1 },
      { name: "missing q", steps: { [input]: { status: 302, location: hop }, [hop]: { status: 301, location: "https://www.google.com/search?kgmid=/g/11yfky_f64" } }, requests: 2 },
      { name: "duplicate q", steps: { [input]: { status: 302, location: hop }, [hop]: { status: 301, location: `${terminal}&q=Other` } }, requests: 2 },
      { name: "oversized q", steps: { [input]: { status: 302, location: hop }, [hop]: { status: 301, location: `https://www.google.com/search?q=${"Katha+".repeat(40)}` } }, requests: 2 },
      { name: "control-only q", steps: { [input]: { status: 302, location: hop }, [hop]: { status: 301, location: "https://www.google.com/search?q=%00%01%1F" } }, requests: 2 },
      { name: "too many hops", steps: { [input]: { status: 302, location: hop }, [hop]: { status: 302, location: hop } }, requests: 3 },
    ];
    for (const entry of cases) {
      const { transport, bodyReads } = chain(entry.steps);
      const result = await resolveBusinessReference(input, { fetch: transport });
      expect(result, entry.name).toMatchObject({ ...noHints, resolvedUrl: input });
      expect(result.warnings.join(" "), entry.name).toContain("Google share link did not expose a usable routing redirect");
      expect(transport, entry.name).toHaveBeenCalledTimes(entry.requests);
      expect(bodyReads, entry.name).toEqual([]);
    }
  });

  it("strips control characters from the routed name and ignores a malformed knowledge-graph id", async () => {
    const { transport } = chain({ [input]: { status: 302, location: hop }, [hop]: { status: 301, location: "https://www.google.com/search?q=Katha%00+Coffee%1B+%7C+Financial%0ADistrict&kgmid=/x/../../etc" } });
    const result = await resolveBusinessReference(input, { fetch: transport });
    expect(result).toMatchObject({ nameHint: "Katha Coffee", contextHint: "Financial District", placeIdHint: null });
    expect(`${result.nameHint}${result.contextHint}`).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("tolerates an unavailable network without hints", async () => {
    const transport = vi.fn(async () => { throw new TypeError("network down"); });
    const result = await resolveBusinessReference(input, { fetch: transport as unknown as typeof fetch });
    expect(result).toMatchObject({ ...noHints, resolvedUrl: input });
    expect(transport).toHaveBeenCalledOnce();
  });
});
