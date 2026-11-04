import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  collectOfficialMedia, extractOfficialGalleryReferences, extractOfficialMediaCandidates, MAX_IMAGE_DOWNLOAD_BYTES, parseSrcset,
  createOfficialMediaReader, normalizeOfficialImage, publicMediaMetadata,
  type MediaTransport, type RawMediaResponse,
} from "../../lib/media";

const PAGE = "https://bakery.example.com/menu";
const directories: string[] = [];
const response = (body: string | Buffer, type = "text/html", status = 200, headers: Record<string, string> = {}): RawMediaResponse => ({
  status, headers: { "content-type": type, ...headers }, body: Buffer.isBuffer(body) ? body : Buffer.from(body),
});
const noRobots = response("", "text/plain", 404);
const productHtml = `<html><head><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@graph": [
    { "@type": "Product", name: "Signature sourdough", image: { "@type": "ImageObject", url: "/media/loaf.jpg", caption: "Our sourdough loaf", width: 800, height: 600 } },
    { "@type": "Organization", name: "Fixture bakery", logo: "/media/brand.png" },
  ],
})}</script><meta property="og:image" content="/media/loaf.jpg"><meta property="og:image:alt" content="The bakery's products"></head><body><img src="/media/store.webp" alt="Bakery storefront" width="1200" height="900"><img src="https://cdn.vendor.com/loaf.jpg" alt="CDN photo"></body></html>`;

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "tickr-media-"));
  directories.push(path);
  return path;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("official-page media extraction", () => {
  test("links each product image to actual JSON-LD product metadata and retains unknown rights", () => {
    const candidates = extractOfficialMediaCandidates(productHtml, PAGE);
    expect(candidates).toHaveLength(4);
    expect(candidates[0]).toMatchObject({
      imageUrl: "https://bakery.example.com/media/loaf.jpg", sourcePageUrl: PAGE,
      kind: "product", productName: "Signature sourdough", label: "Our sourdough loaf",
      discoveredVia: "json_ld", declaredWidth: 800, declaredHeight: 600, eligible: true, rights: "unknown",
    });
    expect(candidates.find((item) => item.kind === "logo")).toMatchObject({ productName: null, imageUrl: "https://bakery.example.com/media/brand.png" });
    expect(candidates.find((item) => item.imageUrl.includes("cdn.vendor"))).toMatchObject({ eligible: false, exclusionReason: "cross_origin", rights: "unknown" });
  });

  test("handles relative images and lazy references without using a hostile base URL", () => {
    const candidates = extractOfficialMediaCandidates(`<base href="https://attacker.com/"><img src="data:image/png;base64,abc" data-src="photos/cake.jpg" alt="Cake &amp; tea"><meta property="og:image" content="/hero.png"><meta property="og:image:width" content="720">`, PAGE);
    expect(candidates.map((item) => item.imageUrl)).toContain("https://bakery.example.com/photos/cake.jpg");
    expect(candidates.find((item) => item.imageUrl.endsWith("cake.jpg"))?.label).toBe("Cake & tea");
    expect(candidates.find((item) => item.imageUrl.endsWith("hero.png"))?.declaredWidth).toBe(720);
    expect(candidates.every((item) => !item.imageUrl.startsWith("data:"))).toBe(true);
  });

  test("rejects non-website sources and bounds HTML and candidate count", () => {
    expect(() => extractOfficialMediaCandidates(productHtml, "https://www.instagram.com/bakery/")).toThrow();
    expect(() => extractOfficialMediaCandidates("x".repeat(513 * 1024), PAGE)).toThrow();
    const candidates = extractOfficialMediaCandidates(Array.from({ length: 100 }, (_, n) => `<img src="/media/photo-${n}.png">`).join(""), PAGE);
    expect(candidates.length).toBeLessThanOrEqual(24);
  });

  test("ignores image-looking script strings, comments and templates", () => {
    const candidates = extractOfficialMediaCandidates(`<script>const fake = '<img src="/not-a-product.png">';</script><!-- <img src="/comment.png"> --><template><img src="/template.png"></template><img src="/real.png" alt="Real page image">`, PAGE);
    expect(candidates.map((item) => item.imageUrl)).toEqual(["https://bakery.example.com/real.png"]);
  });

  test("retains exact preferred metadata ahead of unrelated candidates without expanding the cap", () => {
    const page = Array.from({ length: 90 }, (_, n) => `<img src="/icon-${n}.png" alt="Icon ${n}">`).join("") + `<img src="https://cdn.vendor.com/jar.jpg" alt="Blueberry Cheesecake Jar">`;
    const candidates = extractOfficialMediaCandidates(page, PAGE, { preferredProduct: "Blueberry Cheesecake Jar" });
    expect(candidates).toHaveLength(24);
    expect(candidates[0]).toMatchObject({ label: "Blueberry Cheesecake Jar", eligible: false, exclusionReason: "cross_origin" });
  });
});

describe("srcset parsing (HTML Standard algorithm)", () => {
  const ZYRO = "https://assets.zyrosite.com/cdn-cgi/image";
  test("keeps commas inside URLs (CDN image-resizing options) as part of the URL", () => {
    const srcset = `${ZYRO}/format=auto,w=375,fit=crop/AwvJ8Xv2kGsVqxEL/img_1234.JPG 375w,${ZYRO}/format=auto,w=768,fit=crop/AwvJ8Xv2kGsVqxEL/img_1234.JPG 768w, ${ZYRO}/format=auto,w=1440,fit=crop/AwvJ8Xv2kGsVqxEL/img_1234.JPG 1440w`;
    expect(parseSrcset(srcset)).toEqual([
      { url: `${ZYRO}/format=auto,w=375,fit=crop/AwvJ8Xv2kGsVqxEL/img_1234.JPG`, width: 375, density: 1 },
      { url: `${ZYRO}/format=auto,w=768,fit=crop/AwvJ8Xv2kGsVqxEL/img_1234.JPG`, width: 768, density: 1 },
      { url: `${ZYRO}/format=auto,w=1440,fit=crop/AwvJ8Xv2kGsVqxEL/img_1234.JPG`, width: 1440, density: 1 },
    ]);
  });

  test("reads w and x descriptors, bare URLs and trailing-comma URLs", () => {
    expect(parseSrcset("/a.jpg 1x, /a@2x.jpg 2x,/b.jpg, /c.jpg 1.5x,\n\t/d.jpg   640w ,  /e.jpg,, /f.jpg")).toEqual([
      { url: "/a.jpg", width: 0, density: 1 }, { url: "/a@2x.jpg", width: 0, density: 2 },
      { url: "/b.jpg", width: 0, density: 1 }, { url: "/c.jpg", width: 0, density: 1.5 }, { url: "/d.jpg", width: 640, density: 1 },
      { url: "/e.jpg", width: 0, density: 1 }, { url: "/f.jpg", width: 0, density: 1 },
    ]);
    // As in browsers, a URL is a run of non-whitespace: an inner comma with no space stays in the URL.
    expect(parseSrcset("/b.jpg,/c.jpg 1.5x")).toEqual([{ url: "/b.jpg,/c.jpg", width: 0, density: 1.5 }]);
    expect(parseSrcset("/a.jpg 800w 600h, /b.jpg")).toEqual([{ url: "/a.jpg", width: 800, density: 1 }, { url: "/b.jpg", width: 0, density: 1 }]);
  });

  test("ignores data:/blob: URLs and drops candidates with malformed descriptors", () => {
    expect(parseSrcset("data:image/png;base64,iVBORw0KGgo= 1x, /real.jpg 2x, blob:https://x.example/1 3x")).toEqual([{ url: "/real.jpg", width: 0, density: 2 }]);
    expect(parseSrcset("/a.jpg 100w 2x, /b.jpg 0w, /c.jpg -1x, /d.jpg 300q, /e.jpg 100w 200w, /f.jpg 600h, /g.jpg foo(1, 2) 1x, /ok.jpg 500w")).toEqual([{ url: "/ok.jpg", width: 500, density: 1 }]);
    expect(parseSrcset("")).toEqual([]);
    expect(parseSrcset(undefined)).toEqual([]);
    expect(parseSrcset(" , ,, ")).toEqual([]);
  });

  test("bounds the input and the number of candidates", () => {
    expect(parseSrcset(Array.from({ length: 40 }, (_, n) => `/p-${n}.jpg ${n + 1}w`).join(", "))).toHaveLength(16);
    // A candidate cut off by the input bound is never returned as a (partial) URL.
    const long = `/keep.jpg 100w, /${"x".repeat(20_000)}.jpg 200w`;
    expect(parseSrcset(long)).toEqual([{ url: "/keep.jpg", width: 100, density: 1 }]);
  });

  test("the standard extractor records whole comma-bearing srcset URLs, never fragments", () => {
    const srcset = [375, 768, 1024, 1440, 1920, 2880].map((width) => `${ZYRO}/format=auto,w=${width},fit=crop/AwvJ8Xv2kGsVqxEL/img_1234.JPG ${width}w`).join(",");
    const candidates = extractOfficialMediaCandidates(`<img alt="Pancakes" src="${ZYRO}/format=auto,w=1440,fit=crop/AwvJ8Xv2kGsVqxEL/img_1234.JPG" srcset="${srcset}">`, "https://synthetic-diner.example.com/");
    const urls = candidates.map((item) => item.imageUrl);
    expect(urls).toContain(`${ZYRO}/format=auto,w=1920,fit=crop/AwvJ8Xv2kGsVqxEL/img_1234.JPG`);
    expect(urls.every((url) => url.startsWith(`${ZYRO}/format=auto,w=`))).toBe(true);
    expect(urls.some((url) => /fit=crop\/AwvJ/.test(url) && url.startsWith("https://synthetic-diner.example.com/"))).toBe(false);
    expect(candidates.every((item) => item.eligible)).toBe(true);
  });

  test("a page of many site-builder pictures keeps every picture's preferred rendition reader-referenced", () => {
    const resized = (n: number, width: number) => `${ZYRO}/format=auto,w=${width},fit=crop/AwvJ8Xv2kGsVqxEL/photo-${n}.JPG`;
    const widths = [375, 768, 1024, 1440, 1920, 2880];
    const html = Array.from({ length: 20 }, (_, n) => `<img alt="Synthetic plate ${n}" src="${resized(n, 1024)}" srcset="${widths.map((width) => `${resized(n, width)} ${width}w`).join(",")}">`).join("");
    const page = "https://synthetic-diner.example.com/";
    const candidates = extractOfficialMediaCandidates(html, page);
    expect(candidates).toHaveLength(24);
    const urls = new Set(candidates.map((item) => item.imageUrl));
    // Breadth first: the preferred (widest <= 2000 px) rendition of all 20 pictures precedes any fallback.
    for (let n = 0; n < 20; n++) expect(urls.has(resized(n, 1920))).toBe(true);
    expect(candidates.slice(0, 20).map((item) => item.imageUrl)).toEqual(Array.from({ length: 20 }, (_, n) => resized(n, 1920)));
    const references = extractOfficialGalleryReferences(html, page, { max: 20 });
    expect(references).toHaveLength(20);
    expect(references.every((reference) => reference.candidate.eligible)).toBe(true);
    expect(references.map((reference) => reference.candidate.imageUrl)).toEqual(Array.from({ length: 20 }, (_, n) => resized(n, 1920)));
  });

  test("lazy data-srcset renditions are references too, in the gallery's preference order", () => {
    const html = `<img alt="Lazy" src="/img/placeholder.jpg" data-srcset="${ZYRO}/format=auto,w=640,fit=crop/AwvJ8Xv2kGsVqxEL/lazy.JPG 640w, ${ZYRO}/format=auto,w=1280,fit=crop/AwvJ8Xv2kGsVqxEL/lazy.JPG 1280w">`;
    const page = "https://synthetic-diner.example.com/";
    const candidates = extractOfficialMediaCandidates(html, page);
    expect(candidates.map((item) => item.imageUrl)).toEqual([
      `${ZYRO}/format=auto,w=1280,fit=crop/AwvJ8Xv2kGsVqxEL/lazy.JPG`,
      `${ZYRO}/format=auto,w=640,fit=crop/AwvJ8Xv2kGsVqxEL/lazy.JPG`,
      `${page}img/placeholder.jpg`,
    ]);
    const [reference] = extractOfficialGalleryReferences(html, page);
    expect(reference.candidate.imageUrl).toBe(`${ZYRO}/format=auto,w=1280,fit=crop/AwvJ8Xv2kGsVqxEL/lazy.JPG`);
    expect(reference.alternates.map((item) => item.imageUrl)).toEqual([`${ZYRO}/format=auto,w=640,fit=crop/AwvJ8Xv2kGsVqxEL/lazy.JPG`, `${page}img/placeholder.jpg`]);
  });
});

describe("bounded official media acquisition", () => {
  test("downloads same-origin real bytes, normalizes locally and keeps paths private", async () => {
    const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#b77943" } }).jpeg().toBuffer();
    const outputDir = await directory();
    const calls: string[] = [];
    const transport: MediaTransport = async (url, options) => {
      calls.push(url.href);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      if (url.pathname === "/robots.txt") return noRobots;
      if (url.pathname === "/menu") return response(productHtml);
      return response(jpg, "image/jpeg");
    };
    const result = await collectOfficialMedia({ officialWebsite: PAGE, outputDir, maxAssets: 1 }, { transport });
    expect(result.status).toBe("partial"); // CDN reference intentionally omitted.
    expect(calls).toEqual(["https://bakery.example.com/robots.txt", PAGE, "https://bakery.example.com/media/loaf.jpg"]);
    expect(result.acquired).toHaveLength(1);
    const asset = result.acquired[0];
    expect(asset).toMatchObject({
      productName: "Signature sourdough", kind: "product", width: 800, height: 600,
      mimeType: "image/png", sourceMimeType: "image/jpeg", rights: "unknown",
      usage: "private_concept_review", requiresPublicationReview: true,
    });
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    const stored = await readFile(result.localFiles[asset.id]);
    expect(stored.length).toBe(asset.bytes);
    expect((await sharp(stored).metadata()).format).toBe("png");
    expect(JSON.stringify(publicMediaMetadata(result))).not.toContain(outputDir);
    expect(publicMediaMetadata(result)).not.toHaveProperty("localFiles");
  });

  test("blocks private/service URLs before transport and refuses cross-origin image redirects", async () => {
    const transport = vi.fn<MediaTransport>();
    for (const officialWebsite of ["https://127.0.0.1", "https://169.254.169.254/latest/meta-data", "https://www.instagram.com/a", "https://maps.app.goo.gl/reference", "https://api.vendor.com/images"]) {
      const result = await collectOfficialMedia({ officialWebsite, outputDir: await directory() }, { transport });
      expect(result.status).toBe("unavailable");
    }
    expect(transport).not.toHaveBeenCalled();
    const calls: string[] = [];
    const redirect: MediaTransport = async (url) => {
      calls.push(url.href);
      if (url.pathname === "/robots.txt") return noRobots;
      if (url.pathname === "/menu") return response(`<img src="/photo.png">`);
      return response("", "image/png", 302, { location: "https://cdn.vendor.com/photo.png" });
    };
    const result = await collectOfficialMedia({ officialWebsite: PAGE, outputDir: await directory() }, { transport: redirect });
    expect(result.acquired).toHaveLength(0);
    expect(calls).not.toContain("https://cdn.vendor.com/photo.png");
    expect(result.warnings.join(" ")).toContain("CROSS_ORIGIN_MEDIA");
  });

  test("prioritizes an exact product alt label before the acquisition cap", async () => {
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
    const calls: string[] = [];
    const result = await collectOfficialMedia({ officialWebsite: PAGE, outputDir: await directory(), maxAssets: 1, preferredProduct: "Blueberry Cheesecake Jar" }, {
      transport: async (url) => {
        calls.push(url.pathname);
        if (url.pathname === "/robots.txt") return noRobots;
        if (url.pathname === "/menu") return response(`<img src="/store.png" alt="Storefront"><img src="/cake.png" alt="Blueberry cake"><img src="/jar.png" alt=" Blueberry   Cheesecake Jar ">`);
        return response(png, "image/png");
      },
    });
    expect(result.acquired).toHaveLength(1);
    expect(result.acquired[0]).toMatchObject({ sourceUrl: "https://bakery.example.com/jar.png", label: "Blueberry Cheesecake Jar", productName: null });
    expect(calls).toEqual(["/robots.txt", "/menu", "/jar.png"]);
  });

  test("honors robots image restrictions and page/header reuse restrictions", async () => {
    const calls: string[] = [];
    const transport: MediaTransport = async (url) => {
      calls.push(url.pathname);
      return url.pathname === "/robots.txt"
        ? response("User-agent: *\nDisallow: /private/", "text/plain")
        : response(`<img src="/private/product.png">`);
    };
    const result = await collectOfficialMedia({ officialWebsite: PAGE, outputDir: await directory() }, { transport });
    expect(result.warnings.join(" ")).toContain("ROBOTS_RESTRICTED");
    expect(calls).toEqual(["/robots.txt", "/menu"]);
    for (const page of [response(`<meta name="robots" content="noimageai"><img src="/a.png">`), response(`<img src="/a.png">`, "text/html", 200, { "x-robots-tag": "noarchive" })]) {
      const blocked = await collectOfficialMedia({ officialWebsite: PAGE, outputDir: await directory() }, { transport: async (url) => url.pathname === "/robots.txt" ? noRobots : page });
      expect(blocked.candidates).toHaveLength(0);
      expect(blocked.warnings.join(" ")).toContain("SOURCE_RESTRICTED");
    }
  });

  test("acquires only exact approved CDN references and checks that origin's robots first", async () => {
    const imageUrl = "https://cdn.uengage.io/uploads/7175/jar.png";
    const png = await sharp({ create: { width: 160, height: 160, channels: 3, background: "white" } }).png().toBuffer();
    const calls: string[] = [];
    const transport: MediaTransport = async (url) => {
      calls.push(url.href);
      if (url.pathname === "/robots.txt") return noRobots;
      if (url.href === PAGE) return response(`<img src="${imageUrl}" alt="Blueberry Cheesecake Jar"><img src="https://cdn.uengage.io/api/image.png" alt="Unapproved path">`);
      return response(png, "image/png");
    };
    const result = await collectOfficialMedia({ officialWebsite: PAGE, outputDir: await directory(), preferredProduct: "Blueberry Cheesecake Jar", maxAssets: 1 }, { transport });
    expect(result.acquired[0]).toMatchObject({ sourcePageUrl: PAGE, sourceUrl: imageUrl, label: "Blueberry Cheesecake Jar", width: 160, height: 160, rights: "unknown" });
    expect(calls).toEqual(["https://bakery.example.com/robots.txt", PAGE, "https://cdn.uengage.io/robots.txt", imageUrl]);
    const reader = createOfficialMediaReader(PAGE, { transport });
    try {
      await reader.readPage();
      await expect(reader.readImage("https://cdn.uengage.io/uploads/7175/not-on-page.png")).rejects.toMatchObject({ code: "CROSS_ORIGIN_MEDIA" });
      expect(calls).not.toContain("https://cdn.uengage.io/uploads/7175/not-on-page.png");
    } finally { reader.close(); }
  });

  test("does not download a referenced CDN image when CDN robots denies it", async () => {
    const imageUrl = "https://cdn.uengage.io/uploads/7175/jar.png";
    const calls: string[] = [];
    const result = await collectOfficialMedia({ officialWebsite: PAGE, outputDir: await directory() }, {
      transport: async (url) => {
        calls.push(url.href);
        if (url.origin === "https://cdn.uengage.io") return response("User-agent: *\nDisallow: /uploads/", "text/plain");
        return url.pathname === "/robots.txt" ? noRobots : response(`<img src="${imageUrl}" alt="Blueberry Cheesecake Jar">`);
      },
    });
    expect(result.acquired).toHaveLength(0);
    expect(result.warnings.join(" ")).toContain("ROBOTS_RESTRICTED");
    expect(calls).not.toContain(imageUrl);
  });

  test("stops on CDN robots server errors and does not repeat that robots request for other candidates", async () => {
    const calls: string[] = [];
    const result = await collectOfficialMedia({ officialWebsite: PAGE, outputDir: await directory() }, {
      transport: async (url) => {
        calls.push(url.href);
        if (url.origin === "https://cdn.uengage.io") return response("Upstream unavailable", "text/html", 500);
        return url.pathname === "/robots.txt" ? noRobots : response(`<img src="https://cdn.uengage.io/uploads/7175/jar.png" alt="Jar"><img src="https://cdn.uengage.io/brand_logo/brand.png" alt="Brand">`);
      },
    });
    expect(result.acquired).toHaveLength(0);
    expect(result.warnings.join(" ")).toContain("ROBOTS_RESTRICTED");
    expect(calls.filter((url) => url.startsWith("https://cdn.uengage.io"))).toEqual(["https://cdn.uengage.io/robots.txt"]);
  });

  test("rejects oversized bodies, compressed transfers and invalid/active image payloads", async () => {
    const badImages = [
      response(Buffer.alloc(MAX_IMAGE_DOWNLOAD_BYTES + 1), "image/png"),
      response("compressed", "image/png", 200, { "content-encoding": "gzip" }),
      response(`<svg><image href="https://attacker.com/x"/></svg>`, "image/svg+xml"),
      response("not an image", "image/jpeg"),
    ];
    for (const bad of badImages) {
      const result = await collectOfficialMedia({ officialWebsite: PAGE, outputDir: await directory() }, {
        transport: async (url) => url.pathname === "/robots.txt" ? noRobots : url.pathname === "/menu" ? response(`<img src="/photo.png">`) : bad,
      });
      expect(result.acquired).toHaveLength(0);
      expect(result.status).toBe("unavailable");
    }
  });

  test("enforces decoded dimensions, MIME identity and preserves aspect ratio when resizing", async () => {
    const small = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
    await expect(normalizeOfficialImage(small, "image/png")).rejects.toMatchObject({ code: "IMAGE_DIMENSIONS_NOT_ALLOWED" });
    const png = await sharp({ create: { width: 200, height: 150, channels: 3, background: "white" } }).png().toBuffer();
    await expect(normalizeOfficialImage(png, "image/jpeg")).rejects.toMatchObject({ code: "IMAGE_TYPE_MISMATCH" });
    const large = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: "white" } }).png().toBuffer();
    await expect(normalizeOfficialImage(large, "image/png")).rejects.toMatchObject({ code: "IMAGE_DECODE_FAILED" });
    const wide = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "white" } }).png().toBuffer();
    const normalized = await normalizeOfficialImage(wide, "image/png");
    expect(normalized).toMatchObject({ width: 1600, height: 800 });
  });

  test("returns an access limitation without replacing failed official media", async () => {
    const unavailable = await collectOfficialMedia({ officialWebsite: PAGE, outputDir: await directory() }, { transport: async () => { throw new Error("network blocked"); } });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.acquired).toHaveLength(0);
    expect(unavailable.warnings.join(" ")).toContain("no unverified replacement");
    const timedOut = await collectOfficialMedia({ officialWebsite: PAGE, outputDir: await directory() }, { transport: () => new Promise(() => {}), timeoutMs: 5 });
    expect(timedOut.warnings.join(" ")).toContain("READ_TIMEOUT");
  });
});
