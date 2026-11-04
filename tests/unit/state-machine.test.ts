import { describe, expect, it } from "vitest";
import { checkpointRun, createRunState, transitionRun } from "../../lib/agents/state-machine";

const at = "2026-11-01T09:00:00Z";

describe("run state machine", () => {
  it("rejects skipped stages and terminal-state revival", () => {
    const initial = createRunState("run_1", at);
    expect(() => transitionRun(initial, "ready", { at })).toThrow("Illegal run transition");
    const cancelled = transitionRun(initial, "cancelled", { at });
    expect(() => transitionRun(cancelled, "ingesting", { at })).toThrow("Illegal run transition");
    expect(initial.stage).toBe("created");
  });

  it("retains immutable checkpoints across interruption and explicit resume", () => {
    const ingesting = transitionRun(createRunState("run_1", at), "ingesting", { at });
    const checkpoint = { stage: "ingesting" as const, artifactId: "profile_1", artifactHash: "a".repeat(64), completedAt: at };
    const saved = checkpointRun(ingesting, checkpoint);
    expect(ingesting.checkpoints).toHaveLength(0);
    expect(checkpointRun(saved, checkpoint).checkpoints).toHaveLength(1);
    expect(() => checkpointRun(saved, { ...checkpoint, artifactHash: "b".repeat(64) })).toThrow("immutable");
    const researching = transitionRun(saved, "researching", { at });
    const interrupted = transitionRun(researching, "interrupted", { at, reason: "Worker restarted" });
    expect(() => transitionRun(interrupted, "creating", { at })).toThrow("Illegal run transition");
    const resumed = transitionRun(interrupted, "researching", { at });
    expect(resumed.checkpoints).toEqual([checkpoint]);
  });
});
