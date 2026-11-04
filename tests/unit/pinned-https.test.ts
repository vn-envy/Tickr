import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import { checkServerIdentity } from "node:tls";
import { describe, expect, test, vi } from "vitest";
import { pinnedHttpsRequest, proxyConnectAuthority, type PinnedHttpsDependencies } from "../../lib/network/pinned-https";

class FakeResource extends EventEmitter {
  destroy = vi.fn();
  end = vi.fn();
  authorized = true;
  headers: Record<string, string> = {};
  statusCode = 200;
}

function transport(options: { connectStatus?: number; authorized?: boolean; stallTls?: boolean; stallOrigin?: boolean; headers?: Record<string, string>; chunks?: Buffer[]; environment?: Record<string, string | undefined> } = {}) {
  const tunnel = new FakeResource();
  const secure = new FakeResource();
  secure.authorized = options.authorized ?? true;
  const originResponse = new FakeResource();
  originResponse.headers = options.headers ?? { "content-type": "text/plain" };
  const connectRequests: { options: RequestOptions; request: FakeResource }[] = [];
  const originRequests: { url: URL; options: RequestOptions; request: FakeResource }[] = [];
  let receive: ((message: IncomingMessage) => void) | undefined;
  const sendOrigin = () => {
    receive?.(originResponse as unknown as IncomingMessage);
    for (const chunk of options.chunks ?? [Buffer.from("public website")]) originResponse.emit("data", chunk);
    originResponse.emit("end");
  };
  const request = vi.fn((...args: unknown[]) => {
    const fake = new FakeResource();
    if (args[0] instanceof URL) {
      originRequests.push({ url: args[0], options: args[1] as RequestOptions, request: fake });
      receive = args[2] as (message: IncomingMessage) => void;
      fake.end.mockImplementation(() => { if (!options.stallOrigin) queueMicrotask(sendOrigin); });
    } else {
      connectRequests.push({ options: args[0] as RequestOptions, request: fake });
      fake.end.mockImplementation(() => queueMicrotask(() => fake.emit("connect", { statusCode: options.connectStatus ?? 200 }, tunnel, Buffer.alloc(0))));
    }
    return fake as unknown as ClientRequest;
  });
  const tls = vi.fn<(options: ConnectionOptions) => TLSSocket>(() => {
    if (!options.stallTls) queueMicrotask(() => secure.emit("secureConnect"));
    return secure as unknown as TLSSocket;
  });
  const resolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
  const dependencies: PinnedHttpsDependencies = {
    resolver,
    environment: options.environment ?? { HTTPS_PROXY: "http://proxy-user:proxy-pass@proxy.example.com:8080/", META_API_KEY: "fixture-meta-key-never-forwarded" },
    httpRequest: request as unknown as NonNullable<PinnedHttpsDependencies["httpRequest"]>,
    httpsRequest: request as unknown as NonNullable<PinnedHttpsDependencies["httpsRequest"]>,
    tlsConnect: tls as unknown as NonNullable<PinnedHttpsDependencies["tlsConnect"]>,
  };
  return { dependencies, resolver, request, tls, tunnel, secure, originResponse, originRequests, connectRequests, sendOrigin };
}

const origin = new URL("https://bakery.example.com/menu");
const requestOptions = (signal = new AbortController().signal, maxBytes = 1024) => ({ signal, maxBytes, accept: "text/html,text/plain" });

describe("pinned official-site HTTPS transport", () => {
  test("CONNECT uses only a validated public IP, proxy credentials stay on CONNECT, and TLS verifies the original hostname", async () => {
    const mock = transport();
    const response = await pinnedHttpsRequest(origin, requestOptions(), mock.dependencies);
    expect(response.body.toString()).toBe("public website");
    expect(mock.resolver).toHaveBeenCalledOnce();
    expect(mock.resolver).toHaveBeenCalledWith("bakery.example.com");
    expect(mock.connectRequests).toHaveLength(1);
    expect(mock.connectRequests[0].options).toMatchObject({ hostname: "proxy.example.com", method: "CONNECT", path: "93.184.216.34:443", headers: { Host: "93.184.216.34:443", "Proxy-Authorization": `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}` } });
    expect(mock.tls).toHaveBeenCalledWith({ socket: mock.tunnel, servername: "bakery.example.com", rejectUnauthorized: true, checkServerIdentity });
    expect(mock.originRequests).toHaveLength(1);
    expect(mock.originRequests[0].url.href).toBe(origin.href);
    expect(mock.originRequests[0].options).toMatchObject({ method: "GET", rejectUnauthorized: true, headers: { Host: "bakery.example.com", "Accept-Encoding": "identity" } });
    const headers = mock.originRequests[0].options.headers as Record<string, string>;
    expect(Object.keys(headers).some((header) => /authorization|cookie/i.test(header))).toBe(false);
    expect(JSON.stringify(headers)).not.toMatch(/proxy-user|proxy-pass|fixture-meta-key/);
  });

  test("rejects mixed DNS answers before any proxy or origin request", async () => {
    const mock = transport();
    mock.resolver.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }]);
    await expect(pinnedHttpsRequest(origin, requestOptions(), mock.dependencies)).rejects.toMatchObject({ code: "DESTINATION_NOT_PUBLIC" });
    expect(mock.request).not.toHaveBeenCalled();
    expect(mock.tls).not.toHaveBeenCalled();
  });

  test("does not retry a rejected CONNECT using a hostname or direct connection", async () => {
    const mock = transport({ connectStatus: 403 });
    await expect(pinnedHttpsRequest(origin, requestOptions(), mock.dependencies)).rejects.toMatchObject({ code: "PROXY_CONNECT_REJECTED" });
    expect(mock.connectRequests).toHaveLength(1);
    expect(mock.connectRequests[0].options.path).toBe("93.184.216.34:443");
    expect(mock.originRequests).toHaveLength(0);
    expect(mock.tls).not.toHaveBeenCalled();
    expect(mock.tunnel.destroy).toHaveBeenCalled();
  });

  test("never sends the origin GET if tunneled TLS is unverified", async () => {
    const mock = transport({ authorized: false });
    await expect(pinnedHttpsRequest(origin, requestOptions(), mock.dependencies)).rejects.toMatchObject({ code: "TLS_UNVERIFIED" });
    expect(mock.originRequests).toHaveLength(0);
    expect(mock.secure.destroy).toHaveBeenCalled();
    expect(mock.tunnel.destroy).toHaveBeenCalled();
  });

  test("enforces response byte limits both from headers and streamed data", async () => {
    for (const options of [{ headers: { "content-length": "5" } }, { chunks: [Buffer.from("abcd"), Buffer.from("e")] }]) {
      const mock = transport(options);
      await expect(pinnedHttpsRequest(origin, requestOptions(undefined, 4), mock.dependencies)).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
      expect(mock.originResponse.destroy).toHaveBeenCalled();
      expect(mock.secure.destroy).toHaveBeenCalled();
    }
  });

  test("aborts during DNS without opening a late connection", async () => {
    const mock = transport();
    let resolveDns!: (value: { address: string; family: number }[]) => void;
    mock.resolver.mockImplementation(() => new Promise((resolve) => { resolveDns = resolve; }));
    const controller = new AbortController();
    const pending = pinnedHttpsRequest(origin, requestOptions(controller.signal), mock.dependencies);
    const rejected = expect(pending).rejects.toMatchObject({ code: "READ_TIMEOUT" });
    controller.abort();
    await rejected;
    resolveDns([{ address: "93.184.216.34", family: 4 }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.request).not.toHaveBeenCalled();
  });

  test("aborts a TLS handshake and destroys a response arriving after cancellation", async () => {
    const handshake = transport({ stallTls: true });
    const controller = new AbortController();
    const pending = pinnedHttpsRequest(origin, requestOptions(controller.signal), handshake.dependencies);
    const rejected = expect(pending).rejects.toMatchObject({ code: "READ_TIMEOUT" });
    await vi.waitFor(() => expect(handshake.tls).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(handshake.secure.destroy).toHaveBeenCalled();
    expect(handshake.tunnel.destroy).toHaveBeenCalled();
    expect(handshake.originRequests).toHaveLength(0);

    const late = transport({ stallOrigin: true });
    const afterConnect = new AbortController();
    const waiting = pinnedHttpsRequest(origin, requestOptions(afterConnect.signal), late.dependencies);
    const cancelled = expect(waiting).rejects.toMatchObject({ code: "READ_TIMEOUT" });
    await vi.waitFor(() => expect(late.originRequests).toHaveLength(1));
    afterConnect.abort();
    await cancelled;
    late.sendOrigin();
    expect(late.originResponse.destroy).toHaveBeenCalled();
  });

  describe("opt-in hostname CONNECT for proxies that refuse IP-literal tunnels", () => {
    const proxied = { HTTPS_PROXY: "http://proxy-user:proxy-pass@proxy.example.com:8080/", META_API_KEY: "fixture-meta-key-never-forwarded" };

    test("default mode and any value other than exactly \"1\" still CONNECT by validated IP", async () => {
      for (const flag of [undefined, "", "0", "true", "yes", " 1"]) {
        const mock = transport({ environment: { ...proxied, TICKR_PROXY_CONNECT_BY_HOSTNAME: flag } });
        await pinnedHttpsRequest(origin, requestOptions(), mock.dependencies);
        expect(mock.connectRequests[0].options).toMatchObject({ path: "93.184.216.34:443", headers: { Host: "93.184.216.34:443" } });
      }
    });

    test("opt-in mode CONNECTs by hostname only after local validation, keeps TLS on the hostname and credentials off the origin", async () => {
      const mock = transport({ environment: { ...proxied, TICKR_PROXY_CONNECT_BY_HOSTNAME: "1" } });
      const response = await pinnedHttpsRequest(origin, requestOptions(), mock.dependencies);
      expect(response.body.toString()).toBe("public website");
      expect(mock.resolver).toHaveBeenCalledWith("bakery.example.com");
      expect(mock.resolver.mock.invocationCallOrder[0]).toBeLessThan(mock.request.mock.invocationCallOrder[0]);
      expect(mock.connectRequests).toHaveLength(1);
      expect(mock.connectRequests[0].options).toMatchObject({ hostname: "proxy.example.com", method: "CONNECT", path: "bakery.example.com:443", headers: { Host: "bakery.example.com:443", "Proxy-Authorization": `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}` } });
      expect(mock.tls).toHaveBeenCalledWith({ socket: mock.tunnel, servername: "bakery.example.com", rejectUnauthorized: true, checkServerIdentity });
      const headers = mock.originRequests[0].options.headers as Record<string, string>;
      expect(Object.keys(headers).some((header) => /authorization|cookie/i.test(header))).toBe(false);
      expect(JSON.stringify(headers)).not.toMatch(/proxy-user|proxy-pass|fixture-meta-key/);
    });

    test("opt-in mode still rejects private, metadata, mixed and unresolvable answers before any CONNECT", async () => {
      for (const answers of [[{ address: "10.0.0.5", family: 4 }], [{ address: "169.254.169.254", family: 4 }], [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }], [{ address: "2606:2800:220:1::", family: 6 }], []]) {
        const mock = transport({ environment: { ...proxied, TICKR_PROXY_CONNECT_BY_HOSTNAME: "1" } });
        mock.resolver.mockResolvedValue(answers);
        await expect(pinnedHttpsRequest(origin, requestOptions(), mock.dependencies)).rejects.toMatchObject({ code: "DESTINATION_NOT_PUBLIC" });
        expect(mock.request).not.toHaveBeenCalled();
        expect(mock.tls).not.toHaveBeenCalled();
      }
      const dnsDown = transport({ environment: { ...proxied, TICKR_PROXY_CONNECT_BY_HOSTNAME: "1" } });
      dnsDown.resolver.mockRejectedValue(new Error("ENOTFOUND"));
      await expect(pinnedHttpsRequest(origin, requestOptions(), dnsDown.dependencies)).rejects.toMatchObject({ code: "DNS_UNAVAILABLE" });
      expect(dnsDown.request).not.toHaveBeenCalled();
    });

    test("opt-in mode still rejects userinfo, non-443 ports, IP literals and non-HTTPS before DNS", async () => {
      for (const target of ["https://user:pass@bakery.example.com/", "https://bakery.example.com:8443/", "https://93.184.216.34/", "http://bakery.example.com/"]) {
        const mock = transport({ environment: { ...proxied, TICKR_PROXY_CONNECT_BY_HOSTNAME: "1" } });
        await expect(pinnedHttpsRequest(new URL(target), requestOptions(), mock.dependencies)).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
        expect(mock.resolver).not.toHaveBeenCalled();
        expect(mock.request).not.toHaveBeenCalled();
      }
    });

    test("a rejected hostname CONNECT is not retried by IP or directly", async () => {
      const mock = transport({ connectStatus: 403, environment: { ...proxied, TICKR_PROXY_CONNECT_BY_HOSTNAME: "1" } });
      await expect(pinnedHttpsRequest(origin, requestOptions(), mock.dependencies)).rejects.toMatchObject({ code: "PROXY_CONNECT_REJECTED" });
      expect(mock.connectRequests).toHaveLength(1);
      expect(mock.connectRequests[0].options.path).toBe("bakery.example.com:443");
      expect(mock.originRequests).toHaveLength(0);
      expect(mock.tls).not.toHaveBeenCalled();
    });

    test("the flag is ignored without a proxy: the direct connection stays pinned to the validated IP", async () => {
      const mock = transport({ environment: { TICKR_PROXY_CONNECT_BY_HOSTNAME: "1" } });
      await pinnedHttpsRequest(origin, requestOptions(), mock.dependencies);
      expect(mock.connectRequests).toHaveLength(0);
      expect(mock.tls).not.toHaveBeenCalled();
      expect(mock.originRequests).toHaveLength(1);
      const agent = mock.originRequests[0].options.agent as unknown as { options: { lookup: (host: string, options: object, callback: (error: Error | null, address: unknown) => void) => void } };
      const pinnedAddress = await new Promise((resolve, reject) => agent.options.lookup("bakery.example.com", { all: true }, (error, address) => error ? reject(error) : resolve(address)));
      expect(pinnedAddress).toEqual([{ address: "93.184.216.34", family: 4 }]);
      expect(mock.resolver).toHaveBeenCalledOnce();
    });

    test("authority helper fails closed on unvalidated addresses and unexpected hostnames", () => {
      expect(() => proxyConnectAuthority(origin, { address: "10.0.0.1" }, { TICKR_PROXY_CONNECT_BY_HOSTNAME: "1" })).toThrow(expect.objectContaining({ code: "DESTINATION_NOT_PUBLIC" }));
      expect(() => proxyConnectAuthority(new URL("https://bakery.example.com:8443/"), { address: "93.184.216.34" }, { TICKR_PROXY_CONNECT_BY_HOSTNAME: "1" })).toThrow(expect.objectContaining({ code: "URL_NOT_ALLOWED" }));
      expect(() => proxyConnectAuthority(new URL("https://[::1]/"), { address: "93.184.216.34" }, { TICKR_PROXY_CONNECT_BY_HOSTNAME: "1" })).toThrow(expect.objectContaining({ code: "URL_NOT_ALLOWED" }));
      expect(proxyConnectAuthority(origin, { address: "93.184.216.34" }, {})).toBe("93.184.216.34:443");
      expect(proxyConnectAuthority(origin, { address: "93.184.216.34" }, { TICKR_PROXY_CONNECT_BY_HOSTNAME: "1" })).toBe("bakery.example.com:443");
    });
  });
});
