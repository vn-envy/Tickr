import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ResearchReportSchema, CampaignKitSchema, type RunView } from "../lib/research/contracts";
import { VerticalSchema } from "../lib/schemas/common";

const base = process.env.TICKR_SMOKE_URL || "http://127.0.0.1:3000";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("Smoke checks only target the local app.");
if (!process.argv.includes("--live-meta")) throw new Error("This check makes up to two paid Meta calls using fictional data. Explicitly pass --live-meta.");
const verticalOptions = process.argv.filter((argument) => argument.startsWith("--vertical="));
if (verticalOptions.length > 1) throw new Error("Choose one vertical per smoke run.");
if (process.argv.slice(2).some((argument) => argument !== "--live-meta" && !argument.startsWith("--vertical="))) throw new Error("Use --live-meta with optional --vertical=bakery|dentist|gym|salon.");
const vertical = VerticalSchema.parse(verticalOptions[0]?.slice("--vertical=".length) ?? "bakery");
const resultPath = vertical === "bakery" ? ".data/build-smoke.json" : `.data/build-smoke-${vertical}.json`;
let businessId: string | null = null;
let runId: string | null = null;

async function json(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, body === undefined ? { signal: AbortSignal.timeout(15_000) } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}. ${result.error || "Request failed"}`);
  return result;
}

async function waitForRun(id: string, expected: string, timeoutMs: number): Promise<RunView> {
  const end = Date.now() + timeoutMs;
  let lastStage = "";
  while (Date.now() < end) {
    const { run } = await json(`/api/runs/${id}`) as { run: RunView };
    if (run.stage !== lastStage) { console.log(`Run stage: ${run.stage}`); lastStage = run.stage; }
    if (run.status === "failed" || run.stage === "interrupted") throw new Error(run.error || "Run stopped.");
    if (run.stage === expected) return run;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("Timed out waiting for the local worker; no retry or new paid request was made.");
}

async function main() {
  const fixture = JSON.parse(await readFile(`tests/fixtures/synthetic-${vertical}.json`, "utf8"));
  assert.equal(fixture.business.vertical, vertical);
  assert.equal(fixture.input.mode, "synthetic");
  const { business } = await json("/api/businesses", fixture.business);
  businessId = business.id;
  const { run: queued } = await json(`/api/businesses/${business.id}/runs`, fixture.input);
  runId = queued.id;
  console.log(`Synthetic ${vertical} verification run: ${queued.id}`);
  const researched = await waitForRun(queued.id, "awaiting_selection", 210_000);
  const report = ResearchReportSchema.parse(researched.report);
  assert.equal(report.mode, "synthetic");
  assert.ok(report.evidence.length > 0);
  assert.ok(report.opportunities.length > 0);
  assert.equal(report.findings.length >= 4, true);
  const opportunityId = report.recommendedOpportunityId || report.opportunities[0].id;
  await json(`/api/runs/${queued.id}/campaign`, { opportunityId });
  const completed = await waitForRun(queued.id, "needs_review", 360_000);
  const campaign = CampaignKitSchema.parse(completed.campaign);
  assert.equal(campaign.mode, "synthetic");
  assert.equal(campaign.status, "concept_needs_review");
  assert.equal(new Set(campaign.channels.map((channel) => channel.id)).size, 7);
  assert.ok(campaign.assets.some((asset) => asset.mediaType === "video"));
  assert.ok(campaign.assets.some((asset) => asset.mediaType === "archive"));
  for (const asset of campaign.assets) {
    const response = await fetch(`${base}/api/runs/${queued.id}/files/${encodeURIComponent(asset.filename)}`, { signal: AbortSignal.timeout(60_000) });
    assert.equal(response.status, 200, asset.filename);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, asset.bytes, asset.filename);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256, asset.filename);
  }
  await mkdir(".data", { recursive: true });
  const result = { checkedAt: new Date().toISOString(), vertical, passed: true, mode: "synthetic inputs with live Meta inference", runId: queued.id, businessId: business.id, sourceCount: researched.sources.length, evidenceCount: report.evidence.length, opportunities: report.opportunities.length, channels: campaign.channels.length, assets: campaign.assets.length, usage: completed.usage, status: campaign.status, scope: "Software and live API verification only; no real business validation or owner-approved campaign." };
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "Research check failed.";
  const result = { checkedAt: new Date().toISOString(), vertical, passed: false, mode: "synthetic inputs with live Meta inference", runId, businessId, error: message, note: "No automatic retry was made. A timed-out worker may still be running; inspect this run before any new paid action.", scope: "Software check only; no real business validation." };
  await mkdir(".data", { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n");
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
});
