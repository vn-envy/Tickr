import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { escapeSvg, resolveCampaignTheme, type PrebuiltReel, type RenderImage } from "../campaign/render";
import type { CampaignCopy } from "../campaign/copy";
import { CinemaEncodeError, sha256File } from "../campaign/cinema/encode";
import { dilateMask } from "../campaign/cinema/fill";
import type { renderSamOverlayVideo } from "../campaign/cinema/overlay";
import { StillDepthError, type renderStillDepthReel, type StillDepthScene, type StillDepthTheme } from "../campaign/cinema/still-depth";
import { TrackedCinemaError, type renderTrackedReel } from "../campaign/cinema/tracked";
import { REEL_HEIGHT, REEL_WIDTH } from "../rendering/reel-contract";
import { OwnerClipError, renderClipMatches, verifyRenderClip, type normalizeOwnerClip, type normalizeOwnerRenderClip, type OwnerRenderClip } from "../media/clip";
import type { CompositionLedger, NormalizedClip } from "../media/cinema-types";
import type { MediaLibrary } from "../media/library";
import { MaskletStoreError } from "../media/masklets";
import { composeObjectLayers, type ObjectLayer } from "../media/object-layers";
import { MetaClientError } from "../meta/config";
import { scaleSamBox, type SamObjectPrompt } from "../meta/sam-prompts";
import type { segmentMetaImage } from "../meta/segmentation";
import type { trackMetaVideo } from "../meta/sam-video";
import type { ModelUsage } from "../research/contracts";
import { clipConsent, type PaidGate } from "./analyze";
import type { AnalyzedAsset, ProductionPlan, ReelPlan, StillPick } from "./contracts";
import type { HarvestedAsset } from "./harvest";
import { AutopilotCheckpointError, bounded, readCheckpoint, sha256Hex, writeCheckpoint, type SamRecord } from "./report";

/**
 * Autopilot production from real pixels: working stills, SAM 3.1 image cutouts (box prompt from
 * Spark's located subject, concept phrase as fallback, composed crops when neither works), mask
 * previews, and the Reel — SAM-tracked owner footage, a still-depth Reel from the hero layers,
 * a depth Reel from a SAM cutout of the labelled illustration, or the legacy path. SAM masks only
 * SELECT existing pixels (real photo pixels, or the illustration's own); nothing here verifies
 * what a selected object is.
 */
export const MAX_SEGMENTED_STILLS = 5;
export const WORKING_LONG_SIDE = 2048;
const PREVIEW_LONG_SIDE = 720;
const MIN_LAYER_COVERAGE = 0.005;
const MAX_LAYER_COVERAGE = 0.95;
/** A tracked object must be present on at least this share of the clip's frames to drive the Reel. */
const MIN_TRACK_PRESENCE = 0.6;
const MIN_TRACK_COVERAGE = 0.01;

export interface StillSource { assetId: string; provenance: HarvestedAsset["provenance"]; bytes: Buffer; mimeType: "image/jpeg"; width: number; height: number; sha256: string }

/** Atomic 0600 write (pending file, fsync, rename): a crash never leaves a truncated file at `path`. */
async function writeAtomic(path: string, bytes: Buffer): Promise<void> {
  const pending = `${path}.${process.pid}.pending`;
  const handle = await open(pending, "w", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await rename(pending, path); } catch (error) { await unlink(pending).catch(() => undefined); throw error; }
}

/** Oriented, flattened JPEG (≤2048 px) of a library image: the exact bytes SAM, previews and the renderer use. */
export async function workingStill(library: MediaLibrary, asset: HarvestedAsset, directory: string): Promise<StillSource> {
  const path = join(directory, "stills", `${asset.assetId}.jpg`);
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const record = await library.verifyAsset(asset.assetId);
    bytes = await sharp(record.localPath, { limitInputPixels: 50_000_000, failOn: "error", animated: false })
      .rotate().resize({ width: WORKING_LONG_SIDE, height: WORKING_LONG_SIDE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
    await mkdir(join(directory, "stills"), { recursive: true, mode: 0o700 });
    await writeAtomic(path, bytes);
  }
  // A full decode (not only the header) so a damaged saved still is never sent to SAM or rendered.
  // Any SAM checkpoint is also bound to these exact bytes (its binding is their sha256).
  const decoded = await sharp(bytes, { failOn: "truncated", limitInputPixels: 50_000_000 }).raw().toBuffer({ resolveWithObject: true }).catch(() => null);
  const metadata = decoded ? await sharp(bytes).metadata() : null;
  if (!decoded || metadata?.format !== "jpeg" || !metadata.width || !metadata.height || metadata.width > WORKING_LONG_SIDE || metadata.height > WORKING_LONG_SIDE) {
    throw new AutopilotCheckpointError("A saved Autopilot working image is not readable. No new Meta request was made; start a fresh run.");
  }
  return { assetId: asset.assetId, provenance: asset.provenance, bytes, mimeType: "image/jpeg", width: metadata.width, height: metadata.height, sha256: sha256Hex(bytes) };
}

/** Asset id of the labelled Muse illustration when it stands in for missing real media. */
export const ILLUSTRATION_ASSET_ID = "meta-illustration";
/** Visible provenance of the illustration's SAM depth Reel: still clearly an illustration. */
export const ILLUSTRATION_REEL_LABEL = "ILLUSTRATIVE IMAGE · SAM CUTOUT";

/**
 * The working JPEG of the labelled Muse illustration (same treatment as a library still). The file
 * is named by the illustration's hash, so a saved copy only ever matches the same illustration.
 */
export async function illustrationStill(illustration: Uint8Array, directory: string): Promise<StillSource> {
  const path = join(directory, "stills", `${ILLUSTRATION_ASSET_ID}-${sha256Hex(illustration).slice(0, 16)}.jpg`);
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    bytes = await sharp(illustration, { limitInputPixels: 50_000_000, failOn: "error", animated: false })
      .resize({ width: WORKING_LONG_SIDE, height: WORKING_LONG_SIDE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
    await mkdir(join(directory, "stills"), { recursive: true, mode: 0o700 });
    await writeAtomic(path, bytes);
  }
  const decoded = await sharp(bytes, { failOn: "truncated", limitInputPixels: 50_000_000 }).raw().toBuffer({ resolveWithObject: true }).catch(() => null);
  const metadata = decoded ? await sharp(bytes).metadata() : null;
  if (!decoded || metadata?.format !== "jpeg" || !metadata.width || !metadata.height || metadata.width > WORKING_LONG_SIDE || metadata.height > WORKING_LONG_SIDE) {
    throw new AutopilotCheckpointError("A saved Autopilot working image is not readable. No new Meta request was made; start a fresh run.");
  }
  return { assetId: ILLUSTRATION_ASSET_ID, provenance: "meta_illustration", bytes, mimeType: "image/jpeg", width: metadata.width, height: metadata.height, sha256: sha256Hex(bytes) };
}

/** Visible footer provenance for a routed still. */
export function stillProvenanceLabel(provenance: HarvestedAsset["provenance"], cutout: boolean): string {
  const base = provenance === "owner_upload" ? "OWNER PHOTO" : provenance === "owner_instagram" ? "OWNER INSTAGRAM PHOTO" : provenance === "owner_facebook" ? "OWNER FACEBOOK PHOTO"
    : provenance === "official_website" ? "WEBSITE IMAGE" : "ILLUSTRATIVE IMAGE";
  return cutout && provenance !== "meta_illustration" ? `${base} · SAM CUTOUT` : base;
}

export interface StillLayer { assetId: string; cutoutPath: string; maskPath: string; cutoutSha256: string; maskSha256: string; coverage: number; objectId: string }
export interface SegmentOutcome { layer: StillLayer | null; record: SamRecord; usage: ModelUsage | null; preview: Buffer | null }

function bestLayer(layers: readonly ObjectLayer[], preferredPromptId: number | null): ObjectLayer | null {
  if (!layers.length) return null;
  const preferred = preferredPromptId === null ? undefined : layers.find((layer) => layer.promptObjectId === preferredPromptId);
  return preferred ?? [...layers].sort((a, b) => b.coverage * (b.confidence ?? 1) - a.coverage * (a.confidence ?? 1) || a.objectId.localeCompare(b.objectId))[0];
}

/** Dimmed source + unchanged subject pixels + outline + a visible provenance label (≤720 px PNG). */
export async function maskPreview(still: Pick<StillSource, "bytes" | "width" | "height">, maskPng: Buffer, label: string, accent = "#F2B134"): Promise<Buffer> {
  const scale = Math.min(1, PREVIEW_LONG_SIDE / Math.max(still.width, still.height));
  const width = Math.max(2, Math.round(still.width * scale)), height = Math.max(2, Math.round(still.height * scale));
  const source = await sharp(still.bytes).resize(width, height, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const mask = await sharp(maskPng).resize(width, height, { fit: "fill", kernel: "nearest" }).removeAlpha().greyscale().raw().toBuffer();
  const grown = dilateMask(mask, width, height, 3);
  const rgb = Buffer.alloc(width * height * 3);
  const [ar, ag, ab] = [1, 3, 5].map((offset) => Number.parseInt(accent.slice(offset, offset + 2), 16));
  for (let index = 0; index < width * height; index++) {
    const inside = mask[index] >= 128, edge = !inside && grown[index] === 1;
    for (let channel = 0; channel < 3; channel++) {
      const value = source[index * 3 + channel];
      rgb[index * 3 + channel] = edge ? [ar, ag, ab][channel] : inside ? value : Math.round(value * 0.32);
    }
  }
  const text = escapeSvg(bounded(label, 80).toUpperCase());
  const band = Math.max(28, Math.round(height * 0.07));
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="0" y="${height - band}" width="${width}" height="${band}" fill="#111111" opacity=".78"/><text x="12" y="${height - Math.round(band * 0.32)}" fill="#ffffff" font-family="DejaVu Sans,sans-serif" font-size="${Math.max(10, Math.round(band * 0.42))}" letter-spacing="1">${text}</text></svg>`);
  return sharp(rgb, { raw: { width, height, channels: 3 } }).composite([{ input: overlay, left: 0, top: 0 }]).png().toBuffer();
}

/**
 * One SAM image selection for a planned still. Box prompts come from Spark's located subject
 * (scaled to the working image); a concept phrase is the fallback. Budget exhaustion, no match
 * or any failure falls back to composed crops; a request is never repeated.
 */
export async function segmentStill(input: {
  directory: string; still: StillSource; asset: Pick<AnalyzedAsset, "width" | "height">; pick: Pick<StillPick, "segmentation">; gate: PaidGate; segment: typeof segmentMetaImage;
}): Promise<SegmentOutcome> {
  const { still, pick } = input;
  const plan = pick.segmentation;
  const label = plan.kind === "none" ? "main subject" : plan.label;
  const base: SamRecord = {
    assetId: still.assetId, media: "image", promptKind: plan.kind === "concept" ? "concept" : "geometry", label, origin: plan.kind === "concept" ? "concept_prompt" : plan.kind === "geometry" ? "spark_grounding" : "local_layout",
    status: "skipped", preview: null, overlayVideo: null, coverage: null, framesTracked: null, elapsedMs: null, responseId: null, objectCount: null, note: null,
  };
  if (plan.kind === "none") return { layer: null, record: { ...base, note: "Spark located no single subject; composed crops are used." }, usage: null, preview: null };
  const saved = await readCheckpoint<{ layer: StillLayer | null; record: SamRecord; usage: ModelUsage | null }>(input.directory, `sam-${still.assetId.replace(/_/g, "-")}`, still.sha256);
  if (saved) {
    if (saved.layer) {
      const mask = await readFile(saved.layer.maskPath).catch(() => null);
      const cutout = await readFile(saved.layer.cutoutPath).catch(() => null);
      if (!mask || !cutout || sha256Hex(mask) !== saved.layer.maskSha256 || sha256Hex(cutout) !== saved.layer.cutoutSha256) throw new AutopilotCheckpointError();
      return { ...saved, preview: await maskPreview(still, mask, `SAM 3.1 selection · ${stillProvenanceLabel(still.provenance, false)}`) };
    }
    return { ...saved, preview: null };
  }
  const directory = join(input.directory, "sam-image", still.assetId);
  const gate = await input.gate("sam_image", directory, "sam");
  if (gate === "exhausted") return { layer: null, record: { ...base, note: "The SAM budget for this run was used up; composed crops are used." }, usage: null, preview: null };
  const geometry: SamObjectPrompt[] | undefined = plan.kind === "geometry"
    ? [{ objectId: 0, label: bounded(plan.label, 120) || "main subject", origin: "spark_grounding", prompts: [{ frame: 0, box: scaleSamBox(plan.box, { width: input.asset.width, height: input.asset.height }, { width: still.width, height: still.height }) }] }]
    : undefined;
  let outcome: Omit<SegmentOutcome, "preview">;
  try {
    const result = await input.segment({
      bytes: still.bytes, mimeType: still.mimeType, ...(geometry ? { geometry } : { prompt: plan.kind === "concept" ? plan.phrase : label }),
      sourceAssetId: still.assetId, sourceProvenance: still.provenance === "official_website" ? "source_photo" : still.provenance === "meta_illustration" ? "meta_illustration" : "owner_photo",
    }, { responseDirectory: directory });
    const usage: ModelUsage = { model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, elapsedMs: Math.max(0, Math.round(result.elapsedMs)), imagesProcessed: result.usage.imagesProcessed ?? null };
    // The response is already stored: masks that cannot be composed locally are treated like no
    // match (checkpointed below), so a retry never loops on the same stored response.
    let unusable = false;
    const layers = result.status === "segmented"
      ? await composeObjectLayers(still.bytes, result, { minCoverage: MIN_LAYER_COVERAGE, maxCoverage: MAX_LAYER_COVERAGE }).catch(() => { unusable = true; return [] as ObjectLayer[]; })
      : [];
    const chosen = bestLayer(layers, geometry ? 0 : null);
    const record: SamRecord = { ...base, status: chosen ? "segmented" : unusable ? "failed" : "no_match", coverage: chosen?.coverage ?? null, elapsedMs: result.elapsedMs, responseId: result.responseId, objectCount: result.objects.length,
      note: chosen ? null : unusable ? "SAM's masks could not be composed into a layer locally; composed crops are used and the request was not repeated." : "SAM returned no usable selection; composed crops are used and the request was not repeated." };
    let layer: StillLayer | null = null;
    if (chosen) {
      const layerDir = join(input.directory, "layers");
      await mkdir(layerDir, { recursive: true, mode: 0o700 });
      const cutoutPath = join(layerDir, `${still.assetId}.cutout.png`), maskPath = join(layerDir, `${still.assetId}.mask.png`);
      await writeFile(cutoutPath, chosen.cutoutPng, { mode: 0o600 });
      await writeFile(maskPath, chosen.maskPng, { mode: 0o600 });
      layer = { assetId: still.assetId, cutoutPath, maskPath, cutoutSha256: chosen.sha256s.cutout, maskSha256: chosen.sha256s.mask, coverage: chosen.coverage, objectId: chosen.objectId };
    }
    outcome = { layer, record, usage };
  } catch (error) {
    if (!(error instanceof MetaClientError)) throw error;
    outcome = { layer: null, record: { ...base, status: "failed", note: "The SAM selection did not complete; composed crops are used and the request was not repeated." }, usage: null };
  }
  await writeCheckpoint(input.directory, `sam-${still.assetId.replace(/_/g, "-")}`, still.sha256, outcome);
  const preview = outcome.layer ? await maskPreview(still, await readFile(outcome.layer.maskPath), `SAM 3.1 selection · ${stillProvenanceLabel(still.provenance, false)}`) : null;
  return { ...outcome, preview };
}

/** The routed image for one placement: real pixels, plus the SAM cutout when one exists. */
export async function renderImageFor(still: StillSource, layer: StillLayer | null, description: string): Promise<RenderImage> {
  const foreground = layer ? await readFile(layer.cutoutPath) : undefined;
  if (layer && (!foreground || sha256Hex(foreground) !== layer.cutoutSha256)) throw new AutopilotCheckpointError();
  return {
    bytes: still.bytes, mimeType: still.mimeType, provenance: still.provenance === "official_website" ? "source_photo" : "owner_photo", sourceIds: [], description,
    ...(foreground ? { foregroundBytes: foreground, backgroundStyle: "palette_gradient" as const } : {}),
    provenanceLabel: stillProvenanceLabel(still.provenance, Boolean(foreground)),
  };
}

// ---------------------------------------------------------------------------
// Reel

export interface ReelDependencies {
  normalizeClip: typeof normalizeOwnerClip;
  /**
   * Prepares the local render-resolution copy of the tracking clip's frames for the tracked Reel's
   * output pixels (never sent to Meta). Absent: the Reel is drawn from the 1280-px tracking clip.
   */
  normalizeRenderClip?: typeof normalizeOwnerRenderClip;
  trackVideo: typeof trackMetaVideo;
  /** Null when no tracked-footage renderer is available; Autopilot then never pays for SAM video. */
  renderTracked: typeof renderTrackedReel | null;
  renderStillDepth: typeof renderStillDepthReel;
  renderOverlay: typeof renderSamOverlayVideo;
}

export interface ReelRecord {
  version: 1;
  mode: "tracked_video" | "still_depth" | "legacy";
  /** Prebuilt Reel files (private); null for the legacy in-kit Reel. */
  files: { videoPath: string; coverPath: string; videoSha256: string; coverSha256: string } | null;
  overlay: { path: string; sha256: string } | null;
  provenanceLabel: string | null;
  ledger: CompositionLedger | null;
  violations: string[];
  /** The Reel must be withheld from the ready kit (subject hidden or missing). */
  withhold: boolean;
  trackedObject: { objectId: string; label: string; framesPresent: number; frameCount: number; meanCoverage: number } | null;
  sam: SamRecord | null;
  usage: ModelUsage[];
  notes: string[];
}

export function reelScenes(copy: CampaignCopy): { scenes: StillDepthScene[]; cta: string } {
  const reel = copy.channels.find((channel) => channel.id === "instagram_reels") ?? copy.channels[0];
  const kicker = bounded(copy.creativeBrief?.focus.name || reel?.title || copy.name, 60);
  const scenes = copy.creativeBrief
    ? copy.creativeBrief.scenes.map((scene) => ({ headline: bounded(scene.headline, 140) || bounded(copy.name, 140), body: bounded(scene.body, 320), kicker }))
    : [
      { headline: reel.headline, body: reel.body, kicker },
      { headline: reel.body, body: reel.headline, kicker },
      { headline: reel.caption.split(/[.!?]\s/)[0] || reel.headline, body: reel.body, kicker },
      { headline: reel.cta, body: reel.headline, kicker },
    ].map((scene) => ({ headline: bounded(scene.headline, 140) || bounded(copy.name, 140), body: bounded(scene.body, 320), kicker: scene.kicker }));
  return { scenes, cta: bounded(reel?.cta || copy.primaryCta, 48) || "Learn more" };
}

export function reelTheme(vertical: string, copy: CampaignCopy): StillDepthTheme {
  const theme = resolveCampaignTheme({ vertical, creativeBrief: copy.creativeBrief });
  return { paper: theme.paper, ink: theme.ink, accent: theme.accent, soft: theme.soft };
}

async function verifiedFile(path: string, sha256: string): Promise<boolean> {
  try { return (await sha256File(path)).sha256 === sha256; } catch { return false; }
}

/** Checkpoint name and file suffix of the Reel first rendered for critique, and of its post-critique re-render. */
export type ReelVariant = "reel" | "reel-revised";
const variantSuffix = (variant: ReelVariant) => (variant === "reel" ? "" : "-revised");

/** The saved Reel (checkpoint `name`), reused only when every file still matches its recorded hash. */
export async function savedReel(directory: string, name: string, binding: string): Promise<ReelRecord | null> {
  const saved = await readCheckpoint<ReelRecord>(directory, name, binding);
  if (!saved) return null;
  if (saved.files && (!(await verifiedFile(saved.files.videoPath, saved.files.videoSha256)) || !(await verifiedFile(saved.files.coverPath, saved.files.coverSha256)))) return null;
  if (saved.overlay && !(await verifiedFile(saved.overlay.path, saved.overlay.sha256))) return { ...saved, overlay: null };
  return saved;
}

export function prebuiltReel(record: ReelRecord): PrebuiltReel | null {
  return record.files ? { kind: "prebuilt", videoPath: record.files.videoPath, coverPath: record.files.coverPath } : null;
}

export interface ReelContext {
  directory: string;
  /**
   * "reel-revised" writes its own files, so re-rendering after a critic copy fix never
   * overwrites the critiqued Reel that earlier checkpoints are bound to.
   */
  variant: ReelVariant;
  binding: string;
  plan: ProductionPlan;
  analyzed: readonly AnalyzedAsset[];
  harvest: readonly HarvestedAsset[];
  library: MediaLibrary;
  stills: ReadonlyMap<string, StillSource>;
  layers: ReadonlyMap<string, StillLayer>;
  copy: CampaignCopy;
  business: { name: string; vertical: string };
  mode: "live" | "synthetic";
  gate: PaidGate;
  dependencies: ReelDependencies;
  /** Called before the paid SAM video request so the director's room shows the tracking phase. */
  onTracking?: () => Promise<void>;
  /**
   * The labelled Muse illustration and its SAM layer, present only when no real photo or footage
   * carries the Reel: the Reel is then a depth Reel of the illustration, still labelled as one.
   */
  illustration?: { still: StillSource; layer: StillLayer } | null;
}

const reelPaths = (context: Pick<ReelContext, "directory" | "variant">, name: string) => {
  const stem = `${name}${variantSuffix(context.variant)}`;
  return { videoPath: join(context.directory, "reel", `${stem}.mp4`), coverPath: join(context.directory, "reel", `${stem}-cover.png`) };
};

async function filesRecord(paths: { videoPath: string; coverPath: string }) {
  return { ...paths, videoSha256: (await sha256File(paths.videoPath)).sha256, coverSha256: (await sha256File(paths.coverPath)).sha256 };
}

const WITHHOLD_VIOLATIONS = new Set(["foreground_occlusion", "subject_missing"]);

async function stillDepthReel(context: ReelContext, still: StillPick | null, notes: string[]): Promise<ReelRecord | null> {
  const layer = still ? context.layers.get(still.assetId) : undefined;
  const source = still ? context.stills.get(still.assetId) : undefined;
  if (!layer || !source) return null;
  return depthReel(context, { source, layer, name: "still-depth", label: `${stillProvenanceLabel(source.provenance, false)} · SAM DEPTH`, fallbackNote: "The depth Reel could not be composed locally; the Reel uses composed crops of the hero photo instead." }, notes);
}

async function depthReel(context: ReelContext, input: { source: StillSource; layer: StillLayer; name: string; label: string; fallbackNote: string }, notes: string[]): Promise<ReelRecord | null> {
  const { source, layer, label } = input;
  const mask = await readFile(layer.maskPath);
  if (sha256Hex(mask) !== layer.maskSha256) throw new AutopilotCheckpointError();
  const { scenes, cta } = reelScenes(context.copy);
  const paths = reelPaths(context, input.name);
  await mkdir(join(context.directory, "reel"), { recursive: true, mode: 0o700 });
  let result: Awaited<ReturnType<typeof renderStillDepthReel>>;
  try {
    result = await context.dependencies.renderStillDepth({
      source: await sharp(source.bytes).png().toBuffer(), subjectMask: mask, scenes, cta,
      businessName: bounded(context.business.name, 100) || "Local business", campaignName: bounded(context.copy.name, 140) || "Campaign", mode: context.mode,
      provenanceLabel: label, theme: reelTheme(context.business.vertical, context.copy), outputPath: paths.videoPath, coverPath: paths.coverPath,
    });
  } catch (error) {
    if (!(error instanceof StillDepthError || error instanceof CinemaEncodeError)) throw error;
    notes.push(input.fallbackNote);
    return null;
  }
  const violations = [...result.qa.violations];
  if (violations.includes("headline_in_front")) notes.push("The Reel's hook headline could not sit behind the product; review that layout.");
  const withhold = violations.some((violation) => WITHHOLD_VIOLATIONS.has(violation));
  if (withhold) notes.push("The depth Reel hid or lost the real subject in some frames, so it is withheld from the ready kit.");
  return {
    version: 1, mode: "still_depth", files: await filesRecord(paths), overlay: null, provenanceLabel: result.layout.provenanceLabel, ledger: result.ledger,
    violations, withhold, trackedObject: null, sam: null, usage: [], notes,
  };
}

/** Longest track × mean coverage among objects present on most frames. */
export function heroTrack(objects: ReadonlyArray<{ objectId: string; framesPresent: number; meanCoverage: number; label: string }>, frameCount: number) {
  return [...objects]
    .filter((object) => object.framesPresent >= Math.ceil(frameCount * MIN_TRACK_PRESENCE) && object.meanCoverage >= MIN_TRACK_COVERAGE)
    .sort((a, b) => b.framesPresent * b.meanCoverage - a.framesPresent * a.meanCoverage || a.objectId.localeCompare(b.objectId))[0] ?? null;
}

/**
 * The render-resolution footage for the tracked Reel, reused from its checkpoint only while it still
 * verifies against the tracking clip. Null (with a note) when it cannot be prepared: the Reel then
 * uses the tracking clip and its QA reports any enlargement.
 */
async function reelRenderClip(context: ReelContext, assetId: string, consent: NonNullable<ReturnType<typeof clipConsent>>, reel: Extract<ReelPlan, { mode: "tracked_video" }>, clip: NormalizedClip, notes: string[]): Promise<OwnerRenderClip | null> {
  const normalize = context.dependencies.normalizeRenderClip;
  if (!normalize) return null;
  const saved = await readCheckpoint<{ renderClip: OwnerRenderClip | null }>(context.directory, "reel-render-clip", context.binding);
  if (saved && saved.renderClip === null) return null;
  if (saved?.renderClip) {
    try { await verifyRenderClip(saved.renderClip, clip); return saved.renderClip; } catch (error) { if (!(error instanceof OwnerClipError)) throw error; }
  }
  let renderClip: OwnerRenderClip | null;
  try {
    const record = await context.library.verifyAsset(assetId);
    renderClip = await normalize({
      tracking: clip, sourcePath: record.localPath, outputDir: join(context.directory, "reel-clips"), consent,
      startSeconds: reel.windowStartSeconds, maxSeconds: Math.max(0.5, reel.windowSeconds), cover: { width: REEL_WIDTH, height: REEL_HEIGHT },
    });
  } catch (error) {
    if (!(error instanceof OwnerClipError)) throw error;
    notes.push("The owner footage could not be prepared at full Reel resolution; the Reel uses the smaller tracking copy.");
    return null;
  }
  if (renderClip && !renderClipMatches(renderClip, clip)) {
    notes.push("The full-resolution footage did not match the tracked frames; the Reel uses the smaller tracking copy.");
    return null;
  }
  await writeCheckpoint(context.directory, "reel-render-clip", context.binding, { renderClip });
  return renderClip;
}

async function trackedReel(context: ReelContext, reel: Extract<ReelPlan, { mode: "tracked_video" }>, notes: string[]): Promise<ReelRecord | null> {
  const renderTracked = context.dependencies.renderTracked;
  if (!renderTracked) { notes.push("Tracked-footage Reels are not available in this build; the hero photo drives the Reel instead."); return null; }
  const asset = context.harvest.find((item) => item.assetId === reel.clipAssetId);
  const consent = clipConsent(asset?.consent ?? null);
  if (!asset || !consent || asset.provenance === "official_website" || asset.provenance === "meta_illustration") { notes.push("The planned footage has no usable owner consent; the hero photo drives the Reel instead."); return null; }
  let clip = await readCheckpoint<NormalizedClip>(context.directory, "reel-clip", context.binding);
  if (!clip) {
    try {
      const record = await context.library.verifyAsset(asset.assetId);
      clip = await context.dependencies.normalizeClip({ sourcePath: record.localPath, outputDir: join(context.directory, "reel-clips"), consent, provenance: asset.provenance, startSeconds: reel.windowStartSeconds, maxSeconds: Math.max(0.5, reel.windowSeconds) });
    } catch (error) {
      if (!(error instanceof OwnerClipError)) throw error;
      notes.push("The planned footage could not be prepared locally; the hero photo drives the Reel instead.");
      return null;
    }
    await writeCheckpoint(context.directory, "reel-clip", context.binding, clip);
  }
  const phrase = bounded(reel.subjectLabel, 120);
  const sam: SamRecord = { assetId: asset.assetId, media: "video", promptKind: "concept", label: phrase, origin: "concept_prompt", status: "skipped", preview: null, overlayVideo: null, coverage: null, framesTracked: null, elapsedMs: null, responseId: null, objectCount: null, note: null };
  const responseDirectory = join(context.directory, "sam-video", clip.id);
  const gate = await context.gate("sam_video", responseDirectory, "sam-video");
  if (gate === "exhausted") { notes.push("The SAM video budget for this run was used up; the hero photo drives the Reel instead."); return null; }
  await context.onTracking?.();
  let tracked: Awaited<ReturnType<typeof trackMetaVideo>>;
  try {
    tracked = await context.dependencies.trackVideo({ clip, prompt: { kind: "concept", phrase, label: phrase }, propagation: "both" }, { responseDirectory, outputDirectory: join(context.directory, "masklets", clip.id) });
  } catch (error) {
    // The adapter reports decode and masklet-store failures as MetaClientError; a bare
    // MaskletStoreError is handled the same way so a stored response never causes a retry loop.
    if (!(error instanceof MetaClientError || error instanceof MaskletStoreError)) throw error;
    notes.push("SAM video tracking did not complete and was not repeated; the hero photo drives the Reel instead.");
    return { ...emptyRecord(), sam: { ...sam, status: "failed", note: "Tracking did not complete; not repeated." } };
  }
  const usage: ModelUsage = { model: "sam-3.1", inputTokens: null, outputTokens: null, elapsedMs: Math.max(0, Math.round(tracked.set.elapsedMs)) };
  const hero = heroTrack(tracked.set.objects, clip.frameCount);
  const trackedSam: SamRecord = { ...sam, status: hero ? "tracked" : "no_match", coverage: hero?.meanCoverage ?? null, framesTracked: hero?.framesPresent ?? 0, elapsedMs: tracked.set.elapsedMs, responseId: tracked.set.responseId, objectCount: tracked.set.objects.length,
    note: hero ? null : "SAM tracked no object steadily enough to carry the Reel." };
  if (!hero) { notes.push("SAM did not track the subject steadily enough; the hero photo drives the Reel instead."); return { ...emptyRecord(), sam: trackedSam, usage: [usage] }; }
  const { scenes, cta } = reelScenes(context.copy);
  const paths = reelPaths(context, "tracked");
  await mkdir(join(context.directory, "reel"), { recursive: true, mode: 0o700 });
  const ownerLabel = asset.provenance === "owner_upload" ? "OWNER VIDEO" : asset.provenance === "owner_instagram" ? "OWNER INSTAGRAM VIDEO" : "OWNER FACEBOOK VIDEO";
  // The CTA end card reuses the hero photo's SAM layer when the footage window is shorter than the Reel.
  const endStill = reel.fallbackStill ? context.stills.get(reel.fallbackStill.assetId) : undefined;
  const endLayer = reel.fallbackStill ? context.layers.get(reel.fallbackStill.assetId) : undefined;
  const endMask = endLayer ? await readFile(endLayer.maskPath) : null;
  const endCard = endStill && endMask && sha256Hex(endMask) === endLayer!.maskSha256 ? { source: await sharp(endStill.bytes).png().toBuffer(), subjectMask: endMask, provenanceLabel: stillProvenanceLabel(endStill.provenance, true) } : undefined;
  const renderClip = await reelRenderClip(context, asset.assetId, consent, reel, clip, notes);
  let result: Awaited<ReturnType<typeof renderTrackedReel>>;
  try {
    result = await renderTracked({
      clip, ...(renderClip ? { renderClip } : {}), reader: tracked.reader, heroObjectId: hero.objectId, scenes, cta,
      businessName: bounded(context.business.name, 100) || "Local business", campaignName: bounded(context.copy.name, 140) || "Campaign", mode: context.mode,
      provenanceLabel: `${ownerLabel} · SAM 3.1 TRACKED`, theme: reelTheme(context.business.vertical, context.copy), outputPath: paths.videoPath, coverPath: paths.coverPath,
      ...(endCard ? { endCard } : {}),
    });
  } catch (error) {
    if (!(error instanceof TrackedCinemaError || error instanceof CinemaEncodeError || error instanceof MaskletStoreError)) throw error;
    notes.push("The tracked Reel could not be composed locally; the hero photo drives the Reel instead. The stored SAM tracking is kept.");
    return { ...emptyRecord(), sam: trackedSam, usage: [usage] };
  }
  const violations: string[] = [...result.qa.violations];
  if (violations.includes("tracking_lost")) notes.push("SAM lost the subject on some footage frames; those frames show the footage without the cut-out.");
  if (violations.includes("subject_cropped")) notes.push("The tracked subject touches the frame edge in parts of the Reel; review the framing.");
  if (violations.includes("headline_hidden")) notes.push("The product covers much of the Reel's hook headline; review its legibility.");
  if (result.layout.hookHeadline?.placement === "in_front") notes.push("The product moves through every headline band during the Reel's opening, so its hook headline is set in front of the product on a dark backing; review the framing.");
  if (violations.includes("low_resolution_footage")) {
    const upscale = result.qa.footageUpscale;
    notes.push(`The tracked Reel enlarges the owner footage up to ${upscale.max.toFixed(1)}× (from ${upscale.sourceWidth}×${upscale.sourceHeight}), so it may look soft; review its sharpness or supply higher-resolution footage.`);
  }
  const overlayPath = join(context.directory, "reel", `sam-tracking-overlay${variantSuffix(context.variant)}.mp4`);
  let overlay: ReelRecord["overlay"] = null;
  try {
    const output = await context.dependencies.renderOverlay({ clip, reader: tracked.reader, outputPath: overlayPath, objectLabels: /^\d{1,20}$/.test(hero.objectId) ? { [hero.objectId]: bounded(hero.label, 120) } : {} });
    overlay = { path: overlayPath, sha256: output.video.sha256 };
  } catch { notes.push("The SAM tracking preview video could not be rendered locally."); }
  const withhold = violations.some((violation) => WITHHOLD_VIOLATIONS.has(violation));
  if (withhold) notes.push("The tracked Reel hid or lost the real subject in some frames, so it is withheld from the ready kit.");
  return {
    version: 1, mode: "tracked_video", files: await filesRecord(paths), overlay, provenanceLabel: result.layout.provenanceLabel, ledger: result.ledger, violations, withhold,
    trackedObject: { objectId: hero.objectId, label: hero.label, framesPresent: hero.framesPresent, frameCount: clip.frameCount, meanCoverage: hero.meanCoverage },
    sam: trackedSam, usage: [usage], notes,
  };
}

function emptyRecord(): ReelRecord {
  return { version: 1, mode: "legacy", files: null, overlay: null, provenanceLabel: null, ledger: null, violations: [], withhold: false, trackedObject: null, sam: null, usage: [], notes: [] };
}

/**
 * Produce the Reel the plan asks for, falling back tracked → still-depth → legacy in-kit Reel.
 * The illustration itself comes from the caller (it needs the campaign visual stage); with its
 * SAM layer in `context.illustration`, the Reel is the illustration's depth Reel.
 */
export async function produceReel(context: ReelContext): Promise<ReelRecord> {
  const notes: string[] = [];
  const plan = context.plan.reel;
  if (context.illustration) {
    // The caller supplies the illustration only after real media produced no Reel: SAM's cutout of
    // the labelled illustration drives a depth Reel; without one, the legacy in-kit Reel is used.
    const depth = await depthReel(context, {
      source: context.illustration.still, layer: context.illustration.layer, name: "illustration-depth", label: ILLUSTRATION_REEL_LABEL,
      fallbackNote: "The illustration's depth Reel could not be composed locally; the Reel uses composed crops of the illustration instead.",
    }, notes);
    return depth ? { ...depth, notes } : { ...emptyRecord(), notes };
  }
  let fallback: ReelRecord | null = null;
  if (plan.mode === "tracked_video") {
    const tracked = await trackedReel(context, plan, notes);
    if (tracked?.files) return tracked;
    fallback = tracked;
  }
  const still = plan.mode === "still_depth" ? plan.still : plan.mode === "tracked_video" ? plan.fallbackStill : null;
  const depth = await stillDepthReel(context, still, notes);
  const carried = { sam: fallback?.sam ?? null, usage: fallback?.usage ?? [] };
  if (depth) return { ...depth, ...carried, notes };
  if (still) notes.push("No SAM layer exists for the hero photo; the Reel uses composed crops of it.");
  return { ...emptyRecord(), ...carried, notes };
}
