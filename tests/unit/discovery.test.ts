import { describe, expect, test, vi } from "vitest";
import { discoverBusiness, discoveryNameMatches, extractDiscoveryResponse } from "../../lib/research/discover";
import type { BusinessReference } from "../../lib/research/reference";

const url = "https://www.instagram.com/fixtureorchard/";
const business = { id: "business", name: "Orchard Bakehouse", locality: "", vertical: "bakery" as const, goal: "Tell the business story", website: "https://maps.app.goo.gl/fixtureReference" };
const at = "2026-11-01T00:00:00.000Z";
const candidate = {
  name: "Orchard Bakehouse", locality: null, vertical: "bakery", officialWebsite: null, instagram: url,
  identitySourceUrls: [url], facts: [{ subject: "business", claim: "The business describes its baking as inspired by family recipes.", sourceUrl: url }],
  unknowns: ["Locality and product availability remain unknown."],
};
function response(value: unknown = candidate, options: { status?: string; searchStatus?: string; snippet?: string; annotations?: unknown[]; rawText?: string } = {}) {
  return { id: "response-fixture", status: options.status ?? "completed", usage: { input_tokens: 100, output_tokens: 30 }, output: [
    { id: "search-fixture", type: "web_search_call", status: options.searchStatus ?? "completed", action: { type: "search", query: "Orchard Bakehouse official profile" }, results: [{ type: "text_result", title: "Orchard Bakehouse (@fixtureorchard) • Instagram", url, snippet: options.snippet ?? "" }] },
    { type: "message", content: [{ type: "output_text", text: options.rawText ?? JSON.stringify(value), annotations: options.annotations ?? [] }] },
  ] };
}

describe("Meta business discovery", () => {
  test("matches business punctuation/category variants without matching a different or generic business", () => {
    expect(discoveryNameMatches("Grandma Daphne’s Bake House", "Grandma Daphne's (@grandmadaphnes) • Instagram")).toBe(true);
    expect(discoveryNameMatches("Grandma Daphnes Bakehouse", "Grandma Daphne's")).toBe(true);
    expect(discoveryNameMatches("Grandma Daphne's Bakehouse", "Daphne's Dishes, Newcastle, US")).toBe(false);
    expect(discoveryNameMatches("Grandma Daphne's Bakehouse", "Grandma's Gingerbread Bakery")).toBe(false);
    expect(discoveryNameMatches("The Bake House", "An unrelated Bakery")).toBe(false);
    expect(discoveryNameMatches("Orchard Patisserie", "Orchard bakery")).toBe(true);
    expect(discoveryNameMatches("Patisserie", "An unrelated bakery")).toBe(false);
  });

  test("extracts the short brand name from an SEO title only with opened first-party identity support", () => {
    const website = "https://orchard.example.com/";
    const value = { ...candidate, name: "Orchard Patisserie: Finest Online Bakery Store in India", officialWebsite: website, instagram: null, identitySourceUrls: [website], facts: [
      { subject: "business", claim: "The business presents itself as Orchard Patisserie, serving traditional recipes since 2004.", sourceUrl: website },
      { subject: "business", claim: "The business describes its baking as inspired by family recipes.", sourceUrl: website },
    ] };
    const envelope = { id: "opened-website", status: "completed", output: [
      { id: "opened-homepage", type: "web_search_call", status: "completed", action: { type: "open_page", url: website }, results: [] },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] },
    ] };
    const result = extractDiscoveryResponse(envelope, { ...business, name: "", website }, { discoveredAt: at });
    expect(result.discovery).toMatchObject({ status: "matched", name: "Orchard Patisserie", officialWebsite: website, locality: null });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ text: value.facts[1].claim, acquisition: "meta_cited_summary", citation: { method: "model_reference", url: website, searchCallIds: ["opened-homepage"] } });
    expect(result.sources[0].text).not.toContain("2004");
  });

  test("supports SEO suffixes after title separators without dropping distinctive brand words", () => {
    for (const separator of [": ", " - ", " | ", " — ", " – "]) {
      const result = extractDiscoveryResponse(response({ ...candidate, name: `Orchard Bakehouse${separator}Finest Online Bakery Store` }), business, { discoveredAt: at });
      expect(result.discovery).toMatchObject({ status: "matched", name: "Orchard Bakehouse" });
    }
    for (const name of ["Orchard Riverside Bakehouse: Finest Online Bakery Store", "Different Patisserie: Finest Online Bakery Store", "Patisserie: Finest Online Bakery Store", "Orchard Bakehouse - Riverside", "Orchard-Riverside Bakehouse: Finest Online Bakery Store"]) {
      const result = extractDiscoveryResponse(response({ ...candidate, name }), { ...business, name: "" }, { discoveredAt: at });
      expect(result.discovery.name).toBeNull();
      expect(result.sources).toEqual([]);
    }
    const wrongHint = extractDiscoveryResponse(response({ ...candidate, name: "Orchard Bakehouse: Finest Online Bakery Store" }), { ...business, name: "Orchard Riverside Bakehouse" }, { discoveredAt: at });
    expect(wrongHint.discovery.name).toBeNull();
    expect(wrongHint.sources).toEqual([]);
  });

  test("canonicalizes known Instagram profile aliases but preserves path and query boundaries", () => {
    const aliased = { ...candidate, instagram: "https://instagram.com/FixtureOrchard", identitySourceUrls: ["https://instagram.com/fixtureorchard"], facts: [{ ...candidate.facts[0], sourceUrl: "https://m.instagram.com/fixtureorchard" }] };
    const result = extractDiscoveryResponse(response(aliased), business, { discoveredAt: at });
    expect(result.discovery).toMatchObject({ status: "matched", instagramUrl: url });
    expect(result.sources).toHaveLength(1);
    const changedQuery = extractDiscoveryResponse(response({ ...aliased, facts: [{ ...candidate.facts[0], sourceUrl: `${url}?invented=1` }] }), business, { discoveredAt: at });
    expect(changedQuery.sources).toEqual([]);
    const changedPath = extractDiscoveryResponse(response({ ...aliased, facts: [{ ...candidate.facts[0], sourceUrl: `${url}other/` }] }), business, { discoveredAt: at });
    expect(changedPath.sources).toEqual([]);
  });

  test("retains exact retrieved-URL summaries with explicit lower-strength provenance and no city prerequisite", () => {
    const result = extractDiscoveryResponse(response(), business, { discoveredAt: at });
    expect(result.discovery).toMatchObject({ status: "matched", name: "Orchard Bakehouse", vertical: "bakery", locality: null, instagramUrl: url, completedToolCalls: 1 });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ acquisition: "meta_cited_summary", text: candidate.facts[0].claim, citation: { method: "model_reference", url, responseId: "response-fixture", searchCallIds: ["search-fixture"] } });
    expect(result.discovery.warnings.some((warning) => warning.includes("not independently verified"))).toBe(true);
  });

  test("supports open business categories and a matched brand with unknown category", () => {
    for (const vertical of ["cafe and bistro", "florist", "bookshop", null]) {
      const result = extractDiscoveryResponse(response({ ...candidate, vertical }), business, { discoveredAt: at });
      expect(result.discovery).toMatchObject({ status: "matched", name: "Orchard Bakehouse", vertical, branch: { status: "unresolved" } });
    }
  });

  test("distinguishes an attributed branch candidate from an exact pin match", () => {
    const branchUrl = "https://orchard.example.com/locations/riverside";
    const claim = "Orchard Bakehouse describes its Riverside branch at Riverside Market Road.";
    const proposed = { ...candidate, locality: "Riverside", identitySourceUrls: [branchUrl], facts: [{ subject: "business", claim, sourceUrl: branchUrl }], branch: {
      status: "matched", label: "Orchard Bakehouse Riverside", locality: "Riverside", address: "Riverside Market Road", sourceUrls: [branchUrl], rationale: "The dedicated branch page appears to correspond to the supplied place pin.",
    } };
    const reference: BusinessReference = { inputUrl: business.website, resolvedUrl: "https://www.google.com/maps/place/Orchard/data=!3d17.4!4d78.3", nameHint: business.name,
      coordinatesHint: { latitude: 17.4, longitude: 78.3, kind: "place" }, placeIdHint: null, featureIdHint: null, contextHint: business.name, warnings: [] };
    const envelope = (snippet: string) => ({ id: "branch-response", status: "completed", output: [
      { id: "branch-search", type: "web_search_call", status: "completed", action: { type: "search", query: "Orchard Riverside branch" }, results: [{ title: "Orchard Bakehouse Riverside", url: branchUrl, snippet }] },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(proposed) }] },
    ] });
    const weak = extractDiscoveryResponse(envelope(""), business, { discoveredAt: at, reference });
    expect(weak.discovery).toMatchObject({ status: "matched", locality: null, branch: { status: "candidate", locality: "Riverside", address: "Riverside Market Road" } });
    expect(weak.sources[0].context).toMatchObject({ scope: "unknown", locationEvidence: claim, temporalStatus: "unknown" });
    expect(weak.discovery.branch?.sourceIds).toEqual([weak.sources[0].id]);
    const strong = extractDiscoveryResponse(envelope(`${claim} Coordinates: 17.4, 78.3.`), business, { discoveredAt: at, reference });
    expect(strong.discovery).toMatchObject({ status: "matched", locality: "Riverside", branch: { status: "matched" } });
    expect(strong.sources.every((source) => source.context?.scope === "exact_location" && source.text.includes(source.context.locationEvidence!))).toBe(true);
    const viewOnly = extractDiscoveryResponse(envelope(`${claim} Coordinates: 17.4, 78.3.`), business, { discoveredAt: at, reference: { ...reference, coordinatesHint: { latitude: 17.4, longitude: 78.3, kind: "map_view" } } });
    expect(viewOnly.discovery.branch?.status).toBe("candidate");
    const nearby = extractDiscoveryResponse(envelope(`${claim} Coordinates: 17.412, 78.3.`), business, { discoveredAt: at, reference });
    expect(nearby.discovery.branch?.status).toBe("candidate");
  });

  test("does not use a multi-location brand bio or guessed coordinates to resolve the target branch", () => {
    const value = { ...candidate, locality: "Riverside", facts: [{ subject: "business", sourceUrl: url, claim: "Orchard Bakehouse operates in Riverside and Hilltop." }], branch: {
      status: "matched", label: "Orchard Bakehouse Riverside", locality: "Riverside", address: null, sourceUrls: [url], rationale: "The model guessed Riverside from the supplied coordinates.",
    } };
    const result = extractDiscoveryResponse(response(value), business, { discoveredAt: at });
    expect(result.discovery).toMatchObject({ status: "matched", locality: null, branch: { status: "unresolved", locality: null, sourceIds: [] } });
    expect(result.sources[0].context?.scope).toBe("brand");
    const profile = extractDiscoveryResponse(response(value), { ...business, website: url }, { discoveredAt: at });
    expect(profile.discovery.branch?.status).toBe("unresolved");
  });

  test("treats old article dates and explicit past festive years as historical without inventing publication dates", () => {
    const cases = [
      { sourceUrl: "https://publication.example.com/2019/Nov/07/orchard-menu.html", snippet: "Orchard Bakehouse describes a festive hamper selection.", status: "historical" },
      { sourceUrl: url, snippet: "Orchard Bakehouse promoted a hamper collection for Diwali 2025.", status: "historical" },
      { sourceUrl: "https://publication.example.com/2026/Nov/01/orchard-menu.html", snippet: "Orchard Bakehouse describes a festive hamper selection.", status: "unknown" },
      { sourceUrl: "https://publication.example.com/2027/Nov/01/orchard-menu.html", snippet: "Orchard Bakehouse describes a festive hamper selection.", status: "unknown" },
    ];
    for (const fixture of cases) {
      const envelope = response(null, { rawText: "No additional supported claims.", snippet: fixture.snippet });
      envelope.output[0].results![0].url = fixture.sourceUrl;
      const result = extractDiscoveryResponse(envelope, business, { discoveredAt: at });
      expect(result.sources).toHaveLength(1);
      expect(result.sources[0].context).toMatchObject({ temporalStatus: fixture.status, publishedAt: null, validFrom: null, validThrough: null, dateEvidence: null });
    }
  });

  test("rejects invented URL paths, unsupported locality and competitor conflation", () => {
    const result = extractDiscoveryResponse(response({ ...candidate, locality: "Invented city", facts: [
      ...candidate.facts,
      { subject: "business", claim: "The business is in Invented city.", sourceUrl: `${url}invented` },
      { subject: "business", claim: "The business has 625 followers and was founded in 1975.", sourceUrl: url },
    ] }), business, { discoveredAt: at });
    expect(result.sources).toHaveLength(1);
    expect(result.discovery.locality).toBeNull();
    const conflict = extractDiscoveryResponse(response({ ...candidate, facts: [...candidate.facts, { subject: "competitor", claim: "A competitor supplies these same family recipes.", sourceUrl: url }] }), business, { discoveredAt: at });
    expect(conflict.sources).toEqual([]);
    expect(conflict.discovery.status).not.toBe("matched");
  });

  test("requires a matching identity source and a completed retrieval", () => {
    const mismatch = extractDiscoveryResponse(response({ ...candidate, name: "Different Business" }), business, { discoveredAt: at });
    expect(mismatch.discovery.name).toBeNull();
    expect(mismatch.sources).toEqual([]);
    const failed = extractDiscoveryResponse(response(candidate, { searchStatus: "failed" }), business, { discoveredAt: at });
    expect(failed.sources).toEqual([]);
    expect(failed.discovery.completedToolCalls).toBe(0);
    expect(failed.discovery.status).toBe("unresolved");
  });

  test("distinguishes actual snippets from generated summaries and ignores uncited prose", () => {
    const result = extractDiscoveryResponse(response(null, { rawText: "This bakery has the best pastries, according to search-results://query?bakery", snippet: "Orchard Bakehouse: family recipe loaves baked in our shop." }), business, { discoveredAt: at });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ acquisition: "meta_search_snippet", citation: { method: "search_snippet" } });
    expect(result.sources[0].text).not.toContain("best pastries");
    expect(result.discovery.status).toBe("ambiguous");
  });

  test("does not attribute another profile or listing's snippets and links to the supplied business", () => {
    for (const [inputUrl, relatedUrl, unrelatedUrl] of [
      ["https://instagram.com/fixtureorchard", url, "https://www.instagram.com/otherclinic/"],
      ["https://directory.example.com/business/orchard", "https://directory.example.com/business/orchard", "https://directory.example.com/business/otherclinic"],
    ]) {
      const envelope = response(null, { rawText: "No attributed business findings were returned." });
      const search = envelope.output[0];
      if (!search.results) throw new Error("Fixture must contain a search result.");
      search.results = [
        { type: "text_result", title: "Profile page", url: relatedUrl, snippet: "This supplied profile describes family-recipe baking." },
        { type: "text_result", title: "OtherClinic", url: unrelatedUrl, snippet: "OtherClinic offers dental implants and cosmetic dentistry." },
      ];
      const result = extractDiscoveryResponse(envelope, { ...business, name: "", website: inputUrl }, { discoveredAt: at });
      expect(result.sources.map((source) => source.url)).toEqual([relatedUrl]);
      expect(result.discovery.links.map((link) => link.url)).toEqual([relatedUrl]);
      expect(result.discovery.summary).not.toContain("dental implants");
    }
  });

  test("accepts provider spans only against actual retrieved URLs and valid character offsets", () => {
    const text = "Name: Orchard Bakehouse\nCategory: bakery\nStory: The business describes its family recipes.";
    const lines = text.split("\n");
    let offset = 0;
    const annotations = lines.map((line) => { const result = { type: "url_citation", url, title: "Orchard profile", start_index: offset, end_index: offset + line.length }; offset += line.length + 1; return result; });
    const result = extractDiscoveryResponse(response(null, { rawText: text, annotations }), business, { discoveredAt: at });
    expect(result.discovery).toMatchObject({ status: "matched", name: "Orchard Bakehouse", vertical: "bakery", locality: null });
    expect(result.sources.every((source) => source.citation?.method === "provider_annotation")).toBe(true);
    const rejected = extractDiscoveryResponse(response(null, { rawText: text, annotations: [
      { type: "url_citation", url: "https://invented.example.com/", start_index: 0, end_index: 20 },
      { type: "url_citation", url, start_index: -1, end_index: 1000 },
    ] }), business, { discoveredAt: at });
    expect(rejected.sources).toEqual([]);
  });

  test("a link-derived name hint drives exactly one bounded Meta request", async () => {
    const requestJson = vi.fn().mockResolvedValue(response());
    const resolveReference = vi.fn().mockResolvedValue({ inputUrl: business.website, resolvedUrl: "https://www.google.com/maps/place/Orchard+Bakehouse/", nameHint: "Orchard Bakehouse", coordinatesHint: { latitude: 17.4, longitude: 78.3, kind: "place" }, placeIdHint: "ChIJ_fixturePlace", featureIdHint: null, contextHint: "Orchard Bakehouse", warnings: [] });
    const result = await discoverBusiness({ ...business, name: "" }, { client: { requestJson }, resolveReference, now: () => new Date(at) });
    expect(resolveReference).toHaveBeenCalledWith(business.website);
    expect(requestJson).toHaveBeenCalledTimes(1);
    const request = requestJson.mock.calls[0][1];
    expect(request.body).toMatchObject({ max_tool_calls: 5, max_output_tokens: 5000, store: false, tools: [{ type: "web_search", search_context_size: "medium" }] });
    expect(JSON.parse(request.body.input)).toMatchObject({ currentDate: "2026-11-01", nameHint: "Orchard Bakehouse", suppliedLink: business.website, routingHints: { coordinates: { latitude: 17.4, longitude: 78.3, kind: "place" }, placeId: "ChIJ_fixturePlace", provenance: "unverified_url_routing" } });
    expect(result.discovery.reference?.coordinatesHint?.kind).toBe("place");
    expect(result.discovery.inputUrl).toBe(business.website);
    expect(result.discovery.status).toBe("matched");
    requestJson.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(discoverBusiness(business, { client: { requestJson }, resolveReference })).rejects.toThrow("Provider unavailable");
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  test("passes Google share-link routing to Spark as unverified hints and treats it as a listing", async () => {
    const shareLink = "https://share.google/FVjbnawViHJw2GdDg";
    const located = { ...candidate, locality: "Riverside", facts: [{ subject: "business", claim: "Orchard Bakehouse is located in Riverside.", sourceUrl: url }] };
    const requestJson = vi.fn().mockResolvedValue(response(located, { snippet: "Orchard Bakehouse is located in Riverside." }));
    const resolveReference = vi.fn().mockResolvedValue({ inputUrl: shareLink, resolvedUrl: "https://www.google.com/search?q=Orchard+Bakehouse+%7C+Riverside&kgmid=%2Fg%2F11fixture", nameHint: "Orchard Bakehouse", coordinatesHint: null, placeIdHint: "/g/11fixture", featureIdHint: null, contextHint: "Riverside", warnings: [] });
    const result = await discoverBusiness({ ...business, name: "", website: shareLink }, { client: { requestJson }, resolveReference, now: () => new Date(at) });
    const request = requestJson.mock.calls[0][1];
    expect(request.body.instructions).toContain("Google share links (share.google)");
    expect(request.body.instructions).toContain("unverified search hints; do not fetch Maps, Google share or Google search pages");
    expect(JSON.parse(request.body.input)).toMatchObject({ suppliedLink: shareLink, nameHint: "Orchard Bakehouse", localityHint: null, routingHints: { placeId: "/g/11fixture", context: "Riverside", coordinates: null, provenance: "unverified_url_routing" } });
    // An unmatched branch keeps the listing's locality unresolved, as for Maps links; a plain website keeps the supported brand locality.
    expect(result.discovery).toMatchObject({ locality: null, branch: { status: "unresolved" } });
    const website = await discoverBusiness({ ...business, website: "https://orchard.example.com/" }, { client: { requestJson }, resolveReference: vi.fn().mockResolvedValue({ inputUrl: "https://orchard.example.com/", resolvedUrl: "https://orchard.example.com/", nameHint: null, coordinatesHint: null, placeIdHint: null, featureIdHint: null, contextHint: null, warnings: [] }), now: () => new Date(at) });
    expect(website.discovery.locality).toBe("Riverside");
  });
});
