"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { RunView } from "@/lib/research/contracts";
import type { AutopilotPublicState } from "@/lib/autopilot/public-state";
import { approveRun, getAutopilotState, getRun, HttpError, retryRun } from "./api";
import { AutopilotIntake } from "./autopilot-intake";
import { AutopilotReady } from "./autopilot-ready";
import { DirectorsRoom, type StateStatus } from "./directors-room";
import { isActiveRun, isUuid, RUN_STORAGE_KEY } from "./model";

function rememberRun(id: string) {
  try { window.localStorage.setItem(RUN_STORAGE_KEY, id); } catch { /* Browsing without storage is supported. */ }
  const url = new URL(window.location.href); url.searchParams.set("run", id); window.history.replaceState(null, "", url);
}
function forgetRun() {
  try { window.localStorage.removeItem(RUN_STORAGE_KEY); } catch { /* Optional storage. */ }
  const url = new URL(window.location.href); url.searchParams.delete("run"); window.history.replaceState(null, "", url);
}

/**
 * One-shot Autopilot: intake → director's room → ready-for-approval. A saved run is restored from
 * the same storage key and ?run= link as the step-by-step studio; manual runs open in the studio.
 */
export function AutopilotExperience({ onStudio }: { onStudio: () => void }) {
  const [run, setRun] = useState<RunView | null>(null);
  const [state, setState] = useState<AutopilotPublicState | null>(null);
  const [stateStatus, setStateStatus] = useState<StateStatus>("loading");
  const [restoring, setRestoring] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const headingRef = useRef<HTMLDivElement>(null);
  const onStudioRef = useRef(onStudio);
  useEffect(() => { onStudioRef.current = onStudio; }, [onStudio]);
  // Read the OAuth-return marker before any passive effect runs: the intake's own effect restores the
  // draft and strips ?business= from the URL, and child effects run before this component's effects.
  const oauthReturn = useRef(false);
  useLayoutEffect(() => { oauthReturn.current = new URLSearchParams(window.location.search).has("business"); }, []);

  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        if (oauthReturn.current) return; // OAuth return: the intake restores its draft; a stored run must not replace it.
        const params = new URLSearchParams(window.location.search);
        let stored: string | null = null;
        try { stored = window.localStorage.getItem(RUN_STORAGE_KEY); } catch { /* A shared URL works without storage. */ }
        const linked = params.get("run");
        const id = linked ?? stored;
        if (!id) return;
        if (!isUuid(id)) { if (linked) setNotice("This saved-run link is invalid. Start a new Autopilot run below."); return; }
        const { run: saved } = await getRun(id);
        if (stopped) return;
        if (saved.autopilot) { setRun(saved); rememberRun(saved.id); return; }
        // A manual run opened by link belongs to the step-by-step studio; a remembered one stays there.
        if (linked) onStudioRef.current();
      } catch (cause) {
        if (!stopped) setNotice(cause instanceof HttpError && cause.status === 404 ? "That saved run no longer exists. Start a new Autopilot run below." : "Your previous run couldn’t be restored right now. You can start a new one.");
      } finally { if (!stopped) setRestoring(false); }
    })();
    return () => { stopped = true; };
  }, []);

  const runId = run?.id;
  const runStatus = run?.status;
  // Same cadence as the studio: first check after 1.2 s, then every 2 s while the run is active.
  useEffect(() => {
    if (!runId || !["queued", "running"].includes(runStatus ?? "")) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const body = await getRun(runId!); if (!stopped) { setRun(body.run); setNotice(null); } }
      catch { if (!stopped) setNotice("Connection interrupted. Your run keeps going and is saved; checking again shortly."); }
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 1200);
    return () => { stopped = true; clearTimeout(timer); };
  }, [runId, runStatus]);

  // The director's-room view: poll ~2 s while active, then fetch once more for the final state.
  const active = isActiveRun(run);
  useEffect(() => {
    if (!runId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const body = await getAutopilotState(runId!);
        if (stopped) return;
        setState(body.state); setStateStatus("ready");
      } catch (cause) {
        if (stopped) return;
        if (cause instanceof HttpError && [404, 405, 501].includes(cause.status)) { setStateStatus("unavailable"); return; }
      }
      if (!stopped && active) timer = setTimeout(load, 2000);
    }
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [runId, active]);

  const started = useCallback((next: RunView) => {
    setState(null); setStateStatus("loading"); setNotice(null); setRun(next); rememberRun(next.id);
    window.scrollTo({ top: 0 }); window.setTimeout(() => headingRef.current?.focus(), 0);
  }, []);
  function startOver() {
    forgetRun(); setRun(null); setState(null); setStateStatus("loading"); setNotice(null);
    window.scrollTo({ top: 0 });
  }
  async function retry() {
    if (!run) return;
    setRetrying(true);
    try { const body = await retryRun(run.id); setRun(body.run); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : "The run could not be resumed."); }
    finally { setRetrying(false); }
  }
  // The digest is the one the owner confirmed in the approval block, never a value refreshed behind their back.
  async function approve(digest: string) {
    if (!run || !digest) throw new Error("This kit has no approvable digest. Reload and review it again.");
    if (run.approvalDigest !== digest) throw new Error("The campaign changed since you reviewed it. Review the current files and confirm again.");
    try { const body = await approveRun(run.id, digest); setRun(body.run); }
    catch (cause) {
      // A changed kit (409) must be re-reviewed: refresh so the owner sees the current files and digest.
      if (cause instanceof HttpError && cause.status === 409) { try { const body = await getRun(run.id); setRun(body.run); } catch { /* Keep the current view. */ } }
      throw cause;
    }
  }

  return <div className="ap-stage">
    {notice && <p className="ap-notice ap-notice-inline" role="status">{notice}</p>}
    {run && <div className="ap-run-bar"><button type="button" className="ap-text-button" onClick={startOver}><RotateCcw size={13} />Start a new run</button></div>}
    <div ref={headingRef} tabIndex={-1} className="ap-focus-anchor" aria-label={run ? "Autopilot run" : "Autopilot intake"} />
    {!run ? <AutopilotIntake restoring={restoring} onStarted={started} />
      : run.campaign && !active ? <AutopilotReady run={run} state={state} stateStatus={stateStatus} onApprove={approve} />
      : <DirectorsRoom run={run} state={state} stateStatus={stateStatus} onRetry={() => void retry()} retrying={retrying} onStudio={onStudio} />}
  </div>;
}
