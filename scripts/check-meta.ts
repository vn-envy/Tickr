import { mkdir, writeFile } from "node:fs/promises";
import { MetaClient, MetaClientError, getMetaModelConfig } from "../lib/meta";

async function main() {
  if (!process.env.META_API_KEY?.trim()) {
    console.error("Blocked: add META_API_KEY securely in environment settings. No request made.");
    process.exitCode = 2;
    return;
  }
  const result = await new MetaClient().listModels();
  const data = typeof result === "object" && result !== null && "data" in result ? result.data : undefined;
  if (!Array.isArray(data)) throw new Error("Model listing returned an unrecognized structure; inference remains unverified.");
  const modelIds = data.flatMap((item) => typeof item?.id === "string" ? [item.id] : []);
  const report = {
    checkedAt: new Date().toISOString(),
    operation: "GET https://api.meta.ai/v1/models",
    modelListingSucceeded: true,
    modelIds,
    configuredModels: getMetaModelConfig(),
    inferenceVerified: false,
    note: "A listing does not verify structured output, search, images or segmentation. No generation call was made.",
  };
  await mkdir(".data", { recursive: true });
  await writeFile(".data/meta-capabilities.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  if (error instanceof MetaClientError) console.error(`Meta probe blocked: ${error.code}. ${error.message}`);
  else console.error(error instanceof Error ? error.message : "Meta probe failed.");
  process.exitCode = 1;
});
