import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { RunView } from "../lib/research/contracts";

const base = process.env.TICKR_SMOKE_URL || "http://127.0.0.1:3000";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("Only the local app can be tested.");
if (!process.argv.includes("--live-meta")) throw new Error("This test makes up to five paid Meta requests (discovery, enrichment, analysis, copy, image). Pass --live-meta explicitly.");
const option = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const businessUrl = option("url") || "https://maps.app.goo.gl/nNy6iYx9r4GaU7YY8";
const goal = option("goal") || "Find the strongest source-supported campaign opportunity for this business and its exact location, using real offerings, customer signals and relevant current context.";
const reportName = option("report") || "real-link-smoke";
if (!/^[a-z0-9-]{1,80}$/.test(reportName)) throw new Error("Use a simple diagnostic report name.");
const reportFile = `.data/${reportName}.json`;
const resumeId = option("resume");
if (resumeId && !/^[0-9a-f-]{36}$/.test(resumeId)) throw new Error("Use a saved run UUID for explicit safe retry.");
let runId: string | null = null;
async function request(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20000), ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error || "Request failed"}`);
  return result;
}
async function waitFor(stage: string): Promise<RunView> {
  const deadline = Date.now() + 360000;
  let last = "";
  while (Date.now() < deadline) {
    const { run } = await request(`/api/runs/${runId}`) as { run: RunView };
    if (run.stage !== last) { console.log(`Stage: ${run.stage}`); last = run.stage; }
    if (run.stage === stage) return run;
    if (["failed", "interrupted", "awaiting_owner"].includes(run.stage)) throw new Error(run.error || "The link could not establish sufficient evidence.");
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("The worker did not finish within the verification window. No paid request was retried.");
}
async function main() {
  const existing = resumeId ? (await request(`/api/runs/${resumeId}`)).run as RunView : null;
  const { business } = existing ? await request(`/api/businesses/${existing.businessId}`) : await request("/api/businesses", { website: businessUrl, goal });
  assert.equal(business.name, "");
  assert.equal(business.locality, "");
  const { run } = existing ? await request(`/api/runs/${existing.id}/retry`, {}) : await request(`/api/businesses/${business.id}/runs`, { mode: "live", sources: [], readWebsite: true, discoverFromLink: true, enrichFromLink: true });
  runId = run.id;
  console.log(`Public-link verification run: ${runId}`);
  const researched = existing ?? await waitFor("awaiting_selection");
  assert.equal(researched.discovery?.status, "matched");
  if (business.website?.includes("nNy6iYx9r4GaU7YY8")) assert.match(researched.business.name, /daphne/i);
  assert.ok(researched.business.vertical.trim(), "Expected a researched business category.");
  if (option("expect-category")) assert.equal(researched.business.vertical.toLowerCase(), option("expect-category")!.toLowerCase());
  assert.ok(researched.sources.length > 0);
  assert.ok(researched.sources.every((source) => source.acquisition !== "owner_supplied"));
  assert.ok(researched.sources.some((source) => source.citation?.searchCallIds.length));
  assert.ok(researched.report?.opportunities.length);
  assert.ok(researched.enrichment);
  if (option("expect-branch")) assert.equal((researched.enrichment.branch ?? researched.discovery?.branch)?.status, option("expect-branch"));
  if (process.argv.includes("--expect-offering")) assert.ok(researched.enrichment.offerings.length, "Expected named offerings from this public menu.");
  const opportunityId = researched.report!.recommendedOpportunityId || researched.report!.opportunities[0].id;
  if (!existing) await request(`/api/runs/${runId}/campaign`, { opportunityId });
  const completed = await waitFor("needs_review");
  assert.equal(completed.campaign?.mode, "live");
  assert.equal(completed.campaign?.status, "concept_needs_review");
  assert.equal(completed.campaign?.channels.length, 7);
  assert.ok(completed.campaign?.assets.some((asset) => asset.mediaType === "video"));
  assert.ok(completed.campaign?.assets.some((asset) => asset.mediaType === "archive"));
  assert.ok(completed.campaign?.creativeBrief);
  if (process.argv.includes("--expect-offering")) assert.ok(completed.campaign.creativeBrief.focus.offeringId, "Expected selection of a real discovered offering.");
  if (process.argv.includes("--expect-visual")) assert.notEqual(completed.campaign?.visual?.kind, "typography");
  for (const asset of completed.campaign!.assets) {
    const response = await fetch(`${base}/api/runs/${runId}/files/${encodeURIComponent(asset.filename)}`, { signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, asset.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
  }
  const result = { checkedAt: new Date().toISOString(), passed: true, runId, originalInput: { website: business.website, goal: business.goal, name: business.name, locality: business.locality, suppliedSources: 0 }, discoveredBusiness: completed.business, discovery: completed.discovery, enrichment: completed.enrichment, creativeBrief: completed.campaign.creativeBrief, visual: completed.campaign.visual, sources: completed.sources.map(({ id, title, url, acquisition, citation, context }) => ({ id, title, url, acquisition, citation, context })), evidence: completed.report!.evidence.length, opportunities: completed.report!.opportunities.length, channels: completed.campaign!.channels.length, files: completed.campaign!.assets.length, usage: completed.usage, status: completed.campaign!.status, scope: "Real public-link extraction and campaign concepts; model-linked summaries are not original quotations or owner-approved facts. Generated imagery is illustrative, not actual product photography." };
  await mkdir(".data", { recursive: true });
  await writeFile(reportFile, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, runId, business: completed.business.name, locality: completed.business.locality, sources: completed.sources.length, evidence: result.evidence, channels: result.channels, files: result.files }));
}
main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : "Link verification failed.";
  await mkdir(".data", { recursive: true });
  await writeFile(reportFile, JSON.stringify({ checkedAt: new Date().toISOString(), passed: false, runId, error: message }, null, 2) + "\n");
  console.error(message); process.exitCode = 1;
});
