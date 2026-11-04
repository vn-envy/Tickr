import { createHmac } from "node:crypto";
import { z } from "zod";
import { isMetaCdnUrl } from "../media/meta-cdn";
import { getServerEnvironment } from "./config";
import { getTokenKeyStatus } from "./graph-tokens";

/**
 * Owner-authorized Meta Graph connector: Facebook Login (manual flow) ->
 * the owner's Pages -> the Instagram professional account linked to each
 * Page, used only to list the owner's OWN photos and videos. Media bytes are
 * fetched separately and credential-free from Meta CDNs (lib/media/meta-cdn.ts).
 *
 * Endpoint shapes verified 2026-11-04 against:
 * - https://developers.facebook.com/docs/graph-api/changelog (latest version v26.0, released 2026-07-29)
 * - https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 *   (dialog https://www.facebook.com/v26.0/dialog/oauth: client_id, redirect_uri, state, response_type, scope;
 *    code exchange graph.facebook.com/v26.0/oauth/access_token -> { access_token, token_type, expires_in })
 * - https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived (retrieved 2026-11-04:
 *   the code-exchange User token is short-lived (hours) and Page tokens derived from it are short-lived too;
 *   /oauth/access_token with grant_type=fb_exchange_token, client_id, client_secret, fb_exchange_token returns a
 *   long-lived User token, "generally about 60 days"; Page tokens read with it via /{user-id}/accounts do not expire)
 * - https://developers.facebook.com/docs/facebook-login/facebook-login-for-business (config_id replaces scope;
 *   response_type=code + override_default_response_type=true)
 * - https://developers.facebook.com/docs/pages-api/getting-started (GET /me/accounts -> id, name, access_token, tasks)
 * - https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/get-started
 *   (GET /{page-id}?fields=instagram_business_account)
 * - https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 *   (GET /{ig-user-id}/media; since/until; max 10K most recent; pages_read_engagement|pages_show_list + instagram_basic)
 * - https://developers.facebook.com/docs/instagram-platform/reference/instagram-media (media_type IMAGE|VIDEO|CAROUSEL_ALBUM,
 *   media_url optional: omitted for videos with copyrighted audio; thumbnail_url VIDEO only; children lack permalink/caption)
 * - https://developers.facebook.com/docs/graph-api/reference/page/photos/ (type=uploaded; Page token, pages_read_engagement)
 * - https://developers.facebook.com/docs/graph-api/reference/photo/ (images, name, link, created_time, width, height)
 * - https://developers.facebook.com/docs/video-api/guides/get-videos and .../reference/video/ (source = raw playable file URL)
 * - https://developers.facebook.com/docs/graph-api/results (cursor paging; stop when `next` is absent; do not store cursors)
 *
 * Boundary: one fixed origin (https://graph.facebook.com/<version>/...), no
 * redirects, bounded responses, timeouts, no automatic retries, errors that
 * never contain tokens, secrets, upstream messages or URLs. Access tokens go in
 * the Authorization header, never in a URL. Captions and names are untrusted
 * DATA, never instructions, and never proof of product identity.
 */

export const META_GRAPH_ORIGIN = "https://graph.facebook.com" as const;
export const META_LOGIN_DIALOG_ORIGIN = "https://www.facebook.com" as const;
/** Latest Graph API version per the changelog retrieved 2026-11-04. */
export const DEFAULT_META_GRAPH_VERSION = "v26.0" as const;
export const META_GRAPH_VERSION_ENV = "META_GRAPH_VERSION" as const;
export const MAX_OWNER_MEDIA_ITEMS = 60;

/**
 * Minimum permissions for reading the owner's own media through Facebook Login:
 * - pages_show_list: list the Pages the owner manages (GET /me/accounts) and read a Page's linked IG account.
 * - pages_read_engagement: read Page photos/videos with a Page token; also required with instagram_basic for IG media via Facebook Login.
 * - instagram_basic: read the linked Instagram professional account profile and its media.
 * business_management is NOT requested by default. Meta requires it (or ads_management) only when the owner's
 * access to the Page comes through a Business Manager role; callers opt in with `businessManaged: true`.
 */
export const META_OWNER_MEDIA_SCOPES = ["pages_show_list", "pages_read_engagement", "instagram_basic"] as const;
export const META_BUSINESS_MANAGED_SCOPE = "business_management" as const;

export type MetaOwnerProvenance = "owner_instagram" | "owner_facebook";
type Environment = Record<string, string | undefined>;

export class MetaGraphError extends Error {
  readonly code: string;
  readonly status?: number;
  /** Numeric Graph error code only (e.g. 190 expired token); upstream messages are never kept. */
  readonly graphCode?: number;
  constructor(code: string, message: string, options: { status?: number; graphCode?: number } = {}) {
    super(message);
    this.name = "MetaGraphError";
    this.code = code;
    this.status = options.status;
    this.graphCode = options.graphCode;
  }
}

export function getMetaGraphVersion(environment: Environment = getServerEnvironment()): string {
  const configured = environment[META_GRAPH_VERSION_ENV]?.trim();
  if (!configured) return DEFAULT_META_GRAPH_VERSION;
  const match = /^v([1-9]\d)\.0$/.exec(configured);
  if (!match || Number(match[1]) < 20) throw new MetaGraphError("INVALID_GRAPH_VERSION", `${META_GRAPH_VERSION_ENV} must look like ${DEFAULT_META_GRAPH_VERSION} (v20.0 or later).`);
  return configured;
}

export type MetaConnectorStatus = { status: "ready" } | { status: "not_configured"; missing: string[]; invalid: string[] };

/** Names only; never values. The connector stays off until every server-side setting is present. */
export function getMetaConnectorStatus(environment: Environment = getServerEnvironment()): MetaConnectorStatus {
  const missing: string[] = [];
  const invalid: string[] = [];
  const check = (name: string, valid: (value: string) => boolean) => {
    const value = environment[name]?.trim();
    if (!value) missing.push(name);
    else if (!valid(value)) invalid.push(name);
  };
  check("META_APP_ID", (value) => /^\d{5,32}$/.test(value));
  check("META_APP_SECRET", (value) => /^[A-Za-z0-9]{16,128}$/.test(value));
  check("META_OAUTH_REDIRECT_URI", (value) => parseRedirectUri(value) !== null);
  const key = getTokenKeyStatus(environment);
  if (key.status === "not_configured") (key.reason === "missing_key" ? missing : invalid).push("TICKR_SECRET_KEY");
  try { getMetaGraphVersion(environment); } catch { invalid.push(META_GRAPH_VERSION_ENV); }
  return missing.length || invalid.length ? { status: "not_configured", missing, invalid } : { status: "ready" };
}

function parseRedirectUri(value: string): URL | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.hash || value.length > 2048) return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return url;
}

/**
 * Fails closed: the server must have a valid registered META_OAUTH_REDIRECT_URI and the
 * caller's value must match it exactly (never a redirect derived from request headers).
 */
function requireRedirectUri(redirectUri: string, environment: Environment): string {
  const configured = environment.META_OAUTH_REDIRECT_URI?.trim();
  if (!configured || !parseRedirectUri(configured)) throw new MetaGraphError("NOT_CONFIGURED", "META_OAUTH_REDIRECT_URI must be set to the registered HTTPS callback URL in the server environment.");
  if (typeof redirectUri !== "string" || !parseRedirectUri(redirectUri)) throw new MetaGraphError("INVALID_REDIRECT_URI", "The OAuth redirect URI must be an HTTPS URL (HTTP only for localhost) without credentials or fragments.");
  if (configured !== redirectUri) throw new MetaGraphError("REDIRECT_URI_MISMATCH", "The OAuth redirect URI does not match META_OAUTH_REDIRECT_URI.");
  return redirectUri;
}

function requireAppId(environment: Environment): string {
  const appId = environment.META_APP_ID?.trim();
  if (!appId) throw new MetaGraphError("NOT_CONFIGURED", "META_APP_ID is required in the server environment.");
  if (!/^\d{5,32}$/.test(appId)) throw new MetaGraphError("NOT_CONFIGURED", "META_APP_ID is not a valid Meta app ID.");
  return appId;
}

function requireAppSecret(environment: Environment): string {
  const secret = environment.META_APP_SECRET?.trim();
  if (!secret || !/^[A-Za-z0-9]{16,128}$/.test(secret)) throw new MetaGraphError("NOT_CONFIGURED", "META_APP_SECRET is required in the server environment.");
  return secret;
}

export interface MetaLoginUrlInput {
  /** Signed state from createOAuthState (graph-tokens.ts). */
  state: string;
  redirectUri: string;
  /** Adds business_management for owners whose Page access comes through a Business Manager role. */
  businessManaged?: boolean;
}

/**
 * Manual-flow login dialog URL. If META_LOGIN_CONFIG_ID is set (Facebook Login
 * for Business configuration), config_id replaces scope as Meta documents.
 */
export function buildMetaLoginUrl(input: MetaLoginUrlInput, environment: Environment = getServerEnvironment()): string {
  const appId = requireAppId(environment);
  const redirectUri = requireRedirectUri(input.redirectUri, environment);
  if (typeof input.state !== "string" || !/^[A-Za-z0-9_.-]{16,1024}$/.test(input.state)) throw new MetaGraphError("INVALID_STATE", "A signed OAuth state is required.");
  const url = new URL(`${META_LOGIN_DIALOG_ORIGIN}/${getMetaGraphVersion(environment)}/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("response_type", "code");
  const configId = environment.META_LOGIN_CONFIG_ID?.trim();
  if (configId) {
    if (!/^\d{5,32}$/.test(configId)) throw new MetaGraphError("NOT_CONFIGURED", "META_LOGIN_CONFIG_ID is not a valid configuration ID.");
    url.searchParams.set("config_id", configId);
    url.searchParams.set("override_default_response_type", "true");
  } else {
    url.searchParams.set("scope", [...META_OWNER_MEDIA_SCOPES, ...(input.businessManaged ? [META_BUSINESS_MANAGED_SCOPE] : [])].join(","));
  }
  return url.href;
}

// ---------------------------------------------------------------------------
// Fixed-origin Graph transport
// ---------------------------------------------------------------------------

export interface MetaGraphClientOptions {
  fetch?: typeof globalThis.fetch;
  environment?: Environment;
  timeoutMs?: number;
  /** Maximum decoded body bytes per response. Defaults to 2 MiB. */
  maxResponseBytes?: number;
}

type QueryValue = string | number;
const PATH = /^\/[A-Za-z0-9_]{1,64}(?:\/[A-Za-z0-9_]{1,64}){0,2}$/;
const QUERY_NAMES = new Set(["fields", "limit", "since", "until", "after", "type", "__paging_token"]);
const PAGING_PARAMS = ["after", "until", "since", "__paging_token"] as const;
const NODE_ID = /^\d{1,32}$/;

async function readBounded(response: Response, maximumBytes: number, controller: AbortController): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maximumBytes) {
    controller.abort();
    void response.body?.cancel().catch(() => { /* Cancellation must not replace the limit error. */ });
    throw new MetaGraphError("RESPONSE_TOO_LARGE", "The Meta Graph response exceeded its size limit; no retry was attempted.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        controller.abort();
        void reader.cancel().catch(() => { /* Best-effort release. */ });
        throw new MetaGraphError("RESPONSE_TOO_LARGE", "The Meta Graph response exceeded its size limit; no retry was attempted.");
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally { reader.releaseLock(); }
}

const graphErrorSchema = z.object({ error: z.object({ code: z.number().int().optional(), error_subcode: z.number().int().optional() }).passthrough() }).passthrough();

function mapGraphError(status: number, graphCode: number | undefined): MetaGraphError {
  if (graphCode === 190 || status === 401) return new MetaGraphError("TOKEN_INVALID", "The Meta connection has expired or was revoked; reconnect the account.", { status, graphCode });
  if (graphCode !== undefined && (graphCode === 10 || (graphCode >= 200 && graphCode <= 299))) return new MetaGraphError("PERMISSION_DENIED", "The Meta connection lacks a permission needed to read this media; reconnect and grant access.", { status, graphCode });
  if ((graphCode !== undefined && [4, 17, 32, 613].includes(graphCode)) || status === 429) return new MetaGraphError("RATE_LIMITED", "Meta rate-limited the media listing; no retry was attempted.", { status, graphCode });
  if (graphCode === 100) return new MetaGraphError("INVALID_REQUEST", "Meta rejected the media listing request.", { status, graphCode });
  return new MetaGraphError("HTTP_ERROR", `Meta Graph request failed (HTTP ${status}).`, { status, graphCode });
}

class MetaGraphClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #environment: Environment;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly version: string;

  constructor(options: MetaGraphClientOptions = {}) {
    this.#environment = options.environment ?? getServerEnvironment();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > 60_000) throw new MetaGraphError("INVALID_TIMEOUT", "The Graph request timeout must be between 1 and 60000 milliseconds.");
    this.#maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes <= 0 || this.#maxResponseBytes > 8 * 1024 * 1024) throw new MetaGraphError("INVALID_RESPONSE_LIMIT", "The Graph response limit must be between 1 and 8388608 bytes.");
    this.version = getMetaGraphVersion(this.#environment);
  }

  endpoint(path: string): URL {
    if (!PATH.test(path)) throw new MetaGraphError("ENDPOINT_NOT_ALLOWED", "Use a relative path below the fixed Graph API origin.");
    return new URL(`${META_GRAPH_ORIGIN}/${this.version}${path}`);
  }

  /**
   * Accepts a Graph `next` link only when it targets the same versioned path on the fixed origin. For `/me/...`
   * paths Graph usually substitutes the numeric node ID (`/v26.0/1234567890/accounts`), which is accepted too.
   * Only cursor parameters are copied; the follow-up request is rebuilt from our own path, never from the link.
   */
  pagingParams(next: string, path: string): Record<string, string> | null {
    let url: URL;
    try { url = new URL(next); } catch { return null; }
    if (url.origin !== META_GRAPH_ORIGIN || url.username || url.password) return null;
    const prefix = `/${this.version}`;
    if (!url.pathname.startsWith(`${prefix}/`)) return null;
    const relative = url.pathname.slice(prefix.length);
    const meEdge = path.startsWith("/me/") ? path.slice("/me".length) : null;
    const meNode = meEdge !== null && relative.endsWith(meEdge) && NODE_ID.test(relative.slice(1, -meEdge.length));
    if (relative !== path && !meNode) return null;
    const params: Record<string, string> = {};
    for (const name of PAGING_PARAMS) {
      const value = url.searchParams.get(name);
      if (value === null) continue;
      if (!/^[A-Za-z0-9_\-=.%+/]{1,2048}$/.test(value)) return null;
      params[name] = value;
    }
    return Object.keys(params).length ? params : null;
  }

  #appSecretProof(token: string): string | undefined {
    const secret = this.#environment.META_APP_SECRET?.trim();
    return secret ? createHmac("sha256", secret).update(token).digest("hex") : undefined;
  }

  async get(path: string, token: string, query: Record<string, QueryValue> = {}): Promise<unknown> {
    return this.#send("GET", path, token, query);
  }

  async delete(path: string, token: string): Promise<unknown> {
    return this.#send("DELETE", path, token, {});
  }

  /** Code and long-lived token exchange: form-encoded POST so the app secret and tokens never appear in a URL. */
  async exchange(form: Record<string, string>): Promise<unknown> {
    return this.#send("POST", "/oauth/access_token", null, {}, new URLSearchParams(form).toString());
  }

  async #send(method: "GET" | "POST" | "DELETE", path: string, token: string | null, query: Record<string, QueryValue>, form?: string): Promise<unknown> {
    const url = this.endpoint(path);
    for (const [name, value] of Object.entries(query)) {
      if (!QUERY_NAMES.has(name)) throw new MetaGraphError("INVALID_REQUEST", "The Graph request used a parameter outside the connector allowlist.");
      url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token !== null) {
      if (!/^[A-Za-z0-9_\-.|]{16,4096}$/.test(token)) throw new MetaGraphError("TOKEN_INVALID", "The Meta connection token is not usable; reconnect the account.");
      headers.Authorization = `Bearer ${token}`;
      const proof = this.#appSecretProof(token);
      if (proof) url.searchParams.set("appsecret_proof", proof);
    }
    if (form !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url.href, { method, headers, body: form, redirect: "error", signal: controller.signal, cache: "no-store" });
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new MetaGraphError("REDIRECT_NOT_ALLOWED", "Meta Graph redirects are not allowed.");
      if (!response.ok) {
        // Only the numeric Graph error code is read; upstream messages/bodies are never echoed.
        let graphCode: number | undefined;
        try { graphCode = graphErrorSchema.safeParse(JSON.parse(await readBounded(response, 64 * 1024, controller))).data?.error.code; } catch { /* Error bodies are optional. */ }
        throw mapGraphError(response.status, graphCode);
      }
      const text = await readBounded(response, this.#maxResponseBytes, controller);
      try { return JSON.parse(text) as unknown; } catch { throw new MetaGraphError("INVALID_RESPONSE", "Meta Graph returned a response that was not valid JSON."); }
    } catch (error) {
      if (error instanceof MetaGraphError) throw error;
      if (controller.signal.aborted) throw new MetaGraphError("REQUEST_TIMEOUT", "The Meta Graph request timed out; no retry was attempted.");
      throw new MetaGraphError("NETWORK_ERROR", "The Meta Graph request failed; no retry was attempted.");
    } finally { clearTimeout(timer); }
  }
}

// ---------------------------------------------------------------------------
// OAuth code exchange and revocation
// ---------------------------------------------------------------------------

const tokenResponseSchema = z.object({
  access_token: z.string().regex(/^[A-Za-z0-9_\-.|]{16,4096}$/),
  token_type: z.string().max(64).optional(),
  expires_in: z.number().int().positive().max(10 * 365 * 24 * 3600).optional(),
}).passthrough();

export interface MetaUserToken {
  accessToken: string;
  tokenType: string;
  expiresAt: Date | null;
  /** True after the fb_exchange_token upgrade (about 60 days); false means the hours-long code-exchange token. */
  longLived: boolean;
  /** Sanitized MetaGraphError code when the long-lived upgrade failed and the short-lived token was kept. */
  upgradeErrorCode?: string;
}

type TokenExchangeOptions = MetaGraphClientOptions & { now?: () => Date };
const TOKEN_PATTERN = /^[A-Za-z0-9_\-.|]{16,4096}$/;

async function postTokenExchange(client: MetaGraphClient, form: Record<string, string>, now: Date, longLived: boolean): Promise<MetaUserToken> {
  const parsed = tokenResponseSchema.safeParse(await client.exchange(form));
  if (!parsed.success) throw new MetaGraphError("INVALID_RESPONSE", "Meta returned an unexpected token response.");
  return {
    accessToken: parsed.data.access_token,
    tokenType: parsed.data.token_type ?? "bearer",
    expiresAt: parsed.data.expires_in === undefined ? null : new Date(now.getTime() + parsed.data.expires_in * 1000),
    longLived,
  };
}

/**
 * Server-side only: upgrades a valid short-lived User token to a long-lived one (about 60 days) so autonomous
 * harvesting can continue long after the owner connects. Secret and token travel in a form POST body (Meta
 * documents a GET with query parameters; the POST form is an assumption pending live verification, as for the
 * code exchange). One request, never retried; errors are sanitized.
 */
export async function exchangeForLongLivedToken(shortLivedToken: string, options: TokenExchangeOptions = {}): Promise<MetaUserToken> {
  const environment = options.environment ?? getServerEnvironment();
  if (typeof shortLivedToken !== "string" || !TOKEN_PATTERN.test(shortLivedToken)) throw new MetaGraphError("TOKEN_INVALID", "The Meta connection token is not usable; reconnect the account.");
  const form = { grant_type: "fb_exchange_token", client_id: requireAppId(environment), client_secret: requireAppSecret(environment), fb_exchange_token: shortLivedToken };
  const client = new MetaGraphClient({ ...options, environment });
  return postTokenExchange(client, form, options.now?.() ?? new Date(), true);
}

/**
 * Server-side only: exchanges the authorization code (META_APP_SECRET in a POST body; neither the code, secret
 * nor token is ever logged or echoed), then immediately upgrades the short-lived result to a long-lived token.
 * If only the upgrade fails, the short-lived token is returned with `longLived: false` and the sanitized error
 * code (the single-use code cannot be redeemed again), so the caller can harvest now and ask for a reconnect later.
 */
export async function exchangeCodeForToken(code: string, redirectUri: string, options: TokenExchangeOptions = {}): Promise<MetaUserToken> {
  const environment = options.environment ?? getServerEnvironment();
  if (typeof code !== "string" || !/^[A-Za-z0-9_\-.~+/=]{8,2048}$/.test(code)) throw new MetaGraphError("INVALID_CODE", "The Meta authorization code is missing or malformed.");
  const form = { client_id: requireAppId(environment), client_secret: requireAppSecret(environment), redirect_uri: requireRedirectUri(redirectUri, environment), code };
  const client = new MetaGraphClient({ ...options, environment });
  const shortLived = await postTokenExchange(client, form, options.now?.() ?? new Date(), false);
  try {
    return await exchangeForLongLivedToken(shortLived.accessToken, { ...options, environment });
  } catch (error) {
    if (!(error instanceof MetaGraphError)) throw error;
    return { ...shortLived, upgradeErrorCode: error.code };
  }
}

/** Graph-side revocation of every permission this app holds for the owner. Pair with deleteOwnerToken. */
export async function revokeMetaPermissions(token: string, options: MetaGraphClientOptions = {}): Promise<{ revoked: boolean }> {
  const result = z.object({ success: z.boolean() }).passthrough().safeParse(await new MetaGraphClient(options).delete("/me/permissions", token));
  if (!result.success) throw new MetaGraphError("INVALID_RESPONSE", "Meta returned an unexpected revocation response.");
  return { revoked: result.data.success };
}

// ---------------------------------------------------------------------------
// Owner media sources
// ---------------------------------------------------------------------------

const displayText = (maximum: number) => z.string().transform((value) => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum) || null);

export const ownerMediaSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("facebook_page"), id: z.string().regex(NODE_ID), name: z.string().max(200).nullable(), provenance: z.literal("owner_facebook") }).strict(),
  z.object({ kind: z.literal("instagram_account"), id: z.string().regex(NODE_ID), pageId: z.string().regex(NODE_ID), username: z.string().max(200).nullable(), provenance: z.literal("owner_instagram") }).strict(),
]);
/** Token-free description of a media source. Names are owner-account DATA, not verified identity. */
export type OwnerMediaSource = z.infer<typeof ownerMediaSourceSchema>;

const pageEntrySchema = z.object({
  id: z.string().regex(NODE_ID),
  name: displayText(200).optional(),
  instagram_business_account: z.object({ id: z.string().regex(NODE_ID), username: displayText(200).optional() }).passthrough().optional(),
}).passthrough();
const pagingSchema = z.object({ next: z.string().max(8192).optional() }).passthrough();
const listSchema = z.object({ data: z.array(z.unknown()).max(500), paging: pagingSchema.optional() }).passthrough();

interface EdgePage { items: unknown[]; next: Record<string, string> | null; untrustedNext: boolean }

async function readEdgePage(client: MetaGraphClient, path: string, token: string, query: Record<string, QueryValue>): Promise<EdgePage> {
  const parsed = listSchema.safeParse(await client.get(path, token, query));
  if (!parsed.success) throw new MetaGraphError("INVALID_RESPONSE", "Meta returned an unexpected listing response.");
  const nextLink = parsed.data.paging?.next;
  if (!nextLink) return { items: parsed.data.data, next: null, untrustedNext: false };
  const next = client.pagingParams(nextLink, path);
  return { items: parsed.data.data, next, untrustedNext: next === null };
}

/** Lists the owner's Pages and each Page's linked Instagram professional account (tokens stay inside this module). */
const MAX_SOURCE_PAGES = 4;

export async function listOwnerMediaSources(token: string, options: MetaGraphClientOptions = {}): Promise<{ sources: OwnerMediaSource[]; warnings: string[]; truncated: boolean }> {
  const client = new MetaGraphClient(options);
  const sources: OwnerMediaSource[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let paging: Record<string, string> = {};
  for (let page = 0; page < MAX_SOURCE_PAGES; page++) {
    const result = await readEdgePage(client, "/me/accounts", token, { fields: "id,name,instagram_business_account{id,username}", limit: 50, ...paging });
    for (const raw of result.items) {
      const entry = pageEntrySchema.safeParse(raw);
      if (!entry.success) { warnings.push("A Page entry with an unexpected shape was skipped."); continue; }
      if (seen.has(`page:${entry.data.id}`)) continue;
      seen.add(`page:${entry.data.id}`);
      sources.push({ kind: "facebook_page", id: entry.data.id, name: entry.data.name ?? null, provenance: "owner_facebook" });
      const instagram = entry.data.instagram_business_account;
      if (instagram && !seen.has(`ig:${instagram.id}`)) {
        seen.add(`ig:${instagram.id}`);
        sources.push({ kind: "instagram_account", id: instagram.id, pageId: entry.data.id, username: instagram.username ?? null, provenance: "owner_instagram" });
      }
    }
    if (result.untrustedNext) { warnings.push("Paging stopped: Meta returned a next link outside the fixed Graph endpoint."); return { sources, warnings, truncated: true }; }
    if (!result.next) return { sources, warnings, truncated: false };
    paging = result.next;
  }
  warnings.push(`Only the first ${MAX_SOURCE_PAGES * 50} Pages were listed; more Pages exist.`);
  return { sources, warnings, truncated: true };
}

// ---------------------------------------------------------------------------
// Owner media listing
// ---------------------------------------------------------------------------

export interface OwnerMediaItem {
  /** Graph media ID (carousel children use their own child ID). */
  sourceId: string;
  /** Carousel album ID for a child item, otherwise null. */
  parentSourceId: string | null;
  /** The Page or Instagram account the item was listed from. */
  sourceAccountId: string;
  kind: "image" | "video";
  /** Short-lived signed Meta CDN URL; download promptly with downloadMetaCdnMedia and never persist as a durable link. */
  mediaUrl: string;
  thumbnailUrl: string | null;
  /** Owner-written caption: untrusted DATA, never instructions or verified product facts. */
  caption: string | null;
  permalink: string | null;
  timestamp: string | null;
  provenance: MetaOwnerProvenance;
  /** Owner-connected account: rights are owner-attested, not independently verified. */
  rights: "owner_attested";
  mediaProductType: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

export type OwnerMediaSkipReason = "media_url_unavailable" | "non_meta_cdn_url" | "unsupported_media_type" | "invalid_item";
export interface OwnerMediaListing {
  source: OwnerMediaSource;
  items: OwnerMediaItem[];
  skipped: { sourceId: string | null; reason: OwnerMediaSkipReason }[];
  /** True when more media existed than the requested limit (or paging was cut short). */
  truncated: boolean;
  warnings: string[];
}

export interface ListOwnerMediaOptions { limit?: number; since?: Date | string }

const CAPTION_MAX = 2200;
const caption = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const cleaned = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
  return cleaned ? cleaned.slice(0, CAPTION_MAX) : null;
};
const timestamp = (value: string | undefined): string | null => {
  if (!value) return null;
  const parsed = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const PERMALINK_HOSTS = new Set(["www.instagram.com", "instagram.com", "www.facebook.com", "facebook.com", "m.facebook.com", "business.facebook.com"]);
function permalink(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value, META_LOGIN_DIALOG_ORIGIN); } catch { return null; }
  return url.protocol === "https:" && !url.username && !url.password && !url.port && PERMALINK_HOSTS.has(url.hostname) && url.href.length <= 2048 ? url.href : null;
}
const cdnUrl = (value: string | undefined): string | null => value && isMetaCdnUrl(value) ? new URL(value).href : null;

const igChildSchema = z.object({
  id: z.string().regex(NODE_ID),
  media_type: z.string().max(32),
  media_url: z.string().max(4096).optional(),
  thumbnail_url: z.string().max(4096).optional(),
  timestamp: z.string().max(64).optional(),
}).passthrough();
const igMediaSchema = igChildSchema.extend({
  media_product_type: z.string().max(32).optional(),
  permalink: z.string().max(4096).optional(),
  caption: z.string().max(65_536).optional(),
  children: z.object({ data: z.array(z.unknown()).max(50) }).passthrough().optional(),
});
const imageSourceSchema = z.object({ source: z.string().max(4096), width: z.number().int().positive().max(100_000), height: z.number().int().positive().max(100_000) }).passthrough();
const fbPhotoSchema = z.object({
  id: z.string().regex(NODE_ID),
  name: z.string().max(65_536).optional(),
  link: z.string().max(4096).optional(),
  created_time: z.string().max(64).optional(),
  width: z.number().int().positive().max(100_000).optional(),
  height: z.number().int().positive().max(100_000).optional(),
  images: z.array(z.unknown()).max(50).optional(),
}).passthrough();
const fbVideoSchema = z.object({
  id: z.string().regex(NODE_ID),
  description: z.string().max(65_536).optional(),
  created_time: z.string().max(64).optional(),
  source: z.string().max(4096).optional(),
  picture: z.string().max(4096).optional(),
  permalink_url: z.string().max(4096).optional(),
  length: z.number().nonnegative().max(24 * 3600).optional(),
}).passthrough();

function validateListOptions(options: ListOwnerMediaOptions): { limit: number; since: number | null } {
  const limit = options.limit ?? MAX_OWNER_MEDIA_ITEMS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OWNER_MEDIA_ITEMS) throw new MetaGraphError("INVALID_LIMIT", `The media limit must be an integer between 1 and ${MAX_OWNER_MEDIA_ITEMS}.`);
  if (options.since === undefined) return { limit, since: null };
  const time = options.since instanceof Date ? options.since.getTime() : typeof options.since === "string" ? Date.parse(options.since) : Number.NaN;
  if (!Number.isFinite(time) || time < 0) throw new MetaGraphError("INVALID_SINCE", "The since filter must be a valid date.");
  return { limit, since: Math.floor(time / 1000) };
}

type Sink = { items: OwnerMediaItem[]; skipped: OwnerMediaListing["skipped"] };

function pushInstagram(raw: unknown, account: string, sink: Sink): void {
  const parsed = igMediaSchema.safeParse(raw);
  if (!parsed.success) { sink.skipped.push({ sourceId: null, reason: "invalid_item" }); return; }
  const media = parsed.data;
  const base = {
    sourceAccountId: account, caption: caption(media.caption), permalink: permalink(media.permalink),
    provenance: "owner_instagram" as const, rights: "owner_attested" as const, mediaProductType: media.media_product_type ?? null,
    width: null, height: null, durationSeconds: null,
  };
  const emit = (entry: z.infer<typeof igChildSchema>, parentSourceId: string | null) => {
    const kind = entry.media_type === "IMAGE" ? "image" : entry.media_type === "VIDEO" ? "video" : null;
    if (!kind) { sink.skipped.push({ sourceId: entry.id, reason: "unsupported_media_type" }); return; }
    // media_url is optional (e.g. videos with copyrighted audio); never substitute a permalink or thumbnail as the asset.
    if (!entry.media_url) { sink.skipped.push({ sourceId: entry.id, reason: "media_url_unavailable" }); return; }
    const mediaUrl = cdnUrl(entry.media_url);
    if (!mediaUrl) { sink.skipped.push({ sourceId: entry.id, reason: "non_meta_cdn_url" }); return; }
    sink.items.push({ ...base, sourceId: entry.id, parentSourceId, kind, mediaUrl, thumbnailUrl: kind === "video" ? cdnUrl(entry.thumbnail_url) : null, timestamp: timestamp(entry.timestamp ?? media.timestamp) });
  };
  if (media.media_type !== "CAROUSEL_ALBUM") { emit(media, null); return; }
  const children = media.children?.data ?? [];
  if (!children.length) { sink.skipped.push({ sourceId: media.id, reason: "media_url_unavailable" }); return; }
  for (const rawChild of children) {
    const child = igChildSchema.safeParse(rawChild);
    if (child.success) emit(child.data, media.id);
    else sink.skipped.push({ sourceId: null, reason: "invalid_item" });
  }
}

function pushFacebookPhoto(raw: unknown, account: string, sink: Sink): void {
  const parsed = fbPhotoSchema.safeParse(raw);
  if (!parsed.success) { sink.skipped.push({ sourceId: null, reason: "invalid_item" }); return; }
  const photo = parsed.data;
  const renditions = (photo.images ?? []).flatMap((entry) => {
    const image = imageSourceSchema.safeParse(entry);
    const url = image.success ? cdnUrl(image.data.source) : null;
    return image.success && url ? [{ url, width: image.data.width, height: image.data.height }] : [];
  }).sort((a, b) => b.width * b.height - a.width * a.height);
  if (!renditions.length) { sink.skipped.push({ sourceId: photo.id, reason: photo.images?.length ? "non_meta_cdn_url" : "media_url_unavailable" }); return; }
  const largest = renditions[0];
  const thumbnail = [...renditions].reverse().find((entry) => entry.width >= 200) ?? renditions[renditions.length - 1];
  sink.items.push({
    sourceId: photo.id, parentSourceId: null, sourceAccountId: account, kind: "image", mediaUrl: largest.url,
    thumbnailUrl: thumbnail.url === largest.url ? null : thumbnail.url, caption: caption(photo.name), permalink: permalink(photo.link),
    timestamp: timestamp(photo.created_time), provenance: "owner_facebook", rights: "owner_attested", mediaProductType: null,
    width: largest.width, height: largest.height, durationSeconds: null,
  });
}

function pushFacebookVideo(raw: unknown, account: string, sink: Sink): void {
  const parsed = fbVideoSchema.safeParse(raw);
  if (!parsed.success) { sink.skipped.push({ sourceId: null, reason: "invalid_item" }); return; }
  const video = parsed.data;
  if (!video.source) { sink.skipped.push({ sourceId: video.id, reason: "media_url_unavailable" }); return; }
  const mediaUrl = cdnUrl(video.source);
  if (!mediaUrl) { sink.skipped.push({ sourceId: video.id, reason: "non_meta_cdn_url" }); return; }
  sink.items.push({
    sourceId: video.id, parentSourceId: null, sourceAccountId: account, kind: "video", mediaUrl, thumbnailUrl: cdnUrl(video.picture),
    caption: caption(video.description), permalink: permalink(video.permalink_url), timestamp: timestamp(video.created_time),
    provenance: "owner_facebook", rights: "owner_attested", mediaProductType: null, width: null, height: null, durationSeconds: video.length ?? null,
  });
}

const MAX_EDGE_PAGES = 10;

/** Pages through one edge until `limit` normalized items exist, `next` is absent, or the page budget is spent. */
async function collectEdge(client: MetaGraphClient, path: string, token: string, query: Record<string, QueryValue>, limit: number, push: (raw: unknown, sink: Sink) => void, warnings: string[]): Promise<Sink & { more: boolean }> {
  const sink: Sink = { items: [], skipped: [] };
  let paging: Record<string, string> = {};
  for (let page = 0; page < MAX_EDGE_PAGES; page++) {
    const result = await readEdgePage(client, path, token, { ...query, limit: Math.min(25, Math.max(1, limit - sink.items.length)), ...paging });
    for (const raw of result.items) push(raw, sink);
    if (result.untrustedNext) { warnings.push("Paging stopped: Meta returned a next link outside the fixed Graph endpoint."); return { ...sink, more: true }; }
    if (sink.items.length >= limit) return { ...sink, more: sink.items.length > limit || result.next !== null };
    if (!result.next) return { ...sink, more: false };
    paging = result.next;
  }
  warnings.push("Paging stopped after the page budget was spent.");
  return { ...sink, more: true };
}

const IG_FIELDS = "id,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,caption,children{id,media_type,media_url,thumbnail_url,timestamp}";
const FB_PHOTO_FIELDS = "id,name,link,created_time,width,height,images";
const FB_VIDEO_FIELDS = "id,description,created_time,source,picture,permalink_url,length";
const pageTokenSchema = z.object({ id: z.string().regex(NODE_ID), access_token: z.string().regex(/^[A-Za-z0-9_\-.|]{16,4096}$/) }).passthrough();

/**
 * Lists up to `limit` (<= 60) of the owner's photos/videos from one connected
 * source, newest first, expanding carousel children. Items without a Meta CDN
 * media URL are reported as skipped rather than replaced.
 */
export async function listOwnerMedia(token: string, source: OwnerMediaSource, options: ListOwnerMediaOptions = {}, clientOptions: MetaGraphClientOptions = {}): Promise<OwnerMediaListing> {
  const checked = ownerMediaSourceSchema.safeParse(source);
  if (!checked.success) throw new MetaGraphError("INVALID_SOURCE", "The media source is not a connected Page or Instagram account.");
  const { limit, since } = validateListOptions(options);
  const client = new MetaGraphClient(clientOptions);
  const warnings: string[] = [];
  const timeWindow: Record<string, QueryValue> = since === null ? {} : { since };
  const account = checked.data.id;

  if (checked.data.kind === "instagram_account") {
    const result = await collectEdge(client, `/${account}/media`, token, { fields: IG_FIELDS, ...timeWindow }, limit, (raw, sink) => pushInstagram(raw, account, sink), warnings);
    return { source: checked.data, items: result.items.slice(0, limit), skipped: result.skipped, truncated: result.more, warnings };
  }

  // Page media needs the Page access token; it is fetched per call and never returned or stored by this module.
  const pageToken = pageTokenSchema.safeParse(await client.get(`/${account}`, token, { fields: "id,access_token" }));
  if (!pageToken.success || pageToken.data.id !== account) throw new MetaGraphError("PERMISSION_DENIED", "The Meta connection cannot read this Page's media; reconnect and grant Page access.");
  const photos = await collectEdge(client, `/${account}/photos`, pageToken.data.access_token, { type: "uploaded", fields: FB_PHOTO_FIELDS, ...timeWindow }, limit, (raw, sink) => pushFacebookPhoto(raw, account, sink), warnings);
  const videos = await collectEdge(client, `/${account}/videos`, pageToken.data.access_token, { fields: FB_VIDEO_FIELDS, ...timeWindow }, limit, (raw, sink) => pushFacebookVideo(raw, account, sink), warnings);
  const merged = [...photos.items, ...videos.items].sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
  return {
    source: checked.data,
    items: merged.slice(0, limit),
    skipped: [...photos.skipped, ...videos.skipped],
    truncated: photos.more || videos.more || merged.length > limit,
    warnings,
  };
}
