import { z } from "zod";
import { IdSchema, Sha256Schema, TimestampSchema } from "../schemas/common";

export const RunStageSchema = z.enum([
  "created", "ingesting", "researching", "proposing", "awaiting_owner", "awaiting_selection",
  "creating", "checking", "ready", "needs_review", "failed", "cancelled", "interrupted",
]);
export type RunStage = z.infer<typeof RunStageSchema>;

export const CheckpointSchema = z.object({
  stage: z.enum(["ingesting", "researching", "proposing", "creating", "checking"]),
  artifactId: IdSchema,
  artifactHash: Sha256Schema,
  completedAt: TimestampSchema,
}).strict();
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const RunStateSchema = z.object({
  id: IdSchema,
  stage: RunStageSchema,
  updatedAt: TimestampSchema,
  checkpoints: z.array(CheckpointSchema),
  interruptedFrom: RunStageSchema.optional(),
  reason: z.string().trim().min(1).optional(),
}).strict();
export type RunState = z.infer<typeof RunStateSchema>;

const TRANSITIONS: Readonly<Record<RunStage, readonly RunStage[]>> = {
  created: ["ingesting", "cancelled"],
  ingesting: ["researching", "awaiting_owner", "failed", "cancelled", "interrupted"],
  researching: ["proposing", "awaiting_owner", "failed", "cancelled", "interrupted"],
  proposing: ["awaiting_owner", "awaiting_selection", "failed", "cancelled", "interrupted"],
  awaiting_owner: ["researching", "proposing", "awaiting_selection", "creating", "checking", "cancelled", "interrupted"],
  awaiting_selection: ["awaiting_owner", "creating", "cancelled", "interrupted"],
  creating: ["checking", "awaiting_owner", "failed", "cancelled", "interrupted"],
  checking: ["ready", "needs_review", "creating", "awaiting_owner", "failed", "cancelled", "interrupted"],
  ready: ["creating"],
  needs_review: ["creating", "awaiting_owner", "cancelled"],
  failed: ["cancelled"],
  cancelled: [],
  // Actual resume targets are checked against interruptedFrom below.
  interrupted: ["ingesting", "researching", "proposing", "awaiting_owner", "awaiting_selection", "creating", "checking", "cancelled"],
};

export function createRunState(id: string, at: string): RunState {
  return RunStateSchema.parse({ id, stage: "created", updatedAt: at, checkpoints: [] });
}

export function canTransitionRun(state: RunState, nextStage: RunStage): boolean {
  if (!TRANSITIONS[state.stage].includes(nextStage)) return false;
  return state.stage !== "interrupted" || nextStage === "cancelled" || nextStage === state.interruptedFrom;
}

/** Pure state transition. It does not execute tasks, approve assets or repeat requests. */
export function transitionRun(state: RunState, nextStage: RunStage, options: { at: string; reason?: string }): RunState {
  const current = RunStateSchema.parse(state);
  const next = RunStageSchema.parse(nextStage);
  if (!canTransitionRun(current, next)) {
    throw new Error(`Illegal run transition: ${current.stage} → ${next}`);
  }
  if (["failed", "interrupted", "needs_review"].includes(next) && !options.reason?.trim()) {
    throw new Error(`A reason is required when entering ${next}`);
  }
  TimestampSchema.parse(options.at);
  if (Date.parse(options.at) < Date.parse(current.updatedAt)) {
    throw new Error("Run updates cannot move backwards in time");
  }
  return RunStateSchema.parse({
    ...current,
    stage: next,
    updatedAt: options.at,
    reason: options.reason,
    interruptedFrom: next === "interrupted" ? current.stage : undefined,
  });
}

/** A checkpoint records an artifact; the caller must persist it before advancing. */
export function checkpointRun(state: RunState, checkpoint: Checkpoint): RunState {
  const current = RunStateSchema.parse(state);
  const completed = CheckpointSchema.parse(checkpoint);
  if (current.stage !== completed.stage) {
    throw new Error("A checkpoint must belong to the current stage");
  }
  if (Date.parse(completed.completedAt) < Date.parse(current.updatedAt)) {
    throw new Error("A checkpoint cannot predate the current stage");
  }
  const existing = current.checkpoints.find((item) => item.artifactId === completed.artifactId);
  if (existing) {
    if (existing.stage !== completed.stage || existing.artifactHash !== completed.artifactHash) {
      throw new Error("A checkpoint artifact is immutable; use a new artifact ID for revisions");
    }
    return current;
  }
  return RunStateSchema.parse({
    ...current,
    updatedAt: completed.completedAt,
    checkpoints: [...current.checkpoints, completed],
  });
}
