import { jobs } from "@/lib/jobs/store";
import { jobError, requireId } from "@/lib/jobs/http";
import { readLocalJson } from "@/lib/http";
import { ResearchInputSchema } from "@/lib/research/contracts";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    requireId(id);
    const input = ResearchInputSchema.parse(await readLocalJson(request, 131_072));
    return Response.json({ run: await jobs.enqueueResearch(id, input) }, { status: 202 });
  } catch (error) { return jobError(error); }
}
