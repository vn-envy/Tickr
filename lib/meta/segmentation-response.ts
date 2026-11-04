import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { MetaClientError } from "./config";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const markerSchema = z.object({ version: z.literal(1), inputHash: hashSchema, requestedAt: z.string().datetime() }).strict();
const payloadSchema = z.object({ version: z.literal(1), inputHash: hashSchema, receivedAt: z.string().datetime(), elapsedMs: z.number().int().nonnegative(), response: z.unknown() }).strict();
const recordSchema = payloadSchema.extend({ contentHash: hashSchema });
export type StoredSegmentationResponse = z.infer<typeof payloadSchema>;
const maxRecordBytes = 9 * 1024 * 1024;

function failure(code = "SEGMENTATION_CHECKPOINT_INVALID") {
  return new MetaClientError(code, code === "SEGMENTATION_PENDING"
    ? "A previous SAM request has an uncertain outcome. No replacement request is allowed."
    : "The saved SAM response failed its input or integrity check. No replacement request is allowed.", { outcome: "unknown" });
}
function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function paths(directory: string) {
  const root = resolve(directory);
  return { root, marker: join(root, "sam-request.json"), target: join(root, "sam-response.json"), pending: join(root, "sam-response.pending.json") };
}
async function checkDirectory(path: string, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  try { if (!(await lstat(path)).isDirectory()) throw failure(); }
  catch (error) { if (!create && missing(error)) return; throw failure(); }
}
async function readBounded(path: string, maximum: number): Promise<string | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return null; throw failure(); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw failure();
    const bytes = await file.readFile();
    if (bytes.length > maximum) throw failure();
    return bytes.toString("utf8");
  } finally { await file.close(); }
}
async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function writeExclusive(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
}

/** Null means no prior attempt. A pending/corrupt attempt never permits another paid call. */
export async function readStoredSegmentationResponse(directory: string, inputHash: string): Promise<StoredSegmentationResponse | null> {
  hashSchema.parse(inputHash);
  const { root, marker, target, pending } = paths(directory);
  await checkDirectory(root);
  const markerText = await readBounded(marker, 4096);
  if (markerText !== null) {
    try { if (markerSchema.parse(JSON.parse(markerText)).inputHash !== inputHash) throw failure(); }
    catch { throw failure(); }
  }
  // A complete, input-bound temporary record can also be recovered offline after
  // a process stopped between fsync and publication. Partial records fail closed.
  const bytes = await readBounded(target, maxRecordBytes) ?? await readBounded(pending, maxRecordBytes);
  if (bytes === null) {
    if (markerText !== null) throw failure("SEGMENTATION_PENDING");
    return null;
  }
  try {
    const record = recordSchema.parse(JSON.parse(bytes));
    const { contentHash, ...payload } = record;
    if (!markerText || record.inputHash !== inputHash || contentHash !== digest(payload)) throw failure();
    return payload;
  } catch { throw failure(); }
}

/** Exclusive creation is the concurrency guard, before sending any request. */
export async function markSegmentationRequested(directory: string, inputHash: string): Promise<void> {
  const { root, marker } = paths(directory);
  await checkDirectory(root, true);
  try {
    await writeExclusive(marker, markerSchema.parse({ version: 1, inputHash, requestedAt: new Date().toISOString() }));
    await syncDirectory(root);
  } catch { throw failure("SEGMENTATION_PENDING"); }
}

/** Raw provider JSON and metering only: no request image, headers or credentials. */
export async function storeSegmentationResponse(directory: string, payload: StoredSegmentationResponse): Promise<void> {
  const validated = payloadSchema.parse(payload);
  const record = { ...validated, contentHash: digest(validated) };
  if (Buffer.byteLength(JSON.stringify(record)) > maxRecordBytes) throw failure();
  const { root, target, pending } = paths(directory);
  await checkDirectory(root);
  try {
    await writeExclusive(pending, record);
    await syncDirectory(root);
    // A same-directory link publishes atomically and cannot overwrite a winner.
    await link(pending, target);
    await syncDirectory(root);
    await unlink(pending);
    await syncDirectory(root);
  } catch { throw failure(); }
}
