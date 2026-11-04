import { createHash } from "node:crypto";
import { db } from "../db";
import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { RequestError } from "../http";
import {
  BusinessContextSchema, BusinessDiscoverySchema, BusinessEnrichmentSchema, CampaignKitSchema, CollectedSourceSchema, ModelUsageSchema, ResearchInputSchema, ResearchReportSchema,
  type BusinessContext, type BusinessDiscovery, type CampaignKit, type CollectedSource, type ModelUsage, type ResearchInput, type ResearchReport, type RunEvent, type RunView,
} from "../research/contracts";
import { mergeResearchSources, requiredResearchSourceIds, resolveEnrichedBusiness, type EnrichmentCheckpoint } from "./discovery";
import { reconcileLocationScopes } from "../research/grounding";
import { AutopilotSelectionSchema, CampaignApprovalSchema, type AutopilotSelection } from "../research/contracts";
import { chooseAutopilotOpportunity } from "../autopilot/select";
import { approvableFiles, buildApproval, manifestDigest } from "./approval";
import { AutopilotQualitySchema, type AutopilotQuality } from "../autopilot/production-types";

export const MAX_JOB_ATTEMPTS = 4;
export const MAX_MODEL_CALLS = 6;
/**
 * Autopilot runs discovery, enrichment, analysis, copy, media analysis, SAM image/video,
 * Muse plates and a critic inside one durable run. Each paid step still reserves one call
 * and is never retried automatically; per-role caps live in lib/autopilot/budget.ts.
 */
export const AUTOPILOT_MODEL_CALL_LIMIT = 28;
export const LEASE_MS = 180_000;
export const RESEARCH_WORKFLOW_VERSION = "research-5-branch-media";
type Transaction = Prisma.TransactionClient;
type Json = Prisma.InputJsonValue;
export const contentHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const events = (value: unknown): RunEvent[] => Array.isArray(value) ? value as RunEvent[] : [];
const event = (stage: string, message: string): RunEvent => ({ stage, message, at: new Date().toISOString() });
const isUniqueViolation = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002";

async function artifact(tx: Transaction, runId: string, stage: string, payload: unknown) {
  const hash = contentHash(payload);
  const previous = await tx.stageArtifact.findUnique({ where: { runId_stage_version: { runId, stage, version: 1 } } });
  if (previous) {
    if (previous.contentHash !== hash) throw new Error("An immutable checkpoint changed.");
    return;
  }
  await tx.stageArtifact.create({ data: { runId, stage, version: 1, contentHash: hash, payload: json(payload) } });
}

export class JobStore {
  constructor(readonly client: PrismaClient = db) {}

  async load(id: string) {
    const run = await this.client.run.findUnique({ where: { id }, include: { business: true, artifacts: true } });
    if (!run) throw new RequestError("Run not found.", 404);
    for (const item of run.artifacts) {
      if (item.contentHash !== contentHash(item.payload)) throw new RequestError("A saved checkpoint failed its integrity check.", 409);
    }
    return run;
  }

  async view(id: string): Promise<RunView> {
    const run = await this.load(id);
    const payload = (stage: string) => run.artifacts.find((item) => item.stage === stage)?.payload;
    const collected = payload("sources") as { sources?: unknown[] } | undefined;
    const discovered = payload("discovery") as { discovery?: unknown; resolvedBusiness?: unknown; sources?: unknown[] } | undefined;
    const enriched = payload("enrichment") as { enrichment?: unknown; sources?: unknown[] } | undefined;
    const resolvedBusiness = BusinessContextSchema.parse(discovered?.resolvedBusiness ?? (payload("input") as { business?: unknown } | undefined)?.business ?? run.business);
    const discovery = discovered?.discovery ? BusinessDiscoverySchema.parse(discovered.discovery) : null;
    const enrichment = enriched?.enrichment ? BusinessEnrichmentSchema.parse(enriched.enrichment) : null;
    const branch = enrichment?.branch?.status === "matched" ? enrichment.branch : discovery?.branch?.status === "matched" ? discovery.branch : enrichment?.branch ?? discovery?.branch;
    const visibleSources = collected?.sources ?? reconcileLocationScopes(mergeResearchSources((enriched?.sources ?? []).map((item) => CollectedSourceSchema.parse(item)), (discovered?.sources ?? []).map((item) => CollectedSourceSchema.parse(item)), requiredResearchSourceIds(discovery, enrichment)).sources, branch);
    return {
      id: run.id, businessId: run.businessId, stage: run.stage, status: run.status,
      createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(),
      mode: run.mode === "synthetic" ? "synthetic" : "live",
      error: run.error ?? (run.status === "queued" && Date.now() - run.updatedAt.getTime() > 30_000 ? "Waiting for the local research worker to start. Your inputs are saved; no result has been generated yet." : null),
      business: resolveEnrichedBusiness(resolvedBusiness, enrichment ? { enrichment, sources: (enriched?.sources ?? []).map((source) => CollectedSourceSchema.parse(source)) } : undefined, (discovered?.sources ?? []).map((source) => CollectedSourceSchema.parse(source))),
      sources: visibleSources.map((item) => CollectedSourceSchema.parse(item)),
      discovery,
      enrichment,
      report: payload("report") ? ResearchReportSchema.parse(payload("report")) : null,
      campaign: payload("campaign") ? CampaignKitSchema.parse(payload("campaign")) : null,
      autopilot: Boolean((payload("input") as { input?: { autopilot?: boolean } } | undefined)?.input?.autopilot),
      selection: (() => {
        const selected = payload("selection") as { opportunityId?: string; selectedBy?: string } | undefined;
        if (!selected?.opportunityId) return null;
        if (selected.selectedBy === "autopilot") return AutopilotSelectionSchema.parse(selected);
        return { opportunityId: selected.opportunityId, selectedBy: "owner" as const };
      })(),
      approval: payload("approval") ? CampaignApprovalSchema.parse(payload("approval")) : null,
      quality: payload("quality") ? AutopilotQualitySchema.parse(payload("quality")) : null,
      approvalDigest: (() => {
        const kit = payload("campaign");
        if (!kit) return null;
        const campaign = CampaignKitSchema.parse(kit);
        const withheld = (payload("quality") as { withheldFiles?: string[] } | undefined)?.withheldFiles ?? [];
        return manifestDigest(campaign.id, approvableFiles(campaign, withheld));
      })(),
      events: events(run.events), usage: Array.isArray(run.usage) ? run.usage as unknown as ModelUsage[] : [],
    };
  }

  async enqueueResearch(businessId: string, raw: ResearchInput): Promise<RunView> {
    const input = ResearchInputSchema.parse(raw);
    const business = await this.client.business.findUnique({ where: { id: businessId } });
    if (!business) throw new RequestError("Business not found.", 404);
    const snapshot = BusinessContextSchema.parse(business);
    const workflowVersion = RESEARCH_WORKFLOW_VERSION;
    const hash = contentHash({ version: workflowVersion, business: snapshot, input });
    const existing = await this.client.run.findUnique({ where: { businessId_inputHash: { businessId, inputHash: hash } } });
    if (existing) return this.view(existing.id);
    let id: string;
    try {
      id = await this.client.$transaction(async (tx) => {
        const run = await tx.run.create({ data: {
          businessId, inputHash: hash, mode: input.mode, status: "queued", stage: "created", jobKind: "research",
          modelCallLimit: input.autopilot ? AUTOPILOT_MODEL_CALL_LIMIT : MAX_MODEL_CALLS,
          events: json([event("created", input.autopilot
            ? "Autopilot queued. Tickr will research the business, analyze its media, choose the best-supported campaign and produce a review-ready kit without further input."
            : "Research queued. The local worker will collect sources and analyze them with Meta.")]),
        } });
        await artifact(tx, run.id, "input", { business: snapshot, input, workflowVersion });
        return run.id;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const duplicate = await this.client.run.findUnique({ where: { businessId_inputHash: { businessId, inputHash: hash } } });
      if (!duplicate) throw error;
      id = duplicate.id;
    }
    return this.view(id);
  }

  async enqueueCampaign(id: string, opportunityId: string): Promise<RunView> {
    await this.client.$transaction(async (tx) => {
      const run = await tx.run.findUnique({ where: { id }, include: { artifacts: true } });
      if (!run) throw new RequestError("Run not found.", 404);
      const saved = run.artifacts.find((item) => item.stage === "report");
      if (!saved || contentHash(saved.payload) !== saved.contentHash) throw new RequestError("Finish research before choosing a campaign.", 409);
      const report = ResearchReportSchema.parse(saved.payload);
      const opportunity = report.opportunities.find((item) => item.id === opportunityId);
      if (!opportunity) throw new RequestError("Choose an opportunity from this research run.", 400);
      const previous = run.artifacts.find((item) => item.stage === "selection");
      if (previous) {
        if ((previous.payload as { opportunityId?: string }).opportunityId !== opportunityId) throw new RequestError("This run already has a selected campaign. Start a new research version to change it.", 409);
        return;
      }
      if (run.status !== "waiting" || run.stage !== "awaiting_selection") throw new RequestError("This run is not ready for a campaign selection.", 409);
      await artifact(tx, id, "selection", { opportunityId, reportHash: saved.contentHash });
      await tx.run.update({ where: { id }, data: {
        status: "queued", stage: "creating", jobKind: "campaign", error: null, retrySafe: false,
        events: json([...events(run.events), event("creating", "Campaign concept queued for the selected opportunity.")]),
      } });
    });
    return this.view(id);
  }

  async retry(id: string): Promise<RunView> {
    await this.client.$transaction(async (tx) => {
      const run = await tx.run.findUnique({ where: { id }, include: { artifacts: { where: { stage: { in: ["analysis_resume", "render_resume"] } } } } });
      if (!run) throw new RequestError("Run not found.", 404);
      if (run.status !== "failed" || !run.retrySafe) throw new RequestError("This run cannot be retried automatically: a previous paid request may have completed. Review it before starting another run.", 409);
      if (run.attempts >= MAX_JOB_ATTEMPTS || run.modelCalls >= run.modelCallLimit && !run.artifacts.length) throw new RequestError("This run has reached its request or attempt limit.", 409);
      await tx.run.update({ where: { id }, data: {
        status: "queued", stage: run.jobKind === "campaign" ? "creating" : "created", error: null, retrySafe: false,
        events: json([...events(run.events), event("queued", "Explicit retry queued. Completed checkpoints will be reused; uncertain paid requests will not be repeated.")]),
      } });
    });
    return this.view(id);
  }

  async recoverExpired(now = new Date()): Promise<number> {
    const lost = await this.client.run.findMany({ where: { status: "running", leaseUntil: { lt: now } }, select: { id: true, events: true } });
    let count = 0;
    for (const run of lost) {
      const result = await this.client.run.updateMany({ where: { id: run.id, status: "running", leaseUntil: { lt: now } }, data: {
        status: "failed", stage: "interrupted", leaseOwner: null, leaseUntil: null, retrySafe: false,
        error: "The worker stopped before completing this stage. A Meta request may have completed; no paid request was retried automatically.",
        events: json([...events(run.events), event("interrupted", "Worker lease expired. Saved checkpoints were preserved; automatic retry is withheld.")]),
      } });
      count += result.count;
    }
    return count;
  }

  async claim(owner: string, now = new Date()) {
    return this.client.$transaction(async (tx) => {
      if (await tx.run.count({ where: { status: "running", leaseUntil: { gt: now } } }) >= 2) return null;
      // Each run carries its own explicit request ceiling; compare it in code (Prisma cannot compare columns).
      const queued = await tx.run.findMany({ where: { status: "queued", attempts: { lt: MAX_JOB_ATTEMPTS } }, orderBy: { createdAt: "asc" }, take: 25,
        include: { artifacts: { where: { stage: { in: ["analysis_resume", "render_resume"] } }, select: { id: true } } } });
      const candidate = queued.find((run) => run.modelCalls < run.modelCallLimit || run.artifacts.length > 0);
      if (!candidate) return null;
      const { artifacts: _resume, ...next } = candidate;
      void _resume;
      const result = await tx.run.updateMany({ where: { id: next.id, status: "queued" }, data: {
        status: "running", leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 },
        events: json([...events(next.events), event(next.stage, "Worker started this stage.")]),
      } });
      return result.count === 1 ? next.id : null;
    });
  }

  async heartbeat(id: string, owner: string): Promise<boolean> {
    return (await this.client.run.updateMany({ where: { id, leaseOwner: owner, status: "running" }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } })).count === 1;
  }

  private async owned(tx: Transaction, id: string, owner: string) {
    const run = await tx.run.findUnique({ where: { id } });
    if (!run || run.status !== "running" || run.leaseOwner !== owner || !run.leaseUntil || run.leaseUntil.getTime() <= Date.now()) throw new Error("The worker no longer owns this run.");
    return run;
  }

  async markStage(id: string, owner: string, stage: string, message: string) {
    await this.client.$transaction(async (tx) => {
      const run = await this.owned(tx, id, owner);
      await tx.run.update({ where: { id }, data: { stage, events: json([...events(run.events), event(stage, message)]) } });
    });
  }

  async reserveModelCall(id: string, owner: string) {
    await this.client.$transaction(async (tx) => {
      const run = await this.owned(tx, id, owner);
      if (run.modelCalls >= run.modelCallLimit) throw new RequestError("Run model-request limit reached.", 409);
      await tx.run.update({ where: { id }, data: { modelCalls: { increment: 1 }, retrySafe: false } });
    });
  }

  async checkpointSources(id: string, owner: string, sources: CollectedSource[], warnings: string[]) {
    await this.client.$transaction(async (tx) => {
      const run = await this.owned(tx, id, owner);
      await artifact(tx, id, "sources", { sources, warnings });
      await tx.run.update({ where: { id }, data: { events: json([...events(run.events), event("ingesting", `Collected ${sources.length} attributable sources.`), ...warnings.map((message) => event("ingesting", message))]) } });
    });
  }

  async checkpointDiscovery(id: string, owner: string, payload: { discovery: BusinessDiscovery; resolvedBusiness: BusinessContext; sources: CollectedSource[]; usage: ModelUsage }) {
    await this.client.$transaction(async (tx) => {
      const run = await this.owned(tx, id, owner);
      const previous = await tx.stageArtifact.findUnique({ where: { runId_stage_version: { runId: id, stage: "discovery", version: 1 } } });
      await artifact(tx, id, "discovery", payload);
      if (previous) return;
      await tx.run.update({ where: { id }, data: {
        usage: json([...(Array.isArray(run.usage) ? run.usage : []), payload.usage]),
        events: json([...events(run.events), event("discovering", payload.discovery.status === "matched" ? "Business identity resolved from cited Meta search results." : "Business discovery completed with identity uncertainty; inspect the discovered links and limitations."), ...payload.discovery.warnings.map((message) => event("discovering", message))]),
      } });
    });
  }

  async checkpointEnrichment(id: string, owner: string, payload: EnrichmentCheckpoint) {
    await this.client.$transaction(async (tx) => {
      const run = await this.owned(tx, id, owner);
      const previous = await tx.stageArtifact.findUnique({ where: { runId_stage_version: { runId: id, stage: "enrichment", version: 1 } } });
      await artifact(tx, id, "enrichment", payload);
      if (previous) return;
      await tx.run.update({ where: { id }, data: {
        usage: json([...(Array.isArray(run.usage) ? run.usage : []), payload.usage]),
        events: json([...events(run.events), event("enriching", `Business enrichment saved: ${payload.enrichment.offerings.length} supported offerings and ${payload.enrichment.brandSignals.length} brand signals. Unknowns remain visible.`), ...payload.enrichment.warnings.map((message) => event("enriching", message))]),
      } });
    });
  }

  async awaitIdentity(id: string, owner: string, message: string) {
    await this.client.$transaction(async (tx) => {
      const run = await this.owned(tx, id, owner);
      await tx.run.update({ where: { id }, data: {
        status: "waiting", stage: "awaiting_owner", leaseOwner: null, leaseUntil: null, error: message,
        events: json([...events(run.events), event("awaiting_owner", message)]),
      } });
    });
  }

  async checkpointLocalRender(id: string, owner: string, copyCheckpointHash: string) {
    if (!/^[a-f0-9]{64}$/.test(copyCheckpointHash)) throw new Error("Invalid copy checkpoint hash.");
    await this.client.$transaction(async (tx) => {
      await this.owned(tx, id, owner);
      await artifact(tx, id, "render_resume", { copyCheckpointHash });
    });
  }

  async checkpointLocalAnalysis(id: string, owner: string, responseHash: string) {
    if (!/^[a-f0-9]{64}$/.test(responseHash)) throw new Error("Invalid analysis response hash.");
    await this.client.$transaction(async (tx) => {
      await this.owned(tx, id, owner);
      await artifact(tx, id, "analysis_resume", { responseHash });
    });
  }

  async noSources(id: string, owner: string) {
    await this.client.$transaction(async (tx) => {
      const run = await this.owned(tx, id, owner);
      await tx.run.update({ where: { id }, data: {
        status: "waiting", stage: "awaiting_owner", leaseOwner: null, leaseUntil: null,
        error: "No usable source text was collected. Add an owner statement, attributable customer excerpts or a readable official website, then start research with those inputs.",
        events: json([...events(run.events), event("awaiting_owner", "More source material is needed. No Meta request was made.")]),
      } });
    });
  }

  async completeResearch(id: string, owner: string, raw: ResearchReport, usage: ModelUsage) {
    const report = ResearchReportSchema.parse(raw);
    await this.client.$transaction(async (tx) => {
      const run = await this.owned(tx, id, owner);
      await artifact(tx, id, "report", report);
      const collected = await tx.stageArtifact.findUnique({ where: { runId_stage_version: { runId: id, stage: "sources", version: 1 } } });
      const sources = (collected?.payload as { sources?: CollectedSource[] } | undefined)?.sources ?? [];
      for (const evidence of report.evidence) {
        const source = sources.find((item) => item.id === evidence.sourceId);
        if (!source) throw new Error("Evidence source is missing.");
        await tx.evidence.create({ data: {
          id: `${id}:${evidence.id}`, runId: id, claim: evidence.claim, excerpt: evidence.quote,
          support: source.acquisition === "meta_cited_summary" ? "inferred" : source.acquisition === "owner_supplied" ? "owner_stated" : "supported",
          sourceType: source.kind, sourceUrl: source.url, metadata: json({ ...evidence, source, mode: run.mode }),
        } });
      }
      const input = (await tx.stageArtifact.findUnique({ where: { runId_stage_version: { runId: id, stage: "input", version: 1 } } }))?.payload as { input?: { autopilot?: boolean } } | undefined;
      const saved = await tx.stageArtifact.findUniqueOrThrow({ where: { runId_stage_version: { runId: id, stage: "report", version: 1 } } });
      const selection: AutopilotSelection | null = input?.input?.autopilot ? chooseAutopilotOpportunity(report, saved.contentHash) : null;
      if (selection) {
        // One shot: the immutable selection records Autopilot's deterministic choice and basis,
        // then production is queued in the same run without waiting for the owner.
        await artifact(tx, id, "selection", AutopilotSelectionSchema.parse(selection));
        await tx.run.update({ where: { id }, data: {
          status: "queued", stage: "creating", jobKind: "campaign", leaseOwner: null, leaseUntil: null, error: null, retrySafe: false,
          usage: json([...(Array.isArray(run.usage) ? run.usage : []), usage]),
          events: json([...events(run.events), event("selecting", selection.rationale), event("creating", "Autopilot is producing the campaign: analyzing media, cutting out and tracking real products with SAM 3.1, rendering the Reel and channel assets, then critiquing the result.")]),
        } });
        return;
      }
      const stage = report.opportunities.length ? "awaiting_selection" : "awaiting_owner";
      await tx.run.update({ where: { id }, data: {
        status: "waiting", stage, leaseOwner: null, leaseUntil: null, error: null,
        usage: json([...(Array.isArray(run.usage) ? run.usage : []), usage]),
        events: json([...events(run.events), event(stage, report.opportunities.length ? "Research saved. Review the evidence and choose one campaign opportunity." : "Research saved with insufficient evidence for a supported opportunity. Review the open questions.")]),
      } });
    });
  }

  async completeCampaign(id: string, owner: string, raw: CampaignKit, usage: ModelUsage, additionalUsage: ModelUsage[] = [], options: { quality?: AutopilotQuality } = {}) {
    const campaign = CampaignKitSchema.parse(raw);
    const usages = [usage, ...additionalUsage].map((item) => ModelUsageSchema.parse(item));
    const quality = options.quality ? AutopilotQualitySchema.parse(options.quality) : null;
    await this.client.$transaction(async (tx) => {
      const run = await this.owned(tx, id, owner);
      await artifact(tx, id, "campaign", campaign);
      if (quality) await artifact(tx, id, "quality", quality);
      await tx.run.update({ where: { id }, data: {
        status: "completed", stage: "needs_review", leaseOwner: null, leaseUntil: null, error: null,
        usage: json([...(Array.isArray(run.usage) ? run.usage : []), ...usages]),
        events: json([...events(run.events), event("needs_review", "Campaign concepts rendered. Review claims and replace conceptual visuals with authorized business media before publication.")]),
      } });
    });
  }

  /** Record the owner's single final approval after re-hashing every approved file on disk. */
  async approveCampaign(id: string, digest: string, options: { runsRoot?: string } = {}) {
    const run = await this.load(id);
    const campaignArtifact = run.artifacts.find((item) => item.stage === "campaign");
    if (!campaignArtifact) throw new RequestError("There is no finished campaign kit to approve yet.", 409);
    if (run.artifacts.some((item) => item.stage === "approval")) throw new RequestError("This campaign kit is already approved.", 409);
    const campaign = CampaignKitSchema.parse(campaignArtifact.payload);
    const withheld = (run.artifacts.find((item) => item.stage === "quality")?.payload as { withheldFiles?: string[] } | undefined)?.withheldFiles ?? [];
    const approval = await buildApproval({ runId: id, campaign, manifestDigest: digest, withheld, runsRoot: options.runsRoot });
    await this.client.$transaction(async (tx) => {
      const current = await tx.run.findUniqueOrThrow({ where: { id } });
      if (current.status !== "completed") throw new RequestError("Only a completed campaign kit can be approved.", 409);
      await artifact(tx, id, "approval", approval);
      await tx.run.update({ where: { id }, data: { stage: "owner_approved", events: json([...events(current.events), event("owner_approved", `Owner approved ${approval.files.length} campaign files bound to digest ${approval.manifestDigest.slice(0, 12)}…. Nothing was published.`)]) } });
    });
    return this.view(id);
  }

  async fail(id: string, owner: string, message: string, retrySafe: boolean) {
    await this.client.$transaction(async (tx) => {
      const run = await this.owned(tx, id, owner);
      await tx.run.update({ where: { id }, data: {
        status: "failed", stage: "failed", error: message, retrySafe, leaseOwner: null, leaseUntil: null,
        events: json([...events(run.events), event("failed", message)]),
      } });
    });
  }
}

export const jobs = new JobStore();
