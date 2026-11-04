import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { ModelUsageSchema } from "../research/contracts";
import { hashBytes, safeOutputPath } from "./archive";

export const CompletedCopyResponseSchema = z.object({
  version: z.literal(1), status: z.literal("completed"), responseId: z.string().nullable(),
  model: z.string(), requestHash: z.string().regex(/^[a-f0-9]{64}$/), receivedAt: z.string().datetime(),
  usage: ModelUsageSchema, outputText: z.string().max(200_000),
}).strict().refine((response) => response.model === response.usage.model, "Response metering must match its model.");
export type CompletedCopyResponse = z.infer<typeof CompletedCopyResponseSchema>;
const recordSchema = z.object({ inputHash: z.string().regex(/^[a-f0-9]{64}$/), response: CompletedCopyResponseSchema, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export class CampaignCopyValidationError extends Error {
  readonly retrySafe = true;
  readonly completedResponseStored = true;
  constructor() {
    super("Meta completed the campaign response, but validation did not pass. The input-bound response is saved; a local validation retry will not request paid copy again.");
    this.name = "CampaignCopyValidationError";
  }
}

/** Save only completed response text and metering, never headers, keys or request secrets. */
export async function writeCompletedCopyRecord(directory: string, inputHash: string, response: CompletedCopyResponse): Promise<void> {
  const payload = { inputHash, response: CompletedCopyResponseSchema.parse(response) };
  const contentHash = hashBytes(Buffer.from(JSON.stringify(payload)));
  const record = recordSchema.parse({ ...payload, contentHash });
  await mkdir(directory, { recursive: true });
  const target = safeOutputPath(directory, "copy-response.json");
  // A completed response is immutable. Do not replace it with a later attempt.
  const existing = await readCompletedCopyRecord(directory, inputHash);
  if (existing) {
    if (hashBytes(Buffer.from(JSON.stringify({ inputHash, response: existing }))) !== contentHash) throw new Error("A completed campaign response already exists for this run.");
    return;
  }
  const pending = safeOutputPath(directory, "copy-response.pending.json");
  await writeFile(pending, JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
  await rename(pending, target);
}

/** Missing means no stored response; malformed, changed or wrong-input data always fails closed. */
export async function readCompletedCopyRecord(directory: string, inputHash: string): Promise<CompletedCopyResponse | null> {
  let bytes: string;
  try { bytes = await readFile(safeOutputPath(directory, "copy-response.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The completed campaign response could not be read safely.");
    // A process may stop after persisting completed bytes but before the final rename.
    // That uncertainty must not turn into permission for a replacement paid request.
    const pending = await readFile(safeOutputPath(directory, "copy-response.pending.json")).then(() => true).catch((pendingError: NodeJS.ErrnoException) => {
      if (pendingError.code === "ENOENT") return false;
      throw new Error("The pending campaign response could not be read safely.");
    });
    if (pending) throw new Error("A completed campaign response is pending recovery. No replacement copy request is allowed.");
    return null;
  }
  try {
    const record = recordSchema.parse(JSON.parse(bytes));
    const actualHash = hashBytes(Buffer.from(JSON.stringify({ inputHash: record.inputHash, response: record.response })));
    if (record.inputHash !== inputHash || record.contentHash !== actualHash) throw new Error("Binding mismatch");
    return record.response;
  } catch { throw new Error("The completed campaign response failed its input or integrity check. No replacement copy request is allowed."); }
}
