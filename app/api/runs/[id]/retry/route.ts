import { z } from "zod";
import { jobs } from "@/lib/jobs/store";
import { jobError, requireId } from "@/lib/jobs/http";
import { readLocalJson } from "@/lib/http";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    requireId(id);
    z.object({}).strict().parse(await readLocalJson(request));
    return Response.json({ run: await jobs.retry(id) }, { status: 202 });
  } catch (error) { return jobError(error); }
}
