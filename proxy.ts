import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_NOT_CONFIGURED, ACCESS_REQUIRED, accessCookieName, decideAccess, requestIsHttps } from "@/lib/access";

/**
 * Owner access gate (Next.js 16 Proxy, Node.js runtime). It is a no-op unless TICKR_ACCESS_CODE
 * or TICKR_DEPLOYMENT is set; see lib/access.ts.
 *
 * Next buffers the body of every non-GET request this proxy matches (up to
 * experimental.proxyClientMaxBodySize, and until the whole body has arrived, even when the proxy
 * refuses it). The raw owner-upload route (POST /api/businesses/:id/media, up to 300 MiB) is
 * therefore excluded from the matcher and gates itself with accessDenial() before reading any
 * body bytes, so uploads stream straight to the route and unauthenticated uploads cannot pin
 * memory here. tests/unit/access-gate.test.ts checks the matcher.
 */

export function proxy(request: NextRequest) {
  const secure = requestIsHttps(request.url, request.headers);
  const decision = decideAccess({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    method: request.method,
    cookie: request.cookies.get(accessCookieName(secure))?.value ?? null,
  });
  const noStore = { "Cache-Control": "no-store" };
  switch (decision.kind) {
    case "allow":
      return NextResponse.next();
    case "unconfigured":
      return request.nextUrl.pathname.startsWith("/api/")
        ? NextResponse.json({ error: ACCESS_NOT_CONFIGURED }, { status: 503, headers: noStore })
        : new NextResponse(ACCESS_NOT_CONFIGURED, { status: 503, headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
    case "unauthorized":
      return NextResponse.json({ error: ACCESS_REQUIRED }, { status: 401, headers: noStore });
    case "redirect": {
      // Built on request.url so Next relativizes the Location header: the browser then resolves it
      // against the public host it used, not the 0.0.0.0 bind address Next sees.
      const response = NextResponse.redirect(new URL(decision.location, request.url), 307);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
  }
}

// Next requires a statically analysable literal here. The upload exclusion must stay in step with
// the accessDenial() call in app/api/businesses/[id]/media/route.ts.
export const config = {
  matcher: ["/((?!_next/static/|favicon\\.ico$|api/businesses/[^/]+/media$).*)"],
};
