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
