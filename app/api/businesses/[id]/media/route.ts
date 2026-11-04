import {
  addBusinessUpload, assertSameOriginWrite, businessMediaErrorResponse, getMetaConnectionView, libraryStateMessage, listBusinessUploads,
  parseUploadRequest, requireBusiness, type MetaConnectionView, type OwnerMediaSummary,
} from "@/lib/autopilot/business-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// getMetaConnectionView returns not_configured before it can throw, so a failure means "configured, not usable".
const unavailableConnection: MetaConnectionView = { status: "disconnected", provider: "meta", accountName: null, instagramUsername: null, pageName: null, expiresAt: null, mediaCount: null };

/**
 * The business's owner uploads plus its token-free Meta connection status. The two are loaded
 * independently: an unreadable upload library still returns the connection status (with a fixed
 * `mediaError` message and no assets), and a failed connection read never hides the uploads.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireBusiness(id);
    const [assets, connection] = await Promise.allSettled([listBusinessUploads(id), getMetaConnectionView(id)]);
    if (assets.status === "rejected" && !libraryStateMessage(assets.reason)) throw assets.reason;
    const body: { assets: OwnerMediaSummary[]; connection: MetaConnectionView; mediaError?: string } = {
      assets: assets.status === "fulfilled" ? assets.value : [],
      connection: connection.status === "fulfilled" ? connection.value : unavailableConnection,
    };
    if (assets.status === "rejected") body.mediaError = libraryStateMessage(assets.reason) ?? undefined;
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return businessMediaErrorResponse(error); }
}

/**
 * Raw-body owner upload (no multipart): Content-Type is the file's MIME type and the consent
 * query parameters are required. The body is streamed to a private file under a hard limit and
 * validated by magic bytes before it enters the business media library.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginWrite(request);
    const { id } = await context.params;
    await requireBusiness(id);
    const upload = parseUploadRequest(request);
    const { asset, created } = await addBusinessUpload(id, request, upload);
    return Response.json({ asset }, { status: created ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    await request.body?.cancel().catch(() => undefined);
    return businessMediaErrorResponse(error);
  }
}
