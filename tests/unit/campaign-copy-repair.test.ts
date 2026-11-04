import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { hashBytes } from "../../lib/campaign/archive";
import { boundedRecordList, businessQuantityText, CampaignCopySchema, claimRepairDocument, claimRepairNote, CLAIM_REPAIR_NOTE_PREFIX, customerQuestionQuantityText, repairCampaignCopyClaims, validateCampaignCopy, validateCompletedCampaignCopy, withoutAskedClauses, type CampaignCopy } from "../../lib/campaign/copy";
import { readCompletedCopyRecord, writeCompletedCopyRecord, type CompletedCopyResponse } from "../../lib/campaign/completed-response";
import { campaignInputHash, ensureCampaignCopy, readCopyCheckpoint, type CreateCampaignInput } from "../../lib/campaign";
import { ChannelSchema } from "../../lib/schemas/common";
import type { BusinessEnrichment, CollectedSource, ResearchOpportunity, ResearchReport } from "../../lib/research/contracts";

// Synthetic fixtures only; the two live-run strings below are the exact failing shapes from the 4 Nov 2026 hosted runs.
const THEOBROMA_CTWA_BODY = "Hi! Could you share what is available this weekend in Brownies and the Cheesecake Range, and pickup options?";
const GRANDMA_CAROUSEL_ONLY = "A Taste of Home in 3 moments: familiar meals, flavours to share slowly, and a cosy table to stay awhile.";
const GRANDMA_CAROUSEL_CAPTION = `${GRANDMA_CAROUSEL_ONLY} Ask the team about the weekend loaf.`;

const score = { value: null, rationale: "Not measured in this fixture." };
const opportunity: ResearchOpportunity = {
  id: "op-1", title: "Introduce the weekend loaf", hypothesis: "Customers may value knowing the bake schedule.", whyNow: "A specific product is described.", evidenceIds: ["fact-1", "competitor-1"], comparison: "Insufficient market coverage.", customerAction: "Ask about the loaf", test: "Count qualified inquiries.", uncertainties: ["Demand is unmeasured."],
  scores: { impact: score, evidence: score, differentiation: score, feasibility: score, confidence: score },
};
const report: ResearchReport = {
  summary: "Synthetic test only.", evidence: [
    { id: "fact-1", sourceId: "s1", claim: "The bakery makes a weekend loaf.", quote: "We make a weekend loaf.", subject: "business", kind: "fact" },
    { id: "competitor-1", sourceId: "s2", claim: "Another bakery delivers.", quote: "We deliver.", subject: "competitor", kind: "fact" },
  ], findings: [], opportunities: [opportunity], recommendedOpportunityId: "op-1", unknowns: [], ownerQuestions: [], coverage: { sources: 2, competitorSources: 1, customerSources: 0 }, generatedAt: "2026-11-01T00:00:00Z", mode: "synthetic",
};
const context: NonNullable<CollectedSource["context"]> = { scope: "brand", location: null, locationEvidence: null, publishedAt: null, validFrom: null, validThrough: null, temporalStatus: "unknown", dateEvidence: null };
const productSource: CollectedSource = { id: "s1", kind: "owner_statement", title: "Owner product note", url: null, text: "We make a weekend loaf.", retrievedAt: "2026-11-02T00:00:00Z", acquisition: "owner_supplied" };
/** Brand-level (not exact-location) source: availability and offers need dated exact-location evidence. */
const scopedSource: CollectedSource = { ...productSource, context };
const enrichment: BusinessEnrichment = { status: "enriched", businessId: "b1", offerings: [{ id: "offering-1", name: "Weekend loaf", description: "A loaf offered by the bakery.", sourceIds: ["s1"] }], brandSignals: [], sourceIds: ["s1"], unknowns: [], warnings: [], queries: [], completedToolCalls: 0, enrichedAt: "2026-11-02T00:00:00Z" };
const candidate: BusinessEnrichment = { ...enrichment, branch: { status: "candidate", label: "Fixture branch", locality: "Fixture", address: null, sourceIds: ["s1"], rationale: "Likely match from a reported description." } };
/** A Meta-cited summary source: quantities and dates need original wording or owner confirmation. */
const reported: ResearchReport = { ...structuredClone(report), evidence: report.evidence.map((item) => (item.id === "fact-1" ? { ...item, kind: "signal" as const, basis: "meta_cited_summary" as const } : item)) };
const summarySource: CollectedSource = { ...productSource, kind: "business_coverage", acquisition: "meta_cited_summary", url: "https://bakery.example/story", citation: { responseId: "response-1", searchCallIds: ["search-1"], url: "https://bakery.example/story", title: "Reported bakery story", method: "model_reference" } };

function generatedDraft(): CampaignCopy {
  return {
    name: "Weekend loaf", objective: "Invite inquiries.", audienceHypothesis: "People interested in local baking.", coreMessage: "Meet the weekend loaf.", primaryCta: "Ask about the loaf", evidenceIds: ["fact-1"], reviewNotes: ["Confirm product availability."],
    channels: ChannelSchema.options.map((id) => ({ id, title: id, headline: "A loaf for the weekend", body: "Meet our weekend loaf.", caption: "Ask us about the weekend loaf.", cta: "Ask about the loaf", evidenceIds: ["fact-1"] })),
    conversation: { opener: "I would like to know about the loaf.", commonReplies: Array.from({ length: 3 }, () => ({ question: "Is it available?", answer: "The team can confirm availability." })), qualificationQuestion: "What would you like to know?", nextAction: "Ask the team to confirm details." },
    creativeBrief: {
      context: { insightIds: [], whyNow: "Explain the source-attributed offering.", seasonalTheme: { name: null, status: "none", sourceIds: [] } },
      focus: { offeringId: "offering-1", name: "Weekend loaf", description: "A loaf from the bakery.", evidenceIds: ["fact-1"], sourceIds: ["s1"] },
      brandStory: { signalIds: [], narrative: "", evidenceIds: [], sourceIds: [] },
      visualDirection: { status: "proposed", description: "Warm cream and forest ink, with an illustrative focus on the named loaf.", palette: ["#F6EEDD", "#263A30", "#BB4D2F"], sourceIds: [] },
      scenes: (["hook", "proof", "occasion", "action"] as const).map((role) => ({ role, headline: "Meet the weekend loaf", body: "Ask the team about the weekend loaf." })),
    },
  };
}
const channel = (copy: CampaignCopy, id: string) => copy.channels.find((item) => item.id === id)!;
const repairNotes = (copy: CampaignCopy) => copy.reviewNotes.filter((note) => note.startsWith(CLAIM_REPAIR_NOTE_PREFIX));

describe("targeted claim-rule fixes", () => {
  test("the click-to-WhatsApp body is the customer's prefilled inquiry; every other field stays business voice", () => {
    const copy = generatedDraft(); channel(copy, "click_to_whatsapp").body = THEOBROMA_CTWA_BODY;
    expect(() => validateCampaignCopy(copy, report, opportunity, [scopedSource], candidate)).not.toThrow();
    // The same sentence spoken by the business is an availability claim, in the CTWA caption and in any other channel.
    for (const id of ["click_to_whatsapp", "facebook_ads", "instagram_feed"]) {
      const business = generatedDraft(); channel(business, id).caption = THEOBROMA_CTWA_BODY;
      expect(() => validateCampaignCopy(business, report, opportunity, [scopedSource], candidate), id).toThrow("dated, original evidence");
    }
    const otherBody = generatedDraft(); channel(otherBody, "instagram_feed").body = THEOBROMA_CTWA_BODY;
    expect(() => validateCampaignCopy(otherBody, report, opportunity, [scopedSource], candidate)).toThrow("dated, original evidence");
    // Customer voice exempts genuine requests only: an assertion in the prefilled message is still a claim.
    for (const body of ["Hi! The weekend loaf is available this weekend.", "Could you share what is available? The weekend loaf is in stock today.", "Could I tempt you with our special offer this weekend?", "Could you believe the weekend loaf is available today?"]) {
      const assertive = generatedDraft(); channel(assertive, "click_to_whatsapp").body = body;
      expect(() => validateCampaignCopy(assertive, report, opportunity, [scopedSource], candidate), body).toThrow("dated, original evidence");
    }
    const cta = generatedDraft(); channel(cta, "click_to_whatsapp").cta = "Available today";
    expect(() => validateCampaignCopy(cta, report, opportunity, [scopedSource], candidate)).toThrow("dated, original evidence");
  });

  test("the click-to-WhatsApp body is printed on the ad image, so yes/no questions, presupposed offers and greeting text stay claims", () => {
    for (const body of [
      "Hi! Is the Weekend loaf on sale this weekend?", "Hi! Do you have the Weekend loaf in stock today?", "Hi! Are bookings open today for the Weekend loaf?",
      "Hi! Can you do same-day delivery on the Weekend loaf?", "Hi! Could you tell me about the free delivery today on the Weekend loaf?",
      "Hey saw the Weekend loaf is in stock today - could you hold one?", "Hi! I'm curious, the Weekend loaf is on sale today, can I order?",
      "Is the weekend loaf in stock today?", "Can I get same-day delivery on the weekend loaf today?", "Are bookings open today for the weekend loaf?",
      "Hi there, what is available today? The weekend loaf is in stock.",
    ]) {
      const copy = generatedDraft(); channel(copy, "click_to_whatsapp").body = body;
      expect(() => validateCampaignCopy(copy, report, opportunity, [scopedSource], candidate), body).toThrow("dated, original evidence");
    }
    // Only the open phrase "what is available" is neutral, inside a genuine request that opens with at most a short addressee.
    for (const body of ["Hi team, could you share what is available this weekend for the Weekend loaf?", "What's available today in the Weekend loaf range?", "Hi! Could you tell me about Weekend loaf?"]) {
      const copy = generatedDraft(); channel(copy, "click_to_whatsapp").body = body;
      expect(() => validateCampaignCopy(copy, report, opportunity, [scopedSource], candidate), body).not.toThrow();
    }
    // The completed-response repair judges the body the same way and falls back to a neutral inquiry naming only the focus.
    const draft = generatedDraft(); channel(draft, "click_to_whatsapp").body = "Hi! Is the Weekend loaf on sale this weekend?";
    expect(channel(validateCompletedCampaignCopy(draft, report, opportunity, [scopedSource], candidate), "click_to_whatsapp").body).toBe("Hi! Could you tell me about Weekend loaf?");
  });

  test("a self-counted story lead-in is editorial only in a sequence channel's caption; bare structure counts stay quantities", () => {
    const carousel = generatedDraft(); channel(carousel, "instagram_carousel").caption = GRANDMA_CAROUSEL_CAPTION;
    expect(validateCampaignCopy(carousel, reported, opportunity, [summarySource], enrichment).channels.find((item) => item.id === "instagram_carousel")!.caption).toBe(GRANDMA_CAROUSEL_CAPTION);
    for (const id of ["instagram_stories", "instagram_reels", "whatsapp_status"]) {
      const sequence = generatedDraft(); channel(sequence, id).caption = GRANDMA_CAROUSEL_CAPTION;
      expect(() => validateCampaignCopy(sequence, reported, opportunity, [summarySource], enrichment), id).not.toThrow();
    }
    // Outside a sequence channel's caption, or without the counted list, "in 3 moments" is still an unsupported number.
    for (const [id, key] of [["facebook_ads", "caption"], ["instagram_feed", "caption"], ["instagram_carousel", "body"]] as const) {
      const copy = generatedDraft(); channel(copy, id)[key] = key === "body" ? "Weekend loaf in 3 moments: warm, shared, savoured." : GRANDMA_CAROUSEL_CAPTION;
      expect(() => validateCampaignCopy(copy, reported, opportunity, [summarySource], enrichment), `${id} ${key}`).toThrow("quantitative promises");
    }
    expect(businessQuantityText("A Taste of Home in 3 moments: meals, flavours, and a table.", { channel: "instagram_carousel", field: "caption" })).not.toMatch(/\d/);
    expect(businessQuantityText("A Taste of Home in 3 moments: meals, flavours, and a table.", { channel: "instagram_carousel", field: "body" })).toContain("3");
    expect(businessQuantityText("Splash down 12 slides", { channel: "instagram_carousel", field: "caption" })).toContain("12");
    expect(businessQuantityText("Our loaf story in 3 moments", { channel: "instagram_carousel", field: "caption" })).toContain("3");
    // Water-park slides, studio scenes, courses, instalments, play equipment and miscounted lists are business quantities.
    for (const unsafe of [
      "The Weekend loaf, one of 12 slides at our water park.", "Weekend loaf workshop taught in 6 parts.", "Our studio has 8 scenes to shoot the Weekend loaf.",
      "Our weekend loaf tasting menu unfolds in 7 moments.", "Our weekend loaf play barn has 3 slides and a ball pit.", "Pay for the weekend loaf in 3 parts.",
      "The weekend loaf course runs across 6 chapters.", "Swipe 3 slides of the weekend loaf.", "The weekend loaf in 3 moments: warm crust and soft crumb.",
      "The weekend loaf in 3 moments: bread and butter, jam, and tea.", "The weekend loaf in 3 moments: baked since 1998, sliced, and shared.",
      "Weekend loaf: 3 cakes for your table.", "Weekend loaf, 3 steps from the station.", "Weekend loaf, open 3 days.", "Weekend loaf since 1998.", "Weekend loaf: 3 for 2.", "The weekend loaf in 3 moments, ready in 20 minutes.",
    ]) {
      const copy = generatedDraft(); channel(copy, "instagram_carousel").caption = unsafe;
      expect(() => validateCampaignCopy(copy, reported, opportunity, [summarySource], enrichment), unsafe).toThrow("quantitative promises");
    }
    // Story keywords elsewhere in the copy no longer exempt structure counts in other channels or fields.
    for (const [id, caption] of [["instagram_feed", "Our story: the Weekend loaf workshop runs over 6 parts."], ["facebook_ads", "Weekend loaf story — a class taught across 10 chapters."], ["facebook_ads", "Our weekend loaf story: a tasting menu in 7 moments."]] as const) {
      const copy = generatedDraft(); channel(copy, id).caption = caption;
      expect(() => validateCampaignCopy(copy, reported, opportunity, [summarySource], enrichment), caption).toThrow("quantitative promises");
    }
    const answer = generatedDraft(); answer.objective = "Invite inquiries with a reel story."; answer.conversation.commonReplies[0].answer = "Our weekend loaf tasting is served in 5 moments.";
    expect(() => validateCampaignCopy(answer, reported, opportunity, [summarySource], enrichment)).toThrow("quantitative promises");
  });

  test("brief and top-level quantity checks accept a list read either across joined fields (as before) or within one field", () => {
    const listed = generatedDraft();
    listed.creativeBrief!.brandStory = { signalIds: [], narrative: "A weekend loaf story.", evidenceIds: ["fact-1"], sourceIds: ["s1"] };
    listed.creativeBrief!.scenes.forEach((scene, index) => { scene.headline = `${index + 1}. Warm weekend loaf`; });
    // Numbered scenes were accepted by the joined reading before this change; strict validation must not start rejecting them.
    expect(validateCampaignCopy(structuredClone(listed), reported, opportunity, [summarySource], enrichment).creativeBrief!.scenes.map((scene) => scene.headline)).toEqual(["1. Warm weekend loaf", "2. Warm weekend loaf", "3. Warm weekend loaf", "4. Warm weekend loaf"]);
    // Copy that strict validation accepts is returned unchanged by the completed-response path: no repair, no note.
    const completed = validateCompletedCampaignCopy(listed, reported, opportunity, [summarySource], enrichment);
    expect(completed.creativeBrief!.scenes.map((scene) => scene.headline)).toEqual(["1. Warm weekend loaf", "2. Warm weekend loaf", "3. Warm weekend loaf", "4. Warm weekend loaf"]);
    expect(repairNotes(completed)).toEqual([]);
    expect(completed.claimRepairs).toBeUndefined();
    // A genuine list inside one field still loses only its markers.
    const withinField = generatedDraft();
    withinField.creativeBrief!.focus.description = "A weekend loaf story:\n1. Fresh from the oven.\n2. Shared at the table.\n3. Ask the team.";
    withinField.conversation.nextAction = "Our story:\n1. Choose the weekend loaf.\n2. Ask the team.";
    expect(() => validateCampaignCopy(withinField, reported, opportunity, [summarySource], enrichment)).not.toThrow();
    // Real quantities in brief and top-level fields are still detected.
    for (const mutate of [(copy: CampaignCopy) => { copy.creativeBrief!.focus.description = "A weekend loaf story:\n1. Baked since 1954.\n2. Ask the team."; }, (copy: CampaignCopy) => { copy.coreMessage = "Weekend loaf, 3 steps from the station."; }, (copy: CampaignCopy) => { copy.conversation.commonReplies[0].answer = "We bake 40 loaves each Saturday."; }]) {
      const copy = generatedDraft(); mutate(copy);
      expect(() => validateCampaignCopy(copy, reported, opportunity, [summarySource], enrichment)).toThrow("quantitative promises");
    }
  });
});

const FIELD_FALLBACK = "Curious about Weekend loaf? Ask the team.";
const PREFILL_FALLBACK = "Hi! Could you tell me about Weekend loaf?";
/** A reset channel: every text field of the ad and its post is replaced, so nothing written for the removed claim stays. */
const AD_FALLBACK = { title: "Weekend loaf", headline: "Weekend loaf", body: FIELD_FALLBACK, caption: FIELD_FALLBACK, cta: "Ask the team" } as const;
const CTWA_FALLBACK = { ...AD_FALLBACK, body: PREFILL_FALLBACK } as const;
const adText = (copy: CampaignCopy, id: string) => { const { title, headline, body, caption, cta } = channel(copy, id); return { title, headline, body, caption, cta }; };
/** The draft's own text in every channel field, which a unit reset replaces with the alongside reason. */
const DRAFT_AD = { title: "", headline: "A loaf for the weekend", body: "Meet our weekend loaf.", caption: "Ask us about the weekend loaf.", cta: "Ask about the loaf" } as const;
const alongside = (id: string, key: keyof typeof DRAFT_AD, trigger: string) => ({ field: `${id} ${key}`, removed: [key === "title" ? id : DRAFT_AD[key]], unsupported: [key === "title" ? id : DRAFT_AD[key]], reason: `read with the replaced ${trigger}`, fallback: true });
type Evidence = "scoped" | "summary";
const strictCheck = (copy: CampaignCopy, evidence: Evidence) => (evidence === "scoped" ? validateCampaignCopy(copy, report, opportunity, [scopedSource], candidate) : validateCampaignCopy(copy, reported, opportunity, [summarySource], enrichment));
const completedCheck = (copy: CampaignCopy, evidence: Evidence) => (evidence === "scoped" ? validateCompletedCampaignCopy(copy, report, opportunity, [scopedSource], candidate) : validateCompletedCampaignCopy(copy, reported, opportunity, [summarySource], enrichment));

/**
 * Safety-review shapes where dropping one sentence shifted the meaning of the rest, or left a dangling fragment. Each is
 * rejected by strict validation and comes out of the completed path with the whole field replaced: the listed words of
 * the original (and every other word of it) are gone.
 */
const RESET_CASES: Array<[string, Evidence, string[]]> = [
  // (2) Meaning shifts.
  ["The weekend loaf is available. Brownies are on sale. Today only!", "scoped", ["Today only", "available", "Brownies"]],
  ["Weekend loaf baked fresh. Same-day delivery available. Order by 5 pm and it arrives tonight.", "scoped", ["Order by", "tonight", "delivery", "baked"]],
  ["Weekend loaf baked fresh. Bookings are open now. Reserve yours today.", "scoped", ["Reserve yours", "Bookings", "baked"]],
  ["Weekend loaf baked fresh. Brownies are discounted. Weekend loaf is too.", "scoped", ["too", "discounted", "baked"]],
  // (3) Dangling fragments.
  ["Today's deal:\nWeekend loaf, 20% off.", "scoped", ["deal", "Today", "20%"]],
  ["This weekend only at the counter:\nWeekend loaf on sale.", "scoped", ["This weekend only", "counter", "sale"]],
  ["Weekend loaf from Rs. 250 today. Baked fresh.", "summary", ["Rs.", "250", "Baked"]],
  ["Weekend loaf, baked fresh. Est. 1998 in Pune.", "summary", ["Est.", "1998", "Pune", "baked"]],
  // The rest of the reviewer's p2/p3 probes.
  ["Weekend loaf available\nBrownies on sale\nToday only", "scoped", ["Today only", "Brownies"]],
  ["Weekend loaf... now available today.", "scoped", ["available", "today"]],
  ["Weekend loaf 🍞 Available today 🎉 Baked fresh.", "scoped", ["Available", "Baked", "🍞"]],
  ["Order at https://shop.example/a. Weekend loaf baked fresh.", "scoped", ["Order at", "https", "baked"]],
  ["\"Available today!\" Weekend loaf baked fresh.", "scoped", ["Available", "baked"]],
  ["On sale today! Weekend loaf baked fresh. On sale today!", "scoped", ["On sale", "baked"]],
  ["Rated 4.5 by locals. Weekend loaf on sale.", "scoped", ["Rated", "4.5", "sale"]],
  ["Weekend loaf baked fresh. Free delivery? Not this weekend.", "scoped", ["Free delivery", "Not this weekend", "baked"]],
  ["Weekend loaf is not discounted. It is baked fresh daily.", "scoped", ["discounted", "daily"]],
  ["Weekend loaf baked fresh. Brownies are discounted. The Weekend loaf as well.", "scoped", ["as well", "discounted"]],
  ["Weekend loaf baked fresh. Get it at 20% off. That's this weekend, Saturday and Sunday.", "scoped", ["That's this weekend", "Saturday", "20%"]],
  ["Weekend loaf in stock now. Mon. to Sat. pickup.", "scoped", ["Mon.", "Sat.", "pickup", "stock"]],
  ["Weekend loaf baked fresh. 50% off this Saturday. Saturday 9 Nov, 8 am to noon.", "scoped", ["Saturday", "9 Nov", "noon", "50%"]],
  ["Weekend loaf, fresh. Limited stock.\nBrownies on sale today.", "scoped", ["Limited stock", "Brownies"]],
];

/** Relative clauses, later sentences and presupposed offers in the prefilled body: rejected and reset to the prefill fallback. */
const PREFILL_RESET_CASES = [
  // (1) The four relative-clause shapes from the safety review.
  "Hi! Could you tell me about the Weekend loaf, which is available today?",
  "Hi! Could you hold a Weekend loaf for me, which is available now?",
  "Hi! Could you reserve the Weekend loaf loaves which are available here?",
  "Hi! What's available now, the Weekend loaf, which is available this weekend?",
  // The rest of the reviewer's p1/p2 prefill probes.
  "Hi! Could you share which Weekend loaf flavours are available today at the counter?",
  "Hi! Could you tell me about the Weekend loaf that is available today?",
  "What is available today? The Weekend loaf?",
  "Hi! I saw the Weekend loaf is on sale. Could you hold one for Saturday?",
  "Hi! Free delivery today on the Weekend loaf? Could you hold one for Saturday?",
  // Second review: a tail after the neutral "available" that asserts or presupposes the focus is available now.
  "Hi! What's available today is the Weekend loaf, right?",
  "Hi! What is available today is the Weekend loaf?",
  "Hi! What's available now is the Weekend loaf at the counter, isn't it?",
  "Hi! Could you tell me what is available today besides the Weekend loaf?",
  "Hi! What's available today other than the Weekend loaf?",
  "Hi! What is available today along with the Weekend loaf?",
  "Hi! Could you tell me what are available today, Weekend loaf included?",
  "Hello team: what's available now, I hear the Weekend loaf?",
  "Hi! Please share what is available today including the Weekend loaf 🍞?",
  "Hi! What's available here: just the Weekend loaf?",
  "Hi! What's available today — the Weekend loaf?",
  "Hi! What is available today: the Weekend loaf at the counter?",
  "Hi! Could you share what is available for delivery tonight with the Weekend loaf?",
  "Hi! What is available this weekend at your Pune branch besides the Weekend loaf?",
  "Hi! What is available now that the Weekend loaf is available here?",
  "Hi!\nWhat's available today with the Weekend loaf?",
];

/**
 * Second review: a claim and its follow-on split across fields that are read together. Each draft is rejected by strict
 * validation; the completed path must replace every field of the unit, so no qualifier, lead-in or follow-on written
 * for the removed claim ("Today only!", "Today's deal:", "Weekend loaf is too.") is left to attach to the focus.
 */
const AD_UNIT_CASES: Array<[string, Partial<Record<"title" | "headline" | "body" | "caption" | "cta", string>>, string[]]> = [
  ["facebook_ads", { headline: "Weekend loaf on sale", body: "Today only! Order by 5 pm." }, ["Today only", "Order by", "sale"]],
  ["instagram_feed", { headline: "Weekend loaf, 20% off", body: "Today only. Ends at closing." }, ["Today only", "Ends at closing", "20%"]],
  ["facebook_ads", { headline: "This weekend only at the counter:", body: "Weekend loaf on sale." }, ["This weekend only", "counter", "sale"]],
  ["facebook_ads", { body: "Same-day delivery on the Weekend loaf.", caption: "Order by 5 pm and it arrives tonight." }, ["Order by", "arrives tonight", "delivery"]],
  ["facebook_ads", { body: "Weekend loaf bookings are open now.", caption: "Reserve yours today. Only 20 loaves." }, ["Reserve yours", "Only 20", "bookings"]],
  ["facebook_ads", { body: "Brownies are on sale this weekend.", caption: "Weekend loaf is too. Today only!" }, ["is too", "Today only", "Brownies"]],
  ["facebook_ads", { headline: "Today's deal:", body: "Weekend loaf, 20% off." }, ["deal", "20%"]],
  ["facebook_ads", { headline: "Weekend loaf 20% off", caption: "This weekend only. Baked fresh Saturday morning." }, ["This weekend only", "Saturday", "20%"]],
  ["click_to_whatsapp", { headline: "Weekend loaf, today only:", body: "Hi! Is the Weekend loaf on sale this weekend?", cta: "Order by 5 pm" }, ["today only", "Order by", "sale"]],
];

describe("asked clauses stay questions, not hidden assertions", () => {
  // Strict rule (pre-dates the repair pass): "ask/check/confirm ... whether/if/what/which" only exempts the asked clause itself.
  const strictCaption = (text: string) => { const copy = generatedDraft(); channel(copy, "facebook_ads").caption = text; return () => validateCampaignCopy(copy, report, opportunity, [scopedSource], candidate); };
  test.each([
    "Hi! Could you confirm the Weekend loaf, which is available today?",
    "Ask whether the Weekend loaf, on sale today, suits you.",
    "Check if you like the Weekend loaf, which is in stock now.",
    "Check if you like the Weekend loaf that is in stock now.",
    "Ask the team about the Weekend loaf which is available today.",
    "Confirm the Weekend loaf is available today.",
    // An asked clause that names bookings, slots, sales or stock is not erased; the claim rules decide (S1).
    "Ask us if bookings are open this weekend.",
  ])("rejects an availability or sale claim tucked into an asked clause: %s", (text) => {
    expect(strictCaption(text)).toThrow("Current offers and availability need dated, original evidence");
  });
  test.each([
    "Ask the team what's available this weekend.",
    "Ask whether the Weekend loaf is available this weekend.",
    "Check with us which flavours are available today.",
    "Curious about the Weekend loaf? Ask the team what's available.",
  ])("keeps a genuine inquiry invitation: %s", (text) => {
    expect(strictCaption(text)).not.toThrow();
  });
  test("a completed response with such a clause is repaired, not failed", () => {
    const copy = generatedDraft(); channel(copy, "facebook_ads").caption = "Hi! Could you confirm the Weekend loaf, which is available today?";
    const repaired = validateCompletedCampaignCopy(copy, report, opportunity, [scopedSource], candidate);
    expect(JSON.stringify(channel(repaired, "facebook_ads"))).not.toContain("available today");
    expect(repaired.claimRepairs?.some((item) => item.unsupported.join(" ").includes("which is available today"))).toBe(true);
  });
});

describe("whole-field claim repair of completed responses", () => {
  test("strict validation rejects a business-voice availability sentence; the completed path replaces the whole field and notes it", () => {
    const copy = generatedDraft(); channel(copy, "facebook_ads").caption = THEOBROMA_CTWA_BODY;
    expect(() => validateCampaignCopy(structuredClone(copy), report, opportunity, [scopedSource], candidate)).toThrow("dated, original evidence");
    const repaired = validateCompletedCampaignCopy(copy, report, opportunity, [scopedSource], candidate);
    // The whole ad is replaced: its title, headline, body and CTA are read with the rejected caption.
    expect(adText(repaired, "facebook_ads")).toEqual(AD_FALLBACK);
    // Every other channel passed and is untouched.
    for (const id of ChannelSchema.options.filter((item) => item !== "facebook_ads")) expect(adText(repaired, id)).toEqual({ ...DRAFT_AD, title: id });
    expect(repairNotes(repaired)).toEqual([`Automatic claim repair: replaced 5 fields with a neutral line because the sources could not support this text (4 only because they are read with such text) — facebook_ads caption: “${THEOBROMA_CTWA_BODY.slice(4, 73).trimEnd()}…” (availability or offer without dated original evidence); facebook_ads title (read with the replaced facebook_ads caption); +3 more fields. copy-claim-repairs.json lists the original text in full; confirm with the owner before restoring any of it.`]);
    expect(repaired.claimRepairs).toEqual([
      alongside("facebook_ads", "title", "facebook_ads caption"), alongside("facebook_ads", "headline", "facebook_ads caption"), alongside("facebook_ads", "body", "facebook_ads caption"),
      { field: "facebook_ads caption", removed: [THEOBROMA_CTWA_BODY], unsupported: [THEOBROMA_CTWA_BODY.slice(4)], reason: "availability or offer without dated original evidence", fallback: true },
      alongside("facebook_ads", "cta", "facebook_ads caption"),
    ]);
  });

  test("no sentence of a violating field survives: meaning-shift and fragment shapes are reset in full", () => {
    for (const [caption, evidence, words] of RESET_CASES) {
      const copy = generatedDraft(); channel(copy, "facebook_ads").caption = caption;
      expect(() => strictCheck(structuredClone(copy), evidence), caption).toThrow();
      const repaired = completedCheck(copy, evidence);
      const field = channel(repaired, "facebook_ads").caption;
      expect(field, caption).toBe(FIELD_FALLBACK);
      for (const word of words) expect(field.toLowerCase(), `${caption} kept “${word}”`).not.toContain(word.toLowerCase());
      expect(repaired.claimRepairs!.map((repair) => repair.field), caption).toEqual(["title", "headline", "body", "caption", "cta"].map((key) => `facebook_ads ${key}`));
      const rejected = repaired.claimRepairs!.find((repair) => repair.field === "facebook_ads caption")!;
      expect(rejected, caption).toMatchObject({ removed: [caption], fallback: true });
      // Detection quotes only text that was in the original field.
      for (const quoted of rejected.unsupported) expect(caption, caption).toContain(quoted);
      expect(adText(repaired, "facebook_ads"), caption).toEqual(AD_FALLBACK);
      expect(strictCheck(structuredClone(repaired), evidence)).toEqual(repaired);
    }
  });

  test("the prefill voice neutralises only a leading open 'what is available' request; relative clauses reset to the prefill fallback", () => {
    for (const body of PREFILL_RESET_CASES) {
      const copy = generatedDraft(); channel(copy, "click_to_whatsapp").body = body;
      expect(() => validateCampaignCopy(structuredClone(copy), report, opportunity, [scopedSource], candidate), body).toThrow("dated, original evidence");
      const repaired = validateCompletedCampaignCopy(copy, report, opportunity, [scopedSource], candidate);
      expect(adText(repaired, "click_to_whatsapp"), body).toEqual(CTWA_FALLBACK);
      expect(repaired.claimRepairs!.find((repair) => repair.field === "click_to_whatsapp body"), body).toMatchObject({ removed: [body], reason: "availability or offer without dated original evidence", fallback: true });
      expect(repaired.claimRepairs!.every((repair) => repair.field.startsWith("click_to_whatsapp "))).toBe(true);
    }
    // The direct-object request shapes stay neutral, including the exact live-run body.
    for (const body of [THEOBROMA_CTWA_BODY, "Hi team, could you share what is available this weekend for the Weekend loaf?", "What's available today in the Weekend loaf range?", "Please let me know what is available in the Weekend loaf range this weekend?", "Can you tell me what's available in the Weekend loaf range?"]) {
      const copy = generatedDraft(); channel(copy, "click_to_whatsapp").body = body;
      expect(channel(validateCampaignCopy(copy, report, opportunity, [scopedSource], candidate), "click_to_whatsapp").body, body).toBe(body);
    }
  });

  test("a claim split across the fields of one ad is replaced as a unit, so its kept follow-on cannot attach to the focus", () => {
    for (const [id, fields, words] of AD_UNIT_CASES) {
      const copy = generatedDraft(); Object.assign(channel(copy, id), fields);
      const label = `${id} ${JSON.stringify(fields)}`;
      expect(() => validateCampaignCopy(structuredClone(copy), report, opportunity, [scopedSource], candidate), label).toThrow();
      const original = adText(copy, id);
      const repaired = validateCompletedCampaignCopy(copy, report, opportunity, [scopedSource], candidate);
      const ad = adText(repaired, id);
      expect(ad, label).toEqual(id === "click_to_whatsapp" ? CTWA_FALLBACK : AD_FALLBACK);
      for (const word of words) expect(JSON.stringify(ad).toLowerCase(), `${label} kept “${word}”`).not.toContain(word.toLowerCase());
      // Every changed field of the unit is listed with its full original text, and nothing outside the unit changed.
      const changed = (["title", "headline", "body", "caption", "cta"] as const).filter((key) => original[key] !== ad[key]);
      expect(repaired.claimRepairs!.map((repair) => repair.field), label).toEqual(changed.map((key) => `${id} ${key}`));
      for (const key of changed) expect(repaired.claimRepairs!.find((repair) => repair.field === `${id} ${key}`)!.removed, label).toEqual([original[key]]);
      for (const other of ChannelSchema.options.filter((item) => item !== id)) expect(adText(repaired, other), label).toEqual({ ...DRAFT_AD, title: other });
      expect(repairNotes(repaired)[0], label).toMatch(/^Automatic claim repair: replaced \d+ fields with a neutral line because the sources could not support this text \(\d+ only because (?:it is|they are) read with such text\) — /);
      expect(validateCampaignCopy(structuredClone(repaired), report, opportunity, [scopedSource], candidate), label).toEqual(repaired);
    }
  });

  test("the four scenes and the carousel and reel posts that show them are one unit; the WhatsApp script is another", () => {
    const sceneCases: Array<(copy: CampaignCopy) => void> = [
      (copy) => { copy.creativeBrief!.scenes[1].headline = "Brownies 30% off"; copy.creativeBrief!.scenes[1].body = "The Weekend loaf too. This weekend only."; },
      (copy) => { copy.creativeBrief!.scenes[0].headline = "Weekend loaf 20% off"; copy.creativeBrief!.scenes[3].body = "This weekend only, while loaves last."; },
      (copy) => { channel(copy, "instagram_carousel").caption = "Swipe: Weekend loaf, 20% off."; copy.creativeBrief!.scenes[3].headline = "Today only!"; },
    ];
    for (const mutate of sceneCases) {
      const copy = generatedDraft(); mutate(copy);
      expect(() => validateCampaignCopy(structuredClone(copy), report, opportunity, [scopedSource], candidate)).toThrow();
      const repaired = validateCompletedCampaignCopy(copy, report, opportunity, [scopedSource], candidate);
      expect(repaired.creativeBrief!.scenes.map(({ headline, body }) => ({ headline, body }))).toEqual(Array.from({ length: 4 }, () => ({ headline: "Weekend loaf", body: FIELD_FALLBACK })));
      for (const id of ["instagram_carousel", "instagram_reels"]) expect(adText(repaired, id)).toEqual(AD_FALLBACK);
      for (const id of ChannelSchema.options.filter((item) => !["instagram_carousel", "instagram_reels"].includes(item))) expect(adText(repaired, id)).toEqual({ ...DRAFT_AD, title: id });
      expect(JSON.stringify(repaired.creativeBrief!.scenes)).not.toMatch(/only|too|off|last/i);
      expect(repaired.claimRepairs).toHaveLength(18);
      expect(validateCampaignCopy(structuredClone(repaired), report, opportunity, [scopedSource], candidate)).toEqual(repaired);
    }
    // A customer question reset with its answer kept would leave "Yes, until Sunday." replying to a different question.
    const script = generatedDraft();
    script.conversation.commonReplies[0] = { question: "Hi! The Weekend loaf is on sale this weekend, right?", answer: "Yes, until Sunday at closing." };
    expect(() => validateCampaignCopy(structuredClone(script), report, opportunity, [scopedSource], candidate)).toThrow("dated, original evidence");
    const repaired = validateCompletedCampaignCopy(script, report, opportunity, [scopedSource], candidate);
    expect(repaired.conversation.commonReplies[0]).toEqual({ question: PREFILL_FALLBACK, answer: "The team will confirm that detail for you." });
    expect(repaired.claimRepairs!.find((repair) => repair.field === "reply 1")).toEqual({ field: "reply 1", removed: ["Yes, until Sunday at closing."], unsupported: ["Yes, until Sunday at closing."], reason: "read with the replaced customer question 1", fallback: true });
    expect(adText(repaired, "facebook_ads")).toEqual({ ...DRAFT_AD, title: "facebook_ads" });
  });

  test("both live-run strings pass unchanged through strict and completed validation, with no repair", () => {
    const copy = generatedDraft();
    channel(copy, "click_to_whatsapp").body = THEOBROMA_CTWA_BODY;
    channel(copy, "instagram_carousel").caption = GRANDMA_CAROUSEL_ONLY;
    const summaryScoped: CollectedSource = { ...summarySource, context };
    for (const [evidenceReport, sources, enriched] of [[report, [scopedSource], candidate], [reported, [summaryScoped], candidate], [reported, [summarySource], enrichment]] as const) {
      const strict = validateCampaignCopy(structuredClone(copy), evidenceReport, opportunity, [...sources], enriched);
      const completed = validateCompletedCampaignCopy(structuredClone(copy), evidenceReport, opportunity, [...sources], enriched);
      for (const result of [strict, completed]) {
        expect(channel(result, "click_to_whatsapp").body).toBe(THEOBROMA_CTWA_BODY);
        expect(channel(result, "instagram_carousel").caption).toBe(GRANDMA_CAROUSEL_ONLY);
      }
      expect(completed.claimRepairs).toBeUndefined();
      expect(repairNotes(completed)).toEqual([]);
    }
  });

  test("each violating unit falls back to neutral text built only from the exact focus name; a repeated part is listed once", () => {
    const copy = generatedDraft();
    channel(copy, "facebook_ads").caption = "The weekend loaf is available today.";
    channel(copy, "facebook_ads").cta = "Available today";
    channel(copy, "facebook_ads").headline = "Weekend loaf, now available";
    channel(copy, "instagram_feed").caption = "On sale today! Weekend loaf baked fresh. On sale today!";
    copy.conversation.opener = "Hi! The weekend loaf is available this weekend.";
    copy.conversation.commonReplies[1].answer = "The weekend loaf is in stock today.";
    copy.coreMessage = "Visit us for the weekend loaf.";
    const repaired = validateCompletedCampaignCopy(copy, report, opportunity, [scopedSource], candidate);
    expect(adText(repaired, "facebook_ads")).toEqual(AD_FALLBACK);
    expect(adText(repaired, "instagram_feed")).toEqual(AD_FALLBACK);
    for (const id of ChannelSchema.options.filter((item) => !["facebook_ads", "instagram_feed"].includes(item))) expect(adText(repaired, id)).toEqual({ ...DRAFT_AD, title: id });
    // The WhatsApp script is one unit: every message in it is replaced, so no answer is left replying to a different question.
    expect(repaired.conversation).toEqual({
      opener: PREFILL_FALLBACK,
      commonReplies: Array.from({ length: 3 }, () => ({ question: PREFILL_FALLBACK, answer: "The team will confirm that detail for you." })),
      qualificationQuestion: "What would you like to know about Weekend loaf?",
      nextAction: "Share what you would like to know about Weekend loaf.",
    });
    // The campaign summary is one unit; the name already equals its neutral label and is not listed.
    expect([repaired.name, repaired.objective, repaired.audienceHypothesis, repaired.coreMessage, repaired.primaryCta]).toEqual(["Weekend loaf", "Invite customer questions about Weekend loaf.", "People curious about Weekend loaf.", FIELD_FALLBACK, "Ask the team"]);
    const [note] = repairNotes(repaired);
    expect(note).toMatch(/^Automatic claim repair: replaced 23 fields with a neutral line because the sources could not support this text \(16 only because they are read with such text\) — core message: “Visit us for the weekend loaf\.” \(unconfirmed local destination\); WhatsApp opener: /);
    expect(note).toContain("unconfirmed local destination");
    expect(note.length).toBeLessThanOrEqual(500);
    expect(repaired.claimRepairs).toHaveLength(23);
    expect(repaired.claimRepairs!.filter((repair) => !repair.reason.startsWith("read with the replaced ")).map((repair) => repair.field)).toEqual(["core message", "WhatsApp opener", "reply 2", "facebook_ads headline", "facebook_ads caption", "facebook_ads cta", "instagram_feed caption"]);
    expect(repaired.claimRepairs!.find((repair) => repair.field === "WhatsApp opener")).toEqual({ field: "WhatsApp opener", removed: ["Hi! The weekend loaf is available this weekend."], unsupported: ["The weekend loaf is available this weekend."], reason: "availability or offer without dated original evidence", fallback: true });
    expect(repaired.claimRepairs!.find((repair) => repair.field === "reply 1")).toEqual({ field: "reply 1", removed: ["The team can confirm availability."], unsupported: ["The team can confirm availability."], reason: "read with the replaced WhatsApp opener", fallback: true });
    expect(repaired.claimRepairs!.find((repair) => repair.field === "primary CTA")).toMatchObject({ removed: ["Ask about the loaf"], reason: "read with the replaced core message" });
    expect(repaired.claimRepairs!.some((repair) => repair.field === "campaign name")).toBe(false);
    // A repeated unsupported sentence is listed once; the full original text, with every occurrence, is under removed.
    expect(repaired.claimRepairs!.find((repair) => repair.field === "instagram_feed caption")).toMatchObject({ removed: ["On sale today! Weekend loaf baked fresh. On sale today!"], unsupported: ["On sale today!"] });
    // The fallback contains nothing beyond the focus name: no number, offer, date or availability wording.
    expect(JSON.stringify([adText(repaired, "facebook_ads"), repaired.conversation, repaired.coreMessage])).not.toMatch(/available|\d|offer|today|visit|sale/i);
    // The same violating text in two channels is two replaced units.
    const twice = generatedDraft();
    channel(twice, "facebook_ads").caption = "Weekend loaf, 20% off.";
    channel(twice, "instagram_feed").caption = "Weekend loaf, 20% off.";
    const both = validateCompletedCampaignCopy(twice, report, opportunity, [scopedSource], candidate);
    expect(both.claimRepairs!.filter((repair) => !repair.reason.startsWith("read with")).map((repair) => repair.field)).toEqual(["facebook_ads caption", "instagram_feed caption"]);
    expect(repairNotes(both)[0]).toMatch(/^Automatic claim repair: replaced 10 fields .* — facebook_ads caption: “Weekend loaf, 20% off\.” \(unsupported price or percentage\); instagram_feed caption: “Weekend loaf, 20% off\.”/);
  });

  test("a reset channel still names the focus offering", () => {
    const copy = generatedDraft();
    Object.assign(channel(copy, "instagram_feed"), { headline: "A loaf for the weekend", body: "Our weekend loaf is in stock today. Fresh bread for your table.", caption: "Ask us more about it." });
    const repaired = validateCompletedCampaignCopy(copy, report, opportunity, [scopedSource], candidate);
    expect(adText(repaired, "instagram_feed")).toEqual(AD_FALLBACK);
    expect(repaired.claimRepairs!.find((repair) => repair.field === "instagram_feed body")).toEqual({ field: "instagram_feed body", removed: ["Our weekend loaf is in stock today. Fresh bread for your table."], unsupported: ["Our weekend loaf is in stock today."], reason: "availability or offer without dated original evidence", fallback: true });
    expect(repaired.claimRepairs!.find((repair) => repair.field === "instagram_feed caption")).toEqual({ field: "instagram_feed caption", removed: ["Ask us more about it."], unsupported: ["Ask us more about it."], reason: "read with the replaced instagram_feed body", fallback: true });
  });

  test("the repair judges consumer text after production labels are moved out, exactly as strict validation does", () => {
    // Before cleaning, "video" in a production-only sentence made the list markers look editorial; strict validation removes that sentence first.
    const copy = generatedDraft(); channel(copy, "facebook_ads").caption = "Weekend loaf, our way: 1) warm crust 2) soft crumb. This concept was rendered as a video.";
    expect(() => validateCampaignCopy(structuredClone(copy), reported, opportunity, [summarySource], enrichment)).toThrow("quantitative promises");
    const repaired = validateCompletedCampaignCopy(copy, reported, opportunity, [summarySource], enrichment);
    expect(channel(repaired, "facebook_ads").caption).toBe(FIELD_FALLBACK);
    expect(repaired.reviewNotes).toContain("Production notes moved from consumer copy: This concept was rendered as a video.");
    expect(repairNotes(repaired)[0]).toContain("facebook_ads caption: “Weekend loaf, our way: 1) warm crust 2) soft crumb.”");
    expect(validateCampaignCopy(structuredClone(repaired), reported, opportunity, [summarySource], enrichment)).toEqual(repaired);
  });

  test("structural failures still throw, a missing focus repairs nothing, and repair never runs inside strict validation", () => {
    const availability = "The weekend loaf is available today.";
    const outside = generatedDraft(); channel(outside, "facebook_ads").caption = availability; channel(outside, "facebook_ads").evidenceIds = ["competitor-1"];
    expect(() => validateCompletedCampaignCopy(outside, report, opportunity, [scopedSource], candidate)).toThrow("outside the selected sources");
    const order = generatedDraft(); channel(order, "facebook_ads").caption = availability; order.creativeBrief!.scenes.reverse();
    expect(() => validateCompletedCampaignCopy(order, report, opportunity, [scopedSource], candidate)).toThrow("hook, proof, occasion and action");
    const focus = generatedDraft(); channel(focus, "facebook_ads").caption = availability; focus.creativeBrief!.focus.name = "Chocolate celebration cake";
    expect(() => validateCompletedCampaignCopy(focus, report, opportunity, [scopedSource], candidate)).toThrow("does not match");
    const leak = generatedDraft(); channel(leak, "facebook_ads").caption = "Meet the weekend loaf. Concept visual for owner review.";
    expect(() => validateCompletedCampaignCopy(leak, report, opportunity, [scopedSource], candidate)).toThrow("consumer-facing copy");
    const unnamed = generatedDraft(); Object.assign(channel(unnamed, "instagram_feed"), { headline: "Fresh bread", body: "Good bread.", caption: "Ask us." });
    expect(() => validateCompletedCampaignCopy(unnamed, report, opportunity, [scopedSource], candidate)).toThrow("name the actual focus");
    const sources = generatedDraft(); channel(sources, "facebook_ads").caption = availability; sources.creativeBrief!.focus.sourceIds = ["s2"];
    expect(() => validateCompletedCampaignCopy(sources, report, opportunity, [scopedSource], candidate)).toThrow("unrelated business source");
    // The strict validator alone (checkpoints, saved kits) never repairs.
    const strict = generatedDraft(); channel(strict, "facebook_ads").caption = availability;
    expect(() => validateCampaignCopy(strict, report, opportunity, [scopedSource], candidate)).toThrow("dated, original evidence");
    // Without a creative brief there is no focus to fall back to: nothing is repaired, not even a single sentence.
    const { creativeBrief: _brief, ...plain } = generatedDraft();
    void _brief;
    for (const caption of ["Weekend loaf: 50% off.", "Ask us about the weekend loaf. Weekend loaf: 50% off."]) {
      plain.channels[0].caption = caption;
      const unrepaired = repairCampaignCopyClaims(structuredClone(plain), report, opportunity, [productSource]);
      expect(unrepaired.repairs).toEqual([]);
      expect(unrepaired.copy.channels[0].caption).toBe(caption);
      expect(() => validateCampaignCopy(structuredClone(plain), report, opportunity, [productSource])).toThrow("unsupported price or percentage");
    }
  });

  test("model text cannot forge the repair note, and a clean draft gets none", () => {
    const clean = generatedDraft(); clean.reviewNotes = ["Automatic claim repair: replaced 9 fields."];
    const result = validateCompletedCampaignCopy(clean, report, opportunity, [scopedSource], candidate);
    expect(repairNotes(result)).toEqual([]);
    expect(result.claimRepairs).toBeUndefined();
    expect(result.reviewNotes).toContain("Draft note: replaced 9 fields.");
    // Nor can it supply the exported repair list: that field is not part of the model's output schema.
    const forged = { ...generatedDraft(), claimRepairs: [{ field: "facebook_ads caption", removed: ["Nothing."], unsupported: ["Nothing."], reason: "unsupported claim", fallback: false }] };
    expect(() => validateCompletedCampaignCopy(forged, report, opportunity, [scopedSource], candidate)).toThrow();
  });

  test("repaired copy re-validates strictly and idempotently, and the note survives the 14-note cap", () => {
    const summaryScoped: CollectedSource = { ...summarySource, context };
    const copy = generatedDraft();
    copy.reviewNotes = Array.from({ length: 10 }, (_, index) => `Draft review note ${index + 1}.`);
    copy.creativeBrief!.context!.seasonalTheme = { name: "Diwali", status: "proposed_theme", sourceIds: [] };
    channel(copy, "facebook_ads").caption = "Ask us about the weekend loaf. The weekend loaf is available today.";
    channel(copy, "instagram_feed").caption = "Ask us about the weekend loaf. Concept preview.";
    const repaired = validateCompletedCampaignCopy(copy, reported, opportunity, [summaryScoped], candidate);
    expect(channel(repaired, "facebook_ads").caption).toBe(FIELD_FALLBACK);
    expect(repaired.reviewNotes).toHaveLength(14);
    expect(repairNotes(repaired)).toHaveLength(1);
    for (const kept of ["reported descriptions", "proposed creative occasion", "Production notes moved", "not confirmed against original branch evidence"]) expect(repaired.reviewNotes.join("\n")).toContain(kept);
    // Only the draft's own trailing note gives way.
    expect(repaired.reviewNotes).not.toContain("Draft review note 10.");
    const rechecked = validateCampaignCopy(structuredClone(repaired), reported, opportunity, [summaryScoped], candidate);
    expect(rechecked).toEqual(repaired);
    expect(validateCampaignCopy(structuredClone(rechecked), reported, opportunity, [summaryScoped], candidate)).toEqual(repaired);
    // The same stored response always repairs to the same bytes.
    expect(validateCompletedCampaignCopy(copy, reported, opportunity, [summaryScoped], candidate)).toEqual(repaired);
  });

  test("the repair note stays concise when many fields are replaced", () => {
    const repairs = Array.from({ length: 30 }, (_, index) => ({ field: `field ${index}`, removed: [`A long unsupported sentence number ${index} that keeps going well past the excerpt limit for quoting.`], unsupported: [`A long unsupported sentence number ${index} that keeps going well past the excerpt limit for quoting.`], reason: "availability or offer without dated original evidence", fallback: true }));
    const note = claimRepairNote(repairs);
    expect(note.length).toBeLessThanOrEqual(500);
    expect(note).toMatch(/^Automatic claim repair: replaced 30 fields with a neutral line because the sources could not support this text — field 0: /);
    expect(note).toMatch(/; \+\d+ more fields\. copy-claim-repairs\.json lists the original text in full; confirm with the owner before restoring any of it\.$/);
  });
});

describe("stored completed responses replay through repair without another paid request", () => {
  test("a copy checkpoint the previous validator accepted (numbered scene headlines) still re-validates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tickr-checkpoint-compat-"));
    const input: CreateCampaignInput = { business: { id: "b1", name: "Fixture bakery", locality: "Fixture", vertical: "bakery", goal: "Resume after a later stage", website: null }, report: reported, opportunityId: opportunity.id, sources: [summarySource], enrichment, mode: "synthetic", outputDir: directory };
    const copy = generatedDraft();
    copy.creativeBrief!.brandStory = { signalIds: [], narrative: "A weekend loaf story.", evidenceIds: ["fact-1"], sourceIds: ["s1"] };
    copy.creativeBrief!.scenes.forEach((scene, index) => { scene.headline = `${index + 1}. Warm weekend loaf`; });
    const usage = { model: "muse-spark-1.3", inputTokens: 17, outputTokens: 29, elapsedMs: 43 };
    try {
      await writeFile(join(directory, "copy-checkpoint.json"), JSON.stringify({ inputHash: campaignInputHash(input), copy, usage }));
      const resumed = await readCopyCheckpoint(input, opportunity);
      expect(resumed?.usage).toEqual(usage);
      expect(resumed?.copy.creativeBrief!.scenes.map((scene) => scene.headline)).toEqual(["1. Warm weekend loaf", "2. Warm weekend loaf", "3. Warm weekend loaf", "4. Warm weekend loaf"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("both live-run failure shapes now replay locally, checkpoint once and re-validate idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tickr-repair-replay-"));
    const summaryScoped: CollectedSource = { ...summarySource, context };
    const input: CreateCampaignInput = { business: { id: "b1", name: "Fixture bakery", locality: "Fixture", vertical: "bakery", goal: "Replay a repaired response", website: null }, report: reported, opportunityId: opportunity.id, sources: [summaryScoped], enrichment: candidate, mode: "synthetic", outputDir: directory, requireCompletedCopy: true };
    const copy = generatedDraft();
    channel(copy, "click_to_whatsapp").body = THEOBROMA_CTWA_BODY;
    channel(copy, "instagram_carousel").caption = GRANDMA_CAROUSEL_CAPTION;
    // The channel whose caption genuinely fails is replaced in full; every other channel of the paid response is kept.
    channel(copy, "facebook_ads").caption = "Ask us about the weekend loaf. Baked fresh since 1998.";
    const response: CompletedCopyResponse = { version: 1, status: "completed", responseId: "response-repair", model: "muse-spark-1.3", requestHash: hashBytes(Buffer.from("fixture request")), receivedAt: new Date().toISOString(), usage: { model: "muse-spark-1.3", inputTokens: 17, outputTokens: 29, elapsedMs: 43 }, outputText: JSON.stringify(copy) };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request in an offline test."));
    const reserveCopyCall = vi.fn(async () => undefined);
    vi.stubEnv("META_API_KEY", "");
    try {
      await writeCompletedCopyRecord(directory, campaignInputHash(input), response);
      const replays = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const replayed = await readCopyCheckpoint(input, opportunity);
        expect(replayed?.origin).toBe("completed_response");
        expect(replayed?.usage).toEqual(response.usage);
        replays.push(replayed!.copy);
      }
      expect(replays[1]).toEqual(replays[0]);
      const [repaired] = replays;
      expect(channel(repaired, "click_to_whatsapp").body).toBe(THEOBROMA_CTWA_BODY);
      expect(channel(repaired, "instagram_carousel").caption).toBe(GRANDMA_CAROUSEL_CAPTION);
      expect(adText(repaired, "facebook_ads")).toEqual(AD_FALLBACK);
      expect(repairNotes(repaired)).toEqual(["Automatic claim repair: replaced 5 fields with a neutral line because the sources could not support this text (4 only because they are read with such text) — facebook_ads caption: “Baked fresh since 1998.” (quantity or date from a Meta summary); facebook_ads title (read with the replaced facebook_ads caption); +3 more fields. copy-claim-repairs.json lists the original text in full; confirm with the owner before restoring any of it."]);
      expect(repaired.claimRepairs).toEqual([
        alongside("facebook_ads", "title", "facebook_ads caption"), alongside("facebook_ads", "headline", "facebook_ads caption"), alongside("facebook_ads", "body", "facebook_ads caption"),
        { field: "facebook_ads caption", removed: ["Ask us about the weekend loaf. Baked fresh since 1998."], unsupported: ["Baked fresh since 1998."], reason: "quantity or date from a Meta summary", fallback: true },
        alongside("facebook_ads", "cta", "facebook_ads caption"),
      ]);

      const ensured = await ensureCampaignCopy(input, { reserveCopyCall });
      expect(ensured.origin).toBe("completed_response");
      expect(ensured.copy).toEqual(repaired);
      // The checkpoint now holds the repaired copy, which strict validation accepts unchanged on every later retry.
      const checkpoint = JSON.parse(await readFile(join(directory, "copy-checkpoint.json"), "utf8")) as { copy: CampaignCopy };
      expect(checkpoint.copy).toEqual(repaired);
      for (let attempt = 0; attempt < 2; attempt++) {
        const again = await ensureCampaignCopy(input, { reserveCopyCall });
        expect(again.origin).toBeUndefined();
        expect(again.copy).toEqual(repaired);
        expect(repairNotes(again.copy)).toHaveLength(1);
      }
      expect(reserveCopyCall).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect((await readCompletedCopyRecord(directory, campaignInputHash(input)))?.outputText).toBe(response.outputText);
    } finally { fetchSpy.mockRestore(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });
});

/** The neutral line each kind of field falls back to. */
const fallbackFor = (id: string, key: "title" | "headline" | "body" | "caption" | "cta") => (key === "title" || key === "headline" ? "Weekend loaf" : key === "cta" ? "Ask the team" : id === "click_to_whatsapp" && key === "body" ? PREFILL_FALLBACK : FIELD_FALLBACK);
type FieldCase = ["facebook_ads" | "click_to_whatsapp" | "instagram_feed", "headline" | "body" | "caption" | "cta", string];
const withField = ([id, key, text]: FieldCase) => { const copy = generatedDraft(); channel(copy, id)[key] = text; return copy; };
const scopedArgs = [report, opportunity, [scopedSource], candidate] as const;
const summaryScopedArgs = [reported, opportunity, [{ ...summarySource, context }], candidate] as const;

describe("fifth review: asked-clause, prefill, note and record hardening (fail closed)", () => {
  /** Every attack string from the last review (probes3 a1 and a4): rejected strictly, reset by the completed path. */
  const ATTACKS: FieldCase[] = [
    ["facebook_ads", "caption", "Weekend loaf on sale today"],
    ["facebook_ads", "caption", "Ask which flavour you'd like\nWeekend loaf on sale today"],
    ["facebook_ads", "caption", "Ask us what you need\nThe Weekend loaf is in stock now 🍞"],
    ["facebook_ads", "caption", "Ask what you fancy and grab the Weekend loaf, now in stock"],
    ["facebook_ads", "caption", "Ask what you fancy and grab the Weekend loaf now in stock."],
    ["facebook_ads", "caption", "Check which size suits you because the Weekend loaf is on sale today."],
    ["facebook_ads", "caption", "Ask us what you need and get free delivery today."],
    ["facebook_ads", "caption", "Confirm what time suits you - bookings are open now."],
    ["facebook_ads", "caption", "Ask what's fresh 🍞 Weekend loaf on sale today 🎉"],
    ["facebook_ads", "caption", "Check what's new (Weekend loaf on sale today)"],
    ["facebook_ads", "caption", "Ask what you like / Weekend loaf in stock now"],
    ["facebook_ads", "caption", "Ask which loaf you want and book now while slots are available."],
    ["facebook_ads", "caption", "Ask if you want to, then pick up the Weekend loaf on sale today."],
    ["facebook_ads", "caption", "Ask if you want to then pick up the Weekend loaf on sale today."],
    ["facebook_ads", "body", "Ask what is new so you can enjoy 20% off."],
    ["facebook_ads", "headline", "Ask what's on sale today"],
    ["facebook_ads", "cta", "Check what's in stock now"],
    ["facebook_ads", "caption", "Weekend loaf: ask what's discounted today"],
    ["facebook_ads", "caption", "Ask me if the Weekend loaf is on sale - it is, today only!"],
    ["facebook_ads", "caption", "Ask if it's on sale. It is!"],
    ["facebook_ads", "caption", "Ask whether we deliver; same-day delivery available."],
    ["facebook_ads", "caption", "Ask whether we deliver… same-day delivery available"],
    ["facebook_ads", "caption", "Ask whether you can visit us at our Pune branch today"],
    ["click_to_whatsapp", "body", "Hi! Ask if you like but the Weekend loaf is on sale today?"],
    ["click_to_whatsapp", "body", "Hi! Could you confirm if the Weekend loaf is on sale today and if free delivery is available now?"],
    ["click_to_whatsapp", "body", "Hi! What's available today? Check if the Weekend loaf is in stock"],
    ["click_to_whatsapp", "body", "Hi! What's available today? Ask if you like and grab the Weekend loaf on sale today"],
    ["facebook_ads", "caption", "What's available today? Ask if you like and grab the Weekend loaf on sale today"],
    ["click_to_whatsapp", "body", "Hi! What's available today in on-sale Weekend loaf?"],
    ["facebook_ads", "caption", "Weekend loaf, on-sale today"],
    ["facebook_ads", "caption", "Weekend loaf, in-stock now"],
    ["click_to_whatsapp", "body", "Hi! What's available for delivery tonight?"],
    ["facebook_ads", "caption", "Weekend loaf, available for delivery tonight"],
    ["click_to_whatsapp", "body", "Hi! Could you share what is available this weekend for buy-one-get-one?"],
    ["facebook_ads", "caption", "Weekend loaf: buy-one-get-one this weekend"],
    // Further stop and vocabulary shapes.
    ["facebook_ads", "caption", "Ask what's fresh — Weekend loaf on sale today"],
    ["facebook_ads", "caption", "Ask what's fresh... Weekend loaf in stock now"],
    ["facebook_ads", "caption", "Ask what you like [Weekend loaf on sale today]"],
    ["facebook_ads", "caption", "Ask what you like | Weekend loaf in stock now"],
    ["facebook_ads", "caption", "Ask which size you need plus the Weekend loaf is on sale today"],
    ["facebook_ads", "caption", "Ask whether the Weekend loaf is available this weekend. Yes!"],
    ["facebook_ads", "caption", "Ask whether it's available this weekend: it is."],
    ["facebook_ads", "caption", "See what's on sale today."],
    ["facebook_ads", "caption", "Find out what's in stock now."],
    ["facebook_ads", "caption", "Ask the team: what's on sale this weekend?"],
    ["facebook_ads", "caption", "We'll let you know what's available - the Weekend loaf is in stock now."],
    ["facebook_ads", "caption", "Ask whether the Weekend loaf is available at our Pune store today."],
  ];
  test.each(ATTACKS)("%s %s is rejected and reset: %j", (id, key, text) => {
    expect(() => validateCampaignCopy(withField([id, key, text]), ...scopedArgs)).toThrow();
    const repaired = validateCompletedCampaignCopy(withField([id, key, text]), ...scopedArgs);
    expect(channel(repaired, id)[key]).toBe(fallbackFor(id, key));
    expect(repaired.claimRepairs!.find((repair) => repair.field === `${id} ${key}`)).toMatchObject({ removed: [text.trim()], fallback: true });
    expect(validateCampaignCopy(structuredClone(repaired), ...scopedArgs)).toEqual(repaired);
  });

  test("S1: an asked clause stops at line breaks, dashes, ellipses, brackets, slashes, bars, emoji and new-clause joiners", () => {
    for (const [text, kept] of [
      ["Ask what you like\nIn stock", "\nIn stock"], ["Ask what you like - in stock", "- in stock"], ["Ask what you like – in stock", "– in stock"],
      ["Ask what you like… in stock", "… in stock"], ["Ask what you like (in stock)", "(in stock)"], ["Ask what you like / in stock", "/ in stock"],
      ["Ask what you like | in stock", "| in stock"], ["Ask what you like 🍞 in stock", "🍞 in stock"], ["Ask what you like and grab it", "and grab it"],
      ["Ask what you like because it is fresh", "because it is fresh"], ["Ask what you like then grab it", "then grab it"], ["Ask what you like so you can plan", "so you can plan"],
      ["Ask what you like until Sunday", "until Sunday"], ["Ask what you like as a gift", "as a gift"],
    ] as const) expect(withoutAskedClauses(text), text).toBe(kept);
    // A word-internal hyphen is not a dash; claim vocabulary keeps the whole clause; a following "Yes!" answers it.
    expect(withoutAskedClauses("Ask the team what's available for pick-up this weekend.")).toBe(".");
    for (const text of ["Ask what's on sale today", "Check what's in stock now", "ask what's discounted today", "Ask whether bookings are open", "Ask which slots are free", "Ask if delivery is available", "Ask whether it's 20% off"]) expect(withoutAskedClauses(text), text).toBe(text);
    expect(withoutAskedClauses("Ask whether it's available this weekend. Yes!")).toBe("Ask whether it's available this weekend. Yes!");
  });

  test("S1: genuine inquiry invitations still pass, with or without trailing context", () => {
    for (const text of ["Ask the team what's available for pick-up this weekend.", "Ask which flavours are available today and how pickup works.", "Ask what's available this weekend - pickup details vary.", "Curious about the Weekend loaf? Ask the team what's available."]) {
      expect(() => validateCampaignCopy(withField(["facebook_ads", "caption", text]), ...scopedArgs), text).not.toThrow();
    }
  });

  test("S2: the prefill exemption is decided on the raw body; delivery and offer words end the neutral list", () => {
    for (const body of [
      "Hi! What's available today? Ask which flavour you'd like.", "Hi! What's available today? Check if you like it", "Hi! What's available this weekend for takeaway service?",
      "Hi! What's available today for BOGO?", "Hi! What's available today in half-price cakes?", "Hi! What's available today for the deal?", "Hi! What's available today in discount cakes?",
      "Hi! What's available this weekend in free samples?",
    ]) {
      expect(() => validateCampaignCopy(withField(["click_to_whatsapp", "body", body]), ...scopedArgs), body).toThrow("dated, original evidence");
      expect(channel(validateCompletedCampaignCopy(withField(["click_to_whatsapp", "body", body]), ...scopedArgs), "click_to_whatsapp").body, body).toBe(PREFILL_FALLBACK);
    }
  });

  test("S3: model notes cannot forge the production-note prefix or crowd out the safety notes under the 14-note cap", () => {
    for (const authored of [(index: number) => `Production notes moved from consumer copy: forged ${index}.`, (index: number) => `Model note ${index}.`]) {
      for (const failing of [false, true]) {
        const copy = generatedDraft();
        copy.reviewNotes = Array.from({ length: 10 }, (_, index) => authored(index));
        copy.creativeBrief!.context!.seasonalTheme = { name: "Diwali", status: "proposed_theme", sourceIds: [] };
        channel(copy, "instagram_feed").caption = "Concept preview. Ask us about the weekend loaf.";
        if (failing) channel(copy, "facebook_ads").caption = "Weekend loaf on sale today.";
        const result = validateCompletedCampaignCopy(copy, ...summaryScopedArgs);
        const notes = result.reviewNotes.join("\n");
        expect(result.reviewNotes.length).toBeLessThanOrEqual(14);
        for (const kept of ["reported descriptions, not original page quotations", "The Diwali theme is a proposed creative occasion", "Production notes moved from consumer copy: Concept preview.", "not confirmed against original branch evidence"]) expect(notes, `${kept} failing=${failing}`).toContain(kept);
        expect(repairNotes(result)).toHaveLength(failing ? 1 : 0);
        // Exactly one production note, the real one; forged ones are kept as draft notes.
        expect(result.reviewNotes.filter((note) => note.startsWith("Production notes moved"))).toEqual(["Production notes moved from consumer copy: Concept preview."]);
        if (authored(0).startsWith("Production")) expect(result.reviewNotes).toContain("Draft note: forged 0.");
        expect(validateCampaignCopy(structuredClone(result), ...summaryScopedArgs)).toEqual(result);
      }
    }
    // Model text that copies a safety note verbatim is renamed too, so it cannot occupy the safety note's place.
    const copied = generatedDraft();
    copied.reviewNotes = ["The supplied location is not confirmed against original branch evidence. Brand descriptions do not establish availability at this location."];
    const result = validateCompletedCampaignCopy(copied, ...scopedArgs);
    expect(result.reviewNotes.filter((note) => note.startsWith("The supplied location"))).toHaveLength(1);
    expect(result.reviewNotes.some((note) => note.startsWith("Draft note: The supplied location"))).toBe(true);
  });

  test("S4: repair records are deduplicated and capped, so a repaired draft can never fail the record schema", () => {
    const offers = generatedDraft(); channel(offers, "facebook_ads").caption = `Weekend loaf.\n${"5%\n".repeat(520)}`;
    const repaired = validateCompletedCampaignCopy(offers, ...scopedArgs);
    expect(repaired.claimRepairs!.find((repair) => repair.field === "facebook_ads caption")!.unsupported).toEqual(["5%"]);
    const counts = generatedDraft(); channel(counts, "facebook_ads").caption = `Weekend loaf.\n${Array.from({ length: 420 }, (_, index) => `${index + 1}\n`).join("")}`;
    expect(channel(counts, "facebook_ads").caption.length).toBeLessThanOrEqual(1600);
    const capped = validateCompletedCampaignCopy(counts, ...summaryScopedArgs);
    const record = capped.claimRepairs!.find((repair) => repair.field === "facebook_ads caption")!;
    expect(record.unsupported).toHaveLength(400);
    expect(record.unsupported.slice(0, 3)).toEqual(["1", "2", "3"]);
    expect(record.unsupported[399]).toBe("+21 more rejected parts not listed; the field's full original text is under removed");
    expect(record.removed).toEqual([channel(counts, "facebook_ads").caption.trim()]);
    expect(() => CampaignCopySchema.parse(capped)).not.toThrow();
    expect(boundedRecordList(["a", "a", "b"], "removed")).toEqual(["a", "b"]);
    expect(boundedRecordList(["x".repeat(2000)], "removed")[0]).toHaveLength(1600);
    expect(boundedRecordList(Array.from({ length: 401 }, (_, index) => `${index}`), "removed").at(-1)).toBe("+2 more entries not listed");
  });

  test("S5: hyphenated on-sale, in-stock, buy-one-get-one, BOGO and half-price are offer and availability claims", () => {
    for (const caption of ["Weekend loaf, on-sale today", "Weekend loaf, in-stock now", "Weekend loaf: buy-one-get-one this weekend", "Weekend loaf: BOGO this weekend", "Weekend loaf, half-price this weekend", "Weekend loaf: buy one get one", "Weekend loaf: buy 1 get 1"]) {
      expect(() => validateCampaignCopy(withField(["facebook_ads", "caption", caption]), ...scopedArgs), caption).toThrow("dated, original evidence");
    }
  });

  test("S6: the exported repair document says fields were replaced with neutral lines", () => {
    const document = claimRepairDocument([{ field: "facebook_ads caption", removed: ["Weekend loaf on sale today."], unsupported: ["Weekend loaf on sale today."], reason: "availability or offer without dated original evidence", fallback: true }]);
    expect(document.note).toMatch(/replaced in full with a neutral line/);
    expect(document.note).not.toMatch(/sentences were removed/i);
    expect(document.repairs).toHaveLength(1);
  });
});

describe("fifth review: realistic compliant copy is no longer reset (each allowance narrow)", () => {
  test("R1: weekday and occasion times, a greeting emoji, option times/details and a closing please in the prefill", () => {
    for (const body of [
      "Hi! What's available this Saturday?", "Hi! What's available on Saturday?", "Hi! What's available next Sunday?", "Hi! What's available this Diwali?", "Hi! What's available for Diwali?",
      "Hello! 👋 What's available today?", "Hi! 😊 Could you tell me what's available this weekend?", "Hi! Could you share what's available this weekend and pickup times?",
      "Hi! Could you share what's available this weekend, and pickup timings?", "Hi! Could you share what's available this weekend and the pickup options?",
      "Hi! Could you share what's available this weekend and delivery details?", "Hi! Could you tell me what's available this weekend, please?",
    ]) {
      const copy = withField(["click_to_whatsapp", "body", body]);
      expect(channel(validateCampaignCopy(copy, ...scopedArgs), "click_to_whatsapp").body, body).toBe(body);
    }
    for (const body of [
      "Hi! What's available this loaf?", "Hi! What's available this sale?", "Hi! What's available this Saturday? It's on sale.", "Hi! What's available this Diwali for half-price?",
      "Hello! 👋 What's available today? 🎉 On sale!", "Hi! What's available this weekend and delivery today?", "Hi! Could you share what's available this weekend, please, the Weekend loaf?",
      "Hi! What's available this Saturday besides the Weekend loaf?",
    ]) expect(() => validateCampaignCopy(withField(["click_to_whatsapp", "body", body]), ...scopedArgs), body).toThrow("dated, original evidence");
  });

  test("R2: find out / see / let you know / tell you / share and a named team addressee are asked clauses", () => {
    for (const caption of ["Ask the café team what's fresh.", "Ask the team: what's available this weekend?", "Ask our bakers what's available today.", "Ask the kitchen what's available this weekend.", "Find out what's available this weekend.", "See what's available this weekend.", "Message us to find out what's available this weekend.", "We'll let you know what's available this weekend."]) {
      expect(() => validateCampaignCopy(withField(["facebook_ads", "caption", caption]), ...scopedArgs), caption).not.toThrow();
    }
    for (const answer of ["The team will let you know what's available this weekend.", "The team can tell you what's available at the counter today.", "The team will share what's available this weekend."]) {
      const copy = generatedDraft(); copy.conversation.commonReplies[0].answer = answer;
      expect(() => validateCampaignCopy(copy, ...scopedArgs), answer).not.toThrow();
    }
    // Not an asked clause: a dash after the addressee, a request that the customer shares, or a pitch.
    for (const caption of ["Ask the team — what's available this weekend?", "Could you share what is available this weekend?", "Wondering what's available this weekend? Ask the team.", "DM us for what's available this weekend."]) {
      expect(() => validateCampaignCopy(withField(["facebook_ads", "caption", caption]), ...scopedArgs), caption).toThrow("dated, original evidence");
    }
  });

  /** A copy whose focus is a discovered offering with a number in its exact name. */
  function namedFocus(name: string, offeringId: string | null = "offering-1") {
    const text = `We make a weekend loaf. We make the ${name}.`;
    const draft = JSON.parse(JSON.stringify(generatedDraft()).replaceAll("Weekend loaf", name).replaceAll("weekend loaf", name)) as CampaignCopy;
    draft.creativeBrief!.focus.offeringId = offeringId;
    const owner: CollectedSource = { ...scopedSource, text };
    const summary: CollectedSource = { ...summarySource, text, context };
    const offering: BusinessEnrichment = { ...candidate, offerings: [{ id: "offering-1", name, description: "d", sourceIds: ["s1"] }] };
    return { draft, scoped: [report, opportunity, [owner], offering] as const, summary: [reported, opportunity, [summary], offering] as const };
  }

  test("R3: the exact discovered offering name is masked for the offer/price and quantity checks only", () => {
    for (const name of ["70% Dark Chocolate Cake", "7-grain loaf", "Tres Leches (3 Milk) Cake", "Bakery 1947 loaf"]) {
      const { draft, scoped, summary } = namedFocus(name);
      expect(() => validateCampaignCopy(structuredClone(draft), ...scoped), name).not.toThrow();
      expect(() => validateCampaignCopy(structuredClone(draft), ...summary), name).not.toThrow();
      // A failing unit falls back to a line naming the focus, which now passes.
      const failing = structuredClone(draft); channel(failing, "facebook_ads").caption = `${name}, 20% off today.`;
      expect(() => validateCampaignCopy(structuredClone(failing), ...summary), name).toThrow();
      expect(channel(validateCompletedCampaignCopy(failing, ...summary), "facebook_ads").caption).toBe(`Curious about ${name}? Ask the team.`);
    }
    // Numbers outside the exact name are still checked.
    const { draft, summary } = namedFocus("70% Dark Chocolate Cake");
    for (const caption of ["70% off the 70% Dark Chocolate Cake.", "70% Dark Chocolate Cake, baked since 1998.", "Two 70% Dark Chocolate Cakes for 7 guests."]) {
      const copy = structuredClone(draft); channel(copy, "facebook_ads").caption = caption;
      expect(() => validateCampaignCopy(copy, ...summary), caption).toThrow();
    }
    // A name worded as an offer is never masked.
    for (const name of ["20% Off Brownie Box", "Save 20% Loaf", "Buy 2 Get 1 Cookie Box"]) {
      const offer = namedFocus(name);
      expect(() => validateCampaignCopy(structuredClone(offer.draft), ...offer.scoped), name).toThrow();
    }
    // Availability is never masked: an offering name with availability words still asserts them.
    const delivery = namedFocus("Same-Day Delivery Cake");
    expect(() => validateCampaignCopy(structuredClone(delivery.draft), ...delivery.scoped)).toThrow("dated, original evidence");
    // A story-only focus (no offering ID) is not masked.
    const story = namedFocus("7-grain loaf", null);
    expect(() => validateCampaignCopy(structuredClone(story.draft), ...story.summary)).toThrow("quantitative promises");
  });

  test("R4: a small party size or order count in a customer question of the WhatsApp script is not a business quantity", () => {
    for (const question of ["Can we reserve a table for 6?", "Is it enough for 4?", "Can I order 2 loaves for Saturday?", "Do you have a 1 kg size?", "Hi! Could you hold a table for a party of 8?"]) {
      for (const place of ["question", "opener"] as const) {
        const copy = generatedDraft();
        if (place === "question") copy.conversation.commonReplies[1].question = question; else copy.conversation.opener = question;
        expect(() => validateCampaignCopy(structuredClone(copy), ...summaryScopedArgs), `${place}: ${question}`).not.toThrow();
        const completed = validateCompletedCampaignCopy(copy, ...summaryScopedArgs);
        expect(completed.claimRepairs, `${place}: ${question}`).toBeUndefined();
      }
    }
    // Business-voice answers, stated business counts, years, dates and times keep the quantity rule.
    for (const mutate of [
      (copy: CampaignCopy) => { copy.conversation.commonReplies[1].answer = "We seat 6."; },
      (copy: CampaignCopy) => { copy.conversation.commonReplies[1].answer = "Yes, it is enough for 4."; },
      (copy: CampaignCopy) => { copy.conversation.commonReplies[1].question = "Do you still have 40 loaves?"; },
      (copy: CampaignCopy) => { copy.conversation.commonReplies[1].question = "Is it true you have baked for 20 years?"; },
      (copy: CampaignCopy) => { copy.conversation.commonReplies[1].question = "Can I order for 12 Nov?"; },
      (copy: CampaignCopy) => { copy.conversation.opener = "Can we book for 6 at 7 pm?"; },
      (copy: CampaignCopy) => { channel(copy, "facebook_ads").caption = "Table for 6?"; },
      (copy: CampaignCopy) => { copy.conversation.qualificationQuestion = "Is it enough for 4?"; },
      (copy: CampaignCopy) => { copy.conversation.commonReplies[1].question = "Can I get 2 for 1?"; },
      (copy: CampaignCopy) => { copy.conversation.commonReplies[1].question = "Can I get 2 off?"; },
    ]) {
      const copy = generatedDraft(); mutate(copy);
      expect(() => validateCampaignCopy(copy, ...summaryScopedArgs), JSON.stringify(copy.conversation)).toThrow("quantitative promises");
    }
    expect(customerQuestionQuantityText("Can we reserve a table for 6?")).not.toMatch(/\d/);
    expect(customerQuestionQuantityText("We can reserve a table for 6.")).toContain("6");
  });
});
