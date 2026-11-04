"use client";

import { useState } from "react";
import { Ban, Check, CircleAlert, Clapperboard, Crosshair, Eye, Film, ImageOff, Layers3, LoaderCircle, Route, ScanEye, Sparkles, Target } from "lucide-react";
import type { RunView } from "@/lib/research/contracts";
import type { AutopilotPublicState } from "@/lib/autopilot/public-state";
import { BoxedImage } from "./boxed-image";
import { RealMediaCard } from "./real-media-card";
import { autopilotFileUrl, CHANNEL_LABEL, deriveRail, directorLog, GOAL_FIT_LABEL, isListed, type IntakeFocus, type MediaStateStatus, mediaWallMode, PROVENANCE_LABEL, REEL_MODE_LABEL, RIGHTS_LABEL, roleBadges, roomHeadline, SAM_ORIGIN_LABEL, type PublicMedia, type RailStep } from "./model";

export type StateStatus = MediaStateStatus;

export function PhaseRail({ steps, compact = false }: { steps: RailStep[]; compact?: boolean }) {
  const active = steps.find((step) => step.status === "active" || step.status === "failed");
  return <nav className={`ap-rail ${compact ? "is-compact" : ""}`} aria-label="Autopilot progress">
    <ol>{steps.map((step, index) => <li key={step.id} className={`is-${step.status}`} aria-current={step.status === "active" ? "step" : undefined}>
      <span className="ap-rail-dot" aria-hidden="true">{step.status === "done" ? <Check size={12} strokeWidth={2.4} /> : step.status === "failed" ? <CircleAlert size={12} /> : step.status === "active" ? <span className="ap-rail-pulse" /> : index + 1}</span>
      <span className="ap-rail-label">{step.label}<span className="ap-visually-hidden">{step.status === "done" ? " — done" : step.status === "active" ? " — in progress" : step.status === "failed" ? " — needs attention" : " — not started"}</span></span>
    </li>)}</ol>
    {active && !compact && <p className="ap-rail-hint" aria-hidden="true">{active.hint}</p>}
  </nav>;
}

export function DirectorLog({ run, state }: { run: RunView; state: AutopilotPublicState | null }) {
  const entries = directorLog(run.events, 8);
  const busy = ["queued", "running"].includes(run.status);
  return <section className="ap-panel ap-log" aria-labelledby="ap-log-title">
    <div className="ap-panel-head"><h2 id="ap-log-title"><Clapperboard size={16} />Director’s log</h2>{busy && <span className="ap-live"><span />Live</span>}</div>
    {state?.headline && <p className="ap-log-headline">{state.headline}</p>}
    <ol className="ap-log-list" aria-live="polite" aria-relevant="additions" aria-atomic="false">
      {entries.length ? entries.map((entry, index) => <li key={entry.key} className={index === 0 && busy ? "is-latest" : ""}><time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><p>{entry.message}</p></li>) : <li><time>—</time><p>Waiting for the local worker to pick up this run.</p></li>}
    </ol>
  </section>;
}

function MediaTile({ media, runId, state }: { media: PublicMedia; runId: string; state: AutopilotPublicState }) {
  const thumb = isListed(state, media.thumb) ? autopilotFileUrl(runId, media.thumb) : null;
  const subject = media.analysis?.primarySubject;
  const excluded = media.status === "excluded";
  const roles = roleBadges(media);
  const hero = roles.includes("HERO");
  const describe = [media.analysis?.depicts, subject ? `Primary subject: ${subject.label}` : null, excluded && media.excludedReasons.length ? `Excluded: ${media.excludedReasons.join("; ")}` : null].filter(Boolean).join(". ");
  const tipId = `ap-media-tip-${media.assetId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return <li className={`ap-tile is-${media.status} ${hero ? "is-hero" : ""}`} tabIndex={0} aria-describedby={describe ? tipId : undefined}>
    <div className="ap-tile-frame">
      <BoxedImage src={thumb} width={media.width} height={media.height} label={media.analysis?.depicts ? `${PROVENANCE_LABEL[media.provenance]} ${media.kind}: ${media.analysis.depicts}` : `${PROVENANCE_LABEL[media.provenance]} ${media.kind}`} boxes={subject?.box ? [{ id: "subject", box: subject.box, tone: "subject" }] : []} />
      {media.kind === "video" && <span className="ap-tile-kind"><Film size={11} />{media.durationSeconds ? `${media.durationSeconds.toFixed(0)}s` : "Video"}</span>}
      {media.status === "harvested" && <span className="ap-tile-scan" aria-hidden="true" />}
      {excluded && <span className="ap-tile-excluded"><Ban size={12} />Excluded</span>}
    </div>
    <div className="ap-tile-badges">
      <span className={`ap-badge is-${media.provenance}`} title={RIGHTS_LABEL[media.rights]}>{PROVENANCE_LABEL[media.provenance]}</span>
      {media.analysis && <span className={`ap-badge is-fit-${media.analysis.goalFit}`}>{GOAL_FIT_LABEL[media.analysis.goalFit]}</span>}
      {roles.map((role) => <span key={role} className={`ap-badge ${role === "HERO" ? "is-hero" : "is-role"}`}>{role}</span>)}
    </div>
    {describe && <div className="ap-tile-tip" role="tooltip" id={tipId}>{media.analysis?.depicts && <p>{media.analysis.depicts}</p>}{subject && <p><Crosshair size={11} />{subject.label}</p>}{excluded && media.excludedReasons.map((reason, index) => <p key={index} className="is-reason"><Ban size={11} />{reason}</p>)}<p className="is-rights">{RIGHTS_LABEL[media.rights]}</p></div>}
  </li>;
}

export function MediaWall({ run, state, status }: { run: RunView; state: AutopilotPublicState | null; status: StateStatus }) {
  const media = state?.media ?? [];
  const counts = state?.sources;
  const analyzed = media.filter((item) => item.analysis).length;
  const mode = mediaWallMode(run, status, media.length);
  const gathered = counts ? [counts.officialWebsite ? `${counts.officialWebsite} from the website` : null, counts.ownerUploads ? `${counts.ownerUploads} uploaded` : null, counts.ownerInstagram ? `${counts.ownerInstagram} from Instagram` : null, counts.ownerFacebook ? `${counts.ownerFacebook} from Facebook` : null].filter(Boolean).join(" · ") : "";
  return <section className="ap-panel ap-wall" aria-labelledby="ap-wall-title">
    <div className="ap-panel-head"><h2 id="ap-wall-title"><Eye size={16} />Media wall</h2>{media.length > 0 && <span className="ap-count">{analyzed}/{media.length} studied</span>}</div>
    {counts && (gathered || mode === "skeleton") && <p className="ap-sources-line">{gathered || "Gathering photos and videos…"}</p>}
    {mode === "unavailable" ? <p className="ap-empty-note"><ImageOff size={16} />The live media view isn’t available in this build. Progress continues in the director’s log.</p>
      : mode === "grid" ? <ul className="ap-wall-grid">{media.map((item) => <MediaTile key={item.assetId} media={item} runId={run.id} state={state!} />)}</ul>
      : mode === "skeleton" ? <ul className="ap-wall-grid is-skeleton" aria-label="Media loading">{Array.from({ length: 8 }, (_, index) => <li key={index} className="ap-skeleton-tile" aria-hidden="true" />)}</ul>
      : <p className="ap-empty-note" role="status"><ImageOff size={16} />{mode === "loading" ? "Loading what Autopilot gathered…" : mode === "error" ? "Autopilot couldn’t load the photos and videos for this run. Reload the page to try again; the director’s log still shows what happened." : mode === "empty_failed" ? "Autopilot stopped before it gathered any photos or videos. Try resuming the run above." : "No photos or videos were gathered for this run."}</p>}
    {media.length > 0 && <p className="ap-fineprint">Outlines are Muse Spark’s located observations, not verified product identity. Hover or focus a tile for its reasons.</p>}
  </section>;
}

export function SamPanel({ run, state }: { run: RunView; state: AutopilotPublicState | null }) {
  const [samView, setSamView] = useState(true);
  const entries = state?.sam ?? [];
  if (!entries.length) return null;
  return <section className="ap-panel ap-sam" aria-labelledby="ap-sam-title">
    <div className="ap-panel-head"><h2 id="ap-sam-title"><ScanEye size={16} />SAM 3.1 selections</h2>
      <label className="ap-switch"><input type="checkbox" role="switch" checked={samView} onChange={(event) => setSamView(event.target.checked)} /><span aria-hidden="true" />How SAM saw it</label></div>
    <ul className="ap-sam-grid">{entries.map((entry, index) => {
      const media = state?.media.find((item) => item.assetId === entry.assetId);
      const original = media && isListed(state, media.thumb) ? autopilotFileUrl(run.id, media.thumb) : null;
      const preview = isListed(state, entry.preview) ? autopilotFileUrl(run.id, entry.preview) : null;
      const overlay = isListed(state, entry.overlayVideo) ? autopilotFileUrl(run.id, entry.overlayVideo) : null;
      const showSam = samView && (preview || overlay);
      const width = media?.width ?? 1080; const height = media?.height ?? 1350;
      return <li key={`${entry.assetId}-${index}`} className={`ap-sam-card is-${entry.status}`}>
        <div className="ap-sam-media" style={{ aspectRatio: `${width} / ${height}` }}>
          {showSam && overlay ? <video src={overlay} muted loop playsInline autoPlay={!prefersReducedMotion()} controls aria-label={`SAM tracking overlay for ${entry.label}`} />
            : <BoxedImage src={showSam ? preview : original ?? preview} width={width} height={height} label={showSam ? `SAM mask preview: ${entry.label}` : `Original: ${entry.label}`} />}
        </div>
        <div className="ap-sam-meta">
          <strong>{entry.label}</strong>
          <span>{SAM_ORIGIN_LABEL[entry.origin]} · {entry.promptKind === "geometry" ? "box prompt" : "concept prompt"}</span>
          <span className={`ap-badge is-sam-${entry.status}`}>{entry.status === "tracked" ? `Tracked${entry.framesTracked ? ` · ${entry.framesTracked} frames` : ""}` : entry.status === "segmented" ? `Selected${entry.coverage !== null ? ` · ${Math.round(entry.coverage * 100)}% of frame` : ""}` : entry.status.replace("_", " ")}</span>
        </div>
      </li>;
    })}</ul>
    <p className="ap-fineprint">SAM selects real pixels from your media. A selection is not proof of what the product is; review it like any other claim.</p>
  </section>;
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function MiniThumb({ run, state, assetId, label }: { run: RunView; state: AutopilotPublicState; assetId: string | null; label: string }) {
  const media = assetId ? state.media.find((item) => item.assetId === assetId) : null;
  return <span className="ap-mini">{media ? <BoxedImage src={isListed(state, media.thumb) ? autopilotFileUrl(run.id, media.thumb) : null} width={media.width} height={media.height} label={label} fit="slice" /> : <span className="ap-mini-empty" role="img" aria-label={`${label}: no asset`}><Sparkles size={14} /></span>}</span>;
}

export function PlanCard({ run, state }: { run: RunView; state: AutopilotPublicState | null }) {
  const plan = state?.plan;
  if (!state || !plan) return null;
  return <section className="ap-panel ap-plan" aria-labelledby="ap-plan-title">
    <div className="ap-panel-head"><h2 id="ap-plan-title"><Route size={16} />Production plan</h2><span className="ap-count">{REEL_MODE_LABEL[plan.reelMode]}</span></div>
    <div className="ap-plan-hero"><MiniThumb run={run} state={state} assetId={plan.heroAssetId} label="Hero asset" /><div><span className="ap-label">HERO</span><p>{plan.heroAssetId ? state.media.find((item) => item.assetId === plan.heroAssetId)?.analysis?.depicts ?? "Chosen hero asset" : "No real photo was strong enough; an illustration fills in."}</p></div></div>
    {plan.carousel.length > 0 && <div><span className="ap-label">CAROUSEL ORDER</span><ol className="ap-plan-carousel">{plan.carousel.map((assetId, index) => <li key={`${assetId}-${index}`}><MiniThumb run={run} state={state} assetId={assetId} label={`Carousel slide ${index + 1}`} /><span className="ap-plan-num" aria-hidden="true">{index + 1}</span></li>)}</ol></div>}
    <div><span className="ap-label">REEL · {REEL_MODE_LABEL[plan.reelMode].toUpperCase()}</span><ul className="ap-reasons">{plan.reelReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>
    {Object.keys(plan.channelAssets).length > 0 && <div><span className="ap-label">CHANNEL ROUTING</span><ul className="ap-routing">{Object.entries(plan.channelAssets).map(([channel, assetId]) => <li key={channel}><MiniThumb run={run} state={state} assetId={assetId} label={CHANNEL_LABEL[channel] ?? channel} /><span>{CHANNEL_LABEL[channel] ?? channel.replaceAll("_", " ")}</span></li>)}</ul></div>}
    {plan.notes.length > 0 && <ul className="ap-reasons is-notes">{plan.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
  </section>;
}

const basisLabel = { report_recommendation: "Research recommendation", highest_complete_score: "Highest complete score", first_supported: "First supported idea" } as const;
export function SelectionCard({ run }: { run: RunView }) {
  const selection = run.selection;
  if (!selection) return null;
  const opportunity = run.report?.opportunities.find((item) => item.id === selection.opportunityId);
  return <section className="ap-panel ap-selection" aria-labelledby="ap-selection-title">
    <div className="ap-panel-head"><h2 id="ap-selection-title"><Target size={16} />The idea Autopilot chose</h2>{"score" in selection && selection.score !== null && <span className="ap-count">{selection.score}/100</span>}</div>
    {opportunity && <h3>{opportunity.title}</h3>}
    {"basis" in selection ? <><span className="ap-label">{basisLabel[selection.basis]}</span><p>{selection.rationale}</p></> : <p>Chosen by you in the step-by-step studio.</p>}
    {opportunity && <p className="ap-fineprint">{opportunity.hypothesis}</p>}
  </section>;
}

export function DirectorsRoom({ run, state, stateStatus, onRetry, retrying, onStudio, onAddMedia }: { run: RunView; state: AutopilotPublicState | null; stateStatus: StateStatus; onRetry: () => void; retrying: boolean; onStudio: () => void; onAddMedia?: (focus: IntakeFocus) => void }) {
  const rail = deriveRail(run, state);
  const busy = ["queued", "running"].includes(run.status);
  const headline = roomHeadline(run);
  const waitingOnOwner = run.status === "waiting";
  return <div className="ap-room">
    <header className="ap-room-head">
      <div>
        <span className="ap-kicker"><Layers3 size={14} />Director’s room</span>
        <h1>{headline.pending ? <span className="ap-shimmer-text">{headline.text}</span> : headline.text}</h1>
        <p>{[run.discovery?.locality ?? run.business.locality, run.business.goal].filter(Boolean).join(" · ")}</p>
      </div>
      <span className={`ap-status ${run.status === "failed" ? "is-failed" : waitingOnOwner ? "is-waiting" : ""}`} role="status">{busy ? <LoaderCircle size={14} className="spin" /> : run.status === "failed" ? <CircleAlert size={14} /> : <Check size={14} />}{busy ? "Autopilot is working" : run.status === "failed" ? "Needs attention" : waitingOnOwner ? "Paused for you" : "Finished"}</span>
    </header>
    <PhaseRail steps={rail.steps} />
    {run.status === "failed" && <div className="ap-error" role="alert"><strong>Autopilot stopped</strong><p>{run.error ?? "This run could not finish."}</p><div className="ap-error-actions"><button type="button" className="button button-secondary" onClick={onRetry} disabled={retrying}>{retrying ? <LoaderCircle size={15} className="spin" /> : null}{retrying ? "Checking…" : "Try resuming"}</button></div></div>}
    {waitingOnOwner && <div className="ap-notice" role="status"><strong>Autopilot needs a little more from you.</strong><p>{run.error ?? "The research didn’t find enough supported evidence to choose a campaign on its own. Review the open questions in the step-by-step studio."}</p><button type="button" className="button button-secondary" onClick={onStudio}>Open the step-by-step studio</button></div>}
    {!busy && run.status !== "failed" && !waitingOnOwner && run.error && <div className="ap-notice" role="status"><p>{run.error}</p></div>}
    {onAddMedia && <RealMediaCard run={run} state={state} onAddMedia={onAddMedia} />}
    <div className="ap-room-grid">
      <div className="ap-room-main">
        <MediaWall run={run} state={state} status={stateStatus} />
        <SamPanel run={run} state={state} />
      </div>
      <aside className="ap-room-side" aria-label="Autopilot decisions">
        <DirectorLog run={run} state={state} />
        <SelectionCard run={run} />
        <PlanCard run={run} state={state} />
      </aside>
    </div>
  </div>;
}
