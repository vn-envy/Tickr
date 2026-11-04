import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { CampaignKitSchema, ModelUsageSchema, type BusinessContext, type BusinessEnrichment, type CampaignKit, type CampaignVisual, type CollectedSource, type ModelUsage, type ResearchMode, type ResearchOpportunity, type ResearchReport } from "../research/contracts";
import { eligibleBusinessEvidence, generateCampaignCopy, validateCampaignCopy, validateCompletedCampaignCopy, type CampaignCopy } from "./copy";
import { hashBytes, safeOutputPath, writeVerifiedArchive } from "./archive";
import { normalizeCampaignImage, renderCampaignAssets, type RenderInput } from "./render";
import { prepareCampaignVisual } from "./visual";
import { prepareCampaignLayers, type LayerAsset } from "./layers";
import { CampaignCopyValidationError, readCompletedCopyRecord, writeCompletedCopyRecord } from "./completed-response";
export { CampaignCopyValidationError } from "./completed-response";

export interface CreateCampaignInput {
  business: BusinessContext;
  report: ResearchReport;
  opportunityId: string;
  sources: CollectedSource[];
  mode: ResearchMode;
  outputDir: string;
  reuseCompletedCopyOnly?: boolean;
  requireCompletedCopy?: boolean;
  enrichment?: BusinessEnrichment;
  image?: RenderInput["image"];
  reserveAdditionalModelCall?: () => Promise<void>;
}

/** Pure preflight: call before reserving a paid request. It never constructs a Meta client. */
export function assertCampaignInput(input: CreateCampaignInput): void {
  if (input.report.mode !== input.mode) throw new Error("The campaign source mode does not match the research report.");
  const opportunity = input.report.opportunities.find((item) => item.id === input.opportunityId);
  if (!opportunity) throw new Error("Select an opportunity from the current research report.");
  if (!eligibleBusinessEvidence(input.report, opportunity, input.sources).length) throw new Error("This opportunity needs source-attributed business evidence before creative production.");
  if (input.enrichment && input.enrichment.businessId !== input.business.id) throw new Error("The enrichment dossier belongs to another business.");
  const model = process.env.META_STRATEGY_MODEL?.trim() || process.env.META_REASONING_MODEL?.trim() || "muse-spark-1.3";
  if (/contributor/i.test(model)) throw new Error("Contributor model variants are not enabled for owner material.");
}

export class CampaignRenderError extends Error {
  readonly retrySafe = true;
  constructor() {
    super("The completed campaign copy was checkpointed, but local media/export did not finish. Retrying this stage reuses that copy without another Meta request.");
    this.name = "CampaignRenderError";
  }
}

export function campaignInputHash(input: CreateCampaignInput): string {
  const scoped = input.sources.some((source) => source.context) || input.enrichment?.branch || input.enrichment?.insights;
  return hashBytes(Buffer.from(JSON.stringify({ version: scoped ? "campaign-copy-v4-context" : input.enrichment ? "campaign-copy-v3" : "campaign-copy-v2", business: input.business, report: input.report, opportunityId: input.opportunityId, sources: input.sources, mode: input.mode, ...(input.enrichment ? { enrichment: input.enrichment } : {}), model: process.env.META_STRATEGY_MODEL?.trim() || process.env.META_REASONING_MODEL?.trim() || "muse-spark-1.3" })));
}

/** A bound completed response can be retried locally even while its content still fails validation. */
export async function hasBoundCompletedCopy(input: CreateCampaignInput): Promise<boolean> {
  return Boolean(await readCompletedCopyRecord(input.outputDir, campaignInputHash(input)));
}

/** A corrupt or mismatched checkpoint fails closed instead of paying to regenerate. */
export async function readCopyCheckpoint(input: CreateCampaignInput, opportunity: ResearchOpportunity): Promise<{ copy: CampaignCopy; usage: ModelUsage; origin?: "completed_response" } | null> {
  let bytes: string;
  try { bytes = await readFile(safeOutputPath(input.outputDir, "copy-checkpoint.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The campaign copy checkpoint could not be read safely.");
    const completed = await readCompletedCopyRecord(input.outputDir, campaignInputHash(input));
    if (!completed) return null;
    try { return { copy: validateCompletedCampaignCopy(JSON.parse(completed.outputText), input.report, opportunity, input.sources, input.enrichment), usage: completed.usage, origin: "completed_response" }; }
    catch { throw new CampaignCopyValidationError(); }
  }
  try {
    const saved = JSON.parse(bytes) as { inputHash?: string; copy?: unknown; usage?: unknown };
    if (saved.inputHash !== campaignInputHash(input)) throw new Error("Input changed");
    return { copy: validateCampaignCopy(saved.copy, input.report, opportunity, input.sources, input.enrichment), usage: ModelUsageSchema.parse(saved.usage) };
  } catch { throw new Error("The campaign copy checkpoint no longer matches this run. Start a fresh run instead of retrying a paid request."); }
}

/** One bounded Meta text request, deterministic local assets, and a review-only export. */
export async function createCampaign(input: CreateCampaignInput): Promise<{ campaign: CampaignKit; usage: ModelUsage; additionalUsage?: ModelUsage[] }> {
  assertCampaignInput(input);
  const opportunity = input.report.opportunities.find((item) => item.id === input.opportunityId);
  if (!opportunity) throw new Error("Select an opportunity from the current research report.");
  await mkdir(input.outputDir, { recursive: true });
  let completed = await readCopyCheckpoint(input, opportunity);
  if ((input.reuseCompletedCopyOnly || input.requireCompletedCopy) && !completed) throw new Error("The completed copy checkpoint is required for this retry. No Meta request was made.");
  if (!completed) {
    completed = await generateCampaignCopy({ ...input, opportunity, onCompletedResponse: (response) => writeCompletedCopyRecord(input.outputDir, campaignInputHash(input), response) });
  }
  if (!(await readFile(safeOutputPath(input.outputDir, "copy-checkpoint.json")).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; }))) {
    const pendingPath = safeOutputPath(input.outputDir, "copy-checkpoint.pending.json");
    await writeFile(pendingPath, JSON.stringify({ inputHash: campaignInputHash(input), copy: completed.copy, usage: completed.usage }), { mode: 0o600 });
    await rename(pendingPath, safeOutputPath(input.outputDir, "copy-checkpoint.json"));
  }
  // Paid visual preparation must stay outside the retry-safe local-render catch.
  const prepared = input.image ? {
    image: input.image,
    visual: { kind: input.image.provenance === "meta_illustration" ? "meta_illustration" as const : "source_photo" as const, filename: "campaign-source-image.png", description: input.image.description, sourceIds: input.image.sourceIds, sourceUrls: [], model: null, warnings: ["Caller-supplied image; verify provenance, permissions and product fidelity before publication."] } satisfies CampaignVisual,
  } : await prepareCampaignVisual({ business: input.business, copy: completed.copy, enrichment: input.enrichment, sources: input.sources, outputDir: input.outputDir, mode: input.mode, reuseCompletedOnly: input.reuseCompletedCopyOnly, reserveModelCall: input.reserveAdditionalModelCall });
  const directed = await prepareCampaignLayers({ image: prepared.image, visual: prepared.visual, copy: completed.copy, outputDir: input.outputDir, mode: input.mode, reuseCompletedOnly: input.reuseCompletedCopyOnly, reserveModelCall: input.reserveAdditionalModelCall });
  try {
    const rendered = await renderConcept(input, opportunity, completed.copy, completed.usage, directed.image, directed.visual, directed.assets);
    const additionalUsage = [...("usage" in prepared && prepared.usage ? [prepared.usage] : []), ...directed.usage];
    return { ...rendered, ...(additionalUsage.length ? { additionalUsage } : {}) };
  }
  catch { throw new CampaignRenderError(); }
}

async function renderConcept(input: CreateCampaignInput, opportunity: ResearchOpportunity, copy: CampaignCopy, usage: ModelUsage, image: RenderInput["image"], visual: CampaignVisual, layerAssets: LayerAsset[] = []): Promise<{ campaign: CampaignKit; usage: ModelUsage }> {
  // Export the normalized local raster used for composition, without replacing visual checkpoints.
  let sourceImageAsset: CampaignKit["assets"][number] | null = null;
  if (image) {
    const bytes = await normalizeCampaignImage(image);
    const metadata = await sharp(bytes).metadata();
    const filename = "campaign-hero-source.png";
    await writeFile(safeOutputPath(input.outputDir, filename), bytes);
    image = { ...image, bytes, mimeType: "image/png" };
    visual = { ...visual, filename };
    sourceImageAsset = { id: "campaign-hero-source", channel: null, filename, mediaType: "image", width: metadata.width!, height: metadata.height!, sha256: hashBytes(bytes), bytes: bytes.length };
  }
  const rendered = await renderCampaignAssets({ businessName: input.business.name, vertical: input.business.vertical, mode: input.mode, campaignName: copy.name, channels: copy.channels, outputDir: input.outputDir, creativeBrief: copy.creativeBrief, image });
  const reviewNotes = [...new Set([
    "Concept only: verify every factual claim, caption, offer and CTA with the business owner before use.",
    visual.kind === "meta_illustration" ? "The shared hero image is an AI-generated illustration, not a photograph of this business's actual product. Confirm product fidelity and use authorized real photographs for exact product representation." : visual.kind === "source_photo" ? "The same source image is composed across the campaign. Confirm usage permission and that it depicts the intended business offering." : "No product image is included. Confirm brand direction and add authorized imagery where needed.",
    "The visual palette and layout are a proposed campaign interpretation, not a verified brand guide.",
    ...visual.warnings,
    "WhatsApp Status is a creative concept; advertiser and regional placement eligibility has not been checked. Suggested messages are not a deployed messaging integration.",
    ...(input.mode === "synthetic" ? ["Synthetic demonstration: the business facts and campaign are illustrative, not real market findings or customer results."] : []),
    ...copy.reviewNotes,
  ])];
  const campaign = CampaignKitSchema.parse({
    id: randomUUID(), name: copy.name, objective: copy.objective, audienceHypothesis: copy.audienceHypothesis,
    coreMessage: copy.coreMessage, primaryCta: copy.primaryCta, opportunityId: input.opportunityId,
    evidenceIds: copy.evidenceIds, status: "concept_needs_review", mode: input.mode, reviewNotes,
    channels: copy.channels, assets: rendered, createdAt: new Date().toISOString(), model: usage.model,
    creativeBrief: copy.creativeBrief, visual,
  });
  if (sourceImageAsset) campaign.assets.push(sourceImageAsset);
  for (const layer of layerAssets) {
    const bytes = await readFile(safeOutputPath(input.outputDir, layer.filename));
    if (bytes.length !== layer.bytes || hashBytes(bytes) !== layer.sha256) throw new Error("A campaign layer changed before export.");
    campaign.assets.push({ id: layer.filename.replace(/\.[^.]+$/, ""), channel: null, mediaType: "image", ...layer });
  }

  const addDocument = async (filename: string, content: string) => {
    const bytes = Buffer.from(content, "utf8");
    await writeFile(safeOutputPath(input.outputDir, filename), bytes);
    campaign.assets.push({ id: filename.replace(/\.[^.]+$/, ""), channel: null, filename, mediaType: "document", width: null, height: null, sha256: hashBytes(bytes), bytes: bytes.length });
  };
  const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
  const selectedEvidence = input.report.evidence.filter((item) => opportunity.evidenceIds.includes(item.id));
  const selectedSourceIds = new Set(selectedEvidence.map((item) => item.sourceId));
  await addDocument("campaign-strategy.json", json({ ...campaign, assets: undefined, opportunity, measurement: opportunity.test, reviewStatus: "Owner and contextual quality review required; no ready-to-use approval has been issued." }));
  if (copy.creativeBrief || input.enrichment) {
    const dossierSourceIds = [...new Set([
      ...(input.enrichment?.sourceIds ?? []), ...(input.enrichment?.offerings.flatMap((offering) => offering.sourceIds) ?? []), ...(input.enrichment?.brandSignals.flatMap((signal) => signal.sourceIds) ?? []),
      ...(input.enrichment?.insights?.flatMap((insight) => insight.sourceIds) ?? []), ...(input.enrichment?.branch?.sourceIds ?? []), ...(input.enrichment?.coverage?.flatMap((area) => area.sourceIds) ?? []),
      ...(copy.creativeBrief?.focus.sourceIds ?? []), ...(copy.creativeBrief?.brandStory.sourceIds ?? []), ...(copy.creativeBrief?.visualDirection.sourceIds ?? []), ...visual.sourceIds,
      ...(copy.creativeBrief?.context?.seasonalTheme.sourceIds ?? []),
    ])];
    const sourceMap = Object.fromEntries(dossierSourceIds.map((id) => {
      const source = input.sources.find((item) => item.id === id);
      return [id, source ? { id: source.id, title: source.title, kind: source.kind, url: source.url, retrievedAt: source.retrievedAt, acquisition: source.acquisition, citation: source.citation ?? null, context: source.context ?? null, text: source.text } : { id, status: "unavailable_in_run", url: null, citation: null }];
    }));
    await addDocument("brand-product-dossier.json", json({ business: input.business, creativeBrief: copy.creativeBrief ?? null, enrichment: input.enrichment ?? null, visual, sourceMap, interpretation: "Discovered descriptions and campaign art direction remain subject to owner confirmation. Proposed palettes are not verified brand standards.", evidenceIds: copy.evidenceIds }));
  }
  await addDocument("evidence-report.json", json({ mode: input.mode, evidence: selectedEvidence, sources: input.sources.filter((source) => selectedSourceIds.has(source.id)).map(({ id, kind, title, url, retrievedAt, acquisition, citation, context }) => ({ id, kind, title, url, retrievedAt, acquisition, citation, context })), unknowns: input.report.unknowns, limitations: reviewNotes }));
  await addDocument("captions.md", `# ${copy.name}\n\nCONCEPT — REVIEW REQUIRED\n\n${copy.channels.map((channel) => `## ${channel.title}\n\n${channel.caption}\n\nCTA: ${channel.cta}\n\nSupporting evidence: ${channel.evidenceIds.join(", ")}`).join("\n\n")}\n`);
  await addDocument("whatsapp-conversation.json", json({ status: "suggested_scripts_not_deployed", eligibility: "unchecked", ...copy.conversation }));
  await addDocument("review-report.json", json({
    ruleVersion: "concept-v1", verdict: "needs_owner", campaignId: campaign.id, mode: input.mode,
    checks: [
      { id: "channel-inventory", status: "pass", reason: "All seven channel adaptations are present." },
      { id: "evidence-references", status: "pass", reason: "Copy references selected source-attributed business claims. Reported signals remain unverified; this checks references, not semantic entailment or current availability." },
      { id: "local-media", status: "pass", reason: "PNG dimensions and the four-scene MP4 encoding/duration were checked locally." },
      { id: "owner-and-contextual-review", status: "needs_owner", reason: "Owner factual, brand, category, placement and final-copy review has not been completed." },
    ],
    assets: rendered.map(({ filename, sha256, bytes }) => ({ filename, sha256, bytes })), reviewNotes,
  }));
  await addDocument("README.txt", [
    `TICKR — ${copy.name}`, "CONCEPT PACKAGE — REVIEW REQUIRED", `Source mode: ${input.mode}`, "",
    "This package contains editorial creative concepts, suggested copy and a real multi-scene MP4.",
    "It does not contain an approved campaign, verified product photography, posted content or activated ads.",
    "All visuals visibly carry a concept/synthetic label. Do not remove that label until the facts and final assets have been approved and rendered again.",
    "", ...reviewNotes.map((note) => `- ${note}`), "",
    "manifest.json records the bytes of all preceding assets/documents. It excludes itself and this ZIP to avoid a circular checksum.",
    "The server inventory additionally records the manifest and ZIP hashes. A changed file invalidates its matching hash.", "",
  ].join("\n"));
  await addDocument("manifest.json", json({ campaignId: campaign.id, status: campaign.status, mode: campaign.mode, createdAt: campaign.createdAt, schemaVersion: "concept-v1", inventory: [...campaign.assets], checksumScope: "Every listed file; manifest and enclosing ZIP excluded to avoid circular hashes." }));
  const archive = await writeVerifiedArchive(input.outputDir, campaign.assets);
  campaign.assets.push({ id: "campaign-concept", channel: null, filename: "campaign-concept.zip", mediaType: "archive", width: null, height: null, ...archive });
  return { campaign: CampaignKitSchema.parse(campaign), usage };
}
