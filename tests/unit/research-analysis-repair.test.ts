import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnalysisValidationError, analysisInputHash, analyzeBusiness, misfiledEvidenceCaveat, repairMisfiledFindingEvidence, ResearchValidationError,
  validateCompletedResearchOutput, validateResearchOutput,
} from "../../lib/research/analyze";
import { writeCompletedAnalysisRecord } from "../../lib/research/completed-response";
import type { BusinessContext, CollectedSource, ResearchReport } from "../../lib/research/contracts";
import type { MetaClient } from "../../lib/meta";

afterEach(() => vi.unstubAllEnvs());

// Synthetic fixtures only. The shape mirrors hosted run 7f7a5df2 (4 Nov 2026): the customer finding honestly said no
// customer signals were retrieved, yet cited two business facts (ordering channels, same-day freshness advice).
const business: BusinessContext = { id: "repair-business", name: "Synthetic patisserie", locality: "Fixture locality", vertical: "bakery", goal: "Introduce the brownie range", website: null };
const sources: CollectedSource[] = [
  { id: "s-owner", kind: "owner_statement", title: "Synthetic owner note", url: null, text: "Our brownies are baked fresh every morning in small batches.", retrievedAt: "2026-11-01T00:00:00.000Z", acquisition: "owner_supplied" },
  { id: "s-site", kind: "official_website", title: "Synthetic ordering page", url: null, text: "Order online through Swiggy and Zomato. Our cakes are best enjoyed the same day.", retrievedAt: "2026-11-01T00:00:00.000Z", acquisition: "owner_supplied" },
  { id: "s-competitor", kind: "competitor", title: "Synthetic competitor excerpt", url: "https://example.com/menu", text: "This fictional competitor lists brownies without baking details.", retrievedAt: "2026-11-01T00:00:00.000Z", acquisition: "owner_supplied" },
];
const customerSource: CollectedSource = { id: "s-customer", kind: "customer_review", title: "Synthetic review excerpt", url: null, text: "I would like to know when the brownies are fresh.", retrievedAt: "2026-11-01T00:00:00.000Z", acquisition: "owner_supplied" };
const context = { mode: "synthetic" as const, generatedAt: "2026-11-01T00:00:00.000Z" };
const HONEST_SUMMARY = "No independent customer signals for this exact shop were retrieved. Supported operational context is ordering through Swiggy/Zomato and same-day freshness advice.";
const CUSTOMER_CAVEAT = "Business context cited under customer signals was removed: those statements are business facts, not customer evidence.";
const STANDARD_CUSTOMER_SUMMARY = "No attributable customer evidence was established. Customer needs and demand remain unverified.";
type ModelReport = Omit<ResearchReport, "coverage" | "generatedAt" | "mode">;
const score = (value: number | null) => ({ value, rationale: "Synthetic rationale." });

function incident(): ModelReport {
  return {
    summary: "Synthetic evidence supports a proposed brownie story.",
    evidence: [
      { id: "ev1", sourceId: "s-owner", quote: "Our brownies are baked fresh every morning in small batches.", claim: "The owner states brownies are baked each morning in small batches.", subject: "business", kind: "fact" },
      { id: "ev2", sourceId: "s-competitor", quote: "This fictional competitor lists brownies without baking details.", claim: "One competitor excerpt lists brownies without baking details.", subject: "competitor", kind: "fact" },
      { id: "ev4", sourceId: "s-site", quote: "Order online through Swiggy and Zomato.", claim: "The site lists Swiggy and Zomato as ordering channels.", subject: "business", kind: "fact" },
      { id: "ev5", sourceId: "s-site", quote: "Our cakes are best enjoyed the same day.", claim: "The site advises same-day consumption.", subject: "business", kind: "fact" },
    ],
    findings: [
      { area: "business", summary: "The owner describes a daily small-batch bake.", evidenceIds: ["ev1", "ev4"], caveats: ["Confirm the schedule before publishing."] },
      { area: "customer", summary: HONEST_SUMMARY, evidenceIds: ["ev4", "ev5"], caveats: ["Customer demand is unmeasured."] },
      { area: "competitor", summary: "One competitor excerpt lacks baking detail.", evidenceIds: ["ev2"], caveats: ["Not a complete competitor audit."] },
      { area: "content", summary: "The daily bake and ordering channels can inform content.", evidenceIds: ["ev1", "ev4", "ev5"], caveats: [] },
    ],
    opportunities: [{
      id: "o-bake", title: "Show the morning bake", hypothesis: "Showing the stated morning bake may prompt online orders.", whyNow: "It serves the stated introduction goal.",
      evidenceIds: ["ev1", "ev4", "ev5", "ev2"], comparison: "One competitor excerpt lacks baking detail.", customerAction: "Order through the listed channels.",
      test: "Count qualified inquiries after the post.", uncertainties: ["Confirm current availability."],
      scores: { impact: score(50), evidence: score(50), differentiation: score(50), feasibility: score(null), confidence: score(50) },
    }],
    recommendedOpportunityId: "o-bake", unknowns: ["Customer demand for this exact shop."], ownerQuestions: ["Which photos may be used?"],
  };
}
function responseFor(output: unknown) {
  return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }], usage: { input_tokens: 200, output_tokens: 400, total_tokens: 600 } };
}
const thrown = (run: () => unknown) => { try { run(); } catch (error) { return error; } throw new Error("Expected a rejection."); };

describe("completed research: bounded repair of business facts cited as customer evidence", () => {
  it("strict validation still rejects the exact incident shape for that one reason", () => {
    const error = thrown(() => validateResearchOutput(incident(), sources, context));
    expect(error).toBeInstanceOf(ResearchValidationError);
    expect((error as ResearchValidationError).message).toBe("A finding cites missing evidence or evidence about the wrong subject.");
    expect((error as ResearchValidationError).reason).toBe("finding_evidence_subject");
  });

  it("the incident validates after repair, with the removal recorded as a caveat and an owner-visible unknown", () => {
    const report = validateCompletedResearchOutput(incident(), sources, context);
    const customer = report.findings.find((finding) => finding.area === "customer")!;
    expect(customer.evidenceIds).toEqual([]);
    // No business statement remains presented as customer evidence, and no model text is reused as a customer finding.
    expect(customer.summary).toBe(STANDARD_CUSTOMER_SUMMARY);
    expect(customer.caveats[0]).toBe(CUSTOMER_CAVEAT);
    expect(misfiledEvidenceCaveat("customer", "business")).toBe(CUSTOMER_CAVEAT);
    expect(report.evidence.filter((entry) => entry.subject === "customer")).toEqual([]);
    expect(report.unknowns).toContain("Local validation removed 2 citations (ev4, ev5) from the customer finding: business facts are not customer evidence. The cited entries remain listed under their own subject.");
    // The business facts stay as business evidence; the opportunity and every other finding are unchanged.
    expect(report.evidence.map((entry) => [entry.id, entry.subject])).toEqual([["ev1", "business"], ["ev2", "competitor"], ["ev4", "business"], ["ev5", "business"]]);
    expect(report.findings.find((finding) => finding.area === "business")!.evidenceIds).toEqual(["ev1", "ev4"]);
    expect(report.findings.find((finding) => finding.area === "content")!.evidenceIds).toEqual(["ev1", "ev4", "ev5"]);
    expect(report.opportunities[0].evidenceIds).toEqual(["ev1", "ev4", "ev5", "ev2"]);
    expect(report.recommendedOpportunityId).toBe("o-bake");
  });

  it("hosted run bcba1188 shape: customer AND competitor findings each cite a business fact while every evidence item is a business fact", () => {
    const output = incident();
    output.evidence = output.evidence.filter((entry) => entry.subject === "business");
    output.findings = output.findings.map((finding) => finding.area === "competitor"
      ? { ...finding, summary: "No competitor evidence was retrieved, so differentiation cannot be demonstrated.", evidenceIds: ["ev5"] }
      : finding.area === "customer" ? { ...finding, evidenceIds: ["ev4"] } : finding);
    output.opportunities = output.opportunities.map((opportunity) => ({ ...opportunity, evidenceIds: ["ev1", "ev4", "ev5"], comparison: "No competitor evidence was retrieved." }));
    expect((thrown(() => validateResearchOutput(output, sources, context)) as ResearchValidationError).reason).toBe("finding_evidence_subject");
    const report = validateCompletedResearchOutput(output, sources, context);
    expect(report.findings.find((finding) => finding.area === "customer")!.evidenceIds).toEqual([]);
    expect(report.findings.find((finding) => finding.area === "competitor")!.evidenceIds).toEqual([]);
    expect(report.findings.find((finding) => finding.area === "competitor")!.caveats[0]).toBe(misfiledEvidenceCaveat("competitor", "business"));
    expect(report.findings.find((finding) => finding.area === "business")!.evidenceIds).toEqual(["ev1", "ev4"]);
    expect(report.unknowns.filter((entry) => entry.startsWith("Local validation removed"))).toHaveLength(2);
    expect(report.evidence.every((entry) => entry.subject === "business")).toBe(true);
    expect(report.recommendedOpportunityId).toBe("o-bake");
  });

  it("is idempotent: the repaired object needs no further repair and strictly validates to the same report", () => {
    const repaired = repairMisfiledFindingEvidence(incident())!;
    expect(repaired.repairs).toHaveLength(1);
    expect(repairMisfiledFindingEvidence(repaired.output)).toBeNull();
    const first = validateCompletedResearchOutput(incident(), sources, context);
    expect(validateResearchOutput(structuredClone(repaired.output), sources, context)).toEqual(first);
    expect(validateCompletedResearchOutput(structuredClone(repaired.output), sources, context)).toEqual(first);
    expect(validateCompletedResearchOutput(incident(), sources, context)).toEqual(first);
  });

  it("a mixed finding keeps its subject-matching evidence and summary, losing only the misfiled citation", () => {
    const output = incident();
    output.evidence.push({ id: "ev6", sourceId: "s-customer", quote: "I would like to know when the brownies are fresh.", claim: "One supplied excerpt asks about freshness timing.", subject: "customer", kind: "signal" });
    output.findings[1] = { area: "customer", summary: "One supplied excerpt asks about freshness timing.", evidenceIds: ["ev6", "ev5"], caveats: [] };
    const report = validateCompletedResearchOutput(output, [...sources, customerSource], context);
    const customer = report.findings.find((finding) => finding.area === "customer")!;
    expect(customer).toMatchObject({ summary: "One supplied excerpt asks about freshness timing.", evidenceIds: ["ev6"] });
    expect(customer.caveats).toContain(CUSTOMER_CAVEAT);
  });

  it("other invalid shapes still throw exactly as before", () => {
    const cases: Array<[string, (output: ModelReport) => void, CollectedSource[], string]> = [
      ["missing evidence id in a business finding", (output) => { output.findings[0].evidenceIds = ["ev1", "ev-missing"]; }, sources, "wrong subject"],
      ["missing evidence id beside a misfiled one", (output) => { output.findings[1].evidenceIds = ["ev4", "ev-missing"]; }, sources, "wrong subject"],
      ["fabricated quote", (output) => { output.evidence[2].quote = "Free delivery on every order today."; }, sources, "excerpt"],
      ["business finding citing only competitor evidence", (output) => { output.findings[0].evidenceIds = ["ev2"]; }, sources, "wrong subject"],
      ["customer finding left empty while customer evidence exists", (output) => {
        output.evidence.push({ id: "ev6", sourceId: "s-customer", quote: "I would like to know when the brownies are fresh.", claim: "One excerpt asks about freshness.", subject: "customer", kind: "signal" });
      }, [...sources, customerSource], "wrong subject"],
      ["repaired object whose opportunity cites missing evidence", (output) => { output.opportunities[0].evidenceIds.push("ev-missing"); }, sources, "existing evidence"],
      ["repaired object whose recommendation is unknown", (output) => { output.recommendedOpportunityId = "o-missing"; }, sources, "recommendation"],
      ["missing analysis area", (output) => { output.findings = output.findings.filter((finding) => finding.area !== "competitor"); }, sources, "four distinct"],
    ];
    for (const [name, mutate, caseSources, message] of cases) {
      const output = incident(); mutate(output);
      expect(() => validateCompletedResearchOutput(output, caseSources, context), name).toThrow(message);
    }
    // A wrong-subject rejection that cannot be repaired keeps the original error object and reason.
    const unrepairable = incident(); unrepairable.findings[0].evidenceIds = ["ev2"];
    const error = thrown(() => validateCompletedResearchOutput(unrepairable, sources, context)) as ResearchValidationError;
    expect([error.message, error.reason]).toEqual(["A finding cites missing evidence or evidence about the wrong subject.", "finding_evidence_subject"]);
    const missing = incident(); missing.findings[0].evidenceIds = ["ev-missing"];
    expect((thrown(() => validateCompletedResearchOutput(missing, sources, context)) as ResearchValidationError).reason).toBeNull();
  });

  it("a fresh completed response is repaired, stored unchanged and replayed locally without a second request", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tickr-analysis-repair-fresh-"));
    const request = vi.fn().mockResolvedValue(responseFor(incident()));
    const input = { business, sources, mode: "synthetic" as const, outputDir };
    try {
      const first = await analyzeBusiness(input, { client: { requestJson: request as MetaClient["requestJson"] }, now: () => new Date(context.generatedAt) });
      expect(first.report.findings.find((finding) => finding.area === "customer")!.caveats[0]).toBe(CUSTOMER_CAVEAT);
      vi.stubEnv("META_API_KEY", "");
      const replay = await analyzeBusiness({ ...input, requireCompletedResponse: true }, { now: () => new Date("2026-11-09T00:00:00Z") });
      expect(replay).toEqual(first);
      expect(request).toHaveBeenCalledTimes(1);
    } finally { await rm(outputDir, { recursive: true, force: true }); }
  });

  it("a response stored before this repair (the hosted resume state) now replays through the resume path with no paid request", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "tickr-analysis-repair-stored-"));
    const input = { business, sources, mode: "synthetic" as const, outputDir };
    const outputText = JSON.stringify(incident());
    try {
      await writeCompletedAnalysisRecord(outputDir, analysisInputHash(input), {
        version: 1, status: "completed", responseId: "resp-fixture", model: "muse-spark-1.3", analysisDate: context.generatedAt, receivedAt: context.generatedAt,
        requestHash: "a".repeat(64), outputText, usage: { model: "muse-spark-1.3", inputTokens: 200, outputTokens: 400, elapsedMs: 10 },
      });
      vi.stubEnv("META_API_KEY", "");
      const request = vi.fn(async () => { throw new Error("No paid request is allowed on a local replay."); });
      const client = { requestJson: request as unknown as MetaClient["requestJson"] };
      const replay = await analyzeBusiness({ ...input, requireCompletedResponse: true }, { client });
      const again = await analyzeBusiness({ ...input, requireCompletedResponse: true }, { client });
      expect(request).not.toHaveBeenCalled();
      expect(again).toEqual(replay);
      expect(replay.usage).toMatchObject({ model: "muse-spark-1.3", inputTokens: 200, outputTokens: 400 });
      expect(replay.report.generatedAt).toBe(context.generatedAt);
      expect(replay.report.findings.find((finding) => finding.area === "customer")).toMatchObject({ evidenceIds: [], summary: STANDARD_CUSTOMER_SUMMARY });
      expect(replay.report.unknowns.some((unknown) => unknown.startsWith("Local validation removed 2 citations (ev4, ev5) from the customer finding"))).toBe(true);
      // Every other stored rejection still fails closed on replay, with no request.
      const fabricatedDir = await mkdtemp(join(tmpdir(), "tickr-analysis-repair-fabricated-"));
      try {
        const fabricated = incident(); fabricated.evidence[2].quote = "Free delivery on every order today.";
        const fabricatedInput = { ...input, outputDir: fabricatedDir };
        await writeCompletedAnalysisRecord(fabricatedDir, analysisInputHash(fabricatedInput), {
          version: 1, status: "completed", responseId: null, model: "muse-spark-1.3", analysisDate: context.generatedAt, receivedAt: context.generatedAt,
          requestHash: "b".repeat(64), outputText: JSON.stringify(fabricated), usage: { model: "muse-spark-1.3", inputTokens: null, outputTokens: null, elapsedMs: 1 },
        });
        await expect(analyzeBusiness({ ...fabricatedInput, requireCompletedResponse: true }, { client })).rejects.toBeInstanceOf(AnalysisValidationError);
      } finally { await rm(fabricatedDir, { recursive: true, force: true }); }
      expect(request).not.toHaveBeenCalled();
    } finally { await rm(outputDir, { recursive: true, force: true }); }
  });

  it("the research instructions forbid citing business facts under customer or competitor findings; the input hash does not include them", async () => {
    const request = vi.fn().mockResolvedValue(responseFor(incident()));
    await analyzeBusiness({ business, sources, mode: "synthetic" }, { client: { requestJson: request as MetaClient["requestJson"] }, now: () => new Date(context.generatedAt) });
    const instructions: string = request.mock.calls[0][1].body.instructions;
    expect(instructions).toContain("Never cite business facts");
    expect(instructions).toContain("that finding's evidenceIds must be empty");
    const hash = analysisInputHash({ business, sources, mode: "synthetic" });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(request.mock.calls[0][1].body.text.format.schema)).not.toContain("Never cite business facts");
  });
});
