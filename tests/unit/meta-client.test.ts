import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaClient, getMetaModelConfig, requireMetaModel } from "../../lib/meta";

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("Meta transport boundary", () => {
  it("requires server credentials and configured model IDs without network calls", async () => {
    vi.stubEnv("META_API_KEY", "");
    expect(() => new MetaClient()).toThrow("META_API_KEY");
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new MetaClient({ apiKey: "test-only-key", models: {}, fetch });
    await expect(client.requestJson("/responses", { method: "POST", modelRole: "reasoning", body: {} })).rejects.toMatchObject({ code: "MODEL_NOT_CONFIGURED" });
    expect(fetch).not.toHaveBeenCalled();
    expect(getMetaModelConfig({ META_REASONING_MODEL: " verified-model " })).toEqual({ reasoning: "verified-model" });
    expect(() => requireMetaModel("image", {})).toThrow("META_IMAGE_MODEL");
  });

  it("rejects foreign endpoints, traversal and redirects", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: "https://example.com" } }));
    const client = new MetaClient({ apiKey: "test-only-key", fetch });
    for (const endpoint of ["https://example.com/v1/models", "//example.com/models", "/../models", "/%2e%2e/models", "/models?redirect=https://example.com", "/models\\other"]) {
      await expect(client.requestJson(endpoint)).rejects.toMatchObject({ code: "ENDPOINT_NOT_ALLOWED" });
    }
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.listModels()).rejects.toMatchObject({ code: "REDIRECT_NOT_ALLOWED" });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://api.meta.ai/v1/models", expect.objectContaining({ redirect: "error", method: "GET" }));
  });

  it("does not expose upstream error bodies or credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("secret-key and private prompt", { status: 401 }));
    const client = new MetaClient({ apiKey: "secret-key", fetch });
    await expect(client.listModels()).rejects.toMatchObject({ code: "HTTP_ERROR", message: "Meta request failed (HTTP 401)" });
    expect(JSON.stringify(client)).not.toContain("secret-key");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses only the configured model and returns a mocked successful result", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ output: "example" }));
    const client = new MetaClient({ apiKey: "test-only-key", models: { reasoning: "verified-model" }, fetch });
    await expect(client.requestJson("/responses", { method: "POST", modelRole: "reasoning", body: { model: "unapproved-model" } })).rejects.toMatchObject({ code: "MODEL_MISMATCH" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.requestJson("/responses", { method: "POST", modelRole: "reasoning", body: { input: "example" } })).resolves.toEqual({ output: "example" });
    expect(fetch).toHaveBeenCalledWith("https://api.meta.ai/v1/responses", expect.objectContaining({ body: JSON.stringify({ input: "example", model: "verified-model" }), redirect: "error" }));
  });

  it("marks a paid timeout as unknown and never automatically retries", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const client = new MetaClient({ apiKey: "test-only-key", models: { reasoning: "verified-model" }, fetch, timeoutMs: 50 });
    const request = client.requestJson("/responses", { method: "POST", modelRole: "reasoning", body: { input: "test" } });
    const assertion = expect(request).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", outcome: "unknown" });
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("validates bounded response limits before making a request", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const maxResponseBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 32 * 1024 * 1024 + 1]) {
      expect(() => new MetaClient({ apiKey: "test-only-key", fetch, maxResponseBytes })).toThrow("response size limit");
    }
    expect(() => new MetaClient({ apiKey: "test-only-key", fetch, maxResponseBytes: 32 * 1024 * 1024 })).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared length before reading any body bytes", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { headers: { "Content-Length": String(4 * 1024 * 1024 + 1) } }));
    const client = new MetaClient({ apiKey: "test-only-key", fetch });
    await expect(client.listModels()).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE", outcome: "not_applicable" });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("parses UTF-8 split across chunks at the exact byte boundary", async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ text: "café 🍞" }));
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < payload.length) controller.enqueue(payload.subarray(offset, ++offset));
        else controller.close();
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { headers: { "Content-Length": "1" } }));
    const client = new MetaClient({ apiKey: "test-only-key", fetch, maxResponseBytes: payload.length });
    await expect(client.listModels()).resolves.toEqual({ text: "café 🍞" });
  });

  it.each([undefined, "1"])("stops an oversized chunked paid response with content-length %s", async (declaredLength) => {
    const chunks = [new TextEncoder().encode('{"text":"'), new TextEncoder().encode("private provider data"), new TextEncoder().encode('"}')];
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(chunks[pulls++]); },
      cancel,
    }, { highWaterMark: 0 });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { headers: declaredLength ? { "Content-Length": declaredLength } : {} }));
    const client = new MetaClient({ apiKey: "test-only-key", models: { reasoning: "verified-model" }, fetch, maxResponseBytes: 12 });
    await expect(client.requestJson("/responses", { method: "POST", modelRole: "reasoning", body: {} })).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE", outcome: "unknown", message: "Meta response exceeded the configured size limit; no retry was attempted",
    });
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("times out and cancels a stalled response body without retrying", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
    const client = new MetaClient({ apiKey: "test-only-key", models: { reasoning: "verified-model" }, fetch, timeoutMs: 50 });
    const assertion = expect(client.requestJson("/responses", { method: "POST", modelRole: "reasoning", body: {} })).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", outcome: "unknown" });
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sanitizes parse errors without exposing response content", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("secret-key private provider content"));
    const client = new MetaClient({ apiKey: "secret-key", fetch });
    await expect(client.listModels()).rejects.toMatchObject({ code: "INVALID_RESPONSE", message: "Meta returned a response that was not valid JSON" });
  });
});
