import { ChevronDown, Compass, MapPin } from "lucide-react";
import type { RunView } from "@/lib/research/contracts";
import { SourceTrace } from "./business-insights";
import { InsightContextNotes } from "./source-context";

export function BranchIdentityPanel({ run }: { run: RunView }) {
  const branch = run.enrichment?.branch ?? run.discovery?.branch;
  if (!branch) return <p className="branch-legacy-note">This research does not include a separate exact-branch match.</p>;
  const labels = { matched: "Branch match reported", candidate: "Likely branch — needs confirmation", unresolved: "Exact branch unresolved" };
  return <div className={`branch-identity branch-${branch.status}`}>
    <div className="branch-heading"><h3><MapPin size={15} />The specific location</h3><span className="small-tag">{labels[branch.status]}</span></div>
    <dl><div><dt>Branch</dt><dd>{branch.label ?? "Not established"}</dd></div><div><dt>Locality</dt><dd>{branch.locality ?? "Not established"}</dd></div><div className="branch-address"><dt>Address</dt><dd>{branch.address ?? "No attributable street address established"}</dd></div></dl>
    <p>{branch.rationale}</p>
    {branch.status === "unresolved" && <p className="branch-caution">Brand-level or other-location findings cannot confirm this branch’s current details.</p>}
    {branch.status === "candidate" && <p className="branch-caution">This is a likely location, not a confirmed branch match. Check the address before using location-specific claims.</p>}
    <SourceTrace ids={branch.sourceIds} sources={run.sources} />
  </div>;
}

export function ResearchContextPanel({ run }: { run: RunView }) {
  const enrichment = run.enrichment;
  if (!enrichment || (!enrichment.coverage && !enrichment.insights && !enrichment.researchPlan)) return null;
  const areaLabels = { identity: "Business & branch", offerings: "Products & services", brand: "Brand story", customer: "Customer needs", competitor: "Competitor context", seasonal: "Seasonal & timely context", content: "Content & visibility" };
  const insightLabels = { customer: "Customer signal", competitor: "Competitor context", seasonal: "Seasonal & timely context", content: "Content & visibility", operations: "Business operations" };
  const statusLabels = { found: "Sources found", limited: "Limited evidence", not_found: "Not established" };
  return <section className="panel research-context-panel" aria-labelledby="research-context-heading">
    <div className="section-kicker"><Compass size={15} />THE WIDER RESEARCH</div><h2 id="research-context-heading">What the surrounding evidence supports.</h2><p className="section-description">Customer signals, alternatives and timely context from the sources reached in this run. Gaps remain visible; source coverage is not proof of market demand.</p>
    {enrichment.coverage && <div className="research-coverage-list">{enrichment.coverage.map((item, index) => <article key={`${item.area}-${index}`} className={`research-coverage-item coverage-${item.status}`}><div className="coverage-item-heading"><h3>{areaLabels[item.area]}</h3><span className="small-tag">{statusLabels[item.status]}</span></div><p>{item.summary}</p>{item.sourceIds.length > 0 ? <SourceTrace ids={item.sourceIds} sources={run.sources} /> : <p className="trace-empty">No attributable source records attached to this area.</p>}</article>)}</div>}
    {enrichment.insights && <div className="wider-insights"><h3>Findings to consider</h3>{enrichment.insights.length > 0 ? enrichment.insights.map((insight) => <article className="wider-insight-card" key={insight.id}><span className="insight-kind">{insightLabels[insight.kind]}</span><h4>{insight.claim}</h4><InsightContextNotes sourceIds={insight.sourceIds} sources={run.sources} /><div className="insight-implication"><span>Possible business implication</span><p>{insight.implication}</p></div><SourceTrace ids={insight.sourceIds} sources={run.sources} /></article>) : <p className="catalog-empty-text">No attributable customer, competitor or timely findings were established in this pass.</p>}</div>}
    {enrichment.researchPlan && enrichment.researchPlan.length > 0 && <details className="research-plan-details"><summary>Questions guiding this research<ChevronDown size={14} /></summary><ul>{enrichment.researchPlan.map((question, index) => <li key={index}>{question}</li>)}</ul><p>These are research questions, not a claim that every question was resolved.</p></details>}
  </section>;
}
