import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CRITIC_MAX_ASSETS, CRITIC_MAX_REEL_BYTES, CRITIC_REEL_ASSET_ID, type CriticCampaignChannel, type critiqueCampaign, type CritiqueReport } from "../agents/critic";
import { planDeterministicFixes, type DeterministicFixPlan, type FixRemedy } from "../agents/critic-fixes";
import { probeVideo } from "../campaign/cinema/encode";
import type { CampaignCopy } from "../campaign/copy";
import { MetaClientError } from "../meta/config";
import type { CampaignKit, ModelUsage, ResearchOpportunity, ResearchReport } from "../research/contracts";
import type { PaidGate } from "./analyze";
import type { AutopilotPublicState } from "./public-state";
import { bounded, readCheckpoint, sha256Hex, writeCheckpoint } from "./report";

/**
 * Autopilot self-critique: one Muse Spark critic request over the rendered stills (≤16) and the
 * Reel, then deterministic, model-free remedies. Withheld assets leave the ready kit; internal
 * review wording is deleted from channel copy and the affected stills are re-rendered locally;
 * everything else becomes a recorded recommendation for the owner. Findings are diagnostics.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const REEL_FILES = ["instagram_reel.mp4", "instagram_reel_cover.png"] as const;

export interface CritiqueSnapshot {
  version: 1;
  stills: Array<{ assetId: string; filename: string; channel: string | null; sha256: string; width: number; height: number; path: string }>;
  reel: { filename: string; sha256: string; path: string; durationSeconds: number; width: number; height: number } | null;
  notes: string[];
}

/**
 * Private copies of exactly the bytes sent for critique, so a resumed run binds to the same
 * request even after the kit is re-rendered. Reused only when every copy still verifies.
 */
export async function critiqueSnapshot(kit: CampaignKit, outputDir: string, directory: string, binding: string, options: {
  /** Checkpoint and private folder name ("critique-input" for the first critique). */
  name?: string;
  /** Only these kit files (the verification critique of files changed after the first one). */
  only?: readonly string[];
} = {}): Promise<CritiqueSnapshot> {
  const name = options.name ?? "critique-input";
  const only = options.only ? new Set(options.only) : null;
  const saved = await readCheckpoint<CritiqueSnapshot>(directory, name, binding);
  if (saved && await snapshotIntact(saved)) return saved;
  const target = join(directory, name);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const notes: string[] = [];
  const stills: CritiqueSnapshot["stills"] = [];
  for (const asset of kit.assets.filter((item) => item.mediaType === "image" && item.channel !== null && item.filename.endsWith(".png") && (!only || only.has(item.filename))).slice(0, CRITIC_MAX_ASSETS)) {
    if (!ID.test(asset.id) || asset.id === CRITIC_REEL_ASSET_ID || !asset.width || !asset.height) continue;
    const path = join(target, asset.filename);
    await copyFile(join(outputDir, asset.filename), path);
    const bytes = await readFile(path);
    if (sha256Hex(bytes) !== asset.sha256) throw new Error("A rendered still changed before critique.");
    stills.push({ assetId: asset.id, filename: asset.filename, channel: asset.channel, sha256: asset.sha256, width: asset.width, height: asset.height, path });
  }
  let reel: CritiqueSnapshot["reel"] = null;
  const video = kit.assets.find((item) => item.filename === "instagram_reel.mp4" && (!only || only.has(item.filename)));
  if (video && video.bytes <= CRITIC_MAX_REEL_BYTES) {
    const path = join(target, video.filename);
    await copyFile(join(outputDir, video.filename), path);
    if (sha256Hex(await readFile(path)) !== video.sha256) throw new Error("The rendered Reel changed before critique.");
    const probe = await probeVideo(path);
    reel = { filename: video.filename, sha256: video.sha256, path, durationSeconds: probe.durationSeconds, width: probe.width, height: probe.height };
  } else if (video) notes.push("The Reel is larger than the critic's 16 MiB limit, so only its cover was critiqued; review the Reel itself before use.");
  const snapshot: CritiqueSnapshot = { version: 1, stills, reel, notes };
  await writeCheckpoint(directory, name, binding, snapshot);
  return snapshot;
}

async function snapshotIntact(snapshot: CritiqueSnapshot): Promise<boolean> {
  try {
    for (const item of [...snapshot.stills, ...(snapshot.reel ? [snapshot.reel] : [])]) if (sha256Hex(await readFile(item.path)) !== item.sha256) return false;
    return true;
  } catch { return false; }
}

export function criticChannels(copy: CampaignCopy): CriticCampaignChannel[] {
  return copy.channels.map((channel) => ({ id: channel.id, headline: channel.headline, body: channel.body, caption: channel.caption, cta: channel.cta }));
}

export interface CritiqueOutcome { report: CritiqueReport | null; usage: ModelUsage | null; notes: string[] }

/**
 * One paid critique when the budget allows; an exhausted budget or a failed request leaves it "not_run".
 * Round 2 is the single verification critique of the files the round-1 fixes changed (never repeated).
 */
export async function runCritique(input: {
  directory: string; snapshot: CritiqueSnapshot; copy: CampaignCopy; report: ResearchReport; opportunity: ResearchOpportunity;
  business: { name: string; vertical: string }; goal: string; gate: PaidGate; critique: typeof critiqueCampaign; round?: 1 | 2;
}): Promise<CritiqueOutcome> {
  const round = input.round ?? 1;
  if (!input.snapshot.stills.length) return { report: null, usage: null, notes: [round === 1 ? "No rendered stills were available to critique." : "None of the files changed after the critique could be sent for a verification critique; review them carefully."] };
  const directory = join(input.directory, "spark-critic", `round-${round}`);
  const gate = await input.gate("spark_critic", directory, "spark-critic");
  if (gate === "exhausted") return { report: null, usage: null, notes: [round === 1 ? "The critic budget for this run was used up, so the kit was not self-critiqued; review every file carefully." : "The critic budget for this run was used up, so the files changed after the critique were not re-critiqued; review those new versions closely."] };
  const evidenceIds = new Set([...input.opportunity.evidenceIds, ...input.copy.evidenceIds]);
  const supportedClaims = input.report.evidence.filter((item) => evidenceIds.has(item.id) && ID.test(item.id)).slice(0, 40).map((item) => ({ evidenceId: item.id, claim: bounded(item.claim, 500) || item.id }));
  const seasonal = input.copy.creativeBrief?.context?.seasonalTheme.status;
  const assets = [];
  for (const still of input.snapshot.stills) assets.push({ assetId: still.assetId, filename: still.filename, channel: still.channel, png: await readFile(still.path), width: still.width, height: still.height, sha256: still.sha256 });
  try {
    const report = await input.critique({
      assets,
      ...(input.snapshot.reel ? { reel: { filename: input.snapshot.reel.filename, sha256: input.snapshot.reel.sha256, mp4: await readFile(input.snapshot.reel.path), durationSeconds: input.snapshot.reel.durationSeconds, channel: "instagram_reels", width: input.snapshot.reel.width, height: input.snapshot.reel.height } } : {}),
      campaign: {
        name: bounded(input.copy.name, 200) || "Campaign", objective: bounded(input.copy.objective, 600) || "Campaign objective", coreMessage: bounded(input.copy.coreMessage, 400) || "Campaign message",
        primaryCta: bounded(input.copy.primaryCta, 120) || "Learn more",
        // No approved-offer workflow exists: a proposed seasonal theme is at most a proposal.
        offerStatus: seasonal && seasonal !== "none" ? "proposed" : "none",
        supportedClaims,
        channels: criticChannels(input.copy).map((channel) => ({ id: channel.id, headline: bounded(channel.headline, 200), body: bounded(channel.body, 2000), caption: bounded(channel.caption, 2400), cta: bounded(channel.cta, 120) })),
      },
      context: { businessName: bounded(input.business.name, 200) || "Local business", category: bounded(input.business.vertical, 100) || "local business", goal: bounded(input.goal, 600) || "Campaign goal" },
    }, { responseDirectory: directory });
    return { report, usage: { model: report.responseModel ?? report.model, inputTokens: report.usage.inputTokens, outputTokens: report.usage.outputTokens, elapsedMs: Math.max(0, Math.round(report.elapsedMs)) }, notes: [] };
  } catch (error) {
    if (!(error instanceof MetaClientError)) throw error;
    return { report: null, usage: null, notes: [round === 1 ? "The self-critique request did not complete and was not repeated; review every file carefully." : "The verification critique of the changed files did not complete and was not repeated; review those new versions closely."] };
  }
}

export interface AppliedFixes {
  plan: DeterministicFixPlan | null;
  copy: CampaignCopy;
  copyChanged: boolean;
  /** Channel copy the Reel renders changed: the Reel must be rendered again. */
  reelCopyChanged: boolean;
  fixesApplied: string[];
  withheldFiles: string[];
  /**
   * Withheld files whose problem is in the pixels they show (a person, a third-party mark, an
   * unresolved critical finding): every other kit file rendered from the same source is withheld too.
   */
  contentWithheldFiles: string[];
  /**
   * The critic reported a critical problem it could not attribute to one file: nothing in the kit
   * can be approved until it is critiqued again (fail closed).
   */
  withholdAll: boolean;
  /** Critiqued files whose bytes an APPLIED fix re-renders (never recommendation-only remedies). */
  rerenderedFiles: string[];
  recommendations: string[];
}

/** Kit files a critiqued asset id stands for (the Reel and its cover travel together). */
function snapshotFilesOf(snapshot: CritiqueSnapshot, assetId: string): string[] {
  if (assetId === CRITIC_REEL_ASSET_ID) return [...REEL_FILES];
  const still = snapshot.stills.find((item) => item.assetId === assetId);
  if (!still) return [];
  return still.filename === "instagram_reel_cover.png" ? [...REEL_FILES] : [still.filename];
}

const describeRemedy = (remedy: FixRemedy): string | null => {
  switch (remedy.kind) {
    case "relayout_text_away_from_subject": return `Recommended for ${remedy.assetId}: move text away from the subject.`;
    case "recrop_to_subject": return `Recommended for ${remedy.assetId}: recrop around the subject.`;
    case "increase_text_contrast": return `Recommended for ${remedy.assetId}: increase text contrast.`;
    case "restore_cta": return `Recommended for ${remedy.assetId}: restore the call to action “${bounded(remedy.cta, 80)}”.`;
    case "manual_copy_edit": return `Owner edit needed: the ${remedy.channelId} ${remedy.field} contains tentative or conditional wording (${remedy.phrases.slice(0, 3).map((phrase) => `“${bounded(phrase, 40)}”`).join(", ")}).`;
    case "manual_review": return remedy.assetId ? `Owner review needed for ${remedy.assetId} (${remedy.reason.replaceAll("_", " ")}).` : "Owner review needed: the critic reported a critical problem it could not attribute to one file.";
    default: return null;
  }
};

/** Withhold reasons about what the pixels show, so every export of the same source shares them. */
const CONTENT_REASONS: ReadonlySet<string> = new Set(["person_without_consent", "third_party_branding", "unresolved_critical"]);
/** Withhold reasons about the channel copy, so every file rendering that channel's copy shares them. */
const COPY_REASONS: ReadonlySet<string> = new Set(["claim_not_supported", "unapproved_offer"]);
/** Remedies the pipeline never applies: they stay owner recommendations. */
const RECOMMENDATION_ONLY: ReadonlySet<FixRemedy["kind"]> = new Set(["relayout_text_away_from_subject", "recrop_to_subject", "increase_text_contrast", "restore_cta"]);

/**
 * Applies only remedies that need no model: withholding and deleting listed internal wording from
 * channel copy. Fails closed: a critical finding whose remedy is only a recommendation withholds its
 * file, and a critical finding the critic could not attribute to one file withholds the whole kit.
 */
export function applyDeterministicFixes(report: CritiqueReport | null, copy: CampaignCopy, snapshot: CritiqueSnapshot): AppliedFixes {
  if (!report) return { plan: null, copy, copyChanged: false, reelCopyChanged: false, fixesApplied: [], withheldFiles: [], contentWithheldFiles: [], withholdAll: false, rerenderedFiles: [], recommendations: [] };
  const plan = planDeterministicFixes(report, criticChannels(copy));
  const patched: CampaignCopy = { ...copy, channels: copy.channels.map((channel) => ({ ...channel })) };
  const fixesApplied: string[] = [];
  const recommendations: string[] = [];
  let reelCopyChanged = false, copyChanged = false;
  const withheld = new Set<string>(), contentWithheld = new Set<string>(), rerendered = new Set<string>();
  const critical = new Set(report.findings.filter((finding) => finding.severity === "critical").map((finding) => finding.id));
  const filesOf = (assetId: string) => snapshotFilesOf(snapshot, assetId);
  const channelOf = (assetId: string) => assetId === CRITIC_REEL_ASSET_ID ? "instagram_reels" : snapshot.stills.find((item) => item.assetId === assetId)?.channel ?? null;
  const withhold = (assetId: string, reasons: readonly string[]) => {
    const files = filesOf(assetId);
    // A claim or offer lives in the channel copy, which every file of that channel renders.
    const channel = reasons.some((reason) => COPY_REASONS.has(reason)) ? channelOf(assetId) : null;
    if (channel) for (const item of snapshot.stills) if (item.channel === channel) files.push(...filesOf(item.assetId));
    files.forEach((file) => withheld.add(file));
    if (reasons.some((reason) => CONTENT_REASONS.has(reason))) files.forEach((file) => contentWithheld.add(file));
  };
  const withholdAll = plan.remedies.some((remedy) => remedy.kind === "manual_review" && remedy.reason === "unattributed_critical");
  for (const remedy of plan.remedies) {
    if (remedy.kind === "withhold_asset") {
      withhold(remedy.assetId, remedy.reasons);
      fixesApplied.push(bounded(`Withheld ${remedy.assetId === CRITIC_REEL_ASSET_ID ? "the Reel" : remedy.assetId} from the ready kit (${remedy.reasons.map((reason) => reason.replaceAll("_", " ")).join(", ")}).`, 300));
      continue;
    }
    if (remedy.kind === "strip_review_language") {
      const channel = patched.channels.find((item) => item.id === remedy.channelId);
      if (!channel || channel[remedy.field] !== remedy.before) continue;
      channel[remedy.field] = remedy.after;
      copyChanged = true;
      if (remedy.channelId === "instagram_reels") reelCopyChanged = true;
      remedy.assetIds.forEach((assetId) => filesOf(assetId).forEach((file) => rerendered.add(file)));
      fixesApplied.push(bounded(`Removed internal review wording (${remedy.removedPhrases.slice(0, 3).map((phrase) => `“${bounded(phrase, 40)}”`).join(", ")}) from the ${remedy.channelId} ${remedy.field}; affected files were re-rendered locally and need a fresh look.`, 300));
      continue;
    }
    if (RECOMMENDATION_ONLY.has(remedy.kind) && "assetId" in remedy && remedy.assetId && remedy.findingIds.some((id) => critical.has(id))) {
      // Nothing applies this remedy, so the critical finding stays unresolved: withhold the file.
      withhold(remedy.assetId, ["unresolved_critical_layout"]);
      fixesApplied.push(bounded(`Withheld ${remedy.assetId === CRITIC_REEL_ASSET_ID ? "the Reel" : remedy.assetId} from the ready kit (unresolved critical finding: ${remedy.kind.replaceAll("_", " ")} is only a recommendation).`, 300));
    }
    const text = describeRemedy(remedy);
    if (text) recommendations.push(bounded(text, 600));
  }
  if (withholdAll) {
    for (const item of [...snapshot.stills.map((still) => still.filename), ...(snapshot.reel ? [...REEL_FILES] : [])]) { withheld.add(item); contentWithheld.add(item); }
    fixesApplied.push("Withheld the whole kit from approval: the critic reported a critical problem it could not attribute to one file.");
  }
  // A withheld file is never also reported as a re-rendered, approvable change.
  for (const file of withheld) rerendered.delete(file);
  return {
    plan, copy: copyChanged ? patched : copy, copyChanged, reelCopyChanged, fixesApplied: fixesApplied.slice(0, 40),
    withheldFiles: [...withheld].sort(), contentWithheldFiles: [...contentWithheld].sort(), withholdAll, rerenderedFiles: [...rerendered].sort(),
    recommendations: [...new Set(recommendations)],
  };
}

export interface RecheckFixes {
  withheldFiles: string[];
  contentWithheldFiles: string[];
  /** Fail closed exactly like the first critique: an unattributable critical finding withholds the kit. */
  withholdAll: boolean;
  fixesApplied: string[];
  recommendations: string[];
}

/**
 * Outcomes of the single verification critique over the files the first fixes changed. Only
 * withholding and owner-review outcomes apply: nothing is rewritten or re-rendered again, so the
 * critique never loops. A rewrite it would ask for stays an owner edit, and withholds the files
 * when its finding is critical (an unresolved critical finding is never left approvable).
 */
export function applyRecheckFixes(report: CritiqueReport, copy: CampaignCopy, snapshot: CritiqueSnapshot, critiqued: CritiqueSnapshot | null = null): RecheckFixes {
  const applied = applyDeterministicFixes(report, copy, snapshot);
  const withheld = new Set(applied.withheldFiles), contentWithheld = new Set(applied.contentWithheldFiles);
  const fixesApplied = applied.fixesApplied.filter((fix) => fix.startsWith("Withheld"));
  const recommendations = [...applied.recommendations];
  const critical = new Set(report.findings.filter((finding) => finding.severity === "critical").map((finding) => finding.id));
  for (const remedy of applied.plan?.remedies ?? []) {
    if (remedy.kind === "withhold_asset" && critiqued && remedy.reasons.some((reason) => COPY_REASONS.has(reason))) {
      // A claim or offer lives in the channel copy: every critiqued file of that channel shares it,
      // including files the verification critique did not see again.
      const channel = remedy.assetId === CRITIC_REEL_ASSET_ID ? "instagram_reels" : snapshot.stills.find((item) => item.assetId === remedy.assetId)?.channel ?? null;
      if (channel) for (const item of critiqued.stills) if (item.channel === channel) snapshotFilesOf(critiqued, item.assetId).forEach((file) => withheld.add(file));
    }
    if (remedy.kind !== "strip_review_language") continue;
    recommendations.push(bounded(`Owner edit needed: the verification critique still found internal review wording (${remedy.removedPhrases.slice(0, 3).map((phrase) => `“${bounded(phrase, 40)}”`).join(", ")}) in the ${remedy.channelId} ${remedy.field}; it was not rewritten again.`, 600));
    if (!remedy.findingIds.some((id) => critical.has(id))) continue;
    const files = remedy.assetIds.flatMap((assetId) => snapshotFilesOf(snapshot, assetId));
    files.forEach((file) => withheld.add(file));
    if (files.length) fixesApplied.push(bounded(`Withheld ${files.slice(0, 4).join(", ")} from the ready kit (unresolved critical finding in the verification critique: internal review wording).`, 300));
  }
  return {
    withheldFiles: [...withheld].sort(), contentWithheldFiles: [...contentWithheld].sort(), withholdAll: applied.withholdAll,
    fixesApplied: fixesApplied.map((fix) => bounded(`Verification critique: ${fix}`, 300)), recommendations: [...new Set(recommendations)],
  };
}

/** The worse of two critic verdicts ("not_run" only when neither ran). */
export function combinedVerdict(...reports: Array<CritiqueReport | null>): NonNullable<AutopilotPublicState["critic"]>["verdict"] {
  const ran = reports.filter((report): report is CritiqueReport => Boolean(report));
  if (!ran.length) return "not_run";
  return ran.some((report) => report.verdict === "blocking_findings") ? "blocking_findings" : "no_blocking_findings";
}

export const SAM_OVERLAY_FILE = "sam-tracking-overlay.mp4";
export const ARCHIVE_FILE = "campaign-concept.zip";

/**
 * The final withheld set for the exported kit (fail closed):
 * - withholdAll: every kit file.
 * - a withheld Reel also withholds the SAM tracking overlay of the same footage;
 * - a file withheld for its content withholds every other kit file rendered from the same source
 *   (other placements, the hero source export, SAM mask previews, the tracking overlay);
 * - the concept archive bundles every kit file, so it is withheld whenever anything is.
 */
export function withheldKitFiles(input: { files: readonly string[]; withheld: Iterable<string>; contentWithheld: Iterable<string>; withholdAll: boolean; sourcesOf: (filename: string) => readonly string[] }): string[] {
  const present = new Set(input.files);
  if (input.withholdAll) return [...present].sort();
  const result = new Set([...input.withheld].filter((file) => present.has(file)));
  const tainted = new Set<string>();
  for (const file of input.contentWithheld) input.sourcesOf(file).forEach((source) => tainted.add(source));
  if (tainted.size) for (const file of present) if (input.sourcesOf(file).some((source) => tainted.has(source))) result.add(file);
  // After source propagation: a Reel withheld for any reason, directly or through its source, takes its overlay with it.
  if (REEL_FILES.some((file) => result.has(file)) && present.has(SAM_OVERLAY_FILE)) result.add(SAM_OVERLAY_FILE);
  if (result.size && present.has(ARCHIVE_FILE)) result.add(ARCHIVE_FILE);
  return [...result].sort();
}

/** The director's-room critic panel; verification-critique findings follow with an "r2-" id prefix. */
export function publicCritic(report: CritiqueReport | null, fixes: Pick<AppliedFixes, "fixesApplied" | "withheldFiles">, recheck: CritiqueReport | null = null): NonNullable<AutopilotPublicState["critic"]> {
  const findings = [...(report?.findings ?? []).map((finding) => ({ finding, id: finding.id })), ...(recheck?.findings ?? []).map((finding) => ({ finding, id: `r2-${finding.id}` }))];
  return {
    verdict: combinedVerdict(report, recheck),
    findings: findings.slice(0, 60).map(({ finding, id }) => ({
      id: bounded(id, 20), assetId: bounded(finding.assetId, 80), severity: finding.severity, rule: finding.rule, description: bounded(finding.description, 400),
      box: finding.box ? { ...finding.box } : null, timeSeconds: finding.timeSeconds,
    })),
    fixesApplied: fixes.fixesApplied.slice(0, 40).map((fix) => bounded(fix, 300)), withheld: fixes.withheldFiles.slice(0, 80),
  };
}

/** critic-report.json: diagnostics bound to the critiqued bytes, the remedy plan and what was applied. */
export function criticReportDocument(input: { report: CritiqueReport | null; fixes: AppliedFixes; snapshot: CritiqueSnapshot; notes: readonly string[]; changedAfterCritique: readonly string[] }): string {
  const report = input.report;
  return `${JSON.stringify({
    version: "autopilot-critic-report-1",
    interpretation: "Findings are a model's located observations about the rendered files, not verification. The owner's final approval is still required and binds to exact file bytes.",
    verdict: report?.verdict ?? "not_run",
    critic: report ? { rulesVersion: report.rulesVersion, model: report.model, responseId: report.responseId, summary: report.summary, usage: report.usage } : null,
    critiquedFiles: [...input.snapshot.stills.map(({ assetId, filename, sha256 }) => ({ assetId, filename, sha256 })), ...(input.snapshot.reel ? [{ assetId: CRITIC_REEL_ASSET_ID, filename: input.snapshot.reel.filename, sha256: input.snapshot.reel.sha256 }] : [])],
    findings: (report?.findings ?? []).map(({ id, assetId, assetKind, severity, rule, description, box, boxBasis, timeSeconds }) => ({ id, assetId, assetKind, severity, rule, description, box, boxBasis, timeSeconds })),
    unattributedFindings: (report?.discardedFindings ?? []).map(({ severity, rule }) => ({ severity, rule })),
    remedyPlan: input.fixes.plan ? { rulesVersion: input.fixes.plan.rulesVersion, status: input.fixes.plan.status, remedies: input.fixes.plan.remedies, assets: input.fixes.plan.assets } : null,
    fixesApplied: input.fixes.fixesApplied,
    withheldFiles: input.fixes.withheldFiles,
    recommendations: input.fixes.recommendations,
    changedAfterCritique: input.changedAfterCritique,
    notes: input.notes,
  }, null, 2)}\n`;
}

