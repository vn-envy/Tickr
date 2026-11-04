import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AutopilotRole } from "./contracts";

/**
 * Per-role request caps for the Autopilot production stage. The run-level ceiling in the job
 * store (AUTOPILOT_MODEL_CALL_LIMIT) still applies on top. Every reservation is persisted
 * BEFORE the store reservation and the paid call, so a crash can only over-count (conservative).
 * List prices (dated, 2026-11-04) are informational; actual usage is recorded per call.
 */
export const AUTOPILOT_ROLE_CAPS: Readonly<Record<AutopilotRole, number>> = Object.freeze({
  spark_copy: 1, spark_media: 3, spark_shotlog: 2, sam_image: 8, sam_video: 2, muse_image: 2, spark_critic: 2,
});

const ledgerSchema = z.object({ version: z.literal(1), counts: z.record(z.string(), z.number().int().nonnegative()) }).strict();

export class AutopilotBudgetError extends Error {
  constructor(readonly role: AutopilotRole) {
    super(`The Autopilot ${role.replaceAll("_", " ")} request budget is exhausted for this run; the step was skipped without a paid request.`);
    this.name = "AutopilotBudgetError";
  }
}

export interface AutopilotBudget {
  remaining(role: AutopilotRole): Promise<number>;
  /** Persist a role reservation, then reserve one run-level call. Throws AutopilotBudgetError when exhausted. */
  reserve(role: AutopilotRole): Promise<void>;
  counts(): Promise<Record<AutopilotRole, number>>;
}

export function createAutopilotBudget(directory: string, reserveRunCall: () => Promise<void>, caps: Readonly<Record<AutopilotRole, number>> = AUTOPILOT_ROLE_CAPS): AutopilotBudget {
  const path = join(directory, "autopilot-budget.json");
  let queue = Promise.resolve();
  const read = async (): Promise<Record<string, number>> => {
    try { return ledgerSchema.parse(JSON.parse(await readFile(path, "utf8"))).counts; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("The Autopilot budget ledger failed validation. No paid request was made.");
    }
  };
  const write = async (counts: Record<string, number>) => {
    await mkdir(directory, { recursive: true });
    const pending = `${path}.pending`;
    await writeFile(pending, JSON.stringify({ version: 1, counts }), { mode: 0o600 });
    await rename(pending, path);
  };
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  return {
    remaining: (role) => serialized(async () => Math.max(0, caps[role] - ((await read())[role] ?? 0))),
    reserve: (role) => serialized(async () => {
      const counts = await read();
      if ((counts[role] ?? 0) >= caps[role]) throw new AutopilotBudgetError(role);
      counts[role] = (counts[role] ?? 0) + 1;
      await write(counts);
      await reserveRunCall();
    }),
    counts: () => serialized(async () => {
      const counts = await read();
      return Object.fromEntries(Object.keys(caps).map((role) => [role, counts[role] ?? 0])) as Record<AutopilotRole, number>;
    }),
  };
}
