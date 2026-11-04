import { describe, expect, test, vi } from "vitest";
import { enrichBusiness, extractEnrichmentResponse } from "../../lib/research/enrich";
import { assertSourceContext, isCurrentOfferSource, isCurrentSource } from "../../lib/research/grounding";
import type { BusinessDiscovery, CollectedSource, SourceContext } from "../../lib/research/contracts";

const at = "2026-11-02T12:00:00.000Z";
const website = "https://orchard.example.org/";
const menuUrl = `${website}riverside/menu`;
const branchUrl = `${website}locations/riverside`;
const business = { id: "orchard", name: "Orchard Bakehouse", locality: "Riverside", vertical: "bakery" as const, goal: "Increase local preorders", website };
const unknownContext: SourceContext = { scope: "brand", location: null, locationEvidence: null, publishedAt: null, validFrom: null, validThrough: null, temporalStatus: "unknown", dateEvidence: null };
const branchExcerpt = "Orchard Bakehouse Riverside at 18 Market Road, Riverside.";
const anchor: CollectedSource = { id: "branch-source", kind: "business_coverage", title: "Orchard Bakehouse Riverside", url: branchUrl, text: branchExcerpt, retrievedAt: at, acquisition: "meta_search_snippet", citation: { responseId: "earlier", searchCallIds: ["earlier-search"], url: branchUrl, title: "Orchard Bakehouse Riverside", method: "search_snippet" }, context: { ...unknownContext, scope: "exact_location", location: "Riverside", locationEvidence: branchExcerpt } };
const discovery: BusinessDiscovery = { status: "matched", inputUrl: website, name: business.name, locality: "Riverside", vertical: "bakery", officialWebsite: website, instagramUrl: null, summary: "Fixture", sourceIds: [anchor.id], warnings: [], queries: [], completedToolCalls: 1, discoveredAt: at, links: [], branch: { status: "matched", label: "Orchard Bakehouse Riverside", locality: "Riverside", address: "18 Market Road, Riverside", sourceIds: [anchor.id], rationale: "Original source identifies the branch." } };
const input = { business, discovery, sources: [anchor] };
const offering = { name: "Cinnamon scroll", description: "Orchard Bakehouse reports a cinnamon scroll.", sourceUrl: menuUrl, identitySupport: "The source names Orchard Bakehouse.", context: unknownContext };
const base = { businessName: business.name, offerings: [offering], brandSignals: [], insights: [], researchPlan: ["Resolve the supplied branch, then follow relevant menu and local feedback gaps."], unknowns: [] };
type Hit = { url: string; title?: string; snippet?: string };
function envelope(model: unknown = base, hits: Hit[] = [{ url: menuUrl, title: "Orchard Bakehouse menu", snippet: offering.description }]) {
  return { id: "deep-research-fixture", status: "completed", usage: { input_tokens: 120, output_tokens: 80 }, output: [
    { id: "native-search", type: "web_search_call", status: "completed", action: { type: "search", queries: ["Orchard Bakehouse Riverside location", "follow-up from a menu finding"] }, results: hits.map((hit) => ({ type: "text_result", title: "Retrieved source", snippet: "", ...hit })) },
    { type: "message", content: [{ type: "output_text", text: JSON.stringify(model), annotations: [] }] },
  ] };
}
function extract(model: unknown, hits?: Hit[], customInput = input) { return extractEnrichmentResponse(envelope(model, hits), customInput, { enrichedAt: at }); }
function exactContext(extra: Partial<SourceContext> = {}): SourceContext { return { ...unknownContext, scope: "exact_location", location: "Riverside", locationEvidence: branchExcerpt, ...extra }; }
function insight(kind: "customer" | "competitor" | "seasonal" | "content" | "operations", subjectName = business.name, sourceUrl = menuUrl) { return { kind, subjectName, sourceUrl, claim: `${subjectName} has an attributable research observation.`, implication: "Test whether this observation matters locally; no outcome is established.", identitySupport: `The source names ${subjectName}.`, context: unknownContext }; }

 describe("location and time grounded deep investigation", () => {
  test("retains original location/date anchors alongside a summary without relabeling it as an original quote", () => {
    const dateExcerpt = "Published 1 November 2026.";
    const result = extract({ ...base, offerings: [{ ...offering, context: exactContext({ publishedAt: "2026-11-01", temporalStatus: "current", dateEvidence: dateExcerpt }) }] }, [{ url: menuUrl, title: "Orchard Bakehouse menu", snippet: `${branchExcerpt} ${dateExcerpt} Cinnamon scroll is listed.` }]);
    expect(result.enrichment.branch?.status).toBe("matched");
    expect(result.enrichment.sourceIds).toContain(anchor.id);
    expect(result.enrichment.coverage?.find((item) => item.area === "identity")?.sourceIds).toEqual([anchor.id]);
    expect(result.sources[0]).toMatchObject({ acquisition: "meta_cited_summary", context: { scope: "exact_location", publishedAt: "2026-11-01", temporalStatus: "current" } });
    expect(result.sources[0].text).toContain(branchExcerpt);
    expect(result.sources[0].text).toContain(dateExcerpt);
    expect(() => assertSourceContext(result.sources[0])).not.toThrow();
    expect(isCurrentOfferSource(result.sources[0], "2026-11-02")).toBe(false);
  });

  test("another shop of the same brand stays excluded even when the model calls it exact", () => {
    const locationEvidence = "Orchard Bakehouse Old Town at 45 Hill Road, Old Town.";
    const result = extract({ ...base, offerings: [{ ...offering, context: { ...unknownContext, scope: "exact_location", location: "Old Town", locationEvidence } }] }, [{ url: menuUrl, title: "Orchard Bakehouse Old Town", snippet: `${offering.description} ${locationEvidence}` }]);
    expect(result.sources[0].context?.scope).toBe("other_location");
    expect(isCurrentSource(result.sources[0], "2026-11-02")).toBe(false);
  });

  test("a generic chain profile cannot establish a branch from model identity assurances", () => {
    const unanchored = { ...input, discovery: { ...discovery, branch: undefined }, sources: [] };
    const result = extract({ ...base, branch: { status: "matched", label: "Orchard Bakehouse Riverside", locality: "Riverside", address: "18 Market Road, Riverside", sourceUrl: website, identitySupport: branchExcerpt, rationale: "The model believes this branch is the input location." }, offerings: [{ ...offering, context: exactContext() }] }, [{ url: website, title: business.name, snippet: "Our bakeries serve Riverside and Old Town." }, { url: menuUrl, title: business.name, snippet: offering.description }], unanchored);
    expect(result.enrichment.branch?.status).toBe("unresolved");
    expect(result.sources.find((source) => source.url === menuUrl)?.context?.scope).toBe("unknown");
  });

  test("a dedicated but unverified branch association is candidate, with no exact-location source upgrade", () => {
    const unanchored = { ...input, discovery: { ...discovery, branch: undefined }, sources: [] };
    const result = extract({ ...base, branch: { status: "candidate", label: "Orchard Bakehouse Riverside", locality: "Riverside", address: "18 Market Road, Riverside", sourceUrl: branchUrl, identitySupport: branchExcerpt, rationale: "The candidate agrees with the supplied Riverside locality." } }, [{ url: branchUrl, title: "Orchard Bakehouse Riverside", snippet: "" }, { url: menuUrl, title: business.name, snippet: offering.description }], unanchored);
    expect(result.enrichment.branch).toMatchObject({ status: "candidate", locality: "Riverside" });
    expect(result.sources.find((source) => source.url === branchUrl)).toMatchObject({ acquisition: "meta_cited_summary", context: { scope: "unknown", location: null } });
    expect(result.enrichment.offerings).toHaveLength(1);
  });

  test("a matched-looking branch cannot override a supplied place pin without correspondence", () => {
    const unanchored = { ...input, discovery: { ...discovery, branch: undefined, reference: { inputUrl: "https://maps.app.goo.gl/fixture", resolvedUrl: "https://www.google.com/maps/place/Orchard/", nameHint: business.name, warnings: [], coordinatesHint: { latitude: 17.1, longitude: 78.2, kind: "place" as const } } }, sources: [] };
    const result = extract({ ...base, branch: { status: "matched", label: "Orchard Bakehouse Riverside", locality: "Riverside", address: "18 Market Road, Riverside", sourceUrl: branchUrl, identitySupport: branchExcerpt, rationale: "Likely Riverside candidate." } }, [{ url: branchUrl, title: business.name, snippet: branchExcerpt }, { url: menuUrl, title: business.name, snippet: offering.description }], unanchored);
    expect(result.enrichment.branch?.status).not.toBe("matched");
  });

  test("a place ID still requires target correspondence when coordinates are absent", () => {
    const unanchored = { ...input, discovery: { ...discovery, branch: undefined, reference: { inputUrl: "https://maps.app.goo.gl/fixture", resolvedUrl: "https://www.google.com/maps/place/Orchard/", nameHint: business.name, warnings: [], coordinatesHint: null, placeIdHint: "ChIJ_targetBranch" } }, sources: [] };
    const result = extract({ ...base, branch: { status: "matched", label: "Orchard Bakehouse Riverside", locality: "Riverside", address: "18 Market Road, Riverside", sourceUrl: branchUrl, identitySupport: branchExcerpt, rationale: "Likely Riverside candidate." } }, [{ url: branchUrl, title: business.name, snippet: branchExcerpt }, { url: menuUrl, title: business.name, snippet: offering.description }], unanchored);
    expect(result.enrichment.branch?.status).not.toBe("matched");
  });

  test("stronger pin or place-ID evidence can correct an unconfirmed earlier branch candidate", () => {
    const oldText = "Orchard Bakehouse Old Town branch is at Hill Road, Old Town.";
    const oldSource: CollectedSource = { ...anchor, text: oldText, context: { ...unknownContext, scope: "unknown", location: "Old Town", locationEvidence: oldText } };
    for (const pin of [true, false]) {
      const target = { business: { ...business, locality: "" }, discovery: { ...discovery, locality: null,
        branch: { status: "candidate" as const, label: "Orchard Bakehouse Old Town", locality: "Old Town", address: "Hill Road, Old Town", sourceIds: [oldSource.id], rationale: "Earlier unverified association." },
        reference: { inputUrl: "https://maps.app.goo.gl/fixture", resolvedUrl: "https://www.google.com/maps/place/Orchard/", nameHint: business.name, warnings: [],
          coordinatesHint: pin ? { latitude: 17.1, longitude: 78.2, kind: "place" as const } : null, placeIdHint: pin ? null : "ChIJ_fixtureTarget" },
      }, sources: [oldSource] };
      const identitySupport = `${branchExcerpt} ${pin ? "Coordinates: 17.1, 78.2." : "Linked place identifier ChIJ_fixtureTarget."}`;
      const model = { ...base, branch: { status: "matched", label: "Orchard Bakehouse Riverside", locality: "Riverside", address: "18 Market Road, Riverside", sourceUrl: branchUrl, identitySupport, rationale: "The source corresponds directly to the supplied routing target." }, offerings: [{ ...offering, context: exactContext() }] };
      const hits = [{ url: branchUrl, title: business.name, snippet: identitySupport }, { url: menuUrl, title: business.name, snippet: `${branchExcerpt} ${offering.description}` }];
      const result = extract(model, hits, target);
      expect(result.enrichment.branch).toMatchObject({ status: "matched", locality: "Riverside" });
      expect(result.sources.find((source) => source.url === menuUrl)?.context?.scope).toBe("exact_location");
      expect(oldSource.context?.scope).toBe("unknown");
      expect(target.discovery.branch.locality).toBe("Old Town");
      const explicitLocality = extract(model, hits, { ...target, business: { ...target.business, locality: "Old Town" } });
      expect(explicitLocality.enrichment.branch).toMatchObject({ status: "candidate", locality: "Old Town" });
      expect(explicitLocality.sources.find((source) => source.url === menuUrl)?.context?.scope).toBe("other_location");
    }
  });

  test("an unconfirmed candidate does not label a different reported location as other_location", () => {
    const target = { ...input, business: { ...business, locality: "" }, discovery: { ...discovery, locality: null, branch: { ...discovery.branch!, status: "candidate" as const } } };
    const locationEvidence = "Orchard Bakehouse Old Town describes a cinnamon scroll.";
    const result = extract({ ...base, offerings: [{ ...offering, context: { ...unknownContext, scope: "exact_location", location: "Old Town", locationEvidence } }] }, [{ url: menuUrl, title: business.name, snippet: `${offering.description} ${locationEvidence}` }], target);
    expect(result.enrichment.branch?.status).toBe("candidate");
    expect(result.sources[0].context?.scope).toBe("unknown");
  });

  test("a city-only anchor cannot turn another neighbourhood's menu into the confirmed branch's offering", () => {
    const locality = "Financial District, Hyderabad";
    const confirmed = { ...anchor, text: `Orchard Bakehouse ${locality}.`, context: { ...anchor.context!, location: locality, locationEvidence: `Orchard Bakehouse ${locality}.` } };
    const target = { ...input, business: { ...business, locality }, discovery: { ...discovery, locality, branch: { ...discovery.branch!, locality, label: `Orchard Bakehouse ${locality}`, address: null } }, sources: [confirmed] };
    const result = extract({ ...base, offerings: [{ ...offering, context: { ...unknownContext, scope: "exact_location", location: "Hyderabad", locationEvidence: "Hyderabad" } }] }, [{ url: menuUrl, title: "Orchard Bakehouse Jubilee Hills", snippet: "Orchard Bakehouse Jubilee Hills, Hyderabad reports a cinnamon scroll." }], target);
    expect(result.enrichment.offerings).toHaveLength(0);
    expect(result.enrichment.warnings.join(" ")).toContain("city-only or ambiguous location evidence");
  });

  test("customer and competitor insights bind to their actual source role and the competitor's own name", () => {
    const customer = { ...insight("customer"), claim: "Orchard Bakehouse customers mention a slow pickup queue.", context: exactContext() };
    const competitor = { ...insight("competitor", "River Flour", "https://riverflour.example.org/menu"), claim: "River Flour advertises a preorder pickup option.", context: { ...unknownContext, scope: "exact_location" as const, location: "Riverside", locationEvidence: "River Flour serves Riverside." } };
    const wrong = { ...competitor, subjectName: "Unrelated Clinic" };
    const result = extract({ ...base, insights: [customer, competitor, wrong] }, [
      { url: menuUrl, title: business.name, snippet: `${branchExcerpt} ${customer.claim}` },
      { url: competitor.sourceUrl, title: "River Flour menu", snippet: `River Flour serves Riverside. ${competitor.claim}` },
    ]);
    expect(result.enrichment.insights?.map((item) => item.kind)).toEqual(["customer", "competitor"]);
    expect(result.sources.find((source) => source.url === competitor.sourceUrl)).toMatchObject({ kind: "competitor", context: { scope: "exact_location" } });
    expect(result.sources.find((source) => source.kind === "customer_review")?.text).toContain("pickup queue");
    expect(result.enrichment.coverage?.find((item) => item.area === "competitor")?.status).toBe("found");
  });

  test("old dated URLs with empty snippets remain historical without inventing verified dates", () => {
    const url = `${website}2022/11/festive-scrolls`;
    const result = extract({ ...base, offerings: [{ ...offering, sourceUrl: url, context: { ...unknownContext, publishedAt: "2026-11-01", temporalStatus: "current", dateEvidence: "Published 1 November 2026." } }] }, [{ url, title: "Orchard Bakehouse festive scrolls", snippet: "" }]);
    expect(result.sources[0].context).toMatchObject({ temporalStatus: "historical", publishedAt: null, validFrom: null, validThrough: null, dateEvidence: null });
    expect(isCurrentSource(result.sources[0], "2026-11-02")).toBe(false);
    expect(result.enrichment.warnings.join(" ")).toContain("exact publication dates remain unverified");
  });

  test("past-year promotional source text excludes an undated URL even if the model omits dates", () => {
    const result = extract(base, [{ url: menuUrl, title: business.name, snippet: `${offering.description} Orchard Bakehouse offered the item for Diwali 2025.` }]);
    expect(result.sources[0].context).toMatchObject({ temporalStatus: "historical", publishedAt: null, validFrom: null, validThrough: null });
    expect(isCurrentSource(result.sources[0], "2026-11-02")).toBe(false);
    expect(() => assertSourceContext(result.sources[0])).not.toThrow();
  });

  test("actually opened official subpages retain weak attributed findings when native source text is absent", () => {
    const response = envelope({ ...base, offerings: [{ ...offering, context: exactContext({ publishedAt: "2026-11-01", temporalStatus: "current", dateEvidence: "Published 1 November 2026." }) }] }, []);
    const result = extractEnrichmentResponse({ ...response, output: [...response.output, { id: "native-open", type: "web_search_call", status: "completed", action: { type: "open_page", url: menuUrl } }] }, input, { enrichedAt: at });
    expect(result.enrichment.offerings).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ acquisition: "meta_cited_summary", citation: { method: "model_reference" }, context: { scope: "unknown", location: null, publishedAt: null, temporalStatus: "unknown" } });
  });

  test("opened competitor sites may retain clearly attributed model-reported signals without original snippets", () => {
    const competitor = insight("competitor", "River Flour", "https://riverflour.example.org/menu");
    const response = envelope({ ...base, insights: [competitor] });
    const result = extractEnrichmentResponse({ ...response, output: [...response.output, { id: "native-competitor-open", type: "web_search_call", status: "completed", action: { type: "open_page", url: competitor.sourceUrl } }] }, input, { enrichedAt: at });
    expect(result.enrichment.insights).toHaveLength(1);
    expect(result.sources.find((source) => source.kind === "competitor")).toMatchObject({ acquisition: "meta_cited_summary", citation: { method: "model_reference" }, context: { temporalStatus: "unknown" } });
  });

  test("conservative historical and other-branch exclusions survive absent original anchors", () => {
    const result = extract({ ...base, offerings: [{ ...offering, context: { ...unknownContext, scope: "other_location", location: "Old Town", locationEvidence: "Unverified location assertion.", temporalStatus: "historical", publishedAt: "2019-05-01", dateEvidence: "Unverified publication assertion." } }] }, [{ url: menuUrl, title: business.name, snippet: "" }]);
    expect(result.sources[0].context).toMatchObject({ scope: "other_location", temporalStatus: "historical", location: null, publishedAt: null });
    expect(isCurrentSource(result.sources[0], "2026-11-02")).toBe(false);
  });

  test("expired seasonal windows remain inspectable but cannot ground a current campaign", () => {
    const dateEvidence = "Valid from 2023-10-01 through 2023-11-15.";
    const seasonal = { ...insight("seasonal"), context: exactContext({ validFrom: "2023-10-01", validThrough: "2023-11-15", temporalStatus: "current", dateEvidence }) };
    const result = extract({ ...base, insights: [seasonal] }, [{ url: menuUrl, title: business.name, snippet: `${branchExcerpt} ${dateEvidence} ${seasonal.claim}` }]);
    const source = result.sources.find((item) => item.id === result.enrichment.insights![0].sourceIds[0])!;
    expect(source.context?.temporalStatus).toBe("historical");
    expect(isCurrentSource(source, "2026-11-02")).toBe(false);
    expect(result.enrichment.coverage?.find((item) => item.area === "seasonal")?.status).toBe("limited");
  });

  test("a fully supported active window retains dates and exact original source anchors", () => {
    const dateEvidence = "Valid from 2026-11-01 through 2026-11-10.";
    const seasonal = { ...insight("seasonal"), context: exactContext({ validFrom: "2026-11-01", validThrough: "2026-11-10", temporalStatus: "current", dateEvidence }) };
    const result = extract({ ...base, insights: [seasonal] }, [{ url: menuUrl, title: business.name, snippet: `${branchExcerpt} ${dateEvidence} ${seasonal.claim}` }]);
    const source = result.sources.find((item) => item.id === result.enrichment.insights![0].sourceIds[0])!;
    expect(() => assertSourceContext(source)).not.toThrow();
    expect(isCurrentOfferSource(source, "2026-11-02")).toBe(true);
  });

  test("future publications, invalid calendars and inverted windows cannot manufacture current status", () => {
    for (const proposed of [
      { publishedAt: "2027-01-01", dateEvidence: "Published 2027-01-01." },
      { publishedAt: "2026-02-30", dateEvidence: "Published 2026-02-30." },
      { validFrom: "2026-11-10", validThrough: "2026-11-01", dateEvidence: "Valid from 2026-11-10 through 2026-11-01." },
    ]) {
      const result = extract({ ...base, offerings: [{ ...offering, context: { ...unknownContext, temporalStatus: "current", ...proposed } }] }, [{ url: menuUrl, title: business.name, snippet: `${offering.description} ${proposed.dateEvidence}` }]);
      expect(result.sources[0].context).toMatchObject({ publishedAt: null, validFrom: null, validThrough: null, temporalStatus: "unknown" });
      expect(() => assertSourceContext(result.sources[0])).not.toThrow();
    }
  });

  test("bounds sources at twenty-four and keeps references/coverage attached to retained records", () => {
    const insights = "ABCDEFGHIJKLMNOP".split("").map((letter) => ({ ...insight("operations"), claim: `Orchard Bakehouse reports operational observation ${letter}.` }));
    const offerings = "ABCDEFGHIJ".split("").map((letter) => ({ ...offering, name: `Named item ${letter}`, description: `Orchard Bakehouse reports named offering ${letter}.` }));
    const result = extract({ ...base, insights, offerings });
    expect(result.sources).toHaveLength(24);
    const ids = new Set([anchor.id, ...result.sources.map((source) => source.id)]);
    expect(result.enrichment.sourceIds.every((id) => ids.has(id))).toBe(true);
    expect([...(result.enrichment.insights ?? []), ...result.enrichment.offerings].every((item) => item.sourceIds.every((id) => ids.has(id)))).toBe(true);
    expect(result.enrichment.coverage).toHaveLength(7);
  });

  test("sends current date, pin hints and category/goal in one adaptive ten-action request", async () => {
    const requestJson = vi.fn().mockResolvedValue(envelope());
    const reference = { inputUrl: "https://maps.app.goo.gl/fixture", resolvedUrl: "https://www.google.com/maps/place/Orchard/", nameHint: business.name, warnings: [], coordinatesHint: { latitude: 17.1, longitude: 78.2, kind: "place" as const }, featureIdHint: "fixture-feature" };
    await enrichBusiness({ ...input, discovery: { ...discovery, reference } }, { client: { requestJson }, now: () => new Date(at) });
    expect(requestJson).toHaveBeenCalledTimes(1);
    const body = requestJson.mock.calls[0][1].body;
    expect(body).toMatchObject({ max_tool_calls: 10, max_output_tokens: 8000, store: false });
    expect(JSON.parse(body.input)).toMatchObject({ currentDate: "2026-11-02", business: { locality: "Riverside", goal: business.goal }, discovery: { reference: { coordinatesHint: reference.coordinatesHint } } });
    expect(body.instructions).toContain("Plan adaptively");
    expect(body.instructions).toContain("FIRST disambiguate the exact shop");
    expect(body.instructions).toContain("nearby relevant competitors");
  });
});
