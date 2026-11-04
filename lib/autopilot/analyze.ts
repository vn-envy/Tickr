import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MediaLibrary } from "../media/library";
import { MAX_CLIP_WINDOW_SECONDS, OwnerClipError, verifyNormalizedClip, type normalizeOwnerClip } from "../media/clip";
import type { NormalizedClip, OwnerMediaConsent } from "../media/cinema-types";
import { MEDIA_ANALYSIS_MAX_ASSETS, type analyzeMediaAssets, type MediaAnalysisOffering, type MediaAnalysisResult, type MediaAssetAnalysis } from "../meta/media-analysis";
import { SHOTLOG_MAX_CLIP_BYTES, type analyzeClipShots, type ShotLog } from "../meta/video-understanding";
import { MetaClientError } from "../meta/config";
import type { SparkUsage } from "../meta/spark-response";
import type { BusinessEnrichment, ModelUsage } from "../research/contracts";
import type { AnalyzedAsset, AutopilotRole } from "./contracts";
import type { HarvestedAsset } from "./harvest";
import { AutopilotCheckpointError, readCheckpoint, writeCheckpoint } from "./report";

/**
 * Autopilot analysis: Spark media analysis over the harvested images (≤24 per paid request),
 * owner-clip normalization and Spark shot logs on at most two clips, mapped to the director's
 * provider-agnostic AnalyzedAsset. Every value here is a model OBSERVATION.
 */
export const ANALYSIS_BATCH_SIZE = MEDIA_ANALYSIS_MAX_ASSETS;
export const MAX_ANALYZED_CLIPS = 2;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

export type PaidGateOutcome = "reserved" | "recover" | "exhausted";
/**
 * Called before each paid request. "recover" means a requested marker already exists, so the
 * adapter decodes the stored response (or fails closed) without a new reservation.
 */
export type PaidGate = (role: AutopilotRole, directory: string, storePrefix: string) => Promise<PaidGateOutcome>;

export interface AnalyzeDependencies {
  analyzeMedia: typeof analyzeMediaAssets;
  analyzeShots: typeof analyzeClipShots;
  normalizeClip: typeof normalizeOwnerClip;
}

export interface AnalysisRecord {
  version: 1;
  assets: AnalyzedAsset[];
  /** Normalized analysis clips by asset id (private paths stay in the private checkpoint). */
  clips: Record<string, NormalizedClip>;
  usage: ModelUsage[];
  notes: string[];
  imagesAnalyzed: number;
  imagesUnanalyzed: number;
  videosLogged: number;
}

export function sparkModelUsage(model: string, usage: SparkUsage, elapsedMs: number, imagesProcessed?: number): ModelUsage {
  return { model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, elapsedMs: Math.max(0, Math.round(elapsedMs)), ...(imagesProcessed === undefined ? {} : { imagesProcessed }) };
}

/** Enrichment offerings as untrusted analysis context (bounded, valid ids only). */
export function analysisOfferings(enrichment: BusinessEnrichment | undefined): MediaAnalysisOffering[] {
  const seen = new Set<string>();
  return (enrichment?.offerings ?? []).filter((offering) => {
    if (!ID_PATTERN.test(offering.id) || seen.has(offering.id) || !offering.name.trim()) return false;
    seen.add(offering.id);
    return true;
  }).slice(0, 12).map((offering) => ({ offeringId: offering.id, name: offering.name.slice(0, 120), ...(offering.description.trim() ? { description: offering.description.slice(0, 400) } : {}) }));
}

function consentOf(asset: HarvestedAsset): AnalyzedAsset["consent"] {
  return asset.consent ? { peopleVisibleHaveConsented: asset.consent.peopleVisibleHaveConsented } : null;
}

/** One analyzed (or unanalyzed) image as the director sees it. */
export function analyzedImage(asset: HarvestedAsset, analysis: MediaAssetAnalysis | null): AnalyzedAsset {
  return {
    assetId: asset.assetId, kind: "image", provenance: asset.provenance, rights: asset.rights,
    width: analysis?.width ?? asset.width, height: analysis?.height ?? asset.height, durationSeconds: null, consent: consentOf(asset),
    analysis: analysis ? {
      depicts: analysis.depicts, subjectKind: analysis.subjectKind, matchedOfferingIds: [...analysis.matchedOfferingIds],
      primarySubject: analysis.primarySubject ? { label: analysis.primarySubject.label, box: analysis.primarySubject.box ? { ...analysis.primarySubject.box } : null } : null,
      quality: { ...analysis.technicalQuality }, goalFit: analysis.goalFit, heroWorthy: analysis.heroWorthy, suitableFor: [...analysis.suitableFor],
      risks: analysis.risks.map((risk) => ({ kind: risk.kind, box: risk.box ? { ...risk.box } : null })),
    } : null,
    shotLog: null,
  };
}

/** One video: shot-log times are relative to the normalized analysis clip, which starts at the source's first frame. */
export function analyzedVideo(asset: HarvestedAsset, clip: NormalizedClip | null, shotLog: ShotLog | null): AnalyzedAsset {
  return {
    assetId: asset.assetId, kind: "video", provenance: asset.provenance, rights: asset.rights,
    width: clip?.width ?? asset.width, height: clip?.height ?? asset.height, durationSeconds: clip?.durationSeconds ?? asset.durationSeconds, consent: consentOf(asset),
    analysis: null,
    shotLog: shotLog ? {
      heroMomentSeconds: shotLog.heroMomentSeconds, peopleVisible: shotLog.peopleVisible,
      moments: shotLog.moments.map((moment) => ({ startSeconds: moment.startSeconds, endSeconds: moment.endSeconds, kind: moment.kind, steadiness: moment.steadiness, subjectLabel: moment.subjectLabel, goalFit: moment.goalFit })),
    } : null,
  };
}

/** Clip consent accepted by normalization: owned or licensed, and people consented or none shown. */
export function clipConsent(consent: OwnerMediaConsent | null): OwnerMediaConsent | null {
  if (!consent?.ownsOrLicensedMedia || consent.peopleVisibleHaveConsented === false) return null;
  return consent;
}

/** At most two videos with usable consent: newest first, owner uploads before connected-account media. */
export function chooseAnalysisVideos(assets: readonly HarvestedAsset[]): HarvestedAsset[] {
  const rank = (asset: HarvestedAsset) => (asset.provenance === "owner_upload" ? 0 : 1);
  return assets.filter((asset) => asset.kind === "video" && clipConsent(asset.consent))
    .sort((a, b) => (b.capturedAt ?? b.addedAt).localeCompare(a.capturedAt ?? a.addedAt) || rank(a) - rank(b) || a.assetId.localeCompare(b.assetId))
    .slice(0, MAX_ANALYZED_CLIPS);
}

export interface AnalyzeInput {
  directory: string;
  binding: string;
  assets: readonly HarvestedAsset[];
  library: MediaLibrary;
  goal: string;
  business: { name: string; category: string };
  offerings: MediaAnalysisOffering[];
  gate: PaidGate;
  dependencies: AnalyzeDependencies;
  onImageBatch?: (results: MediaAssetAnalysis[]) => Promise<void>;
}

async function normalizedClips(input: AnalyzeInput, videos: readonly HarvestedAsset[], notes: string[]): Promise<Record<string, NormalizedClip>> {
  const saved = await readCheckpoint<Record<string, NormalizedClip>>(input.directory, "clips", input.binding) ?? {};
  const clips: Record<string, NormalizedClip> = {};
  for (const video of videos) {
    const existing = saved[video.assetId];
    if (existing) {
      // A clip a paid request may already be bound to is reused only when its bytes still verify.
      try { await verifyNormalizedClip(existing); }
      catch { throw new AutopilotCheckpointError("A saved Autopilot clip no longer matches its recorded bytes. No new Meta request was made; start a fresh run."); }
      clips[video.assetId] = existing;
      continue;
    }
    const consent = clipConsent(video.consent);
    if (!consent || video.provenance === "official_website" || video.provenance === "meta_illustration") continue;
    try {
      const record = await input.library.verifyAsset(video.assetId);
      clips[video.assetId] = await input.dependencies.normalizeClip({
        sourcePath: record.localPath, outputDir: join(input.directory, "clips"), consent, provenance: video.provenance, maxSeconds: MAX_CLIP_WINDOW_SECONDS,
      });
      await writeCheckpoint(input.directory, "clips", input.binding, { ...saved, ...clips });
    } catch (error) {
      if (!(error instanceof OwnerClipError)) throw error;
      notes.push(`A video could not be prepared locally (${error.message.replace(/\.$/, "")}), so it was not analyzed.`);
    }
  }
  return clips;
}

/** Runs every analysis request the role budget allows. Meta errors propagate; nothing is retried. */
export async function analyzeHarvest(input: AnalyzeInput): Promise<AnalysisRecord> {
  const notes: string[] = [];
  const usage: ModelUsage[] = [];
  const images = input.assets.filter((asset) => asset.kind === "image");
  const results = new Map<string, MediaAssetAnalysis>();
  let exhausted = false;
  for (let start = 0, batch = 0; start < images.length; start += ANALYSIS_BATCH_SIZE, batch++) {
    const members = images.slice(start, start + ANALYSIS_BATCH_SIZE);
    const directory = join(input.directory, "spark-media", `batch-${batch}`);
    if ((await input.gate("spark_media", directory, "spark-media")) === "exhausted") { exhausted = true; break; }
    const assets = [];
    for (const member of members) {
      const record = await input.library.verifyAsset(member.assetId);
      assets.push({ assetId: member.assetId, bytes: await readFile(record.localPath), mimeType: record.mimeType as "image/png" | "image/jpeg" | "image/webp", provenance: member.provenance, ...(member.caption ? { caption: member.caption } : {}) });
    }
    const result: MediaAnalysisResult = await input.dependencies.analyzeMedia({ assets, goal: input.goal, business: input.business, offerings: input.offerings, detectRisks: true }, { responseDirectory: directory });
    for (const item of result.assets) results.set(item.assetId, item);
    usage.push(sparkModelUsage(result.model, result.usage, result.elapsedMs, members.length));
    await input.onImageBatch?.(result.assets);
  }
  const unanalyzed = images.length - results.size;
  if (exhausted && unanalyzed) notes.push(`The media-analysis budget for this run was used up; ${unanalyzed} image${unanalyzed === 1 ? " was" : "s were"} not analyzed and cannot be selected.`);

  const videos = chooseAnalysisVideos(input.assets);
  const skippedVideos = input.assets.filter((asset) => asset.kind === "video" && !videos.includes(asset));
  if (skippedVideos.some((asset) => !clipConsent(asset.consent))) notes.push("Videos without a recorded consent for the people shown were not analyzed.");
  const clips = await normalizedClips(input, videos, notes);
  const shotLogs = new Map<string, ShotLog>();
  for (const video of videos) {
    const clip = clips[video.assetId];
    if (!clip) continue;
    if (clip.provenance !== "owner_upload") { notes.push("Shot logs for connected-account videos are not enabled yet; that footage was not used for the Reel."); continue; }
    if ((await stat(clip.path)).size > SHOTLOG_MAX_CLIP_BYTES) { notes.push("A prepared clip exceeded the shot-log size limit, so it was not analyzed."); continue; }
    const directory = join(input.directory, "spark-shotlog", video.assetId);
    const gate = await input.gate("spark_shotlog", directory, "spark-shotlog");
    if (gate === "exhausted") { notes.push("The shot-log budget for this run was used up; remaining footage was not analyzed."); break; }
    try {
      const log = await input.dependencies.analyzeShots({ clip, goal: input.goal, business: input.business, offerings: input.offerings }, { responseDirectory: directory });
      shotLogs.set(video.assetId, log);
      usage.push(sparkModelUsage(log.model, log.usage, log.elapsedMs));
    } catch (error) {
      // An optional shot log fails closed: the footage is simply not used, and the request is never repeated.
      if (!(error instanceof MetaClientError)) throw error;
      notes.push("A video shot log did not complete; that footage was not used and the request was not repeated.");
    }
  }

  const assets = input.assets.map((asset) => asset.kind === "image"
    ? analyzedImage(asset, results.get(asset.assetId) ?? null)
    : analyzedVideo(asset, clips[asset.assetId] ?? null, shotLogs.get(asset.assetId) ?? null));
  return { version: 1, assets, clips, usage, notes, imagesAnalyzed: results.size, imagesUnanalyzed: unanalyzed, videosLogged: shotLogs.size };
}
