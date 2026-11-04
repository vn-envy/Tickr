import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, test, vi } from "vitest";
import { buildGroundedImagePrompt, illustrationSubjectPhrase, prepareCampaignVisual, type PrepareCampaignVisualInput } from "../../lib/campaign/visual";
import type { CampaignCopy } from "../../lib/campaign/copy";
import type { MetaImageResult } from "../../lib/meta/image";
import { generateMetaImage } from "../../lib/meta/image";
import type { MetaClient } from "../../lib/meta/client";
import type { MediaAcquisitionResult } from "../../lib/media";
import { hashBytes } from "../../lib/campaign/archive";

function input(outputDir: string): PrepareCampaignVisualInput {
  return {
    business: { id: "fixture", name: "Fixture Bakery", locality: "", website: null, vertical: "bakery", goal: "A fixture test" },
    copy: { creativeBrief: {
      focus: { offeringId: "brownie", name: "Cocoa brownie", description: "A reported cocoa brownie", evidenceIds: ["e1"], sourceIds: ["s1"] },
      brandStory: { signalIds: [], narrative: "Family baking", evidenceIds: ["e1"], sourceIds: ["s1"] },
      visualDirection: { status: "proposed", description: "Hand-painted bakery illustration", palette: ["#fff4e8", "#332020", "#cc5533"], sourceIds: [] },
      scenes: ["hook", "proof", "occasion", "action"].map((role) => ({ role, headline: "Fixture", body: "Fixture" })),
    } } as unknown as CampaignCopy,
    enrichment: { status: "enriched", businessId: "fixture", offerings: [{ id: "brownie", name: "Cocoa brownie", description: "Cocoa brownie described on the menu", sourceIds: ["s1"] }], brandSignals: [], sourceIds: ["s1"], warnings: [], unknowns: [], queries: [], completedToolCalls: 1, enrichedAt: "2026-11-02T00:00:00Z" },
    sources: [{ id: "s1", kind: "business_coverage", title: "Fixture menu", url: "https://fixture.example.org/menu", text: "Cocoa brownie", acquisition: "meta_cited_summary", retrievedAt: "2026-11-02T00:00:00Z" }],
    mode: "live", outputDir, reserveModelCall: vi.fn(async () => {}),
  };
}
async function result(): Promise<MetaImageResult> {
  const bytes = await sharp({ create: { width: 64, height: 96, channels: 3, background: "#cc5533" } }).png().toBuffer();
  return { bytes, mimeType: "image/png", width: 64, height: 96, sha256: "fixture", model: "muse-image-1.0", endpoint: "/images/generations", createdAt: null, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, provenance: { kind: "meta_generated_illustration", originalBusinessPhoto: false, referencePreservationVerified: false, referenceAssetIds: [], promptSha256: "fixture", implicitSearchEnabled: false, externalImageDownloads: false, requiresOwnerReview: true } };
}

describe("grounded campaign visuals", () => {
  test("prompt uses the sourced offering; unknown products only permit a generic category item", () => {
    const fixture = input("/tmp");
    expect(buildGroundedImagePrompt(fixture)).toContain("Cocoa brownie described on the menu");
    fixture.copy.creativeBrief!.focus.offeringId = null;
    fixture.enrichment = { ...fixture.enrichment!, offerings: [] };
    // Without any discovered offering: a generic, unbranded example of the category (quoted as data), never an invented product.
    const generic = buildGroundedImagePrompt(fixture);
    expect(generic).toContain('item typical of this business category: "bakery"');
    expect(generic).toContain("do not invent a signature product");
    expect(generic).toContain("Do not depict people, hands, premises, storefronts, founder portraits or invented logos");
    expect(generic).not.toContain("Cocoa brownie");
    // No example of a different product biases the image model (a "loaf" example drew bread for a brownie campaign).
    expect(generic).not.toMatch(/\bloaf\b|\bbread\b|for example, an unbranded/i);
    expect(buildGroundedImagePrompt(fixture)).toBe(generic);
    expect(illustrationSubjectPhrase(fixture)).toBe("bakery item");
  });

  // Live regression (patisserie selling brownies and cheesecake): a story-led brief (no offering id)
  // must not fall back to a generic bakery example; the generic item is of the reported kind.
  function storyLedPatisserie() {
    const fixture = input("/tmp");
    fixture.business = { ...fixture.business, vertical: "bakery" };
    fixture.copy.creativeBrief!.focus = { ...fixture.copy.creativeBrief!.focus, offeringId: null, name: "Taste of home", description: "Our cheesecakes and brownies, baked like at home." };
    fixture.enrichment = { ...fixture.enrichment!, offerings: [
      { id: "brownie", name: "Fudge Brownie", description: "Rich cocoa brownie with walnuts and a salted caramel drizzle.", sourceIds: ["s1"] },
      { id: "cheesecake", name: "Baked New York Cheesecake", description: "Classic baked cheesecake.", sourceIds: ["s1"] },
    ] };
    return fixture;
  }

  test("a story-led focus that names a reported offering kind illustrates a generic item of that kind", () => {
    const fixture = storyLedPatisserie();
    const prompt = buildGroundedImagePrompt(fixture);
    // Both offerings are named by head word; the longer whole-name match would win, otherwise research order.
    expect(prompt).toContain('this kind of item, which the business is reported to offer: "Fudge Brownie"');
    expect(prompt).toContain("Depict exactly that kind of item");
    expect(prompt).toContain("Do not show any other kind of product");
    expect(prompt).toContain("do not invent a signature product or recipe, distinctive decorations, fillings, toppings, garnishes, packaging, labels, prices or brand cues");
    expect(prompt).toContain("hand-painted illustrative treatment, never photorealistic");
    expect(prompt).not.toMatch(/\bloaf\b|\bbread\b/i);
    expect(prompt).not.toContain("typical of this business category");
    // Only the generic kind is named: the offering's unverified details (toppings, drizzle) are never asked for.
    expect(prompt).not.toContain("salted caramel");
    expect(prompt).toContain("This image will be labelled an AI illustration for review, never original business photography.");
    // The SAM concept phrase names the same subject the prompt asks for.
    expect(illustrationSubjectPhrase(fixture)).toBe("Fudge Brownie");

    fixture.copy.creativeBrief!.focus.description = "Celebrate with a classic baked New York cheesecake.";
    expect(buildGroundedImagePrompt(fixture)).toContain('reported to offer: "Baked New York Cheesecake"');
    expect(illustrationSubjectPhrase(fixture)).toBe("Baked New York Cheesecake");
    fixture.copy.creativeBrief!.focus = { ...fixture.copy.creativeBrief!.focus, name: "Cheesecakes", description: "Slices for the weekend." };
    expect(illustrationSubjectPhrase(fixture)).toBe("Baked New York Cheesecake");
  });

  test("a focus that names no offering still illustrates a reported offering kind, never a category example", () => {
    const fixture = storyLedPatisserie();
    fixture.copy.creativeBrief!.focus = { ...fixture.copy.creativeBrief!.focus, name: "Taste of home", description: "A family recipe story." };
    expect(buildGroundedImagePrompt(fixture)).toContain('reported to offer: "Fudge Brownie"');
    expect(illustrationSubjectPhrase(fixture)).toBe("Fudge Brownie");
  });

  test("the saved illustration description says a generic kind is not the real product", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tickr-visual-kind-"));
    try {
      const fixture = { ...storyLedPatisserie(), outputDir: dir };
      const prompts: string[] = [];
      const generateImage = vi.fn(async (request: { prompt: string }) => { prompts.push(request.prompt); return result(); });
      const prepared = await prepareCampaignVisual(fixture, { generateImage });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('reported to offer: "Fudge Brownie"');
      expect(prepared.visual.kind).toBe("meta_illustration");
      expect(prepared.visual.description).toContain("generic, unbranded example of a reported offering kind (“Fudge Brownie”)");
      expect(prepared.visual.description).toContain("not the business's real product");
      expect(prepared.image?.provenance).toBe("meta_illustration");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("reuses exact generated bytes and usage without paying again, and rejects changed bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tickr-visual-"));
    try {
      const fixture = input(dir);
      const generateImage = vi.fn(result);
      const first = await prepareCampaignVisual(fixture, { generateImage });
      expect(first.visual.kind).toBe("meta_illustration");
      expect(first.visual.sourceUrls).toEqual(["https://fixture.example.org/menu"]);
      const second = await prepareCampaignVisual({ ...fixture, reuseCompletedOnly: true }, { generateImage });
      expect(Buffer.from(second.image!.bytes)).toEqual(Buffer.from(first.image!.bytes));
      expect(generateImage).toHaveBeenCalledTimes(1);
      expect(fixture.reserveModelCall).toHaveBeenCalledTimes(1);
      await writeFile(join(dir, first.visual.filename!), "corrupt image");
      await expect(prepareCampaignVisual(fixture, { generateImage })).rejects.toThrow("changed");
      expect(generateImage).toHaveBeenCalledTimes(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("an unsuccessful paid image becomes an explicit saved fallback and is never retried", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tickr-visual-failure-"));
    try {
      const fixture = input(dir);
      const generateImage = vi.fn(async () => { throw new Error("upstream failed"); });
      const first = await prepareCampaignVisual(fixture, { generateImage });
      expect(first.visual.kind).toBe("typography");
      expect(first.visual.warnings.join(" ")).toContain("not retried");
      expect(first.usage?.inputTokens).toBeNull();
      await prepareCampaignVisual(fixture, { generateImage });
      expect(generateImage).toHaveBeenCalledTimes(1);
      const saved = JSON.parse(await readFile(join(dir, "visual-checkpoint.json"), "utf8"));
      saved.state = "requested";
      await writeFile(join(dir, "visual-checkpoint.json"), JSON.stringify(saved));
      await expect(prepareCampaignVisual(fixture, { generateImage })).rejects.toThrow("uncertain outcome");
      expect(generateImage).toHaveBeenCalledTimes(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("render-only recovery cannot start a new image request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tickr-visual-missing-"));
    try {
      const fixture = { ...input(dir), reuseCompletedOnly: true };
      const generateImage = vi.fn(result);
      await expect(prepareCampaignVisual(fixture, { generateImage })).rejects.toThrow("completed visual checkpoint");
      expect(generateImage).not.toHaveBeenCalled();
      expect(fixture.reserveModelCall).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("uses the exact product-labelled original and does not generate replacement pixels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tickr-source-image-"));
    try {
      const fixture = input(dir);
      fixture.business.website = "https://fixture.example.org/";
      const original = await result();
      const originalPath = join(dir, "source.png");
      await writeFile(originalPath, original.bytes);
      const metadata: MediaAcquisitionResult = { status: "acquired", sourcePageUrl: fixture.business.website, candidates: [], warnings: [], retrievedAt: "2026-11-02", localFiles: { original: originalPath }, acquired: [{ id: "original", candidateId: "candidate", kind: "page_image", label: "Cocoa brownie", productName: null, sourcePageUrl: fixture.business.website, sourceUrl: "https://fixture.example.org/brownie.png", retrievedAt: "2026-11-02", sourceMimeType: "image/png", mimeType: "image/png", filename: "source.png", width: 64, height: 96, bytes: original.bytes.length, sha256: hashBytes(original.bytes), sourceSha256: hashBytes(original.bytes), normalization: "auto_orient_and_fit_1600_png", rights: "unknown", usage: "private_concept_review", requiresPublicationReview: true }] };
      const generateImage = vi.fn(result);
      const visual = await prepareCampaignVisual(fixture, { collectMedia: async () => metadata, generateImage });
      expect(visual.visual.kind).toBe("source_photo");
      expect(Buffer.from(visual.image!.bytes)).toEqual(original.bytes);
      expect(visual.visual.sourceUrls).toContain("https://fixture.example.org/brownie.png");
      expect(visual.visual.warnings.join(" ")).toContain("original is small");
      expect(generateImage).not.toHaveBeenCalled();
      expect(fixture.reserveModelCall).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

test("Meta image adapter disables hidden source search and refuses URL-only outputs", async () => {
  const generated = await result();
  const requestJson = vi.fn(async (_path: string, _options: unknown) => {
    void _path; void _options;
    return { data: [{ b64_json: generated.bytes.toString("base64") }], output_format: "png" };
  });
  const image = await generateMetaImage({ prompt: "Fixture illustration" }, { client: { requestJson } as unknown as Pick<MetaClient, "requestJson"> });
  expect(image.provenance.originalBusinessPhoto).toBe(false);
  expect(requestJson.mock.calls[0]?.[1]).toMatchObject({ body: { n: 1, tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false } } });
  await expect(generateMetaImage({ prompt: "Fixture illustration" }, { client: { requestJson: async () => ({ data: [{ url: "https://untrusted.example/image.png" }] }) } as unknown as Pick<MetaClient, "requestJson"> })).rejects.toThrow("inline image");
});
