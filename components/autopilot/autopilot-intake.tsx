"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowRight, AtSign, Ban, CircleCheck, CircleDollarSign, CircleStop, Globe, Link2, LoaderCircle, MapPin, MessageSquareOff, PlugZap, Search, ShieldCheck, Sparkles, Unplug, WandSparkles } from "lucide-react";
import type { RunView } from "@/lib/research/contracts";
import { DEFAULT_CAMPAIGN_GOAL } from "@/lib/businesses/input";
import { createBusiness, deleteBusinessMedia, disconnectMeta, getBusiness, getBusinessMedia, HttpError, startAutopilotRun, uploadMedia, type BusinessMedia, type MetaConnection } from "./api";
import { MediaDropzone, type QueuedFile } from "./media-dropzone";
import { classifyUpload, composeGoal, connectUrl, DRAFT_STORAGE_KEY, GOALS, isUuid, LINK_KIND_LABEL, MAX_UPLOADS, normalizeBusinessLink, resolveOAuthReturn, type GoalId, type PeopleVisible } from "./model";
import { UploadCancelledError, uploadBatch } from "./upload-batch";

type Draft = { businessId: string; url: string; goal: string };
type StoredDraft = Draft & { link: string; goalId: GoalId | null; goalText: string };
type MediaStatus = "idle" | "loading" | "ready" | "unavailable";
type Busy = null | "draft" | "upload" | "start" | "connect";

const linkIcons = { maps: MapPin, instagram: AtSign, facebook: Globe, website: Globe };
function readStoredDraft(): StoredDraft | null {
  try { const value = JSON.parse(window.sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? "null") as StoredDraft | null; return value && isUuid(value.businessId) ? value : null; } catch { return null; }
}
function writeStoredDraft(value: StoredDraft | null) {
  try { if (value) window.sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(value)); else window.sessionStorage.removeItem(DRAFT_STORAGE_KEY); } catch { /* Optional storage. */ }
}

/** Intake: one link, one goal, optional media and account connection, one primary action. */
export function AutopilotIntake({ restoring, onStarted }: { restoring: boolean; onStarted: (run: RunView) => void }) {
  const [link, setLink] = useState("");
  const [linkTouched, setLinkTouched] = useState(false);
  const [goalId, setGoalId] = useState<GoalId | null>(null);
  const [goalText, setGoalText] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [media, setMedia] = useState<BusinessMedia | null>(null);
  const [mediaStatus, setMediaStatus] = useState<MediaStatus>("idle");
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [rights, setRights] = useState(false);
  const [people, setPeople] = useState<PeopleVisible | null>(null);
  const [consentError, setConsentError] = useState(false);
  const [attest, setAttest] = useState(false);
  const [connectNotice, setConnectNotice] = useState<null | "returned" | "error" | "not_configured">(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [stoppedNotice, setStoppedNotice] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const consentRef = useRef<HTMLFieldSetElement>(null);
  const queueRef = useRef(queue);
  // Upload control: the running batch, each in-flight file's request, and files the owner removed.
  const batchRef = useRef<AbortController | null>(null);
  const uploadsRef = useRef(new Map<string, AbortController>());
  const removedRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const ids = useId();
  useEffect(() => { queueRef.current = queue; }, [queue]);
  // Leaving the intake (e.g. switching to the studio) cancels the upload and the run it would start.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; batchRef.current?.abort(); };
  }, []);

  const normalized = normalizeBusinessLink(link);
  const goal = composeGoal(goalId, goalText);
  const disabled = restoring || busy !== null;
  const anchored = Boolean(draft && ((media?.assets.length ?? 0) > 0 || media?.connection.status === "connected"));
  const draftStale = Boolean(draft && (!normalized.ok || normalized.url !== draft.url || goal !== draft.goal));
  const connection: MetaConnection | null = media?.connection ?? null;
  const showLinkError = linkTouched && link.trim().length > 0 && !normalized.ok;

  const loadMedia = useCallback(async (businessId: string) => {
    setMediaStatus("loading");
    try { const body = await getBusinessMedia(businessId); setMedia(body); setMediaStatus("ready"); return body; }
    catch (cause) { setMediaStatus(cause instanceof HttpError && [404, 405, 501].includes(cause.status) ? "unavailable" : "idle"); return null; }
  }, []);

  // OAuth return (?business=…&connected=meta|error, or only ?connected=error when the callback could
  // not verify the state): restore the draft that started the connection and report the outcome.
  // The query is stripped only once the restore has settled, so a re-run effect (StrictMode, remount)
  // still sees it; restoring twice is idempotent.
  useEffect(() => {
    const stored = readStoredDraft();
    const target = resolveOAuthReturn(window.location.search, stored?.businessId ?? null);
    if (!target) return;
    const stripReturnParams = () => { const url = new URL(window.location.href); url.searchParams.delete("business"); url.searchParams.delete("connected"); window.history.replaceState(null, "", url); };
    const businessId = target.businessId;
    let stopped = false;
    void (async () => {
      // No draft to restore (the callback dropped the business and this tab saved none): still report the failure.
      if (!businessId) { if (!stopped) { setConnectNotice(target.notice); stripReturnParams(); } return; }
      try {
        if (target.fromDraft && stored) {
          setLink(stored.link); setGoalId(stored.goalId); setGoalText(stored.goalText); setDraft({ businessId, url: stored.url, goal: stored.goal });
        } else {
          const { business } = await getBusiness(businessId);
          if (stopped) return;
          const savedGoal = business.goal === DEFAULT_CAMPAIGN_GOAL ? "" : business.goal;
          setLink(business.website ?? ""); setGoalText(savedGoal); setDraft({ businessId, url: business.website ?? "", goal: savedGoal });
        }
        setConnectNotice(target.notice);
        await loadMedia(businessId);
      } catch { if (!stopped) setError("We couldn’t restore your draft after connecting. Paste your link again to continue."); }
      finally { if (!stopped) stripReturnParams(); }
    })();
    return () => { stopped = true; };
  }, [loadMedia]);

  useEffect(() => () => { for (const item of queueRef.current) URL.revokeObjectURL(item.previewUrl); }, []);

  function fail(cause: unknown) {
    setError(cause instanceof Error ? cause.message : "Something went wrong. Please try again.");
    window.setTimeout(() => errorRef.current?.focus(), 0);
  }
  function addFiles(files: File[]) {
    const messages: string[] = [];
    const room = MAX_UPLOADS - queue.length - (media?.assets.length ?? 0);
    const accepted: QueuedFile[] = [];
    for (const file of files) {
      const check = classifyUpload(file);
      if (!check.ok) { messages.push(`${file.name}: ${check.error}`); continue; }
      if (accepted.length >= room) { messages.push(`${file.name}: you can add up to ${MAX_UPLOADS} files.`); continue; }
      accepted.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, kind: check.kind, mimeType: check.mimeType, previewUrl: URL.createObjectURL(file), status: "queued", progress: 0, error: null });
    }
    setRejected(messages.slice(0, 6));
    if (accepted.length) setQueue((items) => [...items, ...accepted]);
  }
  function removeQueued(id: string) {
    // Recorded synchronously so a running batch skips the file, and its request is aborted if in flight.
    removedRef.current.add(id);
    uploadsRef.current.get(id)?.abort();
    setQueue((items) => { const item = items.find((entry) => entry.id === id); if (item) URL.revokeObjectURL(item.previewUrl); return items.filter((entry) => entry.id !== id); });
  }
  async function removeUploaded(assetId: string) {
    if (!draft) return;
    try { await deleteBusinessMedia(draft.businessId, assetId); setMedia((current) => current && { ...current, assets: current.assets.filter((asset) => asset.id !== assetId) }); }
    catch (cause) { fail(cause); }
  }
  function patchQueued(id: string, patch: Partial<QueuedFile>) { setQueue((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item)); }

  function validLink(): string {
    setLinkTouched(true);
    if (!normalized.ok) { linkRef.current?.focus(); throw new Error(normalized.error); }
    return normalized.url;
  }
  async function ensureDraft(url: string): Promise<string> {
    if (draft && !draftStale) return draft.businessId;
    setBusy("draft");
    const { business } = await createBusiness(url, goal);
    setDraft({ businessId: business.id, url, goal });
    setMedia(null); setMediaStatus("idle");
    return business.id;
  }
  function consentReady(): PeopleVisible {
    if (!queue.length) return "consented";
    if (rights && people) { setConsentError(false); return people; }
    setConsentError(true); window.setTimeout(() => consentRef.current?.focus(), 0);
    throw new Error("Confirm the rights to your photos and videos before they upload.");
  }
  async function uploadQueued(businessId: string, consent: PeopleVisible, signal: AbortSignal) {
    const pending = queueRef.current.filter((item) => item.status !== "uploading" && !removedRef.current.has(item.id));
    if (!pending.length) return;
    setBusy("upload");
    let unremoved = 0;
    // Assets this library already lists, or that a kept file of this batch uploaded: never undone.
    // (Only when the listed library belongs to this business: a fresh draft starts empty.)
    const kept = new Set(draft?.businessId === businessId ? (media?.assets ?? []).map((asset) => asset.id) : []);
    const { failures } = await uploadBatch(pending, signal, {
      isRemoved: (id) => removedRef.current.has(id),
      track: (id, controller) => { if (controller) uploadsRef.current.set(id, controller); else uploadsRef.current.delete(id); },
      onStart: (item) => patchQueued(item.id, { status: "uploading", progress: 0, error: null }),
      upload: (item, itemSignal) => uploadMedia(businessId, item.file, item.mimeType, consent, (progress) => patchQueued(item.id, { progress }), itemSignal),
      onUploaded: (item, asset) => {
        kept.add(asset.id);
        URL.revokeObjectURL(item.previewUrl);
        setQueue((items) => items.filter((entry) => entry.id !== item.id));
        // The server de-duplicates by content and returns the existing asset: never list it twice.
        setMedia((current) => ({ assets: current?.assets.some((existing) => existing.id === asset.id) ? current.assets : [...(current?.assets ?? []), asset], connection: current?.connection ?? { status: "disconnected", provider: "meta", accountName: null, instagramUsername: null, pageName: null, expiresAt: null, mediaCount: null } }));
      },
      // The owner removed this file but its upload had already completed: take it back out of the library.
      onRemovedAfterUpload: async (_item, asset) => {
        if (kept.has(asset.id)) return; // The server de-duplicated it onto a file the owner kept.
        try { await deleteBusinessMedia(businessId, asset.id); }
        catch {
          unremoved += 1;
          setMedia((current) => current && !current.assets.some((existing) => existing.id === asset.id) ? { ...current, assets: [...current.assets, asset] } : current);
        }
      },
      onFailed: (item, cause) => patchQueued(item.id, { status: "error", progress: 0, error: cause instanceof Error ? cause.message : "The upload failed." }),
      onCancelled: (item) => patchQueued(item.id, { status: "queued", progress: 0, error: null }),
      stopAfter: (cause) => cause instanceof HttpError && cause.status === 404,
    });
    if (unremoved) throw new Error(`${unremoved === 1 ? "A file you removed" : `${unremoved} files you removed`} had already uploaded and couldn’t be taken back out. Remove ${unremoved === 1 ? "it" : "them"} from your uploaded files before running.`);
    if (failures) throw new Error(`${failures} file${failures === 1 ? "" : "s"} didn’t upload. Try again, or remove ${failures === 1 ? "it" : "them"} to continue without.`);
  }
  function cancelUpload() { batchRef.current?.abort(); }
  /** One controller per Run/Connect action: cancelling or leaving stops the uploads and the step after them. */
  function beginBatch(): AbortSignal {
    batchRef.current?.abort();
    const controller = new AbortController();
    batchRef.current = controller;
    return controller.signal;
  }
  function settle(cause: unknown) {
    if (cause instanceof UploadCancelledError) { if (mountedRef.current) setStoppedNotice(cause.message); return; }
    fail(cause);
  }

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    setError(null); setStoppedNotice(null);
    const signal = beginBatch();
    try {
      const url = validLink();
      const consent = consentReady();
      const businessId = await ensureDraft(url);
      await uploadQueued(businessId, consent, signal);
      // Cancelled, or the owner left the intake: never start a run they walked away from.
      if (signal.aborted || !mountedRef.current) throw new UploadCancelledError();
      setBusy("start");
      const { run: started } = await startAutopilotRun(businessId);
      writeStoredDraft(null);
      if (mountedRef.current) onStarted(started);
    } catch (cause) { settle(cause); }
    finally { if (batchRef.current?.signal === signal) batchRef.current = null; if (mountedRef.current) setBusy(null); }
  }
  async function connect() {
    if (disabled) return;
    setError(null); setStoppedNotice(null);
    const signal = beginBatch();
    try {
      if (!attest) throw new Error("Confirm the media attestation to connect your accounts.");
      const url = validLink();
      const consent = consentReady();
      const businessId = await ensureDraft(url);
      await uploadQueued(businessId, consent, signal);
      if (signal.aborted || !mountedRef.current) throw new UploadCancelledError();
      setBusy("connect");
      const body = await loadMedia(businessId);
      if (!body) { setConnectNotice("not_configured"); return; }
      if (body.connection.status === "not_configured") { setConnectNotice("not_configured"); return; }
      if (signal.aborted || !mountedRef.current) throw new UploadCancelledError();
      writeStoredDraft({ businessId, url, goal, link, goalId, goalText });
      window.location.assign(connectUrl(businessId));
    } catch (cause) { settle(cause); }
    finally { if (batchRef.current?.signal === signal) batchRef.current = null; if (mountedRef.current) setBusy(null); }
  }
  async function disconnect() {
    if (!draft || disabled) return;
    try { await disconnectMeta(draft.businessId); await loadMedia(draft.businessId); setConnectNotice(null); }
    catch (cause) { fail(cause); }
  }

  const LinkIcon = normalized.ok ? linkIcons[normalized.kind] : Search;
  const connectHidden = connectNotice === "not_configured" || mediaStatus === "unavailable" || connection?.status === "not_configured";
  const actionLabel = busy === "draft" ? "Saving your link…" : busy === "upload" ? "Uploading your files…" : busy === "start" ? "Starting Autopilot…" : busy === "connect" ? "Opening Meta login…" : "Run Autopilot";

  return <div className="ap-intake">
    <header className="ap-hero">
      <span className="ap-kicker"><WandSparkles size={14} />Autopilot</span>
      <h1>One link. One goal.<br /><em>A finished campaign.</em></h1>
      <p>Share your listing or website and what you’d like to achieve. Tickr researches the business, studies your photos and videos, and comes back with a reel-ready campaign kit for your approval.</p>
    </header>

    <form className="ap-intake-card" onSubmit={run} noValidate aria-describedby={`${ids}-promise`}>
      {error && <div className="ap-error" role="alert" tabIndex={-1} ref={errorRef}><strong>We couldn’t start yet</strong><p>{error}</p></div>}
      <div className="ap-link-field">
        <label htmlFor={`${ids}-link`}>Your business link</label>
        <div className={`ap-link-input ${showLinkError ? "has-error" : ""}`}>
          <LinkIcon size={22} strokeWidth={1.7} aria-hidden="true" />
          <input ref={linkRef} id={`${ids}-link`} type="text" inputMode="url" autoComplete="url" spellCheck={false} maxLength={2048} required value={link} disabled={disabled} onChange={(event) => setLink(event.target.value)} onBlur={() => setLinkTouched(true)} placeholder="Paste your Google Maps, website or Instagram link" aria-invalid={showLinkError} aria-describedby={`${ids}-link-help`} />
          {normalized.ok && <span className="ap-link-kind">{LINK_KIND_LABEL[normalized.kind]}</span>}
        </div>
        <p id={`${ids}-link-help`} className={showLinkError ? "ap-field-error" : "ap-help"}>{showLinkError && !normalized.ok ? normalized.error : "Tickr finds your name, neighbourhood, story and offerings from public sources — no forms to fill."}</p>
      </div>

      <fieldset className="ap-goal" disabled={disabled}>
        <legend>What should this campaign do?</legend>
        <div className="ap-chips">{GOALS.map((item) => <button key={item.id} type="button" className={`ap-chip ${goalId === item.id ? "is-selected" : ""}`} aria-pressed={goalId === item.id} onClick={() => setGoalId((current) => current === item.id ? null : item.id)}>{goalId === item.id && <CircleCheck size={14} aria-hidden="true" />}{item.label}</button>)}</div>
        <label className="ap-visually-hidden" htmlFor={`${ids}-goal`}>Add your own words (optional)</label>
        <textarea id={`${ids}-goal`} rows={2} maxLength={600} value={goalText} onChange={(event) => setGoalText(event.target.value)} placeholder={goalId ? "Anything specific? e.g. our new pistachio croissant, weekday mornings" : "Or say it in your own words — e.g. get more people in for weekday breakfast"} />
      </fieldset>

      {media?.mediaError && <p className="ap-hint is-warning" role="status">{media.mediaError}</p>}
      <div className="ap-extras">
        <MediaDropzone queue={queue} uploaded={media?.assets ?? []} rejected={rejected} disabled={disabled} rights={rights} people={people} consentError={consentError} consentRef={consentRef}
          onAdd={addFiles} onRemoveQueued={removeQueued} onRemoveUploaded={(assetId) => void removeUploaded(assetId)} onRights={(value) => { setRights(value); if (value && people) setConsentError(false); }} onPeople={(value) => { setPeople(value); if (rights) setConsentError(false); }} />
        <section className="ap-connect" aria-labelledby={`${ids}-connect`}>
          <div className="ap-card-heading"><span className="ap-card-icon" aria-hidden="true"><PlugZap size={18} strokeWidth={1.7} /></span><div><h2 id={`${ids}-connect`}>Connect Instagram / Facebook <span className="ap-optional">Optional</span></h2><p>Let Autopilot use the photos and videos you’ve already posted.</p></div></div>
          {connection?.status === "connected" ? <div className="ap-connected" role="status">
            <CircleCheck size={18} />
            <div><strong>{connection.instagramUsername ? `@${connection.instagramUsername}` : connection.accountName ?? "Account connected"}</strong><span>{[connection.pageName, typeof connection.mediaCount === "number" ? `${connection.mediaCount} posts available` : null].filter(Boolean).join(" · ") || "Connected through Meta login"}</span></div>
            <button type="button" className="ap-text-button" onClick={() => void disconnect()} disabled={disabled}><Unplug size={13} />Disconnect</button>
          </div> : connectHidden ? <p className="ap-hint">Account connection isn’t set up on this Tickr install. Autopilot will use your website and any files you add.</p> : <>
            {connection?.status === "expired" && <p className="ap-hint is-warning">Your connection expired. Reconnect to include recent posts.</p>}
            {connectNotice === "error" && <p className="ap-hint is-warning" role="status">The connection didn’t complete. You can try again or continue without it.</p>}
            <label className="ap-check"><input type="checkbox" checked={attest} disabled={disabled} onChange={(event) => setAttest(event.target.checked)} /><span>I own or license the media on these accounts, and people shown have agreed to appear in my business’s marketing.</span></label>
            <button type="button" className="button button-secondary ap-connect-button" disabled={disabled || !attest} onClick={() => void connect()}>{busy === "connect" ? <LoaderCircle size={15} className="spin" /> : <Link2 size={15} />}{connection?.status === "expired" ? "Reconnect with Meta" : "Connect with Meta"}</button>
            <p className="ap-help">You’ll sign in on Meta. Tickr only reads your media; it never posts.</p>
          </>}
          {connectNotice === "returned" && connection?.status === "connected" && <p className="ap-hint is-success" role="status">Connected. Your draft is just as you left it.</p>}
        </section>
      </div>

      <div className="ap-cta-row">
        <button className="button button-primary ap-run" type="submit" disabled={disabled} aria-describedby={`${ids}-cta-note`}>{busy ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}{actionLabel}{!busy && <ArrowRight size={18} />}</button>
        {busy === "upload" && <button type="button" className="button button-secondary ap-cancel-upload" onClick={cancelUpload}><CircleStop size={16} />Cancel upload</button>}
        <p id={`${ids}-cta-note`}>{restoring ? "Checking your saved workspace…" : stoppedNotice && !busy ? stoppedNotice : anchored && draftStale ? <span className="ap-stale">The link or goal changed after you added files or connected. Running now starts a fresh draft without them.</span> : "Usually a few minutes. You can leave this page — the run keeps going."}</p>
      </div>
    </form>

    <section className="ap-promise" id={`${ids}-promise`} aria-label="What Autopilot does">
      <div className="ap-promise-col"><h2><Sparkles size={15} />What happens</h2><ol>
        <li><span>1</span>Finds your business from the link and reads cited public sources.</li>
        <li><span>2</span>Picks the best-supported campaign idea for your goal.</li>
        <li><span>3</span>Studies every photo and video, cuts out your real products with SAM and renders the Reel and carousel.</li>
        <li><span>4</span>Critiques its own work, fixes what it can, and hands you one kit to approve.</li>
      </ol></div>
      <div className="ap-promise-col is-never"><h2><ShieldCheck size={15} />What never happens without you</h2><ul>
        <li><Ban size={15} />Nothing is published to any account.</li>
        <li><CircleDollarSign size={15} />No ad budget is spent.</li>
        <li><MessageSquareOff size={15} />No messages are sent to anyone.</li>
      </ul><p>Generated summaries stay labelled as such, and your approval is tied to the exact files you reviewed.</p></div>
    </section>
  </div>;
}
