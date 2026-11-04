import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { z } from "zod";
import { CampaignKitSchema, ModelUsageSchema, type BusinessContext, type BusinessEnrichment, type CampaignKit, type CampaignVisual, type CollectedSource, type ModelUsage, type ResearchMode, type ResearchOpportunity, type ResearchReport } from "../research/contracts";
import { CLAIM_REPAIR_DOCUMENT, claimRepairDocument, eligibleBusinessEvidence, generateCampaignCopy, validateCampaignCopy, validateCompletedCampaignCopy, type CampaignCopy } from "./copy";
import { hashBytes, safeOutputPath, writeVerifiedArchive } from "./archive";
import { normalizeCampaignImage, probeLocalMp4Size, renderCampaignAssets, validateRenderRouting, type RenderInput } from "./render";
import type { Channel } from "../schemas/common";
import { prepareCampaignVisual } from "./visual";
import { prepareCampaignLayers, type LayerAsset } from "./layers";
import { CampaignCopyValidationError, readCompletedCopyRecord, writeCompletedCopyRecord } from "./completed-response";
export { CampaignCopyValidationError } from "./completed-response";
export type { PrebuiltReel, RenderImage, RoutedChannel } from "./render";

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
    catch { throw new CampaignCopyValidationError(completed.usage); }
  }
  try {
    const saved = JSON.parse(bytes) as { inputHash?: string; copy?: unknown; usage?: unknown };
    if (saved.inputHash !== campaignInputHash(input)) throw new Error("Input changed");
    return { copy: validateCampaignCopy(saved.copy, input.report, opportunity, input.sources, input.enrichment), usage: ModelUsageSchema.parse(saved.usage) };
  } catch { throw new Error("The campaign copy checkpoint no longer matches this run. Start a fresh run instead of retrying a paid request."); }
}

export interface CampaignCopyResult { copy: CampaignCopy; usage: ModelUsage; origin?: "completed_response" }

/**
 * The copy stage alone. A valid checkpoint or input-bound completed response is always reused; a corrupt,
 * pending or mismatched one fails closed. `reserveCopyCall` is awaited immediately before a NEW paid request only.
 */
export async function ensureCampaignCopy(input: CreateCampaignInput, options: { reserveCopyCall?: () => Promise<void> } = {}): Promise<CampaignCopyResult> {
  assertCampaignInput(input);
  const opportunity = input.report.opportunities.find((item) => item.id === input.opportunityId);
  if (!opportunity) throw new Error("Select an opportunity from the current research report.");
  await mkdir(input.outputDir, { recursive: true });
  let completed: CampaignCopyResult | null = await readCopyCheckpoint(input, opportunity);
  if ((input.reuseCompletedCopyOnly || input.requireCompletedCopy) && !completed) throw new Error("The completed copy checkpoint is required for this retry. No Meta request was made.");
  if (!completed) {
    await options.reserveCopyCall?.();
    completed = await generateCampaignCopy({ ...input, opportunity, onCompletedResponse: (response) => writeCompletedCopyRecord(input.outputDir, campaignInputHash(input), response) });
  }
  if (!(await readFile(safeOutputPath(input.outputDir, "copy-checkpoint.json")).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; }))) {
    const pendingPath = safeOutputPath(input.outputDir, "copy-checkpoint.pending.json");
    await writeFile(pendingPath, JSON.stringify({ inputHash: campaignInputHash(input), copy: completed.copy, usage: completed.usage }), { mode: 0o600 });
    await rename(pendingPath, safeOutputPath(input.outputDir, "copy-checkpoint.json"));
  }
  return completed;
}

/** One bounded Meta text request, deterministic local assets, and a review-only export. */
export async function createCampaign(input: CreateCampaignInput): Promise<{ campaign: CampaignKit; usage: ModelUsage; additionalUsage?: ModelUsage[] }> {
  const completed = await ensureCampaignCopy(input);
  const opportunity = input.report.opportunities.find((item) => item.id === input.opportunityId)!;
  // Paid visual preparation must stay outside the retry-safe local-render catch.
  const prepared = input.image ? {
    image: input.image,
    visual: { kind: input.image.provenance === "meta_illustration" ? "meta_illustration" as const : "source_photo" as const, filename: "campaign-source-image.png", description: input.image.description, sourceIds: input.image.sourceIds, sourceUrls: [], model: null, warnings: ["Caller-supplied image; verify provenance, permissions and product fidelity before publication."] } satisfies CampaignVisual,
  } : await prepareCampaignVisual({ business: input.business, copy: completed.copy, enrichment: input.enrichment, sources: input.sources, outputDir: input.outputDir, mode: input.mode, reuseCompletedOnly: input.reuseCompletedCopyOnly, reserveModelCall: input.reserveAdditionalModelCall });
  const directed = await prepareCampaignLayers({ image: prepared.image, visual: prepared.visual, copy: completed.copy, outputDir: input.outputDir, mode: input.mode, reuseCompletedOnly: input.reuseCompletedCopyOnly, reserveModelCall: input.reserveAdditionalModelCall });
  const rendered = await renderCampaignKit(input, opportunity, completed.copy, completed.usage, { image: directed.image, visual: directed.visual, layerAssets: directed.assets });
  const additionalUsage = [...("usage" in prepared && prepared.usage ? [prepared.usage] : []), ...directed.usage];
  return { ...rendered, ...(additionalUsage.length ? { additionalUsage } : {}) };
}

export interface CampaignExtraAsset { id?: string; filename: string; mediaType: "image" | "video" | "document"; channel: Channel | null; width?: number | null; height?: number | null }
export interface CampaignProduction {
  image?: RenderInput["image"];
  visual: CampaignVisual;
  layerAssets?: LayerAsset[];
  render?: Pick<RenderInput, "channelImages" | "carouselImages" | "reel">;
  /** Files already written to outputDir by an earlier local stage; hashed here and exported. */
  extraAssets?: CampaignExtraAsset[];
  /** Small text documents written to outputDir and exported. */
  extraDocuments?: Array<{ filename: string; content: string }>;
  extraReviewNotes?: string[];
}

/**
 * Filenames the standard kit or a private run record occupies in outputDir (.data/runs/<runId>), which the copy,
 * visual, layer, analysis and Autopilot stages share. Extras can neither replace nor export any of them.
 */
const RESERVED_FILENAMES = new Set([
  "instagram_feed.png", "facebook_ads.png", "facebook_ads_portrait.png", "instagram_stories.png", "click_to_whatsapp.png", "whatsapp_status.png",
  "instagram_carousel_1.png", "instagram_carousel_2.png", "instagram_carousel_3.png", "instagram_carousel_4.png",
  "instagram_reel.mp4", "instagram_reel.pending.mp4", "instagram_reel_cover.png", "campaign-hero-source.png", "campaign-source-image.png",
  "campaign-subject.png", "campaign-subject-mask.png", "campaign-backdrop.png",
  "campaign-strategy.json", "brand-product-dossier.json", "evidence-report.json", "captions.md", "whatsapp-conversation.json", "review-report.json", "readme.txt", "manifest.json", "campaign-concept.zip",
  CLAIM_REPAIR_DOCUMENT, "copy-checkpoint.json", "copy-checkpoint.pending.json", "copy-response.json", "copy-response.pending.json", "visual-checkpoint.json", "visual-checkpoint.pending.json", "media-acquisition.json",
  "art-direction-checkpoint.json", "backdrop-checkpoint.json", "sam-layer-checkpoint.json", "sam-layer-diagnostic.json",
  "analysis-response.json", "analysis-response.pending.json", "autopilot-budget.json", "autopilot-public", "state.json", "masklets.json",
]);
/**
 * Private record shapes: paid-response-store markers/responses (<prefix>-request.json, -response.json,
 * -response.pending.json), checkpoints, budgets, diagnostics and state files, plus any `.pending`/`.partial` write.
 */
const PRIVATE_RECORD = /(^|[-_.])(request|response|checkpoint|budget|diagnostic|state|masklets)\.json$|\.(pending|partial)(\.|$)/;
const stripExtension = (filename: string) => filename.replace(/\.[^.]+$/, "");
/** Asset ids the standard kit uses (including README, manifest and the ZIP's campaign-concept). */
const STANDARD_IDS = new Set([...RESERVED_FILENAMES].map(stripExtension).concat(["README", "readme", "manifest", "campaign-concept", "campaign-hero-source"]));
const EXTRA_FILENAME = /^[a-z0-9][a-z0-9._-]{0,100}$/;
const EXTRA_FILE_MAX_BYTES = 95_000_000;
const EXTRA_TOTAL_MAX_BYTES = 100_000_000;
const ExtraAssetSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,100}$/).optional(), filename: z.string(), mediaType: z.enum(["image", "video", "document"]),
  channel: z.enum(["facebook_ads", "instagram_feed", "instagram_carousel", "instagram_stories", "instagram_reels", "click_to_whatsapp", "whatsapp_status"]).nullable(),
  width: z.number().int().positive().max(20_000).nullable().optional(), height: z.number().int().positive().max(20_000).nullable().optional(),
}).strict();
const ExtraDocumentSchema = z.object({ filename: z.string(), content: z.string().max(2_000_000) }).strict();
const ExtraNotesSchema = z.array(z.string().trim().min(1).max(600)).max(40);

/**
 * Pure preflight, before rendering: an extra file may not overwrite, impersonate or export a standard kit file or
 * a private run record, and its effective asset id must be unique across the whole kit. Routing input is checked too.
 */
function assertExtras(input: CreateCampaignInput, copy: CampaignCopy, production: CampaignProduction): void {
  const assets = z.array(ExtraAssetSchema).max(40).safeParse(production.extraAssets ?? []);
  const documents = z.array(ExtraDocumentSchema).max(20).safeParse(production.extraDocuments ?? []);
  if (!assets.success || !documents.success || !ExtraNotesSchema.safeParse(production.extraReviewNotes ?? []).success) throw new Error("The extra campaign files are invalid.");
  const reservedNames = new Set([...RESERVED_FILENAMES, ...(production.layerAssets ?? []).map((layer) => layer.filename), ...(production.visual.filename ? [production.visual.filename] : [])]);
  const reservedIds = new Set([...STANDARD_IDS, ...[...reservedNames].map(stripExtension)]);
  const names = new Set<string>();
  const ids = new Set<string>();
  const extras = [...assets.data.map((asset) => ({ filename: asset.filename, id: asset.id ?? stripExtension(asset.filename) })), ...documents.data.map((document) => ({ filename: document.filename, id: stripExtension(document.filename) }))];
  for (const { filename, id } of extras) {
    if (!EXTRA_FILENAME.test(filename) || PRIVATE_RECORD.test(filename) || reservedNames.has(filename) || names.has(filename)) throw new Error("An extra campaign file name is invalid or collides with a standard kit file.");
    if (reservedIds.has(id) || ids.has(id)) throw new Error("An extra campaign asset id is invalid or collides with a standard kit asset.");
    safeOutputPath(input.outputDir, filename);
    names.add(filename);
    ids.add(id);
  }
  if (Buffer.byteLength(documents.data.map((document) => document.content).join(""), "utf8") > EXTRA_TOTAL_MAX_BYTES) throw new Error("The extra campaign files are too large to export.");
  validateRenderRouting({ channels: copy.channels, ...production.render });
}

/**
 * Inspect the caller's existing extra files before rendering: regular files only (no symlinks), bounded per file and
 * in total, images decoded and videos probed so the recorded dimensions are the real ones. Errors name no local path.
 */
async function inspectExtraAssets(input: CreateCampaignInput, production: CampaignProduction): Promise<CampaignKit["assets"]> {
  for (const document of production.extraDocuments ?? []) {
    // A retry rewrites its own earlier document; anything other than a regular file is never written through.
    const info = await lstat(safeOutputPath(input.outputDir, document.filename)).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : error));
    if (info instanceof Error || (info && !info.isFile())) throw new Error(`The extra campaign document ${document.filename} would replace something other than a regular file.`);
  }
  const extras: CampaignKit["assets"] = [];
  let total = Buffer.byteLength((production.extraDocuments ?? []).map((document) => document.content).join(""), "utf8");
  for (const extra of production.extraAssets ?? []) {
    const path = safeOutputPath(input.outputDir, extra.filename);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.size < 1 || info.size > EXTRA_FILE_MAX_BYTES || (total += info.size) > EXTRA_TOTAL_MAX_BYTES) throw new Error(`The extra campaign file ${extra.filename} is missing, empty, not a regular file or too large to export.`);
    let bytes: Buffer;
    try { bytes = await readFile(path); }
    catch { throw new Error(`The extra campaign file ${extra.filename} could not be read.`); }
    if (bytes.length !== info.size) throw new Error(`The extra campaign file ${extra.filename} changed while it was inspected.`);
    let { width = null, height = null } = extra;
    if (extra.mediaType === "document") { width = null; height = null; }
    else {
      const measured = extra.mediaType === "image"
        ? await sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" }).metadata().then(({ width: w, height: h }) => (w && h ? { width: w, height: h } : null), () => null)
        : await probeLocalMp4Size(path);
      if (!measured || (width !== null && width !== measured.width) || (height !== null && height !== measured.height)) throw new Error(`The extra campaign ${extra.mediaType} ${extra.filename} could not be decoded or does not match its declared size.`);
      ({ width, height } = measured);
    }
    extras.push({ id: extra.id ?? stripExtension(extra.filename), channel: extra.channel, filename: extra.filename, mediaType: extra.mediaType, width, height, sha256: hashBytes(bytes), bytes: bytes.length });
  }
  return extras;
}

/**
 * Local rendering and the verified export for already-completed copy and visuals. No Meta request happens here.
 * Caller errors (routing, extra names, ids and the existing extra files) are plain Errors raised before anything is
 * rendered; any later local failure becomes a retry-safe CampaignRenderError.
 */
export async function renderCampaignKit(input: CreateCampaignInput, opportunity: ResearchOpportunity, copy: CampaignCopy, usage: ModelUsage, production: CampaignProduction): Promise<{ campaign: CampaignKit; usage: ModelUsage }> {
  if (opportunity.id !== input.opportunityId) throw new Error("Select an opportunity from the current research report.");
  assertExtras(input, copy, production);
  const extras = await inspectExtraAssets(input, production);
  try { return await renderConcept(input, opportunity, copy, usage, production, extras); }
  catch { throw new CampaignRenderError(); }
}

async function renderConcept(input: CreateCampaignInput, opportunity: ResearchOpportunity, copy: CampaignCopy, usage: ModelUsage, production: CampaignProduction, extras: CampaignKit["assets"]): Promise<{ campaign: CampaignKit; usage: ModelUsage }> {
  let { image, visual } = production;
  const layerAssets = production.layerAssets ?? [];
  const routing = production.render ?? {};
  const routedImages = Boolean((routing.channelImages && Object.values(routing.channelImages).some(Boolean)) || routing.carouselImages);
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
  const rendered = await renderCampaignAssets({ businessName: input.business.name, vertical: input.business.vertical, mode: input.mode, campaignName: copy.name, channels: copy.channels, outputDir: input.outputDir, creativeBrief: copy.creativeBrief, image, ...(routing.channelImages ? { channelImages: routing.channelImages } : {}), ...(routing.carouselImages ? { carouselImages: routing.carouselImages } : {}), ...(routing.reel ? { reel: routing.reel } : {}) });
  const reviewNotes = [...new Set([
    "Concept only: verify every factual claim, caption, offer and CTA with the business owner before use.",
    routedImages ? "Different images are routed to individual placements and carousel slides; each frame's footer names its image provenance. Confirm usage permission and that every routed image depicts the intended business offering." : visual.kind === "meta_illustration" ? "The shared hero image is an AI-generated illustration, not a photograph of this business's actual product. Confirm product fidelity and use authorized real photographs for exact product representation." : visual.kind === "source_photo" ? "The same source image is composed across the campaign. Confirm usage permission and that it depicts the intended business offering." : "No product image is included. Confirm brand direction and add authorized imagery where needed.",
    "The visual palette and layout are a proposed campaign interpretation, not a verified brand guide.",
    ...visual.warnings,
    ...(production.extraReviewNotes ?? []).map((note) => note.trim()),
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
  campaign.assets.push(...extras);

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
  // Every field the deterministic claim repair replaced with a neutral line, with its original text in full: the review note only summarises them.
  if (copy.claimRepairs?.length) await addDocument(CLAIM_REPAIR_DOCUMENT, json(claimRepairDocument(copy.claimRepairs)));
  await addDocument("review-report.json", json({
    ruleVersion: "concept-v1", verdict: "needs_owner", campaignId: campaign.id, mode: input.mode,
    checks: [
      { id: "channel-inventory", status: "pass", reason: "All seven channel adaptations are present." },
      { id: "evidence-references", status: "pass", reason: "Copy references selected source-attributed business claims. Reported signals remain unverified; this checks references, not semantic entailment or current availability." },
      { id: "local-media", status: "pass", reason: routing.reel ? "PNG dimensions and the adopted Reel's encoding, frame count and duration were checked locally." : "PNG dimensions and the four-scene MP4 encoding/duration were checked locally." },
      { id: "owner-and-contextual-review", status: "needs_owner", reason: "Owner factual, brand, category, placement and final-copy review has not been completed." },
    ],
    assets: [...rendered, ...extras].map(({ filename, sha256, bytes }) => ({ filename, sha256, bytes })), reviewNotes,
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
  for (const document of production.extraDocuments ?? []) await addDocument(document.filename, document.content);
  if (new Set(campaign.assets.map((asset) => asset.id)).size !== campaign.assets.length || new Set(campaign.assets.map((asset) => asset.filename)).size !== campaign.assets.length) throw new Error("Campaign asset identifiers must be unique.");
  await addDocument("manifest.json", json({ campaignId: campaign.id, status: campaign.status, mode: campaign.mode, createdAt: campaign.createdAt, schemaVersion: "concept-v1", inventory: [...campaign.assets], checksumScope: "Every listed file; manifest and enclosing ZIP excluded to avoid circular hashes." }));
  const archive = await writeVerifiedArchive(input.outputDir, campaign.assets);
  campaign.assets.push({ id: "campaign-concept", channel: null, filename: "campaign-concept.zip", mediaType: "archive", width: null, height: null, ...archive });
  return { campaign: CampaignKitSchema.parse(campaign), usage };
}
