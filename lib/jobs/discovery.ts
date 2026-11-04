import { BusinessDiscoverySchema, BusinessEnrichmentSchema, CollectedSourceSchema, ModelUsageSchema, type BranchIdentity, type BusinessContext, type BusinessDiscovery, type BusinessEnrichment, type CollectedSource, type ModelUsage } from "../research/contracts";
import { assertSourceContext } from "../research/grounding";
import { MAX_RESEARCH_SOURCES } from "../research/limits";

export interface DiscoveryCheckpoint {
  discovery: BusinessDiscovery;
  resolvedBusiness: BusinessContext;
  sources: CollectedSource[];
  usage: ModelUsage;
}

export interface EnrichmentCheckpoint {
  enrichment: BusinessEnrichment;
  sources: CollectedSource[];
  usage: ModelUsage;
}

export function prepareEnrichmentCheckpoint(business: BusinessContext, priorSources: CollectedSource[], result: EnrichmentCheckpoint): EnrichmentCheckpoint {
  const enrichment = BusinessEnrichmentSchema.parse(result.enrichment);
  const sources = result.sources.map((source) => CollectedSourceSchema.parse(source));
  sources.forEach(assertSourceContext);
  if (enrichment.businessId !== business.id) throw new Error("Enrichment belongs to another business.");
  const byId = new Map(priorSources.map((source) => [source.id, source]));
  for (const source of sources) {
    if (!source.id || byId.has(source.id)) throw new Error("Enrichment must return unique new source records.");
    if (!["meta_search_snippet", "meta_cited_summary"].includes(source.acquisition)
      || !source.citation?.responseId.trim() || !source.citation.searchCallIds.length || source.citation.searchCallIds.some((id) => !id.trim()) || !source.url || source.url !== source.citation.url) {
      throw new Error("Enrichment requires attributable Meta retrieval records.");
    }
    byId.set(source.id, source);
  }
  if (enrichment.sourceIds.some((id) => !byId.has(id))) throw new Error("Enrichment references missing source records.");
  const businessKinds = new Set(["owner_statement", "official_website", "business_coverage"]);
  const referencedSources = (ids: string[]) => ids.map((id) => {
    const source = byId.get(id);
    if (!source || !enrichment.sourceIds.includes(id)) throw new Error("Enrichment references missing or undeclared source records.");
    return source;
  });
  for (const finding of [...enrichment.offerings, ...enrichment.brandSignals]) {
    for (const id of finding.sourceIds) {
      const source = byId.get(id);
      if (!source || !enrichment.sourceIds.includes(id) || !businessKinds.has(source.kind)) throw new Error("Business enrichment references missing or non-business evidence.");
    }
  }
  for (const insight of enrichment.insights ?? []) {
    const references = referencedSources(insight.sourceIds);
    if (insight.kind === "customer" && references.some((source) => source.kind !== "customer_review")
      || insight.kind === "competitor" && references.some((source) => source.kind !== "competitor")) {
      throw new Error("Enrichment insights cannot confuse customer, competitor and business evidence.");
    }
  }
  const coverageAreas = new Set<string>();
  for (const coverage of enrichment.coverage ?? []) {
    if (coverageAreas.has(coverage.area)) throw new Error("Enrichment coverage areas must be unique.");
    coverageAreas.add(coverage.area);
    const references = referencedSources(coverage.sourceIds);
    if (coverage.status === "found" && references.length === 0) throw new Error("Found coverage requires attributable evidence.");
    if (coverage.area === "customer" && references.some((source) => source.kind !== "customer_review")
      || coverage.area === "competitor" && references.some((source) => source.kind !== "competitor")
      || ["identity", "offerings", "brand"].includes(coverage.area) && references.some((source) => !businessKinds.has(source.kind))) {
      throw new Error("Enrichment coverage references evidence about the wrong subject.");
    }
  }
  if (enrichment.branch) {
    const references = referencedSources(enrichment.branch.sourceIds);
    if (references.some((source) => !businessKinds.has(source.kind))) throw new Error("A business branch cannot be established by competitor or customer evidence.");
    if (enrichment.branch.status === "matched" && (!references.length || references.some((source) => source.context?.scope !== "exact_location"))) {
      throw new Error("A matched business branch requires evidence about the exact location.");
    }
  }
  if ((enrichment.offerings.length || enrichment.brandSignals.length || enrichment.insights?.length || enrichment.branch?.status === "matched") && !enrichment.completedToolCalls) throw new Error("Enrichment findings require a completed retrieval.");
  return { enrichment, sources, usage: ModelUsageSchema.parse(result.usage) };
}

/** Derive the same immutable branch snapshot for analysis, campaign input and restored UI. */
export function resolveEnrichedBusiness(business: BusinessContext, checkpoint?: Pick<EnrichmentCheckpoint, "enrichment" | "sources">, priorSources: CollectedSource[] = []): BusinessContext {
  return resolveBranchBusiness(business, checkpoint?.enrichment.branch, [...priorSources, ...(checkpoint?.sources ?? [])]);
}

function resolveBranchBusiness(business: BusinessContext, branch: BranchIdentity | undefined, sources: CollectedSource[]): BusinessContext {
  if (!branch || branch.status !== "matched" || !branch.locality?.trim() || !branch.sourceIds.length) return business;
  const byId = new Map(sources.map((source) => [source.id, source]));
  const supported = branch.sourceIds.every((id) => {
    const source = byId.get(id);
    return source && ["owner_statement", "official_website", "business_coverage"].includes(source.kind)
      && source.context?.scope === "exact_location" && Boolean(source.context.locationEvidence?.trim())
      && source.text.normalize("NFKC").replace(/\s+/gu, " ").includes(source.context.locationEvidence!.normalize("NFKC").replace(/\s+/gu, " "));
  });
  return supported ? { ...business, locality: branch.locality.trim() } : business;
}

/** A search proposal cannot silently become the identity used for a campaign. */
export function prepareDiscoveryCheckpoint(business: BusinessContext, result: { discovery: BusinessDiscovery; sources: CollectedSource[]; usage: ModelUsage }): DiscoveryCheckpoint {
  let discovery = BusinessDiscoverySchema.parse(result.discovery);
  const sources = result.sources.map((source) => CollectedSourceSchema.parse(source));
  sources.forEach(assertSourceContext);
  const byId = new Map(sources.map((source) => [source.id, source]));
  if (byId.size !== sources.length) throw new Error("Discovery source IDs must be unique.");
  const attributableIdentity = discovery.completedToolCalls > 0 && discovery.sourceIds.length > 0 && discovery.sourceIds.every((id) => {
    const source = byId.get(id);
    return source && ["meta_search_snippet", "meta_cited_summary"].includes(source.acquisition)
      && source.citation?.responseId.trim() && source.citation.searchCallIds.length > 0 && source.citation.searchCallIds.every((id) => id.trim()) && source.url && source.url === source.citation.url;
  });
  if (discovery.status === "matched" && !attributableIdentity) {
    discovery = {
      ...discovery, status: "unresolved", name: null, locality: null, vertical: null, officialWebsite: null, instagramUrl: null,
      warnings: [...discovery.warnings, "The proposed identity lacked attributable retrieval references and was not applied to the business profile."],
    };
  }
  let resolvedBusiness = discovery.status === "matched" ? {
    ...business,
    name: discovery.name || business.name,
    locality: discovery.branch ? business.locality : discovery.locality || business.locality,
    vertical: discovery.vertical || business.vertical,
    website: discovery.officialWebsite || business.website,
  } : business;
  if (discovery.status === "matched" && discovery.branch) resolvedBusiness = resolveBranchBusiness(resolvedBusiness, discovery.branch, sources);
  return { discovery, resolvedBusiness, sources, usage: ModelUsageSchema.parse(result.usage) };
}

export function discoveryNeedsIdentityConfirmation(checkpoint: DiscoveryCheckpoint): boolean {
  // Identity ambiguity needs confirmation; an unknown descriptive category does not block research.
  return checkpoint.discovery.status !== "matched" || !checkpoint.resolvedBusiness.name;
}

/** Keep the ledger records needed to restore every grounded finding and branch identity. */
export function requiredResearchSourceIds(discovery?: BusinessDiscovery | null, enrichment?: BusinessEnrichment | null): string[] {
  return [...new Set([
    ...(discovery?.status === "matched" ? [...discovery.sourceIds, ...(discovery.branch?.sourceIds ?? [])] : []),
    ...(enrichment?.sourceIds ?? []), ...(enrichment?.branch?.sourceIds ?? []),
    ...(enrichment?.offerings.flatMap((finding) => finding.sourceIds) ?? []),
    ...(enrichment?.brandSignals.flatMap((finding) => finding.sourceIds) ?? []),
    ...(enrichment?.insights?.flatMap((finding) => finding.sourceIds) ?? []),
    ...(enrichment?.coverage?.flatMap((finding) => finding.sourceIds) ?? []),
  ])];
}

export function mergeResearchSources(discovered: CollectedSource[], supplied: CollectedSource[], requiredSourceIds: readonly string[] = []): { sources: CollectedSource[]; warnings: string[] } {
  const unique = new Map<string, CollectedSource>();
  for (const source of [...discovered, ...supplied]) {
    const previous = unique.get(source.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(source)) throw new Error("Source identities collided between collection stages.");
    unique.set(source.id, source);
  }
  const required = new Set(requiredSourceIds);
  if (required.size > MAX_RESEARCH_SOURCES) throw new Error(`Required evidence exceeds the ${MAX_RESEARCH_SOURCES}-source research limit; no analysis request was made.`);
  if ([...required].some((id) => !unique.has(id))) throw new Error("Required research evidence is missing from the collected source ledger.");
  const records = [...unique.values()];
  if (records.length <= MAX_RESEARCH_SOURCES) return { sources: records, warnings: [] };
  const requiredRecords = records.filter((source) => required.has(source.id));
  const optional = records.filter((source) => !required.has(source.id));
  const priority = (source: CollectedSource) => source.acquisition === "direct_website" ? 0 : source.acquisition === "owner_supplied" ? 1 : source.acquisition === "meta_search_snippet" ? 2 : 3;
  optional.sort((first, second) => priority(first) - priority(second));
  return {
    sources: [...requiredRecords, ...optional.slice(0, MAX_RESEARCH_SOURCES - requiredRecords.length)],
    warnings: [`Research is bounded to ${MAX_RESEARCH_SOURCES} source records; ${records.length - MAX_RESEARCH_SOURCES} optional records were excluded. Required evidence was retained, with remaining space prioritizing original website text.`],
  };
}
