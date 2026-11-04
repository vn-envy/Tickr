import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { analyzedImage, analyzeHarvest, ownBrandingRiskKind, type AnalyzeDependencies } from "../../lib/autopilot/analyze";
import { planProduction } from "../../lib/autopilot/director";
import type { HarvestedAsset } from "../../lib/autopilot/harvest";
import type { MediaLibrary } from "../../lib/media/library";
import type { MediaAnalysisRequest, MediaAssetAnalysis } from "../../lib/meta/media-analysis";

// SYNTHETIC business, notes and observations only; no Meta request is made.
const business = { name: "Grandma Daphne's", category: "cafe and bakery" };

let root = "";
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "tickr-autopilot-analyze-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function harvested(id: string): HarvestedAsset {
  return { assetId: id, kind: "image", provenance: "official_website", rights: "unknown", width: 1200, height: 1200, durationSeconds: null, consent: null, addedAt: "2026-11-04T00:00:00.000Z", capturedAt: null, caption: null } as unknown as HarvestedAsset;
}
function observation(id: string, overrides: Partial<MediaAssetAnalysis> = {}): MediaAssetAnalysis {
  return {
    assetId: id, width: 1200, height: 1200, depicts: "A synthetic layered dessert.", subjectKind: "dish_or_drink", matchedOfferingIds: [],
    primarySubject: { label: "layered dessert", box: { x1: 100, y1: 100, x2: 900, y2: 900 } }, technicalQuality: { sharpness: "good", lighting: "good", composition: "good" },
    goalFit: "moderate", goalReason: "Synthetic.", heroWorthy: false, heroReason: "Synthetic.", suitableFor: ["carousel", "feed", "story", "ad", "whatsapp"], risks: [], visibleText: "",
    ...overrides,
  } as unknown as MediaAssetAnalysis;
}

describe("own-branding risk guard", () => {
  test("a branding flag whose note names only this business becomes readable text", () => {
    expect(ownBrandingRiskKind("third_party_logo", "Grandma Daphne's pink logo on the wall", business)).toBe("readable_text");
    expect(ownBrandingRiskKind("other_business_signage", "Grandma Daphnes bakery sign in the window", business)).toBe("readable_text");
    expect(ownBrandingRiskKind("third_party_logo", "GRANDMA DAPHNE’S logo printed on cup", business)).toBe("readable_text");
  });

  test("anything that may name another party keeps the model's label", () => {
    expect(ownBrandingRiskKind("third_party_logo", "Coca-Cola logo on fridge", business)).toBe("third_party_logo");
    expect(ownBrandingRiskKind("third_party_logo", "Coca-Cola logo on fridge in Grandma Daphne's", business)).toBe("third_party_logo");
    expect(ownBrandingRiskKind("other_business_signage", "Grandma Daphne's sign next to another cafe's sign", business)).toBe("other_business_signage");
    expect(ownBrandingRiskKind("other_business_signage", "Grandma Daphne's and Nero signs", business)).toBe("other_business_signage");
    expect(ownBrandingRiskKind("other_business_signage", "Sign of a neighbouring business", business)).toBe("other_business_signage");
    expect(ownBrandingRiskKind("other_business_signage", "Eclectic cafe dining room", business)).toBe("other_business_signage");
    expect(ownBrandingRiskKind("third_party_logo", "Grandma logo", business)).toBe("third_party_logo");
    expect(ownBrandingRiskKind("third_party_logo", "Grandma Daphne's logo", undefined)).toBe("third_party_logo");
  });

  test("a generic business name never qualifies, and other risk kinds are untouched", () => {
    const generic = { name: "The Cafe", category: "cafe" };
    expect(ownBrandingRiskKind("other_business_signage", "The cafe sign", generic)).toBe("other_business_signage");
    expect(ownBrandingRiskKind("possible_minor", "Grandma Daphne's logo", business)).toBe("possible_minor");
    expect(ownBrandingRiskKind("price_or_offer_text", "Grandma Daphne's logo", business)).toBe("price_or_offer_text");
  });

  test("the director keeps an own-branded photo but still rejects a bare logo and a real third-party mark", () => {
    const ownSign = analyzedImage(harvested("interior"), observation("interior", { subjectKind: "interior", risks: [{ kind: "other_business_signage", box: null, note: "Grandma Daphne's sign on the wall" }] }), business);
    const logo = analyzedImage(harvested("logo"), observation("logo", { subjectKind: "logo", risks: [{ kind: "third_party_logo", box: null, note: "Grandma Daphne's pink logo" }] }), business);
    const thirdParty = analyzedImage(harvested("fridge"), observation("fridge", { risks: [{ kind: "third_party_logo", box: null, note: "Coca-Cola logo on fridge" }] }), business);
    const unguarded = analyzedImage(harvested("unguarded"), observation("unguarded", { risks: [{ kind: "third_party_logo", box: null, note: "Grandma Daphne's logo" }] }));
    expect(ownSign.analysis?.risks).toEqual([{ kind: "readable_text", box: null }]);
    const plan = planProduction({ focusOfferingId: null, offerApproved: false, assets: [ownSign, logo, thirdParty, unguarded] });
    const reasons = Object.fromEntries(plan.excluded.map((item) => [item.assetId, item.reasons]));
    expect(reasons.interior).toBeUndefined();
    expect(reasons.logo).toEqual(["A logo alone is not campaign hero material."]);
    expect(reasons.fridge).toEqual(["Shows third-party branding or another business's signage."]);
    expect(reasons.unguarded).toEqual(["Shows third-party branding or another business's signage."]);
  });

  test("analysis applies the guard to analyzed images and says so in its notes", async () => {
    const directory = join(root, "harvest");
    await mkdir(directory, { recursive: true });
    for (const id of ["own", "other"]) await writeFile(join(directory, id), Buffer.from("synthetic"));
    const dependencies: AnalyzeDependencies = {
      normalizeClip: (async () => { throw new Error("no clips"); }) as unknown as AnalyzeDependencies["normalizeClip"],
      analyzeShots: (async () => { throw new Error("no clips"); }) as unknown as AnalyzeDependencies["analyzeShots"],
      analyzeMedia: (async (request: MediaAnalysisRequest) => ({
        model: "muse-spark-1.3", usage: { inputTokens: 1, outputTokens: 1 }, elapsedMs: 1,
        assets: request.assets.map((asset) => observation(asset.assetId, { risks: [{ kind: "third_party_logo", box: null, note: asset.assetId === "own" ? "Grandma Daphne's logo on cup" : "Delivery app sticker on window" }] })),
      })) as unknown as AnalyzeDependencies["analyzeMedia"],
    };
    const library = { verifyAsset: async (id: string) => ({ localPath: join(directory, id), mimeType: "image/png" }) } as unknown as MediaLibrary;
    const record = await analyzeHarvest({ directory, binding: "synthetic-binding", assets: [harvested("own"), harvested("other")], library, goal: "Synthetic goal", business, offerings: [], gate: async () => "reserved", dependencies });
    const kinds = Object.fromEntries(record.assets.map((asset) => [asset.assetId, asset.analysis?.risks.map((risk) => risk.kind)]));
    expect(kinds).toEqual({ own: ["readable_text"], other: ["third_party_logo"] });
    expect(record.notes.join(" ")).toContain("1 branding flag names this business itself");
  });
});
