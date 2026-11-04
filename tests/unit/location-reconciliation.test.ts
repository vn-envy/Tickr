import { describe, expect, test } from "vitest";
import { assertSourceContext, isCurrentSource, reconcileLocationScopes } from "../../lib/research/grounding";
import type { BranchIdentity, CollectedSource, SourceContext } from "../../lib/research/contracts";

const branch: BranchIdentity = { status: "matched", label: "Orchard North City", locality: "North City, Hyderabad", address: "Market Road, North City, Hyderabad", sourceIds: ["branch"], rationale: "Retrieved place pin and address agree." };
function source(location: string, scope: SourceContext["scope"] = "unknown", kind: CollectedSource["kind"] = "business_coverage"): CollectedSource {
  const text = `Orchard's offering is described at ${location}.`;
  return { id: "location-source", kind, title: "Orchard source", url: "https://orchard.example.com/menu", text, retrievedAt: "2026-11-02T00:00:00.000Z", acquisition: "meta_cited_summary",
    citation: { responseId: "response", searchCallIds: ["search"], url: "https://orchard.example.com/menu", title: "Orchard source", method: "model_reference" },
    context: { scope, location, locationEvidence: text, publishedAt: null, validFrom: null, validThrough: null, temporalStatus: "unknown", dateEvidence: null } };
}

describe("location reconciliation after branch research", () => {
  test("excludes retained disjoint branch records without changing immutable source artifacts", () => {
    for (const scope of ["unknown", "brand", "exact_location"] as const) {
      const previous = source("South City, Hyderabad", scope);
      const before = structuredClone(previous);
      const [derived] = reconcileLocationScopes([previous], branch);
      expect(derived.context?.scope).toBe("other_location");
      expect(isCurrentSource(derived)).toBe(false);
      expect(() => assertSourceContext(derived)).not.toThrow();
      expect(previous).toEqual(before);
      expect(derived).not.toBe(previous);
      expect(derived.context).not.toBe(previous.context);
      expect(derived.citation?.searchCallIds).not.toBe(previous.citation?.searchCallIds);
    }
  });

  test("broader city evidence cannot remain exact but is still reviewable", () => {
    const [exact, unknown, brandWide] = reconcileLocationScopes([source("Hyderabad", "exact_location"), source("Hyderabad"), source("Hyderabad", "brand")], branch);
    expect(exact.context?.scope).toBe("unknown");
    expect(unknown.context?.scope).toBe("unknown");
    expect(brandWide.context?.scope).toBe("brand");
    expect([exact, unknown, brandWide].every((item) => isCurrentSource(item))).toBe(true);
  });

  test("matching text is never automatically promoted from reported material to exact-location evidence", () => {
    const [same, specific, reported] = reconcileLocationScopes([source("North City, Hyderabad", "exact_location"), source("Market Road, North City, Hyderabad", "exact_location"), source("North City, Hyderabad")], branch);
    expect(same.context?.scope).toBe("exact_location");
    expect(specific.context?.scope).toBe("exact_location");
    expect(reported.context?.scope).toBe("unknown");
  });

  test("leaves competitors and unsupported location assertions alone while scoping reviews of other branches", () => {
    const competitor = source("Competitor Road, Hyderabad", "exact_location", "competitor");
    const customer = source("South City, Hyderabad", "unknown", "customer_review");
    const unanchored = source("South City, Hyderabad"); unanchored.context!.locationEvidence = "Text absent from the retained source.";
    const [otherShop, review, unknown] = reconcileLocationScopes([competitor, customer, unanchored], branch);
    expect(otherShop.context?.scope).toBe("exact_location");
    expect(review.context?.scope).toBe("other_location");
    expect(unknown.context?.scope).toBe("unknown");
  });

  test("a candidate or unresolved branch cannot reclassify competing location hypotheses", () => {
    for (const status of ["candidate", "unresolved"] as const) {
      const previous = source("South City, Hyderabad");
      const [derived] = reconcileLocationScopes([previous], { ...branch, status });
      expect(derived).toEqual(previous);
      expect(derived).not.toBe(previous);
    }
  });
});
