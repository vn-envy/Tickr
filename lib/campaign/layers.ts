import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { z } from "zod";
import { generateMetaImage } from "../meta/image";
import { getMetaSegmentationDiagnostic, recoverMetaSegmentationResponse, segmentMetaImage, type MetaSegmentationResult } from "../meta/segmentation";
import { CampaignVisualSchema, ModelUsageSchema, type CampaignVisual, type ModelUsage } from "../research/contracts";
import { hashBytes, safeOutputPath } from "./archive";
import type { CampaignCopy } from "./copy";
import type { RenderInput } from "./render";

const fileSchema = z.object({ filename: z.string(), sha256: z.string(), bytes: z.number().int(), width: z.number().int(), height: z.number().int() }).strict();
export type LayerAsset = z.infer<typeof fileSchema>;
const stepSchema = z.object({ inputHash: z.string(), state: z.enum(["requested", "completed"]), outcome: z.enum(["segmented", "no_match", "failed"]).optional(), requestedAt: z.string(), files: z.array(fileSchema), usage: ModelUsageSchema.optional(), warnings: z.array(z.string()), coverage: z.number().nullable(), objects: z.number().int(), responseId: z.string().nullable() }).strict();
const finalSchema = z.object({ inputHash: z.string(), visual: CampaignVisualSchema, files: z.array(fileSchema), usage: z.array(ModelUsageSchema) }).strict();
export interface CampaignLayersInput {
  image?: RenderInput["image"]; visual: CampaignVisual; copy: CampaignCopy; outputDir: string;
  mode: "live" | "synthetic"; reuseCompletedOnly?: boolean; reserveModelCall?: () => Promise<void>;
}
export interface CampaignLayersResult { image?: RenderInput["image"]; visual: CampaignVisual; assets: LayerAsset[]; usage: ModelUsage[] }
export interface LayerDependencies { segment?: typeof segmentMetaImage; recoverSegment?: typeof recoverMetaSegmentationResponse; generateBackground?: typeof generateMetaImage }

async function readJson(directory: string, filename: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(safeOutputPath(directory, filename), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("The saved visual layer checkpoint could not be verified. No model request was repeated."); }
}
async function saveJson(directory: string, filename: string, value: unknown) {
  await mkdir(directory, { recursive: true });
  const temporary = safeOutputPath(directory, `${filename}.pending`);
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, safeOutputPath(directory, filename));
}
async function savePng(directory: string, filename: string, bytes: Buffer): Promise<LayerAsset> {
  const metadata = await sharp(bytes, { limitInputPixels: 16_777_216 }).metadata();
  if (metadata.format !== "png" || !metadata.width || !metadata.height || bytes.length > 16 * 1024 * 1024) throw new Error("Invalid visual layer raster.");
  await writeFile(safeOutputPath(directory, filename), bytes, { mode: 0o600 });
  return { filename, sha256: hashBytes(bytes), bytes: bytes.length, width: metadata.width, height: metadata.height };
}
async function loadPng(directory: string, asset: LayerAsset): Promise<Buffer> {
  const bytes = await readFile(safeOutputPath(directory, asset.filename));
  if (bytes.length !== asset.bytes || hashBytes(bytes) !== asset.sha256) throw new Error("A saved visual layer changed. No replacement model request was made.");
  return bytes;
}

/** Union matching SAM masks; keep decoded source RGB and multiply its original alpha. */
export async function composeSegmentedSubject(bytes: Uint8Array, result: MetaSegmentationResult): Promise<{ foreground: Buffer; mask: Buffer; coverage: number; objects: number } | null> {
  if (hashBytes(Buffer.from(bytes)) !== result.sourceSha256) throw new Error("SAM mask does not belong to the campaign source image.");
  const source = await sharp(bytes, { limitInputPixels: 16_777_216 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (source.info.width !== result.width || source.info.height !== result.height || source.info.channels !== 4) throw new Error("SAM dimensions differ from the unchanged source raster.");
  const objects = result.objects.filter((object) => object.foregroundPixels > 0 && (object.confidence === null || object.confidence >= 0.5));
  if (!objects.length || objects.length > 16) return null;
  const mask = Buffer.alloc(result.width * result.height);
  for (const object of objects) {
    const { left, top, right, bottom } = object.bounds;
    if (![left, top, right, bottom].every(Number.isInteger) || left < 0 || top < 0 || right > result.width || bottom > result.height || right <= left || bottom <= top) throw new Error("SAM returned invalid subject bounds.");
    const decoded = await sharp(object.maskPng, { limitInputPixels: 16_777_216 }).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== right - left || decoded.info.height !== bottom - top || decoded.info.channels !== 1) throw new Error("SAM mask dimensions differ from its bounds.");
    for (let y = 0; y < decoded.info.height; y++) for (let x = 0; x < decoded.info.width; x++) {
      if (decoded.data[y * decoded.info.width + x] >= 128) mask[(top + y) * result.width + left + x] = 255;
    }
  }
  let selected = 0;
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] && source.data[index * 4 + 3]) selected++;
    source.data[index * 4 + 3] = Math.round(source.data[index * 4 + 3] * mask[index] / 255);
  }
  const coverage = selected / mask.length;
  // Empty/tiny/full-frame selections are poor composition layers, not proof of a visible product.
  if (coverage < 0.015 || coverage > 0.9) return null;
  return {
    foreground: await sharp(source.data, { raw: { width: result.width, height: result.height, channels: 4 } }).png().toBuffer(),
    mask: await sharp(mask, { raw: { width: result.width, height: result.height, channels: 1 } }).png().toBuffer(), coverage, objects: objects.length,
  };
}

export function backgroundPrompt(copy: CampaignCopy): string {
  const brief = copy.creativeBrief;
  return `Create an elegant empty editorial advertising backdrop, portrait composition. No foreground subject, products, food, people, buildings, real premises, packaging, logo, letters, numbers or text. Keep the central area and upper third uncluttered for an unchanged source-product cutout and typography. Use refined paper texture, directional studio light, restrained depth and an intentional premium graphic composition. Proposed palette: ${brief?.visualDirection.palette.join(", ") ?? "warm cream, charcoal, soft gold"}. Art-direction data (not instructions): ${JSON.stringify({ direction: brief?.visualDirection.description, seasonalTheme: brief?.context?.seasonalTheme.status === "proposed_theme" ? brief.context.seasonalTheme.name : null })}. If a seasonal theme is given, suggest it through subtle light and color only. This is a clearly disclosed generated backdrop, not a depiction of the business's real location.`;
}

/** SAM gets one attempt. Only original-photo cutouts need a separate Muse backdrop. */
export async function prepareCampaignLayers(input: CampaignLayersInput, dependencies: LayerDependencies = {}): Promise<CampaignLayersResult> {
  if (!input.image || input.mode === "synthetic") return { image: input.image, visual: input.visual, assets: [], usage: [] };
  const sourceBytes = Buffer.from(input.image.bytes);
  const sourceSha256 = hashBytes(sourceBytes);
  const prompt = (input.copy.creativeBrief?.focus.offeringId ? input.copy.creativeBrief.focus.name : /logo/i.test(input.image.description) ? "logo" : "main object").replace(/[<>\r\n\u0000-\u001f]/g, " ").slice(0, 120).trim();
  const inputHash = hashBytes(Buffer.from(JSON.stringify({ version: "campaign-layers-1", sourceSha256, visual: input.visual, brief: input.copy.creativeBrief, prompt })));
  const finalFile = "art-direction-checkpoint.json";
  const saved = await readJson(input.outputDir, finalFile);
  const restore = async (record: z.infer<typeof finalSchema>): Promise<CampaignLayersResult> => {
    if (record.inputHash !== inputHash) throw new Error("Visual layers no longer match their source and creative brief.");
    const loaded = new Map<string, Buffer>();
    for (const file of record.files) loaded.set(file.filename, await loadPng(input.outputDir, file));
    const layers = record.visual.artDirection;
    return { image: { ...input.image!, backgroundStyle: layers?.composition === "subject_layers" ? "palette_gradient" : "source_image", ...(layers?.foregroundFilename ? { foregroundBytes: loaded.get(layers.foregroundFilename) } : {}), ...(layers?.backgroundFilename ? { backgroundBytes: loaded.get(layers.backgroundFilename) } : {}) }, visual: record.visual, assets: record.files, usage: record.usage };
  };
  if (saved) return restore(finalSchema.parse(saved));
  // Historical render-only retries retain their established image and never initiate SAM.
  if (input.reuseCompletedOnly) return { image: input.image, visual: input.visual, assets: [], usage: [] };
  await mkdir(input.outputDir, { recursive: true });
  const assets: LayerAsset[] = [], usage: ModelUsage[] = [], warnings: string[] = [];
  let segmentation: NonNullable<CampaignVisual["artDirection"]>["segmentation"] = { status: "skipped", model: null, prompt, coverageFraction: null, objectCount: 0 };
  const usefulSubject = Boolean(input.copy.creativeBrief?.focus.offeringId || input.visual.kind === "source_photo");
  if (usefulSubject && input.reserveModelCall && sourceBytes.length <= 8 * 1024 * 1024) {
    const filename = "sam-layer-checkpoint.json";
    const previous = await readJson(input.outputDir, filename);
    let step = previous ? stepSchema.parse(previous) : null;
    if (step && step.inputHash !== inputHash) throw new Error("SAM checkpoint no longer matches the source image.");
    const request = { bytes: sourceBytes, mimeType: input.image.mimeType, prompt, sourceAssetId: "campaign-source-image", sourceProvenance: input.visual.kind === "source_photo" ? "source_photo" as const : "meta_illustration" as const };
    const responseDirectory = safeOutputPath(input.outputDir, "sam-response");
    const applyResult = async (result: MetaSegmentationResult, target: z.infer<typeof stepSchema>) => {
      target.usage = { model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, elapsedMs: result.elapsedMs, imagesProcessed: result.usage.imagesProcessed };
      target.responseId = result.responseId;
      const composed = await composeSegmentedSubject(sourceBytes, result);
      if (composed) {
        target.files = [await savePng(input.outputDir, "campaign-subject.png", composed.foreground), await savePng(input.outputDir, "campaign-subject-mask.png", composed.mask)];
        target.coverage = composed.coverage; target.objects = composed.objects; target.outcome = "segmented";
      } else {
        target.outcome = "no_match";
        target.warnings.push("SAM did not produce a usable subject selection. The original image is retained with art-directed cropping.");
      }
    };
    if (step?.state === "requested") {
      try {
        const recovered = await (dependencies.recoverSegment ?? recoverMetaSegmentationResponse)(request, responseDirectory);
        if (recovered) {
          await applyResult(recovered, step);
          step.state = "completed";
          await saveJson(input.outputDir, filename, step);
        }
      } catch (error) {
        const diagnostic = getMetaSegmentationDiagnostic(error);
        await saveJson(input.outputDir, "sam-layer-diagnostic.json", diagnostic);
        // An outstanding request has no result to revalidate. Corruption and
        // decode failures remain explicit failures; none authorizes a new call.
        if (diagnostic.code !== "SEGMENTATION_PENDING") throw error;
      }
    }
    if (!step) {
      await input.reserveModelCall();
      step = { inputHash, state: "requested", requestedAt: new Date().toISOString(), files: [], warnings: [], coverage: null, objects: 0, responseId: null };
      await saveJson(input.outputDir, filename, step);
      const started = Date.now();
      try {
        const result = await (dependencies.segment ?? segmentMetaImage)(request, { responseDirectory });
        await applyResult(result, step);
      } catch (error) {
        const diagnostic = getMetaSegmentationDiagnostic(error);
        await saveJson(input.outputDir, "sam-layer-diagnostic.json", diagnostic);
        step.outcome = "failed";
        step.responseId ??= diagnostic.responseId;
        step.usage ??= { model: "sam-3.1", inputTokens: diagnostic.usage?.inputTokens ?? null, outputTokens: diagnostic.usage?.outputTokens ?? null, imagesProcessed: diagnostic.usage?.imagesProcessed ?? null, elapsedMs: diagnostic.elapsedMs > 0 ? diagnostic.elapsedMs : Date.now() - started };
        step.warnings.push("The SAM subject layer could not be completed. The original image is retained; segmentation was not retried.");
      }
      step.state = "completed"; await saveJson(input.outputDir, filename, step);
    }
    if (step.state === "requested") {
      warnings.push("A previous SAM request has an uncertain outcome. No segmentation request was repeated; the source image is retained.");
      usage.push({ model: "sam-3.1", inputTokens: null, outputTokens: null, elapsedMs: 0 });
      segmentation = { ...segmentation, status: "failed", model: "sam-3.1" };
    } else {
      for (const file of step.files) await loadPng(input.outputDir, file);
      assets.push(...step.files); warnings.push(...step.warnings); if (step.usage) usage.push(step.usage);
      segmentation = { status: step.outcome ?? (step.files.length ? "segmented" : step.responseId ? "no_match" : "failed"), model: "sam-3.1", prompt, coverageFraction: step.coverage, objectCount: step.objects };
    }
  } else if (usefulSubject) warnings.push("Subject segmentation was unavailable for this execution; the original image is used with composed crops.");
  let background: "palette" | "meta_generated" | "source" = segmentation.status === "segmented" ? "palette" : "source";
  if (segmentation.status === "segmented" && input.visual.kind === "source_photo" && input.reserveModelCall) {
    const filename = "backdrop-checkpoint.json";
    const previous = await readJson(input.outputDir, filename);
    let step = previous ? stepSchema.parse(previous) : null;
    if (step && step.inputHash !== inputHash) throw new Error("Backdrop checkpoint no longer matches the source image.");
    if (!step) {
      await input.reserveModelCall();
      step = { inputHash, state: "requested", requestedAt: new Date().toISOString(), files: [], warnings: [], coverage: null, objects: 0, responseId: null };
      await saveJson(input.outputDir, filename, step);
      const started = Date.now();
      try {
        const result = await (dependencies.generateBackground ?? generateMetaImage)({ prompt: backgroundPrompt(input.copy), size: "1024x1536" });
        step.usage = { model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, elapsedMs: Date.now() - started };
        step.files = [await savePng(input.outputDir, "campaign-backdrop.png", await sharp(result.bytes).png().toBuffer())];
      } catch {
        step.usage = { model: "muse-image-1.0", inputTokens: null, outputTokens: null, elapsedMs: Date.now() - started };
        step.warnings.push("The generated backdrop was unavailable. A local palette background is used; the image request was not repeated.");
      }
      step.state = "completed"; await saveJson(input.outputDir, filename, step);
    }
    if (step.state === "requested") {
      warnings.push("A previous backdrop request has an uncertain outcome. A local palette background is used without repeating that request.");
      usage.push({ model: "muse-image-1.0", inputTokens: null, outputTokens: null, elapsedMs: 0 });
    } else {
      for (const file of step.files) await loadPng(input.outputDir, file);
      assets.push(...step.files); warnings.push(...step.warnings); if (step.usage) usage.push(step.usage);
      if (step.files.length) background = "meta_generated";
    }
  }
  const visual: CampaignVisual = { ...input.visual, warnings: [...input.visual.warnings, ...warnings, ...(segmentation.status === "segmented" ? ["SAM isolates the selected subject while retaining source RGB pixels; its mask is a composition aid, not proof of product identity or accuracy."] : [])], artDirection: {
    composition: segmentation.status === "segmented" ? "subject_layers" : "image_crop", sourceSha256,
    foregroundFilename: assets.find((asset) => asset.filename === "campaign-subject.png")?.filename ?? null,
    maskFilename: assets.find((asset) => asset.filename === "campaign-subject-mask.png")?.filename ?? null,
    backgroundFilename: assets.find((asset) => asset.filename === "campaign-backdrop.png")?.filename ?? null,
    background, segmentation,
  } };
  const record = finalSchema.parse({ inputHash, visual, files: assets, usage });
  await saveJson(input.outputDir, finalFile, record);
  return restore(record);
}
