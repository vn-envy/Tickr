import { z } from "zod";
import { jobs } from "@/lib/jobs/store";
import { jobError, requireId } from "@/lib/jobs/http";
import { readLocalJson } from "@/lib/http";

export const runtime = "nodejs";
const Input = z.object({ opportunityId: z.string().min(1).max(128) }).strict();
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    requireId(id);
    const input = Input.parse(await readLocalJson(request));
    return Response.json({ run: await jobs.enqueueCampaign(id, input.opportunityId) }, { status: 202 });
  } catch (error) { return jobError(error); }
}
