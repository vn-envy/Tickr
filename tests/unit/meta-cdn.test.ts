import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import { checkServerIdentity } from "node:tls";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  META_CDN_MAX_IMAGE_BYTES, downloadMetaCdnMedia, isMetaCdnUrl, pinnedHttpsStream, sniffMetaCdnMime, type MetaCdnStreamResponse, type MetaCdnTransport,
} from "../../lib/media/meta-cdn";
import type { PinnedHttpsDependencies } from "../../lib/network/pinned-https";

// Synthetic media only: a locally generated JPEG and a hand-built ISO-BMFF header.
const syntheticJpeg = () => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toBuffer();
const syntheticMp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2"), Buffer.alloc(4096, 1)]);
const IMAGE_URL = "https://scontent-xyz1-1.cdninstagram.com/v/t51/synthetic.jpg?oh=synthetic&oe=00000000";
const VIDEO_URL = "https://video.xx.fbcdn.net/v/t42/synthetic.mp4?oh=synthetic";

function respond(status: number, headers: Record<string, string>, chunks: Buffer[] = []): MetaCdnStreamResponse & { close: Mock<() => void> } {
  return { status, headers, close: vi.fn<() => void>(), body: (async function* () { for (const chunk of chunks) yield chunk; })() };
}

describe("Meta CDN host allowlist and type sniffing", () => {
  it("accepts only HTTPS Meta media CDN hosts on a dot boundary", () => {
    for (const url of [IMAGE_URL, VIDEO_URL, "https://scontent.fdel1-1.fna.fbcdn.net/v/x.jpg", "https://instagram.fxyz1-1.fna.fbcdn.net/x.mp4"]) expect(isMetaCdnUrl(url)).toBe(true);
    for (const url of [
      "http://scontent.xx.fbcdn.net/x.jpg", "https://fbcdn.net/x.jpg", "https://evilfbcdn.net/x.jpg", "https://scontent.xx.fbcdn.net.evil.test/x.jpg",
      "https://user:pass@scontent.xx.fbcdn.net/x.jpg", "https://scontent.xx.fbcdn.net:8443/x.jpg", "https://157.240.1.1/x.jpg", "https://www.facebook.com/x.jpg",
      "https://graph.facebook.com/v26.0/me", "not a url", `https://scontent.xx.fbcdn.net/${"a".repeat(5000)}`,
      // Static web assets and Meta's third-party image proxy are not owner media.
      "https://static.xx.fbcdn.net/rsrc.php/v3/x.png", "https://external.xx.fbcdn.net/safe_image.php?url=https%3A%2F%2Fthird.example.test%2Fa.jpg",
      "https://external-lhr8-1.xx.fbcdn.net/emg1/v/t13/x.jpg", "https://static.cdninstagram.com/rsrc.php/x.png", "https://scontentx.xx.fbcdn.net/x.jpg",
    ]) expect(isMetaCdnUrl(url)).toBe(false);
    expect(isMetaCdnUrl("https://scontent-lhr8-1.xx.fbcdn.net/v/x.jpg")).toBe(true);
    expect(isMetaCdnUrl("https://video-iad3-1.xx.fbcdn.net/v/x.mp4")).toBe(true);
  });

  it("sniffs container magic bytes", async () => {
    expect(sniffMetaCdnMime(await syntheticJpeg())).toBe("image/jpeg");
    expect(sniffMetaCdnMime(await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer())).toBe("image/png");
    expect(sniffMetaCdnMime(await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).webp().toBuffer())).toBe("image/webp");
    expect(sniffMetaCdnMime(syntheticMp4)).toBe("video/mp4");
    const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.alloc(8)]);
    for (const brand of ["mp42", "avc1", "iso5", "dash", "M4V "]) expect(sniffMetaCdnMime(ftyp(brand))).toBe("video/mp4");
    expect(sniffMetaCdnMime(ftyp("qt  "))).toBe("video/quicktime");
    // HEIF/AVIF still images share the ISO-BMFF container but are never videos.
    for (const brand of ["heic", "heix", "mif1", "msf1", "avif", "avis", "zzzz"]) expect(sniffMetaCdnMime(ftyp(brand))).toBeNull();
    expect(sniffMetaCdnMime(Buffer.from("<html>not media</html>"))).toBeNull();
  });
});

describe("downloadMetaCdnMedia", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "tickr-meta-cdn-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("streams an image to a private content-addressed file without sending credentials", async () => {
    const jpeg = await syntheticJpeg();
    const response = respond(200, { "content-type": "image/jpeg; charset=binary", "content-length": String(jpeg.length) }, [jpeg.subarray(0, 10), jpeg.subarray(10)]);
    const transport = vi.fn<MetaCdnTransport>().mockResolvedValue(response);
    const result = await downloadMetaCdnMedia(IMAGE_URL, { kind: "image", outputDir: join(directory, "owner") }, { transport });
    const sha256 = createHash("sha256").update(jpeg).digest("hex");
    expect(result).toEqual({ path: join(directory, "owner", `${sha256}.jpg`), bytes: jpeg.length, sha256, mimeType: "image/jpeg" });
    expect(await readFile(result.path)).toEqual(jpeg);
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "owner"))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(directory, "owner"))).toEqual([`${sha256}.jpg`]);
    expect(transport).toHaveBeenCalledOnce();
    const [url, options] = transport.mock.calls[0];
    expect(url.href).toBe(IMAGE_URL);
    expect(options).toMatchObject({ maxBytes: META_CDN_MAX_IMAGE_BYTES, accept: "image/jpeg, image/png, image/webp" });
    expect(Object.keys(options)).toEqual(["signal", "maxBytes", "accept"]);
    expect(response.close).toHaveBeenCalled();
  });

  it("downloads a video and keeps the declared ISO-BMFF type", async () => {
    const transport = vi.fn<MetaCdnTransport>().mockResolvedValue(respond(200, { "content-type": "video/mp4" }, [syntheticMp4]));
    const result = await downloadMetaCdnMedia(VIDEO_URL, { kind: "video", outputDir: directory }, { transport });
    expect(result).toMatchObject({ bytes: syntheticMp4.length, mimeType: "video/mp4" });
    expect(result.path.endsWith(".mp4")).toBe(true);
  });

  it("follows only allowlisted redirects, re-validating each hop", async () => {
    const jpeg = await syntheticJpeg();
    const next = "https://scontent.xx.fbcdn.net/v/moved.jpg";
    const transport = vi.fn<MetaCdnTransport>()
      .mockResolvedValueOnce(respond(302, { location: next }))
      .mockResolvedValueOnce(respond(200, { "content-type": "image/jpeg" }, [jpeg]));
    await expect(downloadMetaCdnMedia(IMAGE_URL, { kind: "image", outputDir: directory }, { transport })).resolves.toMatchObject({ bytes: jpeg.length });
    expect(transport.mock.calls.map(([url]) => url.href)).toEqual([IMAGE_URL, next]);

    for (const location of ["https://169.254.169.254/latest/meta-data", "http://scontent.xx.fbcdn.net/x.jpg", "https://evil.example.test/x.jpg", ""]) {
      const foreign = vi.fn<MetaCdnTransport>().mockResolvedValue(respond(301, { location }));
      await expect(downloadMetaCdnMedia(IMAGE_URL, { kind: "image", outputDir: directory }, { transport: foreign })).rejects.toMatchObject({ code: "REDIRECT_NOT_ALLOWED" });
      expect(foreign).toHaveBeenCalledOnce();
    }
    const loop = vi.fn<MetaCdnTransport>().mockImplementation(async () => respond(302, { location: IMAGE_URL }));
    await expect(downloadMetaCdnMedia(IMAGE_URL, { kind: "image", outputDir: directory }, { transport: loop })).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
    expect(loop).toHaveBeenCalledTimes(4);
  });

  it("rejects non-CDN URLs, wrong types, oversize and truncated bodies without leaving files", async () => {
    const jpeg = await syntheticJpeg();
    const unused = vi.fn<MetaCdnTransport>();
    await expect(downloadMetaCdnMedia("https://evil.example.test/x.jpg", { kind: "image", outputDir: directory }, { transport: unused })).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    await expect(downloadMetaCdnMedia(IMAGE_URL, { kind: "image", outputDir: directory, maxBytes: META_CDN_MAX_IMAGE_BYTES + 1 }, { transport: unused })).rejects.toMatchObject({ code: "INVALID_BYTE_LIMIT" });
    expect(unused).not.toHaveBeenCalled();

    const cases: [MetaCdnStreamResponse, "image" | "video", string, number?][] = [
      [respond(200, { "content-type": "text/html" }, [Buffer.from("<html>")]), "image", "MIME_NOT_ALLOWED"],
      [respond(200, { "content-type": "image/png" }, [jpeg]), "image", "TYPE_MISMATCH"],
      [respond(200, { "content-type": "video/mp4" }, [jpeg]), "video", "TYPE_MISMATCH"],
      [respond(200, { "content-type": "video/mp4" }, [Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(64)])]), "video", "TYPE_MISMATCH"],
      [respond(200, { "content-type": "image/jpeg" }, [jpeg]), "video", "MIME_NOT_ALLOWED"],
      [respond(200, { "content-type": "image/jpeg", "content-length": "999999" }, [jpeg]), "image", "BODY_TOO_LARGE", 1000],
      [respond(200, { "content-type": "image/jpeg" }, [jpeg, jpeg]), "image", "BODY_TOO_LARGE", jpeg.length + 10],
      [respond(200, { "content-type": "image/jpeg", "content-length": String(jpeg.length + 5) }, [jpeg]), "image", "INCOMPLETE_BODY"],
      [respond(200, { "content-type": "image/jpeg" }, []), "image", "EMPTY_BODY"],
      [respond(403, { "content-type": "text/plain" }, [Buffer.from("URL signature expired")]), "image", "URL_EXPIRED"],
      [respond(500, { "content-type": "text/plain" }), "image", "HTTP_ERROR"],
    ];
    for (const [response, kind, code, maxBytes] of cases) {
      const transport = vi.fn<MetaCdnTransport>().mockResolvedValue(response);
      const error = (await downloadMetaCdnMedia(kind === "image" ? IMAGE_URL : VIDEO_URL, { kind, outputDir: directory, maxBytes }, { transport }).catch((failure: unknown) => failure)) as Error & { code: string };
      expect(error).toMatchObject({ code });
      expect(error.message).not.toMatch(/oh=synthetic|signature expired|\/tmp\//);
      expect(response.close).toHaveBeenCalled();
    }
    expect(await readdir(directory).catch(() => [])).toEqual([]);
  });

  it("aborts a stalled body on timeout and removes the partial file", async () => {
    const transport = vi.fn<MetaCdnTransport>().mockImplementation(async (_url, { signal }) => ({
      status: 200, headers: { "content-type": "video/mp4" }, close: vi.fn(),
      body: (async function* () {
        yield syntheticMp4.subarray(0, 16);
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      })(),
    }));
    await expect(downloadMetaCdnMedia(VIDEO_URL, { kind: "video", outputDir: directory, timeoutMs: 30 }, { transport })).rejects.toMatchObject({ code: "READ_TIMEOUT" });
    expect(await readdir(directory)).toEqual([]);
  });
});

class FakeResource extends EventEmitter {
  destroy = vi.fn();
  end = vi.fn();
  authorized = true;
}

interface FakeNetworkOptions {
  proxy?: boolean;
  addresses?: { address: string; family: number }[];
  /** TLS identity result reported by the fake tunnel socket. */
  tlsAuthorized?: boolean;
  connectStatus?: number;
  connectHead?: Buffer;
  /** When false the origin body stays open until destroyed. */
  endOrigin?: boolean;
}

function fakeNetwork(options: FakeNetworkOptions = {}) {
  const tunnel = new FakeResource();
  const secure = new FakeResource();
  secure.authorized = options.tlsAuthorized ?? true;
  const origin = Object.assign(new PassThrough(), { headers: { "content-type": "image/jpeg" }, statusCode: 200 });
  const connectRequests: RequestOptions[] = [];
  const originRequests: { url: URL; options: RequestOptions }[] = [];
  const request = vi.fn((...args: unknown[]) => {
    const fake = new FakeResource();
    if (args[0] instanceof URL) {
      originRequests.push({ url: args[0], options: args[1] as RequestOptions });
      const receive = args[2] as (message: IncomingMessage) => void;
      fake.end.mockImplementation(() => queueMicrotask(() => {
        receive(origin as unknown as IncomingMessage);
        if (options.endOrigin === false) origin.write(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
        else origin.end(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
      }));
    } else {
      connectRequests.push(args[0] as RequestOptions);
      fake.end.mockImplementation(() => queueMicrotask(() => fake.emit("connect", { statusCode: options.connectStatus ?? 200 }, tunnel, options.connectHead ?? Buffer.alloc(0))));
    }
    return fake as unknown as ClientRequest;
  });
  const tls = vi.fn<(options: ConnectionOptions) => TLSSocket>(() => { queueMicrotask(() => secure.emit("secureConnect")); return secure as unknown as TLSSocket; });
  const resolver = vi.fn(async () => options.addresses ?? [{ address: "157.240.22.1", family: 4 }]);
  const dependencies: PinnedHttpsDependencies = {
    resolver,
    environment: options.proxy === false ? {} : { HTTPS_PROXY: "http://proxy.example.test:8080/", META_API_KEY: "fixture-meta-key-never-forwarded" },
    httpRequest: request as unknown as NonNullable<PinnedHttpsDependencies["httpRequest"]>,
    httpsRequest: request as unknown as NonNullable<PinnedHttpsDependencies["httpsRequest"]>,
    tlsConnect: tls as unknown as NonNullable<PinnedHttpsDependencies["tlsConnect"]>,
  };
  return { dependencies, resolver, request, tls, tunnel, secure, origin, connectRequests, originRequests };
}

describe("pinnedHttpsStream", () => {
  const options = () => ({ signal: new AbortController().signal, maxBytes: 1024, accept: "image/jpeg" });

  it("tunnels to a validated public IP, verifies the original hostname and sends no credentials", async () => {
    const network = fakeNetwork();
    const response = await pinnedHttpsStream(new URL(IMAGE_URL), options(), network.dependencies);
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) chunks.push(chunk);
    response.close();
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    expect(network.resolver).toHaveBeenCalledExactlyOnceWith("scontent-xyz1-1.cdninstagram.com");
    expect(network.connectRequests).toHaveLength(1);
    expect(network.connectRequests[0]).toMatchObject({ method: "CONNECT", path: "157.240.22.1:443", hostname: "proxy.example.test" });
    expect(network.tls).toHaveBeenCalledWith({ socket: network.tunnel, servername: "scontent-xyz1-1.cdninstagram.com", rejectUnauthorized: true, checkServerIdentity });
    expect(network.originRequests[0].url.href).toBe(IMAGE_URL);
    const headers = network.originRequests[0].options.headers as Record<string, string>;
    expect(Object.keys(headers).some((name) => /authorization|cookie|referer/i.test(name))).toBe(false);
    expect(JSON.stringify(headers)).not.toContain("fixture-meta-key");
    expect(network.secure.destroy).toHaveBeenCalled();
  });

  it("fails closed on non-CDN URLs and non-public DNS answers before connecting", async () => {
    const network = fakeNetwork();
    await expect(pinnedHttpsStream(new URL("https://evil.example.test/x.jpg"), options(), network.dependencies)).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    expect(network.resolver).not.toHaveBeenCalled();
    const privateDns = fakeNetwork({ addresses: [{ address: "157.240.22.1", family: 4 }, { address: "10.0.0.5", family: 4 }] });
    await expect(pinnedHttpsStream(new URL(IMAGE_URL), options(), privateDns.dependencies)).rejects.toMatchObject({ code: "DESTINATION_NOT_PUBLIC" });
    expect(privateDns.request).not.toHaveBeenCalled();
  });

  it("without a proxy connects directly through an agent whose lookup is pinned to the validated address", async () => {
    const network = fakeNetwork({ proxy: false });
    const response = await pinnedHttpsStream(new URL(IMAGE_URL), options(), network.dependencies);
    for await (const chunk of response.body) void chunk;
    response.close();
    expect(network.connectRequests).toHaveLength(0);
    expect(network.tls).not.toHaveBeenCalled();
    expect(network.resolver).toHaveBeenCalledOnce();
    const { url, options: requestOptions } = network.originRequests[0];
    expect(url.href).toBe(IMAGE_URL);
    expect(requestOptions).toMatchObject({ family: 4, method: "GET", rejectUnauthorized: true });
    const agent = requestOptions.agent as HttpsAgent;
    expect(agent).toBeInstanceOf(HttpsAgent);
    const lookup = (agent as HttpsAgent & { options: { lookup: LookupFunction } }).options.lookup;
    const resolved = await new Promise<string>((resolvePromise, reject) => lookup("attacker-chosen.example.test", {}, (error, address) => (error ? reject(error) : resolvePromise(String(address)))));
    expect(resolved).toBe("157.240.22.1");
    expect(Object.keys(requestOptions.headers as Record<string, string>).some((name) => /authorization|cookie|referer/i.test(name))).toBe(false);
  });

  it("fails closed on unverified TLS, rejected or dirty proxy tunnels without sending the origin request", async () => {
    for (const [network, code] of [
      [fakeNetwork({ tlsAuthorized: false }), "TLS_UNVERIFIED"],
      [fakeNetwork({ connectStatus: 407 }), "PROXY_CONNECT_REJECTED"],
      [fakeNetwork({ connectHead: Buffer.from("HTTP/1.1 200 OK\r\n") }), "PROXY_CONNECT_REJECTED"],
    ] as const) {
      await expect(pinnedHttpsStream(new URL(IMAGE_URL), options(), network.dependencies)).rejects.toMatchObject({ code });
      expect(network.originRequests).toHaveLength(0);
      expect(network.tunnel.destroy).toHaveBeenCalled();
    }
  });

  it("tears down the stream when aborted after the response has resolved", async () => {
    const network = fakeNetwork({ endOrigin: false });
    const controller = new AbortController();
    const response = await pinnedHttpsStream(new URL(IMAGE_URL), { signal: controller.signal, maxBytes: 1024, accept: "image/jpeg" }, network.dependencies);
    const destroy = vi.spyOn(network.origin, "destroy");
    const iterator = response.body[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    controller.abort();
    expect(destroy).toHaveBeenCalled();
    expect(network.secure.destroy).toHaveBeenCalled();
    expect(network.tunnel.destroy).toHaveBeenCalled();
    // The consumer sees a premature close, never a silently truncated success.
    await expect(iterator.next()).rejects.toMatchObject({ code: "ERR_STREAM_PREMATURE_CLOSE" });
  });
});
