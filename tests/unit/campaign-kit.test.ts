import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import sharp from "sharp";
import { buildZip, hashBytes, safeOutputPath, writeVerifiedArchive } from "../../lib/campaign/archive";
import { businessQuantityText, campaignCopyInstructions, cleanChannelTitle, cleanConsumerCopy, eligibleBusinessEvidence, generateCampaignCopy, selectCampaignEnrichment, validateCampaignCopy, validateCompletedCampaignCopy, type CampaignCopy } from "../../lib/campaign/copy";
import { readCompletedCopyRecord, writeCompletedCopyRecord, type CompletedCopyResponse } from "../../lib/campaign/completed-response";
import { campaignSvg, normalizeCampaignForeground, normalizeCampaignImage, renderCampaignFrame, type RenderInput } from "../../lib/campaign/render";
import { assertCampaignInput, campaignInputHash, CampaignCopyValidationError, createCampaign, hasBoundCompletedCopy, readCopyCheckpoint, type CreateCampaignInput } from "../../lib/campaign";
import { ChannelSchema } from "../../lib/schemas/common";
import type { BusinessEnrichment, CollectedSource, ResearchOpportunity, ResearchReport } from "../../lib/research/contracts";

const score = { value: null, rationale: "Not measured in this fixture." };
const opportunity: ResearchOpportunity = {
  id: "op-1", title: "Introduce the weekend loaf", hypothesis: "Customers may value knowing the bake schedule.", whyNow: "A specific owner-stated product is available.", evidenceIds: ["fact-1", "competitor-1"], comparison: "Insufficient market coverage.", customerAction: "Ask about the loaf", test: "Count qualified inquiries.", uncertainties: ["Demand is unmeasured."],
  scores: { impact: score, evidence: score, differentiation: score, feasibility: score, confidence: score },
};
const report: ResearchReport = {
  summary: "Synthetic test only.", evidence: [
    { id: "fact-1", sourceId: "s1", claim: "The bakery makes a weekend loaf.", quote: "We make a weekend loaf.", subject: "business", kind: "fact" },
    { id: "competitor-1", sourceId: "s2", claim: "Another bakery delivers.", quote: "We deliver.", subject: "competitor", kind: "fact" },
  ], findings: [], opportunities: [opportunity], recommendedOpportunityId: "op-1", unknowns: [], ownerQuestions: [], coverage: { sources: 2, competitorSources: 1, customerSources: 0 }, generatedAt: "2026-11-01T00:00:00Z", mode: "synthetic",
};
function draft(): CampaignCopy {
  return {
    name: "Weekend loaf", objective: "Invite inquiries.", audienceHypothesis: "People interested in local baking.", coreMessage: "Meet the weekend loaf.", primaryCta: "Ask about the loaf", evidenceIds: ["fact-1"], reviewNotes: ["Confirm product availability."],
    channels: ChannelSchema.options.map((id) => ({ id, title: id, headline: "A loaf for the weekend", body: "Meet our weekend loaf.", caption: "Ask us about the weekend loaf.", cta: "Ask about the loaf", evidenceIds: ["fact-1"] })),
    conversation: { opener: "I would like to know about the loaf.", commonReplies: Array.from({ length: 3 }, () => ({ question: "Is it available?", answer: "The team can confirm availability." })), qualificationQuestion: "What would you like to know?", nextAction: "Ask the team to confirm details." },
  };
}

const productSource: CollectedSource = { id: "s1", kind: "owner_statement", title: "Owner product note", url: null, text: "We make a weekend loaf.", retrievedAt: "2026-11-02T00:00:00Z", acquisition: "owner_supplied" };
const enrichment: BusinessEnrichment = { status: "enriched", businessId: "b1", offerings: [{ id: "offering-1", name: "Weekend loaf", description: "A loaf offered by the bakery.", sourceIds: ["s1"] }], brandSignals: [], sourceIds: ["s1"], unknowns: [], warnings: [], queries: [], completedToolCalls: 0, enrichedAt: "2026-11-02T00:00:00Z" };
function productDraft(): CampaignCopy {
  return { ...draft(), creativeBrief: { focus: { offeringId: "offering-1", name: "Weekend loaf", description: "A loaf from the bakery.", evidenceIds: ["fact-1"], sourceIds: ["s1"] }, brandStory: { signalIds: [], narrative: "", evidenceIds: [], sourceIds: [] }, visualDirection: { status: "proposed", description: "Warm cream and forest ink, with an illustrative focus on the named loaf.", palette: ["#F6EEDD", "#263A30", "#BB4D2F"], sourceIds: [] }, scenes: ["hook", "proof", "occasion", "action"].map((role) => ({ role: role as "hook" | "proof" | "occasion" | "action", headline: "Meet the weekend loaf", body: "Ask the team about the weekend loaf." })) } };
}

describe("campaign concepts retain provenance and review boundaries", () => {
  test("historical and other-branch sources cannot authorize a focus while brand descriptions remain usable", () => {
    const context: NonNullable<CollectedSource["context"]> = { scope: "brand", location: null, locationEvidence: null, publishedAt: null, validFrom: null, validThrough: null, temporalStatus: "unknown", dateEvidence: null };
    expect(eligibleBusinessEvidence(report, opportunity, [{ ...productSource, context }])).toHaveLength(1);
    for (const change of [{ scope: "other_location" as const }, { temporalStatus: "historical" as const }, { validThrough: "2020-01-01" }, { validFrom: "2099-01-01" }]) {
      const source = { ...productSource, context: { ...context, ...change } };
      expect(eligibleBusinessEvidence(report, opportunity, [source])).toEqual([]);
      expect(selectCampaignEnrichment(enrichment, report, opportunity, [source])?.offerings).toEqual([]);
    }
    const candidate: BusinessEnrichment = { ...enrichment, branch: { status: "candidate", label: "Fixture branch", locality: "Fixture", address: null, sourceIds: ["s1"], rationale: "Likely match from a reported description." } };
    expect(validateCampaignCopy(productDraft(), report, opportunity, [{ ...productSource, context }], candidate).reviewNotes.join(" ")).toContain("not confirmed");
    const localPromise = productDraft(); localPromise.channels[0].caption = "Visit us for the weekend loaf.";
    expect(() => validateCampaignCopy(localPromise, report, opportunity, [{ ...productSource, context }], candidate)).toThrow("unresolved branch");
    localPromise.channels[0].caption = "The weekend loaf is available today.";
    expect(() => validateCampaignCopy(localPromise, report, opportunity, [{ ...productSource, context }], candidate)).toThrow("dated, original evidence");
    localPromise.channels[0].caption = "Ask if the weekend loaf is available today.";
    expect(() => validateCampaignCopy(localPromise, report, opportunity, [{ ...productSource, context }], candidate)).not.toThrow();
    localPromise.channels[0].caption = "Ask the team what is currently available for your gathering, including the weekend loaf.";
    localPromise.conversation.commonReplies[0].question = "Is the weekend loaf available for Diwali?";
    expect(() => validateCampaignCopy(localPromise, report, opportunity, [{ ...productSource, context }], candidate)).not.toThrow();
    localPromise.channels[0].caption = "The weekend loaf is available for Diwali. Ask the team what else is available.";
    expect(() => validateCampaignCopy(localPromise, report, opportunity, [{ ...productSource, context }], candidate)).toThrow("dated, original evidence");
  });

  test("customer inquiries about availability are questions, not availability claims", () => {
    const context: NonNullable<CollectedSource["context"]> = { scope: "brand", location: null, locationEvidence: null, publishedAt: null, validFrom: null, validThrough: null, temporalStatus: "unknown", dateEvidence: null };
    const sources = [{ ...productSource, context }];
    const candidate: BusinessEnrichment = { ...enrichment, branch: { status: "candidate", label: "Fixture branch", locality: "Fixture", address: null, sourceIds: ["s1"], rationale: "Likely match from a reported description." } };
    const ctwa = (copy: CampaignCopy) => copy.channels.find((channel) => channel.id === "click_to_whatsapp")!;
    // The hosted live run's click-to-WhatsApp prefilled message shape.
    for (const opener of ["Could you share what is available this weekend…?", "Hi! Could you share what is available this weekend at the Fixture branch?", "Hello team, could you share what's available this weekend? 🎂", "Hi there — may I know which treats are available this weekend?", "What's available this weekend?", "I'd like to know what is available this weekend for a birthday?"]) {
      const copy = productDraft(); copy.conversation.opener = opener;
      expect(() => validateCampaignCopy(copy, report, opportunity, sources, candidate), opener).not.toThrow();
    }
    const replies = productDraft(); replies.conversation.commonReplies[0].question = "Which cakes are available this weekend?";
    expect(() => validateCampaignCopy(replies, report, opportunity, sources, candidate)).not.toThrow();
    const customerYesNo = productDraft(); customerYesNo.conversation.opener = "Hi! Can you deliver the weekend loaf today? Is it available this weekend?";
    expect(() => validateCampaignCopy(customerYesNo, report, opportunity, sources, candidate)).not.toThrow();
    // A business question that asks about the customer, not the offer, carries no claim.
    const ad = productDraft(); ctwa(ad).caption = "Planning a weekend treat? Could you tell us what you're celebrating?";
    expect(() => validateCampaignCopy(ad, report, opportunity, sources, candidate)).not.toThrow();
    // Business-voice assertions, rhetorical questions and an assertion after an inquiry stay availability claims.
    for (const caption of ["Available this weekend!", "The weekend loaf: now available.", "Weekend loaf in stock today.", "Could you resist a weekend loaf available today?", "Would you like the weekend loaf, available this weekend?", "What's better than a weekend loaf available this weekend?", "Could you share what is available this weekend? The weekend loaf is in stock today.", "Check out what's available today!"]) {
      const copy = productDraft(); ctwa(copy).caption = caption;
      expect(() => validateCampaignCopy(copy, report, opportunity, sources, candidate), caption).toThrow("dated, original evidence");
    }
    // Polite or yes/no questions in business copy still assert an offer or availability (ordinary ad phrasings), in every business field.
    const businessQuestions = ["Could you use a free delivery today?", "May I suggest our new weekend loaf, now available?", "Could I tempt you with our special offer this weekend?", "Share the joy with free delivery today?", "Could you share what is available this weekend…?", "Do you want free delivery today?", "Are bookings open today? Yes, message us.", "Can you believe the weekend loaf is available today?"];
    for (const question of businessQuestions) {
      const caption = productDraft(); ctwa(caption).caption = question;
      expect(() => validateCampaignCopy(caption, report, opportunity, sources, candidate), `caption: ${question}`).toThrow("dated, original evidence");
      const headline = productDraft(); headline.channels[0].headline = question;
      expect(() => validateCampaignCopy(headline, report, opportunity, sources, candidate), `headline: ${question}`).toThrow("dated, original evidence");
      const core = productDraft(); core.coreMessage = question;
      expect(() => validateCampaignCopy(core, report, opportunity, sources, candidate), `coreMessage: ${question}`).toThrow("dated, original evidence");
      const qualification = productDraft(); qualification.conversation.qualificationQuestion = question;
      expect(() => validateCampaignCopy(qualification, report, opportunity, sources, candidate), `qualificationQuestion: ${question}`).toThrow("dated, original evidence");
    }
    for (const opener of ["Hi! The weekend loaf is available this weekend.", "Could you share what is available? The weekend loaf is in stock today.", "Could you believe the weekend loaf is available today?", "Can you believe the weekend loaf is available today?", "Could I tempt you with our special offer this weekend?"]) {
      const copy = productDraft(); copy.conversation.opener = opener;
      expect(() => validateCampaignCopy(copy, report, opportunity, sources, candidate), opener).toThrow("dated, original evidence");
    }
    // Plain questions are only inquiries when the customer sends them.
    const answer = productDraft(); answer.conversation.commonReplies[0].answer = "What's available this weekend? The weekend loaf, available this weekend.";
    expect(() => validateCampaignCopy(answer, report, opportunity, sources, candidate)).toThrow("dated, original evidence");
  });

  test("seasonal proposals use selected insights without claiming a current branch offer", () => {
    const scoped = { ...productSource, context: { scope: "brand" as const, location: null, locationEvidence: null, publishedAt: null, validFrom: null, validThrough: null, temporalStatus: "unknown" as const, dateEvidence: null } };
    const enriched: BusinessEnrichment = { ...enrichment, insights: [{ id: "insight-1", kind: "content", claim: "The product description can explain the offering.", implication: "Introduce its named product.", sourceIds: ["s1"] }] };
    const copy = productDraft();
    copy.creativeBrief!.context = { insightIds: ["insight-1"], whyNow: "Use the selected product-description gap to invite seasonal inquiries.", seasonalTheme: { name: "Diwali", status: "proposed_theme", sourceIds: [] } };
    copy.creativeBrief!.scenes[2] = { role: "occasion", headline: "A Diwali gathering", body: "Ask about the weekend loaf for your gathering." };
    expect(validateCompletedCampaignCopy(copy, report, opportunity, [scoped], enriched).reviewNotes.join(" ")).toContain("proposed creative occasion");
    const unsupportedInsight = structuredClone(copy); unsupportedInsight.creativeBrief!.context!.insightIds = ["unknown-insight"];
    expect(() => validateCampaignCopy(unsupportedInsight, report, opportunity, [scoped], enriched)).toThrow("outside the selected research");
    copy.creativeBrief!.context!.seasonalTheme = { name: "Diwali offer", status: "verified_offer", sourceIds: ["s1"] };
    expect(() => validateCampaignCopy(copy, report, opportunity, [scoped], enriched)).toThrow("current original evidence");
    const today = new Date().toISOString().slice(0, 10);
    const offerText = `We make a weekend loaf. Diwali offer: 5% off. Fixture branch. Valid ${today}.`;
    const current = { ...scoped, text: offerText, context: { ...scoped.context, scope: "exact_location" as const, location: "Fixture", locationEvidence: "Fixture branch", temporalStatus: "current" as const, validFrom: today, validThrough: today, dateEvidence: `Valid ${today}.` } };
    const currentReport = structuredClone(report); currentReport.evidence[0].quote = offerText;
    copy.channels[0].caption = "Weekend loaf: our Diwali offer is 5% off.";
    expect(() => validateCampaignCopy(copy, currentReport, opportunity, [current], enriched)).not.toThrow();
    expect(() => validateCompletedCampaignCopy(productDraft(), report, opportunity, [productSource], enrichment)).toThrow();
    expect(() => validateCampaignCopy(productDraft(), report, opportunity, [productSource], enrichment)).not.toThrow();
  });

  test("named services and arbitrary business categories use the same grounded creative path", () => {
    const serviceCopy = JSON.parse(JSON.stringify(productDraft()).replaceAll("Weekend loaf", "Design consultation").replaceAll("weekend loaf", "design consultation")) as CampaignCopy;
    const serviceEnrichment = { ...enrichment, offerings: [{ ...enrichment.offerings[0], name: "Design consultation" }] };
    const serviceSource = { ...productSource, text: "We provide a design consultation." };
    const serviceReport = structuredClone(report); serviceReport.evidence[0].quote = serviceSource.text;
    expect(validateCampaignCopy(serviceCopy, serviceReport, opportunity, [serviceSource], serviceEnrichment).creativeBrief!.focus.name).toBe("Design consultation");
    const svg = campaignSvg({ businessName: "Fixture design studio", campaignName: "Discuss your next space", mode: "synthetic", vertical: "interior design consulting" }, { width: 1080, height: 1350, headline: "Design consultation", body: "Tell us about your space.", cta: "Ask the team", kicker: "Design", variant: 0 });
    expect(svg).toContain("#F5F2EC");
    expect(svg).not.toContain("undefined");
    expect(campaignSvg({ businessName: "Fixture", campaignName: "An arbitrary category", mode: "synthetic", vertical: "constructor" }, { width: 1080, height: 1350, headline: "A source-backed service", body: "Ask the team.", cta: "Ask us", kicker: "Service", variant: 0 })).not.toContain("undefined");
  });

  test("citation-bound reported business signals support descriptive concepts without becoming facts", () => {
    const reported = structuredClone(report);
    reported.evidence[0].kind = "signal";
    reported.evidence[0].basis = "meta_cited_summary";
    const source: CollectedSource = { ...productSource, kind: "business_coverage", acquisition: "meta_cited_summary", url: "https://bakery.example/story", citation: { responseId: "response-1", searchCallIds: ["search-1"], url: "https://bakery.example/story", title: "Reported bakery story", method: "model_reference" } };
    const input: CreateCampaignInput = { business: { id: "b1", name: "Fixture bakery", locality: "Fixture", vertical: "bakery", goal: "Test reported evidence", website: null }, report: reported, opportunityId: opportunity.id, sources: [source], mode: "synthetic", outputDir: "/tmp", enrichment };
    expect(() => assertCampaignInput(input)).not.toThrow();
    expect(eligibleBusinessEvidence(reported, opportunity, [source]).map((item) => item.id)).toEqual(["fact-1"]);
    expect(selectCampaignEnrichment(enrichment, reported, opportunity, [source])?.offerings).toHaveLength(1);
    expect(validateCampaignCopy(productDraft(), reported, opportunity, [source], enrichment).reviewNotes[0]).toContain("reported descriptions");
    expect(reported.evidence[0].kind).toBe("signal");
    const numbered = productDraft();
    numbered.channels[0].caption = "A 3-part story introduction for the weekend loaf. 1: The welcome. 2: Reported family inspiration. 3: An invitation to inquire. Concept preview — message to inquire.";
    expect(validateCampaignCopy(numbered, reported, opportunity, [source], enrichment).channels[0].caption).toContain("3-part story");
    for (const delimiter of [")", ".", ":"]) {
      const sequence = productDraft();
      sequence.channels[0].caption = `Swipe through the story: 1${delimiter} weekend loaf 2${delimiter} reported family inspiration 3${delimiter} an invitation 4${delimiter} ask the team. Concept visuals.`;
      expect(validateCampaignCopy(sequence, reported, opportunity, [source], enrichment).channels[0].caption).not.toContain("Concept visuals");
    }
    const date = productDraft(); date.channels[0].caption = "Our weekend loaf story began on 1. January.";
    expect(() => validateCampaignCopy(date, reported, opportunity, [source], enrichment)).toThrow("quantitative promises");
    const stock = productDraft(); stock.channels[0].caption = "Our weekend loaf story. Only 3 loaves remain.";
    expect(() => validateCampaignCopy(stock, reported, opportunity, [source], enrichment)).toThrow("quantitative promises");
    const numerical = productDraft(); numerical.channels[0].headline = "Weekend loaf since 1954";
    expect(() => validateCampaignCopy(numerical, reported, opportunity, [source], enrichment)).toThrow("quantitative promises");
    const medical = productDraft(); medical.channels[0].headline = "Weekend loaf treats diabetes";
    expect(() => validateCampaignCopy(medical, reported, opportunity, [source], enrichment)).toThrow("medical claims");
    for (const invalid of [
      { ...source, citation: undefined },
      { ...source, citation: { ...source.citation!, url: "https://another.example/story" } },
      { ...source, kind: "competitor" as const },
      { ...source, kind: "customer_review" as const },
      { ...source, kind: "owner_statement" as const },
      { ...source, text: "A different, unrelated statement." },
    ]) expect(() => assertCampaignInput({ ...input, sources: [invalid] })).toThrow("source-attributed business evidence");
  });

  test("the model sees only enrichment records tied to selected business evidence IDs", () => {
    const enriched: BusinessEnrichment = { ...enrichment, offerings: [...enrichment.offerings, { id: "offering-other", name: "Unselected product", description: "From another record.", sourceIds: ["s-other"] }], brandSignals: [{ id: "story-selected", kind: "story", claim: "The selected story.", sourceIds: ["s1", "s-other"] }, { id: "story-other", kind: "story", claim: "A separate story record.", sourceIds: ["s-other"] }], sourceIds: ["s1", "s-other"] };
    const selected = selectCampaignEnrichment(enriched, report, opportunity, [productSource, { ...productSource, id: "s-other" }]);
    expect(selected?.offerings.map((offering) => offering.id)).toEqual(["offering-1"]);
    expect(selected?.brandSignals).toEqual([{ id: "story-selected", kind: "story", claim: "The selected story.", sourceIds: ["s1"] }]);
    expect(selected?.sourceIds).toEqual(["s1"]);
  });

  test("the creative brief binds a named offering to selected source evidence", () => {
    const copy = productDraft();
    expect(validateCampaignCopy(copy, report, opportunity, [productSource], enrichment).creativeBrief?.focus.name).toBe("Weekend loaf");
    const invented = productDraft();
    invented.creativeBrief!.focus.name = "Chocolate celebration cake";
    expect(() => validateCampaignCopy(invented, report, opportunity, [productSource], enrichment)).toThrow("does not match");
    const unrelated = productDraft();
    unrelated.creativeBrief!.focus.sourceIds = ["s2"];
    expect(() => validateCampaignCopy(unrelated, report, opportunity, [productSource], enrichment)).toThrow("unrelated business source");
    const generic = productDraft();
    generic.channels[0].body = "Discover our passion for quality.";
    generic.channels[0].caption = "A reason to choose us.";
    expect(() => validateCampaignCopy(generic, report, opportunity, [productSource], enrichment)).toThrow("name the actual focus");
  });

  test("editorial frame counts allow occasion names without hiding stock, dates or prices", () => {
    expect(businessQuantityText("A 4-frame Diwali story")).not.toMatch(/\b4\b/);
    expect(businessQuantityText("A 4-frame wooden window")).toContain("4");
    expect(businessQuantityText("A 4-frame Diwali story. Only 20 portions on 8 November 2026 at ₹500.")).toContain("20 portions on 8 November 2026 at ₹500");
  });

  test("slash-numbered carousel slides are editorial structure, not unsupported quantities", () => {
    const reported = structuredClone(report);
    reported.evidence[0].kind = "signal";
    reported.evidence[0].basis = "meta_cited_summary";
    const source: CollectedSource = { ...productSource, kind: "business_coverage", acquisition: "meta_cited_summary", url: "https://bakery.example/story", citation: { responseId: "response-1", searchCallIds: ["search-1"], url: "https://bakery.example/story", title: "Reported bakery story", method: "model_reference" } };
    const carouselIndex = productDraft().channels.findIndex((channel) => channel.id === "instagram_carousel");
    // The live caption shape (synthetic text): "1/ … 2/ … 3/ …" with no story/carousel/slide keyword.
    const liveShape = "Weekend loaf, three ways 🍞 1/ The weekend loaf, fresh from the oven. 2/ Shared at the table with family. 3/ Ask the team about the weekend loaf.";
    const carousel = productDraft(); carousel.channels[carouselIndex].caption = liveShape;
    expect(validateCampaignCopy(carousel, reported, opportunity, [source], enrichment).channels[carouselIndex].caption).toBe(liveShape);
    expect(businessQuantityText(liveShape, { channel: "instagram_carousel" })).not.toMatch(/\d/);
    // A strict 1..n list of item-start markers in any channel is numbering, whatever the marker style.
    for (const delimiter of ["/", ")", ".", ":"]) {
      const listed = productDraft();
      listed.channels[0].caption = `Weekend loaf:\n1${delimiter} Fresh from the oven.\n2${delimiter} Shared at the table.\n3${delimiter} Ask the team.`;
      expect(() => validateCampaignCopy(listed, reported, opportunity, [source], enrichment)).not.toThrow();
      const sliding = productDraft();
      sliding.channels[carouselIndex].caption = `Weekend loaf 1${delimiter} fresh from the oven 2${delimiter} shared at the table 3${delimiter} ask the team.`;
      expect(() => validateCampaignCopy(sliding, reported, opportunity, [source], enrichment)).not.toThrow();
    }
    const twoSlides = productDraft(); twoSlides.channels[carouselIndex].caption = "1/ The weekend loaf. 2/ Ask the team.";
    expect(() => validateCampaignCopy(twoSlides, reported, opportunity, [source], enrichment)).not.toThrow();
    // Real quantities, dates and prices inside numbered items are still detected.
    for (const unsafe of [
      "1/ The weekend loaf. 2/ Only 20 loaves each Saturday. 3/ Ask the team.",
      "1/ The weekend loaf. 2/ Baked since 1954. 3/ Ask the team.",
      "1/ The weekend loaf. 2/ Ready in 2 hours. 3/ Ask the team.",
      "1/ The weekend loaf. 2/ Order by 8 November. 3/ Ask the team.",
      "1/ The weekend loaf. 3/ Ask the team.",
      "Weekend loaf: Buy 1. Get 2. Ask the team.",
    ]) {
      const copy = productDraft(); copy.channels[carouselIndex].caption = unsafe;
      expect(() => validateCampaignCopy(copy, reported, opportunity, [source], enrichment)).toThrow("quantitative promises");
    }
    for (const unsafe of ["Weekend loaf: Buy 1. Get 2. Pay 3. Ask the team.", "Weekend loaf 1/ fresh 2/ shared 3/ ask the team.", "Weekend loaf.\n1/ Fresh.\n2/ Shared."]) {
      const copy = productDraft(); copy.channels[0].caption = unsafe;
      expect(() => validateCampaignCopy(copy, reported, opportunity, [source], enrichment)).toThrow("quantitative promises");
    }
    const price = productDraft(); price.channels[carouselIndex].caption = "1/ The weekend loaf. 2/ Just ₹250. 3/ Ask the team.";
    expect(() => validateCampaignCopy(price, reported, opportunity, [source], enrichment)).toThrow("unsupported price");
    // Outside a slide context, two markers or mixed marker styles are not proof of a list.
    expect(businessQuantityText("Buy 1. Get 2. free")).toContain("1");
    expect(businessQuantityText("Weekend loaf 1/ fresh 2) shared 3. ask")).toContain("1");
    // Fractions and 24/7 hours are not markers.
    expect(businessQuantityText("Mix 1/2 cup. Open 24/7.", { channel: "instagram_carousel" })).toBe("Mix 1/2 cup. Open 24/7.");
  });

  test("run-in single-word '.' sequences stay quantities even in slide channels and keyword copy", () => {
    // A strict 1,2,3 run of word-attached "." markers around single words is an offer, not slide numbering.
    expect(businessQuantityText("Buy 1. Get 2. Pay 3. today", { channel: "instagram_carousel" })).toMatch(/\b1\b.*\b2\b.*\b3\b/);
    expect(businessQuantityText("Our story: Buy 1. Get 2. free")).toMatch(/\b1\b.*\b2\b/);
    expect(businessQuantityText("Weekend story: Buy 1. Get 2. Pay 3: today", { channel: "instagram_stories" })).toMatch(/\b1\b.*\b2\b.*\b3\b/);
    // Real slide shapes still lose only their markers.
    expect(businessQuantityText("1. Sourdough 2. Rye 3. Brioche", { channel: "instagram_carousel" })).not.toMatch(/\d/);
    expect(businessQuantityText("Three ways 1) fresh 2) shared", { channel: "instagram_reels" })).not.toMatch(/\d/);
    expect(businessQuantityText("Weekend loaf 1. fresh from the oven 2. shared at the table", { channel: "whatsapp_status" })).not.toMatch(/\d/);
    // A line break before a marker starts a list item even after a word, in any channel.
    expect(businessQuantityText("Our loaves\n1. Sourdough\n2. Rye\n3. Brioche")).not.toMatch(/\d/);
    expect(businessQuantityText("Our loaves\n1. Sourdough\n2. Only 20 left\n3. Brioche")).toMatch(/\b20\b/);
  });

  test("production caveats belong in review notes, not product captions", () => {
    const copy = productDraft();
    copy.channels[0].caption = "Our weekend loaf. Concept visual for owner review.";
    expect(() => validateCampaignCopy(copy, report, opportunity, [productSource], enrichment)).toThrow("consumer-facing copy");
    copy.channels[0].caption = "Meet our weekend loaf. Ask us about it.";
    copy.reviewNotes = ["Concept visual for owner review."];
    expect(validateCampaignCopy(copy, report, opportunity, [productSource], enrichment).reviewNotes).toContain("Concept visual for owner review.");
  });

  test("limited production-label cleanup preserves reported factual qualifications", () => {
    expect(cleanConsumerCopy("A reported family story. Concept preview.")).toBe("A reported family story.");
    expect(cleanConsumerCopy("Reported British roots. Concept visual.")).toBe("Reported British roots.");
    expect(cleanConsumerCopy("A reported story. Concept preview — message to inquire.")).toBe("A reported story. Message to inquire.");
    expect(cleanConsumerCopy("Status concept for the bakery sharing its reported story.")).toBe("A story from the bakery sharing its reported story.");
    expect(cleanConsumerCopy("A concept preview may include reported claims that need confirmation.")).toBe("A concept preview may include reported claims that need confirmation.");
    const removed: string[] = [];
    expect(cleanConsumerCopy("Reported family inspiration. Made as a locally rendered multi-scene MP4 concept. Ask the team. Concept inquiry flow.", removed)).toBe("Reported family inspiration. Ask the team.");
    expect(removed).toEqual(["Made as a locally rendered multi-scene MP4 concept.", "Concept inquiry flow."]);
    expect(cleanConsumerCopy("Status concept: The weekend loaf. Reported family inspiration. Concept visuals.")).toBe("The weekend loaf. Reported family inspiration.");
    const moved: string[] = [];
    expect(cleanConsumerCopy("A reported family story. This is a concept preview rendered locally. Ask the team.", moved)).toBe("A reported family story. Ask the team.");
    expect(moved).toEqual(["This is a concept preview rendered locally."]);
    // Business descriptions and qualifications cannot disappear under a metadata-cleanup rule.
    expect(cleanConsumerCopy("It is made locally. This is a gluten-free concept preview. Reported as a signature loaf.")).toBe("It is made locally. This is a gluten-free concept preview. Reported as a signature loaf.");
    expect(cleanConsumerCopy("Today's concept: Weekend loaf.")).toBe("Discover Weekend loaf.");
    expect(cleanConsumerCopy("Watch the Weekend loaf concept: a reported family story.")).toBe("Watch the Weekend loaf story: a reported family story.");
  });

  test("local raster pixels are composited while disguised SVG input is rejected", async () => {
    const raster = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const image = { bytes: raster, mimeType: "image/png" as const, provenance: "source_photo" as const, sourceIds: ["s1"], description: "Synthetic solid-color diagnostic." };
    const normalized = await normalizeCampaignImage(image);
    const frame = await renderCampaignFrame({ businessName: "Diagnostic bakery", vertical: "bakery", mode: "synthetic", campaignName: "Pixel preservation check", channels: [], outputDir: "/tmp", image, creativeBrief: productDraft().creativeBrief }, { width: 1080, height: 1350, headline: "Meet the weekend loaf", body: "Ask about the loaf.", cta: "Ask us", kicker: "Weekend loaf", variant: 0 }, normalized);
    const { data } = await sharp(frame).extract({ left: 540, top: 700, width: 1, height: 1 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([...data]).toEqual([255, 0, 0]);
    await expect(normalizeCampaignImage({ ...image, bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://outside.invalid/a"/></svg>') })).rejects.toThrow("genuine PNG");
  });

  test("segmented subject pixels compose once over a separate backdrop in four distinct roles", async () => {
    const original = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#0000ff" } }).png().toBuffer();
    const foreground = await sharp({ create: { width: 100, height: 100, channels: 4, background: "#00000000" } }).composite([{ input: await sharp({ create: { width: 50, height: 50, channels: 4, background: "#ff0000" } }).png().toBuffer(), left: 25, top: 25 }]).png().toBuffer();
    const backdrop = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#00ff00" } }).png().toBuffer();
    const input: RenderInput = { businessName: "Synthetic object fixture", vertical: "independent craft", mode: "synthetic", campaignName: "Color preservation diagnostic", channels: [], outputDir: "/tmp", image: { bytes: original, mimeType: "image/png", provenance: "source_photo", sourceIds: ["s1"], description: "Synthetic diagnostic only.", foregroundBytes: foreground, backgroundBytes: backdrop, backgroundStyle: "palette_gradient" } };
    const layout = { width: 1080, height: 1350, headline: "A thoughtful object, with room for its story", body: "Ask the team about the source-attributed object.", cta: "Ask the team", kicker: "Object", variant: 0 };
    const normalized = await normalizeCampaignImage(input.image!);
    const cutout = await normalizeCampaignForeground(foreground);
    const hero = await renderCampaignFrame(input, { ...layout, role: "hero" }, normalized, cutout, backdrop);
    const pixel = async (bytes: Buffer, left: number, top: number) => [...await sharp(bytes).extract({ left, top, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
    expect(await pixel(hero, 540, 700)).toEqual([255, 0, 0]);
    expect(await pixel(hero, 80, 480)).toEqual([0, 255, 0]);
    const frames = [hero];
    for (const role of ["detail", "story", "action"] as const) frames.push(await renderCampaignFrame(input, { ...layout, role }, normalized, cutout, backdrop));
    expect(new Set(frames.map((bytes) => hashBytes(bytes))).size).toBe(4);
    for (const bytes of frames) expect(await sharp(bytes).metadata()).toMatchObject({ width: 1080, height: 1350, format: "png" });
    // An opaque image cannot silently masquerade as a SAM cutout.
    await expect(normalizeCampaignForeground(original)).rejects.toThrow("transparent background");
    const clear = await sharp({ create: { width: 10, height: 10, channels: 4, background: "#00000000" } }).png().toBuffer();
    await expect(normalizeCampaignForeground(clear)).rejects.toThrow("visible pixels");
  });

  test("competitor facts cannot be advertised as business capabilities", () => {
    expect(validateCampaignCopy(draft(), report, opportunity).evidenceIds).toEqual(["fact-1"]);
    const contaminated = draft();
    contaminated.channels[0].evidenceIds = ["competitor-1"];
    expect(() => validateCampaignCopy(contaminated, report, opportunity)).toThrow("outside the selected sources");
  });

  test("rejects invented contact destinations and prices", () => {
    const copy = draft();
    copy.channels[0].caption = "Order at https://unprovided.example/order";
    expect(() => validateCampaignCopy(copy, report, opportunity)).toThrow("unsupported destination");
    copy.channels[0].caption = "Get 50% off today.";
    expect(() => validateCampaignCopy(copy, report, opportunity)).toThrow("unsupported price");
  });

  test("model paraphrases cannot authorize prices, partial links or uncited destinations", () => {
    const altered = structuredClone(report);
    altered.evidence[0].claim += " Now 50% off at https://fiction.example.";
    const copy = draft();
    copy.primaryCta = "Get 50% off";
    expect(() => validateCampaignCopy(copy, altered, opportunity)).toThrow("unsupported price");
    copy.primaryCta = "Visit https://fiction.example";
    expect(() => validateCampaignCopy(copy, altered, opportunity)).toThrow("unsupported destination");
    altered.evidence[0].quote += " Order at https://fiction.example/order.";
    expect(() => validateCampaignCopy(copy, altered, opportunity)).toThrow("unsupported destination");
    copy.primaryCta = "Call 9876543210";
    expect(() => validateCampaignCopy(copy, altered, opportunity)).toThrow("unsupported contact number");
    copy.primaryCta = "Visit https://fiction.example/Order";
    expect(() => validateCampaignCopy(copy, altered, opportunity)).toThrow("unsupported destination");
  });

  test("reported story themes remain usable but summaries cannot authorize dates, prices, phones or medical promises", () => {
    const reported = structuredClone(report);
    reported.evidence[0].basis = "meta_cited_summary";
    reported.evidence[0].quote += " Family recipes and British inspiration. Founded in 1954. Price ₹250. Phone 9876543210. Certified organic. Treats diabetes. Four generations. Free delivery.";
    const generic = draft();
    generic.coreMessage = "Family recipes and British inspiration.";
    expect(validateCampaignCopy(generic, reported, opportunity).reviewNotes[0]).toContain("reported descriptions");
    for (const text of ["A family bakery since 1954", "A loaf for ₹250", "Call 9876543210", "Certified organic", "Treats diabetes", "Four generations of baking", "Free delivery"]) {
      const unsafe = draft();
      unsafe.channels[0].headline = text;
      expect(() => validateCampaignCopy(unsafe, reported, opportunity)).toThrow();
    }
    // An explicit non-summary owner excerpt supplies the missing quantitative basis.
    reported.evidence[0].basis = "source_excerpt";
    const ownerSourced = draft();
    ownerSourced.channels[0].headline = "A family bakery since 1954";
    expect(validateCampaignCopy(ownerSourced, reported, opportunity).channels[0].headline).toContain("1954");
  });

  test("source text cannot inject executable SVG and every visual carries review status", () => {
    const svg = campaignSvg({ businessName: "<script>alert(1)</script>", campaignName: "Test", mode: "live", vertical: "bakery" }, { width: 1080, height: 1350, headline: "<image href='https://outside.example/x'/>", body: "Text & more", cta: "Ask us", kicker: "Concept", variant: 0 });
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("<image");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("CONCEPT · REVIEW REQUIRED");
  });
});

describe("channel titles are short consumer kickers printed on the channel image", () => {
  test("the copy prompt asks for a 2-5 word consumer kicker; the output schema and campaignInputHash are byte-identical", async () => {
    for (const mode of ["live", "synthetic"] as const) {
      const instructions = campaignCopyInstructions(mode);
      expect(instructions).toContain("Each channel title is printed on that channel's image as a short uppercase kicker above the headline, so write it as consumer-facing words of 2 to 5 words (at most 38 characters)");
      expect(instructions).toContain("never use planning or production words in a title, such as story introduction, introduction, concept, narrative, campaign, carousel, reel, scene, part or slide");
    }
    // The prompt is not part of the input binding: a stored completed response stays bound to the same hash.
    vi.stubEnv("META_STRATEGY_MODEL", ""); vi.stubEnv("META_REASONING_MODEL", "");
    const bound: CreateCampaignInput = { business: { id: "b1", name: "Fixture bakery", locality: "Fixture", vertical: "bakery", goal: "Test stored response", website: null }, report, opportunityId: opportunity.id, sources: [productSource], enrichment, mode: "synthetic", outputDir: "/tmp" };
    expect(campaignInputHash(bound)).toBe("593b87c7c6cd7dd8036233ab1dc4b98eac8e8b14d339f88ffb7aff0c692803e8");
    // The wire request carries exactly these instructions and the unchanged strict JSON schema. The stubbed response is
    // not completed, so nothing is written and no other request follows; no network is reached.
    vi.stubEnv("META_API_KEY", "offline-test-key");
    const bodies: Array<{ instructions: string; text: { format: { schema: unknown } } }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ id: "offline", status: "incomplete" }), { status: 200 }); });
    try {
      await expect(generateCampaignCopy({ business: bound.business, report, opportunity, sources: [productSource], mode: "live", enrichment })).rejects.toThrow("did not complete");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(bodies[0].instructions).toBe(campaignCopyInstructions("live"));
      expect(hashBytes(Buffer.from(JSON.stringify(bodies[0].text.format.schema)))).toBe("afd0e92818116faa463cd5a1c8acc9bf065b5ba40911b78e14d495f3eaf05888");
    } finally { fetchSpy.mockRestore(); vi.unstubAllEnvs(); }
  });

  test("a trailing planning label is cut back from a channel title; words are only removed, never added or reworded", () => {
    for (const [title, expected] of [
      ["Taste of Home Story Introduction", "Taste of Home"], ["Taste of Home Introduction", "Taste of Home"], ["Weekend loaf Concept", "Weekend loaf"],
      ["Weekend loaf – Concept", "Weekend loaf"], ["Weekend loaf: Carousel Story Introduction", "Weekend loaf"], ["Taste of Home Part 2", "Taste of Home"],
      ["Taste of Home (Reel)", "Taste of Home"], ["Our Story Reel", "Our Story"], ["Story Introduction", "Story"], ["Family Recipes Narrative", "Family Recipes"], ["Weekend Bakes Campaign", "Weekend Bakes"],
    ] as const) {
      expect(cleanChannelTitle(title), title).toBe(expected);
      expect(title.startsWith(expected), title).toBe(true);
      expect(cleanChannelTitle(expected), `${title} is idempotent`).toBe(expected);
    }
    // Nothing changes without a trailing planning label, when nothing would be left, when the cut would end on a
    // function word or unbalance a bracket, or when it would cut into the protected focus name.
    for (const title of ["Taste of Home", "Our Family Story", "instagram_reels", "Carousel", "The Reel", "Fresh (from the Reel", "Part of the Family", "Slides and Swings"]) expect(cleanChannelTitle(title), title).toBe(title);
    expect(cleanChannelTitle("Fly Fishing Reel", ["Fly Fishing Reel"])).toBe("Fly Fishing Reel");
    expect(cleanChannelTitle("Fly Fishing Reel Introduction", ["Fly Fishing Reel"])).toBe("Fly Fishing Reel");
    expect(cleanChannelTitle("Weekend Story Introduction", ["Weekend Story"])).toBe("Weekend Story");
  });

  test("validation prints the cleaned kicker and re-validates idempotently", () => {
    const copy = productDraft();
    copy.channels[0].title = "Taste of Home Story Introduction";
    copy.channels[1].title = "Weekend loaf Concept";
    const validated = validateCampaignCopy(copy, report, opportunity, [productSource], enrichment);
    expect(validated.channels.slice(0, 2).map((channel) => channel.title)).toEqual(["Taste of Home", "Weekend loaf"]);
    expect(validated.channels.slice(2).map((channel) => channel.title)).toEqual(ChannelSchema.options.slice(2));
    expect(validateCampaignCopy(structuredClone(validated), report, opportunity, [productSource], enrichment)).toEqual(validated);
    const completed = productDraft(); completed.channels[0].title = "Taste of Home Story Introduction";
    completed.creativeBrief!.context = { insightIds: [], whyNow: "Explain the source-attributed offering.", seasonalTheme: { name: null, status: "none", sourceIds: [] } };
    expect(validateCompletedCampaignCopy(completed, report, opportunity, [productSource], enrichment).channels[0].title).toBe("Taste of Home");
  });
});

describe("local export inventory", () => {
  test("completed responses replay exact bound copy locally and retain actual usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tickr-completed-response-"));
    const input: CreateCampaignInput = { business: { id: "b1", name: "Fixture bakery", locality: "Fixture", vertical: "bakery", goal: "Test stored response", website: null }, report, opportunityId: opportunity.id, sources: [productSource], enrichment, mode: "synthetic", outputDir: directory };
    const copy = productDraft(); copy.creativeBrief!.context = { insightIds: [], whyNow: "Explain the source-attributed offering.", seasonalTheme: { name: null, status: "none", sourceIds: [] } };
    const response: CompletedCopyResponse = { version: 1, status: "completed", responseId: "response-fixture", model: "muse-spark-1.3", requestHash: hashBytes(Buffer.from("fixture request")), receivedAt: new Date().toISOString(), usage: { model: "muse-spark-1.3", inputTokens: 17, outputTokens: 29, elapsedMs: 43 }, outputText: JSON.stringify(copy) };
    vi.stubEnv("META_API_KEY", "");
    try {
      await writeCompletedCopyRecord(directory, campaignInputHash(input), response);
      expect(await hasBoundCompletedCopy(input)).toBe(true);
      const replayed = await readCopyCheckpoint(input, opportunity);
      expect(replayed?.origin).toBe("completed_response");
      expect(replayed?.usage).toEqual(response.usage);
      expect(replayed?.copy.creativeBrief?.focus.name).toBe("Weekend loaf");
      await expect(readCopyCheckpoint({ ...input, business: { ...input.business, goal: "Changed input" } }, opportunity)).rejects.toThrow("integrity check");
      const changed = { ...response, outputText: response.outputText + " " };
      await expect(writeCompletedCopyRecord(directory, campaignInputHash(input), changed)).rejects.toThrow("already exists");
      const filename = join(directory, "copy-response.json");
      await writeFile(filename, (await readFile(filename, "utf8")).replace('"outputTokens": 29', '"outputTokens": 30'));
      await expect(hasBoundCompletedCopy(input)).rejects.toThrow("integrity check");
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });

  test("stored structurally invalid copy remains invalid on repeated local replay, without another paid request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tickr-invalid-response-"));
    const input: CreateCampaignInput = { business: { id: "b1", name: "Fixture bakery", locality: "Fixture", vertical: "bakery", goal: "Test invalid stored response", website: null }, report, opportunityId: opportunity.id, sources: [productSource], enrichment, mode: "synthetic", outputDir: directory, requireCompletedCopy: true };
    // An unsupported claim is repaired locally now; evidence outside the selected sources is structural and never is.
    const copy = productDraft(); copy.creativeBrief!.context = { insightIds: [], whyNow: "Explain the offering.", seasonalTheme: { name: null, status: "none", sourceIds: [] } }; copy.channels[0].caption = "Weekend loaf: 50% off."; copy.channels[0].evidenceIds = ["competitor-1"];
    const response: CompletedCopyResponse = { version: 1, status: "completed", responseId: "response-invalid", model: "muse-spark-1.3", requestHash: hashBytes(Buffer.from("fixture request")), receivedAt: new Date().toISOString(), usage: { model: "muse-spark-1.3", inputTokens: 17, outputTokens: 29, elapsedMs: 43 }, outputText: JSON.stringify(copy) };
    vi.stubEnv("META_API_KEY", "");
    try {
      await writeCompletedCopyRecord(directory, campaignInputHash(input), response);
      expect(await hasBoundCompletedCopy(input)).toBe(true);
      for (let attempt = 0; attempt < 2; attempt++) await expect(createCampaign(input)).rejects.toBeInstanceOf(CampaignCopyValidationError);
      // The failed replay still carries the stored response's metering so the run can account for it.
      await expect(createCampaign(input)).rejects.toMatchObject({ usage: response.usage });
      expect((await readCompletedCopyRecord(directory, campaignInputHash(input)))?.outputText).toBe(response.outputText);
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });

  test("a stored carousel response numbered 1/ 2/ 3/ revalidates locally on retry, without another paid request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tickr-carousel-response-"));
    const reported = structuredClone(report);
    reported.evidence[0].kind = "signal";
    reported.evidence[0].basis = "meta_cited_summary";
    const source: CollectedSource = { ...productSource, kind: "business_coverage", acquisition: "meta_cited_summary", url: "https://bakery.example/story", citation: { responseId: "response-1", searchCallIds: ["search-1"], url: "https://bakery.example/story", title: "Reported bakery story", method: "model_reference" } };
    const input: CreateCampaignInput = { business: { id: "b1", name: "Fixture bakery", locality: "Fixture", vertical: "bakery", goal: "Test carousel numbering", website: null }, report: reported, opportunityId: opportunity.id, sources: [source], enrichment, mode: "synthetic", outputDir: directory, requireCompletedCopy: true };
    const copy = productDraft(); copy.creativeBrief!.context = { insightIds: [], whyNow: "Explain the offering.", seasonalTheme: { name: null, status: "none", sourceIds: [] } };
    const carousel = copy.channels.find((channel) => channel.id === "instagram_carousel")!;
    carousel.caption = "Weekend loaf, three ways 1/ The weekend loaf, fresh from the oven. 2/ Shared at the table with family. 3/ Ask the team about the weekend loaf.";
    const response: CompletedCopyResponse = { version: 1, status: "completed", responseId: "response-carousel", model: "muse-spark-1.3", requestHash: hashBytes(Buffer.from("fixture request")), receivedAt: new Date().toISOString(), usage: { model: "muse-spark-1.3", inputTokens: 17, outputTokens: 29, elapsedMs: 43 }, outputText: JSON.stringify(copy) };
    vi.stubEnv("META_API_KEY", "");
    try {
      await writeCompletedCopyRecord(directory, campaignInputHash(input), response);
      expect(await hasBoundCompletedCopy(input)).toBe(true);
      for (let attempt = 0; attempt < 2; attempt++) {
        const replayed = await readCopyCheckpoint(input, opportunity);
        expect(replayed?.origin).toBe("completed_response");
        expect(replayed?.usage).toEqual(response.usage);
        expect(replayed?.copy.channels.find((channel) => channel.id === "instagram_carousel")?.caption).toBe(carousel.caption);
      }
      expect((await readCompletedCopyRecord(directory, campaignInputHash(input)))?.outputText).toBe(response.outputText);
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });

  test("a stored live response whose WhatsApp opener asks what is available revalidates locally on retry, without another paid request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tickr-inquiry-response-"));
    const context: NonNullable<CollectedSource["context"]> = { scope: "brand", location: null, locationEvidence: null, publishedAt: null, validFrom: null, validThrough: null, temporalStatus: "unknown", dateEvidence: null };
    const candidate: BusinessEnrichment = { ...enrichment, branch: { status: "candidate", label: "Fixture branch", locality: "Fixture", address: null, sourceIds: ["s1"], rationale: "Likely match from a reported description." } };
    const input: CreateCampaignInput = { business: { id: "b1", name: "Fixture bakery", locality: "Fixture", vertical: "bakery", goal: "Test customer inquiry", website: null }, report, opportunityId: opportunity.id, sources: [{ ...productSource, context }], enrichment: candidate, mode: "synthetic", outputDir: directory, requireCompletedCopy: true };
    const copy = productDraft(); copy.creativeBrief!.context = { insightIds: [], whyNow: "Explain the offering.", seasonalTheme: { name: null, status: "none", sourceIds: [] } };
    copy.conversation.opener = "Hi! Could you share what is available this weekend…?";
    const response: CompletedCopyResponse = { version: 1, status: "completed", responseId: "response-inquiry", model: "muse-spark-1.3", requestHash: hashBytes(Buffer.from("fixture request")), receivedAt: new Date().toISOString(), usage: { model: "muse-spark-1.3", inputTokens: 17, outputTokens: 29, elapsedMs: 43 }, outputText: JSON.stringify(copy) };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request in an offline test."));
    vi.stubEnv("META_API_KEY", "");
    try {
      await writeCompletedCopyRecord(directory, campaignInputHash(input), response);
      for (let attempt = 0; attempt < 2; attempt++) {
        const replayed = await readCopyCheckpoint(input, opportunity);
        expect(replayed?.origin).toBe("completed_response");
        expect(replayed?.usage).toEqual(response.usage);
        expect(replayed?.copy.conversation.opener).toBe(copy.conversation.opener);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect((await readCompletedCopyRecord(directory, campaignInputHash(input)))?.outputText).toBe(response.outputText);
    } finally { fetchSpy.mockRestore(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });

  test("a pending completed response fails closed before any replacement request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tickr-pending-response-"));
    try {
      await writeFile(join(directory, "copy-response.pending.json"), "interrupted write");
      await expect(readCompletedCopyRecord(directory, hashBytes(Buffer.from("input")))).rejects.toThrow("pending recovery");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("render-only retry fails before any model request if its completed checkpoint disappears", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tickr-copy-missing-"));
    const input: CreateCampaignInput = { business: { id: "b1", name: "Fixture bakery", locality: "Fixture", vertical: "bakery", goal: "Test missing checkpoint", website: null }, report, opportunityId: opportunity.id, sources: [], mode: "synthetic", outputDir: directory, reuseCompletedCopyOnly: true };
    vi.stubEnv("META_API_KEY", "");
    try {
      await expect(createCampaign(input)).rejects.toThrow("completed copy checkpoint is required");
      await expect(createCampaign({ ...input, reuseCompletedCopyOnly: false, requireCompletedCopy: true })).rejects.toThrow("completed copy checkpoint is required");
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });

  test("completed copy checkpoints bind exact inputs and reject corrupt or changed runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tickr-copy-checkpoint-"));
    const input: CreateCampaignInput = { business: { id: "b1", name: "Fixture bakery", locality: "Fixture", vertical: "bakery", goal: "Test copy checkpoint", website: null }, report, opportunityId: opportunity.id, sources: [], mode: "synthetic", outputDir: directory };
    try {
      expect(await readCopyCheckpoint(input, opportunity)).toBeNull();
      const saved = { inputHash: campaignInputHash(input), copy: draft(), usage: { model: "muse-spark-1.3", inputTokens: 10, outputTokens: 20, elapsedMs: 100 } };
      await writeFile(join(directory, "copy-checkpoint.json"), JSON.stringify(saved));
      expect((await readCopyCheckpoint(input, opportunity))?.usage.inputTokens).toBe(10);
      await expect(readCopyCheckpoint({ ...input, business: { ...input.business, goal: "A changed goal" } }, opportunity)).rejects.toThrow("no longer matches");
      await writeFile(join(directory, "copy-checkpoint.json"), "not JSON");
      await expect(readCopyCheckpoint(input, opportunity)).rejects.toThrow("no longer matches");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("rejects traversal, duplicate filenames and changed bytes", async () => {
    expect(() => safeOutputPath("/tmp", "../../private.txt")).toThrow("Invalid campaign filename");
    expect(() => buildZip([{ filename: "a.txt", bytes: Buffer.from("a") }, { filename: "a.txt", bytes: Buffer.from("b") }])).toThrow("inventory");
    const directory = await mkdtemp(join(tmpdir(), "tickr-export-test-"));
    try {
      await writeFile(join(directory, "creative.png"), "approved bytes");
      const inventory = [{ filename: "creative.png", sha256: hashBytes(Buffer.from("approved bytes")) }];
      const archive = await writeVerifiedArchive(directory, inventory);
      expect(hashBytes(await readFile(join(directory, "campaign-concept.zip")))).toBe(archive.sha256);
      await writeFile(join(directory, "creative.png"), "changed bytes");
      await expect(writeVerifiedArchive(directory, inventory)).rejects.toThrow("changed after review");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
