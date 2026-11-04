import type { AnalyzedAsset, GoalFit, PlannedChannel, ProductionPlan, QualityLevel, ReelPlan, ScoreBreakdown, SegmentationPlan, StillPick, SubjectKind } from "./contracts";

/**
 * Deterministic Autopilot director. It turns Spark observations into a production plan
 * with a transparent, documented heuristic — not a model probability, a predicted
 * conversion rate or a claim that an asset depicts a verified product.
 *
 * Safety exclusions come first and are absolute: possible minors, people without a
 * recorded owner consent, third-party branding/signage, and visible price/offer text when
 * no offer is approved never enter the plan.
 */
export interface DirectorInput {
  assets: readonly AnalyzedAsset[];
  /** The creative brief's focus offering, when the campaign features one. */
  focusOfferingId: string | null;
  offerApproved: boolean;
  /** Maximum tracked-reel window. */
  maxReelSeconds?: number;
}

const FIT: Record<GoalFit, number> = { none: 0, weak: 10, moderate: 25, strong: 40 };
const QUALITY: Record<QualityLevel, number> = { poor: 0, fair: 4, good: 8, excellent: 10 };
const PRODUCT_KINDS: ReadonlySet<SubjectKind> = new Set(["product", "dish_or_drink"]);
const PROVENANCE: Record<AnalyzedAsset["provenance"], number> = { owner_upload: 8, owner_instagram: 8, owner_facebook: 8, official_website: 4, meta_illustration: 0 };

function exclusionReasons(asset: AnalyzedAsset, offerApproved: boolean): string[] {
  const reasons: string[] = [];
  const analysis = asset.analysis;
  if (asset.kind === "image" && !analysis) reasons.push("Not analyzed, so its content and risks are unknown.");
  if (asset.kind === "video" && !asset.shotLog) reasons.push("No shot log, so its moments and risks are unknown.");
  // The shot log cannot report minors, branding or price text, so footage needs the image risk
  // check on its sampled frames; without it the footage fails closed like an unanalyzed image.
  if (asset.kind === "video" && !(asset.frameRisks && asset.frameRisks.framesChecked > 0)) reasons.push("Its frames were not checked for minors, third-party branding or price text.");
  const risks = new Set([...(analysis?.risks.map((risk) => risk.kind) ?? []), ...(asset.kind === "video" ? asset.frameRisks?.risks.map((risk) => risk.kind) ?? [] : [])]);
  const consented = asset.consent?.peopleVisibleHaveConsented === true;
  if (risks.has("possible_minor")) reasons.push("A possible minor is visible; Autopilot never uses this automatically.");
  if ((risks.has("person") || risks.has("face") || analysis?.subjectKind === "people" || asset.shotLog?.peopleVisible) && !consented) {
    reasons.push("People are visible without a recorded owner consent for this media.");
  }
  if (risks.has("third_party_logo") || risks.has("other_business_signage")) reasons.push("Shows third-party branding or another business's signage.");
  if (risks.has("price_or_offer_text") && !offerApproved) reasons.push("Shows price or offer text while no offer is approved for this campaign.");
  if (analysis && [analysis.quality.sharpness, analysis.quality.lighting, analysis.quality.composition].every((level) => level === "poor")) reasons.push("Technical quality is poor on every dimension.");
  if (analysis?.subjectKind === "logo") reasons.push("A logo alone is not campaign hero material.");
  return reasons;
}

export function segmentationPlan(asset: AnalyzedAsset): SegmentationPlan {
  const subject = asset.analysis?.primarySubject;
  if (!subject) return { kind: "none" };
  const label = subject.label.replace(/[<>\r\n\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  if (subject.box) return { kind: "geometry", box: subject.box, label: label || "main subject" };
  return label ? { kind: "concept", phrase: label, label } : { kind: "none" };
}

export function scoreStill(asset: AnalyzedAsset, focusOfferingId: string | null): { score: number; breakdown: ScoreBreakdown; reasons: string[] } {
  const analysis = asset.analysis!;
  const reasons: string[] = [];
  const quality = QUALITY[analysis.quality.sharpness] + QUALITY[analysis.quality.lighting] + QUALITY[analysis.quality.composition];
  const offering = focusOfferingId && analysis.matchedOfferingIds.includes(focusOfferingId) ? 20 : analysis.matchedOfferingIds.length ? 5 : 0;
  const plan = segmentationPlan(asset);
  const risk = analysis.risks.filter((item) => item.kind === "readable_text").length ? -3 : 0;
  const breakdown: ScoreBreakdown = {
    goalFit: FIT[analysis.goalFit], quality, heroWorthy: analysis.heroWorthy ? 10 : 0, offering,
    subject: PRODUCT_KINDS.has(analysis.subjectKind) ? 5 : analysis.subjectKind === "process_or_hands" ? 4 : 0,
    provenance: PROVENANCE[asset.provenance], samReady: plan.kind === "geometry" ? 5 : plan.kind === "concept" ? 2 : 0, risk,
  };
  if (offering === 20) reasons.push("Shows the campaign's featured offering (Spark observation, not a verified identity).");
  if (analysis.goalFit === "strong" || analysis.goalFit === "moderate") reasons.push(`${analysis.goalFit === "strong" ? "Strong" : "Moderate"} fit with the owner's goal.`);
  if (analysis.heroWorthy) reasons.push("Judged hero-worthy for composition and impact.");
  if (asset.provenance.startsWith("owner_")) reasons.push("The owner's own media.");
  if (plan.kind === "geometry") reasons.push("Subject located, ready for a box-prompted SAM cutout.");
  const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  return { score, breakdown, reasons };
}

function pick(asset: AnalyzedAsset, focusOfferingId: string | null): StillPick {
  const { score, breakdown, reasons } = scoreStill(asset, focusOfferingId);
  return { assetId: asset.assetId, segmentation: segmentationPlan(asset), score, breakdown, reasons };
}

function planReel(videos: readonly AnalyzedAsset[], hero: StillPick | null, maxSeconds: number): ReelPlan {
  type Candidate = { asset: AnalyzedAsset; moment: NonNullable<AnalyzedAsset["shotLog"]>["moments"][number]; score: number };
  const candidates: Candidate[] = [];
  for (const asset of videos) {
    for (const moment of asset.shotLog?.moments ?? []) {
      if (!["hero_product", "process", "hands"].includes(moment.kind) || !moment.subjectLabel || moment.steadiness === "shaky") continue;
      if (FIT[moment.goalFit] < FIT.moderate) continue;
      const score = FIT[moment.goalFit] + (moment.kind === "hero_product" ? 10 : 6) + (moment.steadiness === "steady" ? 8 : 3) + PROVENANCE[asset.provenance]
        + (asset.shotLog?.heroMomentSeconds !== null && asset.shotLog!.heroMomentSeconds! >= moment.startSeconds && asset.shotLog!.heroMomentSeconds! <= moment.endSeconds ? 5 : 0);
      candidates.push({ asset, moment, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.asset.assetId.localeCompare(b.asset.assetId) || a.moment.startSeconds - b.moment.startSeconds);
  const best = candidates[0];
  if (best) {
    const duration = best.asset.durationSeconds ?? best.moment.endSeconds;
    const promptSeconds = Math.min(best.moment.endSeconds, Math.max(best.moment.startSeconds, best.asset.shotLog?.heroMomentSeconds ?? (best.moment.startSeconds + best.moment.endSeconds) / 2));
    const windowSeconds = Math.min(maxSeconds, duration);
    // Start a little before the prompt frame so the tracked subject is established early.
    const windowStartSeconds = Math.max(0, Math.min(duration - windowSeconds, promptSeconds - Math.min(2, windowSeconds / 4)));
    return {
      mode: "tracked_video", clipAssetId: best.asset.assetId, windowStartSeconds: round(windowStartSeconds), windowSeconds: round(windowSeconds), promptSeconds: round(promptSeconds),
      subjectLabel: best.moment.subjectLabel!, momentKind: best.moment.kind, fallbackStill: hero,
      reasons: [`Owner footage shows a ${best.moment.steadiness} ${best.moment.kind.replaceAll("_", " ")} moment with ${best.moment.goalFit} goal fit; SAM 3.1 will track the real subject through it.`],
    };
  }
  if (hero && hero.segmentation.kind !== "none") return { mode: "still_depth", still: hero, reasons: ["No qualifying steady product footage; the hero photo's SAM layers drive a depth Reel."] };
  if (hero) return { mode: "still_depth", still: hero, reasons: ["No located subject; the depth Reel uses composed crops of the hero photo."] };
  return { mode: "illustration", reasons: ["No usable real media; a clearly labelled Muse illustration is the fallback."] };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export function planProduction(input: DirectorInput): ProductionPlan {
  const excluded: ProductionPlan["excluded"] = [];
  const usableImages: AnalyzedAsset[] = [];
  const usableVideos: AnalyzedAsset[] = [];
  for (const asset of [...input.assets].sort((a, b) => a.assetId.localeCompare(b.assetId))) {
    const reasons = exclusionReasons(asset, input.offerApproved);
    if (reasons.length) { excluded.push({ assetId: asset.assetId, reasons }); continue; }
    (asset.kind === "image" ? usableImages : usableVideos).push(asset);
  }
  const ranked = usableImages.map((asset) => ({ asset, pick: pick(asset, input.focusOfferingId) }))
    .sort((a, b) => b.pick.score - a.pick.score || a.asset.assetId.localeCompare(b.asset.assetId));
  // Prefer real media over generated illustrations for the hero whenever one qualifies.
  const real = ranked.filter((item) => item.asset.provenance !== "meta_illustration" && FIT[item.asset.analysis!.goalFit] >= FIT.weak);
  const heroEntry = real.find((item) => PRODUCT_KINDS.has(item.asset.analysis!.subjectKind) || item.asset.analysis!.heroWorthy) ?? real[0] ?? null;
  const hero = heroEntry?.pick ?? null;

  // Carousel: hero first, then diverse subjects (penalize repeating a subject kind), then repeat real assets if needed.
  // Every unused moderate-or-better asset outranks every weak-fit one: the diversity penalty only
  // orders assets within a goal-fit tier, so a weak asset fills a slot only when nothing stronger is left.
  const carousel: StillPick[] = hero ? [hero] : [];
  const usedKinds = new Map<SubjectKind, number>();
  if (heroEntry) usedKinds.set(heroEntry.asset.analysis!.subjectKind, 1);
  const pool = real.filter((item) => item.pick.assetId !== hero?.assetId && item.asset.analysis!.suitableFor.includes("carousel"));
  const tier = (item: (typeof pool)[number]) => (FIT[item.asset.analysis!.goalFit] >= FIT.moderate ? 1 : 0);
  const diverse = (item: (typeof pool)[number]) => item.pick.score - 25 * (usedKinds.get(item.asset.analysis!.subjectKind) ?? 0);
  while (carousel.length < 4 && pool.length) {
    pool.sort((a, b) => tier(b) - tier(a) || diverse(b) - diverse(a) || a.pick.assetId.localeCompare(b.pick.assetId));
    const next = pool.shift()!;
    carousel.push(next.pick);
    usedKinds.set(next.asset.analysis!.subjectKind, (usedKinds.get(next.asset.analysis!.subjectKind) ?? 0) + 1);
  }
  for (let index = 0; carousel.length && carousel.length < 4; index++) carousel.push(carousel[index % carousel.length]);

  const bestFor = (need: "story" | "ad" | "whatsapp" | "feed", preferPortrait = false) => {
    const options = real.filter((item) => item.asset.analysis!.suitableFor.includes(need));
    if (preferPortrait) options.sort((a, b) => Number(b.asset.height > b.asset.width) - Number(a.asset.height > a.asset.width) || b.pick.score - a.pick.score);
    return options[0]?.pick.assetId ?? hero?.assetId ?? null;
  };
  const second = carousel.find((item) => item.assetId !== hero?.assetId)?.assetId ?? hero?.assetId ?? null;
  const channelAssets: Record<PlannedChannel, string | null> = {
    instagram_feed: hero?.assetId ?? null,
    facebook_ads: bestFor("ad"),
    instagram_stories: bestFor("story", true),
    click_to_whatsapp: bestFor("whatsapp"),
    whatsapp_status: second,
  };
  const reel = planReel(usableVideos, hero, Math.min(12, Math.max(4, input.maxReelSeconds ?? 12)));
  const notes: string[] = [];
  if (!hero) notes.push("No real image qualified as a hero; channel stills fall back to a labelled illustration or typography.");
  if (excluded.length) notes.push(`${excluded.length} media item${excluded.length === 1 ? " was" : "s were"} excluded for safety, rights or quality; see the reasons.`);
  if (hero && carousel.filter((item, index, list) => list.findIndex((other) => other.assetId === item.assetId) === index).length < 4) notes.push("Fewer than four distinct real images qualified; some carousel slides reuse an image with a different crop.");
  return {
    version: "autopilot-plan-1", hero, carousel, channelAssets, reel, excluded,
    ranking: [...ranked.map((item) => ({ assetId: item.pick.assetId, kind: "image" as const, score: item.pick.score, breakdown: item.pick.breakdown })), ...usableVideos.map((asset) => ({ assetId: asset.assetId, kind: "video" as const, score: 0, breakdown: null }))],
    needsIllustration: !hero && reel.mode !== "tracked_video", notes,
  };
}
