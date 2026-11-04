"use client";

import Image from "next/image";
import { ArrowUpRight, ChevronDown, FileText, Layers3, Palette, Search, Sparkles } from "lucide-react";
import type { CampaignKit, CollectedSource, RunView } from "@/lib/research/contracts";
import { InsightContextNotes, SourceContextDetails } from "./source-context";
import { VisualComposition } from "./visual-composition";

function sourceUrl(source: CollectedSource): string | null {
  const value = source.citation?.url ?? source.url;
  if (!value) return null;
  try { const parsed = new URL(value); return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null; }
  catch { return null; }
}

function sourceLabel(source: CollectedSource) {
  return source.acquisition === "meta_cited_summary" ? "Meta-cited summary" : source.acquisition === "meta_search_snippet" ? "Meta search snippet" : source.acquisition === "direct_website" ? "Website excerpt" : "Supplied material";
}

function visualWarningMessage(warning: string) {
  const message = warning.replace(/^candidate_[a-z0-9_-]+:\s*/i, "");
  const code = message.match(/^([A-Z][A-Z0-9_]+):\s*/)?.[1];
  if (code === "URL_NOT_ALLOWED") return "The linked social or listing page could not be read for source photography. Its cited text remains available as a research reference.";
  if (code === "ROBOTS_RESTRICTED") return "The website’s access rules prevented us from retrieving some original images.";
  if (code === "SOURCE_RESTRICTED") return "The source restricts automated image reuse, so those images were not used.";
  if (code === "CROSS_ORIGIN_MEDIA") return "An image’s connection to the official business website could not be established, so it was not used.";
  if (code === "READ_TIMEOUT") return "Some original images did not load in time.";
  if (code && ["DIRECT_CONNECTION_UNAVAILABLE", "CONNECTION_UNAVAILABLE", "PROXY_CONNECT_REJECTED", "TLS_UNVERIFIED"].includes(code)) return "A secure connection to some original images could not be established.";
  if (code && ["BODY_TOO_LARGE", "OUTPUT_TOO_LARGE", "IMAGE_DIMENSIONS_NOT_ALLOWED"].includes(code)) return "Some source images did not meet the size requirements for campaign previews.";
  if (code && ["IMAGE_DECODE_FAILED", "IMAGE_TYPE_MISMATCH", "IMAGE_TYPE_NOT_ALLOWED", "CONTENT_TYPE_NOT_ALLOWED", "ENCODING_NOT_SUPPORTED"].includes(code)) return "Some source files were not available in a usable image format.";
  if (code && ["REDIRECT_LIMIT", "HTTP_UNAVAILABLE", "MEDIA_UNAVAILABLE"].includes(code)) return "Some original images could not be retrieved from the website.";
  return message.replace(/^[A-Z][A-Z0-9_]+:\s*/, "");
}

// Presentation only: diagnostic details remain in the saved provenance and exports.
export function readableMediaWarnings(warnings: string[]) {
  return [...new Set(warnings.map(visualWarningMessage))];
}

export function SourceTrace({ ids, sources }: { ids: string[]; sources: CollectedSource[] }) {
  const requested = [...new Set(ids)];
  const matched = requested.flatMap((id) => { const source = sources.find((item) => item.id === id); return source ? [source] : []; });
  const urls = new Set(matched.flatMap((source) => { const url = sourceUrl(source); return url ? [url] : []; }));
  if (requested.length === 0) return <p className="trace-empty">No source references are attached. These details need independent confirmation.</p>;
  return <details className="insight-source-trace"><summary><span><FileText size={12} />{matched.length} source record{matched.length === 1 ? "" : "s"}{urls.size ? ` · ${urls.size} unique URL${urls.size === 1 ? "" : "s"}` : ""}</span><ChevronDown size={13} /></summary>{matched.map((source) => { const url = sourceUrl(source); return <article key={source.id}><div className="trace-source-heading"><strong>{source.title}</strong><span>{sourceLabel(source)}</span></div><SourceContextDetails source={source} /><p>{source.text}</p>{source.acquisition === "meta_cited_summary" && <small>This summary is not a verbatim page quotation. Check its cited source before using the claim.</small>}{url && <a href={url} target="_blank" rel="noopener noreferrer">{new URL(url).hostname}<ArrowUpRight size={12} /></a>}</article>; })}{matched.length < requested.length && <p className="trace-empty">{requested.length - matched.length} referenced source record{requested.length - matched.length === 1 ? " is" : "s are"} unavailable in this saved run.</p>}</details>;
}

function CampaignContext({ run, campaign }: { run: RunView; campaign: CampaignKit }) {
  const context = campaign.creativeBrief?.context;
  if (!context) return null;
  const seasonal = context.seasonalTheme;
  const matching = run.enrichment?.insights?.filter((insight) => context.insightIds.includes(insight.id)) ?? [];
  const unmatched = context.insightIds.filter((id) => !matching.some((insight) => insight.id === id)).length;
  const labels = { none: "No seasonal offer established", proposed_theme: "Proposed seasonal theme", verified_offer: "Source-supported seasonal offer" };
  return <div className="campaign-context">
    <h3>Why this campaign, now</h3><p>{context.whyNow}</p>
    <div className={`seasonal-context seasonal-${seasonal.status}`}><span className="insight-kind">{labels[seasonal.status]}</span>{seasonal.name && <h4>{seasonal.name}</h4>}<p>{seasonal.status === "proposed_theme" ? "This is a creative suggestion. It does not establish a current promotion, event, price or special availability." : seasonal.status === "verified_offer" ? "Retrieved sources support this offer. Check its dates, branch and availability before publication." : "The campaign does not claim a current seasonal promotion."}</p>{seasonal.sourceIds.length > 0 && <><InsightContextNotes sourceIds={seasonal.sourceIds} sources={run.sources} /><SourceTrace ids={seasonal.sourceIds} sources={run.sources} /></>}</div>
    {context.insightIds.length > 0 && <details className="campaign-context-research"><summary>Research behind this timing<ChevronDown size={14} /></summary>{matching.map((insight) => <article key={insight.id}><span className="insight-kind">{insight.kind}</span><p>{insight.claim}</p><InsightContextNotes sourceIds={insight.sourceIds} sources={run.sources} /><SourceTrace ids={insight.sourceIds} sources={run.sources} /></article>)}{unmatched > 0 && <p className="trace-empty">{unmatched} referenced research finding{unmatched === 1 ? " is" : "s are"} unavailable in this saved run.</p>}</details>}
  </div>;
}

export function BusinessEnrichmentPanel({ run }: { run: RunView }) {
  const enrichment = run.enrichment;
  if (!enrichment) return null;
  const status = enrichment.status === "enriched" ? "Research expanded" : enrichment.status === "limited" ? "Partial coverage" : "No usable findings";
  return <section className="panel enrichment-panel" aria-labelledby="enrichment-heading"><div className="discovery-heading"><span className="section-kicker"><Layers3 size={15} />PRODUCTS & BRAND STORY</span><span className="small-tag">{status}</span></div><h2 id="enrichment-heading">A closer look at what makes this business.</h2><p className="section-description">Reported offerings and brand signals, with their sources. The level of detail follows the evidence available.</p><div className="enrichment-counts"><span><strong>{enrichment.offerings.length}</strong> named offering{enrichment.offerings.length === 1 ? "" : "s"}</span><span><strong>{enrichment.brandSignals.length}</strong> brand signal{enrichment.brandSignals.length === 1 ? "" : "s"}</span></div><div className="enrichment-section"><h3>What the business offers</h3>{enrichment.offerings.length ? <div className="offering-grid">{enrichment.offerings.map((offering) => <article className="offering-card" key={offering.id}><span className="insight-kind">Reported offering</span><h4>{offering.name}</h4><p>{offering.description}</p><InsightContextNotes sourceIds={offering.sourceIds} sources={run.sources} /><SourceTrace ids={offering.sourceIds} sources={run.sources} /></article>)}</div> : <div className="catalog-empty"><Search size={20} /><div><strong>No specific products or services established.</strong><p>{enrichment.brandSignals.length ? "The collected sources did not support a named offering. This run can explore the supported brand story without inventing a menu, service, price or availability." : "The collected sources did not support a named offering. Specific products, services, prices and availability remain unknown."}</p></div></div>}</div><div className="enrichment-section"><h3>Signals behind the brand</h3>{enrichment.brandSignals.length ? <div className="brand-signal-list">{enrichment.brandSignals.map((signal) => <article key={signal.id}><span className="insight-kind">{signal.kind}</span><p>{signal.claim}</p><InsightContextNotes sourceIds={signal.sourceIds} sources={run.sources} /><SourceTrace ids={signal.sourceIds} sources={run.sources} /></article>)}</div> : <p className="catalog-empty-text">No attributable brand signals were established in this pass.</p>}</div>{(enrichment.unknowns.length > 0 || enrichment.warnings.length > 0) && <details className="enrichment-limits"><summary>Coverage limits & open questions<ChevronDown size={14} /></summary>{enrichment.unknowns.length > 0 && <div><h4>Still unknown</h4><ul>{enrichment.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}{enrichment.warnings.length > 0 && <div><h4>Research notes</h4><ul>{enrichment.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}</details>}<details className="discovery-provenance"><summary>Research trail<ChevronDown size={14} /></summary><p>{enrichment.completedToolCalls} completed search operations · {new Date(enrichment.enrichedAt).toLocaleString()}</p>{enrichment.queries.length > 0 && <ul>{enrichment.queries.map((query, index) => <li key={index}>{query}</li>)}</ul>}<SourceTrace ids={enrichment.sourceIds} sources={run.sources} /></details></section>;
}

export function CreativeBriefPanel({ run, campaign }: { run: RunView; campaign: CampaignKit }) {
  const brief = campaign.creativeBrief;
  if (!brief) return null;
  const opportunity = run.report?.opportunities.find((item) => item.id === campaign.opportunityId);
  const labels = { hook: "Hook", proof: "Proof", occasion: "Occasion", action: "Action" };
  return <section className="panel creative-brief-panel" aria-labelledby="creative-brief-heading"><div className="section-kicker"><Sparkles size={14} />THE IDEA BEHIND THE CREATIVE</div><h2 id="creative-brief-heading">A focus, a story, a visual direction.</h2><div className="creative-brief-grid"><article><span className="insight-kind">{brief.focus.offeringId ? "Featured offering" : "Brand story focus"}</span><h3>{brief.focus.name}</h3><p>{brief.focus.description}</p>{opportunity?.whyNow && <div className="focus-rationale"><strong>Why this direction</strong><p>{opportunity.whyNow}</p></div>}<InsightContextNotes sourceIds={brief.focus.sourceIds} sources={run.sources} /><SourceTrace ids={brief.focus.sourceIds} sources={run.sources} /></article><article><span className="insight-kind">Brand narrative</span><h3>The story we’re carrying forward</h3><p>{brief.brandStory.narrative || "No sourced brand-story narrative was established for this concept."}</p><InsightContextNotes sourceIds={brief.brandStory.sourceIds} sources={run.sources} /><SourceTrace ids={brief.brandStory.sourceIds} sources={run.sources} /></article></div><CampaignContext run={run} campaign={campaign} /><div className="visual-direction"><div><span className="insight-kind"><Palette size={12} />{brief.visualDirection.status === "source_informed" ? "Source-informed direction" : "Proposed visual direction"}</span><p>{brief.visualDirection.description}</p></div><div className="palette-swatches" aria-label="Proposed campaign palette">{brief.visualDirection.palette.map((color, index) => <span key={`${color}-${index}`}><i style={{ backgroundColor: color }} aria-hidden="true" /><code>{color.toUpperCase()}</code></span>)}</div></div><p className="muted-note">A campaign direction is a design proposal, not a verified brand guideline.</p><SourceTrace ids={brief.visualDirection.sourceIds} sources={run.sources} /><details className="storyboard-details"><summary>Four-scene Reel plan<ChevronDown size={15} /></summary><div className="storyboard-grid">{brief.scenes.map((scene, index) => <article key={`${scene.role}-${index}`}><span>{String(index + 1).padStart(2, "0")} · {labels[scene.role]}</span><h3>{scene.headline}</h3><p>{scene.body}</p></article>)}</div></details></section>;
}


export function VisualProvenancePanel({ run, campaign }: { run: RunView; campaign: CampaignKit }) {
  const visual = campaign.visual;
  if (!visual) return null;
  const asset = visual.filename ? campaign.assets.find((item) => item.filename === visual.filename && item.mediaType === "image") : null;
  const label = visual.kind === "source_photo" ? "Source photograph" : visual.kind === "meta_illustration" ? "Meta-generated illustration" : "Typography layout";
  const explanation = visual.kind === "source_photo" ? "Uses a sourced photograph. Its origin and permission to publish still need review." : visual.kind === "meta_illustration" ? "Illustrative creative, not a photograph of this business, its people or its products." : "Built from typography and graphic shapes. No product photograph is implied.";
  const warnings = readableMediaWarnings(visual.warnings);
  const urls = [...new Set(visual.sourceUrls)].flatMap((url) => { try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? [parsed.href] : []; } catch { return []; } });
  return <section className={`panel visual-provenance-panel ${asset ? "has-visual-thumbnail" : ""}`} aria-labelledby="visual-provenance-heading">{asset && <div className="visual-provenance-thumbnail"><Image unoptimized src={`/api/runs/${encodeURIComponent(run.id)}/files/${encodeURIComponent(asset.filename)}`} width={asset.width ?? 1024} height={asset.height ?? 1024} alt={`${label}: ${visual.description}`} /></div>}<div className="visual-provenance-content"><span className="section-kicker">IMAGE PROVENANCE</span><h2 id="visual-provenance-heading">{label}</h2><p>{visual.description}</p><p className="visual-origin-note">{explanation}</p>{visual.model && <span className="visual-model">Created with {visual.model}</span>}<VisualComposition run={run} campaign={campaign} />{visual.filename && !asset && <p className="muted-note">The visual file is not listed among this run’s downloadable assets.</p>}{visual.sourceIds.length > 0 && <SourceTrace ids={visual.sourceIds} sources={run.sources} />}{urls.length > 0 && <div className="visual-source-links">{urls.map((url) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">{new URL(url).hostname}<ArrowUpRight size={12} /></a>)}</div>}{warnings.length > 0 && <ul className="visual-warnings">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</div></section>;
}

export function campaignVisualNotice(campaign: CampaignKit): string {
  if (campaign.visual?.kind === "meta_illustration") return "Concept · owner review needed. Includes a Meta-generated illustration, not a verified business photograph.";
  if (campaign.visual?.kind === "source_photo" && campaign.visual.artDirection?.background === "meta_generated") return "Concept · owner review needed. Uses source photography with a Meta-generated backdrop; review provenance and permissions below.";
  if (campaign.visual?.kind === "source_photo") return "Concept · owner review needed. Source photography and permission details are recorded below.";
  return "Editorial concept · owner review needed. These layouts do not contain verified business photographs.";
}
