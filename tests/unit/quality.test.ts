import { describe, expect, it } from "vitest";
import { canExportCreative } from "../../lib/schemas";

const asset = {
  id: "reel_1", channel: "instagram_reels", mediaType: "video", localPath: "campaign/reel.mp4",
  assetHash: "a".repeat(64), copyHash: "b".repeat(64), motionSpecHash: "c".repeat(64),
  sourceAssetIds: ["photo_1"], generatedComponents: [], width: 1080, height: 1920,
};
const report = {
  assetId: asset.id, assetHash: asset.assetHash, copyHash: asset.copyHash, motionSpecHash: asset.motionSpecHash,
  evidenceVersion: "evidence_v1", ruleVersion: "rules_v1", checkedAt: "2026-11-01T09:00:00Z", verdict: "pass",
  checks: [{ ruleId: "factual_support", status: "pass", reason: "Exact offer confirmed by owner" }],
};
const context = { evidenceVersion: "evidence_v1", ruleVersion: "rules_v1" };

describe("final-version quality approval", () => {
  it("allows only the exact checked asset, copy, motion, evidence and rules versions", () => {
    expect(canExportCreative(asset, report, context)).toBe(true);
    for (const field of ["assetHash", "copyHash", "motionSpecHash"] as const) {
      expect(canExportCreative({ ...asset, [field]: "d".repeat(64) }, report, context)).toBe(false);
    }
    expect(canExportCreative(asset, report, { ...context, evidenceVersion: "evidence_v2" })).toBe(false);
    expect(canExportCreative(asset, report, { ...context, ruleVersion: "rules_v2" })).toBe(false);
  });

  it("withholds unresolved checks and unbound video motion", () => {
    expect(canExportCreative(asset, { ...report, checks: [{ ruleId: "offer", status: "needs_owner", reason: "Price unconfirmed" }] }, context)).toBe(false);
    expect(canExportCreative({ ...asset, motionSpecHash: undefined }, { ...report, motionSpecHash: undefined }, context)).toBe(false);
  });
});
