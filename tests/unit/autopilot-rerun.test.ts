import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CampaignKit, RunView } from "@/lib/research/contracts";
import { ResearchInputSchema } from "@/lib/research/contracts";
import { DEFAULT_CAMPAIGN_GOAL } from "@/lib/businesses/input";
import { emptyPublicState, type AutopilotPublicState } from "@/lib/autopilot/public-state";
import { composeGoal, deriveMediaRevision, fnv1a64, mediaRevisionInput, mediaRevisionSource, noRealMedia, normalizeBusinessLink, resolveOAuthReturn, restoreSearch, restoreTarget } from "@/components/autopilot/model";
import { DirectorsRoom } from "@/components/autopilot/directors-room";
import { AutopilotReady } from "@/components/autopilot/autopilot-ready";
import { RealMediaCard } from "@/components/autopilot/real-media-card";
import { MediaDropzone } from "@/components/autopilot/media-dropzone";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const sources = (patch: Partial<AutopilotPublicState["sources"]> = {}) => ({ officialWebsite: 0, ownerUploads: 0, ownerInstagram: 0, ownerFacebook: 0, connected: false, ...patch });
const plan = (reelMode: NonNullable<AutopilotPublicState["plan"]>["reelMode"]) => ({ heroAssetId: null, carousel: [], reelMode, reelReasons: [], channelAssets: {}, notes: [] }) as unknown as AutopilotPublicState["plan"];
function state(patch: Partial<AutopilotPublicState> = {}): AutopilotPublicState { return { ...emptyPublicState(RUN_ID), ...patch }; }
const kit = { id: "synthetic-campaign", opportunityId: "o1", name: "Synthetic kit", coreMessage: "m", objective: "o", audienceHypothesis: "a", primaryCta: "c", reviewNotes: [], channels: [], assets: [] } as unknown as CampaignKit;
function run(patch: Partial<RunView> = {}): RunView {
  return { id: RUN_ID, businessId: BUSINESS_ID, stage: "needs_review", status: "completed", createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z", mode: "live", error: null,
    business: { id: BUSINESS_ID, name: "Synthetic Cafe", website: "https://synthetic-cafe.example/", locality: "", vertical: "", goal: "Fill our quiet weekday mornings" }, sources: [], report: null, campaign: kit, events: [], usage: [], autopilot: true, ...patch } as unknown as RunView;
}

describe("no-real-media detection", () => {
  it("is unknown while harvesting, before a failed harvest, or with no state", () => {
    expect(noRealMedia(null)).toBeNull();
    expect(noRealMedia(state({ phase: "harvest" }))).toBeNull();
    expect(noRealMedia(state({ phase: "failed" }))).toBeNull();
  });
  it("fires once harvesting gathered nothing from the website, uploads or connected accounts", () => {
    expect(noRealMedia(state({ phase: "analyze", sources: sources() }))).toEqual({ reason: "none_gathered", connected: false });
    expect(noRealMedia(state({ phase: "done", sources: sources({ connected: true }) }))).toEqual({ reason: "none_gathered", connected: true });
  });
  it("stays quiet whenever any real media was harvested and used", () => {
    for (const key of ["officialWebsite", "ownerUploads", "ownerInstagram", "ownerFacebook"] as const) {
      expect(noRealMedia(state({ phase: "done", sources: sources({ [key]: 1 }), plan: plan("still_depth") }))).toBeNull();
    }
    expect(noRealMedia(state({ phase: "done", sources: sources({ ownerUploads: 2 }), plan: plan("tracked_video") }))).toBeNull();
  });
  it("fires for an illustration plan, naming the honest reason", () => {
    expect(noRealMedia(state({ phase: "done", sources: sources({ officialWebsite: 3 }), plan: plan("illustration") }))).toEqual({ reason: "none_usable", connected: false });
    expect(noRealMedia(null, { reelMode: "illustration" })).toEqual({ reason: "illustration", connected: false });
    expect(noRealMedia(null, { reelMode: "still_depth" })).toBeNull();
  });
});

describe("media revision", () => {
  const connection = { status: "connected", accountName: "@synthetic", instagramUsername: "synthetic", pageName: "Synthetic Cafe" };
  it("is deterministic and independent of asset order or duplicates", async () => {
    const a = await deriveMediaRevision(["b", "a", "c"], connection);
    const b = await deriveMediaRevision(["c", "a", "b", "a"], { ...connection });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(createHash("sha256").update(mediaRevisionInput(["a", "b", "c"], connection)).digest("hex"));
    expect(ResearchInputSchema.safeParse({ mode: "live", readWebsite: true, sources: [], mediaRevision: a }).success).toBe(true);
  });
  it("changes with a new upload, a removed upload, or a new connection", async () => {
    const base = await deriveMediaRevision(["a"], { status: "disconnected" });
    expect(await deriveMediaRevision(["a", "b"], { status: "disconnected" })).not.toBe(base);
    expect(await deriveMediaRevision([], { status: "disconnected" })).not.toBe(base);
    expect(await deriveMediaRevision(["a"], { status: "connected", instagramUsername: "synthetic" })).not.toBe(base);
    expect(await deriveMediaRevision(["a"], { status: "connected", instagramUsername: "other" })).not.toBe(await deriveMediaRevision(["a"], { status: "connected", instagramUsername: "synthetic" }));
  });
  it("falls back to a valid 64-bit value without Web Crypto", async () => {
    const value = await deriveMediaRevision(["a"], null, null);
    expect(value).toMatch(/^[a-f0-9]{16}$/);
    expect(value).toBe(await deriveMediaRevision(["a"], null, null));
    expect(fnv1a64(new Uint8Array())).toBe("cbf29ce484222325");
    expect(ResearchInputSchema.safeParse({ mode: "live", readWebsite: true, sources: [], mediaRevision: value }).success).toBe(true);
  });
  it("uses the server library, else the locally known one, else none", () => {
    const local = { assetIds: ["local-1"], connection: { status: "disconnected" } };
    const server = { assets: [{ id: "a" }, { id: "b" }], connection: { status: "connected", instagramUsername: "synthetic" } };
    expect(mediaRevisionSource(server, local)).toEqual({ assetIds: ["a", "b"], connection: server.connection });
    // Unreadable library (request failed, or the server reports mediaError): files this intake uploaded still count.
    expect(mediaRevisionSource(null, local)).toBe(local);
    expect(mediaRevisionSource({ ...server, assets: [], mediaError: "unreadable" }, local)).toBe(local);
    expect(mediaRevisionSource(null, { assetIds: [], connection: null })).toBeNull();
    expect(mediaRevisionSource(null, null)).toBeNull();
  });
  it("is optional and validated by the strict run input schema", () => {
    expect(ResearchInputSchema.safeParse({ mode: "live", readWebsite: true, sources: [] }).success).toBe(true);
    for (const bad of ["", "abc", "Z".repeat(32), "a".repeat(65)]) expect(ResearchInputSchema.safeParse({ mode: "live", readWebsite: true, sources: [], mediaRevision: bad }).success).toBe(false);
  });
});

describe("restore target for adding media", () => {
  const saved = (patch: Partial<{ website: string | null; goal: string }> = {}) => ({ website: "https://synthetic-cafe.example/", goal: "Fill our quiet weekday mornings", ...patch });
  it("keeps the same business, link and goal, composed exactly as the intake compares them", () => {
    const target = restoreTarget(BUSINESS_ID, saved());
    expect(target).toEqual({ businessId: BUSINESS_ID, url: "https://synthetic-cafe.example/", goal: "Fill our quiet weekday mornings", link: "https://synthetic-cafe.example/", goalId: null, goalText: "Fill our quiet weekday mornings" });
    // The intake treats the draft as unchanged: same normalized link and composed goal.
    const normalized = normalizeBusinessLink(target!.link);
    expect(normalized.ok && normalized.url).toBe(target!.url);
    expect(composeGoal(target!.goalId, target!.goalText)).toBe(target!.goal);
  });
  it("restores the link the owner pasted, not the official site discovery matched for the run", () => {
    const pasted = "https://maps.app.goo.gl/SyntheticCafe1";
    // RunView.business carries discovery's official website; the persisted row keeps the pasted Maps link.
    const discovered = run({ business: { ...run().business, website: "https://synthetic-cafe.example/" } });
    const target = restoreTarget(discovered.businessId, saved({ website: pasted }))!;
    expect(target.link).toBe(pasted);
    expect(target.link).not.toBe(discovered.business.website);
    const normalized = normalizeBusinessLink(pasted);
    expect(normalized.ok && normalized.kind).toBe("maps");
    expect(normalized.ok && normalized.url).toBe(target.url);
    expect(target.businessId).toBe(BUSINESS_ID);
  });
  it("leaves the server default goal blank and normalizes whitespace in a custom goal", () => {
    expect(restoreTarget(BUSINESS_ID, saved({ goal: DEFAULT_CAMPAIGN_GOAL }))).toMatchObject({ goal: "", goalText: "" });
    const spaced = restoreTarget(BUSINESS_ID, saved({ goal: "Weekday   breakfast" }))!;
    expect(composeGoal(spaced.goalId, spaced.goalText)).toBe(spaced.goal);
  });
  it("restores a goal composed from a chip as that chip and its extra words", () => {
    const quiet = composeGoal("quiet", "");
    expect(restoreTarget(BUSINESS_ID, saved({ goal: quiet }))).toMatchObject({ goalId: "quiet", goalText: "", goal: quiet });
    const launch = composeGoal("launch", "our pistachio croissant");
    const target = restoreTarget(BUSINESS_ID, saved({ goal: launch }))!;
    expect(target).toMatchObject({ goalId: "launch", goalText: "our pistachio croissant." });
    expect(composeGoal(target.goalId, target.goalText)).toBe(launch);
  });
  it("returns null without a usable link or business id", () => {
    expect(restoreTarget(BUSINESS_ID, saved({ website: null }))).toBeNull();
    expect(restoreTarget("not-a-uuid", saved())).toBeNull();
  });
  it("marks the intake URL so the existing draft restore picks it up", () => {
    const search = restoreSearch("?run=abc&connected=meta&tab=x", BUSINESS_ID);
    const params = new URLSearchParams(search);
    expect(params.get("business")).toBe(BUSINESS_ID);
    expect(params.has("run")).toBe(false);
    expect(params.has("connected")).toBe(false);
    expect(params.get("tab")).toBe("x");
    expect(resolveOAuthReturn(search, BUSINESS_ID)).toEqual({ businessId: BUSINESS_ID, fromDraft: true, notice: null });
  });
});

describe("no-real-media card", () => {
  const noMedia = state({ phase: "done", sources: sources(), plan: plan("illustration") });
  it("explains what happened, why it matters and how to add owned photos, without suggesting scraping", () => {
    const html = renderToStaticMarkup(createElement(RealMediaCard, { run: run(), state: noMedia, onAddMedia: () => undefined }));
    expect(html).toContain("couldn’t use any real photos of your business this time");
    expect(html).toContain("clearly-labelled illustrations");
    expect(html).toContain("SAM");
    expect(html).toContain("cinematic Reel");
    expect(html).toContain("Add your photos");
    expect(html).toContain("download photos from your own Google Business Profile");
    expect(html).toContain("Only add photos you own");
    expect(html).not.toMatch(/scrap|Tickr reads|we read your Google/i);
  });
  it("never claims there was no connected account when one was connected", () => {
    const connected = state({ phase: "done", sources: sources({ connected: true }), plan: plan("illustration") });
    const html = renderToStaticMarkup(createElement(RealMediaCard, { run: run(), state: connected, onAddMedia: () => undefined }));
    expect(html).toContain("your connected account didn’t provide usable photos");
    expect(html).not.toMatch(/no uploads or connected accounts/);
    const disconnected = renderToStaticMarkup(createElement(RealMediaCard, { run: run(), state: noMedia, onAddMedia: () => undefined }));
    expect(disconnected).toContain("there were no uploads or connected accounts");
  });
  it("says an active run keeps going in the background, without claiming it stays reachable", () => {
    const html = renderToStaticMarkup(createElement(RealMediaCard, { run: run({ status: "running", stage: "creating", campaign: null }), state: { ...noMedia, phase: "copy" }, onAddMedia: () => undefined }));
    expect(html).toContain("keeps going in the background");
    expect(html).not.toContain("stays saved");
    expect(renderToStaticMarkup(createElement(RealMediaCard, { run: run(), state: noMedia, onAddMedia: () => undefined }))).not.toContain("background");
  });
  it("renders nothing when real media was used", () => {
    expect(renderToStaticMarkup(createElement(RealMediaCard, { run: run(), state: state({ phase: "done", sources: sources({ ownerUploads: 1 }), plan: plan("still_depth") }), onAddMedia: () => undefined }))).toBe("");
  });
  it("appears in the director's room and the ready view", () => {
    const room = renderToStaticMarkup(createElement(DirectorsRoom, { run: run({ status: "running", stage: "creating", campaign: null }), state: { ...noMedia, phase: "copy" }, stateStatus: "ready", onRetry: () => undefined, retrying: false, onStudio: () => undefined, onAddMedia: () => undefined }));
    expect(room).toContain("ap-real-media-title");
    expect(room).toContain("will be clearly-labelled illustrations");
    const ready = renderToStaticMarkup(createElement(AutopilotReady, { run: run(), state: noMedia, stateStatus: "ready", onApprove: async () => undefined, onAddMedia: () => undefined }));
    expect(ready).toContain("ap-real-media-title");
  });
  it("adds the Business Profile tip under the dropzone", () => {
    const html = renderToStaticMarkup(createElement(MediaDropzone, { queue: [], uploaded: [], rejected: [], disabled: false, rights: false, people: null, consentError: false, consentRef: { current: null }, onAdd: () => undefined, onRemoveQueued: () => undefined, onRemoveUploaded: () => undefined, onRights: () => undefined, onPeople: () => undefined }));
    expect(html).toContain("Tip: you can download photos from your own Google Business Profile and add them here.");
  });
});
