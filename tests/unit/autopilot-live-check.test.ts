import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  billableFromFailure, createDryClients, diagnoseLiveCheckError, estimateLiveCheckCost, formatLiveCheckTable, MISSING_KEY_MESSAGE, parseLiveCheckArguments, runAutopilotLiveCheck, STILL_PROBE_PROVENANCE,
  type AdapterDiagnostic, type DryFaults, type LiveCheckOutcome, type LiveCheckStep,
} from "../../scripts/autopilot-live-check";

// SYNTHETIC only: the --dry path draws its own media locally and answers every Meta call with an
// injected fake client. No META_API_KEY is used and no network request is made.
const roots: string[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), "tickr-live-check-")); roots.push(value); return value; }
afterAll(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const STEP_IDS = ["spark-media-analysis", "sam-image-geometry", "sam-image-concept", "clip-shotlog", "sam-video-tracking", "reel-render", "spark-critic"];

describe("autopilot live check --dry", () => {
  let outcome: LiveCheckOutcome;
  let parent: string;
  const lines: string[] = [];
  const fetchCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    parent = await root();
    // Any network attempt would be recorded here; the dry flow must never reach it.
    globalThis.fetch = (async (...args: unknown[]) => { fetchCalls.push(args); throw new Error("network disabled in tests"); }) as typeof fetch;
    try {
      outcome = await runAutopilotLiveCheck({
        dry: true, rootDirectory: parent, environment: { META_API_KEY: "test-key-must-never-appear" }, log: (line) => lines.push(line),
        now: () => new Date("2026-11-04T10:00:00.000Z"),
      });
    } finally { globalThis.fetch = originalFetch; }
  }, 600_000);

  test("runs every step offline and exits 0", () => {
    expect(fetchCalls).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    const report = outcome.report!;
    expect(report.mode).toBe("dry");
    expect(report.run).toBe("2026-11-04T10-00-00-000Z-dry");
    expect(report.steps.map((step) => step.id)).toEqual(STEP_IDS);
    expect(report.steps.map((step) => step.status)).toEqual(STEP_IDS.map(() => "succeeded"));
    expect(report.succeeded).toBe(true);
    for (const step of report.steps.filter((entry) => entry.endpoint)) {
      expect(step.endpoint).toBe("POST https://api.meta.ai/v1/responses");
      expect(step.responseId).toMatch(/^resp_/);
      expect(step.usage).not.toBeNull();
      expect(step.diagnostic).toBeNull();
    }
    expect(report.steps.find((step) => step.id === "reel-render")).toMatchObject({ model: null, endpoint: null, elapsedMs: null });
  });

  test("feeds Spark observations into SAM prompts and the shot-log label into video tracking", () => {
    const facts = Object.fromEntries(outcome.report!.steps.map((step) => [step.id, step.facts]));
    expect(facts["sam-image-geometry"]).toMatchObject({ boxSource: "spark_media_analysis", promptKind: "geometry", status: "segmented" });
    expect(facts["sam-image-concept"]).toMatchObject({ conceptSource: "spark_media_analysis", concept: "glass jar", promptKind: "concept" });
    expect(facts["sam-video-tracking"]).toMatchObject({ concept: "red disk", conceptSource: "spark_shot_log", objects: 1, source: "request" });
    expect(facts["clip-shotlog"]).toMatchObject({ clip: { width: 960, height: 540, fps: 30, frameCount: 120 } });
  });

  test("renders both Reels and the overlay with labelled provenance and no generated subject pixels", () => {
    const render = outcome.report!.steps.find((step) => step.id === "reel-render")!.facts as Record<string, Record<string, unknown>>;
    expect(render.stillDepth).toMatchObject({ status: "rendered", conceptLabel: "SYNTHETIC DEMO · CONCEPT", generatedPixelsOnSubject: 0 });
    expect(render.trackedReel).toMatchObject({ status: "rendered", conceptLabel: "SYNTHETIC DEMO · CONCEPT", generatedPixelsOnSubject: 0, endCard: "still_depth" });
    // The tracked Reel's end card is the synthetic probe still: it is never labelled as owner media.
    expect(render.stillDepth).toMatchObject({ provenanceLabel: STILL_PROBE_PROVENANCE });
    expect(render.trackedReel).toMatchObject({ endCardProvenanceLabel: STILL_PROBE_PROVENANCE });
    expect(String(render.trackedReel.endCardProvenanceLabel)).not.toMatch(/owner/i);
    expect(render.overlay).toMatchObject({ status: "rendered", label: "ANALYSIS PREVIEW · NOT CAMPAIGN CREATIVE" });
    expect(outcome.report!.steps.find((step) => step.id === "spark-critic")!.facts).toMatchObject({ reelAsset: "synthetic-tracked-reel.mp4", verdict: "no_blocking_findings", diagnosticOnly: true });
  });

  test("keeps every step in its own private directory and writes synthetic media only", async () => {
    const run = outcome.runDirectory!;
    const entries = (await readdir(run)).sort();
    expect(entries).toEqual(["01-spark-media-analysis", "02-sam-image-geometry", "03-sam-image-concept", "04-clip-shotlog", "05-sam-video-tracking", "06-reel-render", "07-spark-critic", "report.json", "synthetic-media"]);
    for (const entry of entries.filter((name) => name !== "report.json")) expect((await stat(join(run, entry))).mode & 0o777).toBe(0o700);
    expect((await stat(outcome.reportPath!)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(run, "synthetic-media"))).sort()).toEqual(["synthetic-cup.png", "synthetic-jar.png", "synthetic-red-disk.mp4"]);
    expect(outcome.report!.syntheticMedia.every((media) => media.file.startsWith("synthetic-media/synthetic-") && /Synthetic/.test(media.note))).toBe(true);
    // Each paid step kept its requested marker and stored response privately.
    for (const step of ["01-spark-media-analysis", "02-sam-image-geometry", "03-sam-image-concept", "04-clip-shotlog", "05-sam-video-tracking", "07-spark-critic"]) {
      const files = await readdir(join(run, step, "responses"));
      expect(files.some((name) => name.endsWith("-request.json"))).toBe(true);
      expect(files.some((name) => name.endsWith("-response.json"))).toBe(true);
    }
    expect((await readdir(join(run, "06-reel-render"))).sort()).toEqual(expect.arrayContaining(["synthetic-sam-overlay.mp4", "synthetic-still-depth-cover.png", "synthetic-still-depth-reel.mp4", "synthetic-tracked-cover.png", "synthetic-tracked-reel.mp4"]));
  });

  test("report.json carries no keys, media payloads, prompts or local paths", async () => {
    const text = await readFile(outcome.reportPath!, "utf8");
    expect(text).not.toContain("test-key-must-never-appear");
    expect(text).not.toMatch(/data:(image|video)\//);
    expect(text).not.toMatch(/base64|Bearer|authorization/i);
    expect(text).not.toContain(parent);
    expect(text).not.toContain("UNTRUSTED DATA");
    expect(JSON.parse(text)).toEqual(outcome.report);
    expect(lines.join("\n")).not.toContain("test-key-must-never-appear");
  });

  test("prints a table and a clearly labelled dry-run list-price estimate", () => {
    const estimate = outcome.report!.estimate;
    expect(estimate.label).toMatch(/^LIST-PRICE ESTIMATE ONLY/);
    expect(estimate.notes[0]).toMatch(/^DRY RUN/);
    expect(estimate.lines.map((line) => line.kind)).toEqual(["spark_tokens", "sam_images", "sam_images", "spark_tokens", "sam_video_frames", "spark_tokens"]);
    // Fake usage: 3600/840, 6400/260 and 5200/90 tokens; 2 SAM images; 120 video frames.
    const spark = (input: number, output: number) => input / 1e6 * 1.25 + output / 1e6 * 4.25;
    const expected = spark(3600, 840) + spark(6400, 260) + spark(5200, 90) + 2 * 2.5 / 1000 + 120 * 0.2 / 1000;
    expect(estimate.totalUsd).toBeCloseTo(expected, 6);
    expect(estimate.incomplete).toBe(false);
    const printed = lines.join("\n");
    expect(printed).toContain("[DRY RUN] LIST-PRICE ESTIMATE ONLY");
    expect(printed).toContain("All steps succeeded.");
    for (const id of STEP_IDS) expect(printed).toContain(id);
    expect(formatLiveCheckTable(outcome.report!)).toContain("spark-media-analysis");
  });
});

describe("autopilot live check guards", () => {
  test("refuses a live run without META_API_KEY before creating anything", async () => {
    const parent = await root();
    const lines: string[] = [];
    const outcome = await runAutopilotLiveCheck({ dry: false, rootDirectory: join(parent, "never-created"), environment: { META_API_KEY: "  " }, log: (line) => lines.push(line) });
    expect(outcome).toEqual({ exitCode: 2, report: null, runDirectory: null, reportPath: null });
    expect(lines.join("\n")).toBe(MISSING_KEY_MESSAGE);
    expect(MISSING_KEY_MESSAGE).toContain("META_API_KEY");
    expect(await readdir(parent)).toEqual([]);
  });

  test("refuses a disallowed Spark model before creating anything", async () => {
    const parent = await root();
    const outcome = await runAutopilotLiveCheck({ dry: false, rootDirectory: join(parent, "never-created"), environment: { META_API_KEY: "test-key", META_REASONING_MODEL: "muse-spark-contributor" }, log: () => undefined });
    expect(outcome.exitCode).toBe(2);
    expect(await readdir(parent)).toEqual([]);
  });

  test("dry clients answer only POST /responses", async () => {
    const clients = await createDryClients({ imageBoxes: new Map(), gridBoxes: new Map(), clip: null });
    await expect(clients.spark.requestJson("/models")).rejects.toMatchObject({ code: "ENDPOINT_NOT_ALLOWED" });
    await expect(clients.sam.requestJson("/responses", { method: "POST", modelRole: "reasoning", body: {} })).rejects.toMatchObject({ code: "ENDPOINT_NOT_ALLOWED" });
    expect(clients.calls).toEqual([]);
  });

  test("parses arguments strictly", () => {
    expect(parseLiveCheckArguments([])).toEqual({ dry: false, rootDirectory: undefined, help: false });
    expect(parseLiveCheckArguments(["--dry", "--out", "x"])).toEqual({ dry: true, rootDirectory: "x", help: false });
    expect(() => parseLiveCheckArguments(["--out"])).toThrow();
    expect(() => parseLiveCheckArguments(["--live"])).toThrow();
  });

  test("the estimate marks unknown outcomes and unpriced models as incomplete", () => {
    const base = { title: "", status: "failed", endpoint: null, elapsedMs: null, wallMs: 0, responseId: null, usage: null, diagnostic: null, facts: {}, directory: "" } as const;
    const steps: LiveCheckStep[] = [
      { ...base, index: 1, id: "spark-media-analysis", model: "muse-spark-1.3", billable: [], paidOutcomeUnknown: true },
      { ...base, index: 7, id: "spark-critic", model: "muse-wonder-1.0", billable: [{ kind: "spark_tokens", model: "muse-wonder-1.0", inputTokens: 10, outputTokens: 10, basis: "reported" }], paidOutcomeUnknown: false },
      { ...base, index: 5, id: "sam-video-tracking", model: "sam-3.1", billable: [{ kind: "sam_video_frames", model: "sam-3.1", frames: 20, basis: "counted_clip_frames" }], paidOutcomeUnknown: false },
    ];
    const estimate = estimateLiveCheckCost(steps, "live");
    expect(estimate.incomplete).toBe(true);
    expect(estimate.lines[0]).toMatchObject({ usd: null, note: "No dated list price for this model." });
    // The 50-frame per-request minimum applies to the counted 20 frames.
    expect(estimate.lines[1]).toMatchObject({ usd: 0.01, quantity: "50 frame(s) (minimum applied to 20)" });
    expect(estimate.notes.some((note) => note.includes("unknown outcome"))).toBe(true);
    expect(estimate.notes.some((note) => note.startsWith("DRY RUN"))).toBe(false);
  });
});

describe("autopilot live check --dry with failing SAM video", () => {
  const runs = new Map<NonNullable<DryFaults["samVideo"]>, { outcome: LiveCheckOutcome; lines: string[]; parent: string }>();
  beforeAll(async () => {
    for (const fault of ["empty", "undecodable"] as const) {
      const parent = await root();
      const lines: string[] = [];
      const outcome = await runAutopilotLiveCheck({ dry: true, rootDirectory: parent, environment: {}, log: (line) => lines.push(line), dryFaults: { samVideo: fault } });
      runs.set(fault, { outcome, lines, parent });
    }
  }, 900_000);
  const byId = (outcome: LiveCheckOutcome) => Object.fromEntries(outcome.report!.steps.map((step) => [step.id, step]));

  test("no tracked object fails step 5, cascades into step 6 and falls back to the still-depth Reel for the critic", () => {
    const { outcome, lines } = runs.get("empty")!;
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report!.succeeded).toBe(false);
    const steps = byId(outcome);
    expect(steps["sam-video-tracking"]).toMatchObject({ status: "failed", diagnostic: { code: "NO_TRACKED_OBJECT" }, responseId: "resp_dry_sam_video" });
    // The paid response arrived, so its reported frames are still counted.
    expect(steps["sam-video-tracking"].billable).toEqual([{ kind: "sam_video_frames", model: "sam-3.1", frames: 120, basis: "reported" }]);
    expect(steps["reel-render"]).toMatchObject({ status: "failed", diagnostic: { code: "DEPENDENCY_UNAVAILABLE" } });
    expect(steps["reel-render"].facts).toMatchObject({ stillDepth: { status: "rendered" }, trackedReel: { status: "skipped" }, overlay: { status: "skipped" } });
    expect(steps["spark-critic"]).toMatchObject({ status: "succeeded", facts: { reelAsset: "synthetic-still-depth-reel.mp4" } });
    expect(outcome.report!.estimate.incomplete).toBe(false);
    expect(lines.join("\n")).toContain("Failed or skipped: sam-video-tracking, reel-render.");
  });

  test("an undecodable paid response is still counted from the clip and reported with a fixed code", async () => {
    const { outcome, parent } = runs.get("undecodable")!;
    expect(outcome.exitCode).toBe(1);
    const steps = byId(outcome);
    const video = steps["sam-video-tracking"];
    expect(video).toMatchObject({ status: "failed", responseId: "resp_dry_sam_video", usage: null, paidOutcomeUnknown: false, diagnostic: { phase: "decode", completedResponseStored: true } });
    // The adapter's geometry preflight rejects the output with its own fixed text.
    expect(video.diagnostic).toMatchObject({ code: "VIDEO_SEGMENTATION_INVALID", detail: "SAM video geometry exceeds its bounds or contains unsupported fields." });
    expect(video.billable).toEqual([{ kind: "sam_video_frames", model: "sam-3.1", frames: 120, basis: "counted_clip_frames" }]);
    expect(outcome.report!.estimate.lines.find((line) => line.step === "sam-video-tracking")).toMatchObject({ quantity: "120 frame(s)", usd: 0.024 });
    expect(steps["reel-render"]).toMatchObject({ status: "failed", diagnostic: { code: "DEPENDENCY_UNAVAILABLE" } });
    expect(steps["spark-critic"]).toMatchObject({ status: "succeeded", facts: { reelAsset: "synthetic-still-depth-reel.mp4" } });
    const text = await readFile(outcome.reportPath!, "utf8");
    expect(text).not.toContain(parent);
    expect(text).not.toContain("not-a-record");
  });
});

describe("autopilot live check failure accounting", () => {
  const recorded = (patch: Partial<AdapterDiagnostic>): AdapterDiagnostic => ({ phase: "decode", code: "X_INVALID", detail: "fixed", httpStatus: null, completedResponseStored: true, responseId: "resp_1", elapsedMs: 900, usage: null, ...patch });
  const samImage = { model: "sam-3.1", billing: "sam_image" as const };
  const samVideo = { model: "sam-3.1", billing: "sam_video" as const, clipFrames: () => 120 };
  const spark = { model: "muse-spark-1.3", billing: "spark" as const };

  test("a SAM image decode failure with no usage still counts the request", () => {
    expect(billableFromFailure(samImage, null, recorded({}))).toEqual({ billable: [{ kind: "sam_images", model: "sam-3.1", images: 1, basis: "counted_requests" }], unrecorded: false });
    expect(billableFromFailure(samImage, { imagesProcessed: 2, inputTokens: 5 }, recorded({})).billable).toEqual([{ kind: "sam_images", model: "sam-3.1", images: 2, basis: "reported" }]);
  });

  test("a storage failure after the response arrived counts; one before the call does not", () => {
    const after = recorded({ phase: "storage", completedResponseStored: false });
    expect(billableFromFailure(samVideo, null, after).billable).toEqual([{ kind: "sam_video_frames", model: "sam-3.1", frames: 120, basis: "counted_clip_frames" }]);
    expect(billableFromFailure(samVideo, { frames_billed: 90 }, after).billable).toEqual([{ kind: "sam_video_frames", model: "sam-3.1", frames: 90, basis: "reported" }]);
    const before = recorded({ phase: "storage", completedResponseStored: false, responseId: null, elapsedMs: 0 });
    expect(billableFromFailure(samVideo, null, before)).toEqual({ billable: [], unrecorded: false });
    // Request-phase failures are the diagnosis's paidOutcomeUnknown, not a billable line.
    expect(billableFromFailure(spark, null, recorded({ phase: "request", completedResponseStored: false, responseId: null }))).toEqual({ billable: [], unrecorded: false });
    expect(billableFromFailure({ model: null, billing: null }, null, recorded({}))).toEqual({ billable: [], unrecorded: false });
  });

  test("a received Spark response without token usage leaves an unpriced line; an underivable SAM video response is flagged", () => {
    const sparkLine = billableFromFailure(spark, null, recorded({}));
    expect(sparkLine.billable).toEqual([{ kind: "spark_tokens", model: "muse-spark-1.3", inputTokens: null, outputTokens: null, basis: "reported" }]);
    expect(billableFromFailure({ ...samVideo, clipFrames: () => null }, null, recorded({}))).toEqual({ billable: [], unrecorded: true });

    const base = { title: "", status: "failed", endpoint: "POST https://api.meta.ai/v1/responses", elapsedMs: 900, wallMs: 0, responseId: "resp_1", usage: null, facts: {}, directory: "" } as const;
    const decode = { phase: "decode", code: "X_INVALID", detail: "fixed", httpStatus: null, completedResponseStored: true };
    const estimate = estimateLiveCheckCost([
      { ...base, index: 1, id: "spark-media-analysis", model: "muse-spark-1.3", billable: sparkLine.billable, paidOutcomeUnknown: false, diagnostic: decode },
      { ...base, index: 5, id: "sam-video-tracking", model: "sam-3.1", billable: [], paidOutcomeUnknown: true, diagnostic: decode },
      { ...base, index: 7, id: "spark-critic", model: "muse-spark-1.3", billable: [], paidOutcomeUnknown: true, diagnostic: { ...decode, phase: "request", completedResponseStored: false, httpStatus: 400 } },
    ], "live");
    expect(estimate.incomplete).toBe(true);
    expect(estimate.lines[0]).toMatchObject({ usd: null, note: "Token usage was not reported." });
    expect(estimate.notes).toEqual([
      "sam-video-tracking: a paid response was received but its billable usage could not be derived; it is not included.",
      "spark-critic: Meta rejected the request (HTTP 400); billing was not confirmed by Meta and it is not included.",
    ]);
  });

  test("raw local errors become a fixed code without their message", () => {
    const result = diagnoseLiveCheckError(new Error("ENOENT: no such file, open '/home/owner/secret/clip.mp4'"));
    expect(result).toEqual({
      diagnostic: { phase: "local", code: "LOCAL_STEP_FAILED", detail: "The step failed locally; details are withheld from the report by design.", httpStatus: null, completedResponseStored: false },
      recorded: null, paidOutcomeUnknown: false,
    });
    expect(JSON.stringify(result)).not.toContain("/home/owner");
  });
});
