import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { MetaClient, type MetaJsonRequest } from "../lib/meta/client";
import { MetaClientError } from "../lib/meta/config";
import { segmentMetaImage, type MetaSegmentationRequest } from "../lib/meta/segmentation";

/** Explicit one-shot probe. A recorded attempt is never automatically repeated. */
async function main() {
  const sourcePath = resolve(process.argv[2] ?? ".data/runs/c0f52338-da16-45c1-ab59-7d364ec2a4b0/campaign-hero-source.png");
  const prompt = process.argv[3] ?? "glass jar";
  const directory = resolve(process.argv[4] ?? ".data/sam-capability/probe");
  if (!process.env.META_API_KEY?.trim()) throw new Error("META_API_KEY is not configured. No SAM request was made.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const statePath = resolve(directory, "request-state.json");
  try {
    await readFile(statePath);
    throw new Error("This probe already has a recorded attempt. Inspect its saved response/report; no paid retry was made.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const bytes = await readFile(sourcePath);
  const request: MetaSegmentationRequest = { bytes, mimeType: "image/png", prompt, sourceAssetId: basename(sourcePath), sourceProvenance: "meta_illustration" };
  const client = new MetaClient({ models: { segmentation: "sam-3.1" }, timeoutMs: 120000, maxResponseBytes: 8 * 1024 * 1024 });
  const startedAt = new Date().toISOString();
  // Exclusive creation means concurrent invocations cannot double-spend the same probe.
  await writeFile(statePath, JSON.stringify({ status: "requested", startedAt, model: "sam-3.1", prompt, sourceAssetId: request.sourceAssetId }, null, 2), { flag: "wx", mode: 0o600 });
  const started = Date.now();
  try {
    const result = await segmentMetaImage(request, { client: { requestJson: async <T = unknown>(path: string, options?: MetaJsonRequest): Promise<T> => {
      const response = await client.requestJson<T>(path, options);
      await writeFile(resolve(directory, "response.json"), JSON.stringify(response, null, 2), { mode: 0o600 });
      return response;
    } } });
    const objects = [];
    for (const object of result.objects) {
      const filename = `object-${object.id}`;
      await writeFile(resolve(directory, `${filename}-mask.png`), object.maskPng, { mode: 0o600 });
      await writeFile(resolve(directory, `${filename}-cutout.png`), object.cutoutPng, { mode: 0o600 });
      const { maskPng, cutoutPng, ...metadata } = object;
      objects.push({ ...metadata, maskBytes: maskPng.length, cutoutBytes: cutoutPng.length, maskFilename: `${filename}-mask.png`, cutoutFilename: `${filename}-cutout.png` });
    }
    const report = { ...result, objects, checkedAt: new Date().toISOString(), docs: ["https://dev.meta.ai/docs/sam/overview", "https://dev.meta.ai/docs/sam/segmenting", "https://dev.meta.ai/docs/sam/reading-segmentation"], note: "This source is a Meta-generated jar illustration. Segmentation preserves its pixels but does not verify real product identity or photography." };
    await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    await writeFile(statePath, JSON.stringify({ status: "completed", startedAt, completedAt: new Date().toISOString(), result: result.status, responseId: result.responseId }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: result.status, elapsedMs: result.elapsedMs, width: result.width, height: result.height, objects, usage: result.usage, report: resolve(directory, "report.json") }, null, 2));
  } catch (error) {
    const report = { status: "unavailable", startedAt, elapsedMs: Date.now() - started, code: error instanceof MetaClientError ? error.code : "LOCAL_PROBE_FAILURE", outcome: error instanceof MetaClientError ? error.outcome : "unknown", noRetryAttempted: true };
    await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    await writeFile(statePath, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report));
    process.exitCode = 1;
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof MetaClientError ? `SAM probe failed: ${error.code}.` : error instanceof Error && /already has|not configured/.test(error.message) ? error.message : "SAM probe failed before completion. No automatic retry was attempted.");
  process.exitCode = 1;
});
