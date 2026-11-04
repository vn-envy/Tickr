import type { BranchIdentity, CollectedSource } from "./contracts";

/** Calendar validity is independent of whether a model supplied the string. */
export function validSourceDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

/** Check stored provenance metadata; a valid shape alone does not bind a date or branch to text. */
export function assertSourceContext(source: CollectedSource): void {
  const context = source.context;
  if (!context) return;
  for (const value of [context.publishedAt, context.validFrom, context.validThrough]) {
    if (value && !validSourceDate(value)) throw new Error("A source contains an invalid calendar date.");
  }
  if (context.validFrom && context.validThrough && context.validFrom > context.validThrough) throw new Error("A source has an inverted validity window.");
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  for (const anchor of [context.locationEvidence, context.dateEvidence]) {
    if (anchor && !normalize(source.text).includes(normalize(anchor))) throw new Error("Source context is not anchored in its retained text.");
  }
  if (context.scope === "exact_location" && (!context.location?.trim() || !context.locationEvidence?.trim())) throw new Error("An exact-location source needs an attributed location anchor.");
  if ([context.publishedAt, context.validFrom, context.validThrough].some(Boolean) && !context.dateEvidence?.trim()) throw new Error("Source dates require a retained date anchor.");
  if (context.temporalStatus === "current" && (!context.dateEvidence?.trim() || ![context.publishedAt, context.validFrom, context.validThrough].some(Boolean))) throw new Error("Current source status needs supported dates.");
}

/** Undated material can support a reported description, never confirmed current availability. */
export function isCurrentSource(source: CollectedSource, asOfDate = new Date().toISOString().slice(0, 10)): boolean {
  const context = source.context;
  if (!context) return true; // Legacy attribution remains usable with its existing review requirements.
  if (context.scope === "other_location" || context.temporalStatus === "historical") return false;
  const today = validSourceDate(asOfDate);
  if (!today) return false;
  const from = validSourceDate(context.validFrom), through = validSourceDate(context.validThrough);
  if (context.validFrom && !from || context.validThrough && !through) return false;
  if (from && from > today || through && through < today) return false;
  return true;
}

export function isCampaignBusinessSource(source: CollectedSource): boolean {
  return ["owner_statement", "official_website", "business_coverage"].includes(source.kind)
    && source.context?.scope !== "other_location";
}

/** A dated, branch-bound offer is stricter than a descriptive brand or product claim. */
export function isCurrentOfferSource(source: CollectedSource, asOfDate = new Date().toISOString().slice(0, 10)): boolean {
  const context = source.context;
  if (!context || !isCampaignBusinessSource(source) || !isCurrentSource(source, asOfDate)
    || source.acquisition === "meta_cited_summary"
    || context.scope !== "exact_location" || context.temporalStatus !== "current"
    || !context.dateEvidence?.trim() || !context.locationEvidence?.trim()) return false;
  const through = validSourceDate(context.validThrough);
  if (!through) return false;
  const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized(source.text).includes(normalized(context.dateEvidence))
    && normalized(source.text).includes(normalized(context.locationEvidence));
}

/** Re-evaluate location applicability on a derived ledger, preserving immutable stage artifacts. */
export function reconcileLocationScopes(sources: readonly CollectedSource[], branch: BranchIdentity | null | undefined): CollectedSource[] {
  const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const literal = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const includes = (text: string, value: string) => Boolean(value) && ` ${text} `.includes(` ${value} `);
  const anchors = branch?.status === "matched" ? [branch.locality, branch.address].filter((value): value is string => Boolean(value?.trim())).map(normalize) : [];
  return sources.map((original) => {
    const source = structuredClone(original);
    const context = source.context;
    // A competitor has a different shop address by definition; its local-market relevance is a separate question.
    if (!anchors.length || source.kind === "competitor" || !context?.location || !context.locationEvidence) return source;
    const location = normalize(context.location);
    const evidence = normalize(context.locationEvidence);
    if (!literal(source.text).includes(literal(context.locationEvidence)) || !includes(evidence, location)) return source;
    const sameOrMoreSpecific = anchors.some((anchor) => includes(location, anchor));
    const broader = anchors.some((anchor) => includes(anchor, location));
    if (!sameOrMoreSpecific && !broader) context.scope = "other_location";
    else if (!sameOrMoreSpecific && context.scope === "exact_location") context.scope = "unknown";
    // Never promote an unknown/brand/other-location claim into an exact-branch fact here.
    return source;
  });
}
