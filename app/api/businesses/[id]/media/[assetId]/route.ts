import { assertSameOriginWrite, businessMediaErrorResponse, removeBusinessUpload, requireAssetId, requireBusiness } from "@/lib/autopilot/business-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  try {
    assertSameOriginWrite(request);
    const { id, assetId } = await context.params;
    await requireBusiness(id);
    requireAssetId(assetId);
    await removeBusinessUpload(id, assetId);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return businessMediaErrorResponse(error); }
}
