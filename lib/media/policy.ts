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
  // Zyro / Hostinger Website Builder site uploads: /<site id>/<file> or the same upload behind
  // Cloudflare image resizing, /cdn-cgi/image/<options>/<site id>/<file>. The resizing options
  // segment is restricted to plain option syntax and the source must be a relative site upload
  // (never an absolute or nested URL, nor an encoded separator), so the resizer cannot be pointed
  // at another origin.
  { origin: "https://assets.zyrosite.com", path: /^(?!.*%(?:2f|5c))\/(?:cdn-cgi\/image\/(?=[^/]*=)[a-z0-9=,._-]{1,200}\/)?[A-Za-z0-9]{8,40}\/[A-Za-z0-9][A-Za-z0-9._~%()-]{0,200}\.(?:jpe?g|png|webp)$/i },
];

export function isApprovedStaticCdnAsset(url: URL): boolean {
  if (url.username || url.password || url.port) return false;
  return STATIC_IMAGE_RULES.some((rule) => url.origin === rule.origin && rule.path.test(url.pathname));
}
