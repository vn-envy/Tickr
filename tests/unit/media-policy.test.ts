import { describe, expect, it } from "vitest";
import { isApprovedStaticCdnAsset } from "../../lib/media/policy";

describe("official-site static image hosts", () => {
  it("accepts only exact site-builder origins and their owner-image path prefixes", () => {
    for (const url of [
      "https://cdn.uengage.io/uploads/7175/jar.png",
      "https://images.squarespace-cdn.com/content/v1/abc/latte.jpg",
      "https://static.wixstatic.com/media/abc_123~mv2.jpg",
      "https://cdn.shopify.com/s/files/1/0001/products/beans.png",
    ]) expect(isApprovedStaticCdnAsset(new URL(url))).toBe(true);
    for (const url of [
      "https://cdn.uengage.io/api/image.png",
      "https://images.squarespace-cdn.com/other/latte.jpg",
      "https://evil.static.wixstatic.com/media/a.jpg",
      "http://static.wixstatic.com/media/a.jpg",
      "https://static.wixstatic.com:8443/media/a.jpg",
      "https://user:pass@cdn.shopify.com/s/files/a.png",
      "https://cdn.shopify.com/assets/a.png",
      "https://images.squarespace-cdn.com.attacker.example/content/a.jpg",
    ]) expect(isApprovedStaticCdnAsset(new URL(url))).toBe(false);
  });
});
