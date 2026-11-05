import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanReelSubject, planProduction, scoreStill } from "../../lib/autopilot/director";
import { chooseAutopilotOpportunity } from "../../lib/autopilot/select";
import { AutopilotBudgetError, createAutopilotBudget } from "../../lib/autopilot/budget";
import type { AnalyzedAsset } from "../../lib/autopilot/contracts";
import type { ResearchReport } from "../../lib/research/contracts";

// SYNTHETIC fixtures: invented observations used only to exercise deterministic planning.
function image(id: string, overrides: Partial<NonNullable<AnalyzedAsset["analysis"]>> = {}, asset: Partial<AnalyzedAsset> = {}): AnalyzedAsset {
  return {
    assetId: id, kind: "image", provenance: "owner_upload", rights: "owner_attested", width: 1200, height: 1500, durationSeconds: null,
    consent: { peopleVisibleHaveConsented: "no_people" }, shotLog: null,
    analysis: {
      depicts: "A synthetic test subject.", subjectKind: "dish_or_drink", matchedOfferingIds: [], primarySubject: { label: "cup of coffee", box: { x1: 100, y1: 200, x2: 700, y2: 900 } },
      quality: { sharpness: "good", lighting: "good", composition: "good" }, goalFit: "moderate", heroWorthy: false,
      suitableFor: ["carousel", "feed", "story", "ad", "whatsapp", "reel_hero"], risks: [], ...overrides,
    },
    ...asset,
  };
}
function video(id: string, moments: NonNullable<AnalyzedAsset["shotLog"]>["moments"], asset: Partial<AnalyzedAsset> = {}): AnalyzedAsset {
  return { assetId: id, kind: "video", provenance: "owner_upload", rights: "owner_attested", width: 720, height: 1280, durationSeconds: 20, consent: { peopleVisibleHaveConsented: "no_people" }, analysis: null, shotLog: { heroMomentSeconds: 9, peopleVisible: false, moments }, frameRisks: { framesChecked: 8, risks: [] }, ...asset };
}

describe("Autopilot director", () => {
  it("replaces an unclean hero cutout with the best-ranked eligible photo whose existing cutout is clean", () => {
    const assets = [
      image("hero", { goalFit: "strong", heroWorthy: true }), image("weak", { goalFit: "weak", subjectKind: "interior" }),
      image("second", { goalFit: "moderate", subjectKind: "exterior_storefront" }), image("third", { goalFit: "strong" }),
    ];
    const plan = planProduction({ focusOfferingId: null, offerApproved: false, assets });
    expect(plan.hero?.assetId).toBe("hero");
    const hero = plan.hero!;
    const ranked = plan.ranking.map((entry) => entry.assetId).filter((id) => id !== "hero" && id !== "weak");
    // A clean planned hero is kept; otherwise the director's ranking order decides among clean photos.
    expect(cleanReelSubject(plan, assets, hero, new Set(["hero", "second", "third"]))).toBe(hero);
    expect(cleanReelSubject(plan, assets, hero, new Set(["second", "third"]))?.assetId).toBe(ranked[0]);
    expect(cleanReelSubject(plan, assets, hero, new Set([ranked[1]]))?.assetId).toBe(ranked[1]);
    // Weak goal fit, the illustration, a later safety risk, an unknown asset or no clean cutout: no replacement.
    expect(cleanReelSubject(plan, assets, hero, new Set(["weak"]))).toBeNull();
    expect(cleanReelSubject(plan, assets.map((asset) => asset.assetId === "second" ? { ...asset, provenance: "meta_illustration" as const } : asset), hero, new Set(["second"]))).toBeNull();
    expect(cleanReelSubject(plan, assets.map((asset) => asset.assetId === "third" ? image("third", { goalFit: "strong", risks: [{ kind: "possible_minor", box: null }] }) : asset), hero, new Set(["third"]))).toBeNull();
    expect(cleanReelSubject({ ...plan, excluded: [{ assetId: "third", reasons: ["synthetic"] }] } as typeof plan, assets, hero, new Set(["third"]))).toBeNull();
    expect(cleanReelSubject(plan, assets, hero, new Set(["missing"]))).toBeNull();
    expect(cleanReelSubject(plan, assets, hero, new Set())).toBeNull();
  });

  it("excludes unsafe media before ranking and explains why", () => {
    const plan = planProduction({ focusOfferingId: null, offerApproved: false, assets: [
      image("minor", { risks: [{ kind: "possible_minor", box: null }] }),
      image("people-no-consent", { risks: [{ kind: "face", box: null }] }, { consent: null, provenance: "owner_instagram" }),
      image("people-consented", { risks: [{ kind: "person", box: null }], goalFit: "weak" }, { consent: { peopleVisibleHaveConsented: true } }),
      image("brand", { risks: [{ kind: "third_party_logo", box: null }] }),
      image("price", { risks: [{ kind: "price_or_offer_text", box: null }] }),
      image("good"),
    ] });
    expect(plan.excluded.map((item) => item.assetId).sort()).toEqual(["brand", "minor", "people-no-consent", "price"]);
    expect(plan.ranking.map((item) => item.assetId)).toEqual(["good", "people-consented"]);
    expect(plan.hero?.assetId).toBe("good");
  });

  it("allows approved offers and prefers the featured offering with a box-prompted SAM plan", () => {
    const plan = planProduction({ focusOfferingId: "o1", offerApproved: true, assets: [
      image("a", { goalFit: "strong" }), image("b", { matchedOfferingIds: ["o1"], risks: [{ kind: "price_or_offer_text", box: null }] }),
    ] });
    expect(plan.excluded).toEqual([]);
    expect(plan.hero?.assetId).toBe("b");
    expect(plan.hero?.segmentation).toEqual({ kind: "geometry", box: { x1: 100, y1: 200, x2: 700, y2: 900 }, label: "cup of coffee" });
    expect(scoreStill(image("b", { matchedOfferingIds: ["o1"] }), "o1").breakdown.offering).toBe(20);
  });

  it("builds a diverse four-slot carousel and only repeats real assets when necessary", () => {
    const plan = planProduction({ focusOfferingId: null, offerApproved: false, assets: [
      image("cup1", { goalFit: "strong", heroWorthy: true }), image("cup2", { goalFit: "strong" }), image("room", { subjectKind: "interior", goalFit: "moderate" }), image("front", { subjectKind: "exterior_storefront", goalFit: "moderate" }),
    ] });
    expect(plan.carousel.map((item) => item.assetId)).toEqual(["cup1", "front", "room", "cup2"]);
    const sparse = planProduction({ focusOfferingId: null, offerApproved: false, assets: [image("only")] });
    expect(sparse.carousel.map((item) => item.assetId)).toEqual(["only", "only", "only", "only"]);
    expect(sparse.notes.join(" ")).toContain("reuse");
  });

  it("fills carousel slots with moderate-or-better assets before any weak-fit asset", () => {
    // Live regression: a weak-fit latte (product) displaced an unused moderate brownie plate
    // (same subject kind as the hero, so its diversity penalty sank it below the latte).
    const assets = [
      image("hero", { goalFit: "strong", heroWorthy: true }),
      image("brownie", { goalFit: "moderate" }),
      image("latte", { subjectKind: "product", goalFit: "weak", heroWorthy: true }),
      image("room", { subjectKind: "interior", goalFit: "moderate" }),
      image("front", { subjectKind: "exterior_storefront", goalFit: "moderate" }),
    ];
    const scores = Object.fromEntries(assets.map((asset) => [asset.assetId, scoreStill(asset, null).score]));
    expect(scores.latte).toBeGreaterThan(scores.brownie - 25);
    const plan = planProduction({ focusOfferingId: null, offerApproved: false, assets });
    expect(plan.carousel.map((item) => item.assetId)).toEqual(["hero", "front", "room", "brownie"]);
    expect(plan.carousel.map((item) => item.assetId)).not.toContain("latte");
    // A weak asset still fills a slot when no stronger unused real asset remains, before any repeat.
    const sparse = planProduction({ focusOfferingId: null, offerApproved: false, assets: [image("hero", { goalFit: "strong", heroWorthy: true }), image("brownie", { goalFit: "moderate" }), image("latte", { subjectKind: "product", goalFit: "weak" })] });
    expect(sparse.carousel.map((item) => item.assetId)).toEqual(["hero", "brownie", "latte", "hero"]);
  });

  it("chooses tracked owner footage for the Reel and centres the window on the hero moment", () => {
    const plan = planProduction({ focusOfferingId: null, offerApproved: false, assets: [
      image("still"),
      video("shaky", [{ startSeconds: 0, endSeconds: 6, kind: "hero_product", steadiness: "shaky", subjectLabel: "cake", goalFit: "strong" }]),
      video("clip", [{ startSeconds: 7, endSeconds: 14, kind: "hero_product", steadiness: "steady", subjectLabel: "chocolate cake", goalFit: "strong" }]),
    ] });
    expect(plan.reel).toEqual(expect.objectContaining({ mode: "tracked_video", clipAssetId: "clip", promptSeconds: 9, windowStartSeconds: 7, windowSeconds: 12, subjectLabel: "chocolate cake" }));
  });

  it("never tracks footage with people unless consent is recorded, falling back to a depth Reel", () => {
    const plan = planProduction({ focusOfferingId: null, offerApproved: false, assets: [
      image("still"), video("crowd", [{ startSeconds: 0, endSeconds: 5, kind: "hero_product", steadiness: "steady", subjectLabel: "cake", goalFit: "strong" }], { shotLog: { heroMomentSeconds: 2, peopleVisible: true, moments: [{ startSeconds: 0, endSeconds: 5, kind: "hero_product", steadiness: "steady", subjectLabel: "cake", goalFit: "strong" }] }, consent: null }),
    ] });
    expect(plan.reel.mode).toBe("still_depth");
    expect(plan.excluded.map((item) => item.assetId)).toEqual(["crowd"]);
  });

  it("applies the image risk exclusions to footage frames, even with the blanket connected-account consent", () => {
    const steady = [{ startSeconds: 0, endSeconds: 10, kind: "hero_product" as const, steadiness: "steady" as const, subjectLabel: "cake", goalFit: "strong" as const }];
    const attested = { consent: { peopleVisibleHaveConsented: true as const }, provenance: "owner_instagram" as const };
    const frames = (kind: "possible_minor" | "third_party_logo" | "other_business_signage" | "price_or_offer_text") => ({ framesChecked: 4, risks: [{ kind, atSeconds: 3 }] });
    const plan = planProduction({ focusOfferingId: null, offerApproved: false, assets: [
      image("still"),
      video("minor", steady, { ...attested, frameRisks: frames("possible_minor") }),
      video("logo", steady, { ...attested, frameRisks: frames("third_party_logo") }),
      video("signage", steady, { ...attested, frameRisks: frames("other_business_signage") }),
      video("price", steady, { ...attested, frameRisks: frames("price_or_offer_text") }),
      video("unchecked", steady, { ...attested, frameRisks: null }),
      video("unchecked-legacy", steady, { ...attested, frameRisks: undefined }),
      video("zero-frames", steady, { ...attested, frameRisks: { framesChecked: 0, risks: [] } }),
    ] });
    expect(plan.excluded.map((item) => item.assetId).sort()).toEqual(["logo", "minor", "price", "signage", "unchecked", "unchecked-legacy", "zero-frames"]);
    expect(plan.excluded.find((item) => item.assetId === "minor")?.reasons.join(" ")).toContain("possible minor");
    expect(plan.excluded.find((item) => item.assetId === "unchecked")?.reasons.join(" ")).toContain("frames were not checked");
    expect(plan.reel.mode).toBe("still_depth");
    // An approved offer allows price text in footage exactly as it does in photos.
    const approved = planProduction({ focusOfferingId: null, offerApproved: true, assets: [video("price", steady, { ...attested, frameRisks: frames("price_or_offer_text") })] });
    expect(approved.excluded).toEqual([]);
    expect(approved.reel).toEqual(expect.objectContaining({ mode: "tracked_video", clipAssetId: "price" }));
  });

  it("falls back to a labelled illustration when no real media qualifies", () => {
    const plan = planProduction({ focusOfferingId: null, offerApproved: false, assets: [image("bad", { quality: { sharpness: "poor", lighting: "poor", composition: "poor" } })] });
    expect(plan.hero).toBeNull();
    expect(plan.reel.mode).toBe("illustration");
    expect(plan.needsIllustration).toBe(true);
  });
});

describe("Autopilot opportunity selection", () => {
  const dimension = (value: number | null) => ({ value, rationale: "Synthetic." });
  const opportunity = (id: string, values: Array<number | null>) => ({ id, title: `Option ${id}`, hypothesis: "h", whyNow: "w", evidenceIds: ["e1"], comparison: "c", customerAction: "a", test: "t", uncertainties: [],
    scores: { impact: dimension(values[0]), evidence: dimension(values[1]), differentiation: dimension(values[2]), feasibility: dimension(values[3]), confidence: dimension(values[4]) } });
  const report = (opportunities: ReturnType<typeof opportunity>[], recommended: string | null): ResearchReport => ({ summary: "s", evidence: [], findings: [], opportunities, recommendedOpportunityId: recommended, unknowns: [], ownerQuestions: [], coverage: { sources: 1, competitorSources: 0, customerSources: 0 }, generatedAt: "2026-11-04T00:00:00.000Z", mode: "synthetic" });
  const hash = "a".repeat(64);
  it("follows a valid recommendation, else the highest complete score, else the first", () => {
    expect(chooseAutopilotOpportunity(report([opportunity("x", [50, 50, 50, 50, 50]), opportunity("y", [100, 100, 100, 100, 100])], "x"), hash)?.basis).toBe("report_recommendation");
    const scored = chooseAutopilotOpportunity(report([opportunity("x", [50, 50, 50, 50, 50]), opportunity("y", [100, 100, 100, 100, 100])], "missing"), hash);
    expect(scored).toEqual(expect.objectContaining({ opportunityId: "y", basis: "highest_complete_score", score: 100 }));
    expect(chooseAutopilotOpportunity(report([opportunity("x", [null, 50, 50, 50, 50])], null), hash)).toEqual(expect.objectContaining({ opportunityId: "x", basis: "first_supported", score: null }));
    expect(chooseAutopilotOpportunity(report([], null), hash)).toBeNull();
  });
});

describe("Autopilot budget", () => {
  let directory: string | undefined;
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  it("persists role reservations before the run reservation and enforces caps", async () => {
    directory = await mkdtemp(join(tmpdir(), "tickr-budget-"));
    const reserveRun = vi.fn(async () => {});
    const budget = createAutopilotBudget(directory, reserveRun, { spark_copy: 1, spark_media: 1, spark_shotlog: 0, sam_image: 2, sam_video: 0, muse_image: 0, spark_critic: 0 });
    await Promise.all([budget.reserve("sam_image"), budget.reserve("sam_image")]);
    await expect(budget.reserve("sam_image")).rejects.toBeInstanceOf(AutopilotBudgetError);
    await expect(budget.reserve("sam_video")).rejects.toBeInstanceOf(AutopilotBudgetError);
    expect(reserveRun).toHaveBeenCalledTimes(2);
    expect(await budget.remaining("sam_image")).toBe(0);
    expect((await budget.counts()).sam_image).toBe(2);
    // A failed run reservation still counts the role (conservative), so it can never be re-spent.
    const failing = createAutopilotBudget(directory, async () => { throw new Error("run limit"); });
    await expect(failing.reserve("spark_copy")).rejects.toThrow("run limit");
    expect((await failing.counts()).spark_copy).toBe(1);
    await writeFile(join(directory, "autopilot-budget.json"), "{broken");
    await expect(failing.reserve("spark_copy")).rejects.toThrow("failed validation");
  });
});
