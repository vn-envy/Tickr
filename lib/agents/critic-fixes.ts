import type { SamBox, SparkGridBox } from "../meta/sam-prompts";
import type { CriticBoundAsset, CriticCampaignChannel, CriticFinding, CriticRule, CriticSeverity, CritiqueReport } from "./critic";

/**
 * Deterministic, model-free remedies for a Muse Spark critique.
 *
 * Pure: the planner only reads the report and the campaign copy and returns instructions the
 * renderer can apply locally. It never invents copy or facts: claims, offers, people and
 * third-party marks are withheld rather than "fixed"; copy edits only DELETE explicitly internal
 * review or production phrases; tentative or conditional wording (TBC, "subject to approval") is
 * never deleted, because removing it would turn a tentative event or a conditional offer into a
 * firm one: it goes to the owner instead. A missing call to action is restored only from
 * existing channel copy. Every asset a remedy changes must be critiqued again and its new bytes
 * approved by the owner. A critical finding that no remedy resolves withholds its asset.
 * The mandatory provenance/concept footer label ("WEBSITE IMAGE · SAM CUTOUT", "CONCEPT · REVIEW
 * REQUIRED") is required disclosure: a review-language finding about it alone is dismissed, never
 * withheld or sent for review, so honesty labels can never empty the kit.
 */
export const CRITIC_FIXES_VERSION = "critic-fixes-3" as const;

export type WithholdReason = "claim_not_supported" | "unapproved_offer" | "person_without_consent" | "third_party_branding" | "unresolved_critical";
export type CopyField = "headline" | "body" | "caption" | "cta";
export type ManualReviewReason = "no_deterministic_fix" | "region_not_localized" | "channel_copy_unavailable" | "review_language_not_in_copy" | "unattributed_critical";
/** Why channel copy needs the owner's own edit instead of an automatic one. */
export type ManualCopyReason = "tentative_or_conditional_wording" | "copy_empty_after_strip";
interface Region { box: SamBox | null; gridBox: SparkGridBox | null; timeSeconds: number | null }

export type FixRemedy =
  | { kind: "withhold_asset"; assetId: string; reasons: WithholdReason[]; findingIds: string[] }
  | ({ kind: "relayout_text_away_from_subject"; assetId: string; findingIds: string[] } & Region)
  | ({ kind: "recrop_to_subject"; assetId: string; findingIds: string[] } & Region)
  | ({ kind: "increase_text_contrast"; assetId: string; findingIds: string[] } & Region)
  | { kind: "restore_cta"; assetId: string; channelId: string; cta: string; findingIds: string[] }
  | { kind: "strip_review_language"; channelId: string; field: CopyField; before: string; after: string; removedPhrases: string[]; assetIds: string[]; findingIds: string[] }
  /** The field is left exactly as it is; the owner edits it. `assetIds` render this channel's copy. */
  | { kind: "manual_copy_edit"; channelId: string; field: CopyField; text: string; reason: ManualCopyReason; phrases: string[]; severity: CriticSeverity; assetIds: string[]; findingIds: string[] }
  | { kind: "manual_review"; assetId: string | null; channelId: string | null; reason: ManualReviewReason; severity: CriticSeverity; findingIds: string[] };

export type FixRemedyKind = FixRemedy["kind"];

export interface AssetFixDisposition {
  assetId: string;
  kind: CriticBoundAsset["kind"];
  /**
   * withheld: excluded from the ready kit. manual_review: the owner must resolve an open item first.
   * fix_and_recheck: local remedies change its bytes. Precedence: withheld > manual_review > fix_and_recheck.
   */
  disposition: "withheld" | "fix_and_recheck" | "manual_review" | "unchanged";
  /** Local remedies change its bytes: critique again and approve the new bytes (independent of disposition). */
  recheck: boolean;
}

/** A finding the planner dismissed instead of remedying, kept for the record. */
export interface DismissedFinding { findingId: string; assetId: string; reason: "mandatory_provenance_label" }

export interface DeterministicFixPlan {
  rulesVersion: typeof CRITIC_FIXES_VERSION;
  critiqueRulesVersion: CritiqueReport["rulesVersion"];
  critiqueInputHash: string | null;
  remedies: FixRemedy[];
  /** Findings with no remedy because they only object to required disclosure (never withheld). */
  dismissedFindings: DismissedFinding[];
  assets: AssetFixDisposition[];
  withheldAssetIds: string[];
  /** Assets (not withheld) whose bytes the remedies change: they need a new critique and a new owner approval. */
  recheckAssetIds: string[];
  /** blocked: a critical finding could not be attributed, or nothing remains for the kit. */
  status: "clear" | "fixes_planned" | "blocked";
  provenance: { kind: "deterministic_fix_plan"; modelCall: false; ownerApprovalRequired: true };
}

/**
 * Internal review and production wording that is safe to DELETE from consumer copy. Specific
 * phrases only: "draft" or "concept" alone are legitimate copy ("draft beer", "a new concept"),
 * and consumer caveats ("subject to approval") are never on this list.
 */
export const REVIEW_LANGUAGE_PHRASES: readonly { id: string; pattern: RegExp }[] = [
  { id: "provenance_label", pattern: /(?:synthetic demo\s*·\s*)?concept\s*·\s*review required|synthetic demo\s*·\s*concept/giu },
  { id: "template_slot", pattern: /\{\{[^{}\n]{0,80}\}\}|\[(?:insert|add|your|placeholder)\b[^\]\n]{0,80}\]/giu },
  { id: "evidence_reference", pattern: /\[(?:ev|evidence|src|source)[-_ ]?[A-Za-z0-9]{1,12}\]|\bevidence ids?\s*[:#]?\s*[A-Za-z0-9_-]{1,24}/giu },
  { id: "lorem_ipsum", pattern: /\blorem ipsum(?: dolor(?: sit amet)?)?\b/giu },
  { id: "placeholder", pattern: /\bplaceholder(?: (?:text|copy|image|headline|caption))?\b/giu },
  { id: "approval_note", pattern: /\bowner approval (?:required|needed|pending)\b|\b(?:pending|awaiting|needs|requires) owner(?:'s|’s)? (?:review|approval)\b|\b(?:owner )?review required\b|\bfor (?:owner|internal) review(?: only)?\b/giu },
  { id: "not_for_publication", pattern: /\bnot for publication\b|\bdo not publish\b|\binternal (?:use )?only\b/giu },
  { id: "draft_marker", pattern: /\b(?:draft (?:copy|version|text|caption|headline)|first draft)\b|[([]draft[)\]]/giu },
  { id: "concept_marker", pattern: /\bconcept (?:preview|visuals?|image|only|mock-?up)\b/giu },
  { id: "synthetic_marker", pattern: /\bsynthetic (?:demo|image|content)\b|\bAI[- ]generated\b|\bgenerated (?:by|with) AI\b|\bmade with AI\b/giu },
  { id: "mockup", pattern: /\bmock-?ups?\b/giu },
];

/**
 * Wording that must not ship as is but must never be deleted automatically: implementation notes
 * mark unfinished facts ("Live jazz Friday TBC") and approval caveats may be the consumer's terms.
 * TODO/FIXME are matched upper-case only ("todo" is an ordinary word in several languages).
 */
export const MANUAL_EDIT_MARKERS: readonly { id: string; pattern: RegExp }[] = [
  { id: "implementation_note", pattern: /\b(?:TODO|FIXME)\b|\b[Tt][Bb][CDcd]\b/gu },
  { id: "conditional_approval", pattern: /\b(?:subject to|pending|awaiting|requires?|needs?) (?:the )?(?:owner(?:'s|’s)? )?(?:review|approval)\b/giu },
];

/** Listed manual-edit markers present in `value` (after safe phrases are removed). */
export function findManualEditMarkers(value: string): string[] {
  const found: string[] = [];
  for (const { pattern } of MANUAL_EDIT_MARKERS) for (const match of value.matchAll(pattern)) found.push(match[0]);
  return [...new Set(found)];
}

/** Delete listed phrases and tidy the separators they leave. Never adds words. */
export function stripReviewLanguage(value: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  let text = value;
  for (const { pattern } of REVIEW_LANGUAGE_PHRASES) {
    text = text.replace(pattern, (match) => { removed.push(match.trim()); return " "; });
  }
  if (!removed.length) return { text: value, removed };
  text = text
    .replace(/\(\s*\)|\[\s*\]/gu, " ")
    .split("\n")
    .map((line) => line
      .replace(/[ \t]+/gu, " ")
      // Separators left inside brackets: "( , baked daily)" -> "(baked daily)".
      .replace(/([([])\s*[,;:]\s*/gu, "$1")
      .replace(/\s*[,;:]\s*([)\]])/gu, "$1")
      .replace(/\(\s*\)|\[\s*\]/gu, "")
      // Separators doubled up where a phrase between them was removed: "case — — daily" -> "case — daily".
      .replace(/([—–:|·])(?:\s*[—–|·])+/gu, "$1")
      // A separator left dangling before punctuation or the end of the line.
      .replace(/\s*[—–:|·]\s*(?=[.,!?;]|$)/gu, "")
      // A spaced hyphen used as a dash ("Croissants - "), never a hyphen inside a word.
      .replace(/\s+-+\s*(?=[—–:|·.,!?;-]|$)/gu, "")
      // An opening bracket whose contents were removed up to the end of the line.
      .replace(/\s*[([]\s*$/gu, "")
      // ". ." left where a whole phrase sentence was removed; a real ellipsis has no inner space.
      .replace(/([.!?])\s+[.,;:](?=\s|$)/gu, "$1")
      .replace(/\s+([,.!?;:])/gu, "$1")
      .replace(/[,;:]+(?=[.!?])/gu, "")
      .replace(/^[\s—–:|·,.;!?-]+/u, "")
      .trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (/^[\p{P}\p{S}\s]*$/u.test(text)) text = "";
  return { text, removed };
}

/**
 * Words of Tickr's mandatory provenance/concept footer labels (lib/campaign/render.ts,
 * lib/autopilot/produce.ts, the cinema renderers): "OWNER PHOTO · SAM CUTOUT · AI BACKDROP",
 * "WEBSITE IMAGE · SAM CUTOUT", "OWNER INSTAGRAM PHOTO", "OWNER VIDEO", "ILLUSTRATIVE IMAGE", "ILLUSTRATION",
 * "CONCEPT · REVIEW REQUIRED", "SYNTHETIC DEMO · CONCEPT".
 */
const PROVENANCE_LABEL_WORDS: ReadonlySet<string> = new Set([
  "owner", "photo", "photos", "video", "website", "image", "source", "instagram", "facebook", "sam", "cutout", "ai", "backdrop",
  "illustrative", "illustration", "concept", "review", "required", "synthetic", "demo",
]);

/** True when `text` is made only of provenance/concept label words and separators (e.g. "WEBSITE IMAGE · SAM CUTOUT"). */
export function isProvenanceLabelText(text: string): boolean {
  const words = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length > 0 && words.every((word) => PROVENANCE_LABEL_WORDS.has(word));
}

const QUOTED = /"([^"\n]{1,160})"|“([^”\n]{1,160})”|«([^»\n]{1,160})»|‘([^’\n]{1,160})’|(?<![\p{L}\p{N}])'([^'\n]{1,160})'(?![\p{L}\p{N}])/gu;
/** Unquoted on-image text the critic usually writes in capitals ("kicker TASTE OF HOME STORY"). */
const CAPITALS = /(?<![\p{L}\p{N}])\p{Lu}[\p{Lu}\p{N}]+(?:[\s·•|/—–-]+\p{Lu}[\p{Lu}\p{N}]*)*(?![\p{L}\p{N}])/gu;

/**
 * Whether a review-language finding objects ONLY to the mandatory provenance/concept label: every
 * piece of on-image text it quotes (and every unquoted all-capitals run) is label text, and it
 * cites at least one. A finding that also cites other wording (a planning kicker, "draft copy")
 * is kept, so legitimate review language is still remedied, reviewed or withheld.
 */
export function isProvenanceLabelFinding(finding: Pick<CriticFinding, "rule" | "description">): boolean {
  if (finding.rule !== "review_language_in_consumer_copy") return false;
  const quoted = [...finding.description.matchAll(QUOTED)].map((match) => match.slice(1).find((group) => group !== undefined) ?? "");
  const rest = finding.description.replace(QUOTED, " ");
  const cited = [...quoted, ...[...rest.matchAll(CAPITALS)].map((match) => match[0])].filter((text) => /[\p{L}\p{N}]/u.test(text));
  return cited.length > 0 && cited.every(isProvenanceLabelText);
}

const WITHHOLD_RULES: ReadonlySet<CriticRule> = new Set(["claim_not_supported", "unapproved_offer", "person_without_consent", "third_party_branding"]);
const COPY_FIELDS: readonly CopyField[] = ["headline", "body", "caption", "cta"];
const SEVERITY_RANK: Record<CriticSeverity, number> = { critical: 3, major: 2, minor: 1 };
const region = (finding: CriticFinding): Region => ({ box: finding.box, gridBox: finding.gridBox, timeSeconds: finding.timeSeconds });
const hasRegion = (finding: CriticFinding) => Boolean(finding.gridBox);

/**
 * Plan safe local remedies for a critique. Rule matrix (per attributed finding):
 * - claim_not_supported, unapproved_offer, person_without_consent, third_party_branding → withhold_asset (any severity).
 * - unreadable_text → increase_text_contrast (region when localized).
 * - cta_missing_or_occluded → restore_cta from the asset's channel copy; manual review when there is none.
 * - subject_occluded_or_cropped (localized) → relayout_text_away_from_subject, plus recrop_to_subject for stills.
 * - review_language_in_consumer_copy → resolved only when strip_review_language rewrites copy of the asset's own
 *   channel and no field of that channel is left for a manual copy edit; otherwise manual review.
 *   A review_language finding that only cites the mandatory provenance/concept label is dismissed (no remedy, never withheld).
 * - placement_unsuitable, brand_inconsistency, visual_quality, other, or an unlocalized subject issue → manual_review.
 * A critical finding with no deterministic remedy withholds its asset. A critical finding for an unknown asset blocks the plan.
 * Copy fields are always checked, with or without a finding: listed internal phrases are stripped; tentative or
 * conditional wording, or copy that stripping would empty, becomes a manual_copy_edit left untouched for the owner.
 */
export function planDeterministicFixes(
  report: Pick<CritiqueReport, "rulesVersion" | "boundAssets" | "findings" | "discardedFindings"> & { inputHash?: string },
  campaignChannels: readonly CriticCampaignChannel[],
): DeterministicFixPlan {
  const assets = new Map(report.boundAssets.map((asset) => [asset.assetId, asset]));
  const channels = new Map(campaignChannels.map((channel) => [channel.id, channel]));
  const remedies: FixRemedy[] = [];
  const withheld = new Map<string, { reasons: Set<WithholdReason>; findingIds: string[] }>();
  const withhold = (assetId: string, reason: WithholdReason, findingId: string) => {
    const entry = withheld.get(assetId) ?? { reasons: new Set<WithholdReason>(), findingIds: [] };
    entry.reasons.add(reason);
    if (!entry.findingIds.includes(findingId)) entry.findingIds.push(findingId);
    withheld.set(assetId, entry);
  };
  const manual = (finding: CriticFinding, reason: ManualReviewReason, channelId: string | null = null) => {
    remedies.push({ kind: "manual_review", assetId: finding.assetId, channelId, reason, severity: finding.severity, findingIds: [finding.id] });
    if (finding.severity === "critical") withhold(finding.assetId, "unresolved_critical", finding.id);
  };

  // Required disclosure is never a defect: these findings get no remedy and can never withhold.
  const dismissedFindings: DismissedFinding[] = report.findings
    .filter((finding) => assets.has(finding.assetId) && isProvenanceLabelFinding(finding))
    .map((finding) => ({ findingId: finding.id, assetId: finding.assetId, reason: "mandatory_provenance_label" as const }));
  const dismissed = new Set(dismissedFindings.map((item) => item.findingId));

  // Copy is shared by every asset rendered for a channel (stills and a reel linked to it).
  const reviewFindings = report.findings.filter((finding) => finding.rule === "review_language_in_consumer_copy" && assets.has(finding.assetId) && !dismissed.has(finding.id));
  const copyState = new Map<string, "stripped" | "manual">();
  for (const channel of campaignChannels) {
    const channelAssets = report.boundAssets.filter((asset) => asset.channel === channel.id).map((asset) => asset.assetId);
    const channelFindings = reviewFindings.filter((finding) => assets.get(finding.assetId)!.channel === channel.id);
    const findingIds = channelFindings.map((finding) => finding.id);
    for (const field of COPY_FIELDS) {
      const before = channel[field];
      const { text: after, removed } = stripReviewLanguage(before);
      const markers = findManualEditMarkers(after);
      if (!removed.length && !markers.length) continue;
      if (markers.length || !after) {
        const severity = channelFindings.reduce<CriticSeverity>((worst, finding) => SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst] ? finding.severity : worst, "major");
        remedies.push({
          kind: "manual_copy_edit", channelId: channel.id, field, text: before, reason: markers.length ? "tentative_or_conditional_wording" : "copy_empty_after_strip",
          phrases: markers.length ? markers : [...new Set(removed)], severity, assetIds: channelAssets, findingIds,
        });
        copyState.set(channel.id, "manual");
        continue;
      }
      remedies.push({ kind: "strip_review_language", channelId: channel.id, field, before, after, removedPhrases: [...new Set(removed)], assetIds: channelAssets, findingIds });
      if (copyState.get(channel.id) !== "manual") copyState.set(channel.id, "stripped");
    }
  }

  for (const finding of report.findings) {
    const asset = assets.get(finding.assetId);
    if (!asset) continue; // The critic never emits these; a tampered report cannot redirect remedies.
    if (dismissed.has(finding.id)) continue;
    if (WITHHOLD_RULES.has(finding.rule)) { withhold(asset.assetId, finding.rule as WithholdReason, finding.id); continue; }
    switch (finding.rule) {
      case "unreadable_text":
        remedies.push({ kind: "increase_text_contrast", assetId: asset.assetId, findingIds: [finding.id], ...region(finding) });
        break;
      case "cta_missing_or_occluded": {
        const channel = asset.channel ? channels.get(asset.channel) : undefined;
        const cta = channel?.cta.trim() ?? "";
        if (!channel || !cta || stripReviewLanguage(cta).removed.length || findManualEditMarkers(cta).length) manual(finding, "channel_copy_unavailable", channel?.id ?? null);
        else remedies.push({ kind: "restore_cta", assetId: asset.assetId, channelId: channel.id, cta, findingIds: [finding.id] });
        break;
      }
      case "subject_occluded_or_cropped":
        if (!hasRegion(finding)) { manual(finding, "region_not_localized"); break; }
        remedies.push({ kind: "relayout_text_away_from_subject", assetId: asset.assetId, findingIds: [finding.id], ...region(finding) });
        if (asset.kind === "still") remedies.push({ kind: "recrop_to_subject", assetId: asset.assetId, findingIds: [finding.id], ...region(finding) });
        break;
      case "review_language_in_consumer_copy": {
        // Only the asset's own channel copy can explain what the critic saw; an unlinked asset is never "covered".
        const state = asset.channel === null ? undefined : copyState.get(asset.channel);
        if (state === "manual") { if (finding.severity === "critical") withhold(asset.assetId, "unresolved_critical", finding.id); }
        else if (state !== "stripped") manual(finding, "review_language_not_in_copy", asset.channel);
        break;
      }
      default:
        manual(finding, "no_deterministic_fix", asset.channel);
    }
  }

  const unattributed = report.discardedFindings.filter((finding) => finding.severity === "critical");
  if (unattributed.length) remedies.push({ kind: "manual_review", assetId: null, channelId: null, reason: "unattributed_critical", severity: "critical", findingIds: [] });

  // Withholding supersedes any local fix for the same asset.
  const kept = remedies.filter((remedy) => !("assetId" in remedy) || remedy.assetId === null || remedy.kind === "manual_review" || !withheld.has(remedy.assetId));
  const withholdRemedies: FixRemedy[] = [...withheld].map(([assetId, entry]) => ({ kind: "withhold_asset", assetId, reasons: [...entry.reasons].sort(), findingIds: entry.findingIds }));
  const finalRemedies = [...withholdRemedies, ...kept.map((remedy) => "assetIds" in remedy ? { ...remedy, assetIds: remedy.assetIds.filter((id) => !withheld.has(id)) } : remedy)];

  const modified = new Set<string>();
  const manualAssets = new Set<string>();
  for (const remedy of finalRemedies) {
    if (remedy.kind === "strip_review_language") remedy.assetIds.forEach((id) => modified.add(id));
    else if (remedy.kind === "manual_copy_edit") remedy.assetIds.forEach((id) => manualAssets.add(id));
    else if (remedy.kind === "manual_review") { if (remedy.assetId) manualAssets.add(remedy.assetId); }
    else if (remedy.kind !== "withhold_asset") modified.add(remedy.assetId);
  }
  const dispositions: AssetFixDisposition[] = report.boundAssets.map((asset) => {
    const isWithheld = withheld.has(asset.assetId);
    return {
      assetId: asset.assetId, kind: asset.kind,
      disposition: isWithheld ? "withheld" : manualAssets.has(asset.assetId) ? "manual_review" : modified.has(asset.assetId) ? "fix_and_recheck" : "unchanged",
      recheck: !isWithheld && modified.has(asset.assetId),
    };
  });
  const remaining = dispositions.filter((asset) => asset.disposition !== "withheld").length;
  return {
    rulesVersion: CRITIC_FIXES_VERSION,
    critiqueRulesVersion: report.rulesVersion,
    critiqueInputHash: report.inputHash ?? null,
    remedies: finalRemedies,
    dismissedFindings,
    assets: dispositions,
    withheldAssetIds: dispositions.filter((asset) => asset.disposition === "withheld").map((asset) => asset.assetId),
    recheckAssetIds: dispositions.filter((asset) => asset.recheck).map((asset) => asset.assetId),
    status: unattributed.length || remaining === 0 ? "blocked" : finalRemedies.length ? "fixes_planned" : "clear",
    provenance: { kind: "deterministic_fix_plan", modelCall: false, ownerApprovalRequired: true },
  };
}
