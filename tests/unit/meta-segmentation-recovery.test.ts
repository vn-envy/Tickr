import { mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MetaClientError } from "../../lib/meta/config";
import { getMetaSegmentationDiagnostic, recoverMetaSegmentationResponse, segmentMetaImage, type MetaSegmentationRequest } from "../../lib/meta/segmentation";

const directories: string[] = [];
async function directory() { const value = await mkdtemp(join(tmpdir(), "tickr-sam-recovery-")); directories.push(value); return value; }
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function source(): Promise<MetaSegmentationRequest> {
  return { bytes: await sharp({ create: { width: 2, height: 2, channels: 3, background: "#abc123" } }).png().toBuffer(), mimeType: "image/png", prompt: "jar", sourceAssetId: "saved-source", sourceProvenance: "meta_illustration" };
}
function response(text = "") { return { id: "sam-saved-response", model: "sam-3.1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, images_processed: 1 } }; }

describe("durable SAM responses", () => {
  test("stores private input-bound raw responses and recovers without another request", async () => {
    const responseDirectory = await directory();
    const input = await source();
    const requestJson = vi.fn().mockResolvedValue(response());
    const first = await segmentMetaImage(input, { responseDirectory, client: { requestJson } });
    const second = await segmentMetaImage(input, { responseDirectory, client: { requestJson } });
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(await recoverMetaSegmentationResponse(input, responseDirectory)).toEqual(first);
    const saved = JSON.parse(await readFile(join(responseDirectory, "sam-response.json"), "utf8"));
    expect(saved.response).toEqual(response());
    expect(saved.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.contentHash).toMatch(/^[a-f0-9]{64}$/);
    for (const filename of await readdir(responseDirectory)) expect((await stat(join(responseDirectory, filename))).mode & 0o777).toBe(0o600);
    await expect(segmentMetaImage({ ...input, prompt: "bowl" }, { responseDirectory, client: { requestJson } })).rejects.toMatchObject({ code: "SEGMENTATION_CHECKPOINT_INVALID" });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  test("retains completed raw output and actual metering even when local decoding fails", async () => {
    const responseDirectory = await directory();
    const input = await source();
    const raw = response("not valid segmentation");
    const requestJson = vi.fn().mockResolvedValue(raw);
    const failure = await segmentMetaImage(input, { responseDirectory, client: { requestJson } }).catch((error: unknown) => error);
    expect(getMetaSegmentationDiagnostic(failure)).toMatchObject({ phase: "decode", code: "SEGMENTATION_INVALID", completedResponseStored: true, responseId: "sam-saved-response", usage: { inputTokens: 0, outputTokens: 0, imagesProcessed: 1 } });
    expect(JSON.parse(await readFile(join(responseDirectory, "sam-response.json"), "utf8")).response).toEqual(raw);
    await expect(segmentMetaImage(input, { responseDirectory, client: { requestJson } })).rejects.toMatchObject({ code: "SEGMENTATION_INVALID" });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  test("retains an uncertain request marker, never repeats it, and omits raw error text", async () => {
    const responseDirectory = await directory();
    const input = await source();
    const requestJson = vi.fn().mockRejectedValue(new MetaClientError("HTTP_ERROR", "secret-provider-body", { status: 429, outcome: "unknown" }));
    const failure = await segmentMetaImage(input, { responseDirectory, client: { requestJson } }).catch((error: unknown) => error);
    const diagnostic = getMetaSegmentationDiagnostic(failure);
    expect(diagnostic).toMatchObject({ phase: "request", code: "HTTP_ERROR", httpStatus: 429, completedResponseStored: false, usage: null });
    expect(JSON.stringify(diagnostic)).not.toContain("secret-provider-body");
    await expect(segmentMetaImage(input, { responseDirectory, client: { requestJson } })).rejects.toMatchObject({ code: "SEGMENTATION_PENDING" });
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(await readdir(responseDirectory)).toEqual(["sam-request.json"]);
  });

  test("rejects changed, symlinked and partial response files without making a new call", async () => {
    const input = await source();
    for (const damage of ["changed", "symlink", "partial"] as const) {
      const responseDirectory = await directory();
      const requestJson = vi.fn().mockResolvedValue(response());
      await segmentMetaImage(input, { responseDirectory, client: { requestJson } });
      const path = join(responseDirectory, "sam-response.json");
      if (damage === "changed") {
        const saved = JSON.parse(await readFile(path, "utf8")); saved.response.usage.images_processed = 55;
        await writeFile(path, JSON.stringify(saved));
      } else if (damage === "symlink") {
        await rename(path, join(responseDirectory, "another.json"));
        await symlink(join(responseDirectory, "another.json"), path);
      } else {
        await rm(path); await writeFile(join(responseDirectory, "sam-response.pending.json"), "{partial", { mode: 0o600 });
      }
      await expect(segmentMetaImage(input, { responseDirectory, client: { requestJson } })).rejects.toMatchObject({ code: "SEGMENTATION_CHECKPOINT_INVALID" });
      expect(requestJson).toHaveBeenCalledTimes(1);
    }
  });

  test("recovers fully written raw bytes after interruption before atomic publication", async () => {
    const responseDirectory = await directory(); const input = await source();
    const requestJson = vi.fn().mockResolvedValue(response());
    const result = await segmentMetaImage(input, { responseDirectory, client: { requestJson } });
    await rename(join(responseDirectory, "sam-response.json"), join(responseDirectory, "sam-response.pending.json"));
    expect(await segmentMetaImage(input, { responseDirectory, client: { requestJson } })).toEqual(result);
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  test("serializes concurrent attempts before invocation and does not require a client for offline recovery", async () => {
    const responseDirectory = await directory(); const input = await source();
    let release: (value: unknown) => void = () => undefined;
    const waiting = new Promise((resolve) => { release = resolve; });
    const requestJson = vi.fn().mockReturnValue(waiting);
    const attempts = [segmentMetaImage(input, { responseDirectory, client: { requestJson } }), segmentMetaImage(input, { responseDirectory, client: { requestJson } })];
    // Attach rejection handlers before releasing the one accepted provider call.
    const all = Promise.allSettled(attempts);
    await vi.waitFor(() => expect(requestJson).toHaveBeenCalledTimes(1));
    release(response());
    const outcomes = await all;
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(await recoverMetaSegmentationResponse(input, responseDirectory)).toMatchObject({ status: "no_match" });
    expect(await recoverMetaSegmentationResponse(input, await directory())).toBeNull();
  });
});
