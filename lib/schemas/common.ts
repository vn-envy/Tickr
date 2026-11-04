import { z } from "zod";

export const IdSchema = z.string().trim().min(1).max(128);
export const TimestampSchema = z.string().datetime({ offset: true });
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 digest");
// Historical name retained for saved artifacts; categories are descriptive data, not a closed product list.
export const VerticalSchema = z.string().trim().min(1).max(100).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Use a single-line business category.");
export type Vertical = z.infer<typeof VerticalSchema>;

export const ChannelSchema = z.enum([
  "facebook_ads",
  "instagram_feed",
  "instagram_carousel",
  "instagram_stories",
  "instagram_reels",
  "click_to_whatsapp",
  "whatsapp_status",
]);
export type Channel = z.infer<typeof ChannelSchema>;

export const OwnerApprovalSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({
    status: z.literal("approved"),
    approvedBy: IdSchema,
    approvedAt: TimestampSchema,
    claim: z.string().trim().min(1),
  }).strict(),
  z.object({
    status: z.literal("rejected"),
    reviewedBy: IdSchema,
    reviewedAt: TimestampSchema,
  }).strict(),
]);
export type OwnerApproval = z.infer<typeof OwnerApprovalSchema>;

export const SourceSchema = z.object({
  id: IdSchema,
  type: z.enum(["official_website", "meta_retrieval", "owner_upload", "owner_statement", "review"]),
  url: z.string().url().refine((value) => /^https?:\/\//i.test(value), "Expected an HTTP(S) citation").optional(),
  assetId: IdSchema.optional(),
  excerpt: z.string().trim().min(1).optional(),
  retrievedAt: TimestampSchema,
  publishedAt: TimestampSchema.optional(),
  acquisition: z.enum(["owner_supplied", "meta_retrieval", "direct_website"]),
}).strict().refine((source) => Boolean(source.excerpt || source.assetId), {
  message: "A source needs a supporting excerpt or asset, not just a URL",
});
export type Source = z.infer<typeof SourceSchema>;
