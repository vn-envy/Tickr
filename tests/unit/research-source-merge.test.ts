import { expect, test } from "vitest";
import { mergeResearchSources } from "../../lib/jobs/discovery";
import { MAX_RESEARCH_SOURCES } from "../../lib/research/limits";
import type { CollectedSource } from "../../lib/research/contracts";

const records = (count: number): CollectedSource[] => Array.from({ length: count }, (_, index) => ({
  id: `source-${index}`, kind: "business_coverage", title: `Fixture source ${index}`, url: null,
  text: "Synthetic source for source-budget tests.", acquisition: "owner_supplied", retrievedAt: "2026-11-02T00:00:00.000Z",
}));

test("overflow retains required references beyond the old cutoff and favors original website text in remaining slots", () => {
  const discovered = records(45);
  const original: CollectedSource = { ...discovered[0], id: "direct-original", acquisition: "direct_website", url: "https://fixture.example/about" };
  const requiredIds = [discovered[44].id, discovered[43].id];
  const result = mergeResearchSources(discovered, [original], requiredIds);
  expect(result.sources).toHaveLength(MAX_RESEARCH_SOURCES);
  expect(result.sources.slice(0, 2).map((source) => source.id)).toEqual([discovered[43].id, discovered[44].id]);
  expect(result.sources[2].id).toBe(original.id);
  expect(result.warnings.join(" ")).toContain("6 optional records were excluded");
  expect(result.warnings.join(" ")).toContain("Required evidence was retained");
});

test("oversized or missing required evidence fails explicitly instead of silently truncating grounded references", () => {
  const sources = records(MAX_RESEARCH_SOURCES + 1);
  expect(() => mergeResearchSources(sources, [], sources.map((source) => source.id))).toThrow("no analysis request was made");
  expect(() => mergeResearchSources(sources, [], ["missing-branch-source"])).toThrow("missing from the collected source ledger");
});
