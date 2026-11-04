import {
  META_API_BASE_URL,
  MetaClientError,
  getMetaModelConfig,
  getServerEnvironment,
  requireMetaModel,
  type MetaModelConfig,
  type MetaModelRole,
} from "./config";

export interface MetaClientOptions {
  apiKey?: string;
  models?: MetaModelConfig;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Maximum decoded response-body bytes, before JSON parsing. Defaults to 4 MiB. */
  maxResponseBytes?: number;
}

export interface MetaJsonRequest {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  modelRole?: MetaModelRole;
}

/** Only simple paths below the fixed Meta v1 origin; URLs/query strings are rejected. */
export function resolveMetaEndpoint(path: string): string {
  if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) {
    throw new MetaClientError("ENDPOINT_NOT_ALLOWED", "Use a relative endpoint below the fixed Meta API origin");
  }
  return `${META_API_BASE_URL}${path}`;
}

async function readBoundedResponse(response: Response, maximumBytes: number, controller: AbortController, outcome: MetaClientError["outcome"]): Promise<string> {
  const tooLarge = () => new MetaClientError("RESPONSE_TOO_LARGE", "Meta response exceeded the configured size limit; no retry was attempted", { outcome });
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength.trim()) && Number(declaredLength) > maximumBytes) {
    controller.abort();
    void response.body?.cancel().catch(() => { /* Cancellation must not replace the sanitized limit error. */ });
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => { /* Best-effort release of the upstream stream. */ }); };
  controller.signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (controller.signal.aborted) throw new Error("Response aborted");
      const chunk = await reader.read();
      if (controller.signal.aborted) throw new Error("Response aborted");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        controller.abort();
        throw tooLarge();
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    controller.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/**
 * Server-side transport foundation, not a verified inference integration.
 * Callers must first verify endpoint schemas and account capabilities.
 * This client deliberately performs no automatic retries, including paid requests.
 */
export class MetaClient {
  readonly #apiKey: string;
  readonly #models: MetaModelConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: MetaClientOptions = {}) {
    const environment = getServerEnvironment();
    const key = options.apiKey ?? environment.META_API_KEY;
    if (!key?.trim()) {
      throw new MetaClientError("API_KEY_MISSING", "META_API_KEY is required in the server environment");
    }
    this.#apiKey = key.trim();
    this.#models = { ...(options.models ?? getMetaModelConfig(environment)) };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > 120_000) {
      throw new MetaClientError("INVALID_TIMEOUT", "Meta request timeout must be between 1 and 120000 milliseconds");
    }
    this.#maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes <= 0 || this.#maxResponseBytes > 32 * 1024 * 1024) {
      throw new MetaClientError("INVALID_RESPONSE_LIMIT", "Meta response size limit must be an integer between 1 and 33554432 bytes");
    }
  }

  /** Read-only probe. A successful listing does not verify inference capabilities. */
  async listModels(): Promise<unknown> {
    return this.requestJson("/models");
  }

  async requestJson<T = unknown>(path: string, request: MetaJsonRequest = {}): Promise<T> {
    const url = resolveMetaEndpoint(path);
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "POST") {
      throw new MetaClientError("METHOD_NOT_ALLOWED", "Only GET and POST are supported");
    }
    let body: string | undefined;
    if (method === "GET" && request.body !== undefined) {
      throw new MetaClientError("INVALID_REQUEST", "GET requests cannot carry a body");
    }
    if (method === "POST") {
      if (!request.modelRole) {
        throw new MetaClientError("MODEL_ROLE_REQUIRED", "A configured model role is required for an inference request");
      }
      const model = requireMetaModel(request.modelRole, this.#models);
      if (request.body?.model !== undefined && request.body.model !== model) {
        throw new MetaClientError("MODEL_MISMATCH", "The request model must match the configured model role");
      }
      try {
        body = JSON.stringify({ ...request.body, model });
      } catch {
        throw new MetaClientError("INVALID_REQUEST", "The request must be JSON serializable");
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const outcome = method === "POST" ? "unknown" : "not_applicable";
    try {
      const response = await this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body,
        redirect: "error",
        signal: controller.signal,
        cache: "no-store",
      });
      // Native fetch rejects redirects; also defend against custom fetch adapters.
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new MetaClientError("REDIRECT_NOT_ALLOWED", "Meta API redirects are not allowed", { outcome });
      }
      if (!response.ok) {
        // Never echo upstream bodies/headers: they can contain prompts or credentials.
        throw new MetaClientError("HTTP_ERROR", `Meta request failed (HTTP ${response.status})`, { status: response.status, outcome });
      }
      try {
        return JSON.parse(await readBoundedResponse(response, this.#maxResponseBytes, controller, outcome)) as T;
      } catch (error) {
        if (error instanceof MetaClientError) throw error;
        if (controller.signal.aborted) {
          throw new MetaClientError("REQUEST_TIMEOUT", "Meta request timed out; no retry was attempted", { outcome });
        }
        throw new MetaClientError("INVALID_RESPONSE", "Meta returned a response that was not valid JSON", { outcome });
      }
    } catch (error) {
      if (error instanceof MetaClientError) throw error;
      if (controller.signal.aborted) {
        throw new MetaClientError("REQUEST_TIMEOUT", "Meta request timed out; no retry was attempted", { outcome });
      }
      throw new MetaClientError("NETWORK_ERROR", "Meta request failed; no retry was attempted", { outcome });
    } finally {
      clearTimeout(timer);
    }
  }
}
