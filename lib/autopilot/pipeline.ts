import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { critiqueCampaign, type CritiqueReport } from "../agents/critic";
import { renderSamOverlayVideo } from "../campaign/cinema/overlay";
import { renderStillDepthReel } from "../campaign/cinema/still-depth";
import { renderTrackedReel } from "../campaign/cinema/tracked";
import { sha256File } from "../campaign/cinema/encode";
import { CLAIM_REPAIR_DOCUMENT, isAlongsideRepair } from "../campaign/copy";
import { CampaignCopyValidationError, ensureCampaignCopy, renderCampaignKit, type CampaignExtraAsset, type CampaignProduction, type CreateCampaignInput, type PrebuiltReel, type RenderImage, type RoutedChannel } from "../campaign/index";
import { illustrationSubjectPhrase, prepareCampaignVisual } from "../campaign/visual";
import { normalizeOwnerClip, normalizeOwnerRenderClip } from "../media/clip";
import type { MediaLibrary } from "../media/library";
import { RequestError } from "../http";
import { MetaClientError } from "../meta/config";
import { analyzeMediaAssets } from "../meta/media-analysis";
import { trackMetaVideo } from "../meta/sam-video";
import { segmentMetaImage } from "../meta/segmentation";
import { analyzeClipShots } from "../meta/video-understanding";
import type { CampaignVisual, ModelUsage } from "../research/contracts";
import { analysisOfferings, analyzeHarvest, type AnalysisRecord, type AnalyzeDependencies, type PaidGate } from "./analyze";
import { AutopilotBudgetError } from "./budget";
import type { AutopilotRole, PlannedChannel, ProductionPlan } from "./contracts";
import { applyDeterministicFixes, applyRecheckFixes, ARCHIVE_FILE, combinedVerdict, criticReportDocument, critiqueSnapshot, publicCritic, REEL_FILES, runCritique, SAM_OVERLAY_FILE, withheldKitFiles, type CritiqueOutcome, type RecheckFixes } from "./critique";
import { planProduction } from "./director";
import { defaultHarvestDependencies, harvestMedia, harvestThumbnail, officialWebsiteFor, openRunLibrary, type HarvestDependencies, type HarvestRecord } from "./harvest";
import {
  illustrationStill, layerIsClean, prebuiltReel, produceReel, renderImageFor, savedReel, segmentIllustration, segmentStill, workingStill,
  ILLUSTRATION_ASSET_ID, MAX_SEGMENTED_STILLS, type ReelDependencies, type ReelRecord, type ReelVariant, type StillLayer, type StillSource,
} from "./produce";
import { AutopilotPaidStepError, AutopilotResumableError, type AutopilotProductionInput, type AutopilotProductionResult, type AutopilotQuality } from "./production-types";
import { AutopilotCheckpointError, bounded, digestOf, DirectorRoom, directorReport, planRoles, publicAnalysis, publicSam, readCheckpoint, sha256Hex, writeCheckpoint, type SamRecord } from "./report";

/**
 * The one-shot Autopilot production stage, from harvested media to an exported, self-critiqued
 * review kit. Every paid step reserves its role budget (and the run-level call) only for a NEW
 * request, writes its requested marker before the call and stores the completed response, so a
 * retry decodes saved responses offline and never repeats a completed paid request. Private
 * checkpoints live under <outputDir>/autopilot/; owner-visible previews go to the director's room.
 *
 * Error policy: an exhausted optional budget skips that step with a note; Meta errors from
 * required steps (copy, media analysis) propagate unchanged and are never retried; optional
 * Meta steps (shot logs, SAM, critic) fail closed into their local fallback; a local failure
 * after paid work started becomes AutopilotResumableError.
 */
export interface AutopilotDependencies extends HarvestDependencies, AnalyzeDependencies, ReelDependencies {
  ensureCopy: typeof ensureCampaignCopy;
  segment: typeof segmentMetaImage;
  critique: typeof critiqueCampaign;
  prepareVisual: typeof prepareCampaignVisual;
  renderKit: typeof renderCampaignKit;
}

export const defaultAutopilotDependencies: AutopilotDependencies = {
  ...defaultHarvestDependencies,
  analyzeMedia: analyzeMediaAssets, analyzeShots: analyzeClipShots, normalizeClip: normalizeOwnerClip, normalizeRenderClip: normalizeOwnerRenderClip,
  segment: segmentMetaImage, trackVideo: trackMetaVideo, renderTracked: renderTrackedReel, renderStillDepth: renderStillDepthReel, renderOverlay: renderSamOverlayVideo,
  ensureCopy: ensureCampaignCopy, prepareVisual: prepareCampaignVisual, renderKit: renderCampaignKit, critique: critiqueCampaign,
};

class LeaseLostError extends Error {
  constructor() { super("Worker lease was lost before the next Autopilot request."); this.name = "LeaseLostError"; }
}

const PASS_THROUGH = [MetaClientError, AutopilotBudgetError, AutopilotCheckpointError, AutopilotResumableError, AutopilotPaidStepError, CampaignCopyValidationError, LeaseLostError];
const MAX_NOTES = 30;
/** AutopilotQualitySchema.withheldFiles bound: a longer list must never be truncated into approvable files. */
const MAX_WITHHELD_FILES = 80;
const PLAN_CHANNELS: readonly PlannedChannel[] = ["instagram_feed", "facebook_ads", "instagram_stories", "click_to_whatsapp", "whatsapp_status"];

async function markerExists(directory: string, prefix: string): Promise<boolean> {
  try { return (await lstat(join(directory, `${prefix}-request.json`))).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export async function produceAutopilotCampaign(input: AutopilotProductionInput, dependencies: AutopilotDependencies = defaultAutopilotDependencies): Promise<AutopilotProductionResult> {
  const outputDir = resolve(input.outputDir);
  const directory = join(outputDir, "autopilot");
  const room = new DirectorRoom(outputDir, input.runId);
  let paidStarted = false;
  // A paid request was reserved but its adapter has not run to an end yet: its response may be lost.
  let paidUncertain = false;
  // Errors raised inside a paid adapter (a new request or a stored-response recovery) leave that
  // step's paid outcome unknown; a step that catches one and falls back records its own outcome.
  const paidFailures = new WeakSet<object>();
  const settled = <A extends unknown[], R>(adapter: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try { return await adapter(...args); }
    catch (error) {
      if (error && typeof error === "object") paidFailures.add(error);
      throw error;
    } finally { paidUncertain = false; }
  };
  const guarded: AutopilotDependencies = {
    ...dependencies,
    ensureCopy: settled(dependencies.ensureCopy), analyzeMedia: settled(dependencies.analyzeMedia), analyzeShots: settled(dependencies.analyzeShots),
    segment: settled(dependencies.segment), trackVideo: settled(dependencies.trackVideo), critique: settled(dependencies.critique), prepareVisual: settled(dependencies.prepareVisual),
  };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return await produce(input, guarded, { outputDir, directory, room, markPaid: () => { paidStarted = true; }, markReserved: () => { paidStarted = true; paidUncertain = true; } });
  } catch (error) {
    await room.save("failed", "Autopilot stopped before the kit was ready. Saved progress is kept.");
    if (PASS_THROUGH.some((type) => error instanceof type) || !paidStarted) throw error;
    // A paid step whose outcome is unknown (reserved but not returned, or failing inside its adapter)
    // may have lost a completed response: never present that as a safe retry.
    if (paidUncertain || (error && typeof error === "object" && paidFailures.has(error))) throw new AutopilotPaidStepError();
    // Every paid step either stored its response or never started: a retry reuses them offline.
    throw new AutopilotResumableError();
  }
}

interface Runtime { outputDir: string; directory: string; room: DirectorRoom; markPaid: () => void; markReserved: () => void }

async function produce(input: AutopilotProductionInput, dependencies: AutopilotDependencies, runtime: Runtime): Promise<AutopilotProductionResult> {
  const { outputDir, directory, room } = runtime;
  const notes: string[] = [];
  const additionalUsage: ModelUsage[] = [];
  const opportunity = input.report.opportunities.find((item) => item.id === input.opportunityId);
  if (!opportunity) throw new Error("Select an opportunity from the current research report.");
  const campaignInput: CreateCampaignInput = {
    business: input.business, report: input.report, opportunityId: input.opportunityId, sources: input.sources, mode: input.mode, outputDir,
    ...(input.enrichment ? { enrichment: input.enrichment } : {}),
    ...(input.reuseCompletedCopyOnly ? { reuseCompletedCopyOnly: true } : {}), ...(input.requireCompletedCopy ? { requireCompletedCopy: true } : {}),
  };
  // The run-level request ceiling (HTTP 409 from the job store) counts as an exhausted role budget.
  const reserveRequired = async (role: AutopilotRole) => {
    if (input.leaseLost()) throw new LeaseLostError();
    try { await input.budget.reserve(role); }
    catch (error) {
      if (input.leaseLost()) throw new LeaseLostError();
      if (error instanceof RequestError && error.status === 409) throw new AutopilotBudgetError(role);
      throw error;
    }
    // Cleared only when the paid adapter returns (see `settled`).
    runtime.markReserved();
  };
  const gate: PaidGate = async (role, requestDirectory, prefix) => {
    if (await markerExists(requestDirectory, prefix)) { runtime.markPaid(); return "recover"; }
    try { await reserveRequired(role); }
    catch (error) { if (error instanceof AutopilotBudgetError) return "exhausted"; throw error; }
    return "reserved";
  };
  // Purely local re-renders may decode stored responses but never start a new paid request.
  const recoverOnly: PaidGate = async (_role, requestDirectory, prefix) => {
    if (await markerExists(requestDirectory, prefix)) { runtime.markPaid(); return "recover"; }
    return "exhausted";
  };

  // 1. Harvest ------------------------------------------------------------------------------
  await input.progress("harvest", "Gathering the business's photos and videos from your uploads, the official website and any connected accounts.");
  await room.save("harvest", "Gathering the business's photos and videos.");
  const website = officialWebsiteFor(input.business, input.sources);
  const harvestBinding = digestOf({ version: "autopilot-harvest-1", businessId: input.business.id, website });
  let harvest = await readCheckpoint<HarvestRecord>(directory, "harvest", harvestBinding);
  let library: MediaLibrary;
  if (harvest) {
    library = await openRunLibrary(outputDir);
    for (const asset of harvest.assets) if ((await library.getAsset(asset.assetId))?.sha256 !== asset.sha256) throw new AutopilotCheckpointError();
  } else {
    const result = await harvestMedia({ outputDir, workDir: directory, businessId: input.business.id, businessMediaDir: input.businessMediaDir, connectionsDir: input.connectionsDir, website }, dependencies);
    harvest = result.record;
    library = result.library;
    await writeCheckpoint(directory, "harvest", harvestBinding, harvest);
  }
  notes.push(...harvest.notes);
  room.state.sources = { ...harvest.sources };
  room.state.media = [];
  for (const asset of harvest.assets.slice(0, 120)) {
    let thumb: string | null = null;
    try {
      const record = await library.getAsset(asset.assetId);
      if (record) thumb = await room.publish(`thumb-${asset.assetId}.jpg`, await harvestThumbnail(record), "image/jpeg");
    } catch { thumb = null; }
    room.state.media.push({
      assetId: asset.assetId, kind: asset.kind, provenance: asset.provenance, rights: asset.rights, thumb, width: asset.width, height: asset.height,
      durationSeconds: asset.durationSeconds, status: "harvested", analysis: null, roles: [], excludedReasons: [], score: null,
    });
  }
  const imageCount = harvest.assets.filter((asset) => asset.kind === "image").length, videoCount = harvest.assets.length - imageCount;
  await room.save("harvest", harvest.assets.length ? `Found ${plural(imageCount, "photo")} and ${plural(videoCount, "video")}.` : "No usable photos or videos were found; Autopilot will design around the copy.");

  // 2. Copy ---------------------------------------------------------------------------------
  await input.progress("copy", "Writing channel copy grounded in the research evidence.");
  await room.save("copy", "Writing the campaign copy for every channel.");
  const copyResult = await dependencies.ensureCopy(campaignInput, { reserveCopyCall: () => reserveRequired("spark_copy") });
  runtime.markPaid();
  let copy = copyResult.copy;
  const repairs = copy.claimRepairs ?? [];
  // Records from an earlier release may have trimmed a field rather than replacing it; say so rather than over-claim.
  const alongside = repairs.filter(isAlongsideRepair).length;
  if (repairs.length) notes.push(`Copy check: ${plural(repairs.length, "field")} ${repairs.length === 1 ? "was" : "were"} ${repairs.every((repair) => repair.fallback) ? "replaced with a neutral line" : "repaired"} because the sources could not support ${repairs.length === 1 ? "it" : "them"}${alongside ? ` (${alongside} not rejected, only read with such text)` : ""}; ${CLAIM_REPAIR_DOCUMENT} lists the original text for owner confirmation.`);

  // 3. Analyze ------------------------------------------------------------------------------
  await input.progress("analyze", harvest.assets.length ? `Muse Spark is studying ${plural(harvest.assets.length, "photo and video")} against your goal.` : "Nothing to analyze; moving on to the plan.");
  await room.save("analyze", "Muse Spark is studying each photo and clip against your goal.");
  const offerings = analysisOfferings(input.enrichment);
  const category = bounded(input.business.vertical, 120) || "local business";
  const analysisBinding = digestOf({ version: "autopilot-analysis-1", harvest: digestOf(harvest.assets), goal: input.goal, offerings, name: input.business.name, category });
  let analysis = await readCheckpoint<AnalysisRecord>(directory, "analysis", analysisBinding);
  if (!analysis) {
    analysis = await analyzeHarvest({
      directory, binding: analysisBinding, assets: harvest.assets, library, goal: bounded(input.goal, 600) || "Grow the business", business: { name: bounded(input.business.name, 200) || "Local business", category },
      offerings, gate, dependencies,
      onImageBatch: async (results) => {
        for (const result of results) {
          const media = room.media(result.assetId);
          if (media) { media.status = "analyzed"; media.width = result.width; media.height = result.height; }
        }
        await room.save("analyze");
      },
    });
    await writeCheckpoint(directory, "analysis", analysisBinding, analysis);
  }
  additionalUsage.push(...analysis.usage);
  notes.push(...analysis.notes);
  for (const asset of analysis.assets) {
    const media = room.media(asset.assetId);
    if (!media) continue;
    media.analysis = publicAnalysis(asset);
    if (asset.analysis || asset.shotLog) media.status = "analyzed";
  }
  await room.save("analyze", `Analyzed ${plural(analysis.imagesAnalyzed, "photo")}${analysis.videosLogged ? ` and ${plural(analysis.videosLogged, "clip")}` : ""}.`);

  // 4. Direct -------------------------------------------------------------------------------
  const focusOfferingId = copy.creativeBrief?.focus.offeringId ?? null;
  const planBinding = digestOf({ version: "autopilot-plan-1", assets: digestOf(analysis.assets), focusOfferingId, offerApproved: false });
  let plan = await readCheckpoint<ProductionPlan>(directory, "plan", planBinding);
  if (!plan) {
    plan = planProduction({ assets: analysis.assets, focusOfferingId, offerApproved: false });
    await writeCheckpoint(directory, "plan", planBinding, plan);
  }
  notes.push(...plan.notes);
  const roles = planRoles(plan);
  const scores = new Map(plan.ranking.map((entry) => [entry.assetId, entry.score]));
  for (const media of room.state.media) {
    const excluded = plan.excluded.find((item) => item.assetId === media.assetId);
    media.roles = roles.get(media.assetId) ?? [];
    media.excludedReasons = (excluded?.reasons ?? []).slice(0, 8).map((reason) => bounded(reason, 300));
    media.score = scores.get(media.assetId) ?? null;
    if (excluded) media.status = "excluded";
    else if (media.roles.length) media.status = "selected";
  }
  room.state.plan = {
    heroAssetId: plan.hero?.assetId ?? null, carousel: plan.carousel.map((pick) => pick.assetId).slice(0, 4), reelMode: plan.reel.mode,
    reelReasons: plan.reel.reasons.slice(0, 6).map((reason) => bounded(reason, 400)), channelAssets: { ...plan.channelAssets }, notes: plan.notes.slice(0, 12).map((note) => bounded(note, 400)),
  };
  await room.save("direct", plan.hero ? "The plan is ready: hero, carousel and Reel are chosen." : "No real photo qualified as a hero.");
  await input.progress("direct", plan.hero ? `Planned the campaign around ${plan.reel.mode === "tracked_video" ? "your footage" : "the strongest photo"}; ${plural(plan.excluded.length, "item")} left out for safety or quality.` : "No real photo qualified as a hero; the campaign leads with typography or a labelled illustration.");

  // 5. Segment ------------------------------------------------------------------------------
  await input.progress("segment", "SAM 3.1 is selecting the real product pixels in the chosen photos.");
  await room.save("segment", "SAM 3.1 is selecting the real product pixels.");
  const harvested = new Map(harvest.assets.map((asset) => [asset.assetId, asset]));
  const analyzed = new Map(analysis.assets.map((asset) => [asset.assetId, asset]));
  const stills = new Map<string, StillSource>();
  const still = async (assetId: string) => {
    let source = stills.get(assetId);
    if (!source) {
      const asset = harvested.get(assetId);
      if (!asset || asset.kind !== "image") throw new AutopilotCheckpointError();
      source = await workingStill(library, asset, directory);
      stills.set(assetId, source);
    }
    return source;
  };
  const picks = [plan.hero, ...plan.carousel].filter((pick): pick is NonNullable<typeof pick> => Boolean(pick))
    .filter((pick, index, list) => list.findIndex((other) => other.assetId === pick.assetId) === index).slice(0, MAX_SEGMENTED_STILLS);
  const layers = new Map<string, StillLayer>();
  const samRecords: SamRecord[] = [];
  const maskExtras: CampaignExtraAsset[] = [];
  for (const pick of picks) {
    const source = await still(pick.assetId);
    const outcome = await segmentStill({ directory, still: source, asset: analyzed.get(pick.assetId)!, pick, gate, segment: dependencies.segment });
    if (outcome.usage) additionalUsage.push(outcome.usage);
    // A segmented layer whose mask failed the shape gate is kept on record but never used as a
    // cutout (renderImageFor and the Reel both check it); its note says the photo is shown uncut.
    if (outcome.record.note && (outcome.record.status !== "segmented" || (outcome.layer && !layerIsClean(outcome.layer)))) notes.push(outcome.record.note);
    const record = { ...outcome.record };
    if (outcome.layer) layers.set(pick.assetId, outcome.layer);
    if (outcome.preview) {
      record.preview = await room.publish(`mask-${pick.assetId}.png`, outcome.preview, "image/png");
      const filename = `sam-mask-${pick.assetId}.png`;
      await writeFile(join(outputDir, filename), outcome.preview);
      maskExtras.push({ filename, mediaType: "image", channel: null });
    }
    samRecords.push(record);
    room.state.sam = samRecords.map(publicSam);
    await room.save("segment");
  }
  const images = new Map<string, RenderImage>();
  const imageFor = async (assetId: string) => {
    let image = images.get(assetId);
    if (!image) {
      const source = await still(assetId);
      image = await renderImageFor(source, layers.get(assetId) ?? null, `${harvested.get(assetId)?.provenance === "official_website" ? "Official-website image (rights unknown, review required)" : "Owner-provided image"} selected by Autopilot; see director-report.json.`);
      images.set(assetId, image);
    }
    return image;
  };
  const channelImages: Partial<Record<RoutedChannel, RenderImage>> = {};
  for (const channel of PLAN_CHANNELS) {
    const assetId = plan.channelAssets[channel];
    if (assetId && harvested.get(assetId)?.kind === "image") channelImages[channel] = await imageFor(assetId);
  }
  const carouselImages = plan.carousel.length === 4 ? await Promise.all(plan.carousel.map((pick) => imageFor(pick.assetId))) : undefined;
  let heroImage = plan.hero ? await imageFor(plan.hero.assetId) : undefined;

  // 6. Reel ---------------------------------------------------------------------------------
  await input.progress("reel", plan.reel.mode === "tracked_video" ? "SAM 3.1 is tracking the product through your footage for the Reel." : plan.reel.mode === "still_depth" ? "Composing a depth Reel from the hero photo's real layers." : "No usable real media: preparing a clearly labelled illustration and Reel.");
  await room.save("render", "Composing the Reel.");
  const reelContextBase = {
    directory, binding: planBinding, plan, analyzed: analysis.assets, harvest: harvest.assets, library, stills, layers,
    business: { name: input.business.name, vertical: input.business.vertical }, mode: input.mode, dependencies,
  };
  // The shape-gate verdict is part of the binding, so a Reel rendered before the gate (or with a
  // different verdict) is never reused.
  const layerDigest = [...layers.values()].map((layer) => [layer.assetId, layer.maskSha256, layerIsClean(layer) ? "clean" : "unclean"]);
  /** Set once the labelled illustration has a SAM layer: from then on the Reel is its depth Reel. */
  let illustration: { still: StillSource; layer: StillLayer } | null = null;
  /**
   * "reel" is the Reel the critic sees; "reel-revised" is its local re-render after a copy fix,
   * with its own checkpoint and files so the critiqued Reel and every binding derived from it
   * stay intact across retries. The revision only recovers stored responses (never pays). The
   * illustration's depth Reel keeps separate checkpoints, so the real-media attempt stays reusable.
   */
  const reelFor = async (forCopy: typeof copy, variant: ReelVariant): Promise<ReelRecord> => {
    const name = illustration ? `${variant}-illustration` : variant;
    const binding = digestOf({
      version: "autopilot-reel-1", variant, plan: planBinding, copy: digestOf(forCopy), layers: layerDigest, tracked: dependencies.renderTracked !== null,
      ...(illustration ? { illustration: [illustration.still.sha256, illustration.layer.maskSha256, illustration.layer.cutoutSha256] } : {}),
    });
    const saved = await savedReel(directory, name, binding);
    if (saved) return saved;
    const produced = await produceReel({
      ...reelContextBase, variant, copy: forCopy, ...(illustration ? { illustration } : {}),
      ...(variant === "reel" ? { gate, onTracking: () => room.save("track", "SAM 3.1 is tracking the product through your footage.") } : { gate: recoverOnly }),
    });
    await writeCheckpoint(directory, name, binding, produced);
    return produced;
  };
  let reel = await reelFor(copy, "reel");
  additionalUsage.push(...reel.usage);
  notes.push(...reel.notes);
  let visual: CampaignVisual = { kind: "source_photo", filename: null, description: "Owner and official-website media selected and composed by Autopilot; see director-report.json for each choice.", sourceIds: [], sourceUrls: [], model: null, warnings: [] };
  let reelMode: AutopilotQuality["reelMode"] = reel.mode;
  if (!plan.hero && !reel.files) {
    // No real image or footage carries the campaign: a clearly labelled Muse illustration, when the budget allows.
    try {
      // The harvest already covered the official website, and the director screened (or could not
      // analyze) its images: the visual stage must not read the site again and bring an unscreened
      // website photo back as the hero. Only a labelled Meta illustration is accepted here.
      const prepared = await dependencies.prepareVisual({
        business: { ...input.business, website: null }, copy, enrichment: input.enrichment, sources: input.sources, outputDir, mode: input.mode,
        reuseCompletedOnly: input.reuseCompletedCopyOnly, reserveModelCall: () => reserveRequired("muse_image"),
      });
      if (prepared.usage) additionalUsage.push(prepared.usage);
      if (prepared.image && prepared.visual.kind === "meta_illustration") { visual = prepared.visual; heroImage = prepared.image; reelMode = "illustration"; }
      else if (prepared.image) notes.push("The visual stage returned an unscreened image; it was not used.");
    } catch (error) {
      if (!(error instanceof AutopilotBudgetError)) throw error;
      notes.push("The illustration budget for this run was used up; the campaign uses typography instead.");
    }
    if (reelMode === "illustration" && heroImage) {
      // Spark points, SAM cuts: Muse Spark locates the illustration's own subject (spark_media), SAM 3.1
      // selects it with a box prompt, then concept phrases (sam_image), so the Reel is a labelled depth
      // Reel instead of a flat slideshow; no usable layer keeps the legacy Reel.
      await room.save("render", "Muse Spark and SAM 3.1 are selecting the illustration's subject for the Reel.");
      const source = await illustrationStill(heroImage.bytes, directory);
      const outcome = await segmentIllustration({
        directory, still: source, subjectPhrase: illustrationSubjectPhrase({ copy, enrichment: input.enrichment, business: input.business }),
        analysis: { goal: bounded(input.goal, 600) || "Grow the business", business: { name: bounded(input.business.name, 200) || "Local business", category }, offerings },
        gate, analyzeMedia: dependencies.analyzeMedia, segment: dependencies.segment,
      });
      additionalUsage.push(...outcome.usage);
      notes.push(...outcome.notes);
      const records = outcome.records.map((record) => ({ ...record }));
      if (outcome.preview && records.length) {
        records[records.length - 1].preview = await room.publish(`mask-${ILLUSTRATION_ASSET_ID}.png`, outcome.preview, "image/png");
        const filename = `sam-mask-${ILLUSTRATION_ASSET_ID}.png`;
        await writeFile(join(outputDir, filename), outcome.preview);
        maskExtras.push({ filename, mediaType: "image", channel: null });
      }
      samRecords.push(...records);
      room.state.sam = samRecords.map(publicSam);
      if (outcome.layer && !layerIsClean(outcome.layer)) {
        notes.push("SAM's cutout of the illustration failed the mask shape check, so the Reel uses composed crops of the uncut illustration.");
      } else if (outcome.layer) {
        illustration = { still: source, layer: outcome.layer };
        const depth = await reelFor(copy, "reel");
        notes.push(...depth.notes);
        // The real-media attempt's SAM record (e.g. failed tracking) stays on record.
        if (depth.files) reel = { ...depth, sam: reel.sam };
      }
    }
  }
  if (!heroImage && !Object.keys(channelImages).length && !carouselImages) {
    visual = { kind: "typography", filename: null, description: reel.files ? "Text-led stills; only the Reel uses real footage or photo layers selected by Autopilot." : "Text-led campaign concept; no usable real media or illustration was available.", sourceIds: [], sourceUrls: [], model: null, warnings: [] };
    if (reel.files) notes.push("No photo qualified for the stills, so they are text-led; only the Reel uses real media.");
  }
  if (reel.sam) {
    const record: SamRecord = { ...reel.sam };
    if (reel.overlay) {
      try { record.overlayVideo = await room.publish("sam-overlay.mp4", await readFile(reel.overlay.path), "video/mp4"); } catch { record.overlayVideo = null; }
    }
    samRecords.push(record);
    room.state.sam = samRecords.map(publicSam);
  }
  const overlayExtras: CampaignExtraAsset[] = [];
  if (reel.overlay) {
    await copyFile(reel.overlay.path, join(outputDir, "sam-tracking-overlay.mp4"));
    overlayExtras.push({ filename: "sam-tracking-overlay.mp4", mediaType: "video", channel: null });
  }
  if (room.state.plan) room.state.plan.reelMode = reelMode;
  await room.save("render", "Rendering the campaign stills, carousel and Reel.");

  // 7. Render (for critique) ----------------------------------------------------------------
  await input.progress("render", "Rendering the campaign stills, carousel and Reel locally.");
  const roleCounts = async () => await input.budget.counts() as Record<string, number>;
  const reelNotes = (record: ReelRecord) => [
    "Autopilot selected, ranked and composed this media automatically; director-report.json records every observation, choice and exclusion.",
    ...(harvest.assets.some((asset) => asset.provenance === "official_website" && roles.has(asset.assetId)) ? ["Official-website images have unknown reuse rights; confirm permission before publishing them."] : []),
    ...(layers.size ? ["SAM cutouts select real photo pixels; they do not verify which product is shown."] : []),
    ...(illustration && record.files && reelMode === "illustration" ? ["The Reel animates the labelled AI illustration with a SAM 3.1 cutout of its own pixels; it is not a photo of the business, its products or premises."] : []),
    ...(record.mode === "tracked_video" ? ["The Reel uses the owner's footage with the SAM-tracked subject; sam-tracking-overlay.mp4 shows what was selected."] : []),
    ...(record.withhold ? ["The Reel failed its subject-visibility check and is withheld from approval."] : []),
  ];
  const directorDocument = async (record: ReelRecord, extraNotes: readonly string[]) => directorReport({
    runId: input.runId, plan, analyzed: analysis.assets,
    harvest: { sources: harvest.sources, website: harvest.website, assets: harvest.assets.map(({ assetId, kind, provenance, rights, sourcePageUrl }) => ({ assetId, kind, provenance, rights, sourcePageUrl })) },
    sam: samRecords,
    reel: { mode: reelMode, provenanceLabel: record.provenanceLabel, ledger: record.ledger, violations: record.violations, trackedObject: record.trackedObject ? { label: record.trackedObject.label, framesPresent: record.trackedObject.framesPresent, meanCoverage: record.trackedObject.meanCoverage } : null },
    roleCounts: await roleCounts(), notes: [...new Set([...notes, ...extraNotes])].slice(0, 60),
  });
  const production = (forCopy: typeof copy, record: ReelRecord, reelOverride: PrebuiltReel | null, documents: CampaignProduction["extraDocuments"]): CampaignProduction => {
    const prebuilt = reelOverride ?? prebuiltReel(record);
    return {
      ...(heroImage ? { image: heroImage } : {}), visual,
      render: { channelImages, ...(carouselImages ? { carouselImages } : {}), ...(prebuilt && forCopy.channels.some((channel) => channel.id === "instagram_reels") ? { reel: prebuilt } : {}) },
      extraAssets: [...maskExtras, ...overlayExtras], extraDocuments: documents, extraReviewNotes: reelNotes(record).map((note) => bounded(note, 600)).slice(0, 40),
    };
  };
  const renderBinding = digestOf({ version: "autopilot-render-1", plan: planBinding, copy: digestOf(copy), reel: reel.files, visual, hero: heroImage ? sha256Hex(heroImage.bytes) : null, layers: layerDigest });
  const legacyPaths = { videoPath: join(directory, "reel", "legacy.mp4"), coverPath: join(directory, "reel", "legacy-cover.png") };
  let snapshot = await readCheckpoint<Awaited<ReturnType<typeof critiqueSnapshot>>>(directory, "critique-input", renderBinding);
  let legacyReel = await readCheckpoint<{ videoSha256: string; coverSha256: string }>(directory, "legacy-reel", renderBinding);
  const legacyIntact = async () => Boolean(legacyReel) && (await sha256File(legacyPaths.videoPath).then((file) => file.sha256, () => null)) === legacyReel!.videoSha256
    && (await sha256File(legacyPaths.coverPath).then((file) => file.sha256, () => null)) === legacyReel!.coverSha256;
  if (!snapshot || (!reel.files && !(await legacyIntact()))) {
    const first = await dependencies.renderKit(campaignInput, opportunity, copy, copyResult.usage, production(copy, reel, null, [{ filename: "director-report.json", content: await directorDocument(reel, []) }]));
    snapshot = await critiqueSnapshot(first.campaign, outputDir, directory, renderBinding);
    if (!reel.files && first.campaign.assets.some((asset) => asset.filename === "instagram_reel.mp4")) {
      await mkdir(join(directory, "reel"), { recursive: true, mode: 0o700 });
      await copyFile(join(outputDir, "instagram_reel.mp4"), legacyPaths.videoPath);
      await copyFile(join(outputDir, "instagram_reel_cover.png"), legacyPaths.coverPath);
      legacyReel = { videoSha256: (await sha256File(legacyPaths.videoPath)).sha256, coverSha256: (await sha256File(legacyPaths.coverPath)).sha256 };
      await writeCheckpoint(directory, "legacy-reel", renderBinding, legacyReel);
    }
  }
  notes.push(...snapshot.notes);

  // 8. Critique -----------------------------------------------------------------------------
  await input.progress("critique", "Muse Spark is critiquing the rendered campaign before your review.");
  await room.save("critique", "Muse Spark is checking its own work.");
  const critiqueBinding = digestOf({ version: "autopilot-critique-1", snapshot: digestOf(snapshot), copy: digestOf(copy) });
  let critique = await readCheckpoint<CritiqueOutcome>(directory, "critique", critiqueBinding);
  if (!critique) {
    critique = await runCritique({ directory, snapshot, copy, report: input.report, opportunity, business: { name: input.business.name, vertical: input.business.vertical }, goal: input.goal, gate, critique: dependencies.critique });
    await writeCheckpoint(directory, "critique", critiqueBinding, critique);
  }
  if (critique.usage) additionalUsage.push(critique.usage);
  notes.push(...critique.notes);
  const fixes = applyDeterministicFixes(critique.report, copy, snapshot);
  const withheld = new Set(fixes.withheldFiles);
  if (fixes.copyChanged) copy = fixes.copy;
  let reelOverride: PrebuiltReel | null = !reel.files && legacyReel && !fixes.reelCopyChanged ? { kind: "prebuilt", ...legacyPaths } : null;
  if (fixes.reelCopyChanged && reel.files) {
    // The Reel renders this channel's copy: render it again locally into its own files (stored SAM
    // results are reused, never re-requested). The critiqued Reel and its checkpoint stay untouched.
    reel = await reelFor(copy, "reel-revised");
    reelOverride = null;
    if (reelMode !== "illustration") reelMode = reel.mode;
  }
  if (reel.withhold) REEL_FILES.forEach((file) => withheld.add(file));
  room.state.critic = publicCritic(critique.report, { fixesApplied: fixes.fixesApplied, withheldFiles: [...withheld].sort() });
  await room.save("critique", critique.report ? `The critic reported ${plural(critique.report.findings.length, "finding")}${withheld.size ? `; ${plural(withheld.size, "file")} withheld` : ""}.` : "The self-critique did not run.");

  // 9. Export -------------------------------------------------------------------------------
  await input.progress("export", fixes.fixesApplied.length ? "Applying safe fixes and exporting the review kit." : "Exporting the review kit.");
  await room.save("export", "Exporting the review kit.");
  // Only fixes that were actually applied change bytes; recommendation-only remedies change nothing.
  const recheckFiles = fixes.rerenderedFiles;
  const finalNotes = [...fixes.recommendations, ...(recheckFiles.length ? [`${plural(recheckFiles.length, "file")} changed after the critique (${recheckFiles.slice(0, 6).join(", ")}); review those new versions closely.`] : [])];
  const final = await dependencies.renderKit(campaignInput, opportunity, copy, copyResult.usage, production(copy, reel, reelOverride, [
    { filename: "director-report.json", content: await directorDocument(reel, finalNotes) },
    { filename: "critic-report.json", content: criticReportDocument({ report: critique.report, fixes, snapshot, notes: [...critique.notes, ...snapshot.notes], changedAfterCritique: recheckFiles }) },
  ]));
  const campaign = final.campaign;
  // Withholding follows the source pixels, not just the critiqued file (fail closed).
  const heroSources = heroImage ? [visual.kind === "meta_illustration" ? "@illustration" : plan.hero?.assetId ?? "@hero"] : [];
  const reelPlan = plan.reel;
  const reelSources = reelMode === "illustration" ? heroSources // The illustration's depth Reel or the legacy Reel of it.
    : reel.mode === "tracked_video" && reelPlan.mode === "tracked_video" ? [reelPlan.clipAssetId, ...(reelPlan.fallbackStill ? [reelPlan.fallbackStill.assetId] : [])]
    : reel.mode === "still_depth" && reelPlan.mode === "still_depth" ? [reelPlan.still.assetId]
    : reel.mode === "still_depth" && reelPlan.mode === "tracked_video" && reelPlan.fallbackStill ? [reelPlan.fallbackStill.assetId]
    : heroSources; // The in-kit (legacy) Reel and an unattributable depth Reel are composed from the hero.
  const overlaySources = reelPlan.mode === "tracked_video" ? [reelPlan.clipAssetId] : reelSources;
  const channelSources = (channel: string) => (PLAN_CHANNELS as readonly string[]).includes(channel) && channelImages[channel as PlannedChannel] && plan.channelAssets[channel as PlannedChannel]
    ? [plan.channelAssets[channel as PlannedChannel]!] : heroSources;
  const sourcesOf = (filename: string): readonly string[] => {
    if (filename === "campaign-hero-source.png") return heroSources;
    if (filename === SAM_OVERLAY_FILE) return overlaySources;
    if ((REEL_FILES as readonly string[]).includes(filename)) return reelSources;
    const mask = /^sam-mask-(.+)\.png$/.exec(filename);
    if (mask) return [mask[1] === ILLUSTRATION_ASSET_ID ? "@illustration" : mask[1]];
    const slide = /^instagram_carousel_([1-4])\.png$/.exec(filename);
    if (slide) return carouselImages ? [plan.carousel[Number(slide[1]) - 1]?.assetId ?? "@carousel"] : heroSources;
    if (filename === "facebook_ads_portrait.png") return channelSources("facebook_ads");
    const placement = /^([a-z_]+)\.png$/.exec(filename);
    return placement && campaign.assets.some((asset) => asset.filename === filename && asset.channel === placement[1]) ? channelSources(placement[1]) : [];
  };
  const kitFiles = campaign.assets.map((asset) => asset.filename);
  let withheldFiles = withheldKitFiles({ files: kitFiles, withheld, contentWithheld: fixes.contentWithheldFiles, withholdAll: fixes.withholdAll, sourcesOf });

  // 10. Verification critique -----------------------------------------------------------------
  // Files the fixes re-rendered are critiqued once more, bound to their final bytes, when the critic
  // budget allows. Only withholding and owner-review outcomes apply: nothing is rewritten again.
  const recheckNotes: string[] = [];
  let recheckReport: CritiqueReport | null = null, recheckFixes: RecheckFixes | null = null;
  const recheckTargets = recheckFiles.filter((file) => kitFiles.includes(file) && !withheldFiles.includes(file));
  if (recheckTargets.length) {
    await room.save("export", "Muse Spark is re-checking the files its fixes changed.");
    const recheckInput = digestOf({ version: "autopilot-recheck-1", critique: critiqueBinding, files: recheckTargets, copy: digestOf(copy) });
    const recheckSnapshot = await critiqueSnapshot(campaign, outputDir, directory, recheckInput, { name: "critique-recheck-input", only: recheckTargets });
    const recheckBinding = digestOf({ version: "autopilot-recheck-1", snapshot: digestOf(recheckSnapshot), copy: digestOf(copy) });
    let recheck = await readCheckpoint<CritiqueOutcome>(directory, "critique-recheck", recheckBinding);
    if (!recheck) {
      recheck = await runCritique({ directory, snapshot: recheckSnapshot, copy, report: input.report, opportunity, business: { name: input.business.name, vertical: input.business.vertical }, goal: input.goal, gate, critique: dependencies.critique, round: 2 });
      await writeCheckpoint(directory, "critique-recheck", recheckBinding, recheck);
    }
    if (recheck.usage) additionalUsage.push(recheck.usage);
    if (recheck.report) {
      recheckReport = recheck.report;
      recheckFixes = applyRecheckFixes(recheck.report, copy, recheckSnapshot, snapshot);
      recheckFixes.withheldFiles.forEach((file) => withheld.add(file));
      withheldFiles = withheldKitFiles({
        files: kitFiles, withheld, contentWithheld: [...fixes.contentWithheldFiles, ...recheckFixes.contentWithheldFiles], withholdAll: fixes.withholdAll || recheckFixes.withholdAll, sourcesOf,
      });
      const seen = [...recheckSnapshot.stills, ...(recheckSnapshot.reel ? [recheckSnapshot.reel] : [])];
      const newlyWithheld = recheckTargets.filter((file) => withheldFiles.includes(file));
      recheckNotes.push(`A verification critique re-checked ${plural(seen.length, "changed file")} in ${seen.length === 1 ? "its" : "their"} final version: ${recheck.report.verdict === "blocking_findings" ? "it reported blocking problems" : "no blocking findings"}${newlyWithheld.length ? `; ${plural(newlyWithheld.length, "file")} withheld (${newlyWithheld.slice(0, 6).join(", ")})` : ""}.`);
      // A changed file the verification critique did not see in its final bytes stays disclosed.
      const unseen = recheckTargets.filter((file) => !withheldFiles.includes(file) && seen.find((item) => item.filename === file)?.sha256 !== campaign.assets.find((asset) => asset.filename === file)?.sha256);
      if (unseen.length) recheckNotes.push(`${plural(unseen.length, "changed file")} ${unseen.length === 1 ? "was" : "were"} not re-critiqued in ${unseen.length === 1 ? "its" : "their"} final version (${unseen.slice(0, 6).join(", ")}); review ${unseen.length === 1 ? "it" : "them"} closely.`);
      recheckNotes.push(...recheckFixes.recommendations);
    }
    recheckNotes.push(...recheck.notes, ...recheckSnapshot.notes);
  }
  const withholdAll = fixes.withholdAll || Boolean(recheckFixes?.withholdAll);
  if (withheldFiles.length > MAX_WITHHELD_FILES) throw new Error("Too many withheld files to record; the kit was not offered for approval.");
  if (withholdAll) notes.push("The critic reported a critical problem it could not attribute to one file, so every file is withheld from approval; run Autopilot again for a fresh critique.");
  else {
    const derived = withheldFiles.filter((file) => !withheld.has(file) && file !== ARCHIVE_FILE);
    if (derived.length) notes.push(`${plural(derived.length, "other file")} built from the same photo or footage ${derived.length === 1 ? "is" : "are"} withheld too (${derived.slice(0, 6).join(", ")}).`);
    // The concept archive bundles every kit file, withheld ones included: approving it would approve the withheld bytes.
    if (withheldFiles.includes(ARCHIVE_FILE)) notes.push(`${ARCHIVE_FILE} contains the withheld files, so it is withheld too; approve the individual files instead.`);
  }
  // Every approvable critiqued file whose final bytes differ from what the critic saw, beyond the
  // fixes actually applied, is disclosed.
  const critiqued = [...snapshot.stills, ...(snapshot.reel ? [snapshot.reel] : [])];
  const unexpected = critiqued.filter((item) => !fixes.rerenderedFiles.includes(item.filename) && !withheldFiles.includes(item.filename)
    && campaign.assets.find((asset) => asset.filename === item.filename)?.sha256 !== item.sha256).map((item) => item.filename);
  if (unexpected.length) notes.push(`${plural(unexpected.length, "file")} differ from the critiqued version (${unexpected.slice(0, 6).join(", ")}); review them before approving.`);

  const cover = campaign.assets.find((asset) => asset.filename === "instagram_reel_cover.png");
  if (cover) {
    try { await room.publish("reel-cover.jpg", await sharp(join(outputDir, cover.filename)).resize({ width: 480, height: 480, fit: "inside" }).jpeg({ quality: 82 }).toBuffer(), "image/jpeg"); }
    catch { /* The preview is optional. */ }
  }
  const fixesApplied = [...fixes.fixesApplied, ...(recheckFixes?.fixesApplied ?? [])];
  room.state.critic = publicCritic(critique.report, { fixesApplied, withheldFiles }, recheckReport);
  const quality: AutopilotQuality = {
    version: 1, planVersion: plan.version, reelMode,
    mediaAnalyzed: analysis.imagesAnalyzed + analysis.videosLogged, mediaExcluded: plan.excluded.length,
    criticVerdict: combinedVerdict(critique.report, recheckReport), findings: (critique.report?.findings.length ?? 0) + (recheckReport?.findings.length ?? 0),
    fixesApplied: fixesApplied.map((fix) => bounded(fix, 300)).slice(0, 40), withheldFiles: withheldFiles.map((file) => bounded(file, 160)),
    roleCounts: await roleCounts(),
    // The verification outcome leads, so the notes bound never drops it.
    notes: [...new Set([...recheckNotes, ...notes, ...finalNotes])].map((note) => bounded(note, 600)).filter(Boolean).slice(0, MAX_NOTES),
  };
  await room.save("done", withheldFiles.length ? `Your campaign kit is ready for review; ${plural(withheldFiles.length, "file")} withheld.` : "Your campaign kit is ready for review.");
  return { campaign, usage: copyResult.usage, additionalUsage, quality };
}
