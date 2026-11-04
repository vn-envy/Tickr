import { z } from "zod";
import type { CreateCampaignInput } from "../campaign/index";
import type { CampaignKit, ModelUsage } from "../research/contracts";
import type { AutopilotBudget } from "./budget";

/** Input to the one-shot Autopilot production stage (runs inside the durable worker lease). */
export interface AutopilotProductionInput extends Omit<CreateCampaignInput, "reserveAdditionalModelCall" | "image"> {
  runId: string;
  /** The owner's campaign goal (DATA, never instructions). */
  goal: string;
  budget: AutopilotBudget;
  /** Business-level private media library (owner uploads), e.g. .data/businesses/<id>/media. */
  businessMediaDir: string;
  /** Business-level owner connection store directory, e.g. .data/connections. */
  connectionsDir: string;
  /** Appends a visible "director's log" event to the run. */
  progress: (stage: string, message: string) => Promise<void>;
  /** True once the worker lost its lease; stop before any further paid request. */
  leaseLost: () => boolean;
}

export const AutopilotQualitySchema = z.object({
  version: z.literal(1),
  planVersion: z.string(),
  reelMode: z.enum(["tracked_video", "still_depth", "illustration", "legacy"]),
  mediaAnalyzed: z.number().int().nonnegative(),
  mediaExcluded: z.number().int().nonnegative(),
  criticVerdict: z.enum(["no_blocking_findings", "blocking_findings", "not_run"]),
  findings: z.number().int().nonnegative(),
  fixesApplied: z.array(z.string().max(300)).max(40),
  withheldFiles: z.array(z.string().max(160)).max(80),
  roleCounts: z.record(z.string(), z.number().int().nonnegative()),
  notes: z.array(z.string().max(600)).max(30),
}).strict();
export type AutopilotQuality = z.infer<typeof AutopilotQualitySchema>;

export interface AutopilotProductionResult {
  campaign: CampaignKit;
  usage: ModelUsage;
  additionalUsage: ModelUsage[];
  quality: AutopilotQuality;
}

/**
 * Thrown when local work failed after every paid step had either completed and been stored,
 * or never started. A retry reuses stored responses and checkpoints without new paid requests
 * for completed steps; uncertain (requested but unstored) steps still fail closed.
 */
export class AutopilotResumableError extends Error {
  readonly retrySafe = true;
  constructor(message = "Autopilot saved every completed Meta response, but local production did not finish. A retry reuses those saved results without repeating completed paid requests.") {
    super(message);
    this.name = "AutopilotResumableError";
  }
}
