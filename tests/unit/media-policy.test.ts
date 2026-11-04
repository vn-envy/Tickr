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

  it("accepts Zyro/Hostinger site uploads, including Cloudflare-resized ones, and nothing else on that host", () => {
    for (const url of [
      "https://assets.zyrosite.com/AwvJ8Xv2kGsVqxEL/img_1234-YKb0aXQ2ZDhpOMZB.JPG",
      "https://assets.zyrosite.com/cdn-cgi/image/format=auto,w=375,fit=crop/AwvJ8Xv2kGsVqxEL/img_1234-YKb0aXQ2ZDhpOMZB.JPG",
      "https://assets.zyrosite.com/cdn-cgi/image/format=auto,w=1440,h=756,fit=crop/m7V3EJ4GNkUk7pDE/pancakes%20stack-A1b2C3.jpeg",
      "https://assets.zyrosite.com/m7V3EJ4GNkUk7pDE/menu-board.webp",
    ]) expect(isApprovedStaticCdnAsset(new URL(url))).toBe(true);
    for (const url of [
      // Wrong scheme, port, credentials or a look-alike host.
      "http://assets.zyrosite.com/AwvJ8Xv2kGsVqxEL/a.jpg",
      "https://assets.zyrosite.com:8443/AwvJ8Xv2kGsVqxEL/a.jpg",
      "https://user:pass@assets.zyrosite.com/AwvJ8Xv2kGsVqxEL/a.jpg",
      "https://assets.zyrosite.com.attacker.example/AwvJ8Xv2kGsVqxEL/a.jpg",
      "https://evil.assets.zyrosite.com/AwvJ8Xv2kGsVqxEL/a.jpg",
      "https://zyrosite.com/AwvJ8Xv2kGsVqxEL/a.jpg",
      // The resizer pointed at another origin or a nested path, or an encoded separator.
      "https://assets.zyrosite.com/cdn-cgi/image/w=375/https://attacker.example/a.jpg",
      "https://assets.zyrosite.com/cdn-cgi/image/w=375//attacker.example/a.jpg",
      "https://assets.zyrosite.com/cdn-cgi/image/w=375/AwvJ8Xv2kGsVqxEL/nested/a.jpg",
      "https://assets.zyrosite.com/cdn-cgi/image/w=375/AwvJ8Xv2kGsVqxEL/a%2F..%2Fb.jpg",
      "https://assets.zyrosite.com/cdn-cgi/image/w=375/AwvJ8Xv2kGsVqxEL/a%5Cb.jpg",
      "https://assets.zyrosite.com/cdn-cgi/image/w=375:x/AwvJ8Xv2kGsVqxEL/a.jpg",
      "https://assets.zyrosite.com/cdn-cgi/image/auto/AwvJ8Xv2kGsVqxEL/a.jpg",
      // Not an owner upload shape: other paths, short ids, non-photo files.
      "https://assets.zyrosite.com/cdn-cgi/trace",
      "https://assets.zyrosite.com/a.jpg",
      "https://assets.zyrosite.com/short/a.jpg",
      "https://assets.zyrosite.com/AwvJ8Xv2kGsVqxEL/",
      "https://assets.zyrosite.com/AwvJ8Xv2kGsVqxEL/script.js",
      "https://assets.zyrosite.com/AwvJ8Xv2kGsVqxEL/logo.svg",
      "https://assets.zyrosite.com/AwvJ8Xv2kGsVqxEL/a/b.jpg",
    ]) expect(isApprovedStaticCdnAsset(new URL(url))).toBe(false);
  });
});
