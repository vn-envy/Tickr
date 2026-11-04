import { jobs } from "@/lib/jobs/store";
import { jobError, requireId } from "@/lib/jobs/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    requireId(id);
    return Response.json({ run: await jobs.view(id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jobError(error); }
}
