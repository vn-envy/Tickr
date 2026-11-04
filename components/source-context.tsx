import type { CollectedSource } from "@/lib/research/contracts";

const scopeLabels = { exact_location: "Exact location", brand: "Brand-wide source", other_location: "Other location", unknown: "Location scope unknown" };
const dateLabels = { current: "Current in research", historical: "Historical source", unknown: "Freshness unknown" };

function readableDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function SourceContextDetails({ source }: { source: CollectedSource }) {
  const context = source.context;
  return <div className="source-context">
    <div className="source-context-tags"><span className={context?.scope === "other_location" ? "context-caution" : ""}>{scopeLabels[context?.scope ?? "unknown"]}</span><span className={context?.temporalStatus === "historical" ? "context-caution" : ""}>{dateLabels[context?.temporalStatus ?? "unknown"]}</span></div>
    <p className="source-retrieved">Collected {readableDate(source.retrievedAt)} · collection date does not establish when the claim was valid.</p>
    {context && <details className="source-context-details"><summary>Dates & location context</summary><dl>
      <div><dt>Location described</dt><dd>{context.location ?? "Not established"}</dd></div>
      <div><dt>Published</dt><dd>{context.publishedAt ? readableDate(context.publishedAt) : "Date not established"}</dd></div>
      {(context.validFrom || context.validThrough) && <div><dt>Reported validity</dt><dd>{context.validFrom ? readableDate(context.validFrom) : "Start unknown"} — {context.validThrough ? readableDate(context.validThrough) : "End unknown"}</dd></div>}
    </dl>{context.locationEvidence && <p>{context.locationEvidence}</p>}{context.dateEvidence && <p>{context.dateEvidence}</p>}{context.scope === "other_location" && <p className="context-caveat">This source concerns another location. It does not establish this branch’s offerings or availability.</p>}{context.scope === "brand" && <p className="context-caveat">Brand-level information may not apply to the selected branch.</p>}{context.temporalStatus === "historical" && <p className="context-caveat">Historical context does not establish a current offer or event.</p>}</details>}
  </div>;
}

export function InsightContextNotes({ sourceIds, sources }: { sourceIds: string[]; sources: CollectedSource[] }) {
  const matching = sources.filter((source) => sourceIds.includes(source.id));
  const otherLocation = matching.some((source) => source.context?.scope === "other_location");
  const historical = matching.some((source) => source.context?.temporalStatus === "historical");
  const unknownFreshness = matching.some((source) => !source.context || source.context.temporalStatus === "unknown");
  if (!otherLocation && !historical && !unknownFreshness) return null;
  return <div className="insight-context-notes">{otherLocation && <span>Includes another location</span>}{historical && <span>Includes historical context</span>}{unknownFreshness && <span>Source freshness not fully established</span>}</div>;
}
