import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * Owner-authorized Meta Graph tokens at rest. Tokens are encrypted with
 * AES-256-GCM under a key derived (HKDF-SHA256) from TICKR_SECRET_KEY, a
 * 32-byte base64 server secret. Without that key the connector reports
 * `not_configured` and nothing is stored. Records live in an application-
 * controlled private directory (default `.data/connections/`, ignored by git),
 * one 0600 file per business. Plaintext tokens never reach logs, errors,
 * fixtures or API responses.
 */

export const TOKEN_KEY_ENV = "TICKR_SECRET_KEY" as const;
const RECORD_VERSION = 1 as const;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_TOKEN_CHARS = 4096;
const DEFAULT_STATE_TTL_MS = 10 * 60_000;
const MAX_STATE_TTL_MS = 30 * 60_000;
const MAX_STATE_CHARS = 1024;

export class GraphTokenError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "GraphTokenError"; }
}

export type ConnectorKeyStatus = { status: "configured" } | { status: "not_configured"; reason: "missing_key" | "invalid_key" };
type Environment = Record<string, string | undefined>;
interface DerivedKeys { encryption: Buffer; state: Buffer }

const BUSINESS_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidBusinessId(value: unknown): value is string {
  return typeof value === "string" && BUSINESS_ID.test(value);
}

function requireBusinessId(value: unknown): string {
  if (!isValidBusinessId(value)) throw new GraphTokenError("INVALID_BUSINESS_ID", "The business identifier is not valid for a connection record.");
  return value;
}

function readKeyMaterial(environment: Environment): Buffer | ConnectorKeyStatus {
  const raw = environment[TOKEN_KEY_ENV]?.trim();
  if (!raw) return { status: "not_configured", reason: "missing_key" };
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) return { status: "not_configured", reason: "invalid_key" };
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : { status: "not_configured", reason: "invalid_key" };
}

/** Reports configuration only; never returns or logs key material. */
export function getTokenKeyStatus(environment: Environment = process.env): ConnectorKeyStatus {
  const material = readKeyMaterial(environment);
  if (Buffer.isBuffer(material)) { material.fill(0); return { status: "configured" }; }
  return material;
}

function deriveKeys(environment: Environment): DerivedKeys {
  const material = readKeyMaterial(environment);
  if (!Buffer.isBuffer(material)) throw new GraphTokenError("NOT_CONFIGURED", `${TOKEN_KEY_ENV} must be a 32-byte base64 server secret before Meta connections can be stored.`);
  // Separate subkeys: an OAuth state MAC can never be confused with ciphertext authentication.
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), info, 32));
  const keys = { encryption: derive("tickr/meta-graph/token-encryption/v1"), state: derive("tickr/meta-graph/oauth-state/v1") };
  material.fill(0);
  return keys;
}

const b64url = (value: Buffer) => value.toString("base64url");
const fromB64url = (value: string) => Buffer.from(value, "base64url");

// ---------------------------------------------------------------------------
// Encrypted token records
// ---------------------------------------------------------------------------

export interface OwnerTokenInput {
  accessToken: string;
  /** Absolute expiry, or null when Meta reported no expiry. */
  expiresAt: Date | null;
  grantedScopes?: string[];
}

export interface OwnerTokenRecord {
  businessId: string;
  accessToken: string;
  expiresAt: string | null;
  storedAt: string;
  grantedScopes: string[];
}

/** Metadata safe for status displays: never the token. */
export type OwnerTokenMetadata = Omit<OwnerTokenRecord, "accessToken">;

const isoDate = z.string().datetime({ offset: true });
const storedRecordSchema = z.object({
  version: z.literal(RECORD_VERSION),
  businessId: z.string().regex(BUSINESS_ID),
  algorithm: z.literal("aes-256-gcm"),
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{1,8192}$/),
  storedAt: isoDate,
  expiresAt: isoDate.nullable(),
  grantedScopes: z.array(z.string().regex(/^[a-z_]{1,64}$/)).max(32),
}).strict();
type StoredRecord = z.infer<typeof storedRecordSchema>;

/** Binds ciphertext to its business and metadata so a record cannot be swapped between businesses or re-dated. */
function additionalData(record: Pick<StoredRecord, "version" | "businessId" | "storedAt" | "expiresAt" | "grantedScopes">): Buffer {
  return Buffer.from(JSON.stringify(["tickr-meta-owner-token", record.version, record.businessId, record.storedAt, record.expiresAt, record.grantedScopes]));
}

export function encryptOwnerToken(businessId: string, input: OwnerTokenInput, environment: Environment = process.env, now = new Date()): StoredRecord {
  requireBusinessId(businessId);
  const token = typeof input.accessToken === "string" ? input.accessToken.trim() : "";
  if (!token || token.length > MAX_TOKEN_CHARS || /\s/.test(token)) throw new GraphTokenError("INVALID_TOKEN", "The Meta access token could not be stored.");
  if (input.expiresAt !== null && (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()))) throw new GraphTokenError("INVALID_EXPIRY", "The token expiry is invalid.");
  const grantedScopes = [...new Set(input.grantedScopes ?? [])].sort();
  if (grantedScopes.length > 32 || grantedScopes.some((scope) => !/^[a-z_]{1,64}$/.test(scope))) throw new GraphTokenError("INVALID_SCOPES", "The granted scope list is invalid.");
  const keys = deriveKeys(environment);
  try {
    const metadata = { version: RECORD_VERSION, businessId, storedAt: now.toISOString(), expiresAt: input.expiresAt?.toISOString() ?? null, grantedScopes };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keys.encryption, iv);
    cipher.setAAD(additionalData(metadata));
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return { ...metadata, algorithm: "aes-256-gcm", iv: b64url(iv), tag: b64url(cipher.getAuthTag()), ciphertext: b64url(ciphertext) };
  } finally { keys.encryption.fill(0); keys.state.fill(0); }
}

export function decryptOwnerToken(record: unknown, environment: Environment = process.env): OwnerTokenRecord {
  const parsed = storedRecordSchema.safeParse(record);
  if (!parsed.success) throw new GraphTokenError("RECORD_INVALID", "The stored Meta connection record is invalid; reconnect the account.");
  const stored = parsed.data;
  const keys = deriveKeys(environment);
  try {
    const decipher = createDecipheriv("aes-256-gcm", keys.encryption, fromB64url(stored.iv));
    decipher.setAAD(additionalData(stored));
    decipher.setAuthTag(fromB64url(stored.tag));
    const accessToken = Buffer.concat([decipher.update(fromB64url(stored.ciphertext)), decipher.final()]).toString("utf8");
    return { businessId: stored.businessId, accessToken, expiresAt: stored.expiresAt, storedAt: stored.storedAt, grantedScopes: stored.grantedScopes };
  } catch {
    throw new GraphTokenError("RECORD_UNREADABLE", "The stored Meta connection could not be decrypted; reconnect the account.");
  } finally { keys.encryption.fill(0); keys.state.fill(0); }
}

export interface TokenStoreOptions {
  /** Application-controlled private directory; never an owner- or model-supplied path. */
  directory?: string;
  environment?: Environment;
  now?: () => Date;
}

export function defaultConnectionsDirectory(): string {
  return resolve(process.cwd(), ".data", "connections");
}

function recordPath(directory: string | undefined, businessId: string): string {
  return join(resolve(directory ?? defaultConnectionsDirectory()), `${requireBusinessId(businessId)}.json`);
}

export type SaveOwnerTokenResult = { status: "stored"; metadata: OwnerTokenMetadata } | { status: "not_configured"; reason: "missing_key" | "invalid_key" };

/** Atomically writes one 0600 record per business. Nothing is written when the key is not configured. */
export async function saveOwnerToken(businessId: string, input: OwnerTokenInput, options: TokenStoreOptions = {}): Promise<SaveOwnerTokenResult> {
  const environment = options.environment ?? process.env;
  const keyStatus = getTokenKeyStatus(environment);
  if (keyStatus.status === "not_configured") return keyStatus;
  const target = recordPath(options.directory, businessId);
  const stored = encryptOwnerToken(businessId, input, environment, options.now?.() ?? new Date());
  const directory = resolve(target, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${businessId}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(stored), "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
  return { status: "stored", metadata: { businessId: stored.businessId, expiresAt: stored.expiresAt, storedAt: stored.storedAt, grantedScopes: stored.grantedScopes } };
}

export type LoadOwnerTokenResult =
  | { status: "connected"; record: OwnerTokenRecord }
  | { status: "expired"; metadata: OwnerTokenMetadata }
  | { status: "not_connected" }
  | { status: "not_configured"; reason: "missing_key" | "invalid_key" };

/** Expired records are reported (not returned) so callers ask the owner to reconnect instead of making a doomed call. */
export async function loadOwnerToken(businessId: string, options: TokenStoreOptions = {}): Promise<LoadOwnerTokenResult> {
  const environment = options.environment ?? process.env;
  const keyStatus = getTokenKeyStatus(environment);
  if (keyStatus.status === "not_configured") return keyStatus;
  const target = recordPath(options.directory, businessId);
  let text: string;
  try {
    const handle = await open(target, "r");
    try {
      const { size } = await handle.stat();
      if (size > MAX_RECORD_BYTES) throw new GraphTokenError("RECORD_INVALID", "The stored Meta connection record is invalid; reconnect the account.");
      text = await readFile(handle, "utf8");
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "not_connected" };
    if (error instanceof GraphTokenError) throw error;
    throw new GraphTokenError("RECORD_UNREADABLE", "The stored Meta connection could not be read.");
  }
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new GraphTokenError("RECORD_INVALID", "The stored Meta connection record is invalid; reconnect the account."); }
  const record = decryptOwnerToken(json, environment);
  if (record.businessId !== businessId) throw new GraphTokenError("RECORD_INVALID", "The stored Meta connection record is invalid; reconnect the account.");
  const now = options.now?.() ?? new Date();
  if (record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()) {
    return { status: "expired", metadata: { businessId: record.businessId, expiresAt: record.expiresAt, storedAt: record.storedAt, grantedScopes: record.grantedScopes } };
  }
  return { status: "connected", record };
}

/** Local revocation: removes the stored record. Pair with a Graph-side permission revoke when the token is still usable. */
export async function deleteOwnerToken(businessId: string, options: Pick<TokenStoreOptions, "directory"> = {}): Promise<{ deleted: boolean }> {
  const target = recordPath(options.directory, businessId);
  try {
    await rm(target);
    return { deleted: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { deleted: false };
    throw new GraphTokenError("DELETE_FAILED", "The stored Meta connection could not be removed.");
  }
}

// ---------------------------------------------------------------------------
// OAuth state: HMAC-signed, expiring, bound to one business
// ---------------------------------------------------------------------------

const statePayloadSchema = z.object({
  v: z.literal(1),
  b: z.string().regex(BUSINESS_ID),
  n: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  i: z.number().int().nonnegative(),
  e: z.number().int().positive(),
}).strict();

export interface OAuthStateOptions { environment?: Environment; now?: () => Date; ttlMs?: number }

/**
 * `<payload>.<mac>` (base64url). The nonce is returned so the caller can also
 * bind it to the owner's session (e.g. an HttpOnly cookie) and enforce single use.
 */
export function createOAuthState(businessId: string, options: OAuthStateOptions = {}): { state: string; nonce: string; expiresAt: Date } {
  requireBusinessId(businessId);
  const ttl = options.ttlMs ?? DEFAULT_STATE_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > MAX_STATE_TTL_MS) throw new GraphTokenError("INVALID_STATE_TTL", "The OAuth state lifetime must be between 1 second and 30 minutes.");
  const keys = deriveKeys(options.environment ?? process.env);
  try {
    const issued = (options.now?.() ?? new Date()).getTime();
    const nonce = b64url(randomBytes(16));
    const payload = b64url(Buffer.from(JSON.stringify({ v: 1, b: businessId, n: nonce, i: issued, e: issued + ttl })));
    const mac = b64url(createHmac("sha256", keys.state).update(payload).digest());
    return { state: `${payload}.${mac}`, nonce, expiresAt: new Date(issued + ttl) };
  } finally { keys.encryption.fill(0); keys.state.fill(0); }
}

export type OAuthStateVerification =
  | { valid: true; businessId: string; nonce: string; expiresAt: Date }
  | { valid: false; reason: "malformed" | "signature" | "expired" | "business_mismatch" };

/** Constant-time MAC comparison; the business binding and expiry are checked only after authentication. */
export function verifyOAuthState(state: unknown, expectedBusinessId: string, options: Omit<OAuthStateOptions, "ttlMs"> = {}): OAuthStateVerification {
  requireBusinessId(expectedBusinessId);
  if (typeof state !== "string" || state.length > MAX_STATE_CHARS) return { valid: false, reason: "malformed" };
  const match = /^([A-Za-z0-9_-]{16,700})\.([A-Za-z0-9_-]{43})$/.exec(state);
  if (!match) return { valid: false, reason: "malformed" };
  const keys = deriveKeys(options.environment ?? process.env);
  let authentic: boolean;
  try {
    const expected = createHmac("sha256", keys.state).update(match[1]).digest();
    const supplied = fromB64url(match[2]);
    authentic = supplied.length === expected.length && timingSafeEqual(supplied, expected);
  } finally { keys.encryption.fill(0); keys.state.fill(0); }
  if (!authentic) return { valid: false, reason: "signature" };
  let payload: z.infer<typeof statePayloadSchema>;
  try {
    const parsed = statePayloadSchema.safeParse(JSON.parse(fromB64url(match[1]).toString("utf8")));
    if (!parsed.success) return { valid: false, reason: "malformed" };
    payload = parsed.data;
  } catch { return { valid: false, reason: "malformed" }; }
  const now = (options.now?.() ?? new Date()).getTime();
  if (payload.e <= now || payload.e - payload.i > MAX_STATE_TTL_MS || payload.i > now + 60_000) return { valid: false, reason: "expired" };
  const expected = Buffer.from(expectedBusinessId);
  const actual = Buffer.from(payload.b);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { valid: false, reason: "business_mismatch" };
  return { valid: true, businessId: payload.b, nonce: payload.n, expiresAt: new Date(payload.e) };
}
