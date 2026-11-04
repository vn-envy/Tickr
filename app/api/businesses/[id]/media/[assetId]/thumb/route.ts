import { businessMediaErrorResponse, businessThumbnail, requireAssetId, requireBusiness } from "@/lib/autopilot/business-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** JPEG preview (long side at most 480 px; videos use a poster frame) generated from hash-verified bytes. */
export async function GET(_request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  try {
    const { id, assetId } = await context.params;
    await requireBusiness(id);
    requireAssetId(assetId);
    const bytes = await businessThumbnail(id, assetId);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/jpeg", "Content-Length": String(bytes.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) { return businessMediaErrorResponse(error); }
}
