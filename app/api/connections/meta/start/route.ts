import { businessMediaErrorResponse, oauthNonceCookie, requireBusiness } from "@/lib/autopilot/business-media";
import { RequestError } from "@/lib/http";
import { buildMetaLoginUrl, getMetaConnectorStatus, META_LOGIN_DIALOG_ORIGIN } from "@/lib/meta/graph";
import { createOAuthState } from "@/lib/meta/graph-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ATTESTATION_REQUIRED = "Before connecting, confirm that you own or license the media on these accounts and that people shown have agreed to appear in your business's marketing.";

/**
 * Starts Facebook Login for one business. Requires the owner's attestation (attest=1), mints a
 * signed, expiring state bound to the business id, binds its nonce to this browser in an HttpOnly
 * cookie and redirects only to the Meta login dialog URL built by lib/meta/graph.ts.
 */
export async function GET(request: Request) {
  try {
    const site = request.headers.get("sec-fetch-site");
    const origin = request.headers.get("origin");
    const url = new URL(request.url);
    if ((site && site !== "same-origin" && site !== "none") || (origin && origin !== url.origin)) throw new RequestError("Start the connection from the Tickr page.", 403);
    const businessId = url.searchParams.get("businessId") ?? "";
    await requireBusiness(businessId);
    if (url.searchParams.get("attest") !== "1") throw new RequestError(ATTESTATION_REQUIRED, 409);
    const connector = getMetaConnectorStatus();
    if (connector.status !== "ready") {
      const names = [...connector.missing, ...connector.invalid];
      throw new RequestError(`Instagram/Facebook connection is not set up on this server yet (missing or invalid: ${names.join(", ")}). Add these server settings and restart Tickr, or continue with your link and uploaded media.`, 409);
    }
    const redirectUri = (process.env.META_OAUTH_REDIRECT_URI ?? "").trim();
    const callbackOrigin = new URL(redirectUri).origin;
    if (callbackOrigin !== url.origin) throw new RequestError(`Open Tickr at ${callbackOrigin} to connect accounts: Meta returns to that address after login.`, 409);
    const { state, nonce } = createOAuthState(businessId);
    const location = buildMetaLoginUrl({ state, redirectUri });
    if (new URL(location).origin !== META_LOGIN_DIALOG_ORIGIN) throw new RequestError("The Meta login address could not be prepared.", 500);
    return new Response(null, {
      status: 302,
      headers: {
        Location: location, "Set-Cookie": oauthNonceCookie(nonce, new URL(redirectUri).protocol === "https:"),
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) { return businessMediaErrorResponse(error); }
}
