import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { MetaClient } from "../lib/meta/client";
import { MetaClientError } from "../lib/meta/config";
import { generateMetaImage } from "../lib/meta/image";

async function offline() {
  const png = await sharp({ create: { width: 32, height: 48, channels: 3, background: "#ad7854" } }).png().toBuffer();
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = new MetaClient({
    apiKey: "offline-test-key",
    models: { image: "muse-image-1.0" },
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      assert.equal(init?.redirect, "error");
      return Response.json({ created: 1_793_577_600, data: [{ b64_json: png.toString("base64") }], output_format: "png" });
    },
  });
  const generated = await generateMetaImage({ prompt: "Synthetic offline illustration" }, { client });
  assert.equal(generated.mimeType, "image/png");
  assert.equal(generated.width, 32);
  assert.equal(generated.height, 48);
  assert.equal(generated.provenance.originalBusinessPhoto, false);
  assert.equal(requests[0].url, "https://api.meta.ai/v1/images/generations");
  assert.deepEqual(requests[0].body.tool_enablement, { enable_image_search: false, enable_web_search: false, enable_shell: false });
  const edited = await generateMetaImage({
    prompt: "Synthetic offline edit",
    referenceImages: [{ bytes: png, mimeType: "image/png", sourceAssetId: "fixture-only" }],
  }, { client });
  assert.equal(requests[1].url, "https://api.meta.ai/v1/images/edits");
  assert.deepEqual(edited.provenance.referenceAssetIds, ["fixture-only"]);
  assert.equal(edited.provenance.referencePreservationVerified, false);
  assert.match((requests[1].body.images as Array<{ image_url: string }>)[0].image_url, /^data:image\/png;base64,/);
  await assert.rejects(generateMetaImage({
    prompt: "Invalid reference",
    referenceImages: [{ bytes: png, mimeType: "image/jpeg", sourceAssetId: "fixture-only" }],
  }, { client }), /MIME type/);
  assert.equal(requests.length, 2);
  const urlOnlyClient = new MetaClient({
    apiKey: "offline-test-key",
    models: { image: "muse-image-1.0" },
    fetch: async () => Response.json({ data: [{ url: "https://unexpected.example/image.png" }] }),
  });
  await assert.rejects(generateMetaImage({ prompt: "Reject URL-only output" }, { client: urlOnlyClient }), /no image URL will be fetched/);
  console.log("Offline image adapter checks passed: generation/edit shapes, inline bytes, provenance, MIME validation and URL refusal. No external requests made.");
}

async function live() {
  if (!process.env.META_API_KEY?.trim()) throw new Error("META_API_KEY is missing; no live request made.");
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = path.resolve(".data/image-capability", runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const prompt = "Create a refined botanical and heritage-inspired gouache illustration for a fictional bakery campaign background: a warm ochre mixing bowl, folded cream linen, a wooden spoon, delicate leafy sprigs and subtle flour marks on a muted teal tabletop in soft morning light. Portrait composition with generous calm empty space at the top for later typography. No food products, words, letters, logos, brands, people or recognizable real premises. This is a clearly illustrative concept, not a photograph of any real business or its products.";
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const result = await generateMetaImage({ prompt, size: "1024x1536" });
    const extension = result.mimeType === "image/png" ? "png" : result.mimeType === "image/jpeg" ? "jpg" : "webp";
    const imagePath = path.join(directory, `illustrative-capability.${extension}`);
    await writeFile(imagePath, result.bytes, { mode: 0o600, flag: "wx" });
    const { bytes, ...metadata } = result;
    const report = {
      kind: "live_meta_image_capability_probe",
      startedAt,
      completedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      requestsMade: 1,
      automaticRetries: 0,
      networkOrigins: ["https://api.meta.ai"],
      docs: ["https://dev.meta.ai/docs/image-generation", "https://dev.meta.ai/docs/api-reference/images/schemas"],
      prompt,
      outputPath: path.relative(process.cwd(), imagePath),
      outputBytes: bytes.length,
      ...metadata,
      imageEditingLiveVerified: false,
      imageUnderstandingLiveVerified: false,
      searchOrPublicImageRetrievalVerified: false,
      note: "Generic generated illustration only. Not bakery photography, product evidence, owner approval or a ready campaign asset.",
    };
    await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ ...report, prompt: "[generic illustrative diagnostic prompt; stored privately in report]" }, null, 2));
  } catch (error) {
    const failure = {
      kind: "live_meta_image_capability_probe",
      startedAt,
      completedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      passed: false,
      automaticRetries: 0,
      code: error instanceof MetaClientError ? error.code : "PROBE_FAILED",
      outcome: error instanceof MetaClientError ? error.outcome : "unknown",
    };
    await writeFile(path.join(directory, "report.json"), JSON.stringify(failure, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    throw error;
  }
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === "--offline")) return offline();
  if (arguments_.length === 1 && arguments_[0] === "--live") return live();
  throw new Error("Usage: tsx scripts/image-smoke.ts [--offline|--live]. Live mode makes one paid Meta image request.");
}

main().catch((error: unknown) => {
  console.error(error instanceof MetaClientError ? `Image probe failed: ${error.code}; outcome=${error.outcome}. No retry attempted.` : "Image diagnostic failed. No automatic retry attempted.");
  process.exitCode = 1;
});
