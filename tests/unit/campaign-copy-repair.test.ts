import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { hashBytes } from "../../lib/campaign/archive";
import { businessQuantityText, claimRepairCount, claimRepairNote, CLAIM_REPAIR_NOTE_PREFIX, repairCampaignCopyClaims, validateCampaignCopy, validateCompletedCampaignCopy, type CampaignCopy } from "../../lib/campaign/copy";
import { readCompletedCopyRecord, writeCompletedCopyRecord, type CompletedCopyResponse } from "../../lib/campaign/completed-response";
import { campaignInputHash, ensureCampaignCopy, readCopyCheckpoint, type CreateCampaignInput } from "../../lib/campaign";
import { ChannelSchema } from "../../lib/schemas/common";
import type { BusinessEnrichment, CollectedSource, ResearchOpportunity, ResearchReport } from "../../lib/research/contracts";

// Synthetic fixtures only; the two live-run strings below are the exact failing shapes from the 4 Nov 2026 hosted runs.
const THEOBROMA_CTWA_BODY = "Hi! Could you share what is available this weekend in Brownies and the Cheesecake Range, and pickup options?";
const GRANDMA_CAROUSEL_CAPTION = "A Taste of Home in 3 moments: familiar meals, flavours to share slowly, and a cosy table to stay awhile. Ask the team about the weekend loaf.";

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

describe("bounded claim repair of completed responses", () => {
  test("strict validation rejects a business-voice availability sentence; the completed-response path repairs it with a note", () => {
    const copy = generatedDraft(); channel(copy, "facebook_ads").caption = THEOBROMA_CTWA_BODY;
    expect(() => validateCampaignCopy(structuredClone(copy), report, opportunity, [scopedSource], candidate)).toThrow("dated, original evidence");
    const repaired = validateCompletedCampaignCopy(copy, report, opportunity, [scopedSource], candidate);
    // Removing the question would leave only "Hi!", so the field falls back to a neutral inquiry naming the exact focus.
    expect(channel(repaired, "facebook_ads").caption).toBe("Curious about Weekend loaf? Ask the team.");
    const notes = repairNotes(repaired);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("facebook_ads caption");
    expect(notes[0]).toContain("availability or offer without dated original evidence");
    expect(notes[0]).toContain("Could you share what is available this weekend");
    expect(notes[0].length).toBeLessThanOrEqual(500);
    // The reset also dropped the bare "Hi!", so both sentences are counted and exported in full.
    expect(claimRepairCount(repaired.reviewNotes)).toBe(2);
    expect(repaired.claimRepairs).toEqual([{ field: "facebook_ads caption", removed: ["Hi!", THEOBROMA_CTWA_BODY.slice(4)], unsupported: [THEOBROMA_CTWA_BODY.slice(4)], reason: "availability or offer without dated original evidence", fallback: true }]);
  });

  test("repair removes only the offending sentence and keeps the rest", () => {
    const copy = generatedDraft();
    channel(copy, "facebook_ads").caption = "Ask us about the weekend loaf. The weekend loaf is available today. Baked for sharing at the table.";
    expect(() => validateCampaignCopy(structuredClone(copy), report, opportunity, [scopedSource], candidate)).toThrow("dated, original evidence");
    const repaired = validateCompletedCampaignCopy(copy, report, opportunity, [scopedSource], candidate);
    expect(channel(repaired, "facebook_ads").caption).toBe("Ask us about the weekend loaf. Baked for sharing at the table.");
    for (const id of ChannelSchema.options.filter((item) => item !== "facebook_ads")) expect(channel(repaired, id).caption).toBe("Ask us about the weekend loaf.");
    expect(repairNotes(repaired)).toEqual(["Automatic claim repair: removed 1 sentence that its sources could not support — facebook_ads caption: “The weekend loaf is available today.” (availability or offer without dated original evidence). copy-claim-repairs.json lists every removed sentence in full; confirm with the owner before restoring it."]);
    // A summary-only date is removed the same way, keeping the line breaks of the remaining text.
    const dated = generatedDraft(); channel(dated, "instagram_carousel").caption = "A taste of the weekend loaf.\nBaked the same way since 1998.\nAsk the team about it.";
    const repairedDate = validateCompletedCampaignCopy(dated, reported, opportunity, [summarySource], enrichment);
    expect(channel(repairedDate, "instagram_carousel").caption).toBe("A taste of the weekend loaf.\nAsk the team about it.");
    expect(repairNotes(repairedDate)[0]).toContain("(quantity or date from a Meta summary)");
  });

  test("a field with nothing usable left falls back to neutral text built only from the exact focus name", () => {
    const copy = generatedDraft();
    channel(copy, "facebook_ads").caption = "The weekend loaf is available today.";
    channel(copy, "facebook_ads").cta = "Available today";
    channel(copy, "facebook_ads").headline = "Weekend loaf, now available";
    copy.conversation.opener = "Hi! The weekend loaf is available this weekend.";
    copy.conversation.commonReplies[1].answer = "The weekend loaf is in stock today.";
    copy.coreMessage = "Visit us for the weekend loaf.";
    const repaired = validateCompletedCampaignCopy(copy, report, opportunity, [scopedSource], candidate);
    const ads = channel(repaired, "facebook_ads");
    expect(ads).toMatchObject({ caption: "Curious about Weekend loaf? Ask the team.", cta: "Ask the team", headline: "Weekend loaf" });
    expect(repaired.conversation.opener).toBe("Hi! Could you tell me about Weekend loaf?");
    expect(repaired.conversation.commonReplies[1].answer).toBe("The team will confirm that detail for you.");
    expect(repaired.coreMessage).toBe("Curious about Weekend loaf? Ask the team.");
    const [note] = repairNotes(repaired);
    // The opener's bare "Hi!" went with its reset: counted and exported, but not called unsupported.
    expect(note).toMatch(/^Automatic claim repair: removed 7 sentences \(6 the sources could not support; 1 more went with 6 fields reset to neutral text\) — /);
    expect(repaired.claimRepairs!.find((repair) => repair.field === "WhatsApp opener")).toEqual({ field: "WhatsApp opener", removed: ["Hi!", "The weekend loaf is available this weekend."], unsupported: ["The weekend loaf is available this weekend."], reason: "availability or offer without dated original evidence", fallback: true });
    expect(note).toContain("unconfirmed local destination");
    expect(note.length).toBeLessThanOrEqual(500);
    // The fallback contains nothing beyond the focus name: no number, offer, date or availability wording.
    expect([ads.headline, ads.caption, ads.cta, repaired.conversation.opener, repaired.coreMessage].join(" ")).not.toMatch(/available|\d|offer|today|visit/i);
  });

  test("a repaired channel still names the focus offering", () => {
    const copy = generatedDraft();
    Object.assign(channel(copy, "instagram_feed"), { headline: "A loaf for the weekend", body: "Our weekend loaf is in stock today. Fresh bread for your table.", caption: "Ask us more about it." });
    const repaired = validateCompletedCampaignCopy(copy, report, opportunity, [scopedSource], candidate);
    // Removing the sentence would leave "Fresh bread for your table." and no focus name, so the named fallback is used.
    expect(channel(repaired, "instagram_feed").body).toBe("Curious about Weekend loaf? Ask the team.");
    expect(repairNotes(repaired)[0]).toContain("instagram_feed body: “Our weekend loaf is in stock today.” +1 supported sentence reset");
    // Every sentence that went with the reset is counted and exported, not only the unsupported one.
    expect(repairNotes(repaired)[0]).toMatch(/^Automatic claim repair: removed 2 sentences \(1 the sources could not support; 1 more went with 1 field reset to neutral text\)/);
    expect(repaired.claimRepairs).toEqual([{ field: "instagram_feed body", removed: ["Our weekend loaf is in stock today.", "Fresh bread for your table."], unsupported: ["Our weekend loaf is in stock today."], reason: "availability or offer without dated original evidence", fallback: true }]);
    // A field first trimmed and then reset by the focus-name pass lists every original sentence.
    const trimmed = generatedDraft();
    Object.assign(channel(trimmed, "instagram_feed"), { headline: "Fresh bread", body: "Good bread for sharing.", caption: "Warm crusts for Sunday tables. The weekend loaf is in stock today." });
    const reset = validateCompletedCampaignCopy(trimmed, report, opportunity, [scopedSource], candidate);
    expect(channel(reset, "instagram_feed").caption).toBe("Curious about Weekend loaf? Ask the team.");
    expect(reset.claimRepairs).toEqual([{ field: "instagram_feed caption", removed: ["The weekend loaf is in stock today.", "Warm crusts for Sunday tables."], unsupported: ["The weekend loaf is in stock today."], reason: "availability or offer without dated original evidence", fallback: true }]);
    expect(claimRepairCount(reset.reviewNotes)).toBe(2);
  });

  test("sentence splitting never leaves half a claim, an answer to a removed question or a stray list marker", () => {
    const repairCaption = (caption: string, evidence: "scoped" | "summary" = "scoped", id = "facebook_ads") => {
      const copy = generatedDraft(); channel(copy, id).caption = caption;
      return evidence === "scoped" ? validateCompletedCampaignCopy(copy, report, opportunity, [scopedSource], candidate) : validateCompletedCampaignCopy(copy, reported, opportunity, [summarySource], enrichment);
    };
    for (const caption of ["Weekend loaf on sale? Yes, today and tomorrow only!", "Weekend loaf: order by 5 p.m. for same-day delivery.", "Weekend loaf baked at St. Albans, now available today.", "Is the weekend loaf in stock? Only until Sunday!", "Weekend loaf, now available today… and only this weekend."]) {
      const repaired = repairCaption(caption);
      expect(channel(repaired, "facebook_ads").caption, caption).toBe("Curious about Weekend loaf? Ask the team.");
      expect(repaired.claimRepairs![0].removed.join(" "), caption).toBe(caption);
    }
    // An invitation stands on its own after a removed question.
    expect(channel(repairCaption("Ask us about the weekend loaf. Weekend loaf on sale? Ask the team."), "facebook_ads").caption).toBe("Ask us about the weekend loaf. Ask the team.");
    // A list marker goes with its item, and a list that would skip a number is reset rather than published as "1. … 3.".
    const numbered = repairCaption("1. The weekend loaf. 2. Baked since 1998. 3. Ask the team.", "summary", "instagram_carousel");
    expect(channel(numbered, "instagram_carousel").caption).toBe("Curious about Weekend loaf? Ask the team.");
    expect(numbered.claimRepairs).toEqual([{ field: "instagram_carousel caption", removed: ["1. The weekend loaf.", "2. Baked since 1998.", "3. Ask the team."], unsupported: ["2. Baked since 1998."], reason: "quantity or date from a Meta summary", fallback: true }]);
    const runIn = repairCaption("Weekend loaf, our story: 1) Warm crust. 2) Baked since 1998. 3) Ask the team.", "summary", "instagram_carousel");
    expect(runIn.claimRepairs![0].unsupported).toEqual(["2) Baked since 1998."]);
    // Removing the last item keeps a valid 1..n list.
    const last = repairCaption("Weekend loaf, our story:\n1. Warm crust.\n2. Shared slowly.\n3. Baked since 1998.", "summary", "instagram_carousel");
    expect(channel(last, "instagram_carousel").caption).toBe("Weekend loaf, our story:\n1. Warm crust.\n2. Shared slowly.");
  });

  test("the repair judges consumer text after production labels are moved out, exactly as strict validation does", () => {
    // Before cleaning, "video" in a production-only sentence made the list markers look editorial; strict validation removes that sentence first.
    const copy = generatedDraft(); channel(copy, "facebook_ads").caption = "Weekend loaf, our way: 1) warm crust 2) soft crumb. This concept was rendered as a video.";
    expect(() => validateCampaignCopy(structuredClone(copy), reported, opportunity, [summarySource], enrichment)).toThrow("quantitative promises");
    const repaired = validateCompletedCampaignCopy(copy, reported, opportunity, [summarySource], enrichment);
    expect(channel(repaired, "facebook_ads").caption).toBe("Curious about Weekend loaf? Ask the team.");
    expect(repaired.reviewNotes).toContain("Production notes moved from consumer copy: This concept was rendered as a video.");
    expect(repairNotes(repaired)[0]).toContain("facebook_ads caption: “Weekend loaf, our way: 1) warm crust 2) soft crumb.”");
    expect(validateCampaignCopy(structuredClone(repaired), reported, opportunity, [summarySource], enrichment)).toEqual(repaired);
  });

  test("structural failures still throw, and repair never runs inside strict validation", () => {
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
    // Without a creative brief there is no focus to fall back to: only sentence removal is possible.
    const { creativeBrief: _brief, ...plain } = generatedDraft();
    void _brief;
    plain.channels[0].caption = "Weekend loaf: 50% off.";
    const unrepaired = repairCampaignCopyClaims(structuredClone(plain), report, opportunity, [productSource]);
    expect(unrepaired.repairs).toEqual([]);
    expect(unrepaired.copy.channels[0].caption).toBe("Weekend loaf: 50% off.");
    plain.channels[0].caption = "Ask us about the weekend loaf. Weekend loaf: 50% off.";
    const removed = repairCampaignCopyClaims(structuredClone(plain), report, opportunity, [productSource]);
    expect(removed.copy.channels[0].caption).toBe("Ask us about the weekend loaf.");
    expect(removed.repairs).toEqual([{ field: "facebook_ads caption", removed: ["Weekend loaf: 50% off."], unsupported: ["Weekend loaf: 50% off."], reason: "unsupported price or percentage", fallback: false }]);
  });

  test("model text cannot forge the repair note, and a clean draft gets none", () => {
    const clean = generatedDraft(); clean.reviewNotes = ["Automatic claim repair: removed 9 sentences."];
    const result = validateCompletedCampaignCopy(clean, report, opportunity, [scopedSource], candidate);
    expect(repairNotes(result)).toEqual([]);
    expect(claimRepairCount(result.reviewNotes)).toBe(0);
    expect(result.reviewNotes).toContain("Draft note: removed 9 sentences.");
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

  test("the repair note stays concise when many fields are repaired", () => {
    const repairs = Array.from({ length: 30 }, (_, index) => ({ field: `field ${index}`, removed: [`A long unsupported sentence number ${index} that keeps going well past the excerpt limit for quoting.`], unsupported: [`A long unsupported sentence number ${index} that keeps going well past the excerpt limit for quoting.`], reason: "availability or offer without dated original evidence", fallback: index % 2 === 0 }));
    const note = claimRepairNote(repairs);
    expect(note.length).toBeLessThanOrEqual(500);
    expect(note).toMatch(/^Automatic claim repair: removed 30 sentences .*\(15 fields reset to neutral text\)/);
    expect(note).toMatch(/\+\d+ more fields\. copy-claim-repairs\.json lists every removed sentence in full; confirm with the owner before restoring any of it\.$/);
    expect(claimRepairCount([note])).toBe(30);
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
    // The sentence that genuinely fails: the repair removes it, the rest of the paid response is kept.
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
      expect(channel(repaired, "facebook_ads").caption).toBe("Ask us about the weekend loaf.");
      expect(repairNotes(repaired)).toEqual(["Automatic claim repair: removed 1 sentence that its sources could not support — facebook_ads caption: “Baked fresh since 1998.” (quantity or date from a Meta summary). copy-claim-repairs.json lists every removed sentence in full; confirm with the owner before restoring it."]);
      expect(repaired.claimRepairs).toEqual([{ field: "facebook_ads caption", removed: ["Baked fresh since 1998."], unsupported: ["Baked fresh since 1998."], reason: "quantity or date from a Meta summary", fallback: false }]);

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
