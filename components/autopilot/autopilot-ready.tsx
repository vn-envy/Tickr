"use client";

import { useId, useMemo, useState } from "react";
import { BadgeCheck, CircleAlert, CircleCheck, Download, FileArchive, Fingerprint, Gauge, Images, LoaderCircle, ScanEye, ShieldAlert, ShieldCheck, Smartphone } from "lucide-react";
import type { RunView } from "@/lib/research/contracts";
import type { AutopilotPublicState } from "@/lib/autopilot/public-state";
import { CampaignPanel, ExportPanel } from "../research-panels";
import { BoxedImage } from "./boxed-image";
import { RealMediaCard } from "./real-media-card";
import { DirectorLog, MediaWall, PhaseRail, PlanCard, SamPanel, SelectionCard, type StateStatus } from "./directors-room";
import { APPROVAL_STATEMENT, approvalReview, approvedDownloads, autopilotFileUrl, campaignFilename, carouselAssets, deriveRail, findingTarget, formatBytes, type IntakeFocus, offerableArchive, REEL_MODE_LABEL, reelAsset, runFileUrl, serverWithheld, shortDigest, trackingOverlay, withoutWithheld } from "./model";

function ReelPlayer({ run, state, withheld }: { run: RunView; state: AutopilotPublicState | null; withheld: ReadonlySet<string> }) {
  const reel = reelAsset(run.campaign);
  const reelWithheld = Boolean(reel && withheld.has(reel.filename));
  const overlay = trackingOverlay(state);
  const [view, setView] = useState<"reel" | "tracking">("reel");
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showing = view === "tracking" && overlay ? "tracking" : "reel";
  const src = showing === "tracking" && overlay ? autopilotFileUrl(run.id, overlay) : reel ? runFileUrl(run.id, reel.filename) : null;
  return <figure className="ap-phone-wrap">
    <div className="ap-phone"><div className="ap-phone-notch" aria-hidden="true" />
      {src && failedSrc !== src ? <video key={src} src={src} controls playsInline loop preload="metadata" onError={() => setFailedSrc(src)} aria-label={showing === "tracking" ? "SAM tracking overlay video" : "Instagram Reel concept"} /> : <div className="ap-phone-empty" role="img" aria-label="Reel unavailable"><Smartphone size={26} strokeWidth={1.4} /><p>{src ? "This video couldn’t be loaded. Reload the page, or download the kit to watch it." : "No Reel was rendered for this kit. The channel copy and images are below."}</p></div>}
    </div>
    {overlay && reel && <div className="ap-segmented" role="group" aria-label="Reel view">
      <button type="button" aria-pressed={showing === "reel"} onClick={() => setView("reel")}>Reel</button>
      <button type="button" aria-pressed={showing === "tracking"} onClick={() => setView("tracking")}><ScanEye size={13} />How SAM tracked it</button>
    </div>}
    <figcaption>{showing === "tracking" ? "SAM 3.1 masklets over the source clip — real pixels, selected, not generated." : "Concept · needs your review before any use."}{reelWithheld && showing === "reel" && <span className="ap-withheld"><ShieldAlert size={12} />Withheld · not part of the approval</span>}</figcaption>
  </figure>;
}

function CarouselStrip({ run, withheld }: { run: RunView; withheld: ReadonlySet<string> }) {
  const slides = carouselAssets(run.campaign);
  if (!slides.length) return null;
  return <section className="ap-carousel" aria-labelledby="ap-carousel-title"><h2 id="ap-carousel-title"><Images size={15} />Carousel · {slides.length} slides</h2>
    <ol>{slides.map((asset, index) => { const held = withheld.has(asset.filename); return <li key={asset.id} className={held ? "is-withheld" : undefined}><BoxedImage src={runFileUrl(run.id, asset.filename)} width={asset.width ?? 1080} height={asset.height ?? 1350} label={`Carousel slide ${index + 1}${held ? ", withheld from approval" : ""}`} fit="slice" /><span>{index + 1}</span>{held && <em className="ap-slide-withheld" aria-hidden="true">Withheld</em>}</li>; })}</ol>
  </section>;
}

function QualitySummary({ run }: { run: RunView }) {
  const quality = run.quality;
  if (!quality) return null;
  const items = [
    { label: "Reel", value: REEL_MODE_LABEL[quality.reelMode] },
    { label: "Media studied", value: String(quality.mediaAnalyzed) },
    { label: "Set aside", value: String(quality.mediaExcluded) },
    { label: "Critic findings", value: String(quality.findings) },
  ];
  return <section className="ap-quality" aria-labelledby="ap-quality-title"><h2 id="ap-quality-title"><Gauge size={15} />Quality record</h2>
    <dl>{items.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
    {quality.fixesApplied.length > 0 && <details><summary>{quality.fixesApplied.length} automatic fix{quality.fixesApplied.length === 1 ? "" : "es"} applied</summary><ul>{quality.fixesApplied.map((fix, index) => <li key={index}>{fix}</li>)}</ul></details>}
    {quality.notes.length > 0 && <details><summary>Production notes</summary><ul>{quality.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
  </section>;
}

const verdictCopy = {
  no_blocking_findings: { title: "No blocking issues found", tone: "is-good", Icon: ShieldCheck },
  blocking_findings: { title: "Blocking issues — affected files withheld", tone: "is-bad", Icon: ShieldAlert },
  not_run: { title: "The self-critique did not run", tone: "is-neutral", Icon: CircleAlert },
} as const;

function CriticPanel({ run, state }: { run: RunView; state: AutopilotPublicState | null }) {
  const critic = state?.critic;
  const verdict = critic?.verdict ?? run.quality?.criticVerdict;
  const withheld = serverWithheld(run);
  if (!verdict) return null;
  const { title, tone, Icon } = verdictCopy[verdict];
  return <section className={`ap-panel ap-critic ${tone}`} aria-labelledby="ap-critic-title">
    <div className="ap-panel-head"><h2 id="ap-critic-title"><Icon size={16} />Critic · {title}</h2>{critic && <span className="ap-count">{critic.findings.length} finding{critic.findings.length === 1 ? "" : "s"}</span>}</div>
    {critic && critic.findings.length > 0 && <ul className="ap-findings">{critic.findings.map((finding) => {
      const target = findingTarget(finding, run.id, state, run.campaign);
      return <li key={finding.id} className={`is-${finding.severity}`}>
        {target ? <BoxedImage className="ap-finding-thumb" src={target.src} width={target.width} height={target.height} label={`${target.label}${finding.box ? " with the finding outlined" : ""}`} boxes={[{ id: finding.id, box: finding.box, tone: finding.severity }]} /> : <span className="ap-finding-thumb ap-mini-empty" aria-hidden="true"><CircleAlert size={16} /></span>}
        <div><span className={`ap-severity is-${finding.severity}`}>{finding.severity}</span><strong>{finding.rule.replaceAll("_", " ")}</strong><p>{finding.description}</p>{typeof finding.timeSeconds === "number" && <span className="ap-fineprint">At {finding.timeSeconds.toFixed(1)} s</span>}{withheld.includes(campaignFilename(run.campaign, finding.assetId) ?? "") && <span className="ap-withheld">Withheld from approval</span>}</div>
      </li>;
    })}</ul>}
    {critic && critic.findings.length === 0 && <p className="ap-fineprint">Muse Spark reviewed the rendered assets against the evidence and visibility rules and raised nothing.</p>}
    {critic && critic.fixesApplied.length > 0 && <p className="ap-fineprint">Fixed automatically: {critic.fixesApplied.join(" · ")}</p>}
    {withheld.length > 0 && <div className="ap-withheld-list"><strong>Withheld files</strong><p>These stay out of your approval until the issue is resolved: {withheld.join(", ")}</p></div>}
  </section>;
}

/** After approval, when the ZIP can't be offered: the approved files, each still byte-identical, for individual download. */
function ApprovedFiles({ run }: { run: RunView }) {
  const files = approvedDownloads(run);
  if (!files.length) return <p className="ap-fineprint">The approved files no longer match this kit. Reload the page to review the current files.</p>;
  return <div className="ap-approval-files"><p className="ap-fineprint">The kit ZIP bundles withheld files, so download the approved files individually:</p>
    <ul>{files.map((file) => <li key={file.filename}><a href={runFileUrl(run.id, file.filename)} download={file.filename}><Download size={13} />{file.filename}</a><span>{formatBytes(file.bytes)}</span></li>)}</ul>
  </div>;
}

export function ApprovalBlock({ run, state, onApprove }: { run: RunView; state: AutopilotPublicState | null; onApprove: (digest: string) => Promise<void> }) {
  // The confirmation is bound to the digest it was given for: a refreshed kit (new digest) must be re-confirmed.
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkId = useId();
  const review = approvalReview(run, state);
  // Never the unfiltered archive: it bundles every kit file, withheld ones included.
  const archive = offerableArchive(run);
  const approval = run.approval;
  const digest = run.approvalDigest ?? null;
  const inconsistent = review.conflicts.length > 0;
  const confirmed = Boolean(digest) && confirmedFor === digest;
  const blocked = !digest || inconsistent || review.files.length === 0;
  async function approve() {
    if (!confirmed || busy || blocked || !digest) return;
    setBusy(true); setError(null);
    try { await onApprove(digest); }
    catch (cause) {
      setConfirmedFor(null); // Any failed approval (e.g. a changed kit) needs a fresh review and confirmation.
      setError(cause instanceof Error ? cause.message : "Approval could not be recorded.");
    }
    finally { setBusy(false); }
  }
  if (approval) return <section className="ap-approval is-approved" id="ap-approval" aria-labelledby="ap-approval-title">
    <BadgeCheck size={30} strokeWidth={1.5} />
    <h2 id="ap-approval-title">Approved by you</h2>
    <p>{new Date(approval.approvedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · {approval.files.length} files · digest <code title={approval.manifestDigest}>{shortDigest(approval.manifestDigest)}</code></p>
    <p className="ap-approved-note"><ShieldCheck size={15} />Nothing was published. Publishing, ad spend and messaging remain separate steps.</p>
    {approval.withheldFiles.length > 0 && <p className="ap-fineprint">Not included: {approval.withheldFiles.join(", ")}</p>}
    {archive ? <a className="button button-secondary" href={runFileUrl(run.id, archive.filename)} download={archive.filename}><Download size={15} />Download the kit (ZIP)</a>
      : <ApprovedFiles run={run} />}
  </section>;
  return <section className="ap-approval" id="ap-approval" aria-labelledby="ap-approval-title">
    <span className="ap-kicker"><Fingerprint size={14} />One approval</span>
    <h2 id="ap-approval-title">Approve these exact files.</h2>
    <dl className="ap-approval-facts"><div><dt>Files</dt><dd>{review.files.length} · {formatBytes(review.bytes)}</dd></div><div><dt>Withheld</dt><dd>{review.withheld.length}</dd></div><div><dt>Digest</dt><dd><code title={digest ?? undefined}>{shortDigest(digest)}</code></dd></div></dl>
    <details className="ap-approval-files"><summary>The {review.files.length} file{review.files.length === 1 ? "" : "s"} this approval covers</summary>
      <ul>{review.files.map((file) => <li key={file.filename}><code>{file.filename}</code><span>{formatBytes(file.bytes)} · <span title={file.sha256}>{shortDigest(file.sha256)}</span></span></li>)}</ul>
      {review.withheld.length > 0 && <p className="ap-fineprint">Withheld and not covered: {review.withheld.join(", ")}</p>}
    </details>
    {!inconsistent && review.withheld.length > 0 && <p className="ap-hint is-warning">{review.files.length > 0 ? "Some files are withheld from this approval; the rest can still be approved." : "Every file is withheld, so nothing can be approved. Run Autopilot again for a fresh critique."}</p>}
    {inconsistent && <div className="ap-error" role="alert"><strong>This kit is inconsistent</strong><p>The critic withheld {review.conflicts.join(", ")}, but {review.conflicts.length === 1 ? "it is" : "they are"} still in the approvable file list. Reload the page; approval stays off until the kit and its review agree.</p></div>}
    <label className="ap-check ap-approval-check" htmlFor={checkId}><input id={checkId} type="checkbox" checked={confirmed} disabled={busy || blocked} onChange={(event) => setConfirmedFor(event.target.checked ? digest : null)} required /><span>{APPROVAL_STATEMENT}</span></label>
    {error && <div className="ap-error" role="alert"><p>{error}</p></div>}
    <div className="ap-approval-actions">
      <button type="button" className="button button-primary" disabled={!confirmed || busy || blocked} onClick={() => void approve()}>{busy ? <LoaderCircle size={16} className="spin" /> : <CircleCheck size={16} />}{busy ? "Re-checking every file…" : "Approve campaign"}</button>
      {archive && <a className="button button-secondary" href={runFileUrl(run.id, archive.filename)} download={archive.filename}><FileArchive size={15} />Download ZIP</a>}
    </div>
    {!archive && review.withheld.length > 0 && <p className="ap-fineprint">The kit ZIP bundles the withheld files, so it isn’t offered. Each approvable file can be downloaded under “All files &amp; review notes”.</p>}
    <p className="ap-fineprint">{digest ? "Tickr re-hashes every file before recording your approval. If anything changed since you looked, it asks you to review again. Approving never publishes, spends or messages." : "This kit has no approvable digest yet. Reload to review the current files."}</p>
  </section>;
}

export function AutopilotReady({ run, state, stateStatus, onApprove, onAddMedia }: { run: RunView; state: AutopilotPublicState | null; stateStatus: StateStatus; onApprove: (digest: string) => Promise<void>; onAddMedia?: (focus: IntakeFocus) => void }) {
  const campaign = run.campaign!;
  const rail = deriveRail(run, state);
  const withheld = useMemo(() => new Set(serverWithheld(run)), [run]);
  // Channel previews and the file list show only what the approval can cover; withheld files are listed separately.
  const reviewable = useMemo(() => withoutWithheld(run), [run]);
  return <div className="ap-ready">
    <header className="ap-ready-head">
      <span className="ap-kicker"><CircleCheck size={14} />{run.approval ? "Approved" : "Ready for your review"}</span>
      <h1>{campaign.name}</h1>
      <p>{campaign.coreMessage}</p>
      <PhaseRail steps={rail.steps} compact />
    </header>
    {onAddMedia && <RealMediaCard run={run} state={state} onAddMedia={onAddMedia} />}
    <div className="ap-ready-grid">
      <ReelPlayer run={run} state={state} withheld={withheld} />
      <div className="ap-ready-side">
        <div className="ap-ready-strategy"><div><span className="ap-label">OBJECTIVE</span><p>{campaign.objective}</p></div><div><span className="ap-label">AUDIENCE</span><p>{campaign.audienceHypothesis}</p></div><div><span className="ap-label">CALL TO ACTION</span><p>{campaign.primaryCta}</p></div></div>
        <CarouselStrip run={run} withheld={withheld} />
        <QualitySummary run={run} />
        <a className="button button-primary ap-jump" href="#ap-approval">{run.approval ? "See your approval" : "Review & approve"}</a>
      </div>
    </div>
    <CriticPanel run={run} state={state} />
    <section className="ap-channels" aria-labelledby="ap-channels-title"><h2 id="ap-channels-title" className="ap-section-title">Every channel, ready to inspect</h2><CampaignPanel run={reviewable} onExport={() => document.getElementById("ap-approval")?.scrollIntoView({ behavior: "smooth", block: "start" })} /></section>
    <ApprovalBlock run={run} state={state} onApprove={onApprove} />
    <details className="ap-behind"><summary>Behind the scenes · how Autopilot made this</summary>
      <div className="ap-room-grid"><div className="ap-room-main"><MediaWall run={run} state={state} status={stateStatus} /><SamPanel run={run} state={state} /></div><aside className="ap-room-side"><SelectionCard run={run} /><PlanCard run={run} state={state} /><DirectorLog run={run} state={state} /></aside></div>
    </details>
    <details className="ap-behind"><summary>All files &amp; review notes</summary><ExportPanel run={reviewable} onStudio={() => undefined} /></details>
  </div>;
}
