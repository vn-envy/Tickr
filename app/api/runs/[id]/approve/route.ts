import { z } from "zod";
import { jobs } from "@/lib/jobs/store";
import { jobError, requireId } from "@/lib/jobs/http";
import { readLocalJson } from "@/lib/http";

export const runtime = "nodejs";
const Input = z.object({ manifestDigest: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict();

/** The owner's single final approval. It re-hashes every file and never publishes anything. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    requireId(id);
    const input = Input.parse(await readLocalJson(request));
    return Response.json({ run: await jobs.approveCampaign(id, input.manifestDigest) }, { status: 200 });
  } catch (error) { return jobError(error); }
}
