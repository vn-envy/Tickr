import { z } from "zod";
import { ChannelSchema, IdSchema, Sha256Schema, TimestampSchema, VerticalSchema } from "./common";
import { EvidenceSchema, canAdvertiseEvidence } from "./evidence";

export const BusinessProfileSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1),
  vertical: VerticalSchema,
  locality: z.string().trim().min(1),
  websiteUrl: z.string().url().optional(),
  ownerGoal: z.string().trim().min(1),
  evidence: z.array(EvidenceSchema),
  unknowns: z.array(z.string().trim().min(1)),
  updatedAt: TimestampSchema,
}).strict().superRefine((profile, context) => {
  const ids = new Set<string>();
  profile.evidence.forEach((item, index) => {
    if (item.businessId !== profile.id || ids.has(item.id)) {
      context.addIssue({ code: "custom", path: ["evidence", index], message: "Evidence must belong to this business and have a unique ID" });
    }
    ids.add(item.id);
  });
});
export type BusinessProfile = z.infer<typeof BusinessProfileSchema>;

export const OpportunitySchema = z.object({
  id: IdSchema,
  title: z.string().trim().min(1),
  hypothesis: z.string().trim().min(1),
  supportingEvidenceIds: z.array(IdSchema).min(1),
  rationale: z.string().trim().min(1),
  uncertainties: z.array(z.string().trim().min(1)),
  ownerQuestions: z.array(z.string().trim().min(1)).max(3),
  proposedCustomerAction: z.string().trim().min(1),
}).strict();
export type Opportunity = z.infer<typeof OpportunitySchema>;

export const OpportunityReportSchema = z.object({
  businessId: IdSchema,
  evidenceVersion: IdSchema,
  opportunities: z.array(OpportunitySchema).max(3),
  recommendedOpportunityId: IdSchema.optional(),
  insufficientEvidenceReason: z.string().trim().min(1).optional(),
  generatedAt: TimestampSchema,
}).strict().superRefine((report, context) => {
  const ids = report.opportunities.map((opportunity) => opportunity.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["opportunities"], message: "Opportunity IDs must be unique" });
  }
  if (report.opportunities.length === 0 && !report.insufficientEvidenceReason) {
    context.addIssue({ code: "custom", path: ["insufficientEvidenceReason"], message: "Explain why no supported hypotheses could be produced" });
  }
  if (report.recommendedOpportunityId && !ids.includes(report.recommendedOpportunityId)) {
    context.addIssue({ code: "custom", path: ["recommendedOpportunityId"], message: "Recommendation must reference an opportunity in this report" });
  }
});
export type OpportunityReport = z.infer<typeof OpportunityReportSchema>;

/** Validate references against the ledger; IDs alone are not supporting evidence. */
export function assertOpportunityEvidence(report: unknown, ledger: readonly unknown[]): OpportunityReport {
  const parsed = OpportunityReportSchema.parse(report);
  const entries = ledger.map((entry) => EvidenceSchema.parse(entry));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length) throw new Error("Evidence IDs must be unique");
  for (const opportunity of parsed.opportunities) {
    for (const id of opportunity.supportingEvidenceIds) {
      const evidence = byId.get(id);
      if (!evidence || evidence.businessId !== parsed.businessId
        || !["supported", "owner_stated"].includes(evidence.support)
        || !["fact", "signal"].includes(evidence.kind)) {
        throw new Error(`Opportunity ${opportunity.id} references unsupported evidence ${id}`);
      }
    }
  }
  return parsed;
}

export const CampaignBlueprintSchema = z.object({
  id: IdSchema,
  businessId: IdSchema,
  opportunityId: IdSchema,
  evidenceVersion: IdSchema,
  name: z.string().trim().min(1),
  vertical: VerticalSchema,
  objective: z.string().trim().min(1),
  audienceHypothesis: z.string().trim().min(1),
  coreMessage: z.string().trim().min(1),
  primaryCta: z.string().trim().min(1),
  channels: z.array(ChannelSchema).min(1).refine((channels) => new Set(channels).size === channels.length, "Channels must be unique"),
  advertisedClaims: z.array(EvidenceSchema),
  ownerApprovalRequired: z.boolean(),
  publicationStatus: z.literal("not_published").default("not_published"),
}).strict().superRefine((blueprint, context) => {
  blueprint.advertisedClaims.forEach((evidence, index) => {
    if (evidence.businessId !== blueprint.businessId || !canAdvertiseEvidence(evidence)) {
      context.addIssue({ code: "custom", path: ["advertisedClaims", index], message: "Advertised claims must be eligible and belong to this business" });
    }
  });
});
export type CampaignBlueprint = z.infer<typeof CampaignBlueprintSchema>;

export const CreativeAssetSchema = z.object({
  id: IdSchema,
  channel: ChannelSchema,
  mediaType: z.enum(["image", "video"]),
  localPath: z.string().trim().min(1).refine((path) => !/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.startsWith("//"), "Use a local asset path, not a remote URL"),
  assetHash: Sha256Schema,
  copyHash: Sha256Schema,
  motionSpecHash: Sha256Schema.optional(),
  sourceAssetIds: z.array(IdSchema).min(1),
  generatedComponents: z.array(z.string().trim().min(1)),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict().superRefine((asset, context) => {
  if (asset.mediaType === "video" && !asset.motionSpecHash) {
    context.addIssue({ code: "custom", path: ["motionSpecHash"], message: "Video approval must bind to the motion specification" });
  }
});
export type CreativeAsset = z.infer<typeof CreativeAssetSchema>;

export const CreativeManifestSchema = z.object({
  campaignId: IdSchema,
  businessId: IdSchema,
  evidenceVersion: IdSchema,
  assets: z.array(CreativeAssetSchema),
  createdAt: TimestampSchema,
}).strict().refine((manifest) => new Set(manifest.assets.map((asset) => asset.id)).size === manifest.assets.length, "Asset IDs must be unique");
export type CreativeManifest = z.infer<typeof CreativeManifestSchema>;

export const QualityReportSchema = z.object({
  assetId: IdSchema,
  assetHash: Sha256Schema,
  copyHash: Sha256Schema,
  motionSpecHash: Sha256Schema.optional(),
  evidenceVersion: IdSchema,
  ruleVersion: IdSchema,
  checkedAt: TimestampSchema,
  verdict: z.enum(["pass", "fail", "needs_owner"]),
  checks: z.array(z.object({
    ruleId: IdSchema,
    status: z.enum(["pass", "fail", "needs_owner"]),
    reason: z.string().trim().min(1),
  }).strict()).min(1),
}).strict().superRefine((report, context) => {
  if (report.verdict === "pass" && report.checks.some((check) => check.status !== "pass")) {
    context.addIssue({ code: "custom", path: ["verdict"], message: "A passing report cannot contain unresolved checks" });
  }
});
export type QualityReport = z.infer<typeof QualityReportSchema>;

export function isQualityReportCurrent(
  asset: CreativeAsset,
  report: QualityReport,
  context: { evidenceVersion: string; ruleVersion: string },
): boolean {
  return asset.id === report.assetId
    && asset.assetHash === report.assetHash
    && asset.copyHash === report.copyHash
    && asset.motionSpecHash === report.motionSpecHash
    && context.evidenceVersion === report.evidenceVersion
    && context.ruleVersion === report.ruleVersion;
}

export function canExportCreative(asset: unknown, report: unknown, context: { evidenceVersion: string; ruleVersion: string }): boolean {
  const parsedAsset = CreativeAssetSchema.safeParse(asset);
  const parsedReport = QualityReportSchema.safeParse(report);
  return parsedAsset.success && parsedReport.success
    && parsedReport.data.verdict === "pass"
    && isQualityReportCurrent(parsedAsset.data, parsedReport.data, context);
}
