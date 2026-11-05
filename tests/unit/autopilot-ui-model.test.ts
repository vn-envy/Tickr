import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CampaignKit, RunView } from "@/lib/research/contracts";
import { emptyPublicState, type AutopilotPublicState } from "@/lib/autopilot/public-state";
import { APPROVAL_STATEMENT, LINK_KIND_LABEL, approvableFiles, approvalReview, approvedDownloads, campaignFilename, carouselAssets, clampBox, classifyUpload, composeGoal, connectUrl, deriveRail, directorLog, findingTarget, isOAuthReturn, mediaWallMode, normalizeBusinessLink, offerableArchive, railForStage, reelAsset, resolveOAuthReturn, roleBadges, roomHeadline, serverWithheld, shortDigest, STOPPED_STATE_MAX_RETRIES, stoppedStateRetryDelay, trackingOverlay, uploadUrl, withoutWithheld } from "@/components/autopilot/model";
import { ApprovalBlock } from "@/components/autopilot/autopilot-ready";
import { DirectorsRoom, MediaWall } from "@/components/autopilot/directors-room";
import { MediaDropzone, type QueuedFile } from "@/components/autopilot/media-dropzone";
import { UploadCancelledError, uploadBatch } from "@/components/autopilot/upload-batch";
import { CampaignPanel, ExportPanel } from "@/components/research-panels";
import * as serverApproval from "@/lib/jobs/approval";

const sha = (char: string) => char.repeat(64);
const asset = (filename: string, mediaType: CampaignKit["assets"][number]["mediaType"], channel: CampaignKit["assets"][number]["channel"] = null) => ({ id: filename, channel, filename, mediaType, width: mediaType === "image" ? 1080 : null, height: mediaType === "image" ? 1350 : null, sha256: sha("a"), bytes: 10 });
const campaign = { id: "synthetic-campaign", assets: [asset("instagram_reel.mp4", "video", "instagram_reels"), asset("carousel_10.png", "image", "instagram_carousel"), asset("carousel_2.png", "image", "instagram_carousel"), asset("kit.zip", "archive"), asset("feed.png", "image", "instagram_feed")] } as unknown as CampaignKit;
const run = (patch: Partial<RunView>) => ({ stage: "created", status: "running", campaign: null, events: [], ...patch }) as Pick<RunView, "stage" | "status" | "campaign" | "events">;
function state(patch: Partial<AutopilotPublicState> = {}): AutopilotPublicState { return { ...emptyPublicState("synthetic-run"), ...patch }; }

describe("autopilot intake helpers", () => {
  it("normalizes the link forms owners paste", () => {
    expect(normalizeBusinessLink("maps.app.goo.gl/abc123")).toMatchObject({ ok: true, url: "https://maps.app.goo.gl/abc123", kind: "maps" });
    expect(normalizeBusinessLink("https://www.google.com/maps/place/Synthetic+Cafe")).toMatchObject({ ok: true, kind: "maps" });
    expect(normalizeBusinessLink("@synthetic.cafe")).toMatchObject({ ok: true, url: "https://www.instagram.com/synthetic.cafe/", kind: "instagram" });
    expect(normalizeBusinessLink("synthetic-cafe.example")).toMatchObject({ ok: true, url: "https://synthetic-cafe.example/", kind: "website" });
    expect(normalizeBusinessLink("https://facebook.com/synthetic")).toMatchObject({ ok: true, kind: "facebook" });
    expect(normalizeBusinessLink("https://www.google.com/search?q=cafe")).toMatchObject({ ok: true, kind: "website" });
    const share = normalizeBusinessLink("share.google/FVjbnawViHJw2GdDg");
    expect(share).toMatchObject({ ok: true, url: "https://share.google/FVjbnawViHJw2GdDg", kind: "maps", host: "share.google" });
    expect(share.ok && LINK_KIND_LABEL[share.kind]).toBe("Google Maps listing");
    expect(normalizeBusinessLink("https://share.google/")).toMatchObject({ ok: true, kind: "website" });
  });
  it("rejects credentials, non-web schemes and fragments", () => {
    expect(normalizeBusinessLink("").ok).toBe(false);
    expect(normalizeBusinessLink("https://user:pass@example.com").ok).toBe(false);
    expect(normalizeBusinessLink("ftp://example.com").ok).toBe(false);
    expect(normalizeBusinessLink("javascript:alert(1)").ok).toBe(false);
    expect(normalizeBusinessLink("just words").ok).toBe(false);
  });
  it("composes the goal from a chip and free text, or leaves it to the server default", () => {
    expect(composeGoal(null, "  ")).toBe("");
    expect(composeGoal("quiet", "")).toMatch(/quieter hours/);
    expect(composeGoal("launch", "our pistachio croissant")).toMatch(/excited to try it\. our pistachio croissant\.$/);
    expect(composeGoal(null, "Weekday breakfast!")).toBe("Weekday breakfast!");
    expect(composeGoal(null, "x".repeat(3000))).toHaveLength(2000);
  });
  it("pre-checks upload types and size limits", () => {
    expect(classifyUpload({ name: "a.jpg", type: "image/jpeg", size: 1000 })).toEqual({ ok: true, kind: "image", mimeType: "image/jpeg" });
    expect(classifyUpload({ name: "clip.MOV", type: "", size: 1000 })).toEqual({ ok: true, kind: "video", mimeType: "video/quicktime" });
    expect(classifyUpload({ name: "a.gif", type: "image/gif", size: 1000 }).ok).toBe(false);
    expect(classifyUpload({ name: "a.png", type: "image/png", size: 21 * 1024 * 1024 }).ok).toBe(false);
    expect(classifyUpload({ name: "a.mp4", type: "video/mp4", size: 200 * 1024 * 1024 }).ok).toBe(true);
    expect(classifyUpload({ name: "a.mp4", type: "video/mp4", size: 0 }).ok).toBe(false);
  });
  it("builds the upload and connect URLs from the HTTP contract", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const upload = new URL(uploadUrl(id, "my photo.jpg", "no_people"), "http://local");
    expect(upload.pathname).toBe(`/api/businesses/${id}/media`);
    expect(Object.fromEntries(upload.searchParams)).toEqual({ filename: "my photo.jpg", ownsOrLicensedMedia: "true", peopleVisible: "no_people" });
    expect(connectUrl(id)).toBe(`/api/connections/meta/start?businessId=${id}&attest=1`);
  });
});

describe("director's room derivations", () => {
  it("maps run stages and autopilot progress names onto the rail", () => {
    expect(railForStage("discovering")).toBe("discover");
    expect(railForStage("researching")).toBe("research");
    expect(railForStage("selecting")).toBe("choose");
    expect(railForStage("sam_video")).toBe("sam");
    expect(railForStage("rendering")).toBe("reel");
    expect(railForStage("critique")).toBe("critic");
    expect(railForStage("interrupted")).toBeNull();
  });
  it("advances with the most progressed signal and marks failures", () => {
    const research = deriveRail(run({ stage: "researching" }), null);
    expect(research.active).toBe("research");
    expect(research.steps.map((step) => step.status).slice(0, 3)).toEqual(["done", "active", "pending"]);
    expect(deriveRail(run({ stage: "creating" }), state({ phase: "track" })).active).toBe("sam");
    const failed = deriveRail(run({ stage: "failed", status: "failed", events: [{ stage: "rendering", message: "x", at: "2026-11-04T00:00:00.000Z" }] }), null);
    expect(failed).toMatchObject({ active: "reel", failed: true });
    expect(failed.steps.find((step) => step.id === "reel")?.status).toBe("failed");
    const done = deriveRail(run({ stage: "needs_review", status: "completed", campaign }), state({ phase: "done" }));
    expect(done.steps.every((step) => step.status === "done")).toBe(true);
  });
  it("keeps the latest log lines first and drops consecutive repeats", () => {
    const events = [1, 2, 2, 3].map((value, index) => ({ stage: "creating", message: `m${value}`, at: `2026-11-04T00:00:0${index}.000Z` }));
    expect(directorLog(events, 2).map((entry) => entry.message)).toEqual(["m3", "m2"]);
  });
  it("normalizes role badges and clamps overlay boxes", () => {
    expect(roleBadges({ roles: ["hero", "carousel_2", "carousel_2", "story"] })).toEqual(["HERO", "Carousel 2", "story"]);
    expect(clampBox({ x1: -5, y1: 10, x2: 2000, y2: 5 }, 100, 50)).toEqual({ x1: 0, y1: 5, x2: 99, y2: 10 });
    expect(clampBox({ x1: 10, y1: 10, x2: 10, y2: 20 }, 100, 50)).toBeNull();
    expect(clampBox(null, 100, 100)).toBeNull();
  });
});

describe("ready-state derivations", () => {
  const files: AutopilotPublicState["files"] = [{ name: "thumb-a.jpg", sha256: sha("b"), bytes: 1, mediaType: "image/jpeg" }, { name: "track-a.mp4", sha256: sha("c"), bytes: 1, mediaType: "video/mp4" }];
  const media: AutopilotPublicState["media"][number] = { assetId: "a", kind: "image", provenance: "owner_upload", rights: "owner_attested", thumb: "thumb-a.jpg", width: 800, height: 600, durationSeconds: null, status: "selected", analysis: null, roles: ["hero"], excludedReasons: [], score: 0.8 };
  it("finds the reel, carousel order and archive", () => {
    expect(reelAsset(campaign)?.filename).toBe("instagram_reel.mp4");
    expect(carouselAssets(campaign).map((item) => item.filename)).toEqual(["carousel_2.png", "carousel_10.png"]);
  });
  it("only offers a tracking overlay that is listed as servable", () => {
    const sam = [{ assetId: "a", media: "video" as const, promptKind: "geometry" as const, label: "cup", origin: "spark_grounding" as const, status: "tracked" as const, preview: null, overlayVideo: "track-a.mp4", coverage: null, framesTracked: 60, elapsedMs: 10 }];
    expect(trackingOverlay(state({ sam, files }))).toBe("track-a.mp4");
    expect(trackingOverlay(state({ sam, files: [] }))).toBeNull();
  });
  it("targets a finding at a harvested thumbnail or a rendered kit image", () => {
    const current = state({ media: [media], files });
    expect(findingTarget({ assetId: "a" }, "run-1", current, campaign)).toMatchObject({ src: "/api/runs/run-1/autopilot/files/thumb-a.jpg", width: 800, height: 600 });
    expect(findingTarget({ assetId: "feed.png" }, "run-1", current, campaign)).toMatchObject({ src: "/api/runs/run-1/files/feed.png", width: 1080 });
    expect(findingTarget({ assetId: "instagram_reel.mp4" }, "run-1", current, campaign)).toBeNull();
  });
  it("keeps the approval statement and approvable list identical to the server's", () => {
    expect(APPROVAL_STATEMENT).toBe(serverApproval.APPROVAL_STATEMENT);
    for (const withheld of [[], ["feed.png"], ["kit.zip", "carousel_10.png", "not-in-kit.png"]]) expect(approvableFiles(campaign, withheld)).toEqual(serverApproval.approvableFiles(campaign, withheld));
  });
  it("reviews exactly the files the server digest binds, using only quality.withheldFiles", () => {
    const completed = { campaign, quality: { withheldFiles: ["feed.png"] } as RunView["quality"] };
    const review = approvalReview(completed, state({ critic: { verdict: "blocking_findings", findings: [], fixesApplied: [], withheld: ["feed.png"] } }));
    expect(review.files.map((file) => file.filename)).toEqual(["carousel_10.png", "carousel_2.png", "instagram_reel.mp4", "kit.zip"]);
    expect(review).toMatchObject({ withheld: ["feed.png"], bytes: 40, conflicts: [] });
    // The digest of what the owner sees equals the digest the server computes for the run view.
    expect(serverApproval.manifestDigest(campaign.id, review.files)).toBe(serverApproval.manifestDigest(campaign.id, serverApproval.approvableFiles(campaign, serverWithheld(completed))));
    expect(approvalReview({ campaign, quality: null } as Pick<RunView, "campaign" | "quality">, null)).toMatchObject({ withheld: [], conflicts: [] });
  });
  it("flags a critic-withheld file the server would still approve, by filename or asset id", () => {
    const completed = { campaign: { ...campaign, assets: campaign.assets.map((item) => item.filename === "carousel_2.png" ? { ...item, id: "asset-c2" } : item) }, quality: { withheldFiles: ["feed.png"] } as RunView["quality"] };
    const critic = (withheld: string[]) => state({ critic: { verdict: "blocking_findings", findings: [], fixesApplied: [], withheld } });
    expect(approvalReview(completed, critic(["asset-c2", "harvested-source-id"])).conflicts).toEqual(["carousel_2.png"]);
    expect(approvalReview(completed, critic(["carousel_10.png", "feed.png"])).conflicts).toEqual(["carousel_10.png"]);
    expect(approvalReview(completed, critic(["feed.png", "harvested-source-id"])).conflicts).toEqual([]);
    expect(campaignFilename(completed.campaign, "asset-c2")).toBe("carousel_2.png");
    expect(campaignFilename(null, "feed.png")).toBeNull();
  });
  it("leaves server-withheld files out of the Autopilot previews only", () => {
    const view = { id: "run-1", campaign, quality: { withheldFiles: ["feed.png"] } } as unknown as RunView;
    expect(withoutWithheld(view).campaign!.assets.map((item) => item.filename)).not.toContain("feed.png");
    expect(withoutWithheld(view).campaign!.assets).toHaveLength(4);
    expect(campaign.assets).toHaveLength(5);
    const clean = { ...view, quality: null } as unknown as RunView;
    expect(withoutWithheld(clean)).toBe(clean);
    expect(shortDigest(sha("d"))).toBe("dddddddd…dddd");
    expect(shortDigest(null)).toBe("—");
  });
});

/* ---------- Regression: withheld files, OAuth returns, upload control, stopped runs ---------- */

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const zipCampaign = {
  id: "synthetic-campaign", opportunityId: "o1", name: "Synthetic kit", coreMessage: "m", objective: "o", audienceHypothesis: "a", primaryCta: "c", reviewNotes: [],
  channels: [{ id: "instagram_reels", title: "Reel", headline: "h", body: "b", caption: "c", cta: "c" }],
  assets: [asset("instagram_reel.mp4", "video", "instagram_reels"), asset("feed.png", "image", "instagram_feed"), { ...asset("campaign-concept.zip", "archive"), sha256: sha("e") }],
} as unknown as CampaignKit;
const withheldQuality = { withheldFiles: ["instagram_reel.mp4", "campaign-concept.zip"], fixesApplied: [], notes: [], findings: 1, mediaAnalyzed: 1, mediaExcluded: 0, reelMode: "legacy", criticVerdict: "blocking_findings" } as unknown as RunView["quality"];
function fullRun(patch: Partial<RunView> = {}): RunView {
  return { id: RUN_ID, businessId: BUSINESS_ID, stage: "needs_review", status: "completed", createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z", mode: "live", error: null,
    business: { name: "", website: null, locality: "", vertical: "", goal: "Synthetic goal" }, sources: [], report: null, campaign: zipCampaign, events: [], usage: [], autopilot: true, ...patch } as unknown as RunView;
}
const approvalOf = (campaign: CampaignKit, withheld: string[]) => ({ version: 1 as const, campaignId: campaign.id, approvedAt: "2026-11-04T01:00:00.000Z", manifestDigest: sha("f"), files: approvableFiles(campaign, withheld), withheldFiles: withheld, statement: APPROVAL_STATEMENT, scope: "owner_approved_concept_not_published" as const });
const zipHref = `/api/runs/${RUN_ID}/files/campaign-concept.zip`;
const reelHref = `/api/runs/${RUN_ID}/files/instagram_reel.mp4`;

describe("ux-1: the withheld concept ZIP is never offered as the kit", () => {
  it("offers the archive only when it is not withheld and, after approval, only for the approved bytes", () => {
    expect(offerableArchive(fullRun({ quality: withheldQuality }))).toBeNull();
    expect(offerableArchive(fullRun())?.filename).toBe("campaign-concept.zip");
    expect(offerableArchive(fullRun({ approval: approvalOf(zipCampaign, []) }))?.filename).toBe("campaign-concept.zip");
    expect(offerableArchive(fullRun({ quality: withheldQuality, approval: approvalOf(zipCampaign, withheldQuality!.withheldFiles) }))).toBeNull();
    // Approval recorded without the ZIP, or for different ZIP bytes: fail closed.
    expect(offerableArchive(fullRun({ approval: approvalOf(zipCampaign, ["campaign-concept.zip"]) }))).toBeNull();
    const changed = { ...zipCampaign, assets: zipCampaign.assets.map((item) => item.mediaType === "archive" ? { ...item, sha256: sha("9") } : item) } as CampaignKit;
    expect(offerableArchive(fullRun({ campaign: changed, approval: approvalOf(zipCampaign, []) }))).toBeNull();
  });
  it("lists only approved, unchanged, non-withheld files for individual download", () => {
    const run = fullRun({ quality: withheldQuality, approval: approvalOf(zipCampaign, withheldQuality!.withheldFiles) });
    expect(approvedDownloads(run).map((item) => item.filename)).toEqual(["feed.png"]);
    expect(approvedDownloads(fullRun())).toEqual([]);
  });
  it("renders neither the pre-approval nor the approved card with a link to the withheld ZIP", () => {
    const onApprove = async () => undefined;
    const before = renderToStaticMarkup(createElement(ApprovalBlock, { run: fullRun({ quality: withheldQuality, approvalDigest: sha("f") }), state: null, onApprove }));
    expect(before).not.toContain(zipHref);
    expect(before).toContain("Approve these exact files.");
    const after = renderToStaticMarkup(createElement(ApprovalBlock, { run: fullRun({ quality: withheldQuality, approval: approvalOf(zipCampaign, withheldQuality!.withheldFiles) }), state: null, onApprove }));
    expect(after).toContain("Approved by you");
    expect(after).not.toContain(zipHref);
    expect(after).not.toContain("Download the kit (ZIP)");
    expect(after).not.toContain(reelHref);
    expect(after).toContain(`/api/runs/${RUN_ID}/files/feed.png`);
    // A clean kit still offers its approved ZIP.
    const clean = renderToStaticMarkup(createElement(ApprovalBlock, { run: fullRun({ approval: approvalOf(zipCampaign, []) }), state: null, onApprove }));
    expect(clean).toContain(zipHref);
  });
});

describe("ux-2: the step-by-step studio panels honour Autopilot withheld files", () => {
  it("never previews or offers a withheld file, whoever passes the raw run", () => {
    const raw = fullRun({ quality: withheldQuality });
    for (const html of [renderToStaticMarkup(createElement(ExportPanel, { run: raw, onStudio: () => undefined })), renderToStaticMarkup(createElement(CampaignPanel, { run: raw, onExport: () => undefined }))]) {
      expect(html).not.toContain(zipHref);
      expect(html).not.toContain(reelHref);
      expect(html).toContain("Withheld files");
      expect(html).toContain("instagram_reel.mp4, campaign-concept.zip");
    }
    const clean = renderToStaticMarkup(createElement(ExportPanel, { run: fullRun(), onStudio: () => undefined }));
    expect(clean).toContain(zipHref);
    expect(clean).not.toContain("Withheld files");
  });
});

describe("ux-3: OAuth returns without ?business= restore the draft and report the failure", () => {
  it("treats ?connected= alone as an OAuth return", () => {
    expect(isOAuthReturn("?connected=error")).toBe(true);
    expect(isOAuthReturn(`?business=${BUSINESS_ID}&connected=meta`)).toBe(true);
    expect(isOAuthReturn("?run=abc")).toBe(false);
  });
  it("restores the saved draft with an error notice when the callback dropped the business", () => {
    expect(resolveOAuthReturn("?connected=error", BUSINESS_ID)).toEqual({ businessId: BUSINESS_ID, fromDraft: true, notice: "error" });
    expect(resolveOAuthReturn("?connected=error", null)).toEqual({ businessId: null, fromDraft: false, notice: "error" });
    // An unverified success is not trusted.
    expect(resolveOAuthReturn("?connected=meta", BUSINESS_ID)).toMatchObject({ notice: "error" });
    expect(resolveOAuthReturn("?business=not-a-uuid&connected=meta", null)).toEqual({ businessId: null, fromDraft: false, notice: "error" });
    expect(resolveOAuthReturn("?connected=error", "not-a-uuid")).toEqual({ businessId: null, fromDraft: false, notice: "error" });
  });
  it("keeps the verified-return behaviour", () => {
    expect(resolveOAuthReturn(`?business=${BUSINESS_ID}&connected=meta`, BUSINESS_ID)).toEqual({ businessId: BUSINESS_ID, fromDraft: true, notice: "returned" });
    expect(resolveOAuthReturn(`?business=${BUSINESS_ID}&connected=error`, null)).toEqual({ businessId: BUSINESS_ID, fromDraft: false, notice: "error" });
    expect(resolveOAuthReturn("", BUSINESS_ID)).toBeNull();
  });
});

type Item = { id: string };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; }
/** A fake upload that settles when the test says so and rejects on abort, like the XHR helper. */
function controllableUploads() {
  const calls = new Map<string, { settle: ReturnType<typeof deferred<string>>; signal: AbortSignal }>();
  const started: string[] = [];
  const waiters: (() => void)[] = [];
  const upload = (item: Item, signal: AbortSignal) => {
    const settle = deferred<string>();
    signal.addEventListener("abort", () => settle.reject(new Error("Upload cancelled.")), { once: true });
    calls.set(item.id, { settle, signal }); started.push(item.id);
    waiters.splice(0).forEach((wake) => wake());
    return settle.promise;
  };
  const whenStarted = async (id: string) => { while (!started.includes(id)) await new Promise<void>((wake) => waiters.push(wake)); return calls.get(id)!; };
  return { upload, started, whenStarted };
}

describe("ux-4/ux-5: removing or cancelling uploads is honoured", () => {
  const items: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
  function hooks(removed: Set<string>, uploads: ReturnType<typeof controllableUploads>, controllers = new Map<string, AbortController>()) {
    return {
      isRemoved: (id: string) => removed.has(id), upload: uploads.upload,
      track: (id: string, controller: AbortController | null) => { if (controller) controllers.set(id, controller); else controllers.delete(id); },
      onUploaded: vi.fn(), onRemovedAfterUpload: vi.fn(async () => undefined), onFailed: vi.fn(), onCancelled: vi.fn(),
    };
  }
  it("never uploads a file removed while an earlier one uploads", async () => {
    const removed = new Set<string>();
    const uploads = controllableUploads();
    const h = hooks(removed, uploads);
    const done = uploadBatch(items, new AbortController().signal, h);
    const first = await uploads.whenStarted("a");
    removed.add("c"); // The owner removes a later tile mid-batch.
    first.settle.resolve("asset-a");
    (await uploads.whenStarted("b")).settle.resolve("asset-b");
    await expect(done).resolves.toEqual({ failures: 0 });
    expect(uploads.started).toEqual(["a", "b"]);
    expect(h.onUploaded.mock.calls.map(([item]) => item.id)).toEqual(["a", "b"]);
  });
  it("aborts the in-flight request when the uploading file is removed, without counting a failure", async () => {
    const removed = new Set<string>();
    const controllers = new Map<string, AbortController>();
    const uploads = controllableUploads();
    const h = hooks(removed, uploads, controllers);
    const done = uploadBatch(items, new AbortController().signal, h);
    const first = await uploads.whenStarted("a");
    removed.add("a"); controllers.get("a")!.abort(); // What removeQueued does.
    expect(first.signal.aborted).toBe(true);
    (await uploads.whenStarted("b")).settle.resolve("asset-b");
    (await uploads.whenStarted("c")).settle.resolve("asset-c");
    await expect(done).resolves.toEqual({ failures: 0 });
    expect(h.onFailed).not.toHaveBeenCalled();
    expect(h.onUploaded.mock.calls.map(([item]) => item.id)).toEqual(["b", "c"]);
  });
  it("hands back a file that finished uploading after the owner removed it", async () => {
    const removed = new Set<string>();
    const uploads = controllableUploads();
    const h = hooks(removed, uploads);
    const done = uploadBatch([{ id: "a" }], new AbortController().signal, h);
    const first = await uploads.whenStarted("a");
    removed.add("a"); // Removed, but the server had already stored it (no abort reached the request).
    first.settle.resolve("asset-a");
    await done;
    expect(h.onUploaded).not.toHaveBeenCalled();
    expect(h.onRemovedAfterUpload).toHaveBeenCalledWith({ id: "a" }, "asset-a");
  });
  it("cancels the batch: aborts the request in flight and attempts nothing after it", async () => {
    const batch = new AbortController();
    const uploads = controllableUploads();
    const h = hooks(new Set(), uploads);
    const done = uploadBatch(items, batch.signal, h);
    const first = await uploads.whenStarted("a");
    batch.abort(); // "Cancel upload", or the intake unmounting.
    await expect(done).rejects.toBeInstanceOf(UploadCancelledError);
    expect(first.signal.aborted).toBe(true);
    expect(uploads.started).toEqual(["a"]);
    expect(h.onCancelled).toHaveBeenCalledWith({ id: "a" });
    expect(h.onFailed).not.toHaveBeenCalled();
  });
  it("rejects as cancelled when cancelled right after the last upload, so no run starts", async () => {
    const batch = new AbortController();
    const uploads = controllableUploads();
    const h = { ...hooks(new Set(), uploads), onUploaded: vi.fn(() => batch.abort()) };
    const done = uploadBatch([{ id: "a" }], batch.signal, h);
    (await uploads.whenStarted("a")).settle.resolve("asset-a");
    await expect(done).rejects.toBeInstanceOf(UploadCancelledError);
  });
  it("lets the owner remove (cancel) the file that is uploading", () => {
    const file = { name: "clip.mp4", size: 10 } as File;
    const queue: QueuedFile[] = [{ id: "q1", file, kind: "video", mimeType: "video/mp4", previewUrl: "blob:x", status: "uploading", progress: 0.4, error: null }];
    const html = renderToStaticMarkup(createElement(MediaDropzone, { queue, uploaded: [], rejected: [], disabled: true, rights: true, people: "no_people", consentError: false, consentRef: { current: null }, onAdd: () => undefined, onRemoveQueued: () => undefined, onRemoveUploaded: () => undefined, onRights: () => undefined, onPeople: () => undefined }));
    const button = html.match(/<button[^>]*aria-label="Cancel the upload and remove clip\.mp4"[^>]*>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain("disabled");
  });
});

describe("ux-6: a stopped run never shows perpetual loading", () => {
  const failedRun = fullRun({ stage: "discovering", status: "failed", campaign: null, error: "META_API_KEY is not configured.", quality: null });
  it("derives the media wall mode and the headline from the run status", () => {
    expect(mediaWallMode({ status: "running" }, "ready", 0)).toBe("skeleton");
    expect(mediaWallMode({ status: "failed" }, "ready", 0)).toBe("empty_failed");
    expect(mediaWallMode({ status: "waiting" }, "ready", 0)).toBe("empty_stopped");
    expect(mediaWallMode({ status: "failed" }, "loading", 0)).toBe("loading");
    expect(mediaWallMode({ status: "failed" }, "ready", 2)).toBe("grid");
    expect(mediaWallMode({ status: "running" }, "unavailable", 0)).toBe("unavailable");
    expect(roomHeadline(fullRun({ status: "running" }))).toEqual({ text: "Finding your business…", pending: true });
    expect(roomHeadline(failedRun)).toMatchObject({ pending: false });
    expect(roomHeadline(failedRun).text).not.toMatch(/Finding/);
    expect(roomHeadline(fullRun({ status: "failed", business: { ...failedRun.business, name: "Synthetic Cafe" } }))).toEqual({ text: "Synthetic Cafe", pending: false });
  });
  it("renders the failed director's room without skeleton tiles or the in-progress headline", () => {
    const html = renderToStaticMarkup(createElement(DirectorsRoom, { run: failedRun, state: { ...state(), runId: RUN_ID }, stateStatus: "ready", onRetry: () => undefined, retrying: false, onStudio: () => undefined }));
    expect(html).toContain("Autopilot stopped");
    expect(html).toContain("Try resuming");
    expect(html).not.toContain("ap-skeleton-tile");
    expect(html).not.toContain("Finding your business…");
    expect(html).not.toContain("Gathering photos and videos");
    const active = renderToStaticMarkup(createElement(MediaWall, { run: fullRun({ status: "running", campaign: null }), state: state(), status: "ready" }));
    expect(active).toContain("ap-skeleton-tile");
  });  it("bounds state refetches for a stopped run and settles on an error message instead of loading forever", () => {
    // Permanent client errors (e.g. a 409 validation failure) stop at once; they will not fix themselves.
    for (const status of [400, 403, 409, 422]) expect(stoppedStateRetryDelay(status, 0)).toBeNull();
    // Transient faults back off, capped, and give up after a bounded number of attempts.
    for (const status of [null, 408, 429, 500, 503]) expect(stoppedStateRetryDelay(status, 0)).toBe(5000);
    expect(stoppedStateRetryDelay(503, 1)).toBe(10_000);
    expect(stoppedStateRetryDelay(null, 3)).toBe(30_000);
    expect(stoppedStateRetryDelay(null, STOPPED_STATE_MAX_RETRIES)).toBeNull();
    let attempts = 0;
    while (stoppedStateRetryDelay(500, attempts) !== null) attempts += 1;
    expect(attempts).toBe(STOPPED_STATE_MAX_RETRIES);
    expect(mediaWallMode({ status: "failed" }, "error", 0)).toBe("error");
    expect(mediaWallMode({ status: "failed" }, "error", 3)).toBe("grid");
    const html = renderToStaticMarkup(createElement(MediaWall, { run: failedRun, state: null, status: "error" }));
    expect(html).toContain("couldn’t load the photos and videos");
    expect(html).not.toContain("Loading what Autopilot gathered");
    expect(html).not.toContain("ap-skeleton-tile");
  });
});
