import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { RequestError } from "../http";
import { CampaignApprovalSchema, type CampaignApproval, type CampaignKit } from "../research/contracts";

export const APPROVAL_STATEMENT = "I have reviewed these exact campaign files, their claims and the people, products and places they show. I approve them as campaign material for my business. Publishing, ad spend and messaging remain separate steps.";

/** Files the owner approves: every manifest entry except the archive and documents excluded by the export. */
export function approvableFiles(campaign: CampaignKit, withheld: readonly string[] = []) {
  const blocked = new Set(withheld);
  return campaign.assets
    .filter((asset) => !blocked.has(asset.filename))
    .map(({ filename, sha256, bytes }) => ({ filename, sha256, bytes }))
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

/** Canonical digest the UI shows and the owner must echo back, binding approval to exact bytes. */
export function manifestDigest(campaignId: string, files: ReturnType<typeof approvableFiles>): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, campaignId, files })).digest("hex");
}

/**
 * Re-hash every approvable file on disk before recording approval. A changed, missing or
 * replaced file blocks approval: an approval can never inherit from different bytes.
 */
export async function buildApproval(input: { runId: string; campaign: CampaignKit; manifestDigest: string; withheld?: readonly string[]; runsRoot?: string; now?: Date }): Promise<CampaignApproval> {
  const files = approvableFiles(input.campaign, input.withheld);
  if (!files.length) throw new RequestError("There are no campaign files to approve.", 409);
  const expected = manifestDigest(input.campaign.id, files);
  if (input.manifestDigest !== expected) throw new RequestError("The campaign changed since you reviewed it. Reload the kit and review the current files before approving.", 409);
  let directory: string;
  try {
    const root = await realpath(resolve(input.runsRoot ?? ".data/runs"));
    directory = await realpath(resolve(root, input.runId));
    if (!directory.startsWith(root + sep)) throw new Error("outside");
  } catch { throw new RequestError("The campaign files could not be located for approval.", 409); }
  for (const file of files) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(file.filename)) throw new RequestError("A campaign file name failed validation.", 409);
    const path = resolve(directory, file.filename);
    try {
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== file.bytes || !(await realpath(path)).startsWith(directory + sep)) throw new Error("changed");
      const bytes = await readFile(path);
      if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("changed");
    } catch { throw new RequestError("A campaign file changed or is missing. Approval was not recorded; regenerate or review the kit again.", 409); }
  }
  return CampaignApprovalSchema.parse({
    version: 1, campaignId: input.campaign.id, approvedAt: (input.now ?? new Date()).toISOString(), manifestDigest: expected,
    files, withheldFiles: [...(input.withheld ?? [])], statement: APPROVAL_STATEMENT, scope: "owner_approved_concept_not_published",
  });
}
