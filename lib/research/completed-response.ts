import { constants, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ModelUsageSchema } from "./contracts";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const CompletedAnalysisResponseSchema = z.object({
  version: z.literal(1), status: z.literal("completed"), responseId: z.string().max(200).nullable(),
  model: z.string().min(1).max(200), requestHash: sha256, receivedAt: z.string().datetime(),
  analysisDate: z.string().datetime(), usage: ModelUsageSchema, outputText: z.string().max(200_000),
}).strict().refine((response) => response.model === response.usage.model, "Response metering must match its model.");
export type CompletedAnalysisResponse = z.infer<typeof CompletedAnalysisResponseSchema>;

const recordSchema = z.object({ inputHash: sha256, response: CompletedAnalysisResponseSchema, contentHash: sha256 }).strict();
const targetName = "analysis-response.json";
const pendingName = "analysis-response.pending.json";
const maximumRecordBytes = 1_000_000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class AnalysisValidationError extends Error {
  readonly retrySafe = true;
  readonly completedResponseStored = true;
  constructor() {
    super("Meta completed the analysis response, but validation did not pass. The input-bound response is saved; a local validation retry will not request paid analysis again.");
    this.name = "AnalysisValidationError";
  }
}

function paths(directory: string) {
  const root = resolve(directory);
  return { root, target: join(root, targetName), pending: join(root, pendingName) };
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

async function pendingExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (missing(error)) return false;
    throw new Error("The pending analysis response could not be read safely.");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Store completed text and metering privately; no request headers or credentials belong here. */
export async function writeCompletedAnalysisRecord(directory: string, inputHash: string, response: CompletedAnalysisResponse): Promise<void> {
  const payload = { inputHash: sha256.parse(inputHash), response: CompletedAnalysisResponseSchema.parse(response) };
  const contentHash = digest(payload);
  const record = recordSchema.parse({ ...payload, contentHash });
  const { root, target, pending } = paths(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const existing = await readCompletedAnalysisRecord(root, inputHash);
  if (existing) {
    if (digest({ inputHash, response: existing }) !== contentHash) throw new Error("A completed analysis response already exists for this run.");
    return;
  }

  // Exclusive pending creation serializes writers and retains crash evidence.
  const file = await open(pending, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(record, null, 2));
    await file.sync();
  } finally { await file.close(); }
  await syncDirectory(root);

  // Atomic publication without replacement: rename could overwrite a record written
  // after the initial read. A same-directory hard link fails if the target exists.
  try { await link(pending, target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = await readCompletedAnalysisRecord(root, inputHash);
    if (!winner || digest({ inputHash, response: winner }) !== contentHash) {
      throw new Error("A completed analysis response already exists for this run.");
    }
  }
  await syncDirectory(root);
  await unlink(pending);
  await syncDirectory(root);
}

/** Missing is distinct from unreadable, pending, malformed or differently bound data. */
export async function readCompletedAnalysisRecord(directory: string, inputHash: string): Promise<CompletedAnalysisResponse | null> {
  sha256.parse(inputHash);
  const { target, pending } = paths(directory);
  let file;
  try { file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (!missing(error)) throw new Error("The completed analysis response could not be read safely.");
    if (await pendingExists(pending)) throw new Error("A completed analysis response is pending recovery. No replacement analysis request is allowed.");
    return null;
  }

  let bytes: string;
  try {
    const metadata: Stats = await file.stat();
    if (!metadata.isFile() || metadata.size > maximumRecordBytes) throw new Error("Invalid record file");
    bytes = await file.readFile("utf8");
  } catch { throw new Error("The completed analysis response could not be read safely."); }
  finally { await file.close(); }

  try {
    const record = recordSchema.parse(JSON.parse(bytes));
    if (record.inputHash !== inputHash || record.contentHash !== digest({ inputHash: record.inputHash, response: record.response })) {
      throw new Error("Binding mismatch");
    }
    return record.response;
  } catch { throw new Error("The completed analysis response failed its input or integrity check. No replacement analysis request is allowed."); }
}
