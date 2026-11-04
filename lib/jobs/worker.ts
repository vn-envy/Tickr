import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MetaClientError } from "../meta/config";
import { CampaignCopyValidationError, CampaignRenderError, type CreateCampaignInput } from "../campaign/index";
import { AnalysisValidationError, type AnalyzeBusinessInput } from "../research/analyze";
import { reconcileLocationScopes } from "../research/grounding";
import {
  BusinessContextSchema, ResearchInputSchema, ResearchReportSchema, CollectedSourceSchema,
  type BusinessContext, type BusinessDiscovery, type ResearchInput, type CollectedSource, type ResearchReport, type ModelUsage, type CampaignKit,
} from "../research/contracts";
import { contentHash, jobs, RESEARCH_WORKFLOW_VERSION, type JobStore } from "./store";
import { prepareDiscoveryCheckpoint, prepareEnrichmentCheckpoint, discoveryNeedsIdentityConfirmation, mergeResearchSources, requiredResearchSourceIds, resolveEnrichedBusiness, type DiscoveryCheckpoint, type EnrichmentCheckpoint } from "./discovery";

export interface WorkerDependencies {
  discoverBusiness: (business: BusinessContext) => Promise<{ discovery: BusinessDiscovery; sources: CollectedSource[]; usage: ModelUsage }>;
  enrichBusiness: (input: { business: BusinessContext; discovery: BusinessDiscovery; sources: CollectedSource[] }) => Promise<EnrichmentCheckpoint>;
  collectSources: (business: BusinessContext, input: ResearchInput) => Promise<{ sources: CollectedSource[]; warnings: string[] }>;
  assertAnalysisInput: (input: AnalyzeBusinessInput) => void | Promise<void>;
  analyzeBusiness: (input: AnalyzeBusinessInput) => Promise<{ report: ResearchReport; usage: ModelUsage }>;
  hasBoundCompletedAnalysis: (input: AnalyzeBusinessInput) => Promise<boolean>;
  assertCampaignInput: (input: CreateCampaignInput) => void | Promise<void>;
  createCampaign: (input: CreateCampaignInput) => Promise<{ campaign: CampaignKit; usage: ModelUsage; additionalUsage?: ModelUsage[] }>;
  hasCopyCheckpoint: (input: CreateCampaignInput) => Promise<boolean>;
  hasBoundCompletedCopy: (input: CreateCampaignInput) => Promise<boolean>;
  credentialPresent: () => boolean;
}

async function defaultDependencies(): Promise<WorkerDependencies> {
  const [{ collectSources }, { analyzeBusiness, assertAnalysisInput, hasBoundCompletedAnalysis }, { createCampaign, readCopyCheckpoint, hasBoundCompletedCopy, assertCampaignInput }, { discoverBusiness }, { enrichBusiness }] = await Promise.all([
    import("../research/collect-sources"), import("../research/analyze"), import("../campaign/index"), import("../research/discover"), import("../research/enrich"),
  ]);
  return {
    collectSources, analyzeBusiness, assertAnalysisInput, hasBoundCompletedAnalysis, createCampaign, assertCampaignInput, hasBoundCompletedCopy, discoverBusiness, enrichBusiness,
    hasCopyCheckpoint: async (input) => {
      const opportunity = input.report.opportunities.find((item) => item.id === input.opportunityId);
      return Boolean(opportunity && await readCopyCheckpoint(input, opportunity));
    },
    credentialPresent: () => Boolean(process.env.META_API_KEY?.trim()),
  };
}

async function copyCheckpointHash(input: CreateCampaignInput): Promise<string> {
  return createHash("sha256").update(await readFile(resolve(input.outputDir, "copy-checkpoint.json"))).digest("hex");
}

async function analysisResponseHash(input: AnalyzeBusinessInput): Promise<string> {
  if (!input.outputDir) throw new Error("The analysis response directory is missing.");
  return createHash("sha256").update(await readFile(resolve(input.outputDir, "analysis-response.json"))).digest("hex");
}

function publicFailure(error: unknown, paidRequestStarted: boolean): string {
  if (error instanceof MetaClientError) return `${error.message}. No automatic retry was made.`;
  if (!paidRequestStarted) return "The stage stopped before model execution. Check the saved sources and local setup; a safe retry is available.";
  return "The stage could not produce a valid, complete result. Saved research is preserved. A Meta request may have completed, so it was not retried automatically.";
}

/** One durable lease at a time; input injection makes worker recovery tests network-free. */
export async function runNextJob(options: { store?: JobStore; dependencies?: WorkerDependencies; owner?: string } = {}): Promise<string | null> {
  const store = options.store ?? jobs;
  await store.recoverExpired();
  const owner = options.owner ?? randomUUID();
  const id = await store.claim(owner);
  if (!id) return null;
  let paidRequestStarted = false;
  let campaignPreflightRejected = false;
  let analysisPreflightRejected = false;
  let completedAnalysisReused = false;
  let completedCopyReused = false;
  let safeBeforeModel = true;
  let dependencies: WorkerDependencies | undefined;
  let renderInput: CreateCampaignInput | undefined;
  let analysisInput: AnalyzeBusinessInput | undefined;
  let lostLease = false;
  const heartbeat = setInterval(() => {
    void store.heartbeat(id, owner).then((owned) => { if (!owned) lostLease = true; }).catch(() => { lostLease = true; });
  }, 20_000);
  try {
    dependencies = options.dependencies ?? await defaultDependencies();
    const run = await store.load(id);
    const inputCheckpoint = run.artifacts.find((item) => item.stage === "input")?.payload as { business?: unknown; input?: unknown; workflowVersion?: string } | undefined;
    const originalBusiness = BusinessContextSchema.parse(inputCheckpoint?.business);
    let discovery = run.artifacts.find((item) => item.stage === "discovery")?.payload as unknown as DiscoveryCheckpoint | undefined;
    let enrichment = run.artifacts.find((item) => item.stage === "enrichment")?.payload as unknown as EnrichmentCheckpoint | undefined;
    let business = resolveEnrichedBusiness(BusinessContextSchema.parse(discovery?.resolvedBusiness ?? originalBusiness), enrichment, discovery?.sources);
    const input = ResearchInputSchema.parse(inputCheckpoint?.input);
    const sourceCheckpoint = run.artifacts.find((item) => item.stage === "sources")?.payload as { sources?: unknown[] } | undefined;
    let sources = sourceCheckpoint?.sources?.map((item) => CollectedSourceSchema.parse(item));

    if (run.jobKind === "research") {
      if (input.mode === "live" && originalBusiness.website && input.discoverFromLink !== false && !discovery) {
        if (!dependencies.credentialPresent()) {
          await store.fail(id, owner, "Meta credentials are not available to the worker. Apply the existing environment key and retry business-link discovery; no discovery request was made.", true);
          return id;
        }
        await store.markStage(id, owner, "discovering", "Resolving the business link and researching its identity, locality, offerings and public context through Meta search.");
        await store.reserveModelCall(id, owner);
        paidRequestStarted = true;
        const result = await dependencies.discoverBusiness(originalBusiness);
        if (lostLease) throw new Error("Worker lease was lost.");
        discovery = prepareDiscoveryCheckpoint(originalBusiness, result);
        business = discovery.resolvedBusiness;
        await store.checkpointDiscovery(id, owner, discovery);
        // Discovery is known to have finished and is durably stored. Subsequent local collection may safely resume it.
        paidRequestStarted = false;
      }
      if (discovery && discoveryNeedsIdentityConfirmation(discovery)) {
        await store.awaitIdentity(id, owner, discovery.discovery.status === "ambiguous"
          ? "Research found candidate sources but could not confidently establish the business identity. Review the discovered links; an alternative public business link can help resolve this without writing a marketing brief."
          : "The discovery attempt could not establish a cited business identity from this link. Confirm one matching business or share its public website or profile link; you do not need to write its story or a marketing brief.");
        return id;
      }
      if (input.mode === "live" && input.discoverFromLink !== false && input.enrichFromLink !== false
        && discovery?.discovery.status === "matched" && !enrichment
        && ([RESEARCH_WORKFLOW_VERSION, "research-3-enrichment"].includes(inputCheckpoint?.workflowVersion ?? "") || !sources)) {
        if (!dependencies.credentialPresent()) {
          await store.fail(id, owner, "Meta credentials are not available to the worker. The discovered identity is saved; retry enrichment after applying the existing key. No enrichment request was made.", true);
          return id;
        }
        await store.markStage(id, owner, "enriching", "Researching offerings, brand, customer and competitor signals, location scope and current context from public sources.");
        await store.reserveModelCall(id, owner);
        paidRequestStarted = true;
        const result = await dependencies.enrichBusiness({ business, discovery: discovery.discovery, sources: discovery.sources });
        if (lostLease) throw new Error("Worker lease was lost.");
        enrichment = prepareEnrichmentCheckpoint(business, discovery.sources, result);
        await store.checkpointEnrichment(id, owner, enrichment);
        business = resolveEnrichedBusiness(business, enrichment, discovery.sources);
        // Completed enrichment and its usage are durable; local collection can resume without another paid search.
        paidRequestStarted = false;
      }
      if (!sources) {
        await store.markStage(id, owner, "ingesting", "Organizing enriched offerings, discovered citations, supplied evidence and permitted official-site text.");
        const collected = await dependencies.collectSources(business, input);
        const merged = mergeResearchSources([...(enrichment?.sources ?? []), ...(discovery?.sources ?? [])], collected.sources.map((item) => CollectedSourceSchema.parse(item)), requiredResearchSourceIds(discovery?.discovery, enrichment?.enrichment));
        const branch = enrichment?.enrichment.branch?.status === "matched" ? enrichment.enrichment.branch : discovery?.discovery.branch?.status === "matched" ? discovery.discovery.branch : enrichment?.enrichment.branch ?? discovery?.discovery.branch;
        sources = reconcileLocationScopes(merged.sources, branch);
        await store.checkpointSources(id, owner, sources, [...collected.warnings, ...merged.warnings]);
      }
      if (sources.length === 0) {
        await store.noSources(id, owner);
        return id;
      }
      analysisInput = { business, sources, mode: input.mode, outputDir: resolve(".data/runs", id), ...(enrichment ? { enrichment: enrichment.enrichment } : {}) };
      try { await dependencies.assertAnalysisInput(analysisInput); }
      catch (error) { analysisPreflightRejected = true; throw error; }
      const resume = run.artifacts.find((item) => item.stage === "analysis_resume")?.payload as { responseHash?: string } | undefined;
      safeBeforeModel = false;
      if (resume || await dependencies.hasBoundCompletedAnalysis(analysisInput)) {
        if (resume && (!resume.responseHash || await analysisResponseHash(analysisInput) !== resume.responseHash || !await dependencies.hasBoundCompletedAnalysis(analysisInput))) {
          throw new Error("The completed analysis response is unavailable or changed.");
        }
        analysisInput.requireCompletedResponse = true;
        completedAnalysisReused = true;
        await store.markStage(id, owner, "researching", "Revalidating the saved completed analysis response locally. No additional Meta analysis request is needed.");
      } else {
        safeBeforeModel = true;
        if (!dependencies.credentialPresent()) {
          await store.fail(id, owner, "Meta credentials are not available to the worker. Apply the existing environment key and restart the worker; no model request was made.", true);
          return id;
        }
        await store.markStage(id, owner, "researching", "Meta is analyzing business strengths, customer evidence, competitors and content from the collected sources. Search snippets and cited summaries retain their provenance.");
        await store.reserveModelCall(id, owner);
        paidRequestStarted = true;
      }
      const result = await dependencies.analyzeBusiness(analysisInput);
      if (lostLease) throw new Error("Worker lease was lost.");
      await store.completeResearch(id, owner, result.report, result.usage);
    } else if (run.jobKind === "campaign") {
      const reportCheckpoint = run.artifacts.find((item) => item.stage === "report");
      const selection = run.artifacts.find((item) => item.stage === "selection")?.payload as { opportunityId?: string; reportHash?: string } | undefined;
      const report = ResearchReportSchema.parse(reportCheckpoint?.payload);
      if (!reportCheckpoint || !selection?.opportunityId || selection.reportHash !== contentHash(reportCheckpoint.payload)
        || !report.opportunities.some((item) => item.id === selection.opportunityId) || !sources?.length) throw new Error("Campaign input checkpoints are incomplete.");
      const outputDir = resolve(".data/runs", id);
      await mkdir(outputDir, { recursive: true });
      let additionalCallsReserved = 0;
      renderInput = {
        business, sources, report, opportunityId: selection.opportunityId, mode: input.mode, outputDir,
        ...(enrichment ? { enrichment: enrichment.enrichment } : {}),
        reserveAdditionalModelCall: async () => {
          if (lostLease) throw new Error("Worker lease was lost before the additional model request.");
          if (renderInput?.reuseCompletedCopyOnly) throw new Error("A render-only retry cannot start a new paid image request.");
          if (additionalCallsReserved >= 2) throw new Error("Only two additional visual requests are allowed for this campaign stage.");
          await store.reserveModelCall(id, owner);
          additionalCallsReserved++;
          paidRequestStarted = true;
        },
      };
      try { await dependencies.assertCampaignInput(renderInput); }
      catch (error) { campaignPreflightRejected = true; throw error; }
      const resume = run.artifacts.find((item) => item.stage === "render_resume")?.payload as { copyCheckpointHash?: string } | undefined;
      // Any damaged paid-response artifact must fail closed. Only absence of both completed records permits a fresh request.
      safeBeforeModel = false;
      if (resume) {
        // A vanished checkpoint must not turn a previously local-only retry into a new paid call.
        safeBeforeModel = false;
        if (!resume.copyCheckpointHash || await copyCheckpointHash(renderInput) !== resume.copyCheckpointHash || !await dependencies.hasCopyCheckpoint(renderInput)) {
          throw new Error("The completed copy checkpoint is unavailable or changed.");
        }
        renderInput.reuseCompletedCopyOnly = true;
        await store.markStage(id, owner, "creating", "Resuming local rendering from the verified completed copy checkpoint. No new Meta request is needed.");
      } else if (await dependencies.hasBoundCompletedCopy(renderInput) || await dependencies.hasCopyCheckpoint(renderInput)) {
        // Recover completed text without treating an unfinished visual as a local-only render retry.
        renderInput.requireCompletedCopy = true;
        completedCopyReused = true;
        safeBeforeModel = false;
        await store.markStage(id, owner, "creating", "Reusing completed campaign copy and preparing its visual. No additional copy request is needed.");
      } else {
        safeBeforeModel = true;
        if (!dependencies.credentialPresent()) {
          await store.fail(id, owner, "Meta credentials are not available to the worker. Apply the existing environment key and restart the worker; no campaign request was made.", true);
          return id;
        }
        await store.markStage(id, owner, "creating", "Creating channel copy and a source-informed visual, then rendering the campaign for review.");
        await store.reserveModelCall(id, owner);
        paidRequestStarted = true;
      }
      const result = await dependencies.createCampaign(renderInput);
      if (lostLease) throw new Error("Worker lease was lost.");
      await store.completeCampaign(id, owner, result.campaign, result.usage, result.additionalUsage);
    } else {
      throw new Error("Unsupported job kind.");
    }
  } catch (error) {
    let message = analysisPreflightRejected
      ? "Research input validation stopped before analysis. No analysis request was made. Saved discovery and sources can be retried after the input or validation issue is corrected."
      : campaignPreflightRejected
      ? "Campaign input validation stopped before generation. No model request was made. Saved research can be retried after the input or validation issue is corrected."
      : completedCopyReused && !paidRequestStarted
      ? "Completed campaign copy was reused, but the remaining stage could not finish safely. No new copy request was made; retry is withheld until its saved checkpoints are reviewed."
      : completedAnalysisReused && !paidRequestStarted
      ? "The completed analysis response was reused, but local validation could not finish safely. No new Meta analysis request was made; review its saved checkpoint."
      : analysisInput && !safeBeforeModel && !paidRequestStarted
      ? "The completed analysis checkpoint could not be verified. No new Meta request was made; retry is withheld to avoid repeating paid analysis."
      : !safeBeforeModel && !paidRequestStarted
      ? "The completed campaign checkpoint could not be verified. No new Meta request was made; retry is withheld to avoid regenerating paid copy."
      : publicFailure(error, paidRequestStarted);
    let retrySafe = !paidRequestStarted && safeBeforeModel;
    if (analysisInput && dependencies && !analysisPreflightRejected) {
      try {
        if (await dependencies.hasBoundCompletedAnalysis(analysisInput)) {
          await store.checkpointLocalAnalysis(id, owner, await analysisResponseHash(analysisInput));
          message = error instanceof AnalysisValidationError ? error.message : "Meta completed the analysis response and it is saved. Local processing did not finish; an explicit retry will reuse this response without another analysis request.";
          retrySafe = true;
        }
      } catch { /* A missing, corrupt or mismatched response never authorizes a paid analysis retry. */ }
    }
    if (error instanceof CampaignCopyValidationError && renderInput && dependencies) {
      try {
        if (await dependencies.hasBoundCompletedCopy(renderInput)) {
          message = error.message;
          retrySafe = true;
        }
      } catch { /* A corrupt or mismatched response cannot authorize replay or regeneration. */ }
    }
    if (error instanceof CampaignRenderError && renderInput && dependencies) {
      try {
        if (await dependencies.hasCopyCheckpoint(renderInput)) {
          await store.checkpointLocalRender(id, owner, await copyCheckpointHash(renderInput));
          message = error.message;
          retrySafe = true;
        }
      } catch { /* Missing/corrupt copy is never eligible for a local-only retry. */ }
    }
    await store.fail(id, owner, message, retrySafe).catch(() => { /* Expired leases are reconciled on the next worker poll. */ });
  } finally {
    clearInterval(heartbeat);
  }
  return id;
}
