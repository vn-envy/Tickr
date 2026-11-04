import { z } from "zod";
import { ChannelSchema, VerticalSchema } from "../schemas/common";

export const ResearchModeSchema = z.enum(["live", "synthetic"]);
export type ResearchMode = z.infer<typeof ResearchModeSchema>;
export const SourceKindSchema = z.enum(["owner_statement", "customer_review", "competitor", "official_website", "business_coverage"]);
const citationUrl = z.string().url().max(2048).refine((value) => {
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
}, "Use an HTTP(S) citation without credentials.");
export const SourceInputSchema = z.object({
  kind: SourceKindSchema,
  title: z.string().trim().min(2).max(160),
  url: citationUrl.nullable(),
  text: z.string().trim().max(12000),
}).strict().refine((source) => source.text.length >= 10 || Boolean(source.url && ["competitor", "official_website"].includes(source.kind)), "Provide attributable text or an official page to read.");
export type SourceInput = z.infer<typeof SourceInputSchema>;
export const ResearchInputSchema = z.object({
  mode: ResearchModeSchema,
  sources: z.array(SourceInputSchema).max(8),
  readWebsite: z.boolean(),
  discoverFromLink: z.boolean().optional(),
  enrichFromLink: z.boolean().optional(),
  /** One-shot Autopilot: auto-select the best-supported opportunity and continue to a review-ready kit. */
  autopilot: z.boolean().optional(),
  /**
   * Digest of the business's owner media (uploads and connection) when the run was requested. It is
   * part of the run input hash only, so new uploads or a new connection start a fresh run while an
   * unchanged retry still reuses the existing one. It is never treated as evidence.
   */
  mediaRevision: z.string().regex(/^[a-f0-9]{16,64}$/).optional(),
}).strict();
export type ResearchInput = z.infer<typeof ResearchInputSchema>;

export const BusinessContextSchema = z.object({
  id: z.string(), name: z.string(), locality: z.string(), vertical: VerticalSchema,
  goal: z.string(), website: z.string().nullable(),
});
export type BusinessContext = z.infer<typeof BusinessContextSchema>;
const sourceDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
export const SourceContextSchema = z.object({
  scope: z.enum(["exact_location", "brand", "other_location", "unknown"]),
  location: z.string().max(300).nullable(),
  locationEvidence: z.string().max(1000).nullable(),
  publishedAt: sourceDate, validFrom: sourceDate, validThrough: sourceDate,
  temporalStatus: z.enum(["current", "historical", "unknown"]),
  dateEvidence: z.string().max(1000).nullable(),
}).strict();
export type SourceContext = z.infer<typeof SourceContextSchema>;
export const BranchIdentitySchema = z.object({
  status: z.enum(["matched", "candidate", "unresolved"]), label: z.string().max(200).nullable(),
  locality: z.string().max(200).nullable(), address: z.string().max(500).nullable(),
  sourceIds: z.array(z.string()).max(12), rationale: z.string().max(1500),
}).strict();
export type BranchIdentity = z.infer<typeof BranchIdentitySchema>;
export const BusinessReferenceSchema = z.object({
  inputUrl: z.string(), resolvedUrl: z.string(), nameHint: z.string().nullable(), warnings: z.array(z.string()),
  coordinatesHint: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), kind: z.enum(["place", "map_view"]) }).nullable().optional(),
  placeIdHint: z.string().nullable().optional(), featureIdHint: z.string().nullable().optional(), contextHint: z.string().nullable().optional(),
}).strict();
export const CollectedSourceSchema = z.object({
  id: z.string(), kind: SourceKindSchema, title: z.string(), url: z.string().nullable(),
  text: z.string(), retrievedAt: z.string(), acquisition: z.enum(["owner_supplied", "direct_website", "meta_search_snippet", "meta_cited_summary"]),
  citation: z.object({ responseId: z.string(), searchCallIds: z.array(z.string()).min(1), url: citationUrl, title: z.string(), method: z.enum(["provider_annotation", "model_reference", "search_snippet"]).optional() }).strict().optional(),
  context: SourceContextSchema.optional(),
}).strict();
export type CollectedSource = z.infer<typeof CollectedSourceSchema>;

export const BusinessDiscoverySchema = z.object({
  status: z.enum(["matched", "ambiguous", "unresolved"]), inputUrl: citationUrl,
  name: z.string().nullable(), locality: z.string().nullable(), vertical: VerticalSchema.nullable(),
  officialWebsite: citationUrl.nullable(), instagramUrl: citationUrl.nullable(),
  summary: z.string(), sourceIds: z.array(z.string()), warnings: z.array(z.string()), queries: z.array(z.string()),
  completedToolCalls: z.number().int().nonnegative(), discoveredAt: z.string(),
  links: z.array(z.object({ url: citationUrl, title: z.string(), relationship: z.enum(["business", "competitor", "customer", "reference"]) }).strict()),
  branch: BranchIdentitySchema.optional(), reference: BusinessReferenceSchema.optional(),
}).strict();
export type BusinessDiscovery = z.infer<typeof BusinessDiscoverySchema>;

export const BusinessEnrichmentSchema = z.object({
  status: z.enum(["enriched", "limited", "unavailable"]), businessId: z.string(),
  offerings: z.array(z.object({ id: z.string(), name: z.string().max(140), description: z.string().max(900), sourceIds: z.array(z.string()).min(1) }).strict()).max(10),
  brandSignals: z.array(z.object({ id: z.string(), kind: z.enum(["story", "positioning", "tone", "identity"]), claim: z.string().max(900), sourceIds: z.array(z.string()).min(1) }).strict()).max(10),
  sourceIds: z.array(z.string()), unknowns: z.array(z.string()), warnings: z.array(z.string()), queries: z.array(z.string()),
  completedToolCalls: z.number().int().nonnegative(), enrichedAt: z.string(),
  branch: BranchIdentitySchema.optional(),
  researchPlan: z.array(z.string().max(600)).max(10).optional(),
  insights: z.array(z.object({
    id: z.string(), kind: z.enum(["customer", "competitor", "seasonal", "content", "operations"]),
    claim: z.string().max(1000), implication: z.string().max(800), sourceIds: z.array(z.string()).min(1).max(8),
  }).strict()).max(16).optional(),
  coverage: z.array(z.object({
    area: z.enum(["identity", "offerings", "brand", "customer", "competitor", "seasonal", "content"]),
    status: z.enum(["found", "limited", "not_found"]), summary: z.string().max(800), sourceIds: z.array(z.string()).max(16),
  }).strict()).max(7).optional(),
}).strict();
export type BusinessEnrichment = z.infer<typeof BusinessEnrichmentSchema>;

export const ResearchEvidenceSchema = z.object({
  id: z.string().min(1), sourceId: z.string().min(1), quote: z.string().min(1).max(1500),
  claim: z.string().min(1).max(1000), subject: z.enum(["business", "customer", "competitor"]),
  kind: z.enum(["fact", "signal"]),
  basis: z.enum(["source_excerpt", "meta_cited_summary"]).optional(),
}).strict();
export type ResearchEvidence = z.infer<typeof ResearchEvidenceSchema>;
const dimension = z.object({ value: z.number().int().min(0).max(100).nullable(), rationale: z.string().min(1).max(600) }).strict();
export const ResearchOpportunitySchema = z.object({
  id: z.string().min(1), title: z.string().min(1).max(150), hypothesis: z.string().min(1).max(1200),
  whyNow: z.string().min(1).max(1000), evidenceIds: z.array(z.string()).min(1).max(12),
  comparison: z.string().min(1).max(1000), customerAction: z.string().min(1).max(500),
  test: z.string().min(1).max(1000), uncertainties: z.array(z.string().max(600)).max(8),
  scores: z.object({ impact: dimension, evidence: dimension, differentiation: dimension, feasibility: dimension, confidence: dimension }).strict(),
}).strict();
export type ResearchOpportunity = z.infer<typeof ResearchOpportunitySchema>;
export const ResearchReportSchema = z.object({
  summary: z.string().min(1).max(1800),
  evidence: z.array(ResearchEvidenceSchema).max(30),
  findings: z.array(z.object({ area: z.enum(["business", "customer", "competitor", "content"]), summary: z.string().min(1).max(1000), evidenceIds: z.array(z.string()).max(15), caveats: z.array(z.string().max(600)).max(6) }).strict()).max(8),
  opportunities: z.array(ResearchOpportunitySchema).max(3), recommendedOpportunityId: z.string().nullable(),
  unknowns: z.array(z.string().max(800)).max(15), ownerQuestions: z.array(z.string().max(600)).max(3),
  coverage: z.object({ sources: z.number().int(), competitorSources: z.number().int(), customerSources: z.number().int() }).strict(),
  generatedAt: z.string(), mode: ResearchModeSchema,
}).strict();
export type ResearchReport = z.infer<typeof ResearchReportSchema>;
export const ModelUsageSchema = z.object({
  model: z.string(), inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), elapsedMs: z.number(),
  imagesProcessed: z.number().int().nonnegative().nullable().optional(),
}).strict();
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const CampaignCreativeBriefSchema = z.object({
  context: z.object({
    insightIds: z.array(z.string()).max(12), whyNow: z.string().max(1000),
    seasonalTheme: z.object({ name: z.string().max(160).nullable(), status: z.enum(["none", "proposed_theme", "verified_offer"]), sourceIds: z.array(z.string()).max(12) }).strict(),
  }).strict().optional(),
  focus: z.object({ offeringId: z.string().nullable(), name: z.string().max(140), description: z.string().max(900), evidenceIds: z.array(z.string()).min(1), sourceIds: z.array(z.string()).min(1) }).strict(),
  brandStory: z.object({ signalIds: z.array(z.string()), narrative: z.string().max(1000), evidenceIds: z.array(z.string()), sourceIds: z.array(z.string()) }).strict(),
  visualDirection: z.object({ status: z.enum(["proposed", "source_informed"]), description: z.string().max(1000), palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).length(3), sourceIds: z.array(z.string()) }).strict(),
  scenes: z.array(z.object({ role: z.enum(["hook", "proof", "occasion", "action"]), headline: z.string().max(72), body: z.string().max(260) }).strict()).length(4),
}).strict();
export type CampaignCreativeBrief = z.infer<typeof CampaignCreativeBriefSchema>;

export const CampaignVisualSchema = z.object({
  kind: z.enum(["source_photo", "meta_illustration", "typography"]),
  filename: z.string().nullable(), description: z.string(), sourceIds: z.array(z.string()), sourceUrls: z.array(citationUrl),
  model: z.string().nullable(), warnings: z.array(z.string()),
  artDirection: z.object({
    composition: z.enum(["subject_layers", "image_crop"]),
    sourceSha256: z.string(), foregroundFilename: z.string().nullable(), maskFilename: z.string().nullable(), backgroundFilename: z.string().nullable(),
    background: z.enum(["palette", "meta_generated", "source"]),
    segmentation: z.object({ status: z.enum(["segmented", "no_match", "skipped", "failed"]), model: z.string().nullable(), prompt: z.string(), coverageFraction: z.number().min(0).max(1).nullable(), objectCount: z.number().int().nonnegative() }).strict(),
  }).strict().optional(),
}).strict();
export type CampaignVisual = z.infer<typeof CampaignVisualSchema>;

export const CampaignKitSchema = z.object({
  id: z.string(), name: z.string(), objective: z.string(), audienceHypothesis: z.string(), coreMessage: z.string(),
  primaryCta: z.string(), opportunityId: z.string(), evidenceIds: z.array(z.string()),
  status: z.literal("concept_needs_review"), mode: ResearchModeSchema, reviewNotes: z.array(z.string()),
  channels: z.array(z.object({ id: ChannelSchema, title: z.string(), headline: z.string(), body: z.string(), caption: z.string(), cta: z.string(), evidenceIds: z.array(z.string()) }).strict()),
  assets: z.array(z.object({ id: z.string(), channel: ChannelSchema.nullable(), filename: z.string(), mediaType: z.enum(["image", "video", "document", "archive"]), width: z.number().nullable(), height: z.number().nullable(), sha256: z.string(), bytes: z.number() }).strict()),
  createdAt: z.string(), model: z.string(),
  creativeBrief: CampaignCreativeBriefSchema.optional(), visual: CampaignVisualSchema.optional(),
}).strict();
export type CampaignKit = z.infer<typeof CampaignKitSchema>;
export interface RunEvent { stage: string; message: string; at: string }

/** How Autopilot chose the campaign opportunity; recorded with the immutable selection checkpoint. */
export const AutopilotSelectionSchema = z.object({
  opportunityId: z.string().min(1), reportHash: z.string().regex(/^[a-f0-9]{64}$/),
  selectedBy: z.literal("autopilot"), basis: z.enum(["report_recommendation", "highest_complete_score", "first_supported"]),
  score: z.number().int().min(0).max(100).nullable(), rationale: z.string().max(600),
}).strict();
export type AutopilotSelection = z.infer<typeof AutopilotSelectionSchema>;

/** The owner's single final approval, bound to the exact exported bytes. Publication remains a separate step. */
export const CampaignApprovalSchema = z.object({
  version: z.literal(1), campaignId: z.string().min(1), approvedAt: z.string().datetime(),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.object({ filename: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() }).strict()).min(1).max(200),
  withheldFiles: z.array(z.string()).max(200),
  statement: z.string().max(600),
  scope: z.literal("owner_approved_concept_not_published"),
}).strict();
export type CampaignApproval = z.infer<typeof CampaignApprovalSchema>;

export interface RunView {
  id: string; businessId: string; stage: string; status: string; createdAt: string; updatedAt: string;
  mode: ResearchMode; error: string | null; business: BusinessContext;
  sources: CollectedSource[]; report: ResearchReport | null; campaign: CampaignKit | null;
  discovery?: BusinessDiscovery | null;
  enrichment?: BusinessEnrichment | null;
  /** True when this run was started in one-shot Autopilot mode. */
  autopilot?: boolean;
  selection?: AutopilotSelection | { opportunityId: string; selectedBy: "owner" } | null;
  approval?: CampaignApproval | null;
  /** Autopilot production quality record (critic verdict, withheld files, plan summary). */
  quality?: import("../autopilot/production-types").AutopilotQuality | null;
  /** Digest of the current approvable files; the owner's approval must echo it. */
  approvalDigest?: string | null;
  events: RunEvent[]; usage: ModelUsage[];
}

export function opportunityScore(opportunity: ResearchOpportunity): number | null {
  const { impact, evidence, differentiation, feasibility, confidence } = opportunity.scores;
  if ([impact, evidence, differentiation, feasibility, confidence].some((item) => item.value === null)) return null;
  return Math.round(impact.value! * .30 + evidence.value! * .25 + differentiation.value! * .20 + feasibility.value! * .15 + confidence.value! * .10);
}
