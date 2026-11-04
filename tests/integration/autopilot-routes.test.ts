import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

/**
 * Offline route tests for owner media, the Meta connection and the Autopilot director's room.
 * Handlers are called directly with Request objects. Every fixture is synthetic (sharp shapes and
 * an FFmpeg lavfi test pattern); the Meta code exchange is replaced by an injected fake, and no
 * request leaves the process.
 */

const known = vi.hoisted(() => ({ businesses: new Set<string>(), runs: new Set<string>(), activeRunBusinesses: new Set<string>() }));
vi.mock("../../lib/db", () => ({
  db: {
    business: { findUnique: async ({ where }: { where: { id: string } }) => known.businesses.has(where.id) ? { id: where.id } : null },
    run: {
      findUnique: async ({ where }: { where: { id: string } }) => known.runs.has(where.id) ? { id: where.id } : null,
      findFirst: async ({ where }: { where: { businessId: string; status: { in: string[] } } }) =>
        known.activeRunBusinesses.has(where.businessId) && where.status.in.includes("queued") && where.status.in.includes("running") ? { id: "active-run" } : null,
    },
  },
}));
const graph = vi.hoisted(() => ({ exchange: vi.fn(), sources: vi.fn(), revoke: vi.fn() }));
vi.mock("../../lib/meta/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/meta/graph")>()),
  exchangeCodeForToken: graph.exchange,
  listOwnerMediaSources: graph.sources,
  revokeMetaPermissions: graph.revoke,
}));

import * as mediaRoute from "../../app/api/businesses/[id]/media/route";
import * as assetRoute from "../../app/api/businesses/[id]/media/[assetId]/route";
import * as thumbRoute from "../../app/api/businesses/[id]/media/[assetId]/thumb/route";
import * as connectionRoute from "../../app/api/businesses/[id]/connection/route";
import * as startRoute from "../../app/api/connections/meta/start/route";
import * as callbackRoute from "../../app/api/connections/meta/callback/route";
import * as stateRoute from "../../app/api/runs/[id]/autopilot/route";
import * as fileRoute from "../../app/api/runs/[id]/autopilot/files/[name]/route";
import { readMetaAttestation, META_CONNECTION_ATTESTATION } from "../../lib/autopilot/business-media";
import { emptyPublicState, writePublicFile, writePublicState } from "../../lib/autopilot/public-state";
import { MediaLibrary, mediaLibraryIntegrityKey } from "../../lib/media/library";

const BASE = "http://localhost:3000";
const CALLBACK = `${BASE}/api/connections/meta/callback`;
const SYNTHETIC_TOKEN = `synthetic-test-token-${"x".repeat(40)}`;
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

let originalCwd: string;
let workspace: string;
let png: Buffer;
let mp4: Buffer;
const mediaBusiness = randomUUID();
const oauthBusiness = randomUUID();

function configureConnector() {
  vi.stubEnv("META_APP_ID", "1234567890");
  vi.stubEnv("META_APP_SECRET", "syntheticAppSecret0123456789");
  vi.stubEnv("META_OAUTH_REDIRECT_URI", CALLBACK);
  vi.stubEnv("TICKR_SECRET_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("META_LOGIN_CONFIG_ID", "");
  vi.stubEnv("META_GRAPH_VERSION", "");
}

function clearConnector() {
  for (const name of ["META_APP_ID", "META_APP_SECRET", "META_OAUTH_REDIRECT_URI", "TICKR_SECRET_KEY", "META_LOGIN_CONFIG_ID", "META_GRAPH_VERSION"]) vi.stubEnv(name, "");
}

function upload(businessId: string, body: BodyInit, contentType: string, query: Record<string, string> = { filename: "synthetic.png", ownsOrLicensedMedia: "true", peopleVisible: "no_people" }, headers: Record<string, string> = {}) {
  const url = `${BASE}/api/businesses/${businessId}/media?${new URLSearchParams(query).toString()}`;
  return mediaRoute.POST(new Request(url, { method: "POST", headers: { "content-type": contentType, origin: BASE, ...headers }, body, duplex: "half" } as RequestInit), params({ id: businessId }));
}

async function listMedia(businessId: string) {
  const response = await mediaRoute.GET(new Request(`${BASE}/api/businesses/${businessId}/media`), params({ id: businessId }));
  return { status: response.status, text: await response.text() };
}

beforeAll(async () => {
  originalCwd = process.cwd();
  workspace = await mkdtemp(join(tmpdir(), "tickr-autopilot-routes-"));
  process.chdir(workspace);
  known.businesses.add(mediaBusiness).add(oauthBusiness);
  // Synthetic still: a plain two-tone card drawn locally.
  png = await sharp({ create: { width: 640, height: 400, channels: 3, background: "#d9b38c" } })
    .composite([{ input: Buffer.from('<svg width="640" height="400"><rect x="200" y="100" width="240" height="200" fill="#6b3f1d"/></svg>') }])
    .png().toBuffer();
  const video = join(workspace, "synthetic-testsrc2.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15", "-t", "2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video], { timeout: 60_000 });
  mp4 = await readFile(video);
}, 90_000);

afterAll(async () => {
  process.chdir(originalCwd);
  await rm(workspace, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  graph.exchange.mockReset();
  graph.sources.mockReset();
  graph.revoke.mockReset();
});

describe("owner media routes", () => {
  test("accepts a png and an mp4, lists them without private paths, serves thumbnails and deletes", async () => {
    clearConnector();
    const image = await upload(mediaBusiness, new Uint8Array(png), "image/png");
    expect(image.status).toBe(201);
    const { asset: still } = await image.json();
    expect(still).toMatchObject({ kind: "image", provenance: "owner_upload", mimeType: "image/png", width: 640, height: 400, durationSeconds: null });
    expect(still.id).toMatch(/^asset_[a-f0-9]{24}$/);
    expect(still.thumbUrl).toBe(`/api/businesses/${mediaBusiness}/media/${still.id}/thumb`);

    const clip = await upload(mediaBusiness, new Uint8Array(mp4), "video/mp4", { filename: "synthetic clip.mp4", ownsOrLicensedMedia: "true", peopleVisible: "consented" });
    expect(clip.status).toBe(201);
    const { asset: movie } = await clip.json();
    expect(movie).toMatchObject({ kind: "video", mimeType: "video/mp4", width: 320, height: 240 });
    expect(movie.durationSeconds).toBeGreaterThan(1.5);

    const again = await upload(mediaBusiness, new Uint8Array(png), "image/png");
    expect(again.status).toBe(200);
    expect((await again.json()).asset.id).toBe(still.id);

    const listed = await listMedia(mediaBusiness);
    expect(listed.status).toBe(200);
    expect(listed.text).not.toContain(workspace);
    expect(listed.text).not.toMatch(/localPath|consent|sha256/);
    const body = JSON.parse(listed.text);
    expect(body.assets.map((item: { id: string }) => item.id)).toEqual([still.id, movie.id]);
    expect(body.connection).toEqual({ status: "not_configured", provider: "meta", accountName: null, instagramUsername: null, pageName: null, expiresAt: null, mediaCount: null });

    for (const asset of [still, movie]) {
      const thumb = await thumbRoute.GET(new Request(`${BASE}${asset.thumbUrl}`), params({ id: mediaBusiness, assetId: asset.id }));
      expect(thumb.status).toBe(200);
      expect(thumb.headers.get("content-type")).toBe("image/jpeg");
      expect(thumb.headers.get("cache-control")).toBe("no-store");
      expect(thumb.headers.get("x-content-type-options")).toBe("nosniff");
      const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
      expect(meta.format).toBe("jpeg");
      expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(480);
    }

    const crossDelete = await assetRoute.DELETE(new Request(`${BASE}/x`, { method: "DELETE", headers: { origin: "https://attacker.example" } }), params({ id: mediaBusiness, assetId: still.id }));
    expect(crossDelete.status).toBe(403);
    const removed = await assetRoute.DELETE(new Request(`${BASE}/x`, { method: "DELETE", headers: { origin: BASE } }), params({ id: mediaBusiness, assetId: still.id }));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    const after = JSON.parse((await listMedia(mediaBusiness)).text);
    expect(after.assets.map((item: { id: string }) => item.id)).toEqual([movie.id]);
    const gone = await thumbRoute.GET(new Request(`${BASE}${still.thumbUrl}`), params({ id: mediaBusiness, assetId: still.id }));
    expect(gone.status).toBe(404);
    const missing = await assetRoute.DELETE(new Request(`${BASE}/x`, { method: "DELETE", headers: { origin: BASE } }), params({ id: mediaBusiness, assetId: still.id }));
    expect(missing.status).toBe(404);

    // Staging files never outlive a request.
    const mediaDir = resolve(workspace, ".data/businesses", mediaBusiness, "media");
    expect(await readdir(join(mediaDir, "incoming"))).toEqual([]);
    expect(await readdir(join(mediaDir, "accepted"))).toEqual([]);
  }, 60_000);

  test("requires the consent query parameters", async () => {
    const queries: Record<string, string>[] = [{ filename: "a.png" }, { ownsOrLicensedMedia: "false", peopleVisible: "no_people" }, { ownsOrLicensedMedia: "true", peopleVisible: "maybe" }];
    for (const query of queries) {
      const response = await upload(mediaBusiness, new Uint8Array(png), "image/png", query);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/own or are licensed/);
    }
  });

  test("rejects oversize bodies by declared length and while streaming", async () => {
    const declared = await upload(mediaBusiness, new Uint8Array(png), "image/png", undefined, { "content-length": String(21 * 1024 * 1024) });
    expect(declared.status).toBe(413);
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (sent++ < 22) controller.enqueue(chunk); else controller.close(); } });
    const streamed = await upload(mediaBusiness, stream, "image/png");
    expect(streamed.status).toBe(413);
    expect((await streamed.json()).error).toBe("Photos must be 20 MB or smaller.");
    expect(sent).toBeLessThan(23);
    expect(await readdir(resolve(workspace, ".data/businesses", mediaBusiness, "media", "incoming"))).toEqual([]);
  });

  test("rejects spoofed and unsupported types", async () => {
    const spoofed = await upload(mediaBusiness, new Uint8Array(mp4), "image/png");
    expect(spoofed.status).toBe(400);
    const html = await upload(mediaBusiness, new TextEncoder().encode("<html><script>alert(1)</script></html>"), "image/jpeg");
    expect(html.status).toBe(400);
    const unsupported = await upload(mediaBusiness, new Uint8Array(png), "text/html");
    expect(unsupported.status).toBe(400);
  });

  test("enforces the per-business upload limit", async () => {
    clearConnector();
    const crowded = randomUUID();
    known.businesses.add(crowded);
    const noise = (seed: number) => sharp(Buffer.from(Array.from({ length: 16 * 16 * 3 }, (_, index) => (Math.imul(index + 1, 2654435761 + seed * 40503) >>> 13) & 255)), { raw: { width: 16, height: 16, channels: 3 } })
      .resize(160, 160, { kernel: "nearest" }).png().toBuffer();
    for (let index = 0; index < 40; index++) expect((await upload(crowded, new Uint8Array(await noise(index)), "image/png")).status).toBe(201);
    const over = await upload(crowded, new Uint8Array(await noise(40)), "image/png");
    expect(over.status).toBe(409);
    expect((await over.json()).error).toMatch(/40 uploaded/);
  }, 120_000);

  test("blocks cross-origin writes and unknown businesses", async () => {
    const cross = await upload(mediaBusiness, new Uint8Array(png), "image/png", undefined, { origin: "https://attacker.example" });
    expect(cross.status).toBe(403);
    const crossSite = await upload(mediaBusiness, new Uint8Array(png), "image/png", undefined, { origin: "", "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
    const unknown = randomUUID();
    expect((await upload(unknown, new Uint8Array(png), "image/png")).status).toBe(404);
    expect((await listMedia(unknown)).status).toBe(404);
    expect((await listMedia("../../etc")).status).toBe(404);
    const badAsset = await thumbRoute.GET(new Request(`${BASE}/x`), params({ id: mediaBusiness, assetId: "../manifest" }));
    expect(badAsset.status).toBe(404);
  });
});

describe("owner media library maintenance", () => {
  const remove = (businessId: string, assetId: string) =>
    assetRoute.DELETE(new Request(`${BASE}/x`, { method: "DELETE", headers: { origin: BASE } }), params({ id: businessId, assetId }));
  const mediaDir = (businessId: string) => resolve(workspace, ".data/businesses", businessId, "media");
  // Distinct synthetic noise cards (no near-duplicates), one per seed.
  const tinted = (seed: number) => sharp(Buffer.from(Array.from({ length: 16 * 16 * 3 }, (_, index) => (Math.imul(index + 7, 2246822519 + seed * 97231) >>> 11) & 255)), { raw: { width: 16, height: 16, channels: 3 } })
    .resize(192, 192, { kernel: "nearest" }).png().toBuffer();
  const freshBusiness = () => { const id = randomUUID(); known.businesses.add(id); return id; };
  const uploadedId = async (businessId: string, bytes: Buffer) => {
    const response = await upload(businessId, new Uint8Array(bytes), bytes === mp4 ? "video/mp4" : "image/png");
    const body = await response.json();
    expect([response.status, body.error]).toEqual([201, undefined]);
    return body.asset.id as string;
  };

  test("refuses removal while a campaign for the business is queued or running", async () => {
    clearConnector();
    const business = freshBusiness();
    const id = await uploadedId(business, png);
    known.activeRunBusinesses.add(business);
    try {
      const refused = await remove(business, id);
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toMatch(/while a campaign is being produced/);
      expect(JSON.parse((await listMedia(business)).text).assets.map((item: { id: string }) => item.id)).toEqual([id]);
    } finally { known.activeRunBusinesses.delete(business); }
    expect((await remove(business, id)).status).toBe(200);
  });

  test("removes by rewriting only the manifest while other readers open the same library", async () => {
    clearConnector();
    const business = freshBusiness();
    const ids = [await uploadedId(business, await tinted(1)), await uploadedId(business, await tinted(2)), await uploadedId(business, mp4)];
    const before = new Set(await readdir(join(mediaDir(business), "media-library", "files")));
    let reading = true;
    const readerErrors: unknown[] = [];
    const reader = (async () => {
      while (reading) {
        try { await (await MediaLibrary.open(mediaDir(business))).listAssets(); } catch (error) { readerErrors.push(error); }
        await new Promise((done) => setImmediate(done));
      }
    })();
    const responses = await Promise.all([remove(business, ids[0]), remove(business, ids[2])]);
    reading = false;
    await reader;
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(readerErrors).toEqual([]);
    const library = await MediaLibrary.open(mediaDir(business));
    expect((await library.listAssets()).map((asset) => asset.id)).toEqual([ids[1]]);
    await expect(library.verifyAsset(ids[1])).resolves.toMatchObject({ id: ids[1] });
    const after = await readdir(join(mediaDir(business), "media-library", "files"));
    expect(after).toEqual([...before].filter((file) => file.startsWith(ids[1])));
    expect((await readdir(mediaDir(business))).filter((name) => name.startsWith("."))).toEqual([]);
  }, 60_000);

  test("upgrades a library uploaded before TICKR_SECRET_KEY was set, then keeps working under the key", async () => {
    clearConnector();
    const business = freshBusiness();
    const first = await uploadedId(business, await tinted(3));
    configureConnector();
    const listed = JSON.parse((await listMedia(business)).text);
    expect(listed.mediaError).toBeUndefined();
    expect(listed.assets.map((item: { id: string }) => item.id)).toEqual([first]);
    expect(listed.connection.status).toBe("disconnected");
    const manifest = JSON.parse(await readFile(join(mediaDir(business), "media-library", "manifest.json"), "utf8"));
    expect(manifest.integrity).toBe("hmac-sha256");
    await expect(MediaLibrary.open(mediaDir(business), { integrityKey: mediaLibraryIntegrityKey() })).resolves.toBeDefined();
    const second = await uploadedId(business, await tinted(4));
    expect((await remove(business, first)).status).toBe(200);
    expect(JSON.parse((await listMedia(business)).text).assets.map((item: { id: string }) => item.id)).toEqual([second]);
  });

  test("never upgrades an unkeyed manifest that fails its own digest", async () => {
    clearConnector();
    const business = freshBusiness();
    await uploadedId(business, await tinted(5));
    const path = join(mediaDir(business), "media-library", "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.body.assets[0].caption = "edited outside Tickr";
    await writeFile(path, JSON.stringify(manifest));
    configureConnector();
    const listed = await listMedia(business);
    expect(listed.status).toBe(200);
    const body = JSON.parse(listed.text);
    expect(body.assets).toEqual([]);
    expect(body.mediaError).toMatch(/could not be verified with the current server secret/);
    expect(body.connection.status).toBe("disconnected");
    expect(JSON.parse(await readFile(path, "utf8")).integrity).toBe("sha256");
  });

  test("reports a changed or missing server secret honestly and still returns the connection status", async () => {
    configureConnector();
    const business = freshBusiness();
    const id = await uploadedId(business, await tinted(6));
    vi.stubEnv("TICKR_SECRET_KEY", randomBytes(32).toString("base64"));
    const changed = JSON.parse((await listMedia(business)).text);
    expect(changed).toMatchObject({ assets: [], connection: { status: "disconnected", provider: "meta" } });
    expect(changed.mediaError).toMatch(/could not be verified/);
    expect(changed.mediaError).not.toMatch(/tamper/i);
    const blocked = await upload(business, new Uint8Array(await tinted(7)), "image/png");
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toBe(changed.mediaError);
    const refused = await remove(business, id);
    expect(refused.status).toBe(409);
    vi.stubEnv("TICKR_SECRET_KEY", "");
    const missing = JSON.parse((await listMedia(business)).text);
    expect(missing.connection.status).toBe("not_configured");
    expect(missing.mediaError).toMatch(/TICKR_SECRET_KEY\) was set, and it is not set now/);
  });
});

describe("Meta connection routes", () => {
  const start = (query: Record<string, string>, headers: Record<string, string> = {}) =>
    startRoute.GET(new Request(`${BASE}/api/connections/meta/start?${new URLSearchParams(query).toString()}`, { headers }));
  const callback = (query: Record<string, string>, cookie?: string) =>
    callbackRoute.GET(new Request(`${CALLBACK}?${new URLSearchParams(query).toString()}`, { headers: cookie ? { cookie } : {} }));

  test("reports not_configured and refuses to start without server settings", async () => {
    clearConnector();
    const response = await start({ businessId: oauthBusiness, attest: "1" });
    expect(response.status).toBe(409);
    const { error } = await response.json();
    expect(error).toContain("META_APP_ID");
    expect(error).not.toMatch(/=/);
    expect(JSON.parse((await listMedia(oauthBusiness)).text).connection.status).toBe("not_configured");
  });

  test("requires the owner's attestation and a same-origin start", async () => {
    configureConnector();
    const missing = await start({ businessId: oauthBusiness });
    expect(missing.status).toBe(409);
    expect((await missing.json()).error).toMatch(/own or license/);
    expect((await start({ businessId: oauthBusiness, attest: "1" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await start({ businessId: randomUUID(), attest: "1" })).status).toBe(404);
  });

  test("connects with a signed state and browser nonce, stores the token encrypted with the attestation, and disconnects", async () => {
    configureConnector();
    const started = await start({ businessId: oauthBusiness, attest: "1" }, { "sec-fetch-site": "same-origin" });
    expect(started.status).toBe(302);
    const location = new URL(started.headers.get("location")!);
    expect(location.origin).toBe("https://www.facebook.com");
    expect(location.pathname).toMatch(/^\/v\d+\.0\/dialog\/oauth$/);
    expect(location.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(location.searchParams.get("client_id")).toBe("1234567890");
    expect(location.href).not.toContain("syntheticAppSecret");
    const state = location.searchParams.get("state")!;
    const setCookie = started.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    const cookie = setCookie.split(";")[0];

    graph.exchange.mockResolvedValue({ accessToken: SYNTHETIC_TOKEN, tokenType: "bearer", expiresAt: new Date(Date.now() + 60 * 86_400_000), longLived: true });
    graph.sources.mockResolvedValue({ sources: [
      { kind: "facebook_page", id: "111", name: "Synthetic Fixture Cafe", provenance: "owner_facebook" },
      { kind: "instagram_account", id: "222", pageId: "111", username: "synthetic_fixture_cafe", provenance: "owner_instagram" },
    ], warnings: [], truncated: false });

    const done = await callback({ code: "synthetic-code-123", state }, cookie);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`/?business=${oauthBusiness}&connected=meta`);
    expect(done.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect(graph.exchange).toHaveBeenCalledWith("synthetic-code-123", CALLBACK);

    const stored = await readFile(resolve(workspace, ".data/connections", `${oauthBusiness}.json`), "utf8");
    expect(stored).not.toContain(SYNTHETIC_TOKEN);
    const attestation = await readMetaAttestation(oauthBusiness);
    expect(attestation).toMatchObject({ statement: META_CONNECTION_ATTESTATION, pageName: "Synthetic Fixture Cafe", instagramUsername: "synthetic_fixture_cafe", tokenLongLived: true });

    const listed = await listMedia(oauthBusiness);
    expect(listed.text).not.toContain(SYNTHETIC_TOKEN);
    expect(JSON.parse(listed.text).connection).toMatchObject({ status: "connected", provider: "meta", pageName: "Synthetic Fixture Cafe", instagramUsername: "synthetic_fixture_cafe", accountName: "@synthetic_fixture_cafe" });

    graph.revoke.mockResolvedValue({ revoked: true });
    const cross = await connectionRoute.DELETE(new Request(`${BASE}/x`, { method: "DELETE", headers: { origin: "https://attacker.example" } }), params({ id: oauthBusiness }));
    expect(cross.status).toBe(403);
    const disconnected = await connectionRoute.DELETE(new Request(`${BASE}/x`, { method: "DELETE", headers: { origin: BASE } }), params({ id: oauthBusiness }));
    expect(await disconnected.json()).toEqual({ ok: true });
    expect(graph.revoke).toHaveBeenCalledWith(SYNTHETIC_TOKEN, expect.anything());
    expect(JSON.parse((await listMedia(oauthBusiness)).text).connection.status).toBe("disconnected");
    expect(await readMetaAttestation(oauthBusiness)).toBeNull();
  });

  test("rejects tampered, foreign or unbound state without exchanging the code", async () => {
    configureConnector();
    const other = randomUUID();
    known.businesses.add(other);
    const started = await start({ businessId: oauthBusiness, attest: "1" });
    const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
    const cookie = started.headers.get("set-cookie")!.split(";")[0];
    const [payload, mac] = state.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const swapped = `${Buffer.from(JSON.stringify({ ...decoded, b: other })).toString("base64url")}.${mac}`;
    const flipped = `${payload}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
    for (const [query, sentCookie] of [
      [{ code: "synthetic-code-123", state: swapped }, cookie],
      [{ code: "synthetic-code-123", state: flipped }, cookie],
      [{ code: "synthetic-code-123", state: "not-a-state" }, cookie],
      [{ code: "synthetic-code-123", state }, undefined],
      [{ code: "synthetic-code-123", state }, `tickr_meta_oauth=${"A".repeat(22)}`],
    ] as const) {
      const response = await callback(query, sentCookie);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/?connected=error");
    }
    const declined = await callback({ error: "access_denied", state }, cookie);
    expect(declined.headers.get("location")).toBe(`/?business=${oauthBusiness}&connected=error`);
    graph.exchange.mockRejectedValue(new Error("synthetic upstream failure with secret details"));
    const failed = await callback({ code: "synthetic-code-123", state }, cookie);
    expect(failed.headers.get("location")).toBe(`/?business=${oauthBusiness}&connected=error`);
    expect(graph.exchange).toHaveBeenCalledTimes(1);
  });
});

describe("director's room routes", () => {
  const runId = randomUUID();
  const emptyRun = randomUUID();
  const get = (name: string, headers: Record<string, string> = {}) => fileRoute.GET(new Request(`${BASE}/api/runs/${runId}/autopilot/files/${name}`, { headers }), params({ id: runId, name }));

  beforeAll(async () => {
    known.runs.add(runId).add(emptyRun);
    const runDir = resolve(workspace, ".data/runs", runId);
    const files = [await writePublicFile(runDir, "thumb-synthetic.png", png, "image/png"), await writePublicFile(runDir, "overlay-synthetic.mp4", mp4, "video/mp4"), await writePublicFile(runDir, "changed.png", png, "image/png")];
    await writePublicState(runDir, { ...emptyPublicState(runId), phase: "segment", files });
    await writeFile(join(runDir, "autopilot-public", "unlisted.png"), png);
    const changed = Buffer.from(png);
    changed[changed.length - 20] ^= 0xff;
    await writeFile(join(runDir, "autopilot-public", "changed.png"), changed);
  });

  test("serves the validated state, or null before one exists", async () => {
    const response = await stateRoute.GET(new Request(`${BASE}/api/runs/${runId}/autopilot`), params({ id: runId }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { state } = await response.json();
    expect(state.phase).toBe("segment");
    expect(state.files.map((file: { name: string }) => file.name)).toEqual(["thumb-synthetic.png", "overlay-synthetic.mp4", "changed.png"]);
    const empty = await stateRoute.GET(new Request(`${BASE}/x`), params({ id: emptyRun }));
    expect(await empty.json()).toEqual({ state: null });
    expect((await stateRoute.GET(new Request(`${BASE}/x`), params({ id: randomUUID() }))).status).toBe(404);
  });

  test("serves only listed, hash-verified preview files with range support", async () => {
    const image = await get("thumb-synthetic.png");
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await image.arrayBuffer()).equals(png)).toBe(true);

    const partial = await get("overlay-synthetic.mp4", { range: "bytes=0-99" });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("accept-ranges")).toBe("bytes");
    expect(partial.headers.get("content-range")).toBe(`bytes 0-99/${mp4.length}`);
    expect(Buffer.from(await partial.arrayBuffer()).equals(mp4.subarray(0, 100))).toBe(true);
    expect((await get("overlay-synthetic.mp4", { range: `bytes=${mp4.length}-` })).status).toBe(416);
    const tail = await get("overlay-synthetic.mp4", { range: "bytes=-10" });
    expect(tail.status).toBe(206);
    expect(Buffer.from(await tail.arrayBuffer()).equals(mp4.subarray(mp4.length - 10))).toBe(true);
    for (const range of ["bytes=-", "bytes=-0", "bytes=5-2", "items=0-1"]) expect((await get("overlay-synthetic.mp4", { range })).status).toBe(416);

    for (const name of ["unlisted.png", "changed.png", "state.json", "..%2Fstate.json", ".hidden"]) expect((await get(name)).status).toBe(404);
  });
});
