import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { MetaClientError } from "./config";

/**
 * Input-bound storage for paid Meta responses, shared by every paid adapter.
 *
 * Protocol (unchanged from the original SAM adapter):
 * 1. `mark` writes an exclusive "requested" marker bound to the input hash BEFORE the paid call.
 * 2. `store` publishes the completed raw provider JSON atomically (pending file → hard link → unlink).
 * 3. `read` returns null only when no attempt exists. A marker without a response (uncertain outcome),
 *    a mismatched input or a corrupt record throws — none of these ever authorizes another paid call.
 *
 * Records hold raw provider JSON and metering only: never request media, headers or credentials.
 */
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const markerSchema = z.object({ version: z.literal(1), inputHash: hashSchema, requestedAt: z.string().datetime() }).strict();
const payloadSchema = z.object({ version: z.literal(1), inputHash: hashSchema, receivedAt: z.string().datetime(), elapsedMs: z.number().int().nonnegative(), response: z.unknown() }).strict();
const recordSchema = payloadSchema.extend({ contentHash: hashSchema });
export type StoredPaidResponse = z.infer<typeof payloadSchema>;

export interface PaidResponseStoreOptions {
  /** File prefix, e.g. "sam" → sam-request.json / sam-response.json. Lowercase letters, digits and dashes. */
  prefix: string;
  /** Maximum serialized record size. */
  maxRecordBytes: number;
  /** Error code family, e.g. "SEGMENTATION" → SEGMENTATION_PENDING / SEGMENTATION_CHECKPOINT_INVALID. */
  errorFamily: string;
  /** Short human noun used in fixed error messages, e.g. "SAM". */
  label: string;
}

export interface PaidResponseStore {
  read(directory: string, inputHash: string): Promise<StoredPaidResponse | null>;
  mark(directory: string, inputHash: string): Promise<void>;
  store(directory: string, payload: StoredPaidResponse): Promise<void>;
}

function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}

async function writeExclusive(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
}

export function createPaidResponseStore(options: PaidResponseStoreOptions): PaidResponseStore {
  if (!/^[a-z0-9-]{1,40}$/.test(options.prefix) || !/^[A-Z_]{1,40}$/.test(options.errorFamily)
    || !Number.isSafeInteger(options.maxRecordBytes) || options.maxRecordBytes < 1024 || options.maxRecordBytes > 64 * 1024 * 1024) {
    throw new Error("Invalid paid-response store configuration.");
  }
  const failure = (pending = false) => new MetaClientError(pending ? `${options.errorFamily}_PENDING` : `${options.errorFamily}_CHECKPOINT_INVALID`, pending
    ? `A previous ${options.label} request has an uncertain outcome. No replacement request is allowed.`
    : `The saved ${options.label} response failed its input or integrity check. No replacement request is allowed.`, { outcome: "unknown" });
  const paths = (directory: string) => {
    const root = resolve(directory);
    return { root, marker: join(root, `${options.prefix}-request.json`), target: join(root, `${options.prefix}-response.json`), pending: join(root, `${options.prefix}-response.pending.json`) };
  };
  const checkDirectory = async (path: string, create = false) => {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    try { if (!(await lstat(path)).isDirectory()) throw failure(); }
    catch (error) { if (!create && missing(error)) return; throw failure(); }
  };
  const readBounded = async (path: string, maximum: number): Promise<string | null> => {
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
  };
  return {
    async read(directory, inputHash) {
      hashSchema.parse(inputHash);
      const { root, marker, target, pending } = paths(directory);
      await checkDirectory(root);
      const markerText = await readBounded(marker, 4096);
      if (markerText !== null) {
        try { if (markerSchema.parse(JSON.parse(markerText)).inputHash !== inputHash) throw failure(); }
        catch { throw failure(); }
      }
      // A complete, input-bound temporary record can also be recovered offline after a
      // process stopped between fsync and publication. Partial records fail closed.
      const bytes = await readBounded(target, options.maxRecordBytes) ?? await readBounded(pending, options.maxRecordBytes);
      if (bytes === null) {
        if (markerText !== null) throw failure(true);
        return null;
      }
      try {
        const record = recordSchema.parse(JSON.parse(bytes));
        const { contentHash, ...payload } = record;
        if (!markerText || record.inputHash !== inputHash || contentHash !== digest(payload)) throw failure();
        return payload;
      } catch { throw failure(); }
    },
    async mark(directory, inputHash) {
      const { root, marker } = paths(directory);
      await checkDirectory(root, true);
      try {
        await writeExclusive(marker, markerSchema.parse({ version: 1, inputHash, requestedAt: new Date().toISOString() }));
        await syncDirectory(root);
      } catch { throw failure(true); }
    },
    async store(directory, payload) {
      const validated = payloadSchema.parse(payload);
      const record = { ...validated, contentHash: digest(validated) };
      if (Buffer.byteLength(JSON.stringify(record)) > options.maxRecordBytes) throw failure();
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
    },
  };
}
