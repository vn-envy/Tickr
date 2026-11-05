import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CompositionLedger } from "../media/cinema-types";
import type { AnalyzedAsset, ProductionPlan } from "./contracts";
import { emptyPublicState, writePublicFile, writePublicState, type AutopilotPublicState } from "./public-state";

/**
 * Private Autopilot records (checkpoints under <outputDir>/autopilot/), the owner-visible
 * director's room (lib/autopilot/public-state.ts) and the exported director/critic reports.
 *
 * Checkpoints are application-written private JSON: each carries a content digest and the
 * binding of the inputs it was derived from, so a corrupt or out-of-date record fails closed
 * instead of silently steering a paid step. Reports and public state never contain private
 * paths, credentials or raw provider output.
 */
export const CHECKPOINT_VERSION = 1;
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;

export const sha256Hex = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export const digestOf = (value: unknown) => sha256Hex(JSON.stringify(value));

/** A private record no longer matches this run. Never retried into a paid request. */
export class AutopilotCheckpointError extends Error {
  constructor(message = "A saved Autopilot checkpoint failed its integrity check. No new Meta request was made; start a fresh run.") {
    super(message);
    this.name = "AutopilotCheckpointError";
  }
}

const envelopeSchema = z.object({
  version: z.literal(CHECKPOINT_VERSION), name: z.string().regex(NAME), binding: z.string().regex(/^[a-f0-9]{64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/), savedAt: z.string().datetime(), value: z.unknown(),
}).strict();

/** Null when absent. A corrupt, renamed or differently bound record throws AutopilotCheckpointError. */
export async function readCheckpoint<T>(directory: string, name: string, binding: string): Promise<T | null> {
  if (!NAME.test(name)) throw new AutopilotCheckpointError();
  const path = join(directory, `${name}.json`);
  let text: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_CHECKPOINT_BYTES) throw new AutopilotCheckpointError();
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AutopilotCheckpointError();
  }
  try {
    const envelope = envelopeSchema.parse(JSON.parse(text));
    if (envelope.name !== name || envelope.binding !== binding || envelope.digest !== digestOf(envelope.value)) throw new Error("mismatch");
    return envelope.value as T;
  } catch { throw new AutopilotCheckpointError(); }
}

/** Atomic 0600 write (pending file, fsync, rename). */
export async function writeCheckpoint(directory: string, name: string, binding: string, value: unknown): Promise<void> {
  if (!NAME.test(name)) throw new AutopilotCheckpointError();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${name}.json`);
  const pending = join(directory, `.${name}.${process.pid}.pending.json`);
  const serialized = JSON.parse(JSON.stringify(value)) as unknown;
  const body = JSON.stringify({ version: CHECKPOINT_VERSION, name, binding, digest: digestOf(serialized), savedAt: new Date().toISOString(), value: serialized });
  if (Buffer.byteLength(body) > MAX_CHECKPOINT_BYTES) throw new AutopilotCheckpointError("An Autopilot checkpoint exceeded its size limit.");
  const handle = await open(pending, "w", 0o600);
  try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
  try { await rename(pending, target); } catch (error) { await unlink(pending).catch(() => undefined); throw error; }
}

/** Bounded, single-line plain text for public state and reports. */
export function bounded(value: string | null | undefined, max: number): string {
  const clean = (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : clean;
}

type PublicFile = AutopilotPublicState["files"][number];
type PublicMedia = AutopilotPublicState["media"][number];
type Phase = AutopilotPublicState["phase"];

/**
 * The owner-visible director's room. Writes are best-effort: a preview that cannot be written
 * never stops production (the private checkpoints remain the source of truth).
 */
export class DirectorRoom {
  state: AutopilotPublicState;
  private failed = false;

  constructor(private readonly runDir: string, runId: string) {
    this.state = emptyPublicState(runId);
  }

  get writeFailed(): boolean { return this.failed; }

  /** Writes one derived preview and lists it; returns its public name, or null when it could not be written. */
  async publish(name: string, bytes: Buffer, mediaType: PublicFile["mediaType"]): Promise<string | null> {
    try {
      const record = await writePublicFile(this.runDir, name, bytes, mediaType);
      this.state.files = [...this.state.files.filter((file) => file.name !== name), record].slice(-300);
      return name;
    } catch { this.failed = true; return null; }
  }

  media(assetId: string): PublicMedia | undefined {
    return this.state.media.find((item) => item.assetId === assetId);
  }

  async save(phase?: Phase, headline?: string): Promise<void> {
    if (phase) this.state.phase = phase;
    if (headline) this.state.headline = bounded(headline, 300);
    try { await writePublicState(this.runDir, this.state); }
    catch { this.failed = true; }
  }
}

/** Public analysis summary for one asset (no visible-text transcription, no raw model output). */
export function publicAnalysis(asset: AnalyzedAsset): PublicMedia["analysis"] {
  const analysis = asset.analysis;
  if (!analysis) return null;
  return {
    depicts: bounded(analysis.depicts, 300), subjectKind: analysis.subjectKind, goalFit: analysis.goalFit, heroWorthy: analysis.heroWorthy,
    quality: { ...analysis.quality },
    risks: [...new Set(analysis.risks.map((risk) => risk.kind))].slice(0, 12),
    primarySubject: analysis.primarySubject ? { label: bounded(analysis.primarySubject.label, 120), box: analysis.primarySubject.box ? { ...analysis.primarySubject.box } : null } : null,
  };
}

/** Roles each asset plays in the plan, for the director's room. */
export function planRoles(plan: ProductionPlan): Map<string, string[]> {
  const roles = new Map<string, string[]>();
  const add = (assetId: string | null | undefined, role: string) => {
    if (!assetId) return;
    const list = roles.get(assetId) ?? [];
    if (!list.includes(role) && list.length < 10) list.push(role);
    roles.set(assetId, list);
  };
  add(plan.hero?.assetId, "hero");
  plan.carousel.forEach((pick, index) => add(pick.assetId, `carousel_${index + 1}`));
  for (const [channel, assetId] of Object.entries(plan.channelAssets)) add(assetId, channel);
  if (plan.reel.mode === "tracked_video") add(plan.reel.clipAssetId, "reel_footage");
  if (plan.reel.mode === "still_depth") add(plan.reel.still.assetId, "reel_still");
  return roles;
}

/** SAM record kept in reports and the director's room (no paths, no raw output). */
export interface SamRecord {
  assetId: string;
  media: "image" | "video";
  promptKind: "geometry" | "concept";
  label: string;
  origin: "spark_grounding" | "owner_tap" | "concept_prompt" | "local_layout";
  status: "segmented" | "tracked" | "no_match" | "failed" | "skipped";
  preview: string | null;
  overlayVideo: string | null;
  coverage: number | null;
  framesTracked: number | null;
  elapsedMs: number | null;
  responseId: string | null;
  objectCount: number | null;
  note: string | null;
  /**
   * Shape-quality gate of an image selection (lib/media/mask-quality.ts). `clean` false: the cutout
   * was not used anywhere and the photo was shown uncut. Absent for video, no-match and older records.
   */
  maskQuality?: {
    clean: boolean; measured: boolean; solidity: number; roughness: number; components: number; largestComponentShare: number;
    cutThrough: { side: "top" | "bottom" | "left" | "right"; depth: number; span: number; maskSpan: number; strong: boolean } | null;
    failures: Array<"low_solidity" | "rough_edge" | "fragmented" | "cut_through">;
  } | null;
}

export function publicSam(record: SamRecord): AutopilotPublicState["sam"][number] {
  return {
    assetId: record.assetId, media: record.media, promptKind: record.promptKind, label: bounded(record.label, 120) || "subject", origin: record.origin, status: record.status,
    preview: record.preview, overlayVideo: record.overlayVideo, coverage: record.coverage === null ? null : Math.min(1, Math.max(0, record.coverage)),
    framesTracked: record.framesTracked, elapsedMs: record.elapsedMs === null ? null : Math.max(0, Math.round(record.elapsedMs)),
  };
}

export interface DirectorReportInput {
  runId: string;
  plan: ProductionPlan;
  analyzed: readonly AnalyzedAsset[];
  harvest: { sources: AutopilotPublicState["sources"]; website: string | null; assets: ReadonlyArray<{ assetId: string; kind: "image" | "video"; provenance: string; rights: string; sourcePageUrl: string | null }> };
  sam: readonly SamRecord[];
  reel: { mode: string; provenanceLabel: string | null; ledger: CompositionLedger | null; violations: readonly string[]; trackedObject: { label: string; framesPresent: number; meanCoverage: number } | null };
  roleCounts: Record<string, number>;
  notes: readonly string[];
}

/** director-report.json: the plan and the observations behind it. Model text is labelled as observation. */
export function directorReport(input: DirectorReportInput): string {
  const media = input.analyzed.map((asset) => {
    const harvested = input.harvest.assets.find((item) => item.assetId === asset.assetId);
    return {
      assetId: asset.assetId, kind: asset.kind, provenance: asset.provenance, rights: asset.rights, width: asset.width, height: asset.height, durationSeconds: asset.durationSeconds,
      sourcePageUrl: harvested?.sourcePageUrl ?? null,
      ownerConsent: asset.consent ? asset.consent.peopleVisibleHaveConsented : null,
      sparkObservation: asset.analysis ? {
        depicts: asset.analysis.depicts, subjectKind: asset.analysis.subjectKind, matchedOfferingIds: asset.analysis.matchedOfferingIds,
        primarySubject: asset.analysis.primarySubject, quality: asset.analysis.quality, goalFit: asset.analysis.goalFit, heroWorthy: asset.analysis.heroWorthy,
        suitableFor: asset.analysis.suitableFor, risks: asset.analysis.risks.map((risk) => ({ kind: risk.kind, box: risk.box })),
      } : null,
      shotLog: asset.shotLog,
    };
  });
  return `${JSON.stringify({
    version: "autopilot-director-report-1",
    runId: input.runId,
    interpretation: "Spark observations, SAM selections and the deterministic plan below are production records, not verified facts about the business, its products, rights or consent. Website media rights are unknown and need review; owner media rights are owner-attested.",
    sources: { ...input.harvest.sources, officialWebsite: input.harvest.website },
    plan: input.plan,
    media,
    exclusions: input.plan.excluded,
    segmentation: input.sam.map((record) => ({ ...record, preview: undefined, overlayVideo: undefined })),
    reel: input.reel,
    budgetRoleCounts: input.roleCounts,
    provenanceNotes: [
      "Owner photos and footage keep their original pixels; SAM masks only select real pixels and never verify product identity.",
      "Spark boxes are located observations on a 0–1000 grid mapped to source pixels, not verified regions.",
      "Every rendered frame carries a concept/provenance label; the kit stays concept_needs_review until the owner approves exact files.",
    ],
    notes: input.notes,
  }, null, 2)}\n`;
}
