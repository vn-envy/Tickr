import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { critiqueCampaign, type CritiqueReport } from "../../lib/agents/critic";
import type { renderStillDepthReel } from "../../lib/campaign/cinema/still-depth";
import type { renderTrackedReel } from "../../lib/campaign/cinema/tracked";
import type { CampaignCopy } from "../../lib/campaign/copy";
import { prepareCampaignVisual } from "../../lib/campaign/visual";
import type { CampaignCopyResult, CreateCampaignInput } from "../../lib/campaign/index";
import type { NormalizedClip, OwnerMediaConsent } from "../../lib/media/cinema-types";
import type { OfficialGalleryResult } from "../../lib/media/gallery";
import { approvableFiles } from "../../lib/jobs/approval-shared";
import { MediaLibrary, type MediaAssetRecord } from "../../lib/media/library";
import type { MetaClient } from "../../lib/meta/client";
import { analyzeMediaAssets } from "../../lib/meta/media-analysis";
import { trackMetaVideo, type SamVideoRequest } from "../../lib/meta/sam-video";
import { segmentMetaImage, type MetaSegmentationRequest } from "../../lib/meta/segmentation";
import { analyzeClipShots } from "../../lib/meta/video-understanding";
import { AUTOPILOT_ROLE_CAPS, AutopilotBudgetError, createAutopilotBudget, type AutopilotBudget } from "../../lib/autopilot/budget";
import type { AutopilotRole } from "../../lib/autopilot/contracts";
import { applyDeterministicFixes, type CritiqueSnapshot } from "../../lib/autopilot/critique";
import { officialWebsiteFor, selectHarvest } from "../../lib/autopilot/harvest";
import { defaultAutopilotDependencies, produceAutopilotCampaign, type AutopilotDependencies } from "../../lib/autopilot/pipeline";
import { heroTrack } from "../../lib/autopilot/produce";
import { AutopilotPaidStepError, AutopilotResumableError, AutopilotQualitySchema, type AutopilotProductionInput } from "../../lib/autopilot/production-types";
import { readPublicFile, readPublicState, type AutopilotPublicState } from "../../lib/autopilot/public-state";
import { ILLUSTRATION_ASSET_ID, ILLUSTRATION_REEL_LABEL } from "../../lib/autopilot/produce";
import type { BusinessEnrichment, CollectedSource, ResearchOpportunity, ResearchReport } from "../../lib/research/contracts";
import { ChannelSchema } from "../../lib/schemas/common";
import { samImageWire, samResponse, samVideoWire } from "../helpers/sam-wire";

// Every image, clip, business, claim and model response in this file is SYNTHETIC and generated
// locally (sharp shapes, FFmpeg lavfi testsrc2/color). Meta adapters run for real with injected
// fake clients; no network request is made and META_API_KEY is never set.
const run = promisify(execFile);
const consent: OwnerMediaConsent = { ownsOrLicensedMedia: true, peopleVisibleHaveConsented: "no_people", attestedAt: "2026-11-04T00:00:00.000Z" };
const score = { value: null, rationale: "Not measured in this synthetic fixture." };
const opportunity: ResearchOpportunity = {
  id: "op-1", title: "Morning flat white push", hypothesis: "Synthetic hypothesis.", whyNow: "Synthetic timing.", evidenceIds: ["fact-1"], comparison: "Not compared.",
  customerAction: "Visit for a flat white", test: "Count visits.", uncertainties: ["Synthetic."], scores: { impact: score, evidence: score, differentiation: score, feasibility: score, confidence: score },
};
const report: ResearchReport = {
  summary: "Synthetic test only.", evidence: [{ id: "fact-1", sourceId: "s1", claim: "The cafe serves flat whites.", quote: "We serve flat whites.", subject: "business", kind: "fact" }],
  findings: [], opportunities: [opportunity], recommendedOpportunityId: "op-1", unknowns: [], ownerQuestions: [], coverage: { sources: 1, competitorSources: 0, customerSources: 0 }, generatedAt: "2026-11-01T00:00:00Z", mode: "live",
};
const source: CollectedSource = { id: "s1", kind: "owner_statement", title: "Synthetic owner note", url: null, text: "We serve flat whites.", retrievedAt: "2026-11-02T00:00:00Z", acquisition: "owner_supplied" };
const enrichment = (businessId: string): BusinessEnrichment => ({ status: "enriched", businessId, offerings: [{ id: "offering-1", name: "Flat white", description: "A synthetic flat white.", sourceIds: ["s1"] }], brandSignals: [], sourceIds: ["s1"], unknowns: [], warnings: [], queries: [], completedToolCalls: 0, enrichedAt: "2026-11-02T00:00:00Z" });

function copyFixture(options: { reelDraft?: boolean } = {}): CampaignCopy {
  return {
    name: "Synthetic morning cups", objective: "Invite morning visits.", audienceHypothesis: "Synthetic commuters.", coreMessage: "A calm flat white before work.", primaryCta: "Visit this morning", evidenceIds: ["fact-1"], reviewNotes: ["Confirm opening hours."],
    channels: ChannelSchema.options.map((id) => ({ id, title: id, headline: "A flat white before work", body: id === "instagram_feed" || (options.reelDraft && id === "instagram_reels") ? `${id === "instagram_feed" ? "Morning cups" : "Reel cups"}, made slowly. (draft copy)` : "Made slowly for the morning.", caption: "Stop by for a flat white.", cta: "Visit this morning", evidenceIds: ["fact-1"] })),
    conversation: { opener: "Hello!", commonReplies: Array.from({ length: 3 }, () => ({ question: "Open early?", answer: "The team can confirm hours." })), qualificationQuestion: "When do you pass by?", nextAction: "Ask the team." },
    creativeBrief: {
      focus: { offeringId: "offering-1", name: "Flat white", description: "A synthetic flat white.", evidenceIds: ["fact-1"], sourceIds: ["s1"] },
      brandStory: { signalIds: [], narrative: "", evidenceIds: [], sourceIds: [] },
      visualDirection: { status: "proposed", description: "Cream and forest ink.", palette: ["#F6EEDD", "#263A30", "#BB4D2F"], sourceIds: [] },
      scenes: (["hook", "proof", "occasion", "action"] as const).map((role) => ({ role, headline: "A calm flat white", body: "Made slowly for the morning." })),
    },
  };
}

type Calls = Record<"copy" | "media" | "shotlog" | "samImage" | "samVideo" | "critic", number>;
const zeroCalls = (): Calls => ({ copy: 0, media: 0, shotlog: 0, samImage: 0, samVideo: 0, critic: 0 });
type Finding = { assetId: string; severity: "critical" | "major" | "minor"; rule: string; description: string; box: { x_min: number; y_min: number; x_max: number; y_max: number } | null; timeSeconds: number | null };

const sparkEnvelope = (output: unknown) => ({
  id: "resp_synthetic", model: "muse-spark-1.3", status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
  usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 },
});
const fakeClient = (respond: (body: Record<string, unknown>) => unknown | Promise<unknown>) => ({
  requestJson: vi.fn(async (_path: string, init?: { body?: Record<string, unknown> }) => respond(init!.body!)),
}) as unknown as Pick<MetaClient, "requestJson">;

type RiskFixture = ReadonlyArray<{ kind: string; box: null; note: string }>;
/** Sampled video frames carry an "<assetId>:f<frame>" id; photos keep their library id. */
const isVideoFrame = (assetId: string) => /:f\d+$/.test(assetId);
function mediaResponse(body: Record<string, unknown>, risks: RiskFixture = [], frameRisks: RiskFixture = []) {
  const content = (body.input as Array<{ content: Array<{ type: string; text?: string }> }>)[0].content;
  const last = content.filter((part) => part.type === "input_text").at(-1)!.text!;
  const ids = JSON.parse(last.slice(last.indexOf("exactly once: ") + "exactly once: ".length).replace(/\.$/, "")) as string[];
  return sparkEnvelope({ assets: ids.map((assetId, index) => ({
    assetId, depicts: "A synthetic cup shape on a plain background", subjectKind: "dish_or_drink", matchedOfferingIds: ["offering-1"],
    primarySubject: { label: "synthetic cup", box: { x_min: 300, y_min: 250, x_max: 700, y_max: 750 } },
    technicalQuality: { sharpness: "good", lighting: "good", composition: "good" }, goalFit: "strong", goalReason: "Shows a drink", heroWorthy: index === 0, heroReason: "Centered",
    suitableFor: ["reel_hero", "carousel", "story", "feed", "ad", "whatsapp"], risks: isVideoFrame(assetId) ? frameRisks : risks, visibleText: "",
  })) });
}

async function samImageResponse(request: MetaSegmentationRequest) {
  const { width, height } = await sharp(request.bytes).metadata();
  const box = request.geometry?.[0].prompts[0].box ?? { x1: Math.round(width! * .3), y1: Math.round(height! * .3), x2: Math.round(width! * .7), y2: Math.round(height! * .7) };
  return samResponse(samImageWire([{ id: request.geometry ? 0 : 1, box, confidence: 0.92 }], { width: width!, height: height! }));
}

function samVideoResponse(clip: NormalizedClip) {
  const frames = Array.from({ length: clip.frameCount }, (_, frame) => {
    const x1 = 40 + Math.round(frame * 0.8);
    return { frame, objects: [{ id: 0, box: { x1, y1: 50, x2: x1 + 110, y2: 170 }, confidence: 0.9 }] };
  });
  return samResponse(samVideoWire(frames, { width: clip.width, height: clip.height }), { frames_processed: clip.frameCount });
}

const shotResponse = () => sparkEnvelope({
  moments: [{ startSeconds: 0, endSeconds: 2.9, kind: "hero_product", description: "A synthetic test pattern", steadiness: "steady", subjectLabel: "synthetic cup", goalFit: "strong" }],
  heroMomentSeconds: 1.5, peopleVisible: false, speech: { present: false, excerpt: null, language: null },
});

let root = "";
let reelFixture = "", coverFixture = "";

/** A contract-valid 12 s 1080×1920 Reel (synthetic colour field) reused by fast fake renderers. */
async function fakeReelFiles(outputPath: string, coverPath: string) {
  await mkdir(join(outputPath, ".."), { recursive: true });
  await copyFile(reelFixture, outputPath);
  await copyFile(coverFixture, coverPath);
}
const ledger = { frames: 360, meanSubjectSourceFraction: 0.2, meanTreatedSourceFraction: 0.5, meanGeneratedFraction: 0, meanForegroundGraphicsFraction: 0.1, maxSubjectOcclusion: 0, framesSubjectCropped: 0, framesWithoutSubject: 0, generatedPixelsOnSubject: 0 as const };
const fakeStillDepth = (async (input: Parameters<typeof renderStillDepthReel>[0]) => {
  await fakeReelFiles(input.outputPath, input.coverPath);
  return { reel: { sha256: "0".repeat(64), bytes: 1, frames: 360, durationSeconds: 12, width: 1080, height: 1920, fps: 30 }, cover: { sha256: "0".repeat(64), bytes: 1, width: 1080, height: 1920, frame: 60 }, ledger,
    layout: { provenanceLabel: input.provenanceLabel }, qa: { violations: [], framesSubjectHiddenByTransition: 0 } };
}) as unknown as typeof renderStillDepthReel;
const fakeTracked = (async (input: Parameters<typeof renderTrackedReel>[0]) => {
  await fakeReelFiles(input.outputPath, input.coverPath);
  return { ledger, layout: { conceptLabel: "CONCEPT", provenanceLabel: input.provenanceLabel, calloutLabel: "synthetic cup", calloutSide: "above", truncatedText: [] }, qa: { violations: [], framesSubjectHiddenByTransition: 0, footageFramesWithoutMask: 0, headlineOcclusion: { mean: 0, max: 0 } } };
}) as unknown as typeof renderTrackedReel;

type CriticRequest = Parameters<typeof critiqueCampaign>[0];
interface Harness {
  input: AutopilotProductionInput;
  deps: AutopilotDependencies;
  calls: Calls;
  /** Every critique request the pipeline sent (first critique, then the verification critique). */
  criticRequests: CriticRequest[];
  /** Every SAM image request the pipeline sent. */
  segmentRequests: MetaSegmentationRequest[];
  stages: string[];
  phases: Array<AutopilotPublicState["phase"] | null>;
  runCalls: { count: number };
  budget: AutopilotBudget;
}

async function syntheticPhoto(path: string, background: string, cup: string, variant = 0) {
  // Distinct layouts per variant so the library's near-duplicate check keeps every synthetic photo.
  const cx = [320, 200, 450][variant % 3], bars = Array.from({ length: variant + 1 }, (_, index) => `<rect x="${40 + index * 150}" y="${variant % 2 ? 30 : 400}" width="90" height="50" fill="#222"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${background}"/><ellipse cx="${cx}" cy="240" rx="120" ry="110" fill="${cup}"/>${bars}</svg>`;
  await writeFile(path, await sharp(Buffer.from(svg)).png().toBuffer());
}

async function harness(name: string, options: {
  photos?: number; clip?: boolean; website?: boolean; caps?: Partial<Record<AutopilotRole, number>>; findings?: Finding[];
  /** Findings of the verification critique (every critique after the first); none by default. */
  recheckFindings?: Finding[];
  realStillDepth?: boolean; realTracked?: boolean; renderKit?: AutopilotDependencies["renderKit"];
  /** Risks reported for every analyzed photo (e.g. a possible minor excludes them all). */
  imageRisks?: Array<{ kind: string; box: null; note: string }>;
  /** Risks reported for every safety-check frame sampled from the owner clip. */
  frameRisks?: Array<{ kind: string; box: null; note: string }>;
  /** The instagram_reels body carries removable review wording, so the critic's fix re-renders the Reel. */
  reelDraft?: boolean;
} = {}): Promise<Harness> {
  const base = join(root, name);
  const outputDir = join(base, "run"), businessMediaDir = join(base, "business", "media"), staging = join(base, "staging");
  await mkdir(staging, { recursive: true });
  const businessId = "6c1f0a5e-2b7d-4c1e-9a3f-0d5e8b7c6a41";
  if (options.photos || options.clip) {
    const library = await MediaLibrary.open(businessMediaDir);
    for (let index = 0; index < (options.photos ?? 0); index++) {
      const path = join(staging, `photo-${index}.png`);
      await syntheticPhoto(path, ["#e8dcc8", "#d8e4ee", "#efe0e8"][index % 3], ["#7a4b2a", "#2a5b7a", "#7a2a5b"][index % 3], index + 1);
      await library.addAsset({ kind: "image", provenance: "owner_upload", filePath: path, mimeType: "image/png", consent, hints: { originalName: `synthetic-${index}.png` } });
    }
    if (options.clip) {
      const path = join(staging, "clip.mp4");
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path], { timeout: 60_000 });
      await library.addAsset({ kind: "video", provenance: "owner_upload", filePath: path, mimeType: "video/mp4", consent, hints: { originalName: "synthetic.mp4" } });
    }
  }
  const calls = zeroCalls();
  const findings = options.findings ?? [];
  const criticRequests: CriticRequest[] = [];
  const segmentRequests: MetaSegmentationRequest[] = [];
  const runCalls = { count: 0 };
  const budget = createAutopilotBudget(outputDir, async () => { runCalls.count++; }, { ...AUTOPILOT_ROLE_CAPS, ...options.caps });
  const stages: string[] = [];
  const phases: Harness["phases"] = [];
  const gallery = async (input: { officialWebsite: string; outputDir: string }): Promise<OfficialGalleryResult> => {
    await mkdir(input.outputDir, { recursive: true });
    const path = join(input.outputDir, "synthetic-website.png");
    await syntheticPhoto(path, "#f1efe6", "#3b6b3b");
    const bytes = await readFile(path);
    const sha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    return {
      status: "acquired", officialWebsite: input.officialWebsite, pagesRead: [input.officialWebsite], candidatesFound: 1, attempted: 1, skipped: [], warnings: [], retrievedAt: "2026-11-04T00:00:00.000Z",
      localFiles: { "gallery-1": path },
      assets: [{ id: "gallery-1", role: "product", roleSource: "page_metadata", candidateKind: "content_image", discoveredVia: "img", label: "Synthetic flat white", productName: "Flat white",
        sourceUrl: "https://www.synthetic-cafe-fixture.com/media/cup.png", sourcePageUrl: "https://www.synthetic-cafe-fixture.com/", duplicateSourceUrls: [], retrievedAt: "2026-11-04T00:00:00.000Z",
        sourceMimeType: "image/png", mimeType: "image/png", filename: "synthetic-website.png", width: 640, height: 480, bytes: bytes.length, sha256, sourceSha256: sha256, dHash: "0123456789abcdef",
        normalization: "auto_orient_and_fit_1600_png", rights: "unknown_review_required", usage: "private_concept_review", requiresPublicationReview: true }] as unknown as OfficialGalleryResult["assets"],
    };
  };
  const deps: AutopilotDependencies = {
    ...defaultAutopilotDependencies,
    openBusinessLibrary: async (directory) => (await lstat(directory).then(() => true, () => false)) ? MediaLibrary.open(directory) : null,
    collectGallery: gallery,
    harvestOwnerMeta: async () => ({ connected: false, imported: 0, notes: [] }),
    analyzeMedia: (request, dependencies) => analyzeMediaAssets(request, { ...dependencies, client: fakeClient((body) => { calls.media++; return mediaResponse(body, options.imageRisks, options.frameRisks); }) }),
    analyzeShots: (request, dependencies) => analyzeClipShots(request, { ...dependencies, client: fakeClient(() => { calls.shotlog++; return shotResponse(); }) }),
    segment: (request, dependencies) => segmentMetaImage(request, { ...dependencies, client: fakeClient(() => { calls.samImage++; segmentRequests.push(request); return samImageResponse(request); }) }),
    trackVideo: (request: SamVideoRequest, dependencies) => trackMetaVideo(request, { ...dependencies, client: fakeClient(() => { calls.samVideo++; return samVideoResponse(request.clip); }) }),
    critique: (request, dependencies) => critiqueCampaign(request, { ...dependencies, client: fakeClient(() => {
      calls.critic++;
      criticRequests.push(request);
      return sparkEnvelope({ findings: calls.critic === 1 ? findings : options.recheckFindings ?? [], summary: "Synthetic critique summary." });
    }) }),
    ensureCopy: async (input: CreateCampaignInput, copyOptions?: { reserveCopyCall?: () => Promise<void> }): Promise<CampaignCopyResult> => {
      const marker = join(input.outputDir, "synthetic-copy-done.txt");
      if (!(await lstat(marker).then(() => true, () => false))) {
        await copyOptions?.reserveCopyCall?.();
        calls.copy++;
        await writeFile(marker, "synthetic");
      }
      return { copy: copyFixture({ reelDraft: options.reelDraft }), usage: { model: "muse-spark-1.3", inputTokens: 10, outputTokens: 20, elapsedMs: 100 } };
    },
    renderTracked: options.realTracked ? defaultAutopilotDependencies.renderTracked : fakeTracked,
    renderStillDepth: options.realStillDepth ? defaultAutopilotDependencies.renderStillDepth : fakeStillDepth,
    ...(options.renderKit ? { renderKit: options.renderKit } : {}),
  };
  const business = { id: businessId, name: "Synthetic Fixture Cafe", locality: "Fixture town", vertical: "cafe", goal: "Bring weekday commuters in for a morning flat white", website: options.website ? "https://www.synthetic-cafe-fixture.com/" : null };
  const input: AutopilotProductionInput = {
    business, report, opportunityId: "op-1", sources: [source], mode: "live", outputDir, enrichment: enrichment(businessId),
    runId: `run-${name}`, goal: business.goal, budget, businessMediaDir, connectionsDir: join(base, "connections"),
    progress: async (stage) => { stages.push(stage); phases.push((await readPublicState(outputDir))?.phase ?? null); },
    leaseLost: () => false,
  };
  return { input, deps, calls, criticRequests, segmentRequests, stages, phases, runCalls, budget };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tickr-autopilot-pipeline-"));
  reelFixture = join(root, "fixture-reel.mp4");
  coverFixture = join(root, "fixture-cover.png");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=0x335577:s=1080x1920:r=30:d=12", "-frames:v", "360", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", reelFixture], { timeout: 120_000 });
  await writeFile(coverFixture, await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#335577" } }).png().toBuffer());
}, 180_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
beforeEach(() => {
  vi.stubEnv("META_API_KEY", "");
  vi.stubEnv("TICKR_SECRET_KEY", "");
});

const kitFile = (outputDir: string, name: string) => readFile(join(outputDir, name), "utf8");

describe("Autopilot production pipeline", () => {
  test("owner photos and an owner clip become a SAM-tracked Reel with cutouts, a self-critique, safe fixes and a director's room", async () => {
    const h = await harness("tracked", {
      photos: 2, clip: true, realTracked: true,
      findings: [
        { assetId: "facebook_ads", severity: "critical", rule: "third_party_branding", description: "A synthetic third-party mark is prominent.", box: { x_min: 100, y_min: 100, x_max: 300, y_max: 300 }, timeSeconds: null },
        { assetId: "reel", severity: "minor", rule: "visual_quality", description: "Synthetic minor note.", box: null, timeSeconds: 2 },
      ],
    });
    const result = await produceAutopilotCampaign(h.input, h.deps);
    const outputDir = h.input.outputDir;

    // Paid requests: one per step, each reserved once in the role budget and the run ceiling.
    expect(h.calls).toEqual({ copy: 1, media: 1, shotlog: 1, samImage: 2, samVideo: 1, critic: 1 });
    expect(await h.budget.counts()).toEqual({ spark_copy: 1, spark_media: 1, spark_shotlog: 1, sam_image: 2, sam_video: 1, muse_image: 0, spark_critic: 1 });
    expect(h.runCalls.count).toBe(7);

    // Quality record.
    const quality = AutopilotQualitySchema.parse(result.quality);
    expect(quality.reelMode).toBe("tracked_video");
    expect(quality.planVersion).toBe("autopilot-plan-1");
    expect(quality.mediaAnalyzed).toBe(3);
    expect(quality.mediaExcluded).toBe(0);
    expect(quality.criticVerdict).toBe("blocking_findings");
    expect(quality.findings).toBe(2);
    // The branded photo's pixels are withheld wherever they appear: every kit file rendered from the
    // same source photo, its SAM mask preview and, with a withheld Reel, the tracking overlay of the
    // same footage. The concept archive bundles the withheld files, so it is withheld with them.
    const brandedPhoto = (await readPublicState(outputDir))!.plan!.channelAssets.facebook_ads!;
    expect(quality.withheldFiles).toEqual(expect.arrayContaining(["campaign-concept.zip", "facebook_ads.png", "facebook_ads_portrait.png", `sam-mask-${brandedPhoto}.png`]));
    if (quality.withheldFiles.includes("instagram_reel.mp4")) expect(quality.withheldFiles).toContain("sam-tracking-overlay.mp4");
    const approvable = approvableFiles(result.campaign, quality.withheldFiles).map((file) => file.filename);
    expect(approvable).not.toContain("facebook_ads.png");
    expect(approvable).not.toContain("campaign-concept.zip");
    expect(approvable).not.toContain(`sam-mask-${brandedPhoto}.png`);
    // The other photo's files stay approvable.
    expect(approvable.filter((file) => file.startsWith("sam-mask-"))).toHaveLength(1);
    expect(approvable.some((file) => /^(instagram|facebook|click|whatsapp)_[a-z_0-9]*\.png$/.test(file))).toBe(true);
    expect(quality.notes.join(" ")).toMatch(/built from the same photo or footage/);
    expect(quality.notes.join(" ")).toMatch(/campaign-concept\.zip contains the withheld files/);
    expect(quality.fixesApplied.some((fix) => fix.includes("Withheld facebook_ads"))).toBe(true);
    expect(quality.fixesApplied.some((fix) => fix.includes("instagram_feed body"))).toBe(true);
    expect(quality.roleCounts).toMatchObject({ sam_video: 1, spark_critic: 1 });
    expect(result.usage.model).toBe("muse-spark-1.3");
    expect(result.additionalUsage.map((usage) => usage.model).sort()).toEqual(["muse-spark-1.3", "muse-spark-1.3", "muse-spark-1.3", "sam-3.1", "sam-3.1", "sam-3.1"]);

    // The exported kit: tracked Reel, overlay preview, reports, and the stripped copy.
    const files = result.campaign.assets.map((asset) => asset.filename);
    expect(files).toEqual(expect.arrayContaining(["instagram_reel.mp4", "instagram_reel_cover.png", "sam-tracking-overlay.mp4", "director-report.json", "critic-report.json", "campaign-concept.zip"]));
    expect(files.filter((file) => file.startsWith("sam-mask-"))).toHaveLength(2);
    expect(result.campaign.channels.find((channel) => channel.id === "instagram_feed")!.body).toBe("Morning cups, made slowly.");
    const director = await kitFile(outputDir, "director-report.json");
    const critic = await kitFile(outputDir, "critic-report.json");
    for (const text of [director, critic]) {
      expect(text).not.toContain(root);
      expect(text).not.toContain("output_text");
    }
    const directorJson = JSON.parse(director) as { reel: { mode: string; trackedObject: { label: string } }; segmentation: Array<{ status: string; origin: string }>; budgetRoleCounts: Record<string, number> };
    expect(directorJson.reel.mode).toBe("tracked_video");
    expect(directorJson.reel.trackedObject.label).toBe("synthetic cup");
    expect(directorJson.segmentation.map((record) => record.status)).toEqual(["segmented", "segmented", "tracked"]);
    expect(directorJson.segmentation[0].origin).toBe("spark_grounding");
    const criticJson = JSON.parse(critic) as { verdict: string; withheldFiles: string[]; changedAfterCritique: string[] };
    expect(criticJson.verdict).toBe("blocking_findings");
    expect(criticJson.withheldFiles).toEqual(["facebook_ads.png"]);
    expect(criticJson.changedAfterCritique).toContain("instagram_feed.png");
    // The Reel only received a recommendation (minor visual note): it never "changed after the critique".
    expect(criticJson.changedAfterCritique).not.toContain("instagram_reel.mp4");

    // Director's room: progression, previews and the critic panel.
    expect(h.stages).toEqual(["harvest", "copy", "analyze", "direct", "segment", "reel", "render", "critique", "export"]);
    // Each progress event is observed after the previous step's director's-room state was written.
    expect(h.phases).toEqual([null, "harvest", "copy", "direct", "direct", "segment", "render", "render", "critique"]);
    const state = (await readPublicState(outputDir))!;
    expect(state.phase).toBe("done");
    expect(state.media).toHaveLength(3);
    expect(state.media.every((media) => media.thumb && media.status === "selected")).toBe(true);
    expect(state.plan?.reelMode).toBe("tracked_video");
    expect(state.sam.map((record) => record.status)).toEqual(["segmented", "segmented", "tracked"]);
    expect(state.sam[2].overlayVideo).toBe("sam-overlay.mp4");
    expect(state.critic?.withheld).toEqual(quality.withheldFiles);
    for (const name of [state.media[0].thumb!, state.sam[0].preview!, "sam-overlay.mp4", "reel-cover.jpg"]) expect(await readPublicFile(outputDir, name)).not.toBeNull();
    expect(JSON.stringify(state)).not.toContain(root);
  }, 400_000);

  test("a single official-website image drives a still-depth Reel with website provenance", async () => {
    const h = await harness("website", { website: true, realStillDepth: true });
    const result = await produceAutopilotCampaign(h.input, h.deps);
    expect(result.quality.reelMode).toBe("still_depth");
    expect(result.quality.criticVerdict).toBe("no_blocking_findings");
    expect(result.quality.withheldFiles).toEqual([]);
    // The second critique is the verification critique of the stills the copy fix re-rendered.
    expect(h.calls).toEqual({ copy: 1, media: 1, shotlog: 0, samImage: 1, samVideo: 0, critic: 2 });
    const state = (await readPublicState(h.input.outputDir))!;
    expect(state.sources).toEqual({ officialWebsite: 1, ownerUploads: 0, ownerInstagram: 0, ownerFacebook: 0, connected: false });
    expect(state.media[0]).toMatchObject({ provenance: "official_website", rights: "unknown_review_required", status: "selected" });
    const director = JSON.parse(await kitFile(h.input.outputDir, "director-report.json")) as { reel: { provenanceLabel: string; ledger: { generatedPixelsOnSubject: number } }; sources: { officialWebsite: string }; media: Array<{ sourcePageUrl: string }> };
    expect(director.reel.provenanceLabel).toMatch(/^WEBSITE IMAGE · SAM DEPTH/);
    expect(director.reel.ledger.generatedPixelsOnSubject).toBe(0);
    expect(director.sources.officialWebsite).toBe("https://www.synthetic-cafe-fixture.com/");
    expect(director.media[0].sourcePageUrl).toBe("https://www.synthetic-cafe-fixture.com/");
    expect(result.campaign.reviewNotes.some((note) => note.includes("unknown reuse rights"))).toBe(true);
  }, 400_000);

  test("an exhausted budget skips optional SAM, shot-log and critic steps without paid requests", async () => {
    const h = await harness("budget", { photos: 2, clip: true, caps: { sam_image: 0, spark_shotlog: 0, sam_video: 0, spark_critic: 0 } });
    const result = await produceAutopilotCampaign(h.input, h.deps);
    expect(h.calls).toEqual({ copy: 1, media: 1, shotlog: 0, samImage: 0, samVideo: 0, critic: 0 });
    expect(h.runCalls.count).toBe(2);
    const quality = result.quality;
    expect(quality.reelMode).toBe("legacy");
    expect(quality.criticVerdict).toBe("not_run");
    expect(quality.mediaExcluded).toBe(1);
    expect(quality.notes.join(" ")).toMatch(/shot-log budget/);
    expect(quality.notes.join(" ")).toMatch(/SAM budget/);
    expect(quality.notes.join(" ")).toMatch(/critic budget/);
    const state = (await readPublicState(h.input.outputDir))!;
    expect(state.critic?.verdict).toBe("not_run");
    expect(state.sam.every((record) => record.status === "skipped")).toBe(true);
    expect(state.media.find((media) => media.kind === "video")?.status).toBe("excluded");
    expect(result.campaign.assets.some((asset) => asset.filename === "instagram_reel.mp4")).toBe(true);
  }, 400_000);

  test("a crash after every paid step resumes from checkpoints and stored responses without repeating a paid request", async () => {
    let renders = 0;
    const crashing: AutopilotDependencies["renderKit"] = async (...args) => {
      renders++;
      if (renders === 2) throw new Error("Simulated local crash during export.");
      return defaultAutopilotDependencies.renderKit(...args);
    };
    const h = await harness("resume", { photos: 2, clip: true, renderKit: crashing });
    await expect(produceAutopilotCampaign(h.input, h.deps)).rejects.toBeInstanceOf(AutopilotResumableError);
    expect((await readPublicState(h.input.outputDir))?.phase).toBe("failed");
    const paidBefore = { ...h.calls }, countsBefore = await h.budget.counts(), runBefore = h.runCalls.count;
    expect(paidBefore).toEqual({ copy: 1, media: 1, shotlog: 1, samImage: 2, samVideo: 1, critic: 1 });

    // Remove derived checkpoints so the retry must recover through the adapters' stored responses.
    await rm(join(h.input.outputDir, "autopilot", "analysis.json"));
    await rm(join(h.input.outputDir, "autopilot", "reel.json"));
    await rm(join(h.input.outputDir, "autopilot", "critique.json"));
    h.deps.renderKit = defaultAutopilotDependencies.renderKit;
    const result = await produceAutopilotCampaign(h.input, h.deps);
    // The only new paid request is the verification critique, which follows the (crashed) final export.
    expect(h.calls).toEqual({ ...paidBefore, critic: 2 });
    expect(await h.budget.counts()).toEqual({ ...countsBefore, spark_critic: 2 });
    expect(h.runCalls.count).toBe(runBefore + 1);
    expect(result.quality.reelMode).toBe("tracked_video");
    expect(result.additionalUsage.length).toBeGreaterThanOrEqual(5);
    expect((await readPublicState(h.input.outputDir))?.phase).toBe("done");
    // A further pass reuses the verification critique too.
    await produceAutopilotCampaign(h.input, h.deps);
    expect(h.calls).toEqual({ ...paidBefore, critic: 2 });
  }, 400_000);

  test("removable review wording in the Reel copy re-renders the Reel into its own files, and a crash during export resumes without repeating a paid request", async () => {
    let renders = 0;
    const crashing: AutopilotDependencies["renderKit"] = async (...args) => {
      renders++;
      if (renders === 2) throw new Error("Simulated local crash during the final export.");
      return defaultAutopilotDependencies.renderKit(...args);
    };
    const h = await harness("reel-revision", { photos: 2, clip: true, reelDraft: true, renderKit: crashing });
    await expect(produceAutopilotCampaign(h.input, h.deps)).rejects.toBeInstanceOf(AutopilotResumableError);
    const paidBefore = { ...h.calls }, countsBefore = await h.budget.counts(), runBefore = h.runCalls.count;
    expect(paidBefore).toEqual({ copy: 1, media: 1, shotlog: 1, samImage: 2, samVideo: 1, critic: 1 });
    const autopilot = join(h.input.outputDir, "autopilot");
    const critiquedReel = await readFile(join(autopilot, "reel.json"), "utf8");

    h.deps.renderKit = defaultAutopilotDependencies.renderKit;
    const result = await produceAutopilotCampaign(h.input, h.deps);
    // Only the verification critique of the re-rendered files is new (it follows the final export).
    expect(h.calls).toEqual({ ...paidBefore, critic: 2 });
    expect(await h.budget.counts()).toEqual({ ...countsBefore, spark_critic: 2 });
    expect(h.runCalls.count).toBe(runBefore + 1);
    // The re-rendered Reel was re-critiqued in its final bytes.
    const reelAsset = result.campaign.assets.find((asset) => asset.filename === "instagram_reel.mp4")!;
    expect(h.criticRequests[1].reel?.sha256).toBe(reelAsset.sha256);
    // The critiqued Reel's record and files are untouched; the revision has its own.
    expect(await readFile(join(autopilot, "reel.json"), "utf8")).toBe(critiquedReel);
    for (const name of ["reel-revised.json", "reel/tracked-revised.mp4", "reel/tracked-revised-cover.png", "reel/tracked.mp4"]) expect((await lstat(join(autopilot, name))).isFile()).toBe(true);
    expect(result.quality.reelMode).toBe("tracked_video");
    expect(result.quality.fixesApplied.some((fix) => fix.includes("instagram_reels body"))).toBe(true);
    expect(result.campaign.channels.find((channel) => channel.id === "instagram_reels")!.body).toBe("Reel cups, made slowly.");
    expect(result.campaign.assets.some((asset) => asset.filename === "instagram_reel.mp4")).toBe(true);
    const critic = JSON.parse(await kitFile(h.input.outputDir, "critic-report.json")) as { changedAfterCritique: string[] };
    expect(critic.changedAfterCritique).toContain("instagram_reel.mp4");

    // A third, uninterrupted pass over the same checkpoints also completes without paying again.
    await produceAutopilotCampaign(h.input, h.deps);
    expect(h.calls).toEqual({ ...paidBefore, critic: 2 });
  }, 400_000);

  test("excluded website images never come back as a hero through the visual stage", async () => {
    const possibleMinor = [{ kind: "possible_minor", box: null, note: "A synthetic small figure." }];
    const h = await harness("excluded-website", { website: true, imageRisks: possibleMinor });
    const visualWebsites: Array<string | null | undefined> = [];
    let collected = 0;
    h.deps.prepareVisual = (input) => {
      visualWebsites.push(input.business.website);
      return prepareCampaignVisual(input, {
        collectMedia: async () => { collected++; throw new Error("The visual stage must not read the website again."); },
        generateImage: async () => {
          const bytes = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: "#c8a26b" } }).png().toBuffer();
          return { bytes, mimeType: "image/png", width: 1024, height: 1536, sha256: "0".repeat(64), model: "muse-image-1.0", endpoint: "/images/generations", createdAt: null, usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
            provenance: { kind: "meta_generated_illustration", originalBusinessPhoto: false, referencePreservationVerified: false, referenceAssetIds: [], promptSha256: "0".repeat(64), implicitSearchEnabled: false, externalImageDownloads: false, requiresOwnerReview: true } };
        },
      });
    };
    const result = await produceAutopilotCampaign(h.input, h.deps);
    expect(visualWebsites).toEqual([null]);
    expect(collected).toBe(0);
    expect(result.quality.mediaExcluded).toBe(1);
    expect(result.quality.reelMode).toBe("illustration");
    expect(result.campaign.visual?.kind).toBe("meta_illustration");
    // SAM only ever sees the labelled illustration, never the excluded website photo.
    expect(h.calls.samImage).toBe(1);
    expect(h.segmentRequests.map((request) => [request.sourceAssetId, request.sourceProvenance])).toEqual([[ILLUSTRATION_ASSET_ID, "meta_illustration"]]);
    const state = (await readPublicState(h.input.outputDir))!;
    expect(state.media[0]).toMatchObject({ provenance: "official_website", status: "excluded" });
  }, 400_000);

  test("a tracked footage Reel with every photo excluded declares text-led stills, not a source photo", async () => {
    const possibleMinor = [{ kind: "possible_minor", box: null, note: "A synthetic small figure." }];
    const h = await harness("footage-only", { photos: 2, clip: true, imageRisks: possibleMinor });
    let visuals = 0;
    h.deps.prepareVisual = async () => { visuals++; throw new Error("No illustration is needed when footage carries the Reel."); };
    const result = await produceAutopilotCampaign(h.input, h.deps);
    expect(visuals).toBe(0);
    expect(result.quality.reelMode).toBe("tracked_video");
    expect(result.quality.mediaExcluded).toBe(2);
    expect(result.campaign.visual?.kind).toBe("typography");
    expect(result.quality.notes.join(" ")).toMatch(/only the Reel uses real media/);
    expect(h.calls).toMatchObject({ samImage: 0, samVideo: 1 });
  }, 400_000);

  test("owner footage whose sampled frames show a possible minor is never tracked, even with recorded consent", async () => {
    const possibleMinor = [{ kind: "possible_minor", box: null, note: "A synthetic small figure." }];
    const h = await harness("footage-minor", { photos: 1, clip: true, frameRisks: possibleMinor });
    const result = await produceAutopilotCampaign(h.input, h.deps);
    // The frames went through the same paid image-analysis request as the photo; no shot log or SAM video follows.
    expect(h.calls).toMatchObject({ media: 1, shotlog: 0, samVideo: 0 });
    expect(result.quality.reelMode).toBe("still_depth");
    expect(result.quality.mediaExcluded).toBe(1);
    const director = JSON.parse(await kitFile(h.input.outputDir, "director-report.json")) as { reel: { mode: string } };
    expect(director.reel.mode).toBe("still_depth");
    const state = (await readPublicState(h.input.outputDir))!;
    expect(state.media.find((media) => media.kind === "video")).toMatchObject({ status: "excluded" });
  }, 400_000);

  test("without usable media the campaign uses one labelled Muse illustration, and typography once that budget is gone", async () => {
    let images = 0;
    const withIllustration = async (caps?: Partial<Record<AutopilotRole, number>>, name = "illustration", configure?: (h: Harness) => void) => {
      const h = await harness(name, { caps });
      configure?.(h);
      h.deps.prepareVisual = (input) => prepareCampaignVisual(input, { generateImage: async () => {
        images++;
        const bytes = await sharp({ create: { width: 1024, height: 1536, channels: 3, background: "#c8a26b" } }).png().toBuffer();
        return { bytes, mimeType: "image/png", width: 1024, height: 1536, sha256: "0".repeat(64), model: "muse-image-1.0", endpoint: "/images/generations", createdAt: null, usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
          provenance: { kind: "meta_generated_illustration", originalBusinessPhoto: false, referencePreservationVerified: false, referenceAssetIds: [], promptSha256: "0".repeat(64), implicitSearchEnabled: false, externalImageDownloads: false, requiresOwnerReview: true } };
      } });
      return { h, result: await produceAutopilotCampaign(h.input, h.deps) };
    };
    const { h, result } = await withIllustration();
    expect(images).toBe(1);
    expect(result.quality.reelMode).toBe("illustration");
    expect(result.campaign.visual?.kind).toBe("meta_illustration");
    expect(result.additionalUsage.map((usage) => usage.model)).toContain("muse-image-1.0");
    expect((await h.budget.counts()).muse_image).toBe(1);
    expect((await readPublicState(h.input.outputDir))?.plan).toMatchObject({ heroAssetId: null, reelMode: "illustration" });
    // SAM 3.1 concept-segments the labelled illustration (the brief's offering as the phrase), and the
    // Reel is its depth Reel, still labelled an illustrative image, not the flat legacy slideshow.
    expect(h.calls.samImage).toBe(1);
    expect((await h.budget.counts()).sam_image).toBe(1);
    expect(h.segmentRequests).toHaveLength(1);
    expect(h.segmentRequests[0]).toMatchObject({ prompt: "Flat white", sourceAssetId: ILLUSTRATION_ASSET_ID, sourceProvenance: "meta_illustration" });
    expect(h.segmentRequests[0].geometry).toBeUndefined();
    const illustrated = JSON.parse(await kitFile(h.input.outputDir, "director-report.json")) as { reel: { mode: string; provenanceLabel: string; ledger: unknown } };
    expect(illustrated.reel).toMatchObject({ mode: "illustration", provenanceLabel: ILLUSTRATION_REEL_LABEL });
    expect(illustrated.reel.ledger).not.toBeNull();
    const illustratedState = (await readPublicState(h.input.outputDir))!;
    expect(illustratedState.sam).toEqual([expect.objectContaining({ assetId: ILLUSTRATION_ASSET_ID, media: "image", promptKind: "concept", origin: "concept_prompt", status: "segmented", preview: `mask-${ILLUSTRATION_ASSET_ID}.png` })]);
    expect(await readPublicFile(h.input.outputDir, `mask-${ILLUSTRATION_ASSET_ID}.png`)).not.toBeNull();
    expect(result.campaign.assets.map((asset) => asset.filename)).toEqual(expect.arrayContaining(["instagram_reel.mp4", "instagram_reel_cover.png", `sam-mask-${ILLUSTRATION_ASSET_ID}.png`]));
    expect(result.campaign.reviewNotes.join(" ")).toMatch(/labelled AI illustration with a SAM 3\.1 cutout/);
    // A second pass reuses the stored SAM selection and the saved depth Reel.
    await produceAutopilotCampaign(h.input, h.deps);
    expect(h.calls.samImage).toBe(1);
    expect(images).toBe(1);

    // SAM finds nothing usable in the illustration: the legacy in-kit Reel remains, still labelled.
    const noMatch = await withIllustration(undefined, "illustration-no-match", (target) => {
      target.deps.segment = (request, dependencies) => segmentMetaImage(request, { ...dependencies, client: fakeClient(() => { target.calls.samImage++; target.segmentRequests.push(request); return samResponse(""); }) });
    });
    expect(images).toBe(2);
    expect(noMatch.h.calls.samImage).toBe(1);
    expect(noMatch.result.quality.reelMode).toBe("illustration");
    const fallback = JSON.parse(await kitFile(noMatch.h.input.outputDir, "director-report.json")) as { reel: { provenanceLabel: string | null } };
    expect(fallback.reel.provenanceLabel).toBeNull();
    expect(noMatch.result.campaign.assets.some((asset) => asset.filename === "instagram_reel.mp4")).toBe(true);
    expect(noMatch.result.quality.notes.join(" ")).toMatch(/the Reel uses composed crops of the illustration/);
    expect((await readPublicState(noMatch.h.input.outputDir))!.sam).toEqual([expect.objectContaining({ assetId: ILLUSTRATION_ASSET_ID, status: "no_match", preview: null })]);

    const typography = await withIllustration({ muse_image: 0 }, "typography");
    expect(images).toBe(2);
    expect(typography.result.quality.reelMode).toBe("legacy");
    expect(typography.result.campaign.visual?.kind).toBe("typography");
    expect(typography.h.calls.samImage).toBe(0);
    expect(typography.result.quality.notes.join(" ")).toMatch(/illustration budget/);
  }, 400_000);

  test("files changed by the critic's fixes get one verification critique bound to their final bytes, whose critical finding withholds them", async () => {
    const h = await harness("recheck", { photos: 1, recheckFindings: [{ assetId: "instagram_feed", severity: "critical", rule: "unreadable_text", description: "Synthetic unreadable headline.", box: null, timeSeconds: null }] });
    const result = await produceAutopilotCampaign(h.input, h.deps);
    // One first critique, then exactly one verification critique (never a loop).
    expect(h.calls.critic).toBe(2);
    expect((await h.budget.counts()).spark_critic).toBe(2);
    const critic = JSON.parse(await kitFile(h.input.outputDir, "critic-report.json")) as { verdict: string; changedAfterCritique: string[]; critiquedFiles: Array<{ filename: string; sha256: string }> };
    expect(critic.verdict).toBe("no_blocking_findings");
    expect(critic.changedAfterCritique).toContain("instagram_feed.png");
    // The verification critique saw exactly the changed files, bound to their final (new) bytes.
    const [first, second] = h.criticRequests;
    expect(second.assets.map((asset) => asset.filename).sort()).toEqual([...critic.changedAfterCritique].filter((file) => file.endsWith(".png")).sort());
    for (const asset of second.assets) {
      expect(asset.sha256).toBe(result.campaign.assets.find((item) => item.filename === asset.filename)!.sha256);
      expect(asset.sha256).not.toBe(first.assets.find((item) => item.filename === asset.filename)!.sha256);
    }
    // Its critical finding withholds the file (and the archive bundling it); the verdict is the worse of both.
    expect(result.quality.criticVerdict).toBe("blocking_findings");
    expect(result.quality.findings).toBe(1);
    expect(result.quality.withheldFiles).toEqual(expect.arrayContaining(["instagram_feed.png", "campaign-concept.zip"]));
    expect(approvableFiles(result.campaign, result.quality.withheldFiles).map((file) => file.filename)).not.toContain("instagram_feed.png");
    expect(result.quality.fixesApplied.some((fix) => fix.startsWith("Verification critique: Withheld instagram_feed"))).toBe(true);
    expect(result.quality.notes[0]).toMatch(/^A verification critique re-checked \d+ changed files? in (its|their) final version: it reported blocking problems; .*instagram_feed\.png/);
    const state = (await readPublicState(h.input.outputDir))!;
    expect(state.critic?.verdict).toBe("blocking_findings");
    expect(state.critic?.findings.map((finding) => finding.id)).toEqual(["r2-f1"]);
    expect(state.critic?.withheld).toEqual(result.quality.withheldFiles);
    // A retry reuses the stored verification critique.
    await produceAutopilotCampaign(h.input, h.deps);
    expect(h.calls.critic).toBe(2);

    // No critic budget left after the first critique: the changed files keep the "not re-critiqued" note.
    const exhausted = await harness("recheck-exhausted", { photos: 1, caps: { spark_critic: 1 } });
    const unchecked = await produceAutopilotCampaign(exhausted.input, exhausted.deps);
    expect(exhausted.calls.critic).toBe(1);
    expect(unchecked.quality.criticVerdict).toBe("no_blocking_findings");
    expect(unchecked.quality.notes.join(" ")).toMatch(/files changed after the critique were not re-critiqued/);
    expect(unchecked.quality.withheldFiles).toEqual([]);
  }, 400_000);

  test("a critical finding the critic could not attribute to one file withholds the whole kit from approval", async () => {
    const h = await harness("unattributed", {
      photos: 1,
      findings: [{ assetId: "instagram_feed_final.png", severity: "critical", rule: "person_without_consent", description: "A synthetic identifiable face.", box: null, timeSeconds: null }],
    });
    const result = await produceAutopilotCampaign(h.input, h.deps);
    expect(result.quality.criticVerdict).toBe("blocking_findings");
    expect(result.quality.findings).toBe(0);
    expect(result.quality.withheldFiles).toEqual(result.campaign.assets.map((asset) => asset.filename).sort());
    expect(approvableFiles(result.campaign, result.quality.withheldFiles)).toEqual([]);
    expect(result.quality.notes.join(" ")).toMatch(/could not attribute to one file, so every file is withheld/);
    expect((await readPublicState(h.input.outputDir))?.critic?.withheld).toEqual(result.quality.withheldFiles);
  }, 400_000);

  test("a paid step that fails with an unknown outcome is never reported as a safe retry, and is not repeated", async () => {
    const h = await harness("copy-lost", {});
    h.deps.ensureCopy = async (_input, copyOptions) => {
      await copyOptions?.reserveCopyCall?.();
      h.calls.copy++;
      // As copy.ts does for a response Meta did not complete: thrown before anything is stored.
      throw new Error("Meta did not complete the campaign draft.");
    };
    await expect(produceAutopilotCampaign(h.input, h.deps)).rejects.toBeInstanceOf(AutopilotPaidStepError);
    // A retry finds no stored copy, and the role cap refuses a second paid copy request.
    await expect(produceAutopilotCampaign(h.input, h.deps)).rejects.toBeInstanceOf(AutopilotBudgetError);
    expect(h.calls.copy).toBe(1);
    expect(h.runCalls.count).toBe(1);

    // The illustration step: its response is lost after the paid request (for example an undecodable image).
    const visual = await harness("visual-lost", {});
    let images = 0;
    visual.deps.prepareVisual = async (input) => {
      if (images === 0) await input.reserveModelCall?.();
      images++;
      throw new Error(images === 1 ? "Input buffer contains unsupported image format" : "A Muse image request for this campaign was started but its response is not stored.");
    };
    await expect(produceAutopilotCampaign(visual.input, visual.deps)).rejects.toBeInstanceOf(AutopilotPaidStepError);
    await expect(produceAutopilotCampaign(visual.input, visual.deps)).rejects.toBeInstanceOf(AutopilotPaidStepError);
    expect((await visual.budget.counts()).muse_image).toBe(1);
  }, 400_000);

  test("a lost lease stops before the first paid request", async () => {
    const h = await harness("lease", { photos: 1 });
    h.input.leaseLost = () => true;
    await expect(produceAutopilotCampaign(h.input, h.deps)).rejects.toThrow(/lease was lost/);
    expect(h.calls).toEqual(zeroCalls());
    expect(h.runCalls.count).toBe(0);
  }, 120_000);
});

describe("Autopilot pipeline helpers", () => {
  test("only an official website is read; Maps, social and listing links stay references", () => {
    expect(officialWebsiteFor({ website: "https://maps.app.goo.gl/AbCdEf123" }, [])).toBeNull();
    expect(officialWebsiteFor({ website: "https://www.instagram.com/synthetic.cafe/" }, [])).toBeNull();
    expect(officialWebsiteFor({ website: "https://www.google.com/maps/place/Synthetic" }, [{ kind: "official_website", url: "https://www.synthetic-cafe-fixture.com/menu" }])).toBe("https://www.synthetic-cafe-fixture.com/menu");
    expect(officialWebsiteFor({ website: null }, [{ kind: "competitor", url: "https://competitor-fixture.com/" }])).toBeNull();
  });

  test("harvest selection caps media and prefers recent owner media over website images", () => {
    const asset = (id: number, kind: "image" | "video", provenance: MediaAssetRecord["provenance"], addedAt: string): MediaAssetRecord => ({
      id: `asset_${String(id).padStart(24, "0")}`, kind, provenance, rights: provenance === "official_website" ? "unknown_review_required" : "owner_attested", sha256: String(id).padStart(64, "0"), bytes: 10,
      width: 640, height: 480, durationSeconds: kind === "video" ? 3 : null, mimeType: kind === "video" ? "video/mp4" : "image/png", dHash: kind === "video" ? null : "0".repeat(16),
      sourceUrl: null, sourcePageUrl: null, sourceId: null, caption: null, capturedAt: null, addedAt, consent: null, hints: { pageRole: null, productName: null, originalName: null }, duplicates: [], localPath: "/synthetic",
    });
    const assets = [
      ...Array.from({ length: 30 }, (_, index) => asset(index, "image", "official_website", `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`)),
      ...Array.from({ length: 15 }, (_, index) => asset(100 + index, "image", "owner_upload", `2026-02-01T00:00:${String(index).padStart(2, "0")}Z`)),
      ...Array.from({ length: 6 }, (_, index) => asset(200 + index, "video", "owner_upload", `2026-03-01T00:00:${String(index).padStart(2, "0")}Z`)),
    ];
    const { selected, overflow } = selectHarvest(assets);
    expect(selected.filter((item) => item.kind === "image")).toHaveLength(40);
    expect(selected.filter((item) => item.kind === "video").map((item) => item.addedAt)).toEqual(["2026-03-01T00:00:05Z", "2026-03-01T00:00:04Z", "2026-03-01T00:00:03Z", "2026-03-01T00:00:02Z"]);
    expect(selected[0].provenance).toBe("owner_upload");
    expect(selected[0].addedAt).toBe("2026-02-01T00:00:14Z");
    expect(selected.filter((item) => item.provenance === "official_website")).toHaveLength(25);
    expect(overflow).toEqual({ images: 5, videos: 2 });
  });

  test("the hero track is the longest steady, sizeable track", () => {
    const objects = [
      { objectId: "1", framesPresent: 90, meanCoverage: 0.02, label: "a" },
      { objectId: "2", framesPresent: 80, meanCoverage: 0.2, label: "b" },
      { objectId: "3", framesPresent: 20, meanCoverage: 0.9, label: "c" },
    ];
    expect(heroTrack(objects, 90)?.objectId).toBe("2");
    expect(heroTrack([{ objectId: "1", framesPresent: 90, meanCoverage: 0.001, label: "a" }], 90)).toBeNull();
  });

  test("withholding the Reel withholds its cover, and copy fixes only delete listed wording", () => {
    const snapshot: CritiqueSnapshot = { version: 1, stills: [{ assetId: "instagram_feed", filename: "instagram_feed.png", channel: "instagram_feed", sha256: "a".repeat(64), width: 1080, height: 1350, path: "/synthetic" }], reel: { filename: "instagram_reel.mp4", sha256: "b".repeat(64), path: "/synthetic", durationSeconds: 12, width: 1080, height: 1920 }, notes: [] };
    const report = {
      rulesVersion: "critic-1", boundAssets: [{ assetId: "instagram_feed", filename: "instagram_feed.png", sha256: "a".repeat(64), kind: "still", channel: "instagram_feed" }, { assetId: "reel", filename: "instagram_reel.mp4", sha256: "b".repeat(64), kind: "reel", channel: "instagram_reels" }],
      findings: [{ id: "f1", assetId: "reel", assetKind: "reel", severity: "critical", rule: "unapproved_offer", description: "Synthetic.", gridBox: null, box: null, boxBasis: null, boxRejected: false, timeSeconds: 3, timeRejected: false }],
      discardedFindings: [], verdict: "blocking_findings",
    } as unknown as CritiqueReport;
    const fixes = applyDeterministicFixes(report, copyFixture(), snapshot);
    expect(fixes.withheldFiles).toEqual(["instagram_reel.mp4", "instagram_reel_cover.png"]);
    expect(fixes.copyChanged).toBe(true);
    expect(fixes.reelCopyChanged).toBe(false);
    expect(fixes.copy.channels.find((channel) => channel.id === "instagram_feed")!.body).toBe("Morning cups, made slowly.");
    expect(applyDeterministicFixes(null, copyFixture(), snapshot)).toMatchObject({ plan: null, withheldFiles: [], copyChanged: false });
  });
});
