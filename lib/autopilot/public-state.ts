import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";

/**
 * The Autopilot "director's room": a progressively updated, owner-visible view of what the
 * engine is doing (harvested media, Spark observations, plan, SAM previews, critic findings).
 * Only derived previews (thumbnails, mask previews, overlay videos) are listed as servable
 * files; private originals, raw provider responses and credentials never appear here.
 */
export const PUBLIC_DIR = "autopilot-public";
const filename = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/).refine((value) => !value.includes(".."));
const box = z.object({ x1: z.number().int(), y1: z.number().int(), x2: z.number().int(), y2: z.number().int() }).strict();
const phase = z.enum(["harvest", "analyze", "direct", "copy", "segment", "track", "render", "critique", "export", "done", "failed"]);

export const AutopilotPublicStateSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1).max(64),
  updatedAt: z.string().datetime(),
  phase,
  headline: z.string().max(300),
  sources: z.object({ officialWebsite: z.number().int().nonnegative(), ownerUploads: z.number().int().nonnegative(), ownerInstagram: z.number().int().nonnegative(), ownerFacebook: z.number().int().nonnegative(), connected: z.boolean() }).strict(),
  media: z.array(z.object({
    assetId: z.string().max(80), kind: z.enum(["image", "video"]),
    provenance: z.enum(["official_website", "owner_upload", "owner_instagram", "owner_facebook", "meta_illustration"]),
    rights: z.enum(["owner_attested", "unknown_review_required", "generated_illustration"]),
    thumb: filename.nullable(), width: z.number().int().positive(), height: z.number().int().positive(), durationSeconds: z.number().nonnegative().nullable(),
    status: z.enum(["harvested", "analyzed", "selected", "excluded"]),
    analysis: z.object({
      depicts: z.string().max(300), subjectKind: z.string().max(40), goalFit: z.enum(["none", "weak", "moderate", "strong"]), heroWorthy: z.boolean(),
      quality: z.object({ sharpness: z.string().max(12), lighting: z.string().max(12), composition: z.string().max(12) }).strict(),
      risks: z.array(z.string().max(40)).max(12), primarySubject: z.object({ label: z.string().max(120), box: box.nullable() }).strict().nullable(),
    }).strict().nullable(),
    roles: z.array(z.string().max(40)).max(10),
    excludedReasons: z.array(z.string().max(300)).max(8),
    score: z.number().nullable(),
  }).strict()).max(120),
  plan: z.object({
    heroAssetId: z.string().nullable(), carousel: z.array(z.string()).max(4),
    reelMode: z.enum(["tracked_video", "still_depth", "illustration", "legacy"]), reelReasons: z.array(z.string().max(400)).max(6),
    channelAssets: z.record(z.string(), z.string().nullable()), notes: z.array(z.string().max(400)).max(12),
  }).strict().nullable(),
  sam: z.array(z.object({
    assetId: z.string().max(80), media: z.enum(["image", "video"]), promptKind: z.enum(["geometry", "concept"]), label: z.string().max(120),
    origin: z.enum(["spark_grounding", "owner_tap", "concept_prompt", "local_layout"]),
    status: z.enum(["segmented", "tracked", "no_match", "failed", "skipped"]),
    preview: filename.nullable(), overlayVideo: filename.nullable(), coverage: z.number().min(0).max(1).nullable(),
    framesTracked: z.number().int().nonnegative().nullable(), elapsedMs: z.number().int().nonnegative().nullable(),
  }).strict()).max(40),
  critic: z.object({
    verdict: z.enum(["no_blocking_findings", "blocking_findings", "not_run"]),
    findings: z.array(z.object({ id: z.string().max(20), assetId: z.string().max(80), severity: z.enum(["critical", "major", "minor"]), rule: z.string().max(60), description: z.string().max(400), box: box.nullable(), timeSeconds: z.number().nullable() }).strict()).max(60),
    fixesApplied: z.array(z.string().max(300)).max(40), withheld: z.array(z.string().max(160)).max(80),
  }).strict().nullable(),
  files: z.array(z.object({ name: filename, sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), mediaType: z.enum(["image/png", "image/jpeg", "video/mp4"]) }).strict()).max(300),
}).strict();
export type AutopilotPublicState = z.infer<typeof AutopilotPublicStateSchema>;

export function emptyPublicState(runId: string): AutopilotPublicState {
  return { version: 1, runId, updatedAt: new Date().toISOString(), phase: "harvest", headline: "Autopilot is gathering the business's media.", sources: { officialWebsite: 0, ownerUploads: 0, ownerInstagram: 0, ownerFacebook: 0, connected: false }, media: [], plan: null, sam: [], critic: null, files: [] };
}

/** Atomically replace the state file (validated). */
export async function writePublicState(runDir: string, state: AutopilotPublicState): Promise<void> {
  const parsed = AutopilotPublicStateSchema.parse({ ...state, updatedAt: new Date().toISOString() });
  const directory = join(runDir, PUBLIC_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, "state.json");
  await writeFile(`${target}.pending`, JSON.stringify(parsed), { mode: 0o600 });
  await rename(`${target}.pending`, target);
}

/** Write one derived preview file and return its servable record. */
export async function writePublicFile(runDir: string, name: string, bytes: Buffer, mediaType: AutopilotPublicState["files"][number]["mediaType"]) {
  filename.parse(name);
  const directory = join(runDir, PUBLIC_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(`${join(directory, name)}.pending`, bytes, { mode: 0o600 });
  await rename(`${join(directory, name)}.pending`, join(directory, name));
  return { name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, mediaType };
}

export async function readPublicState(runDir: string): Promise<AutopilotPublicState | null> {
  try { return AutopilotPublicStateSchema.parse(JSON.parse(await readFile(join(runDir, PUBLIC_DIR, "state.json"), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("The Autopilot progress record failed validation.");
  }
}

/** Read a listed preview file after path, type, size and hash checks; null when not servable. */
export async function readPublicFile(runDir: string, name: string): Promise<{ bytes: Buffer; mediaType: string } | null> {
  if (!filename.safeParse(name).success || name === "state.json") return null;
  const state = await readPublicState(runDir);
  const record = state?.files.find((file) => file.name === name);
  if (!record) return null;
  try {
    const root = await realpath(resolve(runDir, PUBLIC_DIR));
    const path = resolve(root, name);
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== record.bytes || !(await realpath(path)).startsWith(root + sep)) return null;
    const bytes = await readFile(path);
    if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) return null;
    return { bytes, mediaType: record.mediaType };
  } catch { return null; }
}
