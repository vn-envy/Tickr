import { describe, expect, test, vi } from "vitest";
import { enrichBusiness, extractEnrichmentResponse } from "../../lib/research/enrich";
import type { BusinessDiscovery } from "../../lib/research/contracts";

const at = "2026-11-02T00:00:00.000Z";
const menuUrl = "https://orchard.example.com/menu";
const instagramUrl = "https://www.instagram.com/fixtureorchard/";
const business = { id: "fixture-business", name: "Orchard Bakehouse", locality: "Fixture locality", vertical: "bakery" as const, goal: "Promote a named product", website: "https://orchard.example.com/" };
const discovery: BusinessDiscovery = {
  status: "matched", inputUrl: business.website, name: business.name, locality: business.locality, vertical: "bakery",
  officialWebsite: business.website, instagramUrl, summary: "Synthetic discovery fixture.", sourceIds: [], warnings: [], queries: [], completedToolCalls: 1, discoveredAt: at,
  links: [{ url: instagramUrl, title: "Orchard Bakehouse profile", relationship: "business" }],
};
const input = { business, discovery, sources: [] };
const offering = { name: "Cinnamon scroll", description: "The menu names a cinnamon scroll baked in the shop.", sourceUrl: menuUrl, identitySupport: "The retrieved menu identifies Orchard Bakehouse." };
const brand = { kind: "story", claim: "The business describes a family-recipe approach to baking.", sourceUrl: instagramUrl };
const model = { businessName: business.name, offerings: [offering], brandSignals: [brand], unknowns: ["Current availability is unconfirmed."] };

function response(value: unknown = model, options: { completed?: boolean; snippet?: string } = {}) {
  return { id: "response-enrichment-fixture", status: "completed", usage: { input_tokens: 100, output_tokens: 50 }, output: [
    { id: "search-fixture", type: "web_search_call", status: options.completed === false ? "failed" : "completed", action: { type: "search", query: "Orchard Bakehouse menu" }, results: [
      { type: "text_result", title: "Orchard Bakehouse menu", url: menuUrl, snippet: options.snippet ?? `${offering.name}: ${offering.description}` },
      { type: "text_result", title: "Orchard Bakehouse profile", url: instagramUrl, snippet: "" },
      { type: "text_result", title: "OtherClinic", url: "https://www.instagram.com/otherclinic/", snippet: "OtherClinic offers dental implants." },
    ] },
    { type: "message", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] as unknown[] }] },
  ] };
}

describe("product and brand enrichment", () => {
  test("binds named offerings to returned source IDs and distinguishes original snippets from AI summaries", () => {
    const result = extractEnrichmentResponse(response(), input, { enrichedAt: at });
    expect(result.enrichment.status).toBe("enriched");
    expect(result.enrichment.offerings[0]).toMatchObject({ name: "Cinnamon scroll", description: offering.description });
    expect(result.sources.find((source) => source.id === result.enrichment.offerings[0].sourceIds[0])).toMatchObject({ acquisition: "meta_search_snippet", citation: { method: "search_snippet", url: menuUrl } });
    expect(result.sources.find((source) => source.id === result.enrichment.brandSignals[0].sourceIds[0])).toMatchObject({ acquisition: "meta_cited_summary", citation: { method: "model_reference", url: instagramUrl } });
    expect(result.enrichment.sourceIds).toEqual(result.sources.map((source) => source.id));
    expect(result.inputTokens).toBe(100);
  });

  test("rejects invented paths, unsupported numeric details and unrelated profiles on the same host", () => {
    const result = extractEnrichmentResponse(response({ ...model, offerings: [
      { ...offering, sourceUrl: `${menuUrl}/invented` },
      { ...offering, name: "Special cake", description: "The cake costs 250 rupees and serves 12 guests." },
      { ...offering, name: "Dental implants", description: "OtherClinic offers dental implants.", sourceUrl: "https://www.instagram.com/otherclinic/", identitySupport: "This belongs to Orchard Bakehouse, says the model." },
    ] }), input, { enrichedAt: at });
    expect(result.enrichment.offerings).toEqual([]);
    expect(result.enrichment.status).toBe("limited");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe(instagramUrl);
    expect(result.enrichment.warnings.join(" ")).toContain("source did not establish a relationship");
  });

  test("keeps missing products honest and rejects generic cuisines as named offerings", () => {
    const result = extractEnrichmentResponse(response({ ...model, offerings: [{ ...offering, name: "Desserts" }] }), input, { enrichedAt: at });
    expect(result.enrichment.status).toBe("limited");
    expect(result.enrichment.offerings).toEqual([]);
    expect(result.enrichment.brandSignals).toHaveLength(1);
    expect(result.enrichment.unknowns.join(" ")).toContain("No attributable named offerings");
  });

  test("does not transfer another business's offering or turn failed retrieval into evidence", () => {
    const mismatch = extractEnrichmentResponse(response({ ...model, businessName: "OtherClinic" }), input, { enrichedAt: at });
    expect(mismatch.enrichment.status).toBe("unavailable");
    expect(mismatch.sources).toEqual([]);
    const failed = extractEnrichmentResponse(response(model, { completed: false }), input, { enrichedAt: at });
    expect(failed.enrichment.completedToolCalls).toBe(0);
    expect(failed.enrichment.status).toBe("unavailable");
    expect(failed.inputTokens).toBe(100);
  });

  test("recognizes genuine provider annotations as summaries rather than original quotations", () => {
    const envelope = response(model, { snippet: "" });
    const content = envelope.output[1].content;
    if (!content) throw new Error("Fixture output missing.");
    const text = content[0].text;
    content[0].annotations = [{ type: "url_citation", url: menuUrl, title: "Orchard menu", start_index: 0, end_index: text.length }];
    const result = extractEnrichmentResponse(envelope, input, { enrichedAt: at });
    expect(result.sources.find((source) => source.url === menuUrl)).toMatchObject({ acquisition: "meta_cited_summary", citation: { method: "provider_annotation" } });
  });

  test("bounds new source records while keeping all retained offering references valid", () => {
    const many = { ...model,
      offerings: "ABCDEFGHIJ".split("").map((letter) => ({ ...offering, name: `Fixture item ${letter}`, description: `Orchard Bakehouse reports fixture offering ${letter} for this diagnostic.` })),
      brandSignals: "ABCDEFGHIJ".split("").map((letter) => ({ ...brand, claim: `The business reports synthetic brand detail ${letter} for this diagnostic.` })),
    };
    const result = extractEnrichmentResponse(response(many, { snippet: "" }), input, { enrichedAt: at });
    expect(result.sources).toHaveLength(20);
    const ids = new Set(result.sources.map((source) => source.id));
    expect([...result.enrichment.offerings, ...result.enrichment.brandSignals].every((item) => item.sourceIds.every((id) => ids.has(id)))).toBe(true);
  });

  test("runs one bounded Meta request after identity discovery and preserves real usage for limited results", async () => {
    const requestJson = vi.fn().mockResolvedValue(response({ ...model, offerings: [] }));
    const result = await enrichBusiness(input, { client: { requestJson }, now: () => new Date(at) });
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson.mock.calls[0][1].body).toMatchObject({ max_tool_calls: 10, max_output_tokens: 8000, store: false, tools: [{ type: "web_search", search_context_size: "high" }] });
    expect(result.enrichment.status).toBe("limited");
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });
    const unresolved = await enrichBusiness({ ...input, discovery: { ...discovery, status: "unresolved" } }, { client: { requestJson } });
    expect(unresolved.usage.model).toBe("not_called");
    expect(requestJson).toHaveBeenCalledTimes(1);
    requestJson.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(enrichBusiness(input, { client: { requestJson } })).rejects.toThrow("Provider unavailable");
    expect(requestJson).toHaveBeenCalledTimes(2);
  });
});
