import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({
      status: "ok", mode: "research_and_campaign_concepts", database: "ready",
      capabilities: { businessDrafts: true, linkDiscovery: true, researchPipeline: true, campaignGeneration: true, publishing: false, originalBusinessPhotography: false },
      meta: {
        credentialPresent: Boolean(process.env.META_API_KEY),
        reasoningModelConfigured: true,
        reasoningModel: process.env.META_REASONING_MODEL || "muse-spark-1.3",
        verification: "per_run_results_and_usage",
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "error", database: "unavailable" }, { status: 503 });
  }
}
