import {
  connectionProfile, deleteMetaAttestation, META_OAUTH_COOKIE, oauthNonceCookie, peekOAuthState, readCookie, requireBusiness, sameSecret, saveMetaAttestation,
} from "@/lib/autopilot/business-media";
import { exchangeCodeForToken, getMetaConnectorStatus, listOwnerMediaSources, type OwnerMediaSource } from "@/lib/meta/graph";
import { deleteOwnerToken, saveOwnerToken, verifyOAuthState } from "@/lib/meta/graph-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Facebook Login return. The signed state and the browser's nonce cookie must both match before
 * the code is exchanged server-side. The token is stored encrypted together with the owner's
 * attestation; the browser only ever sees `connected=meta` or `connected=error` (no details).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const redirectUri = (process.env.META_OAUTH_REDIRECT_URI ?? "").trim();
  const secure = redirectUri.startsWith("https:");
  const finish = (businessId: string | null, outcome: "meta" | "error") => new Response(null, {
    status: 302,
    headers: {
      Location: `/?${businessId ? `business=${encodeURIComponent(businessId)}&` : ""}connected=${outcome}`,
      "Set-Cookie": oauthNonceCookie(null, secure), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    },
  });
  let verifiedBusiness: string | null = null;
  try {
    if (getMetaConnectorStatus().status !== "ready") return finish(null, "error");
    const state = url.searchParams.get("state");
    const peeked = peekOAuthState(state);
    if (!peeked) return finish(null, "error");
    const verified = verifyOAuthState(state, peeked.businessId);
    if (!verified.valid || !sameSecret(readCookie(request, META_OAUTH_COOKIE), verified.nonce)) return finish(null, "error");
    verifiedBusiness = verified.businessId;
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.has("error")) return finish(verifiedBusiness, "error");
    await requireBusiness(verifiedBusiness);
    const token = await exchangeCodeForToken(code, redirectUri);
    let sources: OwnerMediaSource[] | null = null;
    try { sources = (await listOwnerMediaSources(token.accessToken)).sources; } catch { /* Names are optional display data. */ }
    await saveMetaAttestation({ businessId: verifiedBusiness, attestedAt: peeked.issuedAt.toISOString(), tokenLongLived: token.longLived, ...connectionProfile(sources) });
    try {
      const saved = await saveOwnerToken(verifiedBusiness, { accessToken: token.accessToken, expiresAt: token.expiresAt });
      if (saved.status !== "stored") throw new Error("not stored");
    } catch {
      await deleteOwnerToken(verifiedBusiness).catch(() => undefined);
      await deleteMetaAttestation(verifiedBusiness).catch(() => undefined);
      return finish(verifiedBusiness, "error");
    }
    return finish(verifiedBusiness, "meta");
  } catch { return finish(verifiedBusiness, "error"); }
}
