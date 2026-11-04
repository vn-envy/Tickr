import { requireRun, runOutputDir, servableBytesResponse } from "@/lib/autopilot/business-media";
import { readPublicFile } from "@/lib/autopilot/public-state";
import { jobError } from "@/lib/jobs/http";
import { RequestError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One derived preview listed in the public state, served only after its size and SHA-256 match. */
export async function GET(request: Request, context: { params: Promise<{ id: string; name: string }> }) {
  try {
    const { id, name } = await context.params;
    await requireRun(id);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(name) || name.includes("..")) throw new RequestError("Preview not found.", 404);
    const directory = await runOutputDir(id);
    const file = directory ? await readPublicFile(directory, name).catch(() => null) : null;
    if (!file) throw new RequestError("Preview not found.", 404);
    return servableBytesResponse(request, file.bytes, file.mediaType, name);
  } catch (error) { return jobError(error); }
}
