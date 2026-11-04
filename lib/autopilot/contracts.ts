import type { SamBox } from "../meta/sam-prompts";

/**
 * Autopilot contracts. These are provider-agnostic: adapters translate Muse Spark media
 * analysis and shot logs into AnalyzedAsset, and the deterministic director turns those
 * observations into a ProductionPlan. Nothing here is a verified fact about the business.
 */
export type MediaProvenance = "official_website" | "owner_upload" | "owner_instagram" | "owner_facebook" | "meta_illustration";
export type MediaRights = "owner_attested" | "unknown_review_required" | "generated_illustration";
export type QualityLevel = "poor" | "fair" | "good" | "excellent";
export type GoalFit = "none" | "weak" | "moderate" | "strong";
export type SubjectKind = "product" | "dish_or_drink" | "interior" | "exterior_storefront" | "people" | "process_or_hands" | "menu_or_signage" | "logo" | "event" | "other";
export type RiskKind = "person" | "face" | "possible_minor" | "third_party_logo" | "readable_text" | "other_business_signage" | "price_or_offer_text";
export type Suitability = "reel_hero" | "carousel" | "story" | "feed" | "ad" | "whatsapp";
export type MomentKind = "hero_product" | "process" | "hands" | "storefront" | "interior" | "people" | "ambience" | "other";

export interface AnalyzedAsset {
  assetId: string;
  kind: "image" | "video";
  provenance: MediaProvenance;
  rights: MediaRights;
  width: number;
  height: number;
  durationSeconds: number | null;
  /** Owner attestation captured at upload; null when unknown (website / connected-account media). */
  consent: { peopleVisibleHaveConsented: boolean | "no_people" } | null;
  analysis: null | {
    depicts: string;
    subjectKind: SubjectKind;
    matchedOfferingIds: string[];
    /** Spark's located primary subject in ORIGINAL asset pixels (inclusive box). */
    primarySubject: { label: string; box: SamBox | null } | null;
    quality: { sharpness: QualityLevel; lighting: QualityLevel; composition: QualityLevel };
    goalFit: GoalFit;
    heroWorthy: boolean;
    suitableFor: Suitability[];
    risks: Array<{ kind: RiskKind; box: SamBox | null }>;
  };
  shotLog: null | {
    heroMomentSeconds: number | null;
    peopleVisible: boolean;
    moments: Array<{ startSeconds: number; endSeconds: number; kind: MomentKind; steadiness: "steady" | "moderate" | "shaky"; subjectLabel: string | null; goalFit: GoalFit }>;
  };
  /**
   * Videos only: the same Spark risk check images get, run on frames sampled evenly across the
   * analysis clip. Absent/null means the frames were not (fully) checked, so the footage is unusable.
   */
  frameRisks?: null | { framesChecked: number; risks: Array<{ kind: RiskKind; atSeconds: number }> };
}

export type SegmentationPlan =
  | { kind: "geometry"; box: SamBox; label: string }
  | { kind: "concept"; phrase: string; label: string }
  | { kind: "none" };

export interface ScoreBreakdown { goalFit: number; quality: number; heroWorthy: number; offering: number; subject: number; provenance: number; samReady: number; risk: number }

export interface StillPick { assetId: string; segmentation: SegmentationPlan; score: number; breakdown: ScoreBreakdown; reasons: string[] }

export type ReelPlan =
  | { mode: "tracked_video"; clipAssetId: string; windowStartSeconds: number; windowSeconds: number; promptSeconds: number; subjectLabel: string; momentKind: MomentKind; fallbackStill: StillPick | null; reasons: string[] }
  | { mode: "still_depth"; still: StillPick; reasons: string[] }
  | { mode: "illustration"; reasons: string[] };

export type PlannedChannel = "instagram_feed" | "facebook_ads" | "instagram_stories" | "click_to_whatsapp" | "whatsapp_status";

export interface ProductionPlan {
  version: "autopilot-plan-1";
  hero: StillPick | null;
  /** Four carousel slots in order; real assets repeat (with different crops) only when fewer exist. */
  carousel: StillPick[];
  channelAssets: Record<PlannedChannel, string | null>;
  reel: ReelPlan;
  excluded: Array<{ assetId: string; reasons: string[] }>;
  ranking: Array<{ assetId: string; kind: "image" | "video"; score: number; breakdown: ScoreBreakdown | null }>;
  needsIllustration: boolean;
  notes: string[];
}

/** Paid-request roles inside the Autopilot production stage. */
export type AutopilotRole = "spark_copy" | "spark_media" | "spark_shotlog" | "sam_image" | "sam_video" | "muse_image" | "spark_critic";
