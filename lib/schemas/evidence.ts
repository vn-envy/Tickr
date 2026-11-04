import { z } from "zod";
import { IdSchema, OwnerApprovalSchema, SourceSchema } from "./common";

/** A proposal retains its identity even when the owner approves its use. */
export const EvidenceSchema = z.object({
  id: IdSchema,
  businessId: IdSchema,
  claim: z.string().trim().min(1),
  kind: z.enum(["fact", "signal", "inference", "proposal"]),
  support: z.enum(["supported", "owner_stated", "inferred", "conflicting", "unknown"]),
  sources: z.array(SourceSchema),
  relatedEvidenceIds: z.array(IdSchema).default([]),
  requiresOwnerApproval: z.boolean().default(false),
  ownerApproval: OwnerApprovalSchema.optional(),
}).strict().superRefine((evidence, context) => {
  if (["supported", "owner_stated"].includes(evidence.support) && evidence.sources.length === 0) {
    context.addIssue({ code: "custom", path: ["sources"], message: "Supported claims need attributable evidence" });
  }
  if (evidence.kind === "proposal" && !evidence.requiresOwnerApproval) {
    context.addIssue({ code: "custom", path: ["requiresOwnerApproval"], message: "Proposed promises require owner approval" });
  }
  if (evidence.ownerApproval?.status === "approved" && evidence.ownerApproval.claim !== evidence.claim) {
    context.addIssue({ code: "custom", path: ["ownerApproval", "claim"], message: "Approval must match this exact claim" });
  }
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** Conservative eligibility, not a certification of legal/platform compliance. */
export function canAdvertiseEvidence(input: unknown): boolean {
  const parsed = EvidenceSchema.safeParse(input);
  if (!parsed.success) return false;
  const evidence = parsed.data;
  if (evidence.kind === "inference" || evidence.kind === "signal") return false;
  if (evidence.support === "conflicting" || evidence.ownerApproval?.status === "rejected") return false;
  const approved = evidence.ownerApproval?.status === "approved";
  if (evidence.kind === "proposal") return approved;
  if (evidence.requiresOwnerApproval && !approved) return false;
  return evidence.support === "supported" || evidence.support === "owner_stated";
}

export function assertAdvertisableEvidence(input: unknown): Evidence {
  const evidence = EvidenceSchema.parse(input);
  if (!canAdvertiseEvidence(evidence)) {
    throw new Error(`Evidence ${evidence.id} is not eligible for use as an advertised claim`);
  }
  return evidence;
}
