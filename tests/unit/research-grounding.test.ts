import { describe, expect, it } from "vitest";
import { isCampaignBusinessSource, isCurrentOfferSource, isCurrentSource, validSourceDate } from "../../lib/research/grounding";
import type { CollectedSource } from "../../lib/research/contracts";

const source = (): CollectedSource => ({
  id: "source", kind: "official_website", title: "Branch festive collection", url: "https://shop.example/festival", retrievedAt: "2026-11-02T00:00:00Z", acquisition: "direct_website",
  text: "Our Riverside branch. Available November 1–8, 2026.",
  context: { scope: "exact_location", location: "Riverside", locationEvidence: "Our Riverside branch.", publishedAt: "2026-10-31", validFrom: "2026-11-01", validThrough: "2026-11-08", temporalStatus: "current", dateEvidence: "Available November 1–8, 2026." },
});
describe("branch and seasonal grounding", () => {
  it("rejects impossible calendar dates without rolling them into another month", () => {
    expect(validSourceDate("2026-02-29")).toBeNull();
    expect(validSourceDate("2024-02-29")).toBe("2024-02-29");
    expect(validSourceDate("2026-13-01")).toBeNull();
  });
  it("separates a dated exact-branch offer from another branch, an expired offer and a reported summary", () => {
    expect(isCurrentOfferSource(source(), "2026-11-02")).toBe(true);
    expect(isCurrentOfferSource(source(), "2026-11-09")).toBe(false);
    expect(isCurrentOfferSource({ ...source(), acquisition: "meta_cited_summary" }, "2026-11-02")).toBe(false);
    const other = source(); other.context!.scope = "other_location";
    expect(isCampaignBusinessSource(other)).toBe(false);
    expect(isCurrentOfferSource(other, "2026-11-02")).toBe(false);
  });
  it("does not treat a recent publication date or unanchored date as an active promotion", () => {
    const undated = source(); undated.context!.validThrough = null;
    expect(isCurrentSource(undated, "2026-11-02")).toBe(true);
    expect(isCurrentOfferSource(undated, "2026-11-02")).toBe(false);
    const unanchored = source(); unanchored.context!.dateEvidence = "Offer valid all year";
    expect(isCurrentOfferSource(unanchored, "2026-11-02")).toBe(false);
  });
  it("withholds historical and not-yet-valid material from a current offering", () => {
    const historical = source(); historical.context!.temporalStatus = "historical";
    expect(isCurrentSource(historical, "2026-11-02")).toBe(false);
    expect(isCurrentSource(source(), "2026-10-30")).toBe(false);
  });
});
