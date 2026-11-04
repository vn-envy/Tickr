import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterEach, describe, expect, test } from "vitest";
import type { MediaTransport, RawMediaResponse } from "../../lib/media";
import { collectOfficialGallery, dHashDistance, imageDHash } from "../../lib/media/gallery";
import { MAX_LIBRARY_ASSETS, MAX_LIBRARY_VIDEOS, MediaLibrary, mediaLibraryIntegrityKey, publicMediaAsset } from "../../lib/media/library";
import { acceptOwnerUpload } from "../../lib/media/uploads";

// Synthetic media only: seeded block patterns (sharp) and ffmpeg lavfi colour clips.
const run = promisify(execFile);
const SITE = "https://synthetic-cafe.example.com";
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "tickr-library-"));
  directories.push(path);
  return path;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const consent = () => ({ ownsOrLicensedMedia: true as const, peopleVisibleHaveConsented: "no_people" as const, attestedAt: new Date().toISOString() });
const response = (body: string | Buffer, type = "text/html", status = 200): RawMediaResponse => ({ status, headers: { "content-type": type }, body: Buffer.isBuffer(body) ? body : Buffer.from(body) });

function pattern(seed: number, width = 800, height = 600) {
  let state = (seed * 2654435761) >>> 0;
  const raw = Buffer.alloc(16 * 12 * 3);
  for (let i = 0; i < raw.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; raw[i] = state >>> 24; }
  return sharp(raw, { raw: { width: 16, height: 12, channels: 3 } }).resize(width, height, { kernel: "nearest" });
}

async function writeImage(dir: string, name: string, seed: number, width?: number, height?: number) {
  const path = join(dir, name);
  await writeFile(path, await pattern(seed, width, height).png().toBuffer());
  return path;
}

/** A synthetic 9x8-cell greyscale ladder whose 64-bit dHash is exactly `bits` (row-major). */
async function writeHashImage(dir: string, name: string, bits: boolean[]) {
  const raw = Buffer.alloc(9 * 8);
  for (let y = 0; y < 8; y++) {
    raw[y * 9] = 128;
    for (let x = 0; x < 8; x++) raw[y * 9 + x + 1] = raw[y * 9 + x] + (bits[y * 8 + x] ? -12 : 12);
  }
  const path = join(dir, name);
  await writeFile(path, await sharp(raw, { raw: { width: 9, height: 8, channels: 1 } }).resize(900, 800, { kernel: "nearest" }).png().toBuffer());
  return path;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function syntheticClip(dir: string, n: number) {
  const path = join(dir, `clip-${n}.mp4`);
  const colour = (0x102030 + n * 0x0b0d07).toString(16).slice(-6);
  await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=0x${colour}:s=160x160:d=0.6:r=10`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", path], { timeout: 30_000 });
  return path;
}

describe("media library catalog", () => {
  test("imports gallery, upload and Graph media with provenance-derived rights", async () => {
    const runDir = await directory();
    const work = await directory();
    const library = await MediaLibrary.open(runDir);
    const gallery = await collectOfficialGallery({ officialWebsite: `${SITE}/`, outputDir: join(work, "gallery") }, {
      transport: (async (url) => {
        if (url.pathname === "/robots.txt") return response("", "text/plain", 404);
        if (url.pathname === "/") return response(`<img src="/a.jpg" alt="Synthetic pastry"><img src="/b.jpg" alt="Synthetic storefront">`);
        return response(await pattern(url.pathname === "/a.jpg" ? 1 : 2).jpeg().toBuffer(), "image/jpeg");
      }) satisfies MediaTransport,
    });
    const imported = await library.importFromGallery(gallery);
    expect(imported.map((item) => item.status)).toEqual(["added", "added"]);
    expect(imported[0].asset).toMatchObject({ kind: "image", provenance: "official_website", rights: "unknown_review_required", sourceUrl: `${SITE}/a.jpg`, sourcePageUrl: `${SITE}/`, caption: "Synthetic pastry", consent: null, durationSeconds: null });
    expect(imported[1].asset?.hints.pageRole).toBe("storefront");

    // The owner uploads a larger copy of the website pastry photo: owner provenance wins.
    const upload = await acceptOwnerUpload({ bytes: await pattern(1, 1600, 1200).jpeg().toBuffer(), declaredMimeType: "image/jpeg", originalName: "pastry.jpg", consent: consent(), libraryDir: join(work, "uploads") });
    const replaced = await library.importUpload(upload);
    expect(replaced).toMatchObject({ status: "replaced", match: "near", replaced: imported[0].asset!.id });
    expect(replaced.asset).toMatchObject({ provenance: "owner_upload", rights: "owner_attested", width: 1600, height: 1200, hints: { originalName: "pastry.jpg" } });
    expect(replaced.asset!.duplicates[0]).toMatchObject({ provenance: "official_website", match: "near", sourceUrl: `${SITE}/a.jpg` });
    await expect(stat(imported[0].asset!.localPath)).rejects.toThrow();

    // Re-importing the website copy afterwards keeps the owner asset.
    const again = await library.importFromGallery(gallery);
    expect(again.map((item) => item.status)).toEqual(["duplicate", "duplicate"]);
    expect(again[0]).toMatchObject({ match: "near", asset: { provenance: "owner_upload" } });
    expect(again[1]).toMatchObject({ match: "exact" });

    // Owner Instagram photo with EXIF GPS is sanitized; the same Graph item is not added twice.
    const igPath = join(work, "ig.jpg");
    await writeFile(igPath, await pattern(3).withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } }).jpeg().toBuffer());
    const item = { sourceId: "17890000000000001", kind: "image" as const, caption: "Synthetic caption\u0000 with control", permalink: "https://www.instagram.com/p/SYNTHETIC/", timestamp: "2026-10-01T09:30:00+0000", provenance: "owner_instagram" as const };
    const ig = await library.importMetaGraphItem(item, { path: igPath, mimeType: "image/jpeg" });
    expect(ig.asset).toMatchObject({ provenance: "owner_instagram", rights: "owner_attested", sourceId: item.sourceId, sourcePageUrl: item.permalink, sourceUrl: null, capturedAt: "2026-10-01T09:30:00.000Z", caption: "Synthetic caption with control" });
    expect((await sharp(ig.asset!.localPath).metadata()).exif).toBeUndefined();
    expect(await library.importMetaGraphItem(item, { path: igPath, mimeType: "image/jpeg" })).toMatchObject({ status: "duplicate", match: "source_id" });
    await expect(library.importMetaGraphItem({ ...item, sourceId: "17890000000000009" }, { path: igPath, mimeType: "image/jpeg", sha256: "f".repeat(64) })).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    const offSite = await library.importMetaGraphItem({ ...item, sourceId: "17890000000000002", permalink: "https://attacker.example.org/p/1", timestamp: "not a date" }, { path: await writeImage(work, "ig2.png", 4), mimeType: "image/png" });
    expect(offSite.asset).toMatchObject({ sourcePageUrl: null, capturedAt: null });

    const listed = await library.listAssets();
    expect(listed.map((asset) => asset.provenance).sort()).toEqual(["official_website", "owner_instagram", "owner_instagram", "owner_upload"]);
    expect(await library.listAssets({ provenance: "owner_upload" })).toHaveLength(1);
    expect(await library.getAsset(replaced.asset!.id)).toEqual(replaced.asset);
    expect(await library.getAsset("asset_000000000000000000000000")).toBeNull();
    for (const asset of listed) {
      expect(asset.localPath.startsWith(join(runDir, "media-library", "files"))).toBe(true);
      expect((await stat(asset.localPath)).mode & 0o777).toBe(0o600);
      expect(await library.verifyAsset(asset.id)).toEqual(asset);
    }
    expect((await stat(join(runDir, "media-library", "manifest.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(listed.map(publicMediaAsset))).not.toContain(runDir);
    expect(await readFile(join(runDir, "media-library", "manifest.json"), "utf8")).not.toContain(runDir);
  });

  test("detects manifest edits and changed asset bytes", async () => {
    const runDir = await directory();
    const library = await MediaLibrary.open(runDir);
    const added = await library.addAsset({ kind: "image", provenance: "official_website", filePath: await writeImage(await directory(), "a.png", 5), mimeType: "image/png", sourceUrl: `${SITE}/a.png` });
    const manifestPath = join(runDir, "media-library", "manifest.json");
    const original = await readFile(manifestPath, "utf8");

    // Upgrading rights alone is inconsistent with provenance; rewriting both still breaks the digest.
    await writeFile(manifestPath, original.replace('"unknown_review_required"', '"owner_attested"'));
    await expect(library.listAssets()).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    await writeFile(manifestPath, original.replace('"unknown_review_required"', '"owner_attested"').replace('"official_website"', '"owner_facebook"'));
    await expect(library.listAssets()).rejects.toMatchObject({ code: "MANIFEST_TAMPERED" });
    await expect(MediaLibrary.open(runDir)).rejects.toMatchObject({ code: "MANIFEST_TAMPERED" });
    await writeFile(manifestPath, "{not json");
    await expect(library.getAsset(added.asset!.id)).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    const parsed = JSON.parse(original);
    parsed.body.assets[0].file = "../../escape.png";
    await writeFile(manifestPath, JSON.stringify(parsed));
    await expect(library.listAssets()).rejects.toMatchObject({ code: "MANIFEST_INVALID" });

    await writeFile(manifestPath, original);
    expect(await library.verifyAsset(added.asset!.id)).toMatchObject({ id: added.asset!.id });
    await writeFile(added.asset!.localPath, await pattern(6).png().toBuffer());
    await expect(library.verifyAsset(added.asset!.id)).rejects.toMatchObject({ code: "ASSET_TAMPERED" });
  });

  test("an integrity key authenticates the manifest against recomputed digests", async () => {
    const work = await directory();
    const filePath = await writeImage(work, "k.png", 31);
    const forge = (raw: string) => {
      const parsed = JSON.parse(raw);
      parsed.body.assets[0].provenance = "owner_facebook";
      parsed.body.assets[0].rights = "owner_attested";
      parsed.body.assets[0].consent = { ownsOrLicensedMedia: true, peopleVisibleHaveConsented: "no_people", attestedAt: new Date().toISOString() };
      parsed.digest = createHash("sha256").update(`tickr-media-library-v1\n${canonicalJson(parsed.body)}`).digest("hex");
      parsed.integrity = "sha256";
      return JSON.stringify(parsed);
    };

    // Unkeyed: the digest only detects corruption; someone able to write the file can recompute it.
    const plainDir = await directory();
    const plain = await MediaLibrary.open(plainDir);
    await plain.addAsset({ kind: "image", provenance: "official_website", filePath, mimeType: "image/png" });
    const plainManifest = join(plainDir, "media-library", "manifest.json");
    await writeFile(plainManifest, forge(await readFile(plainManifest, "utf8")));
    expect((await plain.listAssets())[0].provenance).toBe("owner_facebook");

    // Keyed: the same forgery (and any downgrade to an unkeyed digest) is rejected.
    const key = mediaLibraryIntegrityKey({ TICKR_SECRET_KEY: Buffer.alloc(32, 7).toString("base64") })!;
    expect(key).toHaveLength(32);
    expect(mediaLibraryIntegrityKey({})).toBeNull();
    expect(mediaLibraryIntegrityKey({ TICKR_SECRET_KEY: "short" })).toBeNull();
    const keyedDir = await directory();
    const keyed = await MediaLibrary.open(keyedDir, { integrityKey: key });
    await keyed.addAsset({ kind: "image", provenance: "official_website", filePath, mimeType: "image/png" });
    const keyedManifest = join(keyedDir, "media-library", "manifest.json");
    const original = await readFile(keyedManifest, "utf8");
    expect(JSON.parse(original)).toMatchObject({ integrity: "hmac-sha256" });
    expect(original).not.toContain(key.toString("hex"));
    await expect(MediaLibrary.open(keyedDir)).rejects.toMatchObject({ code: "MANIFEST_KEY_REQUIRED" });
    await expect(MediaLibrary.open(keyedDir, { integrityKey: Buffer.alloc(32, 9) })).rejects.toMatchObject({ code: "MANIFEST_TAMPERED" });
    await expect(MediaLibrary.open(keyedDir, { integrityKey: Buffer.alloc(8) })).rejects.toMatchObject({ code: "LIBRARY_INVALID" });
    await writeFile(keyedManifest, forge(original));
    await expect(keyed.listAssets()).rejects.toMatchObject({ code: "MANIFEST_TAMPERED" });
    const relabelled = JSON.parse(forge(original));
    relabelled.integrity = "hmac-sha256";
    await writeFile(keyedManifest, JSON.stringify(relabelled));
    await expect(keyed.listAssets()).rejects.toMatchObject({ code: "MANIFEST_TAMPERED" });
    await writeFile(keyedManifest, original);
    expect(await keyed.listAssets()).toHaveLength(1);
  });

  test("an owner copy replaces the closest website near-duplicate and absorbs the others", async () => {
    const library = await MediaLibrary.open(await directory());
    const work = await directory();
    let state = 99;
    const base = Array.from({ length: 64 }, () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state >>> 31) === 1; });
    const flip = (indices: number[]) => base.map((bit, index) => indices.includes(index) ? !bit : bit);
    const webA = await writeHashImage(work, "web-a.png", flip([0, 1, 2, 3]));
    const webB = await writeHashImage(work, "web-b.png", flip([60, 61, 62]));
    const owner = await writeHashImage(work, "owner.png", base);
    const [hashA, hashB, hashOwner] = await Promise.all([webA, webB, owner].map((path) => imageDHash(path)));
    expect([dHashDistance(hashA, hashOwner), dHashDistance(hashB, hashOwner), dHashDistance(hashA, hashB)]).toEqual([4, 3, 7]);

    const a = await library.addAsset({ kind: "image", provenance: "official_website", filePath: webA, mimeType: "image/png", sourceUrl: `${SITE}/a.png` });
    const b = await library.addAsset({ kind: "image", provenance: "official_website", filePath: webB, mimeType: "image/png", sourceUrl: `${SITE}/b.png` });
    expect([a.status, b.status]).toEqual(["added", "added"]);
    const replaced = await library.addAsset({ kind: "image", provenance: "owner_instagram", sourceId: "ig_owner_1", filePath: owner, mimeType: "image/png" });
    expect(replaced).toMatchObject({ status: "replaced", match: "near", replaced: b.asset!.id, absorbed: [a.asset!.id] });
    expect(replaced.asset!.duplicates.map((entry) => entry.sourceUrl)).toEqual([`${SITE}/b.png`, `${SITE}/a.png`]);
    expect((await library.listAssets()).map((asset) => asset.id)).toEqual([replaced.asset!.id]);
    await expect(stat(a.asset!.localPath)).rejects.toThrow();
    await expect(stat(b.asset!.localPath)).rejects.toThrow();

    // A lower-priority copy near an owner asset is a duplicate even when a website copy is closer.
    const again = await library.addAsset({ kind: "image", provenance: "official_website", filePath: webA, mimeType: "image/png", sourceUrl: `${SITE}/a.png` });
    expect(again).toMatchObject({ status: "duplicate", match: "near", asset: { id: replaced.asset!.id } });
  });

  test("one changed gallery file is reported without stopping the rest of the import", async () => {
    const work = await directory();
    const gallery = await collectOfficialGallery({ officialWebsite: `${SITE}/`, outputDir: join(work, "gallery") }, {
      transport: (async (url) => {
        if (url.pathname === "/robots.txt") return response("", "text/plain", 404);
        if (url.pathname === "/") return response(`<img src="/a.jpg" alt="Synthetic pastry"><img src="/b.jpg" alt="Synthetic counter"><img src="/c.jpg" alt="Synthetic cup">`);
        return response(await pattern({ "/a.jpg": 41, "/b.jpg": 42, "/c.jpg": 43 }[url.pathname]!).jpeg().toBuffer(), "image/jpeg");
      }) satisfies MediaTransport,
    });
    expect(gallery.assets).toHaveLength(3);
    await writeFile(gallery.localFiles[gallery.assets[0].id], await pattern(44).png().toBuffer());
    delete gallery.localFiles[gallery.assets[1].id];
    const outcomes = await (await MediaLibrary.open(await directory())).importFromGallery(gallery);
    expect(outcomes).toEqual([
      { status: "rejected", asset: null, reason: "invalid_asset", code: "HASH_MISMATCH", sourceUrl: gallery.assets[0].sourceUrl },
      { status: "rejected", asset: null, reason: "invalid_asset", code: "ASSET_UNREADABLE", sourceUrl: gallery.assets[1].sourceUrl },
      expect.objectContaining({ status: "added", asset: expect.objectContaining({ sourceUrl: `${SITE}/c.jpg` }) }),
    ]);
  });

  test("rejects unsanitized images, spoofed types, missing consent and hash drift", async () => {
    const library = await MediaLibrary.open(await directory());
    const work = await directory();
    const exifPath = join(work, "exif.jpg");
    await writeFile(exifPath, await pattern(7).withExif({ IFD0: { Copyright: "synthetic" } }).jpeg().toBuffer());
    await expect(library.addAsset({ kind: "image", provenance: "official_website", filePath: exifPath, mimeType: "image/jpeg" })).rejects.toMatchObject({ code: "IMAGE_NOT_SANITIZED" });
    const pngPath = await writeImage(work, "b.png", 8);
    await expect(library.addAsset({ kind: "image", provenance: "official_website", filePath: pngPath, mimeType: "image/jpeg" })).rejects.toMatchObject({ code: "TYPE_MISMATCH" });
    await expect(library.addAsset({ kind: "video", provenance: "owner_instagram", filePath: pngPath, mimeType: "video/mp4" })).rejects.toMatchObject({ code: "TYPE_MISMATCH" });
    await expect(library.addAsset({ kind: "image", provenance: "owner_upload", filePath: pngPath, mimeType: "image/png" })).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    await expect(library.addAsset({ kind: "image", provenance: "official_website", filePath: pngPath, mimeType: "image/png", expectedSha256: "0".repeat(64) })).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    await expect(library.addAsset({ kind: "image", provenance: "official_website", filePath: pngPath, mimeType: "image/png", sourceUrl: "javascript:alert(1)" })).rejects.toMatchObject({ code: "ASSET_INVALID" });
    await expect(library.addAsset({ kind: "image", provenance: "official_website", filePath: "relative.png", mimeType: "image/png" })).rejects.toMatchObject({ code: "ASSET_UNREADABLE" });
    const illustration = await library.addAsset({ kind: "image", provenance: "meta_illustration", filePath: pngPath, mimeType: "image/png" });
    expect(illustration.asset).toMatchObject({ rights: "generated_illustration" });
    expect(await library.listAssets()).toHaveLength(1);
  });

  test(`caps the catalog at ${MAX_LIBRARY_ASSETS} assets, evicting only lower-priority media for owner media`, async () => {
    const library = await MediaLibrary.open(await directory());
    const work = await directory();
    for (let n = 0; n < MAX_LIBRARY_ASSETS; n++) {
      const result = await library.addAsset({ kind: "image", provenance: "official_website", filePath: await writeImage(work, `w${n}.png`, 1000 + n, 192, 144), mimeType: "image/png" });
      expect(result.status).toBe("added");
    }
    const overflow = await library.addAsset({ kind: "image", provenance: "official_website", filePath: await writeImage(work, "extra.png", 5000, 192, 144), mimeType: "image/png" });
    expect(overflow).toEqual({ status: "rejected", asset: null, reason: "asset_limit" });
    const owner = await library.addAsset({ kind: "image", provenance: "owner_facebook", sourceId: "fb_1", filePath: await writeImage(work, "owner.png", 6000, 192, 144), mimeType: "image/png", consent: consent() });
    expect(owner.status).toBe("added");
    expect(owner.status === "added" && owner.evicted).toMatch(/^asset_/);
    expect(await library.listAssets()).toHaveLength(MAX_LIBRARY_ASSETS);
  }, 60_000);

  test(`caps videos at ${MAX_LIBRARY_VIDEOS} and probes their geometry locally`, async () => {
    const library = await MediaLibrary.open(await directory());
    const work = await directory();
    for (let n = 0; n < MAX_LIBRARY_VIDEOS; n++) {
      const result = await library.importMetaGraphItem({ sourceId: `video_${n}`, kind: "video", caption: null, permalink: null, timestamp: null, provenance: "owner_facebook" }, { path: await syntheticClip(work, n), mimeType: "video/mp4" });
      expect(result.status).toBe("added");
      if (n === 0) expect(result.asset).toMatchObject({ kind: "video", width: 160, height: 160, dHash: null, mimeType: "video/mp4" });
    }
    const extra = await library.importMetaGraphItem({ sourceId: "video_extra", kind: "video", caption: null, permalink: null, timestamp: null, provenance: "owner_facebook" }, { path: await syntheticClip(work, 99), mimeType: "video/mp4" });
    expect(extra).toMatchObject({ status: "rejected", reason: "video_limit" });
    const upload = await acceptOwnerUpload({ tempPath: await syntheticClip(work, 98), declaredMimeType: "video/mp4", consent: consent(), libraryDir: join(work, "uploads") });
    const owner = await library.importUpload(upload);
    expect(owner.status).toBe("added");
    expect((await library.listAssets({ kind: "video" })).length).toBe(MAX_LIBRARY_VIDEOS);
  }, 60_000);

  test("serializes concurrent additions without losing records", async () => {
    const runDir = await directory();
    const work = await directory();
    const library = await MediaLibrary.open(runDir);
    const paths = await Promise.all(Array.from({ length: 6 }, (_, n) => writeImage(work, `c${n}.png`, 200 + n)));
    const results = await Promise.all(paths.map((filePath) => library.addAsset({ kind: "image", provenance: "official_website", filePath, mimeType: "image/png" })));
    expect(results.every((result) => result.status === "added")).toBe(true);
    expect(await (await MediaLibrary.open(runDir)).listAssets()).toHaveLength(6);
  });
});
