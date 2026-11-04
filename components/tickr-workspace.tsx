"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronDown, ChevronRight, Compass, FileText, FlaskConical, Layers3, Lightbulb, LoaderCircle, MapPin, Palette, Plus, Rocket, Search, ShieldCheck, Sparkles, Store, Trash2, WandSparkles, type LucideIcon } from "lucide-react";
import type { RunView, SourceInput, ResearchMode } from "@/lib/research/contracts";
import { CampaignPanel, EmptyStage, ExportPanel, OpportunitiesPanel, ResearchPanel } from "./research-panels";
import { AutopilotExperience } from "./autopilot/autopilot-experience";
import { AutopilotShell } from "./autopilot/autopilot-shell";
import { VIEW_STORAGE_KEY } from "./autopilot/model";

type StageId = "discover" | "investigate" | "opportunities" | "studio" | "launch";
type Brief = { name: string; website: string; locality: string; vertical: string; goal: string };
const stages: { id: StageId; label: string; description: string; icon: LucideIcon }[] = [
  { id: "discover", label: "Discover", description: "Your business, in focus", icon: Compass },
  { id: "investigate", label: "Investigate", description: "Understand the evidence", icon: Search },
  { id: "opportunities", label: "Opportunities", description: "Find your next move", icon: Lightbulb },
  { id: "studio", label: "Creative studio", description: "Bring the campaign to life", icon: Palette },
  { id: "launch", label: "Launch kit", description: "A concept kit for your review", icon: Rocket },
];
const blankBrief: Brief = { name: "", website: "", locality: "", vertical: "", goal: "" };
const newSource = (): SourceInput => ({ kind: "owner_statement", title: "Owner story & business facts", url: null, text: "" });
const storageKey = "tickr.activeRun.v1";
const sourceLabels = { owner_statement: "Owner statement", customer_review: "Customer review excerpt", competitor: "Competitor information", official_website: "Official business website", business_coverage: "Business coverage / article" };

const syntheticSources: SourceInput[] = [
  { kind: "owner_statement", title: "Fictional owner interview — Alder & Crumb", url: null, text: "SYNTHETIC DEMO MATERIAL. Alder & Crumb is a fictional independent bakery in the fictional neighbourhood of Cedar Quarter. Founder Mara learned to bake rye bread with her grandfather and opened this bakery two years ago. The team makes seeded rye loaves and cardamom buns in the open kitchen each morning. Customers can ask the bakers about the day's batches at the counter. We want to tell the story behind our bread and invite people to ask about today's bake. No discount, delivery service or guaranteed stock is offered in this brief." },
  { kind: "customer_review", title: "Fictional customer feedback — demonstration sample", url: null, text: "SYNTHETIC DEMO MATERIAL. Three fictional comments collected for this software demonstration: 'I loved hearing why Mara uses rye, but I would never have known that story from the shop window.' 'The cardamom bun was lovely. I wish I could see what was baking before I walk over.' 'I stopped to watch the bakers shape the loaves. That felt personal.' These invented quotes do not represent measured demand or real customer reviews." },
  { kind: "competitor", title: "Fictional competitor page — Corner Oven", url: null, text: "SYNTHETIC DEMO MATERIAL. Corner Oven is a fictional bakery in Cedar Quarter. Its supplied page describes celebration cakes, sandwich lunches and large group orders. This single fictional page does not describe a founder story or an open kitchen. Other pages and competitors have not been inspected. Absence from this excerpt is not evidence that a competitor lacks a capability." },
];

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `The request could not be completed (${response.status}).`);
  if (!body) throw new Error("The server returned an unreadable response.");
  return body as T;
}
function postJson<T>(url: string, body: unknown) {
  return requestJson<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function rememberRun(id: string) {
  try { window.localStorage.setItem(storageKey, id); } catch { /* Browsing without storage is supported. */ }
  const url = new URL(window.location.href); url.searchParams.set("run", id); window.history.replaceState(null, "", url);
}
function clearRunLink() {
  const url = new URL(window.location.href); url.searchParams.delete("run"); window.history.replaceState(null, "", url);
}

/* The one-shot Autopilot is the default; the step-by-step studio stays one switch away. */
const viewEvent = "tickr:view";
function subscribeView(callback: () => void) {
  window.addEventListener(viewEvent, callback); window.addEventListener("storage", callback);
  return () => { window.removeEventListener(viewEvent, callback); window.removeEventListener("storage", callback); };
}
function readView() { try { return window.localStorage.getItem(VIEW_STORAGE_KEY); } catch { return null; } }
function chooseView(view: "autopilot" | "studio") {
  try { if (view === "studio") window.localStorage.setItem(VIEW_STORAGE_KEY, "studio"); else window.localStorage.removeItem(VIEW_STORAGE_KEY); } catch { /* Optional storage. */ }
  window.dispatchEvent(new Event(viewEvent)); window.scrollTo({ top: 0 });
}

export function TickrWorkspace() {
  const [sessionView, setSessionView] = useState<"autopilot" | "studio" | null>(null);
  const storedView = useSyncExternalStore(subscribeView, readView, () => null);
  const view = sessionView ?? (storedView === "studio" ? "studio" : "autopilot");
  function select(next: "autopilot" | "studio") { setSessionView(next); chooseView(next); }
  if (view === "studio") return <StepByStepStudio onAutopilot={() => { clearRunLink(); select("autopilot"); }} />;
  return <AutopilotShell onStudio={() => select("studio")}><AutopilotExperience onStudio={() => select("studio")} /></AutopilotShell>;
}

function StepByStepStudio({ onAutopilot }: { onAutopilot: () => void }) {
  const [activeStage, setActiveStage] = useState<StageId>("discover");
  const [brief, setBrief] = useState<Brief>(blankBrief);
  const [sources, setSources] = useState<SourceInput[]>([newSource()]);
  const [mode, setMode] = useState<ResearchMode>("live");
  const [busy, setBusy] = useState<"save" | "research" | "campaign" | "retry" | null>(null);
  const [savedDraft, setSavedDraft] = useState<{ id: string; fingerprint: string } | null>(null);
  const [run, setRun] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [restoredRun, setRestoredRun] = useState(false);
  const [saveNotice, setSaveNotice] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const active = stages.find((stage) => stage.id === activeStage)!;
  const stageNumber = stages.findIndex((stage) => stage.id === activeStage) + 1;
  const branch = run?.enrichment?.branch ?? run?.discovery?.branch;
  const processing = run !== null && ["queued", "running"].includes(run.status);
  const disabled = busy !== null || processing || restoring;

  useEffect(() => {
    let stopped = false;
    async function restore() {
      try {
        const params = new URLSearchParams(window.location.search);
        let localId: string | null = null;
        try { localId = window.localStorage.getItem(storageKey); } catch { /* A shared URL works without storage. */ }
        const id = params.has("run") ? params.get("run") : localId;
        if (!id && !params.has("run")) return;
        if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error("This saved-run link is invalid. Start a new business brief to continue.");
        const { run: saved } = await requestJson<{ run: RunView }>(`/api/runs/${encodeURIComponent(id)}`);
        if (stopped) return;
        setRun(saved); setMode(saved.mode); setRestoredRun(true); rememberRun(saved.id);
        const recovered: Brief = { name: saved.business.name, website: saved.business.website ?? "", locality: saved.business.locality, vertical: saved.discovery ? saved.discovery.vertical ?? "" : saved.business.name ? saved.business.vertical : "", goal: saved.business.goal };
        setBrief(recovered); setSavedDraft({ id: saved.businessId, fingerprint: JSON.stringify(recovered) });
        const supplied = saved.sources.filter((source) => source.acquisition === "owner_supplied").map(({ kind, title, url, text }) => ({ kind, title, url, text }));
        setSources(supplied.length ? supplied : [newSource()]);
        setActiveStage(saved.campaign ? "studio" : saved.stage === "creating" ? "studio" : saved.report ? "opportunities" : "investigate");
      } catch (cause) { if (!stopped) setPollError(`Previous run could not be restored. ${cause instanceof Error ? cause.message : "You can start a new investigation."}`); }
      finally { if (!stopped) setRestoring(false); }
    }
    void restore();
    return () => { stopped = true; };
  }, []);

  const runId = run?.id;
  const runStatus = run?.status;
  useEffect(() => {
    if (!runId || !["queued", "running"].includes(runStatus ?? "")) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const body = await requestJson<{ run: RunView }>(`/api/runs/${encodeURIComponent(runId!)}`);
        if (!stopped) {
          setRun(body.run); setPollError(null);
          if (body.run.discovery?.status === "matched" && !["queued", "running"].includes(body.run.status)) {
            const discovered: Brief = { name: body.run.business.name, website: body.run.business.website ?? "", locality: body.run.business.locality, vertical: body.run.business.vertical, goal: body.run.business.goal };
            setBrief(discovered); setSavedDraft({ id: body.run.businessId, fingerprint: JSON.stringify(discovered) });
          }
        }
      } catch { if (!stopped) setPollError("Connection interrupted. Your run remains saved; checking again shortly."); }
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 1200);
    return () => { stopped = true; clearTimeout(timer); };
  }, [runId, runStatus]);

  function updateBrief(patch: Partial<Brief>) { setBrief((previous) => ({ ...previous, ...patch })); setSaveNotice(false); }
  function updateSource(index: number, patch: Partial<SourceInput>) { setSources((previous) => previous.map((source, position) => position === index ? { ...source, ...patch } : source)); }
  function showError(cause: unknown) { setError(cause instanceof Error ? cause.message : "Something went wrong. Please try again."); window.setTimeout(() => errorRef.current?.focus(), 0); }
  function applyPreset(preset: "hero" | "synthetic" | "blank") {
    setError(null); setPollError(null); setSaveNotice(false); setSavedDraft(null); setRun(null); setRestoredRun(false); setActiveStage("discover"); clearRunLink();
    try { window.localStorage.removeItem(storageKey); } catch { /* Optional storage. */ }
    if (preset === "hero") {
      setMode("live"); setBrief({ ...blankBrief, name: "Grandma Daphne's Bakehouse", vertical: "bakery", website: "https://maps.app.goo.gl/nNy6iYx9r4GaU7YY8", goal: "Tell the bakery's story to establish a credible differentiation from other bakeries." }); setSources([newSource()]);
    } else if (preset === "synthetic") {
      setMode("synthetic"); setBrief({ ...blankBrief, name: "Alder & Crumb", vertical: "bakery", locality: "Cedar Quarter · fictional demo locality", goal: "Tell the founder and craft story to encourage people to ask about today's bake." }); setSources(syntheticSources.map((source) => ({ ...source })));
    } else { setMode("live"); setBrief(blankBrief); setSources([newSource()]); }
  }
  async function ensureDraft() {
    const fingerprint = JSON.stringify(brief);
    if (savedDraft?.fingerprint === fingerprint) return savedDraft.id;
    if (!brief.website.trim() && !brief.name.trim()) throw new Error("Paste a business website or listing to begin.");
    const payload = Object.fromEntries(Object.entries(brief).filter(([, value]) => value.trim()));
    const { business } = await postJson<{ business: { id: string } }>("/api/businesses", payload);
    setSavedDraft({ id: business.id, fingerprint });
    return business.id;
  }
  async function saveOnly() {
    if (disabled || !formRef.current?.reportValidity()) return;
    setBusy("save"); setError(null);
    try { await ensureDraft(); setSaveNotice(true); } catch (cause) { showError(cause); }
    finally { setBusy(null); }
  }
  async function investigate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled) return;
    setBusy("research"); setError(null); setPollError(null);
    try {
      const id = await ensureDraft();
      const supplied = sources.filter((source) => source.text.trim() || source.url?.trim()).map((source) => ({ ...source, title: source.title.trim(), text: source.text.trim(), url: source.url?.trim() || null }));
      const { run: started } = await postJson<{ run: RunView }>(`/api/businesses/${id}/runs`, { mode, sources: supplied, readWebsite: mode === "live" && Boolean(brief.website.trim()), discoverFromLink: mode === "live" && Boolean(brief.website.trim()), enrichFromLink: mode === "live" && Boolean(brief.website.trim()) });
      setRun(started); setRestoredRun(false); rememberRun(started.id); setActiveStage("investigate");
    } catch (cause) { showError(cause); }
    finally { setBusy(null); }
  }
  async function selectOpportunity(id: string) {
    if (!run || disabled) return;
    if (run.campaign?.opportunityId === id) { setActiveStage("studio"); return; }
    setBusy("campaign"); setError(null);
    try { const body = await postJson<{ run: RunView }>(`/api/runs/${run.id}/campaign`, { opportunityId: id }); setRun(body.run); setRestoredRun(false); setActiveStage("studio"); }
    catch (cause) { showError(cause); }
    finally { setBusy(null); }
  }
  async function retryRun() {
    if (!run || busy) return;
    setBusy("retry"); setError(null);
    try { const body = await postJson<{ run: RunView }>(`/api/runs/${run.id}/retry`, {}); setRun(body.run); }
    catch (cause) { showError(cause); }
    finally { setBusy(null); }
  }
  const completedStage = (id: StageId) => id === "discover" ? Boolean(savedDraft) : id === "investigate" || id === "opportunities" ? Boolean(run?.report) : Boolean(run?.campaign);

  return <div className="workspace">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar" aria-label="Workspace navigation"><Link href="/" className="brand" aria-label="Tickr home"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span>tickr<span className="brand-period">.</span></span></Link><div className="workspace-label"><Store size={15} /><span>Local growth studio</span></div><div className="sidebar-section-label">YOUR CAMPAIGN</div><nav className="stage-navigation" aria-label="Campaign stages">{stages.map((stage, index) => { const Icon = stage.icon; return <button key={stage.id} type="button" className={`stage-button ${activeStage === stage.id ? "is-active" : ""}`} aria-label={stage.label} aria-current={activeStage === stage.id ? "step" : undefined} onClick={() => setActiveStage(stage.id)}><Icon size={19} strokeWidth={1.7} /><span className="stage-button-label">{stage.label}</span><span className="stage-number" aria-hidden="true">{completedStage(stage.id) ? <Check size={13} /> : `0${index + 1}`}</span></button>; })}</nav><div className="sidebar-note"><div className="sidebar-note-icon"><Layers3 size={18} /></div><strong>Grounded in your business.</strong><p>Evidence first. A clear strategy. Creative with a reason to exist.</p></div><div className="sidebar-footer"><span className="status-dot" /><span>Powered by Meta AI</span><Sparkles size={14} /></div></aside>
    <div className="workspace-body"><header className="topbar"><div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><span>{active.label}</span></div><div className="ap-topbar-right"><button type="button" className="ap-studio-switch" onClick={onAutopilot}><WandSparkles size={13} />Back to Autopilot</button><span className="local-badge">{mode === "synthetic" ? <FlaskConical size={12} /> : <span className="status-dot" />}{mode === "synthetic" ? "Synthetic demo" : "Private workspace"}</span></div></header>
      <main id="main-content" className="main-content"><div className="page-heading"><div><div className="eyebrow"><span>0{stageNumber}</span>{active.label}</div><h1>{activeStage === "discover" ? "Small business. Big story." : activeStage === "investigate" ? "See what makes you different." : activeStage === "opportunities" ? "Your next good move." : activeStage === "studio" ? "A story, ready to take shape." : "Your campaign, together."}</h1><p>{activeStage === "discover" ? "Drop in a business link. We’ll find its story, its market and a reason to choose it." : active.description + "."}</p></div><span className="page-step">STEP {stageNumber} OF 5</span></div>
        {restoring && <p className="connection-notice" role="status"><LoaderCircle className="spin" size={15} />Checking your saved workspace…</p>}
        {restoredRun && run && <div className="saved-run-notice" role="status"><FileText size={15} /><div><strong>Saved run · {new Date(run.createdAt).toLocaleDateString()}</strong><p>{processing ? "Following an existing run and its saved progress." : "You’re viewing stored outputs. Opening this page did not request a new analysis."}</p></div></div>}
        {mode === "synthetic" && <div className="demo-banner"><FlaskConical size={18} /><div><strong>Fictional business. Real AI workflow.</strong><p>All demo business details and quotations are invented inputs. This run uses Meta to analyze them and produce a concept; it does not validate a real market gap.</p></div></div>}
        {pollError && <div className="connection-notice" role="status">{pollError}</div>}
        {error && <div className="form-error global-error" role="alert" tabIndex={-1} ref={errorRef}><strong>We couldn’t complete that step</strong><p>{error}</p></div>}
        {run?.error && <div className="form-error global-error" role="alert"><strong>This run needs attention</strong><p>{run.error}</p>{run.status === "failed" && <button className="button button-secondary" disabled={Boolean(busy)} onClick={retryRun}>{busy === "retry" ? "Checking…" : "Try resuming"}</button>}</div>}
        <div className={`content-grid ${activeStage === "studio" || activeStage === "launch" ? "wide-stage" : ""}`}><div className="primary-column">
          <div hidden={activeStage !== "discover"}>
            <div className="preset-bar"><span>Try a business</span><button type="button" disabled={disabled} onClick={() => applyPreset("hero")}>Grandma Daphne’s<ArrowUpRight size={13} /></button><button type="button" disabled={disabled} onClick={() => applyPreset("synthetic")}><FlaskConical size={13} />Try the fictional demo</button><button type="button" disabled={disabled} onClick={() => applyPreset("blank")}>New business</button></div>
            <form className="business-form panel link-first-form" ref={formRef} onSubmit={investigate}>
              <div className="panel-heading"><span className="section-icon"><Search size={20} /></span><div><h2>Start with a link.</h2><p>The research is our job. You bring the business.</p></div></div>
              <div className="form-body link-first-body">
                <div className="field business-link-field"><label htmlFor="business-website">Business website or listing</label><div className="business-link-input"><Search size={20} /><input id="business-website" type="url" maxLength={2048} autoComplete="url" value={brief.website} onChange={(event) => updateBrief({ website: event.target.value })} disabled={disabled} placeholder="Paste a website, Google Maps or Instagram link" aria-describedby="business-link-help" /></div><p className="field-help" id="business-link-help">Tickr will look up the business, locate public sources and investigate its strengths and local context.</p></div>
                <div className="field goal-field"><label htmlFor="business-goal">Anything you’d like to focus on? <span className="optional-label">Optional</span></label><textarea id="business-goal" maxLength={2000} rows={2} value={brief.goal} onChange={(event) => updateBrief({ goal: event.target.value })} disabled={disabled} placeholder="Find the strongest story to tell about this business." /><p className="field-help">Leave this blank and Tickr will look for the most promising business story.</p></div>
                <div className="link-discovery-steps" aria-label="What happens next"><span><Search size={14} />Find the business</span><ChevronRight size={12} /><span><Layers3 size={14} />Connect the evidence</span><ChevronRight size={12} /><span><Lightbulb size={14} />Find the opportunity</span></div>
              </div>
              <details className="optional-intake" key={mode} open={mode === "synthetic" ? true : undefined}><summary><div><Plus size={16} /><span>Add information <small>(optional)</small></span></div><ChevronDown size={16} /></summary><p className="section-description">Already know something useful? Add it here to guide the research. You can start with just the link.</p>
                <div className="optional-business-fields"><div className="field-row"><div className="field"><label htmlFor="business-name">Business name</label><input id="business-name" maxLength={120} autoComplete="organization" value={brief.name} onChange={(event) => updateBrief({ name: event.target.value })} disabled={disabled} placeholder="We’ll try to find this" /></div><div className="field"><label htmlFor="business-locality">Neighbourhood & city</label><div className="input-with-icon"><MapPin size={16} /><input id="business-locality" maxLength={160} autoComplete="address-level2" value={brief.locality} onChange={(event) => updateBrief({ locality: event.target.value })} disabled={disabled} placeholder="We’ll try to find this" /></div></div></div>
                  <div className="field category-text-field"><label htmlFor="business-category">Business category <span className="optional-label">Optional</span></label><input id="business-category" maxLength={100} value={brief.vertical} onChange={(event) => updateBrief({ vertical: event.target.value })} disabled={disabled} placeholder="e.g. neighbourhood restaurant, florist, repair shop" aria-describedby="business-category-help" /><p className="field-help" id="business-category-help">Any business category is welcome. Leave this blank to research it from the link.</p></div>
                </div>
                <div className="source-intake"><div className="section-heading"><div><span className="section-kicker">EXTRA CONTEXT</span><h2>Anything the internet won’t know?</h2></div><span className="small-tag">{sources.length} / 8 sources</span></div><p className="section-description">Owner notes, a review excerpt or a useful competitor link can strengthen the investigation. None is required to start.</p>{sources.map((source, index) => <fieldset className="source-input-card" key={index} disabled={disabled}><legend>Source {index + 1}</legend><div className="source-input-heading"><div className="field"><label htmlFor={`source-kind-${index}`}>Source type</label><select id={`source-kind-${index}`} value={source.kind} onChange={(event) => updateSource(index, { kind: event.target.value as SourceInput["kind"] })}>{Object.entries(sourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><button type="button" className="icon-button" aria-label={`Remove source ${index + 1}`} onClick={() => setSources((items) => items.filter((_, position) => position !== index))}><Trash2 size={16} /></button></div><div className="field"><label htmlFor={`source-title-${index}`}>Source name</label><input id={`source-title-${index}`} maxLength={160} value={source.title} onChange={(event) => updateSource(index, { title: event.target.value })} placeholder="e.g. Owner interview, 1 November" /></div><div className="field"><label htmlFor={`source-text-${index}`}>Notes or exact excerpt</label><textarea id={`source-text-${index}`} maxLength={12000} rows={source.text.length > 300 ? 5 : 3} value={source.text} onChange={(event) => updateSource(index, { text: event.target.value })} placeholder={source.kind === "owner_statement" ? "A founder story, current offerings or details the owner can stand behind." : "Paste the useful text and identify where it came from."} /></div><div className="field source-url-field"><label htmlFor={`source-url-${index}`}>Source URL <span className="optional-label">Optional</span></label><input id={`source-url-${index}`} type="url" maxLength={2048} value={source.url ?? ""} onChange={(event) => updateSource(index, { url: event.target.value || null })} placeholder="https://…" /></div></fieldset>)}<button type="button" className="button button-secondary add-source" disabled={disabled || sources.length >= 8} onClick={() => setSources((items) => [...items, { ...newSource(), title: "" }])}><Plus size={15} />Add a source</button></div>
              </details>
              <div className="form-footer"><div className="form-actions"><button className="button button-primary" type="submit" disabled={disabled}>{busy === "research" ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{busy === "research" ? "Starting investigation…" : "Investigate this business"}<ArrowRight size={16} /></button><button className="button button-secondary" type="button" disabled={disabled} onClick={saveOnly}>{busy === "save" ? <LoaderCircle size={16} className="spin" /> : <FileText size={16} />}Save for later</button></div><p>{processing ? "Your investigation is processing. We’ll show the sources and any questions that remain." : "We’ll start with public research and ask for your help only where useful details remain unclear."}</p>{saveNotice && <div className="save-result" role="status"><CheckCircle2 size={18} /><div><strong>Business link saved.</strong><p>Your inputs are stored. The investigation starts when you choose to run it.</p></div></div>}</div>
            </form><p className="bottom-note"><ShieldCheck size={14} />Your story stays a draft until you decide it is ready to share.</p>
          </div>
          {activeStage === "investigate" && (run ? <ResearchPanel run={run} onOpportunities={() => setActiveStage("opportunities")} /> : <EmptyStage title="Good campaigns start with good questions." description="Paste a business link. Tickr will investigate its public story and keep findings connected to their sources." action="Start with your business" onAction={() => setActiveStage("discover")} />)}
          {activeStage === "opportunities" && (run ? <OpportunitiesPanel run={run} selecting={disabled} onSelect={selectOpportunity} onEvidence={() => setActiveStage("investigate")} /> : <EmptyStage title="Find a reason to choose you." description="Supported campaign directions will appear here after your first investigation." action="Start an investigation" onAction={() => setActiveStage("discover")} />)}
          {activeStage === "studio" && (run && (run.campaign || run.stage === "creating" || (processing && run.report)) ? <CampaignPanel run={run} onExport={() => setActiveStage("launch")} /> : <EmptyStage title="One idea. A campaign that feels like you." description="Choose a supported direction in Opportunities to create native channel copy, editorial visuals and a Reel concept." action="Choose a direction" onAction={() => setActiveStage("opportunities")} />)}
          {activeStage === "launch" && (run ? <ExportPanel run={run} onStudio={() => setActiveStage("studio")} /> : <EmptyStage title="Every piece, in one place." description="Your downloadable concept kit will arrive here once you have chosen and created a campaign direction." action="Start with your business" onAction={() => setActiveStage("discover")} />)}
        </div><aside className="context-column" aria-label="Campaign context"><div className="readiness-panel"><div className="aside-heading"><span className="small-orange-line" /><h2>{run ? "Your campaign brief" : "A campaign with a reason"}</h2></div>{run ? <><h3 className="aside-business-name">{run.discovery?.name ?? (run.business.name || (processing ? "Identifying your business" : "Business identity unresolved"))}</h3><p className="aside-intro">{run.discovery?.locality ?? (run.business.locality || (processing ? "Location being researched" : "Location not established"))}</p><p className="aside-category">{run.discovery ? run.discovery.vertical ?? "Category not established" : run.business.vertical || "Category not established"}</p>{branch?.status === "candidate" && <span className="small-tag">Likely branch · needs confirmation</span>}{branch?.status === "unresolved" && <span className="small-tag">Exact branch unresolved</span>}{run.discovery?.status === "ambiguous" && <span className="small-tag">Possible match · needs review</span>}<div className="aside-goal"><span>THE GOAL</span><p>{run.business.goal}</p></div><div className="aside-run-status"><span className={`status-dot ${processing ? "processing" : ""}`} />{run.stage === "enriching" ? "Researching the business & local context" : run.stage.replaceAll("_", " ")}</div></> : <p className="aside-intro">You shouldn’t need an agency brief to tell people why your business matters.</p>}<ul className="readiness-list">{[{ title: "Start with what’s true", text: "Find public business details and the sources behind them.", done: Boolean(run?.sources.length) }, { title: "Choose a meaningful direction", text: "Understand the evidence and what still needs checking.", done: Boolean(run?.report) }, { title: "Give the story a visual life", text: "Coordinated channel concepts you can inspect and download.", done: Boolean(run?.campaign) }].map((item) => <li key={item.title}><span className={`readiness-icon ${item.done ? "ready" : "pending"}`}>{item.done ? <Check size={12} /> : <span className="outline-dot" />}</span><div><strong>{item.title}</strong><span>{item.text}</span></div></li>)}</ul></div><div className="approach-panel"><span className="approach-icon"><Layers3 size={25} strokeWidth={1.4} /></span><h2>Your next campaign<br /> starts with a better question.</h2><p>What can your business promise that the right customer actually values?</p><div className="approach-footer"><span>Evidence → opportunity → creative</span><ArrowUpRight size={14} /></div></div>{run?.usage && run.usage.length > 0 && <details className="usage-details"><summary>Run details</summary>{run.usage.map((usage, index) => <p key={index}>{usage.model}<br />{(usage.elapsedMs / 1000).toFixed(1)} seconds · {usage.inputTokens !== null && usage.outputTokens !== null ? `${usage.inputTokens + usage.outputTokens} tokens` : "usage unavailable"}{typeof usage.imagesProcessed === "number" ? ` · ${usage.imagesProcessed} image${usage.imagesProcessed === 1 ? "" : "s"} processed` : ""}</p>)}</details>}</aside></div><footer className="main-footer"><span>Made for the businesses behind the neighbourhood.</span><span>Tickr · Meta AI</span></footer>
      </main></div>
  </div>;
}
