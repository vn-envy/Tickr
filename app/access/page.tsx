import type { Metadata } from "next";
import Link from "next/link";
import { ACCESS_INVALID, ACCESS_THROTTLED, accessMode, sanitizeNextPath } from "@/lib/access";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in — Tickr", robots: { index: false, follow: false } };

const messages: Record<string, string> = { invalid: ACCESS_INVALID, throttled: ACCESS_THROTTLED };

export default async function AccessPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const single = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const next = sanitizeNextPath(single(params.next));
  const error = messages[single(params.error) ?? ""] ?? null;
  const gated = accessMode().kind === "gated";

  return (
    <main className="access-page">
      <section className="access-card" aria-labelledby="access-title">
        <span className="brand access-brand" aria-hidden="true">
          <span className="brand-mark"><span /><span /><span /></span>
          <span>tickr<span className="brand-period">.</span></span>
        </span>
        <h1 id="access-title">Owner access</h1>
        {gated ? (
          <>
            <p className="access-lede">This Tickr workspace is private. Enter the access code you were given to continue.</p>
            <form className="access-form" method="post" action="/api/access">
              <input type="hidden" name="next" value={next} />
              <label htmlFor="access-code">Access code</label>
              <input id="access-code" name="code" type="password" autoComplete="current-password" required minLength={1} maxLength={256} autoFocus aria-describedby={error ? "access-error" : undefined} aria-invalid={error ? true : undefined} />
              {error ? <p id="access-error" className="access-error" role="alert">{error}</p> : null}
              <button type="submit">Continue</button>
            </form>
            <p className="access-note">Signing in keeps this browser signed in for 7 days. Nothing is published from this workspace without your approval.</p>
          </>
        ) : (
          <>
            <p className="access-lede">The access gate is not enabled on this instance.</p>
            <Link className="access-home" href="/">Open the workspace</Link>
          </>
        )}
      </section>
    </main>
  );
}
