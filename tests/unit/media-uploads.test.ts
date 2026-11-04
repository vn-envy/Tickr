import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterEach, describe, expect, test } from "vitest";
import {
  acceptOwnerUpload, MAX_OWNER_IMAGE_BYTES, sanitizeOriginalName, sniffMediaType, validateOwnerConsent, type OwnerUploadInput,
} from "../../lib/media/uploads";

// All media below is synthetic: generated locally with sharp shapes or ffmpeg lavfi sources.
const run = promisify(execFile);
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "tickr-uploads-"));
  directories.push(path);
  return path;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const consent = () => ({ ownsOrLicensedMedia: true as const, peopleVisibleHaveConsented: "no_people" as const, attestedAt: new Date().toISOString() });
const syntheticPng = (width = 320, height = 240) => sharp({ create: { width, height, channels: 3, background: "#3a7d44" } }).png().toBuffer();

/** Detects the GPS IFD pointer tag (0x8825) in a raw EXIF block in either byte order. */
function hasGpsPointer(exif: Buffer | undefined): boolean {
  if (!exif) return false;
  const bigEndian = exif.includes(Buffer.from("MM\u0000*", "latin1"));
  return exif.includes(Buffer.from(bigEndian ? [0x88, 0x25] : [0x25, 0x88]));
}

async function syntheticVideo(dir: string, name: string, args: string[]) {
  const path = join(dir, name);
  await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:d=1:r=10", ...args, "-y", path], { timeout: 30_000 });
  return path;
}

describe("owner upload intake", () => {
  test("rejects magic-byte spoofing and unsupported formats before storing anything", async () => {
    const libraryDir = await directory();
    const png = await syntheticPng();
    const jpeg = await sharp(png).jpeg().toBuffer();
    const cases: Array<[Partial<OwnerUploadInput>, string]> = [
      [{ bytes: png, declaredMimeType: "image/jpeg" }, "TYPE_MISMATCH"],
      [{ bytes: jpeg, declaredMimeType: "video/mp4" }, "TYPE_MISMATCH"],
      [{ bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), declaredMimeType: "image/png" }, "TYPE_NOT_ALLOWED"],
      [{ bytes: Buffer.from("MZ\u0090\u0000 synthetic executable"), declaredMimeType: "video/mp4" }, "TYPE_NOT_ALLOWED"],
      [{ bytes: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(32)]), declaredMimeType: "image/heic" }, "HEIC_NOT_SUPPORTED"],
      [{ bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not really a png")]), declaredMimeType: "image/png" }, "IMAGE_DECODE_FAILED"],
      [{ bytes: png, declaredMimeType: "text/plain" }, "TYPE_NOT_ALLOWED"],
      [{ bytes: Buffer.from("MZ\u0090\u0000 synthetic executable"), declaredMimeType: "application/octet-stream" }, "TYPE_NOT_ALLOWED"],
      [{ bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("not really a jpeg")]), declaredMimeType: "" }, "IMAGE_DECODE_FAILED"],
    ];
    for (const [input, code] of cases) {
      await expect(acceptOwnerUpload({ consent: consent(), libraryDir, ...input } as OwnerUploadInput)).rejects.toMatchObject({ code });
    }
    expect(await readdir(libraryDir).catch(() => [])).toEqual([]);
    expect(sniffMediaType(png)).toMatchObject({ kind: "image", container: "png" });
  });

  test("trusts sniffed bytes when the browser declares no specific type", async () => {
    const libraryDir = await directory();
    const png = await syntheticPng();
    for (const declaredMimeType of ["application/octet-stream", "", "application/octet-stream; charset=binary"]) {
      const record = await acceptOwnerUpload({ bytes: png, declaredMimeType, originalName: "synthetic.bin", consent: consent(), libraryDir });
      expect(record).toMatchObject({ kind: "image", container: "png", mimeType: "image/png", processing: "sanitized_reencoded_image" });
    }
  });

  test("re-encodes photos: EXIF/GPS stripped, auto-oriented, private random storage name", async () => {
    const libraryDir = await directory();
    const original = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#884422" } })
      .withExif({ IFD0: { Copyright: "synthetic fixture" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "0/1 7/1 0/1" } })
      .withMetadata({ orientation: 6 })
      .jpeg().toBuffer();
    const before = await sharp(original).metadata();
    expect(hasGpsPointer(before.exif)).toBe(true);
    expect(before.orientation).toBe(6);

    const upload = await acceptOwnerUpload({ bytes: original, declaredMimeType: "image/jpg", originalName: "../../etc/IMG_0001\u202e.jpg", consent: consent(), libraryDir });
    expect(upload).toMatchObject({ kind: "image", container: "jpeg", mimeType: "image/jpeg", width: 200, height: 400, provenance: "owner_upload", rights: "owner_attested", processing: "sanitized_reencoded_image", durationSeconds: null });
    expect(upload.originalName).toBe("IMG_0001 .jpg");
    expect(basename(upload.path)).toMatch(/^owner_[a-f0-9]{32}\.jpg$/);
    expect(upload.path.startsWith(libraryDir)).toBe(true);
    expect((await stat(upload.path)).mode & 0o777).toBe(0o600);
    const stored = await readFile(upload.path);
    const after = await sharp(stored).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(stored.includes(Buffer.from("synthetic fixture"))).toBe(false);
    expect(upload.originalSha256).not.toBe(upload.sha256);

    const again = await acceptOwnerUpload({ bytes: original, declaredMimeType: "image/jpeg", consent: consent(), libraryDir });
    expect(again.path).not.toBe(upload.path);
  });

  test("requires a current ownership attestation", async () => {
    const libraryDir = await directory();
    const bytes = await syntheticPng();
    for (const bad of [undefined, { ...consent(), ownsOrLicensedMedia: false }, { ...consent(), attestedAt: "yesterday" }, { ...consent(), attestedAt: new Date(Date.now() + 3_600_000).toISOString() }, { ...consent(), extra: true }]) {
      await expect(acceptOwnerUpload({ bytes, declaredMimeType: "image/png", consent: bad as never, libraryDir })).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    }
    expect(validateOwnerConsent({ ownsOrLicensedMedia: true, peopleVisibleHaveConsented: false, attestedAt: new Date().toISOString() }).peopleVisibleHaveConsented).toBe(false);
  });

  test("enforces size, dimension and input-shape limits", async () => {
    const libraryDir = await directory();
    const oversized = Buffer.alloc(MAX_OWNER_IMAGE_BYTES + 1);
    (await syntheticPng()).copy(oversized);
    await expect(acceptOwnerUpload({ bytes: oversized, declaredMimeType: "image/png", consent: consent(), libraryDir })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(acceptOwnerUpload({ bytes: await syntheticPng(100, 100), declaredMimeType: "image/png", consent: consent(), libraryDir })).rejects.toMatchObject({ code: "IMAGE_DIMENSIONS_NOT_ALLOWED" });
    await expect(acceptOwnerUpload({ declaredMimeType: "image/png", consent: consent(), libraryDir } as OwnerUploadInput)).rejects.toMatchObject({ code: "UPLOAD_INVALID" });
    await expect(acceptOwnerUpload({ bytes: await syntheticPng(), declaredMimeType: "image/png", consent: consent(), libraryDir: "relative/dir" })).rejects.toMatchObject({ code: "STORAGE_INVALID" });
    const staged = join(await directory(), "staged.png");
    await writeFile(staged, await syntheticPng());
    const link = join(await directory(), "link.png");
    await symlink(staged, link);
    await expect(acceptOwnerUpload({ tempPath: link, declaredMimeType: "image/png", consent: consent(), libraryDir })).rejects.toMatchObject({ code: "UPLOAD_INVALID" });
    expect((await acceptOwnerUpload({ tempPath: staged, declaredMimeType: "image/png", consent: consent(), libraryDir })).width).toBe(320);
  });

  test("stores video originals privately after sniffing and a local probe", async () => {
    const work = await directory();
    const libraryDir = await directory();
    const mp4 = await syntheticVideo(work, "clip.mp4", ["-f", "lavfi", "-i", "sine=d=1", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
    const upload = await acceptOwnerUpload({ tempPath: mp4, declaredMimeType: "video/mp4", originalName: "clip.mp4", consent: consent(), libraryDir });
    expect(upload).toMatchObject({ kind: "video", container: "mp4", width: 320, height: 240, videoCodec: "h264", hasAudio: true, processing: "original_pending_normalization", rights: "owner_attested" });
    expect(upload.durationSeconds).toBeCloseTo(1, 1);
    expect(upload.sha256).toBe(upload.originalSha256);
    expect(await readFile(upload.path)).toEqual(await readFile(mp4));
    expect((await lstat(upload.path)).mode & 0o777).toBe(0o600);
    expect(basename(upload.path)).toMatch(/^owner_[a-f0-9]{32}\.mp4$/);

    const webm = await syntheticVideo(work, "clip.webm", ["-c:v", "libvpx-vp9", "-deadline", "realtime"]);
    const webmBytes = await readFile(webm);
    expect((await acceptOwnerUpload({ bytes: webmBytes, declaredMimeType: "video/webm", consent: consent(), libraryDir })).container).toBe("webm");
    await expect(acceptOwnerUpload({ bytes: webmBytes, declaredMimeType: "video/mp4", consent: consent(), libraryDir })).rejects.toMatchObject({ code: "TYPE_MISMATCH" });

    // A truncated MP4 keeps a valid ftyp header but cannot be probed; nothing is left behind.
    const truncated = (await readFile(mp4)).subarray(0, 64);
    const before = (await readdir(libraryDir)).length;
    await expect(acceptOwnerUpload({ bytes: truncated, declaredMimeType: "video/mp4", consent: consent(), libraryDir })).rejects.toMatchObject({ code: "VIDEO_DECODE_FAILED" });
    expect((await readdir(libraryDir)).length).toBe(before);
  });

  test("sanitizes display names without using them for storage", () => {
    expect(sanitizeOriginalName("C:\\Users\\owner\\Desktop\\latte art.JPG")).toBe("latte art.JPG");
    expect(sanitizeOriginalName("\u0000\u0007")).toBeNull();
    expect(sanitizeOriginalName(undefined)).toBeNull();
  });
});
