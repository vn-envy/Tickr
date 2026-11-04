import { randomUUID } from "node:crypto";
import { ResearchInputSchema, type BusinessContext, type CollectedSource, type ResearchInput } from "./contracts";
import { readOfficialPage, SourceReadError, validateSourceUrl } from "./source-reader";

/** A reference URL is attribution, never permission to fetch its destination. */
function citationUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}

export async function collectSources(
  business: BusinessContext,
  input: ResearchInput,
  dependencies: { readPage?: typeof readOfficialPage } = {},
): Promise<{ sources: CollectedSource[]; warnings: string[] }> {
  const parsed = ResearchInputSchema.parse(input);
  const sources: CollectedSource[] = [];
  const warnings: string[] = [];
  const readPage = dependencies.readPage ?? readOfficialPage;
  const queued = new Map<string, { kind: "official_website" | "competitor"; title: string }>();

  const queuePage = (url: string, kind: "official_website" | "competitor", title: string) => {
    if (parsed.mode === "synthetic") {
      warnings.push(`${title}: website reading is disabled for synthetic fixtures. Supply labeled fixture text.`);
      return;
    }
    try {
      const canonical = validateSourceUrl(url).href;
      if (!queued.has(canonical)) queued.set(canonical, { kind, title });
    } catch (error) {
      warnings.push(`${title}: ${error instanceof SourceReadError ? error.message : "This source cannot be read directly."}`);
    }
  };

  for (const source of parsed.sources) {
    if (source.text.length >= 10) {
      const url = citationUrl(source.url);
      if (source.url && !url) warnings.push(`${source.title}: the supplied citation URL was invalid and was omitted; the text remains owner-supplied.`);
      sources.push({
        id: randomUUID(), kind: source.kind, title: source.title, url, text: source.text,
        retrievedAt: new Date().toISOString(), acquisition: "owner_supplied",
      });
    } else if (source.url && (source.kind === "official_website" || source.kind === "competitor")) {
      queuePage(source.url, source.kind, source.title);
    }
  }
  if (parsed.readWebsite && business.website) queuePage(business.website, "official_website", `${business.name} website`);
  else if (parsed.readWebsite && !business.website) warnings.push("No official business website was supplied. Research uses the provided text only.");

  const pages = [...queued.entries()];
  if (pages.length > 4) warnings.push("The four-page reading limit was reached. Additional pages were not read.");
  for (const [url, source] of pages.slice(0, 4)) {
    try {
      const page = await readPage(url);
      sources.push({
        id: randomUUID(), kind: source.kind, title: source.title || page.title, url: page.url,
        text: page.text, retrievedAt: page.retrievedAt, acquisition: "direct_website",
      });
    } catch (error) {
      warnings.push(`${source.title}: ${error instanceof SourceReadError ? error.message : "The public page could not be read safely. Provide attributable text instead."}`);
    }
  }
  if (!sources.length && !(parsed.mode === "live" && business.website && parsed.discoverFromLink !== false)) warnings.push("No readable evidence was collected. Business identity and a campaign goal do not establish product, customer or competitor facts.");
  warnings.push("Direct reading covers only supplied excerpts and successfully read pages. Meta discovery, when enabled, has its own recorded sources and coverage limits.");
  return { sources, warnings };
}
