import type { CampaignKit, RunEvent, RunView } from "@/lib/research/contracts";
import type { AutopilotPublicState } from "@/lib/autopilot/public-state";

/**
 * Pure, browser-safe view logic for the one-shot Autopilot experience. Nothing here reads
 * the network or storage; components and tests share these derivations.
 */
export type PublicMedia = AutopilotPublicState["media"][number];
export type PublicFinding = NonNullable<AutopilotPublicState["critic"]>["findings"][number];
export type PublicBox = { x1: number; y1: number; x2: number; y2: number };

export const RUN_STORAGE_KEY = "tickr.activeRun.v1";
export const VIEW_STORAGE_KEY = "tickr.view.v1";
export const DRAFT_STORAGE_KEY = "tickr.autopilotDraft.v1";
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const isUuid = (value: string | null | undefined): value is string => Boolean(value && uuidPattern.test(value));

/* ---------- Intake: link, goal, uploads ---------- */

export type LinkKind = "maps" | "instagram" | "facebook" | "website";
export type NormalizedLink = { ok: true; url: string; kind: LinkKind; host: string } | { ok: false; error: string };

const MAPS_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl|maps\.google\.[a-z.]+|www\.google\.[a-z.]+|google\.[a-z.]+)$/i;

/** Accepts what owners actually paste: full URLs, bare domains, Maps short links or an @handle. */
export function normalizeBusinessLink(raw: string): NormalizedLink {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Paste your Google Maps listing, website or Instagram link." };
  if (value.length > 2048) return { ok: false, error: "That link is too long. Paste the address from your browser bar." };
  const handle = value.match(/^@([a-z0-9._]{1,30})$/i);
  if (handle) return normalizeBusinessLink(`https://www.instagram.com/${handle[1]}/`);
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : /^[^\s/:@]+\.[^\s/]{2,}/.test(value) ? `https://${value}` : value;
  let url: URL;
  try { url = new URL(candidate); } catch { return { ok: false, error: "That doesn’t look like a link. Try copying it from the Share button or your browser bar." }; }
  if (!["http:", "https:"].includes(url.protocol)) return { ok: false, error: "Use a web link that starts with https://." };
  if (url.username || url.password) return { ok: false, error: "Remove the sign-in details from that link." };
  if (!url.hostname.includes(".")) return { ok: false, error: "Add the full web address, for example yourcafe.com." };
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  const isMaps = (MAPS_HOSTS.test(url.hostname) && (url.hostname.startsWith("maps.") || url.pathname.startsWith("/maps") || url.hostname.toLowerCase() === "maps.app.goo.gl"));
  const kind: LinkKind = isMaps ? "maps" : /(^|\.)instagram\.com$/.test(host) ? "instagram" : /(^|\.)(facebook\.com|fb\.com|fb\.me)$/.test(host) ? "facebook" : "website";
  return { ok: true, url: url.href, kind, host };
}

export const LINK_KIND_LABEL: Record<LinkKind, string> = { maps: "Google Maps listing", instagram: "Instagram profile", facebook: "Facebook page", website: "Website" };

export const GOALS = [
  { id: "story", label: "Tell our story", goal: "Tell the story behind the business so new customers understand what makes it different." },
  { id: "launch", label: "Launch something new", goal: "Launch something new and get people excited to try it." },
  { id: "quiet", label: "Fill quiet hours", goal: "Bring more customers in during our quieter hours." },
  { id: "event", label: "Promote an event", goal: "Promote an upcoming event and get people to come along." },
  { id: "regulars", label: "Win new regulars", goal: "Turn first-time visitors from the neighbourhood into regulars." },
] as const;
export type GoalId = (typeof GOALS)[number]["id"];

/** The goal sent to the server; an empty string lets the server apply its documented default. */
export function composeGoal(goalId: GoalId | null, text: string): string {
  const preset = GOALS.find((goal) => goal.id === goalId)?.goal ?? "";
  const detail = text.trim().replace(/\s+/g, " ");
  const combined = preset && detail ? `${preset} ${/[.!?]$/.test(detail) ? detail : `${detail}.`}` : preset || detail;
  return combined.slice(0, 2000);
}

export const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/quicktime", "video/webm"] as const;
export const UPLOAD_ACCEPT = UPLOAD_TYPES.join(",");
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
export const MAX_UPLOADS = 40;
const EXTENSION_TYPES: Record<string, (typeof UPLOAD_TYPES)[number]> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

/** Client-side pre-check only; the server re-validates by magic bytes. */
export function classifyUpload(file: { name: string; type: string; size: number }): { ok: true; kind: "image" | "video"; mimeType: string } | { ok: false; error: string } {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = (UPLOAD_TYPES as readonly string[]).includes(file.type) ? file.type : EXTENSION_TYPES[extension];
  if (!mimeType) return { ok: false, error: "Use JPEG, PNG or WebP photos, or MP4, MOV or WebM videos." };
  const kind = mimeType.startsWith("video/") ? "video" : "image";
  if (file.size <= 0) return { ok: false, error: "This file is empty." };
  if (file.size > (kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) return { ok: false, error: kind === "video" ? "Videos can be up to 300 MB." : "Photos can be up to 20 MB." };
  return { ok: true, kind, mimeType };
}

export type PeopleVisible = "consented" | "no_people";
export function uploadUrl(businessId: string, filename: string, people: PeopleVisible): string {
  const query = new URLSearchParams({ filename: filename.slice(0, 200), ownsOrLicensedMedia: "true", peopleVisible: people });
  return `/api/businesses/${encodeURIComponent(businessId)}/media?${query.toString()}`;
}
export const connectUrl = (businessId: string) => `/api/connections/meta/start?${new URLSearchParams({ businessId, attest: "1" }).toString()}`;

/** True for any Meta OAuth return (?business=… and/or ?connected=…): a stored run must not replace the intake. */
export function isOAuthReturn(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("business") || params.has("connected");
}

export type OAuthReturn = { businessId: string | null; fromDraft: boolean; notice: "returned" | "error" | null };
/**
 * What the intake restores after the Meta callback redirect. The callback leaves the business out
 * whenever it could not verify the signed state (expired, unparseable, nonce mismatch, connector not
 * ready); the draft this browser saved just before leaving is then the only context to restore, and
 * the connection is reported as failed. Returns null when the URL is not an OAuth return.
 */
export function resolveOAuthReturn(search: string, storedDraftBusinessId: string | null): OAuthReturn | null {
  const params = new URLSearchParams(search);
  const business = params.get("business");
  const connected = params.get("connected");
  if (business === null && connected === null) return null;
  const stored = isUuid(storedDraftBusinessId) ? storedDraftBusinessId : null;
  if (isUuid(business)) return { businessId: business, fromDraft: stored === business, notice: connected === "error" ? "error" : connected === "meta" ? "returned" : null };
  // No verified business: an unverified "connected=meta" is not trusted as success.
  return { businessId: stored, fromDraft: stored !== null, notice: connected === null ? null : "error" };
}

/* ---------- Director's room: phases, log, media ---------- */

export const RAIL = [
  { id: "discover", label: "Discover", hint: "Finding the business behind your link" },
  { id: "research", label: "Research", hint: "Reading cited public sources" },
  { id: "choose", label: "Choose", hint: "Picking the best-supported idea" },
  { id: "media", label: "Media", hint: "Studying every photo and video" },
  { id: "copy", label: "Copy", hint: "Writing for each channel" },
  { id: "sam", label: "SAM", hint: "Selecting real product pixels" },
  { id: "reel", label: "Reel", hint: "Rendering the Reel" },
  { id: "critic", label: "Critic", hint: "Checking its own work" },
  { id: "ready", label: "Ready", hint: "Waiting for your review" },
] as const;
export type RailId = (typeof RAIL)[number]["id"];
export type RailStep = { id: RailId; label: string; hint: string; status: "done" | "active" | "pending" | "failed" };

const PHASE_TO_RAIL: Record<AutopilotPublicState["phase"], RailId | null> = { harvest: "media", analyze: "media", direct: "media", copy: "copy", segment: "sam", track: "sam", render: "reel", critique: "critic", export: "critic", done: "ready", failed: null };

/** Maps a run stage (or an Autopilot progress stage name) to a rail step. */
export function railForStage(stage: string): RailId | null {
  const value = stage.toLowerCase();
  if (["created", "discovering"].includes(value) || value.startsWith("discover")) return "discover";
  if (["enriching", "ingesting", "researching"].includes(value)) return "research";
  if (["selecting", "awaiting_selection"].includes(value)) return "choose";
  if (["needs_review", "owner_approved"].includes(value)) return "ready";
  if (/critic|critique|export|fix/.test(value)) return "critic";
  if (/reel|render|encode|cinema/.test(value)) return "reel";
  if (/sam|segment|track|mask/.test(value)) return "sam";
  if (/copy|caption|write/.test(value)) return "copy";
  if (/media|harvest|analy|direct|plan|gallery|upload/.test(value)) return "media";
  if (value === "creating") return "media";
  return null;
}

export function deriveRail(run: Pick<RunView, "stage" | "status" | "campaign" | "events">, state: Pick<AutopilotPublicState, "phase"> | null): { steps: RailStep[]; active: RailId; failed: boolean } {
  const order = RAIL.map((step) => step.id) as RailId[];
  const index = (id: RailId | null) => (id ? order.indexOf(id) : -1);
  let current = index(railForStage(run.stage));
  // The most advanced signal wins: public state phase, the latest recognisable event, or the run stage.
  if (state) current = Math.max(current, index(PHASE_TO_RAIL[state.phase]));
  for (const event of run.events.slice(-6)) current = Math.max(current, index(railForStage(event.stage)));
  if (run.campaign && run.status === "completed") current = order.length - 1;
  if (current < 0) current = 0;
  const failed = run.status === "failed" || state?.phase === "failed";
  const complete = Boolean(run.campaign) && run.status === "completed";
  const steps = RAIL.map((step, position) => ({
    ...step,
    status: complete ? "done" : position < current ? "done" : position === current ? (failed ? "failed" : "active") : "pending",
  })) as RailStep[];
  return { steps, active: order[current], failed };
}

export type LogEntry = { key: string; at: string; message: string; rail: RailId | null };
/** Latest director's-log lines, newest first, without repeated consecutive messages. */
export function directorLog(events: readonly RunEvent[], limit = 8): LogEntry[] {
  const entries: LogEntry[] = [];
  events.forEach((event, position) => {
    if (entries.length && entries[entries.length - 1].message === event.message) return;
    entries.push({ key: `${position}-${event.at}`, at: event.at, message: event.message, rail: railForStage(event.stage) });
  });
  return entries.slice(-limit).reverse();
}

export const PROVENANCE_LABEL: Record<PublicMedia["provenance"], string> = { official_website: "Website", owner_upload: "Your upload", owner_instagram: "Instagram", owner_facebook: "Facebook", meta_illustration: "Illustration" };
export const RIGHTS_LABEL: Record<PublicMedia["rights"], string> = { owner_attested: "Owner-attested rights", unknown_review_required: "Rights unknown · review", generated_illustration: "Generated illustration" };
export const GOAL_FIT_LABEL: Record<NonNullable<PublicMedia["analysis"]>["goalFit"], string> = { none: "No goal fit", weak: "Weak fit", moderate: "Good fit", strong: "Strong fit" };
export const REEL_MODE_LABEL: Record<NonNullable<AutopilotPublicState["plan"]>["reelMode"], string> = { tracked_video: "Tracked video", still_depth: "Still with depth", illustration: "Illustration", legacy: "Classic render" };
export const SAM_ORIGIN_LABEL: Record<AutopilotPublicState["sam"][number]["origin"], string> = { spark_grounding: "Located by Muse Spark", owner_tap: "Your tap", concept_prompt: "Concept prompt", local_layout: "Local layout" };
export const CHANNEL_LABEL: Record<string, string> = { facebook_ads: "Facebook ad", instagram_feed: "Instagram feed", instagram_carousel: "Carousel", instagram_stories: "Stories", instagram_reels: "Reel", click_to_whatsapp: "Click to WhatsApp", whatsapp_status: "WhatsApp Status" };

/** Normalized role badges for the media wall; unknown roles are shown as plain words. */
export function roleBadges(media: Pick<PublicMedia, "roles">): string[] {
  return media.roles.map((role) => {
    const value = role.toLowerCase();
    if (value === "hero" || value === "reel_hero") return "HERO";
    const slot = value.match(/^carousel[_-]?(\d+)$/);
    if (slot) return `Carousel ${slot[1]}`;
    if (value === "carousel") return "Carousel";
    return value.replaceAll("_", " ");
  }).filter((label, position, all) => all.indexOf(label) === position);
}

/**
 * What the media wall shows. Skeleton tiles promise that media is on its way, so they are only shown
 * while the run is queued or running; a stopped run (failed, waiting, finished) gets a plain message.
 */
export type MediaWallMode = "grid" | "unavailable" | "skeleton" | "loading" | "error" | "empty_failed" | "empty_stopped";
export type MediaStateStatus = "loading" | "ready" | "unavailable" | "error";
export function mediaWallMode(run: Pick<RunView, "status">, stateStatus: MediaStateStatus, mediaCount: number): MediaWallMode {
  if (stateStatus === "unavailable") return "unavailable";
  if (mediaCount > 0) return "grid";
  if (isActiveRun(run)) return "skeleton";
  if (stateStatus === "loading") return "loading";
  if (stateStatus === "error") return "error";
  return run.status === "failed" ? "empty_failed" : "empty_stopped";
}

/**
 * Retry schedule for a stopped run's public-state fetch. A stopped run no longer changes, so a failed
 * fetch is retried a few times with backoff for transient faults (network, 408, 429, 5xx) and then
 * given up; any other client error (400, 403, 409, 422 …) will not fix itself, so it stops at once.
 * Returns the delay in ms before the next attempt, or null to stop. `attempt` counts prior retries.
 */
export const STOPPED_STATE_MAX_RETRIES = 4;
export function stoppedStateRetryDelay(httpStatus: number | null, attempt: number): number | null {
  if (attempt >= STOPPED_STATE_MAX_RETRIES) return null;
  if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) return null;
  return Math.min(5000 * 2 ** attempt, 30_000);
}

/** The director's-room title: the in-progress "Finding your business…" only while the run can still find it. */
export function roomHeadline(run: Pick<RunView, "status" | "discovery" | "business">): { text: string; pending: boolean } {
  const name = run.discovery?.name ?? (run.business.name || null);
  if (name) return { text: name, pending: false };
  if (isActiveRun(run)) return { text: "Finding your business…", pending: true };
  if (run.status === "failed") return { text: "Autopilot stopped before it found your business", pending: false };
  return { text: "Your business isn’t identified yet", pending: false };
}

export const isListed = (state: Pick<AutopilotPublicState, "files"> | null, name: string | null | undefined): name is string => Boolean(name && state?.files.some((file) => file.name === name));
export const autopilotFileUrl = (runId: string, name: string) => `/api/runs/${encodeURIComponent(runId)}/autopilot/files/${encodeURIComponent(name)}`;
export const runFileUrl = (runId: string, name: string) => `/api/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(name)}`;

/** First SAM tracking overlay video that is actually servable. */
export function trackingOverlay(state: AutopilotPublicState | null): string | null {
  return state?.sam.find((entry) => isListed(state, entry.overlayVideo))?.overlayVideo ?? null;
}

/** Clamp an inclusive pixel box to the asset; null when it has no area. */
export function clampBox(box: PublicBox | null | undefined, width: number, height: number): PublicBox | null {
  if (!box || width <= 0 || height <= 0) return null;
  const x1 = Math.max(0, Math.min(width - 1, Math.min(box.x1, box.x2)));
  const x2 = Math.max(0, Math.min(width - 1, Math.max(box.x1, box.x2)));
  const y1 = Math.max(0, Math.min(height - 1, Math.min(box.y1, box.y2)));
  const y2 = Math.max(0, Math.min(height - 1, Math.max(box.y1, box.y2)));
  return x2 > x1 && y2 > y1 ? { x1, y1, x2, y2 } : null;
}

/* ---------- Ready: kit, critic, approval ---------- */

export function reelAsset(campaign: CampaignKit | null) {
  const videos = campaign?.assets.filter((asset) => asset.mediaType === "video") ?? [];
  return videos.find((asset) => asset.filename === "instagram_reel.mp4") ?? videos.find((asset) => asset.channel === "instagram_reels") ?? videos[0] ?? null;
}
export function carouselAssets(campaign: CampaignKit | null) {
  return (campaign?.assets ?? []).filter((asset) => asset.channel === "instagram_carousel" && asset.mediaType === "image" && !asset.filename.endsWith(".svg")).sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
}
export const archiveAsset = (campaign: CampaignKit | null) => campaign?.assets.find((asset) => asset.mediaType === "archive") ?? null;

import { approvableFiles } from "@/lib/jobs/approval-shared";
export { approvableFiles };

/** Withheld filenames exactly as the server binds them: only run.quality.withheldFiles (lib/jobs/store.ts). */
export const serverWithheld = (run: Pick<RunView, "quality">): string[] => [...new Set(run.quality?.withheldFiles ?? [])];

/** Resolves a critic reference (a kit filename or a campaign asset id) to a kit filename. */
export function campaignFilename(campaign: CampaignKit | null, ref: string): string | null {
  return campaign?.assets.find((asset) => asset.filename === ref)?.filename ?? campaign?.assets.find((asset) => asset.id === ref)?.filename ?? null;
}

export type ApprovalReview = {
  /** The exact files the server digest covers, in digest order. */
  files: ReturnType<typeof approvableFiles>;
  withheld: string[];
  bytes: number;
  /** Kit files the critic withheld that the server would still approve: approval must stay blocked. */
  conflicts: string[];
};
/** What the owner reviews and approves; never broader or narrower than the server-bound digest. */
export function approvalReview(run: Pick<RunView, "campaign" | "quality">, state: Pick<AutopilotPublicState, "critic"> | null): ApprovalReview {
  const withheld = serverWithheld(run);
  const files = run.campaign ? approvableFiles(run.campaign, withheld) : [];
  const approvable = new Set(files.map((file) => file.filename));
  const conflicts = new Set<string>();
  for (const ref of state?.critic?.withheld ?? []) {
    const filename = campaignFilename(run.campaign, ref);
    if (filename && approvable.has(filename)) conflicts.add(filename);
  }
  return { files, withheld, bytes: files.reduce((total, file) => total + file.bytes, 0), conflicts: [...conflicts].sort() };
}

/** The run as the Autopilot channel previews and file list show it: server-withheld files are left out. */
export function withoutWithheld(run: RunView): RunView {
  const withheld = new Set(serverWithheld(run));
  if (!run.campaign || !withheld.size) return run;
  return { ...run, campaign: { ...run.campaign, assets: run.campaign.assets.filter((asset) => !withheld.has(asset.filename)) } };
}

/**
 * The concept ZIP, only when it may be offered for download. The archive bundles every kit file, so
 * it is never offered once the server withheld it (lib/autopilot/pipeline.ts withholds it whenever
 * any kit file is withheld). After approval it is offered only when the approval covers exactly
 * these archive bytes. Fails closed: anything uncertain returns null.
 */
export function offerableArchive(run: Pick<RunView, "campaign" | "quality" | "approval">) {
  const archive = archiveAsset(run.campaign);
  if (!archive || serverWithheld(run).includes(archive.filename)) return null;
  const approval = run.approval;
  if (!approval) return archive;
  if (approval.withheldFiles.includes(archive.filename)) return null;
  const approved = approval.files.find((file) => file.filename === archive.filename);
  return approved && approved.sha256 === archive.sha256 && approved.bytes === archive.bytes ? archive : null;
}

/** Approved files that are still byte-identical in the current kit and not withheld: the individual downloads after approval. */
export function approvedDownloads(run: Pick<RunView, "campaign" | "quality" | "approval">): CampaignKit["assets"] {
  const approval = run.approval;
  const campaign = run.campaign;
  if (!approval || !campaign) return [];
  const withheld = new Set([...serverWithheld(run), ...approval.withheldFiles]);
  return approval.files.flatMap((file) => {
    const asset = campaign.assets.find((item) => item.filename === file.filename);
    return asset && !withheld.has(file.filename) && asset.sha256 === file.sha256 && asset.bytes === file.bytes ? [asset] : [];
  });
}

/** Text the server records with the approval (shared module, cannot drift). */
export { APPROVAL_STATEMENT } from "@/lib/jobs/approval-shared";

export type FindingTarget = { src: string; width: number; height: number; label: string };
/** Where to draw a critic finding: a harvested asset thumbnail, or a rendered kit image. */
export function findingTarget(finding: Pick<PublicFinding, "assetId">, runId: string, state: AutopilotPublicState | null, campaign: CampaignKit | null): FindingTarget | null {
  const media = state?.media.find((item) => item.assetId === finding.assetId);
  if (media && isListed(state, media.thumb)) return { src: autopilotFileUrl(runId, media.thumb), width: media.width, height: media.height, label: media.analysis?.depicts || PROVENANCE_LABEL[media.provenance] };
  const asset = campaign?.assets.find((item) => item.filename === finding.assetId || item.id === finding.assetId);
  if (asset && asset.mediaType === "image" && asset.width && asset.height && !asset.filename.endsWith(".svg")) return { src: runFileUrl(runId, asset.filename), width: asset.width, height: asset.height, label: asset.filename };
  return null;
}

export const shortDigest = (digest: string | null | undefined) => digest ? `${digest.slice(0, 8)}…${digest.slice(-4)}` : "—";
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
export const isActiveRun = (run: Pick<RunView, "status"> | null) => Boolean(run && ["queued", "running"].includes(run.status));
