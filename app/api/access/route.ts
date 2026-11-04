import {
  ACCESS_INVALID, ACCESS_NOT_CONFIGURED, ACCESS_THROTTLED, AttemptThrottle, accessCookieHeader, accessMode, clientKey,
  clientKeySource, issueAccessToken, requestIsHttps, sanitizeNextPath, verifyAccessCode,
} from "@/lib/access";
import { RequestError, assertSameOriginRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4096;
// 5 failures per client per 10 min; no global hard block (that would let anyone lock the owner
// out), only a 1 s slowdown per attempt once 100 failures arrived within 10 min.
const throttle = new AttemptThrottle({ perClient: 5, windowMs: 10 * 60 * 1000, globalSlowdownAfter: 100, globalDelayMs: 1000 });
let sourceLogged = false;

async function readBoundedText(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new RequestError("Request body is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Accepts the /access form (urlencoded, answered with 303 redirects) or JSON (answered with JSON). */
async function readSubmission(request: Request): Promise<{ form: boolean; code: unknown; next: unknown }> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (type.startsWith("application/x-www-form-urlencoded")) {
    const fields = new URLSearchParams(await readBoundedText(request));
    return { form: true, code: fields.get("code"), next: fields.get("next") };
  }
  if (type.startsWith("application/json")) {
    let body: unknown;
    try { body = JSON.parse(await readBoundedText(request)); } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError("Invalid JSON.", 400);
    }
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    return { form: false, code: record.code, next: record.next };
  }
  throw new RequestError("Send a form or application/json.", 415);
}

const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function seeOther(location: string, extra: Record<string, string> = {}) {
  return new Response(null, { status: 303, headers: { ...noStore, Location: location, ...extra } });
}

function backToForm(error: "invalid" | "throttled", next: string) {
  const params = new URLSearchParams({ error });
  if (next !== "/") params.set("next", next);
  return seeOther(`/access?${params.toString()}`);
}

/** Exchanges the owner access code for a signed, expiring HttpOnly session cookie. */
export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const mode = accessMode();
    if (mode.kind === "open") return Response.json({ error: "The access gate is not enabled." }, { status: 404, headers: noStore });
    if (mode.kind === "unconfigured") return Response.json({ error: ACCESS_NOT_CONFIGURED }, { status: 503, headers: noStore });

    const client = clientKey(request.headers);
    if (!sourceLogged) {
      // Deployment diagnostic (no addresses): shows whether the platform supplies a client hop.
      sourceLogged = true;
      console.log(`access: throttle client key from ${clientKeySource(request.headers)}.`);
    }
    const submission = await readSubmission(request);
    const next = sanitizeNextPath(submission.next);
    if (throttle.isBlocked(client)) {
      return submission.form ? backToForm("throttled", next) : Response.json({ error: ACCESS_THROTTLED }, { status: 429, headers: noStore });
    }
    const delay = throttle.delayMs();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (!verifyAccessCode(submission.code, mode)) {
      throttle.recordFailure(client);
      return submission.form ? backToForm("invalid", next) : Response.json({ error: ACCESS_INVALID }, { status: 401, headers: noStore });
    }
    throttle.recordSuccess(client);
    const cookie = accessCookieHeader(issueAccessToken(mode.signingKey), requestIsHttps(request.url, request.headers));
    return submission.form
      ? seeOther(next, { "Set-Cookie": cookie })
      : Response.json({ ok: true, next }, { headers: { ...noStore, "Set-Cookie": cookie } });
  } catch (error) {
    await request.body?.cancel().catch(() => undefined);
    if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
    return Response.json({ error: "Sign-in failed." }, { status: 500, headers: noStore });
  }
}
