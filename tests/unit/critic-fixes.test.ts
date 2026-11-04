import { describe, expect, test } from "vitest";
import type { CriticBoundAsset, CriticCampaignChannel, CriticFinding, CriticRule, CriticSeverity, CritiqueReport } from "../../lib/agents/critic";
import { MANUAL_EDIT_MARKERS, REVIEW_LANGUAGE_PHRASES, findManualEditMarkers, planDeterministicFixes, stripReviewLanguage } from "../../lib/agents/critic-fixes";

// SYNTHETIC critique reports for a fictional bakery; no model call is involved.
const assets: CriticBoundAsset[] = [
  { assetId: "feed-1", filename: "feed-1.png", sha256: "a".repeat(64), kind: "still", channel: "instagram_feed" },
  { assetId: "story-1", filename: "story-1.png", sha256: "b".repeat(64), kind: "still", channel: "instagram_stories" },
  { assetId: "loose-1", filename: "loose-1.png", sha256: "c".repeat(64), kind: "still", channel: null },
  { assetId: "reel", filename: "reel.mp4", sha256: "d".repeat(64), kind: "reel", channel: null },
];
const channels: CriticCampaignChannel[] = [
  { id: "instagram_feed", headline: "Morning layers", body: "Baked on site each morning.", caption: "Fresh croissants daily.", cta: "Visit this week" },
  { id: "instagram_stories", headline: "Warm from the oven", body: "Baked on site.", caption: "Swipe for the bake.", cta: "" },
];
const gridBox = { x_min: 100, y_min: 200, x_max: 600, y_max: 800 };
const pixelBox = { x1: 205, y1: 307, x2: 1228, y2: 1228 };
let counter = 0;
function finding(assetId: string, rule: CriticRule, severity: CriticSeverity = "major", localized = false, timeSeconds: number | null = null): CriticFinding {
  counter += 1;
  return {
    id: `f${counter}`, assetId, assetKind: assetId === "reel" ? "reel" : "still", severity, rule, description: "Synthetic finding.",
    gridBox: localized ? gridBox : null, box: localized && assetId !== "reel" ? pixelBox : null, boxBasis: localized ? "spark_located_observation" : null,
    boxRejected: false, timeSeconds, timeRejected: false,
  };
}
function report(findings: CriticFinding[], discarded: CritiqueReport["discardedFindings"] = [], boundAssets: CriticBoundAsset[] = assets) {
  return { rulesVersion: "critic-1" as const, inputHash: "e".repeat(64), boundAssets, findings, discardedFindings: discarded };
}
const disposition = (plan: ReturnType<typeof planDeterministicFixes>, assetId: string) => plan.assets.find((asset) => asset.assetId === assetId)?.disposition;

describe("stripReviewLanguage", () => {
  test.each([
    ["Concept preview — Fresh croissants daily.", "Fresh croissants daily."],
    ["Fresh croissants daily. Draft copy. Visit us.", "Fresh croissants daily. Visit us."],
    ["Order now — owner approval required.", "Order now."],
    ["Fresh croissants (draft)", "Fresh croissants"],
    ["Morning layers [insert price here] every day", "Morning layers every day"],
    ["Morning layers {{offer}}", "Morning layers"],
    ["Laminated by hand [ev-3].", "Laminated by hand."],
    ["Fresh croissants - draft copy", "Fresh croissants"],
    ["Croissants (draft copy, baked daily)", "Croissants (baked daily)"],
    ["Bake of the week (draft copy", "Bake of the week"],
    ["Pastry case — mockup — daily", "Pastry case — daily"],
    ["CONCEPT · REVIEW REQUIRED\nSwipe for the bake.", "Swipe for the bake."],
    ["AI-generated image of our pastry case", "image of our pastry case"],
    ["Lorem ipsum dolor sit amet", ""],
    ["Placeholder", ""],
  ])("removes listed phrases from %j without adding words", (input, expected) => {
    const result = stripReviewLanguage(input);
    expect(result.text).toBe(expected);
    expect(result.removed.length).toBeGreaterThan(0);
    const inputWords = new Set(input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    for (const word of result.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) expect(inputWords.has(word)).toBe(true);
  });

  test.each([
    "Try our draft beer flight.",
    "A new concept in neighbourhood baking.",
    "Wait for it... the morning bake.",
    "Leave us a review on your next visit!",
    "Proudly made with butter, flour and time.",
    "Café para todo el barrio.",
    "Free pastry with every coffee, subject to availability.",
    "Gluten-free and dairy-free options - ask us.",
  ])("leaves legitimate copy %j untouched", (input) => {
    expect(stripReviewLanguage(input)).toEqual({ text: input, removed: [] });
    expect(findManualEditMarkers(input)).toEqual([]);
  });

  test.each([
    ["Live jazz Friday TBC", ["TBC"]],
    ["Live jazz Friday night (TBC).", ["TBC"]],
    ["Opening hours TBD, follow for updates", ["TBD"]],
    ["Free pastry with every coffee, subject to approval.", ["subject to approval"]],
    ["Seasonal menu requires approval from the landlord.", ["requires approval"]],
    ["Bake of the week - TODO check the price. Visit us.", ["TODO"]],
  ])("never deletes tentative or conditional wording in %j: it is flagged for the owner instead", (input, markers) => {
    expect(stripReviewLanguage(input)).toEqual({ text: input, removed: [] });
    expect(findManualEditMarkers(input)).toEqual(markers);
  });

  test("uses a fixed, inspectable phrase list", () => {
    expect(REVIEW_LANGUAGE_PHRASES.map((phrase) => phrase.id)).toContain("approval_note");
    expect(REVIEW_LANGUAGE_PHRASES.every((phrase) => phrase.pattern.flags.includes("g"))).toBe(true);
    expect(MANUAL_EDIT_MARKERS.map((marker) => marker.id)).toEqual(["implementation_note", "conditional_approval"]);
    expect(MANUAL_EDIT_MARKERS.every((marker) => marker.pattern.flags.includes("g"))).toBe(true);
  });
});

describe("planDeterministicFixes", () => {
  test("a clean critique needs no remedies", () => {
    const plan = planDeterministicFixes(report([]), channels);
    expect(plan).toMatchObject({ rulesVersion: "critic-fixes-2", critiqueRulesVersion: "critic-1", critiqueInputHash: "e".repeat(64), remedies: [], withheldAssetIds: [], recheckAssetIds: [], status: "clear" });
    expect(plan.assets.every((asset) => asset.disposition === "unchanged" && !asset.recheck)).toBe(true);
    expect(plan.provenance).toEqual({ kind: "deterministic_fix_plan", modelCall: false, ownerApprovalRequired: true });
  });

  test.each([
    ["claim_not_supported", "minor"],
    ["unapproved_offer", "major"],
    ["person_without_consent", "critical"],
    ["third_party_branding", "minor"],
  ] as const)("withholds the asset for %s at any severity (%s) and never rewrites it", (rule, severity) => {
    const item = finding("feed-1", rule, severity, true);
    const plan = planDeterministicFixes(report([item, finding("feed-1", "unreadable_text", "minor", true)]), channels);
    expect(plan.remedies).toEqual([{ kind: "withhold_asset", assetId: "feed-1", reasons: [rule], findingIds: [item.id] }]);
    expect(plan.withheldAssetIds).toEqual(["feed-1"]);
    expect(plan.recheckAssetIds).toEqual([]);
    expect(plan.status).toBe("fixes_planned");
  });

  test("maps layout rules to local remedies with the located region", () => {
    const unreadable = finding("story-1", "unreadable_text", "major", true);
    const occluded = finding("feed-1", "subject_occluded_or_cropped", "major", true);
    const reelOccluded = finding("reel", "subject_occluded_or_cropped", "minor", true, 4.5);
    const cta = finding("feed-1", "cta_missing_or_occluded", "major");
    const plan = planDeterministicFixes(report([unreadable, occluded, reelOccluded, cta]), channels);
    expect(plan.remedies).toEqual([
      { kind: "increase_text_contrast", assetId: "story-1", findingIds: [unreadable.id], box: pixelBox, gridBox, timeSeconds: null },
      { kind: "relayout_text_away_from_subject", assetId: "feed-1", findingIds: [occluded.id], box: pixelBox, gridBox, timeSeconds: null },
      { kind: "recrop_to_subject", assetId: "feed-1", findingIds: [occluded.id], box: pixelBox, gridBox, timeSeconds: null },
      { kind: "relayout_text_away_from_subject", assetId: "reel", findingIds: [reelOccluded.id], box: null, gridBox, timeSeconds: 4.5 },
      { kind: "restore_cta", assetId: "feed-1", channelId: "instagram_feed", cta: "Visit this week", findingIds: [cta.id] },
    ]);
    expect(plan.recheckAssetIds).toEqual(["feed-1", "story-1", "reel"]);
    expect(plan.status).toBe("fixes_planned");
  });

  test("never invents a call to action: missing channel copy goes to manual review", () => {
    const noCta = finding("story-1", "cta_missing_or_occluded", "major");
    const noChannel = finding("loose-1", "cta_missing_or_occluded", "critical");
    const plan = planDeterministicFixes(report([noCta, noChannel]), channels);
    expect(plan.remedies).toEqual([
      { kind: "withhold_asset", assetId: "loose-1", reasons: ["unresolved_critical"], findingIds: [noChannel.id] },
      { kind: "manual_review", assetId: "story-1", channelId: "instagram_stories", reason: "channel_copy_unavailable", severity: "major", findingIds: [noCta.id] },
      { kind: "manual_review", assetId: "loose-1", channelId: null, reason: "channel_copy_unavailable", severity: "critical", findingIds: [noChannel.id] },
    ]);
    expect(plan.assets.find((asset) => asset.assetId === "story-1")?.disposition).toBe("manual_review");
  });

  test("unlocalized subject issues and non-deterministic rules go to manual review; critical ones are withheld", () => {
    const subject = finding("story-1", "subject_occluded_or_cropped", "major");
    const quality = finding("feed-1", "visual_quality", "minor");
    const brand = finding("reel", "brand_inconsistency", "critical");
    const placement = finding("story-1", "placement_unsuitable", "major");
    const other = finding("feed-1", "other", "major");
    const plan = planDeterministicFixes(report([subject, quality, brand, placement, other]), channels);
    expect(plan.remedies.filter((remedy) => remedy.kind === "manual_review").map((remedy) => [remedy.findingIds[0], remedy.kind === "manual_review" && remedy.reason])).toEqual([
      [subject.id, "region_not_localized"], [quality.id, "no_deterministic_fix"], [brand.id, "no_deterministic_fix"], [placement.id, "no_deterministic_fix"], [other.id, "no_deterministic_fix"],
    ]);
    expect(plan.withheldAssetIds).toEqual(["reel"]);
    expect(plan.recheckAssetIds).toEqual([]);
  });

  test("strips review language from channel copy and re-renders that channel's assets", () => {
    const dirty: CriticCampaignChannel[] = [{ ...channels[0], caption: "Concept preview — Fresh croissants daily. Owner approval required." }, channels[1]];
    const review = finding("feed-1", "review_language_in_consumer_copy", "critical");
    const plan = planDeterministicFixes(report([review]), dirty);
    expect(plan.remedies).toEqual([{
      kind: "strip_review_language", channelId: "instagram_feed", field: "caption",
      before: "Concept preview — Fresh croissants daily. Owner approval required.", after: "Fresh croissants daily.",
      removedPhrases: ["Owner approval required", "Concept preview"], assetIds: ["feed-1"], findingIds: [review.id],
    }]);
    expect(plan.withheldAssetIds).toEqual([]);
    expect(plan.recheckAssetIds).toEqual(["feed-1"]);
  });

  test("strips listed phrases even without a finding, and leaves copy that would become empty to the owner", () => {
    const dirty: CriticCampaignChannel[] = [channels[0], { ...channels[1], headline: "Placeholder headline", body: "Baked on site (draft)." }];
    const plan = planDeterministicFixes(report([]), dirty);
    expect(plan.remedies).toEqual([
      { kind: "manual_copy_edit", channelId: "instagram_stories", field: "headline", text: "Placeholder headline", reason: "copy_empty_after_strip", phrases: ["Placeholder headline"], severity: "major", assetIds: ["story-1"], findingIds: [] },
      { kind: "strip_review_language", channelId: "instagram_stories", field: "body", before: "Baked on site (draft).", after: "Baked on site.", removedPhrases: ["(draft)"], assetIds: ["story-1"], findingIds: [] },
    ]);
    // Re-rendered (body) and still waiting on the owner (headline).
    expect(plan.assets.find((asset) => asset.assetId === "story-1")).toEqual({ assetId: "story-1", kind: "still", disposition: "manual_review", recheck: true });
    expect(plan.recheckAssetIds).toEqual(["story-1"]);
  });

  test("a critical review-language finding is withheld when its channel copy would become empty", () => {
    const dirty: CriticCampaignChannel[] = [{ ...channels[0], headline: "Placeholder" }, channels[1]];
    const critical = finding("feed-1", "review_language_in_consumer_copy", "critical");
    const plan = planDeterministicFixes(report([critical]), dirty);
    expect(plan.remedies).toEqual([
      { kind: "withhold_asset", assetId: "feed-1", reasons: ["unresolved_critical"], findingIds: [critical.id] },
      { kind: "manual_copy_edit", channelId: "instagram_feed", field: "headline", text: "Placeholder", reason: "copy_empty_after_strip", phrases: ["Placeholder"], severity: "critical", assetIds: [], findingIds: [critical.id] },
    ]);
    expect(plan.withheldAssetIds).toEqual(["feed-1"]);
    expect(plan.recheckAssetIds).toEqual([]);
  });

  test("tentative or conditional copy is never rewritten: the owner edits it, and a critical finding withholds the asset", () => {
    const dirty: CriticCampaignChannel[] = [
      { ...channels[0], headline: "Live jazz Friday TBC", caption: "Free pastry with every coffee, subject to approval. Draft copy." },
      { ...channels[1], body: "Opening hours TBD, follow for updates" },
    ];
    const critical = finding("feed-1", "review_language_in_consumer_copy", "critical");
    const minor = finding("story-1", "review_language_in_consumer_copy", "minor");
    const plan = planDeterministicFixes(report([critical, minor]), dirty);
    expect(plan.remedies).toEqual([
      { kind: "withhold_asset", assetId: "feed-1", reasons: ["unresolved_critical"], findingIds: [critical.id] },
      { kind: "manual_copy_edit", channelId: "instagram_feed", field: "headline", text: "Live jazz Friday TBC", reason: "tentative_or_conditional_wording", phrases: ["TBC"], severity: "critical", assetIds: [], findingIds: [critical.id] },
      { kind: "manual_copy_edit", channelId: "instagram_feed", field: "caption", text: "Free pastry with every coffee, subject to approval. Draft copy.", reason: "tentative_or_conditional_wording", phrases: ["subject to approval"], severity: "critical", assetIds: [], findingIds: [critical.id] },
      { kind: "manual_copy_edit", channelId: "instagram_stories", field: "body", text: "Opening hours TBD, follow for updates", reason: "tentative_or_conditional_wording", phrases: ["TBD"], severity: "major", assetIds: ["story-1"], findingIds: [minor.id] },
    ]);
    expect(plan.remedies.some((remedy) => remedy.kind === "strip_review_language")).toBe(false);
    expect(disposition(plan, "story-1")).toBe("manual_review");
    expect(plan.recheckAssetIds).toEqual([]);
    // A CTA carrying tentative wording is never copied onto an asset either.
    const cta = finding("feed-1", "cta_missing_or_occluded", "major");
    const ctaPlan = planDeterministicFixes(report([cta]), [{ ...channels[0], cta: "Book now (TBC)" }]);
    expect(ctaPlan.remedies.find((remedy) => remedy.kind === "manual_review")).toMatchObject({ assetId: "feed-1", reason: "channel_copy_unavailable" });
  });

  test("an unlinked reel is never covered by another channel's copy strip", () => {
    const dirty: CriticCampaignChannel[] = [{ ...channels[0], body: "Baked on site each morning. Draft copy." }, channels[1]];
    const critical = finding("reel", "review_language_in_consumer_copy", "critical", false, 2);
    const minor = finding("loose-1", "review_language_in_consumer_copy", "minor");
    const plan = planDeterministicFixes(report([critical, minor]), dirty);
    expect(plan.remedies).toEqual([
      { kind: "withhold_asset", assetId: "reel", reasons: ["unresolved_critical"], findingIds: [critical.id] },
      { kind: "strip_review_language", channelId: "instagram_feed", field: "body", before: "Baked on site each morning. Draft copy.", after: "Baked on site each morning.", removedPhrases: ["Draft copy"], assetIds: ["feed-1"], findingIds: [] },
      { kind: "manual_review", assetId: "reel", channelId: null, reason: "review_language_not_in_copy", severity: "critical", findingIds: [critical.id] },
      { kind: "manual_review", assetId: "loose-1", channelId: null, reason: "review_language_not_in_copy", severity: "minor", findingIds: [minor.id] },
    ]);
    expect(plan.withheldAssetIds).toEqual(["reel"]);
    expect(disposition(plan, "loose-1")).toBe("manual_review");
    expect(plan.recheckAssetIds).toEqual(["feed-1"]);
  });

  test("a reel linked to a channel is re-rendered and rechecked when that channel's copy is stripped", () => {
    const linked = assets.map((asset) => asset.assetId === "reel" ? { ...asset, channel: "instagram_feed" } : asset);
    const dirty: CriticCampaignChannel[] = [{ ...channels[0], cta: "Visit this week [ev-2]" }, channels[1]];
    const critical = finding("reel", "review_language_in_consumer_copy", "critical", false, 11);
    const plan = planDeterministicFixes(report([critical], [], linked), dirty);
    expect(plan.remedies).toEqual([
      { kind: "strip_review_language", channelId: "instagram_feed", field: "cta", before: "Visit this week [ev-2]", after: "Visit this week", removedPhrases: ["[ev-2]"], assetIds: ["feed-1", "reel"], findingIds: [critical.id] },
    ]);
    expect(plan.withheldAssetIds).toEqual([]);
    expect(plan.recheckAssetIds).toEqual(["feed-1", "reel"]);
    expect(disposition(plan, "reel")).toBe("fix_and_recheck");
  });

  test("review language that is not in the copy (baked into pixels) needs review; critical is withheld", () => {
    const minor = finding("story-1", "review_language_in_consumer_copy", "minor");
    const critical = finding("feed-1", "review_language_in_consumer_copy", "critical");
    const plan = planDeterministicFixes(report([minor, critical]), channels);
    expect(plan.remedies).toEqual([
      { kind: "withhold_asset", assetId: "feed-1", reasons: ["unresolved_critical"], findingIds: [critical.id] },
      { kind: "manual_review", assetId: "story-1", channelId: "instagram_stories", reason: "review_language_not_in_copy", severity: "minor", findingIds: [minor.id] },
      { kind: "manual_review", assetId: "feed-1", channelId: "instagram_feed", reason: "review_language_not_in_copy", severity: "critical", findingIds: [critical.id] },
    ]);
  });

  test("withholding supersedes local fixes and removes the asset from copy re-render lists", () => {
    const dirty: CriticCampaignChannel[] = [{ ...channels[0], body: "Baked on site each morning. Draft copy." }, channels[1]];
    const offer = finding("feed-1", "unapproved_offer", "critical");
    const consent = finding("feed-1", "person_without_consent", "critical");
    const contrast = finding("feed-1", "unreadable_text", "minor", true);
    const plan = planDeterministicFixes(report([offer, contrast, consent]), dirty);
    expect(plan.remedies[0]).toEqual({ kind: "withhold_asset", assetId: "feed-1", reasons: ["person_without_consent", "unapproved_offer"], findingIds: [offer.id, consent.id] });
    expect(plan.remedies.some((remedy) => remedy.kind === "increase_text_contrast")).toBe(false);
    expect(plan.remedies.find((remedy) => remedy.kind === "strip_review_language")).toMatchObject({ assetIds: [], after: "Baked on site each morning." });
    expect(plan.recheckAssetIds).toEqual([]);
  });

  test("an unattributed critical finding blocks the plan; an unattributed minor one does not", () => {
    const blocked = planDeterministicFixes(report([], [{ reason: "unknown_asset", assetId: "feed-9", severity: "critical", rule: "person_without_consent" }]), channels);
    expect(blocked.status).toBe("blocked");
    expect(blocked.remedies).toEqual([{ kind: "manual_review", assetId: null, channelId: null, reason: "unattributed_critical", severity: "critical", findingIds: [] }]);
    const minor = planDeterministicFixes(report([], [{ reason: "unknown_asset", assetId: "feed-9", severity: "minor", rule: "visual_quality" }]), channels);
    expect(minor.status).toBe("clear");
  });

  test("blocks when every asset is withheld, ignores findings for unbound assets, and is pure", () => {
    const findings = assets.map((asset) => finding(asset.assetId, "third_party_branding", "critical"));
    const input = report([...findings, { ...finding("feed-1", "unreadable_text"), assetId: "ghost" }]);
    const snapshot = JSON.stringify(input);
    const plan = planDeterministicFixes(input, channels);
    expect(plan.status).toBe("blocked");
    expect(plan.withheldAssetIds).toEqual(["feed-1", "story-1", "loose-1", "reel"]);
    expect(plan.remedies.every((remedy) => remedy.kind === "withhold_asset")).toBe(true);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(planDeterministicFixes(input, channels)).toEqual(plan);
  });
});
