import type { openBrowser } from "@remotion/renderer";

type RenderBrowser = Awaited<ReturnType<typeof openBrowser>>;

export function isLocalRenderUrl(rawUrl: string): boolean {
  if (rawUrl === "about:blank" || rawUrl.startsWith("data:")) return true;
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "blob:") return isLocalRenderUrl(url.pathname);
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/**
 * Diagnostic guard for Remotion's local render server. It intentionally permits
 * only loopback HTTP and inline resources, not external images or fonts. This
 * does not replace the application's API-client policy or OS-level egress rules.
 */
export function installLocalRenderGuard(browser: RenderBrowser) {
  const observedOrigins = new Set<string>();
  const blockedOrigins = new Set<string>();
  const failures: unknown[] = [];
  const pending = new Set<Promise<void>>();
  const newPage = browser.newPage.bind(browser);

  browser.newPage = async (options) => {
    const page = await newPage(options);
    const session = await page.target().createCDPSession();
    // Remotion exposes a typed subset of CDP. Fetch.* is a standard Chromium
    // domain but absent from that subset; constrain the escape hatch here.
    const send = session.send.bind(session) as unknown as (
      method: "Fetch.enable" | "Fetch.continueRequest" | "Fetch.failRequest",
      params: Record<string, unknown>,
    ) => Promise<unknown>;

    session.on("Fetch.requestPaused", (raw: unknown) => {
      const event = raw as { requestId?: string; request?: { url?: string } };
      if (!event.requestId || !event.request?.url) {
        failures.push(new Error("Malformed Chromium request event."));
        return;
      }
      const allowed = isLocalRenderUrl(event.request.url);
      let origin: string;
      try {
        origin = new URL(event.request.url).origin;
      } catch {
        origin = "invalid-url";
      }
      observedOrigins.add(origin);
      if (!allowed) blockedOrigins.add(origin);
      const request = send(
        allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
        allowed
          ? { requestId: event.requestId }
          : { requestId: event.requestId, errorReason: "BlockedByClient" },
      ).then(
        () => undefined,
        (error: unknown) => { failures.push(error); },
      );
      pending.add(request);
      void request.finally(() => pending.delete(request));
    });
    await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    return page;
  };

  return {
    observedOrigins,
    blockedOrigins,
    async assertClean() {
      await Promise.all(pending);
      if (failures.length) throw new Error("The render network guard failed to inspect a request.");
      if (blockedOrigins.size) throw new Error("The composition attempted a non-local network request.");
    },
  };
}
