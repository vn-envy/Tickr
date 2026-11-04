import { assertSameOriginWrite, businessMediaErrorResponse, deleteMetaConnection, requireBusiness } from "@/lib/autopilot/business-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Disconnects the owner's Meta account: best-effort Graph-side revoke, then the encrypted token and attestation are deleted. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginWrite(request);
    const { id } = await context.params;
    await requireBusiness(id);
    await deleteMetaConnection(id);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return businessMediaErrorResponse(error); }
}
