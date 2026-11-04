/** Narrow static host observed in official-site HTML; never accepts model-provided asset URLs. */
export function isApprovedStaticCdnAsset(url: URL): boolean {
  return url.origin === "https://cdn.uengage.io" && /^\/(?:uploads|brand_logo)\//.test(url.pathname);
}
