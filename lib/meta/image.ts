import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { MetaClient } from "./client";
import { MetaClientError, getMetaModelConfig } from "./config";

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 4096 * 4096;
const MIME_BY_FORMAT = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;

export type MetaImageMimeType = typeof MIME_BY_FORMAT[keyof typeof MIME_BY_FORMAT];
export type MetaImageSize = "1024x1024" | "1024x1536" | "1536x1024";

export interface MetaImageReference {
  bytes: Buffer;
  mimeType: MetaImageMimeType;
  /** The caller's authorized/local asset record; never an arbitrary remote URL. */
  sourceAssetId: string;
}

export interface MetaImageRequest {
  prompt: string;
  /** Meta treats this as an aspect-ratio hint, not guaranteed pixel dimensions. */
  size?: MetaImageSize;
  referenceImages?: readonly MetaImageReference[];
}

export interface MetaImageResult {
  bytes: Buffer;
  mimeType: MetaImageMimeType;
  width: number;
  height: number;
  sha256: string;
  model: string;
  endpoint: "/images/generations" | "/images/edits";
  createdAt: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  provenance: {
    kind: "meta_generated_illustration";
    originalBusinessPhoto: false;
    referencePreservationVerified: false;
    referenceAssetIds: string[];
    promptSha256: string;
    implicitSearchEnabled: false;
    externalImageDownloads: false;
    requiresOwnerReview: true;
  };
}

export interface MetaImageDependencies {
  client?: Pick<MetaClient, "requestJson">;
  model?: string;
}

const imageResponseSchema = z.object({
  created: z.number().finite().nonnegative().optional(),
  data: z.array(z.object({ b64_json: z.string().min(1).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4) })).length(1),
  output_format: z.enum(["png", "jpeg", "webp"]).optional(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
});

function imageError(message: string, paidOutcomeUnknown = false): MetaClientError {
  return new MetaClientError("IMAGE_INVALID", message, { outcome: paidOutcomeUnknown ? "unknown" : "not_applicable" });
}

async function inspectImage(bytes: Buffer, maximumBytes: number, paidOutcomeUnknown = false) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximumBytes) {
    throw imageError("Image bytes are empty or exceed the configured size limit", paidOutcomeUnknown);
  }
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error", animated: false });
    const metadata = await image.metadata();
    if (!metadata.format || !(metadata.format in MIME_BY_FORMAT) || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) {
      throw imageError("Image must be a single-frame PNG, JPEG or WebP", paidOutcomeUnknown);
    }
    // Decode the whole image before accepting a provider blob or reference.
    await image.stats();
    const format = metadata.format as keyof typeof MIME_BY_FORMAT;
    return { format, mimeType: MIME_BY_FORMAT[format], width: metadata.width, height: metadata.height };
  } catch (error) {
    if (error instanceof MetaClientError) throw error;
    throw imageError("Image bytes could not be safely decoded", paidOutcomeUnknown);
  }
}

/**
 * One bounded Meta-hosted request; no retries, URL downloads or hidden source discovery.
 * Generated/edited bytes are illustrative even when authorized references are supplied.
 * Docs: https://dev.meta.ai/docs/image-generation (verified 2026-11-02).
 */
export async function generateMetaImage(request: MetaImageRequest, dependencies: MetaImageDependencies = {}): Promise<MetaImageResult> {
  const prompt = request.prompt.trim();
  if (!prompt || prompt.length > 12_000) throw imageError("Image prompt must contain 1 to 12000 characters");
  const size = request.size ?? "1024x1024";
  if (!["1024x1024", "1024x1536", "1536x1024"].includes(size)) throw imageError("Unsupported image aspect-ratio hint");
  const references = request.referenceImages ?? [];
  if (references.length > 3) throw imageError("At most three local reference images are allowed per request");
  const images: Array<{ image_url: string }> = [];
  for (const reference of references) {
    if (!reference.sourceAssetId.trim() || reference.sourceAssetId.length > 200) throw imageError("A reference requires a bounded source asset ID");
    const inspected = await inspectImage(reference.bytes, MAX_REFERENCE_BYTES);
    if (inspected.mimeType !== reference.mimeType) throw imageError("Reference MIME type does not match its decoded bytes");
    images.push({ image_url: `data:${inspected.mimeType};base64,${reference.bytes.toString("base64")}` });
  }

  const model = dependencies.model ?? getMetaModelConfig().image ?? "muse-image-1.0";
  if (model !== "muse-image-1.0") throw new MetaClientError("MODEL_NOT_ALLOWED", "Only the verified Muse Image 1.0 adapter is currently supported");
  const client = dependencies.client ?? new MetaClient({ models: { image: model }, timeoutMs: 120_000, maxResponseBytes: 24 * 1024 * 1024 });
  const endpoint = images.length ? "/images/edits" : "/images/generations";
  const response = await client.requestJson(endpoint, {
    method: "POST",
    modelRole: "image",
    body: {
      model,
      prompt,
      n: 1,
      size,
      response_format: "b64_json",
      output_format: "png",
      reasoning_strength: "low",
      tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
      ...(images.length ? { images } : {}),
    },
  });
  const parsed = imageResponseSchema.safeParse(response);
  if (!parsed.success) throw imageError("Meta did not return exactly one bounded inline image; no image URL will be fetched", true);
  const encoded = parsed.data.data[0].b64_json;
  if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) {
    throw imageError("Meta returned invalid image base64", true);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw imageError("Meta returned noncanonical image base64", true);
  const inspected = await inspectImage(bytes, MAX_IMAGE_BYTES, true);
  if (parsed.data.output_format && parsed.data.output_format !== inspected.format) {
    throw imageError("Meta output format does not match the actual image bytes", true);
  }
  const created = parsed.data.created === undefined ? null : new Date(parsed.data.created * 1000);
  return {
    bytes,
    mimeType: inspected.mimeType,
    width: inspected.width,
    height: inspected.height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    model,
    endpoint,
    createdAt: created && Number.isFinite(created.getTime()) ? created.toISOString() : null,
    usage: {
      inputTokens: parsed.data.usage?.input_tokens ?? null,
      outputTokens: parsed.data.usage?.output_tokens ?? null,
      totalTokens: parsed.data.usage?.total_tokens ?? null,
    },
    provenance: {
      kind: "meta_generated_illustration",
      originalBusinessPhoto: false,
      referencePreservationVerified: false,
      referenceAssetIds: references.map((reference) => reference.sourceAssetId),
      promptSha256: createHash("sha256").update(prompt).digest("hex"),
      implicitSearchEnabled: false,
      externalImageDownloads: false,
      requiresOwnerReview: true,
    },
  };
}
