/**
 * Narrow static image hosts observed in official-site HTML. A URL qualifies only when the
 * official page itself references it (callers enforce that); model-provided asset URLs are
 * never accepted. Each rule is an exact origin plus a path prefix used by that platform for
 * the site owner's own uploaded images — common for small businesses whose official site is
 * built on a hosted site builder. Fetches still go through the pinned, credential-free reader
 * with robots, MIME and size checks.
 */
const STATIC_IMAGE_RULES: ReadonlyArray<{ origin: string; path: RegExp }> = [
  { origin: "https://cdn.uengage.io", path: /^\/(?:uploads|brand_logo)\// },
  // Squarespace site images.
  { origin: "https://images.squarespace-cdn.com", path: /^\/content\// },
  // Wix site media.
  { origin: "https://static.wixstatic.com", path: /^\/media\// },
  // Shopify storefront files and product images.
  { origin: "https://cdn.shopify.com", path: /^\/s\/files\// },
];

export function isApprovedStaticCdnAsset(url: URL): boolean {
  if (url.username || url.password || url.port) return false;
  return STATIC_IMAGE_RULES.some((rule) => url.origin === rule.origin && rule.path.test(url.pathname));
}
