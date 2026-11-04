import { requireRun, runOutputDir } from "@/lib/autopilot/business-media";
import { readPublicState } from "@/lib/autopilot/public-state";
import { jobError } from "@/lib/jobs/http";
import { RequestError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The director's room: the validated public Autopilot state, or null before the engine wrote one. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireRun(id);
    const directory = await runOutputDir(id);
    let state = null;
    if (directory) {
      try { state = await readPublicState(directory); } catch { throw new RequestError("The Autopilot progress record failed validation.", 409); }
      if (state && state.runId !== id) throw new RequestError("The Autopilot progress record failed validation.", 409);
    }
    return Response.json({ state }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jobError(error); }
}
