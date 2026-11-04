import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp, { type Metadata } from "sharp";
import { SourceReadError } from "../research/source-reader";
import { MediaReadError, type MediaAcquisitionResult, type MediaTransport } from "./contracts";
import { extractOfficialMediaCandidates } from "./extract";
import { createOfficialMediaReader } from "./reader";

const MAX_INPUT_PIXELS = 12_000_000;
const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;

export async function normalizeOfficialImage(bytes: Buffer, contentType: string) {
  const image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: false, failOn: "error" });
  let metadata: Metadata;
  try { metadata = await image.metadata(); } catch { throw new MediaReadError("IMAGE_DECODE_FAILED", "The official image could not be decoded within the pixel limit."); }
  const expected: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };
  if (!expected[contentType] || metadata.format !== expected[contentType]) throw new MediaReadError("IMAGE_TYPE_MISMATCH", "The official image bytes did not match its declared type.");
  if (!metadata.width || !metadata.height || metadata.width < 64 || metadata.height < 64 || metadata.width * metadata.height > MAX_INPUT_PIXELS || (metadata.pages ?? 1) > 1) {
    throw new MediaReadError("IMAGE_DIMENSIONS_NOT_ALLOWED", "The official image was too small, too large or animated for the campaign media path.");
  }
  try {
    // Decode/re-encode drops active payloads and private EXIF metadata. Uniform
    // fitting preserves aspect ratio; this is not generative enhancement.
    const result = await image.autoOrient().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    if (result.data.length > MAX_OUTPUT_BYTES) throw new MediaReadError("OUTPUT_TOO_LARGE", "The normalized image exceeded its storage limit.");
    return { bytes: result.data, width: result.info.width, height: result.info.height };
  } catch (error) {
    if (error instanceof MediaReadError) throw error;
    throw new MediaReadError("IMAGE_DECODE_FAILED", "The official image could not be normalized safely.");
  }
}

function failureMessage(error: unknown): string {
  return error instanceof MediaReadError || error instanceof SourceReadError
    ? `${error.code}: ${error.message}`
    : "MEDIA_UNAVAILABLE: Official media acquisition failed; no unverified replacement was used.";
}

/**
 * outputDir is an application-controlled private staging directory, never an
 * owner/model-supplied filesystem path. Unknown reuse rights stay explicit.
 */
export async function collectOfficialMedia(
  input: { officialWebsite: string; outputDir: string; maxAssets?: number; preferredProduct?: string },
  options: { transport?: MediaTransport; timeoutMs?: number } = {},
): Promise<MediaAcquisitionResult> {
  const result: MediaAcquisitionResult = {
    status: "unavailable", sourcePageUrl: input.officialWebsite,
    candidates: [], acquired: [], localFiles: {}, warnings: [], retrievedAt: new Date().toISOString(),
  };
  const requestedAssets = typeof input.maxAssets === "number" && Number.isFinite(input.maxAssets) ? Math.floor(input.maxAssets) : 3;
  const maxAssets = Math.min(3, Math.max(1, requestedAssets));
  let reader: ReturnType<typeof createOfficialMediaReader> | undefined;
  try {
    reader = createOfficialMediaReader(input.officialWebsite, { ...options, preferredProduct: input.preferredProduct });
    const page = await reader.readPage();
    result.sourcePageUrl = page.url;
    result.candidates = extractOfficialMediaCandidates(page.html, page.url, { preferredProduct: input.preferredProduct });
    if (!result.candidates.length) { result.status = "no_candidates"; return result; }
    const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    const preferred = input.preferredProduct ? normalize(input.preferredProduct) : "";
    // Literal page metadata association only; never infer a dish from appearance.
    const exactMatch = (candidate: typeof result.candidates[number]) => preferred && [candidate.productName, candidate.label].some((label) => label && normalize(label) === preferred) ? 1 : 0;
    const eligible = result.candidates.filter((candidate) => candidate.eligible).sort((a, b) => exactMatch(b) - exactMatch(a));
    const excluded = result.candidates.length - eligible.length;
    if (excluded) result.warnings.push(`${excluded} referenced image(s) were not fetched because their origin, format or interface-only role is outside the automatic acquisition boundary.`);
    let failures = 0;
    const contentHashes = new Set<string>();
    // Attempt at most six references, even if several fail or duplicate content.
    for (const candidate of eligible.slice(0, 6)) {
      if (result.acquired.length >= maxAssets) break;
      try {
        const source = await reader.readImage(candidate.imageUrl);
        const normalized = await normalizeOfficialImage(source.body, source.contentType);
        const sha256 = createHash("sha256").update(normalized.bytes).digest("hex");
        if (contentHashes.has(sha256)) continue;
        contentHashes.add(sha256);
        const id = `media_${sha256.slice(0, 24)}`;
        const filename = `${id}.png`;
        const directory = resolve(input.outputDir);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const localPath = join(directory, filename);
        await writeFile(localPath, normalized.bytes, { mode: 0o600 });
        result.acquired.push({
          id, candidateId: candidate.id, sourcePageUrl: page.url, sourceUrl: source.url,
          kind: candidate.kind, label: candidate.label, productName: candidate.productName,
          retrievedAt: new Date().toISOString(), sourceMimeType: source.contentType, mimeType: "image/png",
          filename, width: normalized.width, height: normalized.height, bytes: normalized.bytes.length,
          sha256, sourceSha256: createHash("sha256").update(source.body).digest("hex"), normalization: "auto_orient_and_fit_1600_png",
          rights: "unknown", usage: "private_concept_review", requiresPublicationReview: true,
        });
        result.localFiles[id] = localPath;
      } catch (error) {
        failures++;
        result.warnings.push(`${candidate.id}: ${failureMessage(error)}`);
        if (error instanceof MediaReadError && ["READ_TIMEOUT", "DIRECT_CONNECTION_UNAVAILABLE", "CONNECTION_UNAVAILABLE", "PROXY_CONNECT_REJECTED", "TLS_UNVERIFIED"].includes(error.code)) break;
      }
    }
    result.status = result.acquired.length ? failures || excluded ? "partial" : "acquired" : "unavailable";
    if (result.acquired.length) result.warnings.push("Official-page references do not establish reuse rights or product identity. Acquired media is for private concept review; publication requires a separate rights and factual review.");
    else result.warnings.push("No usable official photo could be acquired. This is a media-access limitation, not proof that the business has no photos.");
    return result;
  } catch (error) {
    result.warnings.push(failureMessage(error));
    return result;
  } finally { reader?.close(); }
}
