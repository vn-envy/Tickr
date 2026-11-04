/**
 * SQLite snapshot persistence for a hosted single container (deploy/modal-start.sh).
 *
 * The live database stays on container-local disk; SQLite on a network volume is not safe.
 * This script copies it to a durable directory (the Modal Volume) and back:
 *
 *   restore   Copy the newest snapshot that passes PRAGMA integrity_check to the local path.
 *             Never overwrites an existing local database. Exit 2 when snapshots exist but none
 *             is intact (the caller refuses to start rather than begin with an empty database).
 *   backup    One online backup (better-sqlite3 / SQLite backup API) to a temp file in the
 *             snapshot directory, integrity check, fsync, then atomic rename into place while
 *             rotating the previous snapshots (tickr.db, tickr.db.1, tickr.db.2).
 *   --loop    backup every TICKR_DB_BACKUP_INTERVAL_SECONDS (default 30) when the database
 *             changed, plus a final backup on SIGTERM/SIGINT. SIGUSR1 stops the loop without a
 *             final backup (modal-start.sh takes exactly one final backup after the app stopped).
 *             After a saved snapshot, slower tiers are kept for rollback: hourly (24) and daily (7).
 *   pre-migrate
 *             When the local database has migrations pending (prisma/migrations vs the
 *             _prisma_migrations table), save tickr.db.pre-migrate-<UTC stamp> (3 kept) first.
 *
 * Restore only ever uses the rolling snapshots; tier and pre-migrate copies are for a deliberate,
 * manual rollback (deploy/README.md). When TICKR_DB_FENCE_FILE exists (this container lost the
 * single-writer lease), no snapshot is written at all.
 *
 * Paths: TICKR_DB_PATH (else DATABASE_URL `file:` path, else .data/tickr.db) and
 * TICKR_DB_BACKUP_DIR (default /data/db). Logs stay minimal and contain no secrets.
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SNAPSHOT_NAME = "tickr.db";
export const DEFAULT_KEEP = 3;
const TEMP_PREFIX = ".tickr-snapshot-";
const STALE_TEMP_MS = 10 * 60 * 1000;

export interface Tier { tag: string; everyMs: number; keep: number }
export const DEFAULT_TIERS: Tier[] = [
  { tag: "hourly", everyMs: 60 * 60 * 1000, keep: 24 },
  { tag: "daily", everyMs: 24 * 60 * 60 * 1000, keep: 7 },
];
export const PRE_MIGRATE_TAG = "pre-migrate";
export const PRE_MIGRATE_KEEP = 3;

export type BackupResult =
  | { status: "saved"; snapshots: number }
  | { status: "skipped"; reason: "no-database" | "fenced" }
  | { status: "failed"; reason: "integrity" | "error" };

export type RestoreResult =
  | { status: "kept-local" }
  | { status: "restored"; from: string }
  | { status: "none" }
  | { status: "failed"; reason: "no-intact-snapshot" };

export function snapshotPaths(directory: string, keep = DEFAULT_KEEP): string[] {
  return Array.from({ length: keep }, (_, index) => join(directory, index === 0 ? SNAPSHOT_NAME : `${SNAPSHOT_NAME}.${index}`));
}

/** True only when SQLite can open the file and PRAGMA integrity_check returns exactly "ok". */
export function integrityOk(path: string): boolean {
  let database: Database.Database | null = null;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
    const rows = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
    return rows.length === 1 && rows[0]?.integrity_check === "ok";
  } catch {
    return false;
  } finally {
    try { database?.close(); } catch { /* already closed */ }
  }
}

function fsyncPath(path: string, directory = false): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, directory ? fsConstants.O_RDONLY | fsConstants.O_DIRECTORY : fsConstants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    // Some filesystems refuse fsync on directories; the file itself was already synced.
    if (!directory) throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function nonEmptyFile(path: string): Promise<boolean> {
  try { const info = await stat(path); return info.isFile() && info.size > 0; } catch { return false; }
}

/** Online backup of `source` into a new temp file; the caller owns (and removes) the result. */
async function onlineCopy(source: string, targetDirectory: string): Promise<string> {
  const temp = join(targetDirectory, `${TEMP_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}`);
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await database.backup(temp);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  } finally {
    database.close();
  }
  // A standalone copy must not depend on -wal/-shm side files, whatever mode the source used.
  try {
    const copy = new Database(temp, { fileMustExist: true });
    try { copy.pragma("journal_mode = DELETE"); } finally { copy.close(); }
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return temp;
}

async function removeStaleTemps(directory: string, nowMs: number): Promise<void> {
  let names: string[];
  try { names = await readdir(directory); } catch { return; }
  await Promise.all(names.filter((name) => name.startsWith(TEMP_PREFIX)).map(async (name) => {
    const path = join(directory, name);
    try { if (nowMs - (await stat(path)).mtimeMs > STALE_TEMP_MS) await rm(path, { force: true }); } catch { /* raced */ }
  }));
}

export async function backupDatabase(options: { source: string; directory: string; keep?: number; now?: () => number; fenceFile?: string | null }): Promise<BackupResult> {
  const keep = Math.max(1, options.keep ?? DEFAULT_KEEP);
  if (options.fenceFile && existsSync(options.fenceFile)) return { status: "skipped", reason: "fenced" };
  if (!(await nonEmptyFile(options.source))) return { status: "skipped", reason: "no-database" };
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await removeStaleTemps(options.directory, (options.now ?? Date.now)());
  let temp: string | null = null;
  try {
    temp = await onlineCopy(options.source, options.directory);
    if (!integrityOk(temp)) return { status: "failed", reason: "integrity" };
    fsyncPath(temp);
    const paths = snapshotPaths(options.directory, keep);
    for (let index = paths.length - 1; index > 0; index -= 1) {
      if (await exists(paths[index - 1])) await rename(paths[index - 1], paths[index]);
    }
    await rename(temp, paths[0]);
    temp = null;
    fsyncPath(options.directory, true);
    let snapshots = 0;
    for (const path of paths) if (await exists(path)) snapshots += 1;
    return { status: "saved", snapshots };
  } catch {
    return { status: "failed", reason: "error" };
  } finally {
    if (temp) await rm(temp, { force: true });
  }
}

/** `20261104T120000Z`: sortable as text, safe in file names. */
export function stamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

const TAGGED = (tag: string) => new RegExp(`^${SNAPSHOT_NAME.replace(".", "\\.")}\\.${tag}-(\\d{8}T\\d{6}Z)$`);

/** Tagged copies (newest first) as { name, ms }. */
export async function taggedSnapshots(directory: string, tag: string): Promise<Array<{ name: string; ms: number }>> {
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  const pattern = TAGGED(tag);
  return names.flatMap((name) => {
    const match = pattern.exec(name);
    if (!match) return [];
    const iso = match[1].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z");
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? [{ name, ms }] : [];
  }).sort((a, b) => b.ms - a.ms || (a.name < b.name ? 1 : -1));
}

async function pruneTagged(directory: string, tag: string, keep: number): Promise<void> {
  for (const old of (await taggedSnapshots(directory, tag)).slice(Math.max(1, keep))) await rm(join(directory, old.name), { force: true });
}

/** Atomically installs an already-verified file as `<snapshot>.<tag>-<stamp>` and prunes the tag. */
async function installTagged(file: string, directory: string, tag: string, keep: number, nowMs: number): Promise<string> {
  const name = `${SNAPSHOT_NAME}.${tag}-${stamp(nowMs)}`;
  await rename(file, join(directory, name));
  fsyncPath(directory, true);
  await pruneTagged(directory, tag, keep);
  return name;
}

/**
 * Copies the newest rolling snapshot (already integrity-checked) into each slower tier whose newest
 * copy is older than the tier period. Returns the tags that received a copy.
 */
export async function promoteTiers(options: { directory: string; tiers?: Tier[]; now?: () => number }): Promise<string[]> {
  const nowMs = (options.now ?? Date.now)();
  const latest = snapshotPaths(options.directory, 1)[0];
  if (!(await nonEmptyFile(latest))) return [];
  const promoted: string[] = [];
  for (const tier of options.tiers ?? DEFAULT_TIERS) {
    const newest = (await taggedSnapshots(options.directory, tier.tag))[0];
    if (newest && nowMs - newest.ms < tier.everyMs) continue;
    const temp = join(options.directory, `${TEMP_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      await copyFile(latest, temp);
      fsyncPath(temp);
      await installTagged(temp, options.directory, tier.tag, tier.keep, nowMs);
      promoted.push(tier.tag);
    } catch {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }
  return promoted;
}

/** Migration folder names under prisma/migrations that the database has not finished applying. */
export function pendingMigrations(databasePath: string, available: string[]): string[] {
  let database: Database.Database | null = null;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'").get();
    if (!table) return [...available];
    const applied = new Set((database.prepare("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL").all() as Array<{ migration_name: string }>).map((row) => row.migration_name));
    return available.filter((name) => !applied.has(name));
  } finally {
    try { database?.close(); } catch { /* already closed */ }
  }
}

export async function listMigrations(migrationsDirectory: string): Promise<string[]> {
  try {
    const entries = await readdir(migrationsDirectory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && /^\d/.test(entry.name)).map((entry) => entry.name).sort();
  } catch { return []; }
}

export type PreMigrateResult =
  | { status: "saved"; name: string; pending: number }
  | { status: "skipped"; reason: "no-database" | "up-to-date" | "fenced" }
  | { status: "failed"; reason: "integrity" | "error" };

/** Before `prisma migrate deploy`: keep a distinct rollback copy when migrations are pending. */
export async function preMigrateSnapshot(options: { source: string; directory: string; migrationsDirectory: string; keep?: number; now?: () => number; fenceFile?: string | null }): Promise<PreMigrateResult> {
  if (options.fenceFile && existsSync(options.fenceFile)) return { status: "skipped", reason: "fenced" };
  if (!(await nonEmptyFile(options.source))) return { status: "skipped", reason: "no-database" };
  let temp: string | null = null;
  try {
    const pending = pendingMigrations(options.source, await listMigrations(options.migrationsDirectory));
    if (!pending.length) return { status: "skipped", reason: "up-to-date" };
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    temp = await onlineCopy(options.source, options.directory);
    if (!integrityOk(temp)) return { status: "failed", reason: "integrity" };
    fsyncPath(temp);
    const name = await installTagged(temp, options.directory, PRE_MIGRATE_TAG, options.keep ?? PRE_MIGRATE_KEEP, (options.now ?? Date.now)());
    temp = null;
    return { status: "saved", name, pending: pending.length };
  } catch {
    return { status: "failed", reason: "error" };
  } finally {
    if (temp) await rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Restores the newest intact snapshot; never replaces an existing local database. */
export async function restoreDatabase(options: { target: string; directory: string; keep?: number }): Promise<RestoreResult> {
  if (await nonEmptyFile(options.target)) return { status: "kept-local" };
  const candidates: string[] = [];
  for (const path of snapshotPaths(options.directory, options.keep ?? DEFAULT_KEEP)) if (await nonEmptyFile(path)) candidates.push(path);
  if (!candidates.length) return { status: "none" };
  const targetDirectory = dirname(resolve(options.target));
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  for (const candidate of candidates) {
    if (!integrityOk(candidate)) continue;
    let temp: string | null = null;
    try {
      temp = await onlineCopy(candidate, targetDirectory);
      if (!integrityOk(temp)) continue;
      fsyncPath(temp);
      if (await nonEmptyFile(options.target)) return { status: "kept-local" };
      // A journal without its main file belongs to no snapshot; SQLite must not replay it.
      for (const suffix of ["-wal", "-shm", "-journal"]) await rm(`${options.target}${suffix}`, { force: true });
      await rename(temp, options.target);
      temp = null;
      fsyncPath(targetDirectory, true);
      return { status: "restored", from: basename(candidate) };
    } catch {
      continue;
    } finally {
      if (temp) await rm(temp, { force: true }).catch(() => undefined);
    }
  }
  return { status: "failed", reason: "no-intact-snapshot" };
}

/** Cheap change signature: size and mtime of the database and its WAL. */
async function signature(source: string): Promise<string> {
  const parts: string[] = [];
  for (const path of [source, `${source}-wal`]) {
    try { const info = await stat(path); parts.push(`${info.size}:${info.mtimeMs}`); } catch { parts.push("-"); }
  }
  return parts.join("|");
}

export function resolveDatabasePath(env: Record<string, string | undefined> = process.env): string {
  if (env.TICKR_DB_PATH?.trim()) return resolve(env.TICKR_DB_PATH.trim());
  const url = env.DATABASE_URL?.trim();
  if (url?.startsWith("file:")) return resolve(url.slice("file:".length));
  return resolve(".data/tickr.db");
}

function describe(result: BackupResult): string {
  switch (result.status) {
    case "saved": return `db-persist: snapshot saved (${result.snapshots} kept).`;
    case "skipped": return result.reason === "fenced"
      ? "db-persist: this container no longer holds the writer lease; snapshot not written."
      : "db-persist: no local database yet; nothing to back up.";
    case "failed": return result.reason === "integrity"
      ? "db-persist: backup failed its integrity check; previous snapshots kept."
      : "db-persist: backup failed; previous snapshots kept.";
  }
}

async function loop(source: string, directory: string, intervalMs: number, fenceFile: string | null): Promise<void> {
  let lastSignature: string | null = null;
  let stopping = false;
  let finalBackup = true;
  let fencedLogged = false;
  let wake: (() => void) | null = null;
  const stop = () => { stopping = true; wake?.(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGUSR1", () => { finalBackup = false; stop(); });
  const attempt = async (force: boolean) => {
    const current = await signature(source);
    if (!force && current === lastSignature) return;
    const first = lastSignature === null;
    const result = await backupDatabase({ source, directory, fenceFile });
    if (result.status === "skipped" && result.reason === "fenced") {
      if (!fencedLogged) console.log(describe(result));
      fencedLogged = true;
      return;
    }
    // Routine saves stay quiet; the first, the final and every failure are logged.
    if (result.status !== "saved" || force || first) console.log(describe(result));
    if (result.status === "saved") {
      lastSignature = current;
      const promoted = await promoteTiers({ directory });
      if (promoted.length) console.log(`db-persist: kept ${promoted.join(" and ")} rollback copy.`);
    }
  };
  console.log(`db-persist: backing up every ${Math.round(intervalMs / 1000)} s.`);
  while (!stopping) {
    await attempt(false);
    if (stopping) break;
    await new Promise<void>((done) => { const timer = setTimeout(done, intervalMs); wake = () => { clearTimeout(timer); done(); }; });
    wake = null;
  }
  if (finalBackup) await attempt(true);
}

async function main(argv: string[]): Promise<number> {
  const source = resolveDatabasePath();
  const directory = resolve(process.env.TICKR_DB_BACKUP_DIR?.trim() || "/data/db");
  const fenceFile = process.env.TICKR_DB_FENCE_FILE?.trim() ? resolve(process.env.TICKR_DB_FENCE_FILE.trim()) : null;
  if (argv.includes("--loop") || argv.includes("loop")) {
    const seconds = Number(process.env.TICKR_DB_BACKUP_INTERVAL_SECONDS ?? 30);
    await loop(source, directory, (Number.isFinite(seconds) && seconds >= 5 ? seconds : 30) * 1000, fenceFile);
    return 0;
  }
  if (argv.includes("pre-migrate")) {
    const result = await preMigrateSnapshot({ source, directory, migrationsDirectory: resolve("prisma/migrations"), fenceFile });
    switch (result.status) {
      case "saved": console.log(`db-persist: ${result.pending} migration(s) pending; saved ${result.name} first.`); return 0;
      case "skipped": return 0;
      case "failed": console.error("db-persist: pre-migration snapshot failed; not migrating."); return 1;
    }
  }
  if (argv.includes("restore")) {
    const result = await restoreDatabase({ target: source, directory });
    switch (result.status) {
      case "kept-local": console.log("db-persist: local database present; snapshot not applied."); return 0;
      case "restored": console.log(`db-persist: restored from ${result.from}.`); return 0;
      case "none": console.log("db-persist: no snapshot yet; starting with a new database."); return 0;
      case "failed": console.error("db-persist: snapshots exist but none passed the integrity check."); return 2;
    }
  }
  if (argv.includes("backup")) {
    const result = await backupDatabase({ source, directory, fenceFile });
    console.log(describe(result));
    return result.status === "failed" ? 1 : 0;
  }
  console.error("Usage: db-persist.ts restore | backup | pre-migrate | --loop");
  return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => {
    console.error("db-persist: unexpected failure.");
    process.exitCode = 1;
  });
}

