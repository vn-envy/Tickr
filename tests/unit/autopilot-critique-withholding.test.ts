import { describe, expect, test } from "vitest";
import type { CritiqueReport } from "../../lib/agents/critic";
import type { CampaignCopy } from "../../lib/campaign/copy";
import { applyDeterministicFixes, applyRecheckFixes, combinedVerdict, publicCritic, withheldKitFiles, type CritiqueSnapshot } from "../../lib/autopilot/critique";
import { ChannelSchema } from "../../lib/schemas/common";

// SYNTHETIC fixtures only: no model, no network. They exercise the model-free withholding rules
// applied to a critic report.

function copyFixture(feedBody = "Made slowly for the morning."): CampaignCopy {
  return {
    name: "Synthetic", objective: "Synthetic objective.", audienceHypothesis: "Synthetic.", coreMessage: "Synthetic message.", primaryCta: "Visit", evidenceIds: ["fact-1"], reviewNotes: [],
    channels: ChannelSchema.options.map((id) => ({ id, title: id, headline: "A flat white before work", body: id === "instagram_feed" ? feedBody : "Made slowly for the morning.", caption: "Stop by.", cta: "Visit this morning", evidenceIds: ["fact-1"] })),
    conversation: { opener: "Hello!", commonReplies: Array.from({ length: 3 }, () => ({ question: "Open early?", answer: "The team can confirm hours." })), qualificationQuestion: "When?", nextAction: "Ask the team." },
  } as CampaignCopy;
}

const still = (assetId: string, channel: string) => ({ assetId, filename: `${assetId}.png`, channel, sha256: "a".repeat(64), width: 1080, height: 1350, path: "/synthetic" });
const snapshot: CritiqueSnapshot = {
  version: 1,
  stills: [still("instagram_feed", "instagram_feed"), still("facebook_ads", "facebook_ads"), still("facebook_ads_portrait", "facebook_ads"), { ...still("instagram_reel_cover", "instagram_reels"), filename: "instagram_reel_cover.png" }],
  reel: { filename: "instagram_reel.mp4", sha256: "b".repeat(64), path: "/synthetic", durationSeconds: 12, width: 1080, height: 1920 },
  notes: [],
};
const boundAssets = [
  { assetId: "instagram_feed", filename: "instagram_feed.png", sha256: "a".repeat(64), kind: "still", channel: "instagram_feed" },
  { assetId: "facebook_ads", filename: "facebook_ads.png", sha256: "a".repeat(64), kind: "still", channel: "facebook_ads" },
  { assetId: "facebook_ads_portrait", filename: "facebook_ads_portrait.png", sha256: "a".repeat(64), kind: "still", channel: "facebook_ads" },
  { assetId: "instagram_reel_cover", filename: "instagram_reel_cover.png", sha256: "a".repeat(64), kind: "still", channel: "instagram_reels" },
  { assetId: "reel", filename: "instagram_reel.mp4", sha256: "b".repeat(64), kind: "reel", channel: "instagram_reels" },
];
type Finding = { assetId: string; severity: "critical" | "major" | "minor"; rule: string; gridBox?: unknown };
function report(findings: Finding[], discarded: Array<{ severity: "critical" | "major" | "minor"; rule: string }> = [], bound: ReadonlyArray<(typeof boundAssets)[number]> = boundAssets): CritiqueReport {
  return {
    rulesVersion: "critic-1", boundAssets: bound,
    findings: findings.map((finding, index) => ({ id: `f${index + 1}`, assetKind: finding.assetId === "reel" ? "reel" : "still", description: "Synthetic.", gridBox: finding.gridBox ?? null, box: null, boxBasis: null, boxRejected: false, timeSeconds: null, timeRejected: false, ...finding })),
    discardedFindings: discarded.map((finding) => ({ reason: "unknown_asset", assetId: "instagram_feed_typo.png", ...finding })),
    verdict: findings.some((finding) => finding.severity === "critical") || discarded.some((finding) => finding.severity === "critical") ? "blocking_findings" : "no_blocking_findings",
  } as unknown as CritiqueReport;
}

describe("critic withholding fails closed", () => {
  test("a critical finding the critic could not attribute to one file withholds every critiqued file, and the whole kit", () => {
    const fixes = applyDeterministicFixes(report([], [{ severity: "critical", rule: "person_without_consent" }]), copyFixture(), snapshot);
    expect(fixes.plan?.status).toBe("blocked");
    expect(fixes.withholdAll).toBe(true);
    expect(fixes.withheldFiles).toEqual(["facebook_ads.png", "facebook_ads_portrait.png", "instagram_feed.png", "instagram_reel.mp4", "instagram_reel_cover.png"]);
    const files = ["instagram_feed.png", "facebook_ads.png", "facebook_ads_portrait.png", "instagram_reel.mp4", "instagram_reel_cover.png", "critic-report.json", "campaign-hero-source.png", "campaign-concept.zip"];
    expect(withheldKitFiles({ files, withheld: fixes.withheldFiles, contentWithheld: fixes.contentWithheldFiles, withholdAll: fixes.withholdAll, sourcesOf: () => [] })).toEqual([...files].sort());
  });

  test("a non-critical unattributed finding does not block the kit", () => {
    const fixes = applyDeterministicFixes(report([], [{ severity: "minor", rule: "visual_quality" }]), copyFixture(), snapshot);
    expect(fixes.withholdAll).toBe(false);
    expect(fixes.withheldFiles).toEqual([]);
  });

  test("a critical finding whose only remedy is a recommendation is withheld, never left approvable", () => {
    const fixes = applyDeterministicFixes(report([{ assetId: "instagram_feed", severity: "critical", rule: "unreadable_text" }]), copyFixture(), snapshot);
    expect(fixes.withheldFiles).toEqual(["instagram_feed.png"]);
    expect(fixes.rerenderedFiles).toEqual([]);
  });
});

describe("files reported as changed after the critique", () => {
  test("recommendation-only remedies change no file", () => {
    const fixes = applyDeterministicFixes(report([
      { assetId: "instagram_feed", severity: "major", rule: "unreadable_text" },
      { assetId: "facebook_ads", severity: "major", rule: "cta_missing_or_occluded" },
    ]), copyFixture(), snapshot);
    // The planner still asks for a recheck, but nothing is re-rendered differently.
    expect(fixes.plan?.recheckAssetIds).toEqual(["instagram_feed", "facebook_ads"]);
    expect(fixes.fixesApplied).toEqual([]);
    expect(fixes.rerenderedFiles).toEqual([]);
    expect(fixes.recommendations.length).toBeGreaterThan(0);
  });

  test("only files whose copy was actually rewritten are reported as re-rendered", () => {
    const fixes = applyDeterministicFixes(report([{ assetId: "facebook_ads", severity: "major", rule: "unreadable_text" }]), copyFixture("Morning cups, made slowly. (draft copy)"), snapshot);
    expect(fixes.copyChanged).toBe(true);
    expect(fixes.rerenderedFiles).toEqual(["instagram_feed.png"]);
  });
});

describe("withholding follows the source pixels", () => {
  const files = [
    "instagram_feed.png", "facebook_ads.png", "facebook_ads_portrait.png", "instagram_reel.mp4", "instagram_reel_cover.png", "sam-tracking-overlay.mp4",
    "sam-mask-photo_x.png", "sam-mask-photo_y.png", "campaign-hero-source.png", "critic-report.json", "campaign-concept.zip",
  ];
  const sources: Record<string, string[]> = {
    "instagram_feed.png": ["photo_x"], "facebook_ads.png": ["photo_y"], "facebook_ads_portrait.png": ["photo_y"], "campaign-hero-source.png": ["photo_x"],
    "sam-mask-photo_x.png": ["photo_x"], "sam-mask-photo_y.png": ["photo_y"], "instagram_reel.mp4": ["clip_1"], "instagram_reel_cover.png": ["clip_1"], "sam-tracking-overlay.mp4": ["clip_1"],
  };
  const sourcesOf = (file: string) => sources[file] ?? [];

  test("a still withheld for a person also withholds the hero source export and the SAM mask preview of the same photo", () => {
    const fixes = applyDeterministicFixes(report([{ assetId: "instagram_feed", severity: "major", rule: "person_without_consent" }]), copyFixture(), snapshot);
    expect(fixes.contentWithheldFiles).toEqual(["instagram_feed.png"]);
    expect(withheldKitFiles({ files, withheld: fixes.withheldFiles, contentWithheld: fixes.contentWithheldFiles, withholdAll: false, sourcesOf }))
      .toEqual(["campaign-concept.zip", "campaign-hero-source.png", "instagram_feed.png", "sam-mask-photo_x.png"]);
  });

  test("a Reel withheld for third-party branding also withholds the SAM tracking overlay of the same footage", () => {
    const fixes = applyDeterministicFixes(report([{ assetId: "reel", severity: "minor", rule: "third_party_branding" }]), copyFixture(), snapshot);
    expect(withheldKitFiles({ files, withheld: fixes.withheldFiles, contentWithheld: fixes.contentWithheldFiles, withholdAll: false, sourcesOf }))
      .toEqual(["campaign-concept.zip", "instagram_reel.mp4", "instagram_reel_cover.png", "sam-tracking-overlay.mp4"]);
  });

  test("any withheld Reel withholds the overlay; a copy withhold covers the channel's other files but not other files of the same photo", () => {
    const reel = applyDeterministicFixes(report([{ assetId: "reel", severity: "critical", rule: "unapproved_offer" }]), copyFixture(), snapshot);
    expect(withheldKitFiles({ files, withheld: reel.withheldFiles, contentWithheld: reel.contentWithheldFiles, withholdAll: false, sourcesOf }))
      .toEqual(["campaign-concept.zip", "instagram_reel.mp4", "instagram_reel_cover.png", "sam-tracking-overlay.mp4"]);
    const claim = applyDeterministicFixes(report([{ assetId: "facebook_ads", severity: "critical", rule: "claim_not_supported" }]), copyFixture(), snapshot);
    expect(withheldKitFiles({ files, withheld: claim.withheldFiles, contentWithheld: claim.contentWithheldFiles, withholdAll: false, sourcesOf }))
      .toEqual(["campaign-concept.zip", "facebook_ads.png", "facebook_ads_portrait.png"]);
  });

  test("nothing withheld leaves the kit, the archive included, approvable", () => {
    expect(withheldKitFiles({ files, withheld: [], contentWithheld: [], withholdAll: false, sourcesOf })).toEqual([]);
  });
});

describe("withholding order", () => {
  test("a Reel withheld only because its source photo was withheld still takes the tracking overlay with it", () => {
    const sourcesOf = (file: string) => ({ "instagram_feed.png": ["photo_x"], "instagram_reel.mp4": ["clip_1", "photo_x"], "instagram_reel_cover.png": ["clip_1", "photo_x"], "sam-tracking-overlay.mp4": ["clip_1"] } as Record<string, string[]>)[file] ?? [];
    expect(withheldKitFiles({ files: ["instagram_feed.png", "instagram_reel.mp4", "instagram_reel_cover.png", "sam-tracking-overlay.mp4", "director-report.json"], withheld: ["instagram_feed.png"], contentWithheld: ["instagram_feed.png"], withholdAll: false, sourcesOf }))
      .toEqual(["instagram_feed.png", "instagram_reel.mp4", "instagram_reel_cover.png", "sam-tracking-overlay.mp4"]);
  });
});

describe("the verification critique of files changed after the first critique", () => {
  // Only the re-rendered feed still and the Facebook ad were sent again.
  const recheckSnapshot: CritiqueSnapshot = { version: 1, stills: [still("instagram_feed", "instagram_feed"), still("facebook_ads", "facebook_ads")], reel: null, notes: [] };
  const recheckBound = boundAssets.filter((asset) => asset.assetId === "instagram_feed" || asset.assetId === "facebook_ads");

  test("never rewrites copy again: leftover review wording stays an owner edit and a critical finding withholds its files", () => {
    const draft = copyFixture("Morning cups, made slowly. (draft copy)");
    const fixes = applyRecheckFixes(report([{ assetId: "instagram_feed", severity: "critical", rule: "review_language_in_consumer_copy" }], [], recheckBound), draft, recheckSnapshot, snapshot);
    expect(fixes).not.toHaveProperty("copy");
    expect(fixes.withheldFiles).toEqual(["instagram_feed.png"]);
    expect(fixes.withholdAll).toBe(false);
    expect(fixes.recommendations.join(" ")).toMatch(/still found internal review wording .* it was not rewritten again/);
    expect(fixes.fixesApplied).toEqual([expect.stringMatching(/^Verification critique: Withheld instagram_feed\.png/)]);
    expect(fixes.fixesApplied.join(" ")).not.toMatch(/Removed internal review wording/);
    // Not critical: only an owner edit, nothing withheld.
    const minor = applyRecheckFixes(report([{ assetId: "instagram_feed", severity: "minor", rule: "review_language_in_consumer_copy" }], [], recheckBound), draft, recheckSnapshot, snapshot);
    expect(minor.withheldFiles).toEqual([]);
    expect(minor.recommendations.join(" ")).toMatch(/Owner edit needed/);
  });

  test("withholds like the first critique: critical recommendation-only findings, copy claims across the channel, and unattributed critical problems", () => {
    const layout = applyRecheckFixes(report([{ assetId: "instagram_feed", severity: "critical", rule: "unreadable_text" }], [], recheckBound), copyFixture(), recheckSnapshot, snapshot);
    expect(layout.withheldFiles).toEqual(["instagram_feed.png"]);
    // A claim lives in the channel copy: the unchanged portrait ad of the same channel is withheld too.
    const claim = applyRecheckFixes(report([{ assetId: "facebook_ads", severity: "critical", rule: "claim_not_supported" }], [], recheckBound), copyFixture(), recheckSnapshot, snapshot);
    expect(claim.withheldFiles).toEqual(["facebook_ads.png", "facebook_ads_portrait.png"]);
    const person = applyRecheckFixes(report([{ assetId: "facebook_ads", severity: "major", rule: "person_without_consent" }], [], recheckBound), copyFixture(), recheckSnapshot, snapshot);
    expect(person.contentWithheldFiles).toEqual(["facebook_ads.png"]);
    const unattributed = applyRecheckFixes(report([], [{ severity: "critical", rule: "person_without_consent" }], recheckBound), copyFixture(), recheckSnapshot, snapshot);
    expect(unattributed.withholdAll).toBe(true);
    const clean = applyRecheckFixes(report([], [], recheckBound), copyFixture(), recheckSnapshot, snapshot);
    expect(clean).toMatchObject({ withheldFiles: [], contentWithheldFiles: [], withholdAll: false, fixesApplied: [] });
  });

  test("the public verdict is the worse of both critiques and verification findings are marked", () => {
    const first = report([]);
    const second = report([{ assetId: "instagram_feed", severity: "critical", rule: "unreadable_text" }], [], recheckBound);
    expect(combinedVerdict(first, null)).toBe("no_blocking_findings");
    expect(combinedVerdict(first, second)).toBe("blocking_findings");
    expect(combinedVerdict(null, null)).toBe("not_run");
    const panel = publicCritic(first, { fixesApplied: [], withheldFiles: ["instagram_feed.png"] }, second);
    expect(panel.verdict).toBe("blocking_findings");
    expect(panel.findings.map((finding) => finding.id)).toEqual(["r2-f1"]);
  });
});
