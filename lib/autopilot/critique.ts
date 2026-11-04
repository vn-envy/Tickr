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
export async function critiqueSnapshot(kit: CampaignKit, outputDir: string, directory: string, binding: string): Promise<CritiqueSnapshot> {
  const saved = await readCheckpoint<CritiqueSnapshot>(directory, "critique-input", binding);
  if (saved && await snapshotIntact(saved)) return saved;
  const target = join(directory, "critique-input");
  await mkdir(target, { recursive: true, mode: 0o700 });
  const notes: string[] = [];
  const stills: CritiqueSnapshot["stills"] = [];
  for (const asset of kit.assets.filter((item) => item.mediaType === "image" && item.channel !== null && item.filename.endsWith(".png")).slice(0, CRITIC_MAX_ASSETS)) {
    if (!ID.test(asset.id) || asset.id === CRITIC_REEL_ASSET_ID || !asset.width || !asset.height) continue;
    const path = join(target, asset.filename);
    await copyFile(join(outputDir, asset.filename), path);
    const bytes = await readFile(path);
    if (sha256Hex(bytes) !== asset.sha256) throw new Error("A rendered still changed before critique.");
    stills.push({ assetId: asset.id, filename: asset.filename, channel: asset.channel, sha256: asset.sha256, width: asset.width, height: asset.height, path });
  }
  let reel: CritiqueSnapshot["reel"] = null;
  const video = kit.assets.find((item) => item.filename === "instagram_reel.mp4");
  if (video && video.bytes <= CRITIC_MAX_REEL_BYTES) {
    const path = join(target, video.filename);
    await copyFile(join(outputDir, video.filename), path);
    if (sha256Hex(await readFile(path)) !== video.sha256) throw new Error("The rendered Reel changed before critique.");
    const probe = await probeVideo(path);
    reel = { filename: video.filename, sha256: video.sha256, path, durationSeconds: probe.durationSeconds, width: probe.width, height: probe.height };
  } else if (video) notes.push("The Reel is larger than the critic's 16 MiB limit, so only its cover was critiqued; review the Reel itself before use.");
  const snapshot: CritiqueSnapshot = { version: 1, stills, reel, notes };
  await writeCheckpoint(directory, "critique-input", binding, snapshot);
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

/** One paid critique when the budget allows; an exhausted budget or a failed request leaves it "not_run". */
export async function runCritique(input: {
  directory: string; snapshot: CritiqueSnapshot; copy: CampaignCopy; report: ResearchReport; opportunity: ResearchOpportunity;
  business: { name: string; vertical: string }; goal: string; gate: PaidGate; critique: typeof critiqueCampaign;
}): Promise<CritiqueOutcome> {
  if (!input.snapshot.stills.length) return { report: null, usage: null, notes: ["No rendered stills were available to critique."] };
  const directory = join(input.directory, "spark-critic", "round-1");
  const gate = await input.gate("spark_critic", directory, "spark-critic");
  if (gate === "exhausted") return { report: null, usage: null, notes: ["The critic budget for this run was used up, so the kit was not self-critiqued; review every file carefully."] };
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
    return { report: null, usage: null, notes: ["The self-critique request did not complete and was not repeated; review every file carefully."] };
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
  recommendations: string[];
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

/** Applies only remedies that need no model: withholding and deleting listed internal wording from channel copy. */
export function applyDeterministicFixes(report: CritiqueReport | null, copy: CampaignCopy, snapshot: CritiqueSnapshot): AppliedFixes {
  if (!report) return { plan: null, copy, copyChanged: false, reelCopyChanged: false, fixesApplied: [], withheldFiles: [], recommendations: [] };
  const plan = planDeterministicFixes(report, criticChannels(copy));
  const patched: CampaignCopy = { ...copy, channels: copy.channels.map((channel) => ({ ...channel })) };
  const fixesApplied: string[] = [];
  const recommendations: string[] = [];
  let reelCopyChanged = false, copyChanged = false;
  const withheld = new Set<string>();
  for (const remedy of plan.remedies) {
    if (remedy.kind === "withhold_asset") {
      if (remedy.assetId === CRITIC_REEL_ASSET_ID) REEL_FILES.forEach((file) => withheld.add(file));
      else {
        const still = snapshot.stills.find((item) => item.assetId === remedy.assetId);
        if (still) withheld.add(still.filename);
        if (still?.filename === "instagram_reel_cover.png") REEL_FILES.forEach((file) => withheld.add(file));
      }
      fixesApplied.push(bounded(`Withheld ${remedy.assetId === CRITIC_REEL_ASSET_ID ? "the Reel" : remedy.assetId} from the ready kit (${remedy.reasons.map((reason) => reason.replaceAll("_", " ")).join(", ")}).`, 300));
      continue;
    }
    if (remedy.kind === "strip_review_language") {
      const channel = patched.channels.find((item) => item.id === remedy.channelId);
      if (!channel || channel[remedy.field] !== remedy.before) continue;
      channel[remedy.field] = remedy.after;
      copyChanged = true;
      if (remedy.channelId === "instagram_reels") reelCopyChanged = true;
      fixesApplied.push(bounded(`Removed internal review wording (${remedy.removedPhrases.slice(0, 3).map((phrase) => `“${bounded(phrase, 40)}”`).join(", ")}) from the ${remedy.channelId} ${remedy.field}; affected files were re-rendered locally and need a fresh look.`, 300));
      continue;
    }
    const text = describeRemedy(remedy);
    if (text) recommendations.push(bounded(text, 600));
  }
  return { plan, copy: copyChanged ? patched : copy, copyChanged, reelCopyChanged, fixesApplied: fixesApplied.slice(0, 40), withheldFiles: [...withheld].sort(), recommendations: [...new Set(recommendations)] };
}

/** The director's-room critic panel. */
export function publicCritic(report: CritiqueReport | null, fixes: Pick<AppliedFixes, "fixesApplied" | "withheldFiles">): NonNullable<AutopilotPublicState["critic"]> {
  return {
    verdict: report?.verdict ?? "not_run",
    findings: (report?.findings ?? []).slice(0, 60).map((finding) => ({
      id: bounded(finding.id, 20), assetId: bounded(finding.assetId, 80), severity: finding.severity, rule: finding.rule, description: bounded(finding.description, 400),
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

