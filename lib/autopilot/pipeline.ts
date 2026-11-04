import type { AutopilotProductionInput, AutopilotProductionResult } from "./production-types";

/** Placeholder until the production pipeline lands; it never makes a paid request. */
export async function produceAutopilotCampaign(input: AutopilotProductionInput): Promise<AutopilotProductionResult> {
  void input;
  throw new Error("Autopilot production is not available in this build. No Meta request was made.");
}
