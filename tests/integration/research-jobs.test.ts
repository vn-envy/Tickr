import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../../lib/generated/prisma/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { JobStore } from "../../lib/jobs/store";
import { runNextJob, type WorkerDependencies } from "../../lib/jobs/worker";
import { MetaClientError } from "../../lib/meta/config";
import { CampaignCopyValidationError, CampaignRenderError } from "../../lib/campaign/index";
import { BusinessDraftInput } from "../../lib/businesses/input";
import { prepareEnrichmentCheckpoint } from "../../lib/jobs/discovery";
import { AnalysisValidationError } from "../../lib/research/analyze";
import type { BusinessDiscovery, BusinessEnrichment, ResearchInput, ResearchReport, CollectedSource, CampaignKit } from "../../lib/research/contracts";

let directory: string;
let client: PrismaClient;
let store: JobStore;
let businessId: string;
const input: ResearchInput = { mode: "synthetic", readWebsite: false, sources: [{ kind: "owner_statement", title: "Synthetic owner note", url: null, text: "We bake sourdough every morning." }] };
const source: CollectedSource = { id: "source1", kind: "owner_statement", title: "Synthetic owner note", url: null, text: "We bake sourdough every morning.", retrievedAt: "2026-11-01T00:00:00.000Z", acquisition: "owner_supplied" };
const usage = { model: "test-double-no-inference", inputTokens: 0, outputTokens: 0, elapsedMs: 1 };
const dimension = { value: null, rationale: "Not established by this fixture." };
const report: ResearchReport = {
  summary: "Synthetic evidence fixture for job recovery tests.",
  evidence: [{ id: "e1", sourceId: "source1", quote: "We bake sourdough every morning.", claim: "The owner reports daily sourdough baking.", subject: "business", kind: "fact" }],
  findings: [{ area: "business", summary: "Owner statement is available.", evidenceIds: ["e1"], caveats: ["Synthetic test input."] }],
  opportunities: [{ id: "op1", title: "Explain the morning bake", hypothesis: "A process story could encourage inquiries.", whyNow: "The owner wants their process understood.", evidenceIds: ["e1"], comparison: "No competitive evidence.", customerAction: "Ask about availability.", test: "Count inquiries.", uncertainties: ["No local demand evidence."], scores: { impact: dimension, evidence: dimension, differentiation: dimension, feasibility: dimension, confidence: dimension } }],
  recommendedOpportunityId: "op1", unknowns: ["Competitors unknown."], ownerQuestions: ["Which real photographs may be used?"],
  coverage: { sources: 1, competitorSources: 0, customerSources: 0 }, generatedAt: "2026-11-01T00:00:00.000Z", mode: "synthetic",
};
const campaign: CampaignKit = { id: "kit1", name: "Synthetic concept", objective: "Tell a story", audienceHypothesis: "Local residents", coreMessage: "A morning bake", primaryCta: "Ask about availability", opportunityId: "op1", evidenceIds: ["e1"], status: "concept_needs_review", mode: "synthetic", reviewNotes: ["Synthetic fixture."], channels: [], assets: [], createdAt: "2026-11-01T00:00:00.000Z", model: "test-double-no-inference" };

function dependencies(): WorkerDependencies {
  return {
    discoverBusiness: vi.fn(async () => { throw new Error("This fixture did not request discovery."); }),
    enrichBusiness: vi.fn(async () => { throw new Error("This fixture did not request enrichment."); }),
    collectSources: vi.fn(async () => ({ sources: [source], warnings: [] })),
    analyzeBusiness: vi.fn(async () => ({ report, usage })),
    assertAnalysisInput: vi.fn(() => {}),
    hasBoundCompletedAnalysis: async () => false,
    assertCampaignInput: vi.fn(() => {}),
    createCampaign: vi.fn(async () => ({ campaign, usage })),
    hasCopyCheckpoint: async () => false,
    hasBoundCompletedCopy: async () => false,
    credentialPresent: () => true,
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tickr-jobs-"));
  const filename = join(directory, "test.db");
  const sqlite = new Database(filename);
  sqlite.pragma("foreign_keys = ON");
  for (const migration of ["20261101000000_foundation", "20261101010000_research_jobs", "20261104000000_autopilot_budget"]) sqlite.exec(await readFile(resolve("prisma/migrations", migration, "migration.sql"), "utf8"));
  sqlite.close();
  client = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${filename}` }) });
  store = new JobStore(client);
  businessId = (await client.business.create({ data: { name: "Synthetic bakery", locality: "Fixture district", vertical: "bakery", goal: "Explain the real baking process" } })).id;
});

function discoveredFixture() {
  const citation = { responseId: "response-fixture", searchCallIds: ["search-fixture"], url: "https://fixture.example/about", title: "Fixture clinic" };
  const discoveredSource: CollectedSource = { id: "discovered1", kind: "official_website", title: "Fixture clinic", url: citation.url, text: "Fixture Clinic is a dental clinic in Fixture District.", acquisition: "meta_search_snippet", citation, retrievedAt: "2026-11-01T00:00:00.000Z" };
  const discovery: BusinessDiscovery = {
    status: "matched", inputUrl: "https://fixture.example/listing", name: "Fixture Clinic", locality: "Fixture District", vertical: "dentist", officialWebsite: citation.url, instagramUrl: null,
    summary: "A cited retrieval identifies the fixture clinic.", sourceIds: [discoveredSource.id], warnings: [], queries: ["fixture listing identity"], completedToolCalls: 1, discoveredAt: "2026-11-01T00:00:00.000Z",
    links: [{ url: citation.url, title: citation.title, relationship: "business" }],
  };
  return { discovery, sources: [discoveredSource], usage };
}

test("URL-only research discovers identity before analysis and campaign uses the resolved snapshot", async () => {
  const intake = BusinessDraftInput.parse({ website: "https://fixture.example/listing" });
  const business = await client.business.create({ data: intake });
  const dep = dependencies();
  dep.discoverBusiness = vi.fn(async () => discoveredFixture());
  const run = await store.enqueueResearch(business.id, { mode: "live", readWebsite: false, sources: [], discoverFromLink: true, enrichFromLink: false });
  try {
    await runNextJob({ store, dependencies: dep });
    const researched = await store.view(run.id);
    expect(researched.business.name).toBe("Fixture Clinic");
    expect(researched.business.locality).toBe("Fixture District");
    expect(researched.business.vertical).toBe("dentist");
    expect(researched.discovery?.status).toBe("matched");
    expect(researched.sources.some((item) => item.acquisition === "meta_search_snippet")).toBe(true);
    expect(researched.usage).toHaveLength(2);
    expect((await client.business.findUniqueOrThrow({ where: { id: business.id } })).name).toBe("");
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(2);
    expect(dep.analyzeBusiness).toHaveBeenCalledWith(expect.objectContaining({ business: expect.objectContaining({ name: "Fixture Clinic", vertical: "dentist" }) }));
    await store.enqueueCampaign(run.id, "op1");
    await runNextJob({ store, dependencies: dep });
    expect(dep.createCampaign).toHaveBeenCalledWith(expect.objectContaining({ business: expect.objectContaining({ name: "Fixture Clinic", vertical: "dentist" }) }));
    expect(dep.discoverBusiness).toHaveBeenCalledTimes(1);
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(3);
  } finally { await rm(resolve(".data/runs", run.id), { recursive: true, force: true }); }
});

test("completed discovery and its usage survive a safe local failure without a repeated search", async () => {
  const business = await client.business.create({ data: BusinessDraftInput.parse({ website: "https://fixture.example/listing" }) });
  const dep = dependencies();
  dep.discoverBusiness = vi.fn(async () => discoveredFixture());
  let collectionAttempts = 0;
  dep.collectSources = vi.fn(async () => {
    if (++collectionAttempts === 1) throw new Error("Synthetic local collection failure");
    return { sources: [source], warnings: [] };
  });
  const run = await store.enqueueResearch(business.id, { mode: "live", readWebsite: false, sources: [], enrichFromLink: false });
  await runNextJob({ store, dependencies: dep });
  expect((await store.view(run.id)).discovery?.status).toBe("matched");
  expect((await store.view(run.id)).usage).toHaveLength(1);
  expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).retrySafe).toBe(true);
  await store.retry(run.id);
  await runNextJob({ store, dependencies: dep });
  const complete = await store.view(run.id);
  expect(complete.stage).toBe("awaiting_selection");
  expect(dep.discoverBusiness).toHaveBeenCalledTimes(1);
  expect(complete.usage).toHaveLength(2);
  expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(2);
});

test("an unresolved or unsupported identity never inherits the storage-default category for analysis", async () => {
  const business = await client.business.create({ data: BusinessDraftInput.parse({ website: "https://fixture.example/listing" }) });
  const dep = dependencies();
  dep.discoverBusiness = vi.fn(async () => {
    const result = discoveredFixture();
    return { ...result, sources: [], discovery: { ...result.discovery, sourceIds: ["invented-source"] } };
  });
  const run = await store.enqueueResearch(business.id, { mode: "live", readWebsite: false, sources: [] });
  await runNextJob({ store, dependencies: dep });
  const result = await store.view(run.id);
  expect(result.stage).toBe("awaiting_owner");
  expect(result.business.name).toBe("");
  expect(result.business.locality).toBe("");
  expect(result.discovery?.status).toBe("unresolved");
  expect(result.discovery?.name).toBeNull();
  expect(result.error).toContain("you do not need to write its story");
  expect(dep.analyzeBusiness).not.toHaveBeenCalled();
  expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(1);
});

test("a cited business identity can be analyzed while its locality remains unknown", async () => {
  const business = await client.business.create({ data: BusinessDraftInput.parse({ website: "https://fixture.example/listing" }) });
  const dep = dependencies();
  dep.discoverBusiness = vi.fn(async () => {
    const result = discoveredFixture();
    return { ...result, discovery: { ...result.discovery, locality: null, warnings: ["The locality was not established by retrieved evidence."] } };
  });
  const run = await store.enqueueResearch(business.id, { mode: "live", readWebsite: false, sources: [], enrichFromLink: false });
  await runNextJob({ store, dependencies: dep });
  const result = await store.view(run.id);
  expect(result.stage).toBe("awaiting_selection");
  expect(result.business.name).toBe("Fixture Clinic");
  expect(result.business.locality).toBe("");
  expect(dep.analyzeBusiness).toHaveBeenCalledWith(expect.objectContaining({ business: expect.objectContaining({ locality: "", vertical: "dentist" }) }));
});

test.each(["Scientific equipment rental", null])("matched identity with category %s is researched without a bakery fallback", async (category) => {
  const business = await client.business.create({ data: BusinessDraftInput.parse({ website: "https://fixture.example/listing" }) });
  const dep = dependencies();
  dep.discoverBusiness = vi.fn(async () => {
    const result = discoveredFixture();
    return { ...result, discovery: { ...result.discovery, vertical: category } };
  });
  const run = await store.enqueueResearch(business.id, { mode: "live", readWebsite: false, sources: [], enrichFromLink: false });
  await runNextJob({ store, dependencies: dep });
  const result = await store.view(run.id);
  expect(result.stage).toBe("awaiting_selection");
  expect(result.business.vertical).toBe(category ?? "business");
  expect(dep.analyzeBusiness).toHaveBeenCalledWith(expect.objectContaining({ business: expect.objectContaining({ vertical: category ?? "business" }) }));
});

test("a candidate discovery branch cannot become the verified locality even if a loose locality field is present", async () => {
  const business = await client.business.create({ data: BusinessDraftInput.parse({ website: "https://fixture.example/listing" }) });
  const dep = dependencies();
  dep.discoverBusiness = vi.fn(async () => {
    const result = discoveredFixture();
    result.discovery.branch = { status: "candidate", label: "Possible branch", locality: "Fixture District", address: null, sourceIds: [result.sources[0].id], rationale: "The brand is known; the branch link is ambiguous." };
    return result;
  });
  const run = await store.enqueueResearch(business.id, { mode: "live", readWebsite: false, sources: [], enrichFromLink: false });
  await runNextJob({ store, dependencies: dep });
  expect((await store.view(run.id)).business.locality).toBe("");
  expect((await store.view(run.id)).stage).toBe("awaiting_selection");
  expect(dep.analyzeBusiness).toHaveBeenCalledWith(expect.objectContaining({ business: expect.objectContaining({ locality: "" }) }));
});

test("optional name and city hints cannot bypass unresolved discovery and activate the default category", async () => {
  const intake = BusinessDraftInput.parse({ website: "https://fixture.example/listing", name: "Fixture Dental", locality: "Fixture District" });
  const business = await client.business.create({ data: intake });
  const dep = dependencies();
  dep.discoverBusiness = vi.fn(async () => {
    const result = discoveredFixture();
    return { ...result, discovery: { ...result.discovery, status: "ambiguous" as const, name: null, locality: null, vertical: null } };
  });
  const run = await store.enqueueResearch(business.id, { mode: "live", readWebsite: false, sources: [], discoverFromLink: true });
  await runNextJob({ store, dependencies: dep });
  expect((await store.view(run.id)).stage).toBe("awaiting_owner");
  expect(dep.analyzeBusiness).not.toHaveBeenCalled();
  expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(1);
  const manual = await store.enqueueResearch(business.id, { mode: "live", readWebsite: false, sources: input.sources, discoverFromLink: false });
  await runNextJob({ store, dependencies: dep });
  expect((await store.view(manual.id)).stage).toBe("awaiting_selection");
  expect(dep.discoverBusiness).toHaveBeenCalledTimes(1);
  expect(dep.analyzeBusiness).toHaveBeenCalledTimes(1);
});
afterEach(async () => { await client.$disconnect(); await rm(directory, { recursive: true, force: true }); });

test("identical research input reuses one run and a lease cannot be claimed twice", async () => {
  const first = await store.enqueueResearch(businessId, input);
  const second = await store.enqueueResearch(businessId, input);
  expect(first.id).toBe(second.id);
  expect(await client.run.count()).toBe(1);
  expect(await store.claim("worker-a")).toBe(first.id);
  expect(await store.claim("worker-b")).toBeNull();
  expect(await store.heartbeat(first.id, "worker-b")).toBe(false);
  await expect(store.markStage(first.id, "worker-b", "researching", "Wrong owner")).rejects.toThrow("no longer owns");
});

test("a changed owner-media revision starts a new run while an unchanged retry still reuses it", async () => {
  const withMedia = { ...input, autopilot: true, mediaRevision: "a".repeat(64) };
  const first = await store.enqueueResearch(businessId, withMedia);
  const retry = await store.enqueueResearch(businessId, { ...withMedia });
  expect(retry.id).toBe(first.id);
  const changed = await store.enqueueResearch(businessId, { ...withMedia, mediaRevision: "b".repeat(64) });
  expect(changed.id).not.toBe(first.id);
  const without = await store.enqueueResearch(businessId, { ...input, autopilot: true });
  expect(new Set([first.id, changed.id, without.id]).size).toBe(3);
  expect(await client.run.count()).toBe(3);
  await expect(store.enqueueResearch(businessId, { ...withMedia, mediaRevision: "NOT-HEX" })).rejects.toThrow();
});

test("campaign selection is run-scoped and finished research is reused without a second analysis", async () => {
  const dep = dependencies();
  const run = await store.enqueueResearch(businessId, input);
  expect(await runNextJob({ store, dependencies: dep })).toBe(run.id);
  const researched = await store.view(run.id);
  expect(researched.stage).toBe("awaiting_selection");
  expect(researched.report?.evidence[0].id).toBe("e1");
  expect((await client.evidence.findFirst())?.id).toBe(`${run.id}:e1`);
  await expect(store.enqueueCampaign(run.id, "op-from-another-run")).rejects.toThrow("from this research run");
  await store.enqueueCampaign(run.id, "op1");
  await store.enqueueCampaign(run.id, "op1");
  await runNextJob({ store, dependencies: dep });
  const complete = await store.view(run.id);
  expect(complete.stage).toBe("needs_review");
  expect(complete.campaign?.status).toBe("concept_needs_review");
  expect(dep.analyzeBusiness).toHaveBeenCalledTimes(1);
  expect(dep.createCampaign).toHaveBeenCalledTimes(1);
  expect(complete.usage).toHaveLength(2);
  expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(2);
  await store.enqueueCampaign(run.id, "op1");
  expect(await runNextJob({ store, dependencies: dep })).toBeNull();
  await rm(resolve(".data/runs", run.id), { recursive: true, force: true });
});

test("a lost campaign lease preserves research and does not silently repeat a paid request", async () => {
  const dep = dependencies();
  const run = await store.enqueueResearch(businessId, input);
  await runNextJob({ store, dependencies: dep });
  await store.enqueueCampaign(run.id, "op1");
  await store.claim("crashed-worker");
  await store.reserveModelCall(run.id, "crashed-worker");
  await client.run.update({ where: { id: run.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
  expect(await store.recoverExpired()).toBe(1);
  const interrupted = await store.view(run.id);
  expect(interrupted.stage).toBe("interrupted");
  expect(interrupted.report).toEqual(report);
  expect(interrupted.error).toContain("no paid request was retried");
  await expect(store.retry(run.id)).rejects.toThrow("cannot be retried automatically");
  expect(await runNextJob({ store, dependencies: dep })).toBeNull();
  expect(dep.createCampaign).not.toHaveBeenCalled();
});

test("a missing key is safely retryable and source checkpoints are not collected twice", async () => {
  const dep = dependencies();
  let credential = false;
  dep.credentialPresent = () => credential;
  const run = await store.enqueueResearch(businessId, input);
  await runNextJob({ store, dependencies: dep });
  expect((await store.view(run.id)).error).toContain("no model request was made");
  expect(dep.analyzeBusiness).not.toHaveBeenCalled();
  credential = true;
  await store.retry(run.id);
  await runNextJob({ store, dependencies: dep });
  expect((await store.view(run.id)).stage).toBe("awaiting_selection");
  expect(dep.collectSources).toHaveBeenCalledTimes(1);
  expect(dep.analyzeBusiness).toHaveBeenCalledTimes(1);
});

test("uncertain paid failures cannot be retried, and no-source runs never call Meta", async () => {
  const dep = dependencies();
  dep.analyzeBusiness = vi.fn(async () => { throw new MetaClientError("NETWORK_ERROR", "Meta request failed", { outcome: "unknown" }); });
  const run = await store.enqueueResearch(businessId, input);
  await runNextJob({ store, dependencies: dep });
  await expect(store.retry(run.id)).rejects.toThrow("cannot be retried automatically");
  const empty = await store.enqueueResearch(businessId, { ...input, sources: [] });
  dep.collectSources = vi.fn(async () => ({ sources: [], warnings: ["No source provided."] }));
  await runNextJob({ store, dependencies: dep });
  expect((await store.view(empty.id)).stage).toBe("awaiting_owner");
  expect(dep.analyzeBusiness).toHaveBeenCalledTimes(1);
});

test("tampered evidence checkpoints are rejected before selection or rendering", async () => {
  const run = await store.enqueueResearch(businessId, input);
  await runNextJob({ store, dependencies: dependencies() });
  await client.stageArtifact.updateMany({ where: { runId: run.id, stage: "report" }, data: { payload: { ...report, summary: "Changed after validation" } } });
  await expect(store.view(run.id)).rejects.toThrow("integrity check");
  await expect(store.enqueueCampaign(run.id, "op1")).rejects.toThrow("Finish research");
});

test("an explicit render retry reuses completed copy and research without another paid reservation", async () => {
  const dep = dependencies();
  const run = await store.enqueueResearch(businessId, input);
  const checkpointText = JSON.stringify({ validatedCompletedCopy: "fixture", sourceVersion: "unchanged" });
  let generatedCopyCount = 0;
  let renderCount = 0;
  dep.hasCopyCheckpoint = async (campaignInput) => (await readFile(join(campaignInput.outputDir, "copy-checkpoint.json"), "utf8").catch(() => null)) === checkpointText;
  dep.createCampaign = vi.fn(async (campaignInput) => {
    renderCount += 1;
    if (renderCount === 1) {
      generatedCopyCount += 1;
      await writeFile(join(campaignInput.outputDir, "copy-checkpoint.json"), checkpointText);
      throw new CampaignRenderError();
    }
    expect(campaignInput.reuseCompletedCopyOnly).toBe(true);
    await expect(campaignInput.reserveAdditionalModelCall?.()).rejects.toThrow("render-only retry cannot start a new paid image request");
    expect(await readFile(join(campaignInput.outputDir, "copy-checkpoint.json"), "utf8")).toBe(checkpointText);
    return { campaign, usage };
  });
  try {
    await runNextJob({ store, dependencies: dep });
    await store.enqueueCampaign(run.id, "op1");
    await runNextJob({ store, dependencies: dep });
    const failed = await store.view(run.id);
    expect(failed.status).toBe("failed");
    expect(failed.report).toEqual(report);
    expect(failed.error).toContain("without another Meta request");
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).retrySafe).toBe(true);
    expect(await runNextJob({ store, dependencies: dep })).toBeNull();
    await store.retry(run.id);
    dep.credentialPresent = () => false; // Local rendering must not require another inference credential.
    await runNextJob({ store, dependencies: dep });
    const complete = await store.view(run.id);
    expect(complete.status).toBe("completed");
    expect(complete.report).toEqual(report);
    expect(generatedCopyCount).toBe(1);
    expect(dep.analyzeBusiness).toHaveBeenCalledTimes(1);
    expect(dep.createCampaign).toHaveBeenCalledTimes(2);
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(2);
    expect(complete.usage).toHaveLength(2);
  } finally { await rm(resolve(".data/runs", run.id), { recursive: true, force: true }); }
});

test("a removed render checkpoint cannot turn a local-only retry into a paid request", async () => {
  const dep = dependencies();
  const run = await store.enqueueResearch(businessId, input);
  dep.hasCopyCheckpoint = async (campaignInput) => (await readFile(join(campaignInput.outputDir, "copy-checkpoint.json"), "utf8").catch(() => null)) === "completed-copy-fixture";
  dep.createCampaign = vi.fn(async (campaignInput) => {
    await writeFile(join(campaignInput.outputDir, "copy-checkpoint.json"), "completed-copy-fixture");
    throw new CampaignRenderError();
  });
  try {
    await runNextJob({ store, dependencies: dep });
    await store.enqueueCampaign(run.id, "op1");
    await runNextJob({ store, dependencies: dep });
    await store.retry(run.id);
    await rm(resolve(".data/runs", run.id, "copy-checkpoint.json"));
    await runNextJob({ store, dependencies: dep });
    const failed = await store.view(run.id);
    expect(failed.error).toContain("No new Meta request was made");
    expect(failed.report).toEqual(report);
    expect(dep.createCampaign).toHaveBeenCalledTimes(1);
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(2);
    await expect(store.retry(run.id)).rejects.toThrow("cannot be retried automatically");
  } finally { await rm(resolve(".data/runs", run.id), { recursive: true, force: true }); }
});

test("completed analysis validation failures preserve a bound local-only retry and meter the analysis once", async () => {
  const dep = dependencies();
  const run = await store.enqueueResearch(businessId, input);
  const responseText = "bound-completed-analysis-fixture";
  let paidAnalysisCalls = 0;
  let fixed = false;
  dep.hasBoundCompletedAnalysis = async (analysisInput) => (await readFile(join(analysisInput.outputDir!, "analysis-response.json"), "utf8").catch(() => null)) === responseText;
  dep.analyzeBusiness = vi.fn(async (analysisInput) => {
    if (!analysisInput.requireCompletedResponse) {
      paidAnalysisCalls++;
      await mkdir(analysisInput.outputDir!, { recursive: true });
      await writeFile(join(analysisInput.outputDir!, "analysis-response.json"), responseText);
    }
    if (!fixed) throw new AnalysisValidationError();
    return { report, usage };
  });
  try {
    await runNextJob({ store, dependencies: dep });
    const failed = await store.view(run.id);
    expect(failed.error).toContain("local validation retry");
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).retrySafe).toBe(true);
    expect(await runNextJob({ store, dependencies: dep })).toBeNull();
    dep.credentialPresent = () => false;
    await store.retry(run.id);
    await runNextJob({ store, dependencies: dep });
    expect((await store.view(run.id)).status).toBe("failed");
    expect(paidAnalysisCalls).toBe(1);
    fixed = true;
    await store.retry(run.id);
    await runNextJob({ store, dependencies: dep });
    const complete = await store.view(run.id);
    expect(complete.stage).toBe("awaiting_selection");
    expect(complete.report).toEqual(report);
    expect(complete.usage).toHaveLength(1);
    expect(paidAnalysisCalls).toBe(1);
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(1);
    expect(dep.collectSources).toHaveBeenCalledTimes(1);
  } finally { await rm(resolve(".data/runs", run.id), { recursive: true, force: true }); }
});

test("a missing saved analysis response cannot turn an explicit local validation retry into a paid request", async () => {
  const dep = dependencies();
  const run = await store.enqueueResearch(businessId, input);
  dep.hasBoundCompletedAnalysis = async (analysisInput) => (await readFile(join(analysisInput.outputDir!, "analysis-response.json"), "utf8").catch(() => null)) === "saved-analysis";
  dep.analyzeBusiness = vi.fn(async (analysisInput) => {
    await mkdir(analysisInput.outputDir!, { recursive: true });
    await writeFile(join(analysisInput.outputDir!, "analysis-response.json"), "saved-analysis");
    throw new AnalysisValidationError();
  });
  try {
    await runNextJob({ store, dependencies: dep });
    await store.retry(run.id);
    await rm(resolve(".data/runs", run.id, "analysis-response.json"));
    await runNextJob({ store, dependencies: dep });
    expect((await store.view(run.id)).error).toContain("No new Meta request");
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).retrySafe).toBe(false);
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(1);
    expect(dep.analyzeBusiness).toHaveBeenCalledTimes(1);
  } finally { await rm(resolve(".data/runs", run.id), { recursive: true, force: true }); }
});

test("local analysis preflight failures do not reserve a request", async () => {
  const dep = dependencies();
  const run = await store.enqueueResearch(businessId, input);
  dep.assertAnalysisInput = () => { throw new Error("Synthetic local source-context validation failure"); };
  await runNextJob({ store, dependencies: dep });
  expect((await store.view(run.id)).error).toContain("No analysis request was made");
  expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).retrySafe).toBe(true);
  expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(0);
  expect(dep.analyzeBusiness).not.toHaveBeenCalled();
});

test("an exhausted six-request budget still permits verified local rendering without more model calls", async () => {
  const business = await client.business.create({ data: BusinessDraftInput.parse({ website: "https://fixture.example/listing" }) });
  const dep = dependencies();
  dep.discoverBusiness = vi.fn(async () => discoveredFixture());
  dep.enrichBusiness = vi.fn(async () => enrichedFixture(business.id));
  dep.hasCopyCheckpoint = async (campaignInput) => (await readFile(join(campaignInput.outputDir, "copy-checkpoint.json"), "utf8").catch(() => null)) === "completed-copy-at-budget";
  let renderAttempts = 0;
  dep.createCampaign = vi.fn(async (campaignInput) => {
    if (++renderAttempts === 1) {
      await campaignInput.reserveAdditionalModelCall?.();
      await campaignInput.reserveAdditionalModelCall?.();
      await writeFile(join(campaignInput.outputDir, "copy-checkpoint.json"), "completed-copy-at-budget");
      throw new CampaignRenderError();
    }
    expect(campaignInput.reuseCompletedCopyOnly).toBe(true);
    await expect(campaignInput.reserveAdditionalModelCall?.()).rejects.toThrow("render-only retry");
    return { campaign, usage, additionalUsage: [usage, usage] };
  });
  const run = await store.enqueueResearch(business.id, { mode: "live", readWebsite: false, sources: [] });
  try {
    await runNextJob({ store, dependencies: dep });
    await store.enqueueCampaign(run.id, "op1");
    await runNextJob({ store, dependencies: dep });
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(6);
    await store.retry(run.id);
    dep.credentialPresent = () => false;
    await runNextJob({ store, dependencies: dep });
    expect((await store.view(run.id)).status).toBe("completed");
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(6);
    expect((await store.view(run.id)).usage).toHaveLength(6);
  } finally { await rm(resolve(".data/runs", run.id), { recursive: true, force: true }); }
});

function enrichedFixture(id: string) {
  const citation = { responseId: "enrichment-response-fixture", searchCallIds: ["enrichment-search-fixture"], url: "https://fixture.example/services", title: "Fixture clinic services" };
  const enrichedSource: CollectedSource = {
    id: "enriched1", kind: "business_coverage", title: citation.title, url: citation.url, citation,
    text: "Fixture Clinic describes its family dentistry consultations and a focus on explaining care clearly.", acquisition: "meta_cited_summary", retrievedAt: "2026-11-02T00:00:00.000Z",
  };
  const enrichment: BusinessEnrichment = {
    status: "enriched", businessId: id,
    offerings: [{ id: "offering1", name: "Family dentistry consultation", description: "A reported consultation service.", sourceIds: [enrichedSource.id] }],
    brandSignals: [{ id: "brand1", kind: "positioning", claim: "The business describes explaining care clearly.", sourceIds: [enrichedSource.id] }],
    sourceIds: [enrichedSource.id], unknowns: ["Current availability is unconfirmed."], warnings: ["Synthetic test data."], queries: ["Fixture Clinic services"], completedToolCalls: 1, enrichedAt: "2026-11-02T00:00:00.000Z",
  };
  return { enrichment, sources: [enrichedSource], usage };
}

test.each(["matched", "candidate"] as const)("an enrichment branch marked %s resolves the same business snapshot for analysis, restored UI and campaign", async (branchStatus) => {
  const business = await client.business.create({ data: BusinessDraftInput.parse({ website: "https://fixture.example/listing" }) });
  const dep = dependencies();
  dep.discoverBusiness = vi.fn(async () => {
    const result = discoveredFixture();
    result.sources[0].context = { scope: "unknown", location: "Fixture District", locationEvidence: result.sources[0].text, publishedAt: null, validFrom: null, validThrough: null, temporalStatus: "unknown", dateEvidence: null };
    return { ...result, discovery: { ...result.discovery, locality: null } };
  });
  dep.enrichBusiness = vi.fn(async () => {
    const result = enrichedFixture(business.id);
    result.sources[0].text += " The requested branch is in Exact District.";
    result.sources[0].context = { scope: "exact_location", location: "Exact District", locationEvidence: "The requested branch is in Exact District.", publishedAt: null, validFrom: null, validThrough: null, temporalStatus: "unknown", dateEvidence: null };
    result.enrichment.branch = { status: branchStatus, label: "Fixture Clinic Exact District", locality: "Exact District", address: null, sourceIds: [result.sources[0].id], rationale: "The retrieved summary explicitly identifies the branch." };
    return result;
  });
  const run = await store.enqueueResearch(business.id, { mode: "live", readWebsite: false, sources: [] });
  try {
    await runNextJob({ store, dependencies: dep });
    const researched = await store.view(run.id);
    const expectedLocality = branchStatus === "matched" ? "Exact District" : "";
    expect(researched.business.locality).toBe(expectedLocality);
    expect(researched.discovery?.locality).toBeNull();
    expect(researched.sources.find((record) => record.id === "discovered1")?.context?.scope).toBe(branchStatus === "matched" ? "other_location" : "unknown");
    const originalDiscovery = (await store.load(run.id)).artifacts.find((artifact) => artifact.stage === "discovery")?.payload as { sources: CollectedSource[] } | undefined;
    expect(originalDiscovery?.sources[0].context?.scope).toBe("unknown");
    expect((await client.business.findUniqueOrThrow({ where: { id: business.id } })).locality).toBe("");
    expect(dep.analyzeBusiness).toHaveBeenCalledWith(expect.objectContaining({ business: expect.objectContaining({ locality: expectedLocality }) }));
    await store.enqueueCampaign(run.id, "op1");
    await runNextJob({ store, dependencies: dep });
    expect(dep.createCampaign).toHaveBeenCalledWith(expect.objectContaining({ business: expect.objectContaining({ locality: expectedLocality }) }));
    expect((await store.view(run.id)).business.locality).toBe(expectedLocality);
  } finally { await rm(resolve(".data/runs", run.id), { recursive: true, force: true }); }
});

test("broad enrichment preserves customer and competitor sources while rejecting cross-subject insights and unsupported branch scope", () => {
  const business = { id: businessId, name: "Fixture Clinic", locality: "", vertical: "Healthcare services", goal: "Explain services", website: null };
  const result = enrichedFixture(businessId);
  const customer: CollectedSource = { ...result.sources[0], id: "customer1", kind: "customer_review", text: "One customer says appointment instructions were unclear." };
  const competitor: CollectedSource = { ...result.sources[0], id: "competitor1", kind: "competitor", text: "A nearby fixture clinic describes online appointment booking." };
  result.sources.push(customer, competitor);
  result.enrichment.sourceIds.push(customer.id, competitor.id);
  result.enrichment.insights = [{ id: "customer-insight", kind: "customer", claim: "A supplied customer signal concerns appointment instructions.", implication: "Test a clearer explanation.", sourceIds: [customer.id] }];
  result.enrichment.coverage = [{ area: "competitor", status: "found", summary: "One competitor describes its booking process.", sourceIds: [competitor.id] }];
  expect(prepareEnrichmentCheckpoint(business, [], result).sources).toHaveLength(3);
  const mixed = structuredClone(result);
  mixed.enrichment.insights![0].sourceIds = [competitor.id];
  expect(() => prepareEnrichmentCheckpoint(business, [], mixed)).toThrow("confuse customer");
  const invalidBranch = structuredClone(result);
  invalidBranch.enrichment.branch = { status: "matched", label: null, locality: "Wrong District", address: null, sourceIds: [result.sources[0].id], rationale: "Unanchored inference." };
  expect(() => prepareEnrichmentCheckpoint(business, [], invalidBranch)).toThrow("exact location");
});

test("a full enrichment and discovery ledger retains a reused branch reference and all four original website reads", async () => {
  const business = await client.business.create({ data: BusinessDraftInput.parse({ website: "https://fixture.example/listing" }) });
  const dep = dependencies();
  const discovered = discoveredFixture();
  discovered.sources = Array.from({ length: 12 }, (_, index) => ({ ...discovered.sources[0], id: `discovered-${index}`, context: { scope: "exact_location" as const, location: "Fixture District", locationEvidence: "Fixture Clinic is a dental clinic in Fixture District.", publishedAt: null, validFrom: null, validThrough: null, temporalStatus: "unknown" as const, dateEvidence: null } }));
  discovered.discovery.sourceIds = [discovered.sources[0].id];
  discovered.discovery.branch = { status: "matched", label: "Fixture Clinic", locality: "Fixture District", address: null, sourceIds: [discovered.sources[11].id], rationale: "The requested branch is supported by the last discovery record." };
  dep.discoverBusiness = vi.fn(async () => discovered);
  const enriched = enrichedFixture(business.id);
  enriched.sources = Array.from({ length: 24 }, (_, index) => ({ ...enriched.sources[0], id: index === 0 ? "enriched1" : `enriched-${index}` }));
  enriched.enrichment.branch = discovered.discovery.branch;
  enriched.enrichment.sourceIds = [...enriched.sources.map((record) => record.id), discovered.sources[11].id];
  dep.enrichBusiness = vi.fn(async () => enriched);
  const originals: CollectedSource[] = Array.from({ length: 4 }, (_, index) => ({ ...source, id: index === 0 ? "source1" : `direct-${index}`, kind: "official_website", url: `https://fixture.example/page-${index}`, acquisition: "direct_website" }));
  dep.collectSources = vi.fn(async () => {
    const interim = await store.view(run.id);
    expect(interim.sources).toHaveLength(36);
    expect(interim.sources.some((record) => record.id === discovered.sources[11].id)).toBe(true);
    return { sources: originals, warnings: [] };
  });
  const run = await store.enqueueResearch(business.id, { mode: "live", readWebsite: true, sources: [] });
  await runNextJob({ store, dependencies: dep });
  const result = await store.view(run.id);
  expect(result.stage).toBe("awaiting_selection");
  expect(result.sources).toHaveLength(40);
  expect(result.sources.filter((record) => record.acquisition === "direct_website")).toHaveLength(4);
  expect(result.sources.some((record) => record.id === discovered.sources[11].id)).toBe(true);
  expect(dep.analyzeBusiness).toHaveBeenCalledWith(expect.objectContaining({ sources: result.sources }));
  expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(3);
});

test("live enrichment is checkpointed before analysis and campaign, with one metered optional image request", async () => {
  const business = await client.business.create({ data: BusinessDraftInput.parse({ website: "https://fixture.example/listing" }) });
  const dep = dependencies();
  dep.discoverBusiness = vi.fn(async () => discoveredFixture());
  dep.enrichBusiness = vi.fn(async () => enrichedFixture(business.id));
  const imageUsage = { ...usage, model: "image-test-double-no-inference" };
  dep.createCampaign = vi.fn(async (campaignInput) => {
    await campaignInput.reserveAdditionalModelCall?.();
    return { campaign, usage, additionalUsage: [imageUsage] };
  });
  const run = await store.enqueueResearch(business.id, { mode: "live", readWebsite: false, sources: [] });
  try {
    await runNextJob({ store, dependencies: dep });
    const researched = await store.view(run.id);
    expect(researched.enrichment?.offerings[0].name).toBe("Family dentistry consultation");
    expect(researched.sources[0].id).toBe("enriched1");
    expect(researched.usage).toHaveLength(3);
    expect(dep.analyzeBusiness).toHaveBeenCalledWith(expect.objectContaining({ enrichment: expect.objectContaining({ businessId: business.id }) }));
    await store.enqueueCampaign(run.id, "op1");
    await runNextJob({ store, dependencies: dep });
    const complete = await store.view(run.id);
    expect(complete.status).toBe("completed");
    expect(dep.createCampaign).toHaveBeenCalledWith(expect.objectContaining({ enrichment: expect.objectContaining({ offerings: expect.arrayContaining([expect.objectContaining({ id: "offering1" })]) }) }));
    expect(complete.usage).toHaveLength(5);
    expect(complete.usage[4].model).toBe(imageUsage.model);
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(5);
    expect(dep.enrichBusiness).toHaveBeenCalledTimes(1);
  } finally { await rm(resolve(".data/runs", run.id), { recursive: true, force: true }); }
});

test("completed enrichment survives collection failure and is reused without another paid request", async () => {
  const business = await client.business.create({ data: BusinessDraftInput.parse({ website: "https://fixture.example/listing" }) });
  const dep = dependencies();
  dep.discoverBusiness = vi.fn(async () => discoveredFixture());
  dep.enrichBusiness = vi.fn(async () => enrichedFixture(business.id));
  let collected = false;
  dep.collectSources = vi.fn(async () => {
    if (!collected) { collected = true; throw new Error("Synthetic local collection failure"); }
    return { sources: [source], warnings: [] };
  });
  const run = await store.enqueueResearch(business.id, { mode: "live", readWebsite: false, sources: [] });
  await runNextJob({ store, dependencies: dep });
  const failed = await store.view(run.id);
  expect(failed.enrichment?.status).toBe("enriched");
  expect(failed.usage).toHaveLength(2);
  expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).retrySafe).toBe(true);
  await store.retry(run.id);
  await runNextJob({ store, dependencies: dep });
  expect((await store.view(run.id)).stage).toBe("awaiting_selection");
  expect((await store.view(run.id)).usage).toHaveLength(3);
  expect(dep.discoverBusiness).toHaveBeenCalledTimes(1);
  expect(dep.enrichBusiness).toHaveBeenCalledTimes(1);
  expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(3);
});

test("uncertain enrichment and cross-business enrichment are withheld without paid retries", async () => {
  const business = await client.business.create({ data: BusinessDraftInput.parse({ website: "https://fixture.example/listing" }) });
  const dep = dependencies();
  dep.discoverBusiness = vi.fn(async () => discoveredFixture());
  dep.enrichBusiness = vi.fn(async () => { throw new MetaClientError("REQUEST_TIMEOUT", "Synthetic enrichment timeout", { outcome: "unknown" }); });
  const run = await store.enqueueResearch(business.id, { mode: "live", readWebsite: false, sources: [] });
  await runNextJob({ store, dependencies: dep });
  expect((await store.view(run.id)).discovery?.status).toBe("matched");
  expect((await store.view(run.id)).enrichment).toBeNull();
  expect((await store.view(run.id)).usage).toHaveLength(1);
  expect(dep.analyzeBusiness).not.toHaveBeenCalled();
  await expect(store.retry(run.id)).rejects.toThrow("cannot be retried automatically");
  const other = await store.enqueueResearch(business.id, { mode: "live", readWebsite: false, sources: input.sources });
  dep.enrichBusiness = vi.fn(async () => enrichedFixture("another-business"));
  await runNextJob({ store, dependencies: dep });
  expect((await store.view(other.id)).status).toBe("failed");
  expect((await store.view(other.id)).enrichment).toBeNull();
  await expect(store.retry(other.id)).rejects.toThrow("cannot be retried automatically");
});

test("campaign callbacks permit segmentation and image generation but cannot reserve a third visual request", async () => {
  const dep = dependencies();
  const run = await store.enqueueResearch(businessId, input);
  dep.createCampaign = vi.fn(async (campaignInput) => {
    await campaignInput.reserveAdditionalModelCall?.();
    await campaignInput.reserveAdditionalModelCall?.();
    await expect(campaignInput.reserveAdditionalModelCall?.()).rejects.toThrow("Only two additional visual requests");
    return { campaign, usage };
  });
  try {
    await runNextJob({ store, dependencies: dep });
    await store.enqueueCampaign(run.id, "op1");
    await runNextJob({ store, dependencies: dep });
    expect((await store.view(run.id)).status).toBe("completed");
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(4);
  } finally { await rm(resolve(".data/runs", run.id), { recursive: true, force: true }); }
});

test("campaign preflight failures stay safely retryable without reserving a paid request", async () => {
  const dep = dependencies();
  const run = await store.enqueueResearch(businessId, input);
  dep.assertCampaignInput = vi.fn(() => { throw new Error("Synthetic local evidence eligibility failure"); });
  try {
    await runNextJob({ store, dependencies: dep });
    const savedResearch = (await store.view(run.id)).report;
    await store.enqueueCampaign(run.id, "op1");
    await runNextJob({ store, dependencies: dep });
    const failed = await store.view(run.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("No model request was made");
    expect(failed.report).toEqual(savedResearch);
    expect(dep.createCampaign).not.toHaveBeenCalled();
    const failedRecord = await client.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(failedRecord.retrySafe).toBe(true);
    expect(failedRecord.modelCalls).toBe(1); // Only the completed research request.
    expect(failed.usage).toHaveLength(1);
    dep.assertCampaignInput = vi.fn(() => {});
    await store.retry(run.id);
    await runNextJob({ store, dependencies: dep });
    expect((await store.view(run.id)).status).toBe("completed");
    expect(dep.analyzeBusiness).toHaveBeenCalledTimes(1);
    expect(dep.createCampaign).toHaveBeenCalledTimes(1);
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(2);
  } finally { await rm(resolve(".data/runs", run.id), { recursive: true, force: true }); }
});

test("recovery of validated completed copy reserves only the remaining image request", async () => {
  const dep = dependencies();
  const run = await store.enqueueResearch(businessId, input);
  const checkpointText = "previously-completed-and-validated-copy-fixture";
  const outputDir = resolve(".data/runs", run.id);
  const imageUsage = { ...usage, model: "image-test-double-no-inference" };
  dep.hasCopyCheckpoint = async (campaignInput) => (await readFile(join(campaignInput.outputDir, "copy-checkpoint.json"), "utf8").catch(() => null)) === checkpointText;
  dep.createCampaign = vi.fn(async (campaignInput) => {
    expect(campaignInput.requireCompletedCopy).toBe(true);
    expect(campaignInput.reuseCompletedCopyOnly).not.toBe(true);
    expect(await readFile(join(campaignInput.outputDir, "copy-checkpoint.json"), "utf8")).toBe(checkpointText);
    await campaignInput.reserveAdditionalModelCall?.();
    return { campaign, usage, additionalUsage: [imageUsage] };
  });
  try {
    await runNextJob({ store, dependencies: dep });
    const savedReport = (await store.view(run.id)).report;
    await store.enqueueCampaign(run.id, "op1");
    // Model a separately audited completed copy request whose valid checkpoint is now available.
    await client.run.update({ where: { id: run.id }, data: { modelCalls: { increment: 1 } } });
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "copy-checkpoint.json"), checkpointText);
    await runNextJob({ store, dependencies: dep });
    const complete = await store.view(run.id);
    expect(complete.status).toBe("completed");
    expect(complete.report).toEqual(savedReport);
    expect(complete.events.some((item) => item.message.includes("Reusing completed campaign copy"))).toBe(true);
    expect(dep.analyzeBusiness).toHaveBeenCalledTimes(1);
    expect(dep.createCampaign).toHaveBeenCalledTimes(1);
    expect(complete.usage).toHaveLength(3);
    // One original research request, one prior copy request, and exactly one new image reservation.
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(3);
  } finally { await rm(outputDir, { recursive: true, force: true }); }
});

test("completed copy responses that fail validation can only be explicitly revalidated locally without another copy request", async () => {
  const dep = dependencies();
  const run = await store.enqueueResearch(businessId, input);
  const savedResponse = "input-bound-completed-copy-response-fixture";
  let copyCalls = 0;
  let validationFixed = false;
  dep.hasBoundCompletedCopy = async (campaignInput) => (await readFile(join(campaignInput.outputDir, "copy-response.json"), "utf8").catch(() => null)) === savedResponse;
  dep.hasCopyCheckpoint = vi.fn(async () => { throw new Error("Invalid completed output must not be tested to decide whether to pay again."); });
  dep.createCampaign = vi.fn(async (campaignInput) => {
    if (!campaignInput.requireCompletedCopy) {
      copyCalls++;
      await writeFile(join(campaignInput.outputDir, "copy-response.json"), savedResponse);
    }
    if (!validationFixed) throw new CampaignCopyValidationError();
    await campaignInput.reserveAdditionalModelCall?.();
    return { campaign, usage, additionalUsage: [{ ...usage, model: "image-test-double-no-inference" }] };
  });
  try {
    await runNextJob({ store, dependencies: dep });
    await store.enqueueCampaign(run.id, "op1");
    // No completed record exists yet; the valid cache lookup reports absence on the first attempt.
    const completedLookup = dep.hasCopyCheckpoint;
    dep.hasCopyCheckpoint = async () => false;
    await runNextJob({ store, dependencies: dep });
    expect((await store.view(run.id)).status).toBe("failed");
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).retrySafe).toBe(true);
    expect(await runNextJob({ store, dependencies: dep })).toBeNull();
    dep.hasCopyCheckpoint = completedLookup;
    await store.retry(run.id);
    await runNextJob({ store, dependencies: dep });
    expect((await store.view(run.id)).status).toBe("failed");
    expect(copyCalls).toBe(1);
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(2);
    expect(dep.hasCopyCheckpoint).not.toHaveBeenCalled();
    validationFixed = true;
    await store.retry(run.id);
    await runNextJob({ store, dependencies: dep });
    const complete = await store.view(run.id);
    expect(complete.status).toBe("completed");
    expect(complete.report).toEqual(report);
    expect(copyCalls).toBe(1);
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCalls).toBe(3);
    expect(complete.usage).toHaveLength(3);
  } finally { await rm(resolve(".data/runs", run.id), { recursive: true, force: true }); }
});

test("an unbound completed-response error or corrupt response record never authorizes a safe paid retry", async () => {
  const dep = dependencies();
  const run = await store.enqueueResearch(businessId, input);
  dep.createCampaign = vi.fn(async () => { throw new CampaignCopyValidationError(); });
  try {
    await runNextJob({ store, dependencies: dep });
    await store.enqueueCampaign(run.id, "op1");
    await runNextJob({ store, dependencies: dep });
    expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).retrySafe).toBe(false);
    await expect(store.retry(run.id)).rejects.toThrow("cannot be retried automatically");
    const another = await store.enqueueResearch(businessId, { ...input, readWebsite: true });
    await runNextJob({ store, dependencies: dep });
    await store.enqueueCampaign(another.id, "op1");
    dep.hasBoundCompletedCopy = async () => { throw new Error("Corrupt response record"); };
    await runNextJob({ store, dependencies: dep });
    expect((await client.run.findUniqueOrThrow({ where: { id: another.id } })).modelCalls).toBe(1);
    expect((await client.run.findUniqueOrThrow({ where: { id: another.id } })).retrySafe).toBe(false);
    await rm(resolve(".data/runs", another.id), { recursive: true, force: true });
  } finally { await rm(resolve(".data/runs", run.id), { recursive: true, force: true }); }
});

test("Autopilot auto-selects the recommended opportunity and continues to production in the same run", async () => {
  const dep = dependencies();
  const run = await store.enqueueResearch(businessId, { ...input, autopilot: true });
  expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCallLimit).toBeGreaterThan(6);
  try {
    await runNextJob({ store, dependencies: dep });
    const selected = await store.view(run.id);
    expect(selected.autopilot).toBe(true);
    expect(selected.status).toBe("queued");
    expect(selected.stage).toBe("creating");
    expect(selected.selection).toEqual(expect.objectContaining({ opportunityId: "op1", selectedBy: "autopilot", basis: "report_recommendation" }));
    // Repeating the same choice is idempotent and leaves the queued Autopilot production unchanged.
    await store.enqueueCampaign(run.id, "op1");
    expect((await store.view(run.id)).selection).toEqual(expect.objectContaining({ selectedBy: "autopilot" }));
    await runNextJob({ store, dependencies: dep });
    expect(dep.createCampaign).toHaveBeenCalledWith(expect.objectContaining({ opportunityId: "op1" }));
    expect((await store.view(run.id)).stage).toBe("needs_review");
  } finally { await rm(resolve(".data/runs", run.id), { recursive: true, force: true }); }
});

test("an Autopilot paid step with an unknown outcome, or a used-up copy budget, is never offered as a safe retry", async () => {
  const { AutopilotPaidStepError, AutopilotResumableError } = await import("../../lib/autopilot/production-types");
  const { AutopilotBudgetError } = await import("../../lib/autopilot/budget");
  const cases: Array<{ error: () => Error; retrySafe: boolean; message: RegExp }> = [
    { error: () => new AutopilotResumableError(), retrySafe: true, message: /saved every completed Meta response/ },
    { error: () => new AutopilotPaidStepError(), retrySafe: false, message: /may have been lost/ },
    { error: () => new AutopilotBudgetError("spark_copy"), retrySafe: false, message: /copy request budget for this run is already used/ },
  ];
  for (const [index, { error, retrySafe, message }] of cases.entries()) {
    const dep = dependencies();
    dep.produceAutopilotCampaign = vi.fn(async () => { throw error(); });
    // Distinct input per case: identical research input would reuse the first run.
    const run = await store.enqueueResearch(businessId, { ...input, autopilot: true, sources: [{ ...input.sources[0], text: `${input.sources[0].text} Case ${index + 1}.` }] });
    try {
      await runNextJob({ store, dependencies: dep });
      await runNextJob({ store, dependencies: dep });
      expect(dep.produceAutopilotCampaign).toHaveBeenCalledTimes(1);
      const stored = await client.run.findUniqueOrThrow({ where: { id: run.id } });
      expect(stored.status).toBe("failed");
      expect(stored.retrySafe).toBe(retrySafe);
      expect(stored.error).toMatch(message);
    } finally { await rm(resolve(".data/runs", run.id), { recursive: true, force: true }); }
  }
});

test("manual runs still wait for the owner's selection", async () => {
  const run = await store.enqueueResearch(businessId, input);
  expect((await client.run.findUniqueOrThrow({ where: { id: run.id } })).modelCallLimit).toBe(6);
  await runNextJob({ store, dependencies: dependencies() });
  const view = await store.view(run.id);
  expect(view.autopilot).toBe(false);
  expect(view.stage).toBe("awaiting_selection");
  expect(view.selection).toBeNull();
});

test("owner approval binds to the exact bytes and rejects a changed file", async () => {
  const { manifestDigest, approvableFiles } = await import("../../lib/jobs/approval");
  const { createHash } = await import("node:crypto");
  const dep = dependencies();
  const runsRoot = join(directory, "runs");
  const run = await store.enqueueResearch(businessId, { ...input, autopilot: true });
  const bytes = Buffer.from("synthetic reel bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const kit: CampaignKit = { ...campaign, id: "kit-approval", assets: [{ id: "reel", channel: "instagram_reels", filename: "instagram_reel.mp4", mediaType: "video", width: 1080, height: 1920, sha256, bytes: bytes.length }] };
  dep.createCampaign = vi.fn(async () => ({ campaign: kit, usage }));
  await runNextJob({ store, dependencies: dep });
  await runNextJob({ store, dependencies: dep });
  await mkdir(join(runsRoot, run.id), { recursive: true });
  await writeFile(join(runsRoot, run.id, "instagram_reel.mp4"), bytes);
  const digest = manifestDigest(kit.id, approvableFiles(kit));
  await expect(store.approveCampaign(run.id, "0".repeat(64), { runsRoot })).rejects.toThrow("changed since you reviewed");
  await writeFile(join(runsRoot, run.id, "instagram_reel.mp4"), Buffer.from("tampered reel bytes!"));
  await expect(store.approveCampaign(run.id, digest, { runsRoot })).rejects.toThrow("changed or is missing");
  await writeFile(join(runsRoot, run.id, "instagram_reel.mp4"), bytes);
  const approved = await store.approveCampaign(run.id, digest, { runsRoot });
  expect(approved.approval?.manifestDigest).toBe(digest);
  expect(approved.approval?.scope).toBe("owner_approved_concept_not_published");
  expect(approved.stage).toBe("owner_approved");
  await expect(store.approveCampaign(run.id, digest, { runsRoot })).rejects.toThrow("already approved");
  await rm(resolve(".data/runs", run.id), { recursive: true, force: true });
});
