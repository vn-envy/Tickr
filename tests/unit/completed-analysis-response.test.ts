import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  AnalysisValidationError, CompletedAnalysisResponseSchema, readCompletedAnalysisRecord, writeCompletedAnalysisRecord,
  type CompletedAnalysisResponse,
} from "../../lib/research/completed-response";

const directories: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const inputHash = hash("synthetic immutable analysis inputs");
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "tickr-analysis-response-"));
  directories.push(path);
  return path;
}
function response(): CompletedAnalysisResponse {
  return {
    version: 1, status: "completed", responseId: "synthetic-response-id", model: "muse-spark-1.3",
    requestHash: hash("synthetic request including original currentDate"),
    analysisDate: "2026-11-01T23:59:58.000Z", receivedAt: "2026-11-02T00:00:03.000Z",
    usage: { model: "muse-spark-1.3", inputTokens: 19, outputTokens: 31, elapsedMs: 5000 },
    outputText: '{"synthetic":"fixture only","unvalidated":true}',
  };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("completed analysis response storage", () => {
  test("replays exact private completed bytes, original analysis date and metering without replacing them", async () => {
    const path = await directory();
    expect(await readCompletedAnalysisRecord(path, inputHash)).toBeNull();
    const original = response();
    await writeCompletedAnalysisRecord(path, inputHash, original);
    const bytes = await readFile(join(path, "analysis-response.json"), "utf8");
    expect(await readCompletedAnalysisRecord(path, inputHash)).toEqual(original);
    expect((await stat(join(path, "analysis-response.json"))).mode & 0o777).toBe(0o600);
    await writeCompletedAnalysisRecord(path, inputHash, original);
    expect(await readFile(join(path, "analysis-response.json"), "utf8")).toBe(bytes);
    await expect(writeCompletedAnalysisRecord(path, inputHash, { ...original, outputText: "replacement" })).rejects.toThrow("already exists");
    expect(await readCompletedAnalysisRecord(path, inputHash)).toEqual(original);
  });

  test("fails closed for changed inputs, response bytes and malformed data", async () => {
    const path = await directory();
    await writeCompletedAnalysisRecord(path, inputHash, response());
    await expect(readCompletedAnalysisRecord(path, hash("different inputs"))).rejects.toThrow("input or integrity");
    const record = JSON.parse(await readFile(join(path, "analysis-response.json"), "utf8"));
    record.response.outputText = "altered after completion";
    await writeFile(join(path, "analysis-response.json"), JSON.stringify(record));
    await expect(readCompletedAnalysisRecord(path, inputHash)).rejects.toThrow("input or integrity");
    await writeFile(join(path, "analysis-response.json"), "{malformed");
    await expect(readCompletedAnalysisRecord(path, inputHash)).rejects.toThrow("No replacement analysis request");
  });

  test("pending completed bytes forbid a replacement request and symlink records are not followed", async () => {
    const path = await directory();
    await writeFile(join(path, "analysis-response.pending.json"), "partially persisted completion", { mode: 0o600 });
    await expect(readCompletedAnalysisRecord(path, inputHash)).rejects.toThrow("pending recovery");
    await expect(writeCompletedAnalysisRecord(path, inputHash, response())).rejects.toThrow("pending recovery");
    await rm(join(path, "analysis-response.pending.json"));
    await writeFile(join(path, "other.json"), "unrelated private material");
    await symlink(join(path, "other.json"), join(path, "analysis-response.json"));
    await expect(readCompletedAnalysisRecord(path, inputHash)).rejects.toThrow("could not be read safely");
  });

  test("concurrent different completions cannot overwrite the first published record", async () => {
    const path = await directory();
    const first = response();
    const second = { ...first, responseId: "other-completion", outputText: "different completion" };
    const writes = await Promise.allSettled([
      writeCompletedAnalysisRecord(path, inputHash, first), writeCompletedAnalysisRecord(path, inputHash, second),
    ]);
    expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
    const winner = await readCompletedAnalysisRecord(path, inputHash);
    expect([first.outputText, second.outputText]).toContain(winner?.outputText);
    await expect(writeCompletedAnalysisRecord(path, inputHash, winner?.outputText === first.outputText ? second : first)).rejects.toThrow("already exists");
    expect(await readCompletedAnalysisRecord(path, inputHash)).toEqual(winner);
  });

  test("validates completed status, bounded text, matching model and secret-free metadata before storage", async () => {
    const original = response();
    expect(CompletedAnalysisResponseSchema.safeParse({ ...original, status: "incomplete" }).success).toBe(false);
    expect(CompletedAnalysisResponseSchema.safeParse({ ...original, outputText: "x".repeat(200_001) }).success).toBe(false);
    expect(CompletedAnalysisResponseSchema.safeParse({ ...original, usage: { ...original.usage, model: "different-model" } }).success).toBe(false);
    expect(CompletedAnalysisResponseSchema.safeParse({ ...original, headers: { Authorization: "should-never-be-stored" } }).success).toBe(false);
    const path = await directory();
    await expect(writeCompletedAnalysisRecord(path, "invalid-hash", original)).rejects.toThrow();
    expect(await readCompletedAnalysisRecord(path, inputHash)).toBeNull();
    const error = new AnalysisValidationError();
    expect(error).toMatchObject({ name: "AnalysisValidationError", retrySafe: true, completedResponseStored: true });
    expect(error.message).toContain("will not request paid analysis again");
  });
});
