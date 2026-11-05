import { describe, expect, test, vi } from "vitest";
import { officialWebsiteFor } from "../../lib/autopilot/harvest";
import { prepareDiscoveryCheckpoint } from "../../lib/jobs/discovery";
import { collectSources } from "../../lib/research/collect-sources";
import { brandDomainMatchesName, discoverBusiness, discoveryBrandDomain, extractDiscoveryResponse } from "../../lib/research/discover";
import type { BusinessReference } from "../../lib/research/reference";

// Offline fixture modelled on the 4 Nov 2026 hosted incident: no Meta or network calls are made.
const mapsLink = "https://maps.app.goo.gl/nNy6iYx9r4GaU7YY8";
const site = "https://grandmadaphnes.com/";
const instagram = "https://www.instagram.com/grandmadaphnes/";
const listing = "https://www.zomato.com/hyderabad/grandma-daphnes-bakehouse-jubilee-hills";
const at = "2026-11-04T00:00:00.000Z";
const business = { id: "business", name: "", locality: "", vertical: "bakery" as const, goal: "Promote the bakehouse", website: mapsLink };
const reference: BusinessReference = {
  inputUrl: mapsLink, resolvedUrl: "https://www.google.com/maps/place/Grandma+Daphne's+Bakehouse/@17.43,78.40,17z", nameHint: "Grandma Daphne's Bakehouse",
  coordinatesHint: { latitude: 17.43, longitude: 78.4, kind: "map_view" }, placeIdHint: null, featureIdHint: null, contextHint: "Grandma Daphne's Bakehouse", warnings: [],
};
const siteFacts = [
  "Grandma Daphne's presents the tagline Come for the food, stay for the feeling.",
  "Grandma Daphne's describes a menu of British classics alongside curries.",
  "Grandma Daphne's describes its food as home-style comfort cooking.",
].map((claim) => ({ subject: "business" as const, claim, sourceUrl: site }));
const modelOutput = {
  name: "Grandma Daphne's Bakehouse", locality: null, vertical: "bakery", officialWebsite: null, instagram,
  identitySourceUrls: [listing, instagram],
  branch: { status: "unresolved", label: null, locality: null, address: null, sourceUrls: [], rationale: "The brand matched; the Hyderabad branch behind the link is not established." },
  facts: siteFacts,
  unknowns: ["Whether https://grandmadaphnes.com is the official site for the Hyderabad Bakehouse location"],
};
type Result = { title: string; url: string; snippet?: string };
const incidentResults: Result[] = [
  { title: "Home", url: site },
  { title: "Grandma Daphne's (@grandmadaphnes) • Instagram", url: instagram },
  { title: "Grandma Daphne's Bakehouse, Jubilee Hills, Hyderabad | Zomato", url: listing },
];
function envelope(value: unknown = modelOutput, results: Result[] = incidentResults) {
  return { id: "incident-response", status: "completed", output: [
    { id: "search-1", type: "web_search_call", status: "completed", action: { type: "search", query: "Grandma Daphne's Bakehouse Hyderabad" }, results: results.map((result) => ({ type: "text_result", snippet: "", ...result })) },
    { type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] },
  ] };
}
const extract = (value: unknown = modelOutput, results: Result[] = incidentResults) =>
  extractDiscoveryResponse(envelope(value, results), { ...business, name: "Grandma Daphne's Bakehouse" }, { discoveredAt: at, reference });
const brandWarning = (warnings: string[]) => warnings.find((warning) => warning.startsWith("Brand website "));

describe("brand website fallback in discovery", () => {
  test("incident: selects the matching retrieved brand site, keeps the branch unresolved and feeds the website reader and harvest", async () => {
    const requestJson = vi.fn().mockResolvedValue(envelope());
    const resolveReference = vi.fn().mockResolvedValue(reference);
    const result = await discoverBusiness(business, { client: { requestJson }, resolveReference, now: () => new Date(at) });
    const instructions: string = requestJson.mock.calls[0][1].body.instructions;
    expect(instructions).toContain("officialWebsite is the BRAND's own first-party website");
    expect(instructions).toContain("EVEN WHEN the exact branch is unresolved");
    expect(instructions).toContain("never inferred from the brand site");
    expect(instructions).toContain("Brand identity and exact branch identity are separate");

    expect(result.discovery).toMatchObject({ status: "matched", name: "Grandma Daphne's Bakehouse", officialWebsite: site, locality: null, branch: { status: "unresolved", sourceIds: [] } });
    expect(brandWarning(result.discovery.warnings)).toBe("Brand website https://grandmadaphnes.com/ was matched to the business name; it is the brand's site and does not confirm this branch.");
    expect(result.discovery.warnings[0]).toContain("exact location behind the supplied link remains unresolved");
    // Brand-site facts stay brand-level, not this branch's capability.
    expect(result.sources.filter((source) => source.url === site)).toHaveLength(3);
    expect(result.sources.every((source) => source.context?.scope === "brand")).toBe(true);

    const checkpoint = prepareDiscoveryCheckpoint(business, result);
    expect(checkpoint.resolvedBusiness.website).toBe(site);
    expect(checkpoint.resolvedBusiness.locality).toBe("");
    expect(officialWebsiteFor(business, [])).toBeNull();
    expect(officialWebsiteFor(checkpoint.resolvedBusiness, checkpoint.sources)).toBe(site);
    const readPage = vi.fn().mockResolvedValue({ url: site, title: "Home", text: "Grandma Daphne's. Come for the food, stay for the feeling.", retrievedAt: at });
    const collected = await collectSources(checkpoint.resolvedBusiness, { mode: "live", sources: [], readWebsite: true, discoverFromLink: true }, { readPage });
    expect(readPage).toHaveBeenCalledWith(site);
    expect(collected.sources).toMatchObject([{ kind: "official_website", url: site, acquisition: "direct_website" }]);
  });

  test("a model-supplied official website is kept without the fallback warning", () => {
    const result = extract({ ...modelOutput, officialWebsite: site, identitySourceUrls: [listing, site] });
    expect(result.discovery.officialWebsite).toBe(site);
    expect(brandWarning(result.discovery.warnings)).toBeUndefined();
  });

  test("keeps the retrieved www host as the brand site's origin root", () => {
    const www = "https://www.grandmadaphnes.com/menu";
    const result = extract({ ...modelOutput, facts: siteFacts.map((fact) => ({ ...fact, sourceUrl: www })) }, [...incidentResults.filter((item) => item.url !== site), { title: "Menu", url: www }]);
    expect(result.discovery.officialWebsite).toBe("https://www.grandmadaphnes.com/");
  });

  test("normalises names conservatively and rejects short or generic brand domains", () => {
    expect(brandDomainMatchesName("Grandma Daphne's Bakehouse", "grandmadaphnes")).toBe(true);
    expect(brandDomainMatchesName("Grandma Daphne’s Bake House", "grandmadaphnesbakery")).toBe(true);
    expect(brandDomainMatchesName("The Orchard & Rye Kitchen", "orchardrye")).toBe(true);
    expect(brandDomainMatchesName("The Bakery", "thebakery")).toBe(false);
    expect(brandDomainMatchesName("The Bake House Cafe", "thebakehouse")).toBe(false);
    expect(brandDomainMatchesName("Mira Bakery", "mira")).toBe(false);
    expect(brandDomainMatchesName("Kiko Cafe", "kiko")).toBe(false);
    expect(brandDomainMatchesName("Grandma Daphne's Bakehouse", "daphnesdishes")).toBe(false);
    expect(brandDomainMatchesName("Grandma Daphne's Bakehouse", "grandma")).toBe(false);
  });

  test("generic short name: The Bakery never selects thebakery.com", () => {
    const value = { ...modelOutput, name: "The Bakery", instagram: null, identitySourceUrls: ["https://thebakery.com/"], facts: [{ subject: "business", claim: "The Bakery describes fresh bread baked every morning.", sourceUrl: "https://thebakery.com/" }] };
    const result = extractDiscoveryResponse(envelope(value, [{ title: "The Bakery", url: "https://thebakery.com/" }]), { ...business, name: "The Bakery" }, { discoveredAt: at, reference });
    expect(result.discovery.officialWebsite).toBeNull();
    expect(brandWarning(result.discovery.warnings)).toBeUndefined();
  });

  test("never treats social, listing, review, delivery, link-in-bio, maps or hosted-blog hosts as the brand site", () => {
    for (const url of [
      "https://www.zomato.com/grandmadaphnes", "https://www.swiggy.com/grandmadaphnes", "https://www.justdial.com/grandmadaphnes", "https://www.tripadvisor.com/grandmadaphnes",
      "https://www.tripadvisor.in/grandmadaphnes", "https://www.facebook.com/grandmadaphnes", "https://www.instagram.com/grandmadaphnes/", "https://linktr.ee/grandmadaphnes",
      "https://grandmadaphnes.wixsite.com/home", "https://grandmadaphnes.blogspot.com/", "https://grandmadaphnes.wordpress.com/", "https://maps.app.goo.gl/nNy6iYx9r4GaU7YY8",
      "https://www.google.com/maps/place/Grandma+Daphnes", "https://shop.grandmadaphnes.com/",
    ]) expect(discoveryBrandDomain(url)).toBeNull();
    expect(discoveryBrandDomain("https://www.grandmadaphnes.com/menu")).toEqual({ host: "grandmadaphnes.com", label: "grandmadaphnes" });
    expect(discoveryBrandDomain("https://grandmadaphnes.co.in/")).toEqual({ host: "grandmadaphnes.co.in", label: "grandmadaphnes" });

    // Model output in the same shape as the incident, with every fact on a non-brand host.
    const hosts = [listing, "https://www.swiggy.com/restaurants/grandma-daphnes", "https://www.justdial.com/Hyderabad/Grandma-Daphnes", "https://linktr.ee/grandmadaphnes", "https://grandmadaphnes.wixsite.com/home", "https://grandmadaphnes.blogspot.com/"];
    const value = { ...modelOutput, facts: hosts.map((sourceUrl) => ({ subject: "business", claim: "Grandma Daphne's describes British classics and curries.", sourceUrl })) };
    const result = extract(value, [...incidentResults, ...hosts.slice(1).map((url) => ({ title: "Grandma Daphne's", url }))]);
    expect(result.discovery.name).toBe("Grandma Daphne's Bakehouse");
    expect(result.discovery.officialWebsite).toBeNull();
    expect(brandWarning(result.discovery.warnings)).toBeUndefined();
  });

  test("a retrieved domain that does not match the business name is not selected", () => {
    const other = "https://daphnesdishes.com/";
    const result = extract({ ...modelOutput, facts: siteFacts.map((fact) => ({ ...fact, sourceUrl: other })) }, [...incidentResults, { title: "Home", url: other }]);
    expect(result.sources.some((source) => source.url === other)).toBe(true);
    expect(result.discovery.officialWebsite).toBeNull();
  });

  test("a matching domain needs an accepted business fact from that host, not competitor or customer facts", () => {
    const competitor = extract({ ...modelOutput, facts: [{ subject: "competitor", claim: "A nearby bakery also offers British classics and curries.", sourceUrl: site }, { ...siteFacts[0], sourceUrl: instagram }] });
    expect(competitor.discovery.officialWebsite).toBeNull();
    const customer = extract({ ...modelOutput, facts: [{ subject: "customer", claim: "Customers describe the food as comforting and homely.", sourceUrl: site }, { ...siteFacts[0], sourceUrl: instagram }] });
    expect(customer.discovery.officialWebsite).toBeNull();
    const about = `${site}about`;
    const mixed = extract({ ...modelOutput, facts: [siteFacts[0], { subject: "competitor", claim: "A nearby bakery also offers British classics and curries.", sourceUrl: about }] }, [...incidentResults, { title: "About", url: about }]);
    expect(mixed.discovery.officialWebsite).toBeNull();
    // Retrieved but uncited is not enough.
    const uncited = extract({ ...modelOutput, facts: [{ ...siteFacts[0], sourceUrl: instagram }] });
    expect(uncited.discovery.officialWebsite).toBeNull();
    // A fact citing a URL that was not retrieved in this response is rejected, so it cannot qualify a host.
    const unretrieved = extract(modelOutput, incidentResults.filter((result) => result.url !== site));
    expect(unretrieved.discovery.officialWebsite).toBeNull();
  });

  test("no fallback without an accepted identity", () => {
    const result = extractDiscoveryResponse(envelope({ ...modelOutput, name: "Daphne's Dishes" }), { ...business, name: "Grandma Daphne's Bakehouse" }, { discoveredAt: at, reference });
    expect(result.discovery.name).toBeNull();
    expect(result.discovery.officialWebsite).toBeNull();
  });

  test("prefers the qualifying host with the most business facts and refuses a tie", () => {
    const second = "https://grandmadaphnes.co.in/";
    const results = [...incidentResults, { title: "Home", url: second }];
    const preferred = extract({ ...modelOutput, facts: [...siteFacts, { ...siteFacts[0], sourceUrl: second }] }, results);
    expect(preferred.discovery.officialWebsite).toBe(site);
    const tie = extract({ ...modelOutput, facts: [siteFacts[0], { ...siteFacts[1], sourceUrl: second }] }, results);
    expect(tie.discovery.officialWebsite).toBeNull();
    expect(brandWarning(tie.discovery.warnings)).toBeUndefined();
    expect(tie.discovery.warnings).toContain("Several retrieved websites matched the business name equally; no brand website was selected automatically.");
  });
});
