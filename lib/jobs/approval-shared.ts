import type { CampaignKit } from "../research/contracts";

/**
 * Client-safe approval helpers (no Node imports) shared by the server's approval binding
 * and the Autopilot UI, so the statement and file set the owner sees cannot drift.
 */
export const APPROVAL_STATEMENT = "I have reviewed these exact campaign files, their claims and the people, products and places they show. I approve them as campaign material for my business. Publishing, ad spend and messaging remain separate steps.";

/**
 * Files the owner approves: every manifest entry (including the ZIP, whose exact bytes are
 * also bound) except files the quality record withheld. Sorted for a canonical digest.
 */
export function approvableFiles(campaign: Pick<CampaignKit, "assets">, withheld: readonly string[] = []) {
  const blocked = new Set(withheld);
  return campaign.assets
    .filter((asset) => !blocked.has(asset.filename))
    .map(({ filename, sha256, bytes }) => ({ filename, sha256, bytes }))
    .sort((a, b) => a.filename.localeCompare(b.filename));
}
