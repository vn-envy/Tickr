import { describe, expect, it } from "vitest";
import { CampaignBlueprintSchema, EvidenceSchema, OpportunityReportSchema, assertOpportunityEvidence, canAdvertiseEvidence } from "../../lib/schemas";

const proposal = {
  id: "offer_1",
  businessId: "bakery_1",
  claim: "Coffee and pastry for ₹299",
  kind: "proposal",
  support: "inferred",
  sources: [],
  requiresOwnerApproval: true,
} as const;

function blueprint(claim: unknown) {
  return {
    id: "campaign_1", businessId: "bakery_1", opportunityId: "opportunity_1", evidenceVersion: "v1",
    name: "Afternoon break", vertical: "bakery", objective: "Test afternoon interest", audienceHypothesis: "Nearby afternoon visitors",
    coreMessage: "Take an afternoon break", primaryCta: "Ask about today's offer", channels: ["instagram_feed"],
    advertisedClaims: [claim], ownerApprovalRequired: true,
  };
}

describe("claim integrity", () => {
  it("keeps a proposed offer out of advertised claims until the owner approves its exact wording", () => {
    expect(EvidenceSchema.safeParse(proposal).success).toBe(true);
    expect(canAdvertiseEvidence(proposal)).toBe(false);
    expect(CampaignBlueprintSchema.safeParse(blueprint(proposal)).success).toBe(false);
    const approved = {
      ...proposal,
      ownerApproval: { status: "approved", approvedBy: "owner_1", approvedAt: "2026-11-01T09:00:00Z", claim: proposal.claim },
    };
    expect(canAdvertiseEvidence(approved)).toBe(true);
    expect(CampaignBlueprintSchema.safeParse(blueprint(approved)).success).toBe(true);
    expect(EvidenceSchema.parse(approved).kind).toBe("proposal");
    expect(canAdvertiseEvidence({ ...approved, claim: "Coffee and pastry for ₹199" })).toBe(false);
  });

  it("rejects unsupported facts, numerical confidence and a rejected proposal", () => {
    expect(EvidenceSchema.safeParse({ ...proposal, kind: "fact", support: "supported" }).success).toBe(false);
    expect(EvidenceSchema.safeParse({ ...proposal, confidence: 0.99 }).success).toBe(false);
    expect(canAdvertiseEvidence({ ...proposal, ownerApproval: { status: "rejected", reviewedBy: "owner", reviewedAt: "2026-11-01T09:00:00Z" } })).toBe(false);
  });

  it("permits zero opportunities with an honest explanation instead of manufacturing three", () => {
    const empty = { businessId: "bakery_1", evidenceVersion: "v1", opportunities: [], generatedAt: "2026-11-01T09:00:00Z" };
    expect(OpportunityReportSchema.safeParse(empty).success).toBe(false);
    expect(OpportunityReportSchema.safeParse({ ...empty, insufficientEvidenceReason: "No usable customer or competitor evidence supplied" }).success).toBe(true);
  });

  it("requires a hypothesis to reference attributable facts or signals for the same business", () => {
    const fact = {
      id: "fact_1", businessId: "bakery_1", claim: "Pickup is available", kind: "fact", support: "owner_stated",
      sources: [{ id: "source_1", type: "owner_statement", excerpt: "We offer pickup", retrievedAt: "2026-11-01T09:00:00Z", acquisition: "owner_supplied" }],
    };
    const report = {
      businessId: "bakery_1", evidenceVersion: "v1", generatedAt: "2026-11-01T09:00:00Z",
      opportunities: [{ id: "op_1", title: "Pickup campaign", hypothesis: "Pickup convenience could attract nearby customers", supportingEvidenceIds: ["fact_1"], rationale: "The owner offers pickup", uncertainties: ["Demand is not measured"], ownerQuestions: [], proposedCustomerAction: "Ask about pickup" }],
    };
    expect(assertOpportunityEvidence(report, [fact]).opportunities).toHaveLength(1);
    expect(() => assertOpportunityEvidence(report, [])).toThrow("unsupported evidence");
    expect(() => assertOpportunityEvidence(report, [{ ...fact, support: "unknown" }])).toThrow("unsupported evidence");
    expect(() => assertOpportunityEvidence(report, [{ ...fact, businessId: "other_business" }])).toThrow("unsupported evidence");
  });
});
