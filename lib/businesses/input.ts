import { z } from "zod";
import { VerticalSchema } from "../schemas/common";

const website = z.string().trim().max(2048).refine((value) => {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
}, "Use an HTTP(S) URL without embedded credentials.");

export const DEFAULT_CAMPAIGN_GOAL = "Find the business's strongest supported opportunity and create a campaign that encourages qualified inquiries.";

const optionalDetail = (limit: number) => z.string().trim().max(limit).optional().default("").refine((value) => !value || value.length >= 2, "Use at least two characters when supplying a detail.");

export const BusinessDraftInput = z.object({
  name: optionalDetail(120),
  website: website.optional().transform((value) => value || null),
  locality: optionalDetail(160),
  // An unresolved category stays generic; it must not inherit another industry's capabilities.
  vertical: VerticalSchema.optional().default("business"),
  goal: z.string().trim().max(2000).optional().transform((value) => value || DEFAULT_CAMPAIGN_GOAL).refine((value) => value.length >= 5, "Use at least five characters for the campaign goal."),
}).strict().superRefine((input, context) => {
  if (!input.website && (!input.name || !input.locality)) {
    context.addIssue({ code: "custom", path: ["website"], message: "Provide a business link, or a business name and locality for manual intake." });
  }
});
