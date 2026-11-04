import Database from "better-sqlite3";
import { mkdir, mkdtemp, open as openFile, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupDatabase, integrityOk, pendingMigrations, preMigrateSnapshot, promoteTiers, resolveDatabasePath, restoreDatabase, snapshotPaths,
  stamp, taggedSnapshots,
} from "@/scripts/db-persist";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "tickr-db-persist-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function createDatabase(path: string, rows: string[]): void {
  const database = new Database(path);
  try {
    database.exec("CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    const insert = database.prepare("INSERT INTO note (body) VALUES (?)");
    database.transaction(() => { for (const row of rows) insert.run(row); })();
  } finally { database.close(); }
}

function readRows(path: string): string[] {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try { return (database.prepare("SELECT body FROM note ORDER BY id").all() as Array<{ body: string }>).map((row) => row.body); }
  finally { database.close(); }
}

/** Overwrites the middle of the file so SQLite pages no longer parse. */
async function corrupt(path: string): Promise<void> {
  const size = (await stat(path)).size;
  const handle = await openFile(path, "r+");
  try { await handle.write(Buffer.alloc(Math.min(8192, size - 4096), 0xa5), 0, undefined, 4096); }
  finally { await handle.close(); }
}

describe("db-persist", () => {
  it("round-trips a database through backup and restore", async () => {
    const source = join(root, "local", "tickr.db");
    const snapshots = join(root, "volume", "db");
    await mkdir(join(root, "local"));
    createDatabase(source, ["first", "second"]);

    expect(await backupDatabase({ source, directory: snapshots })).toEqual({ status: "saved", snapshots: 1 });
    expect(integrityOk(join(snapshots, "tickr.db"))).toBe(true);
    expect((await readdir(snapshots)).sort()).toEqual(["tickr.db"]);

    const restored = join(root, "fresh", "tickr.db");
    expect(await restoreDatabase({ target: restored, directory: snapshots })).toEqual({ status: "restored", from: "tickr.db" });
    expect(readRows(restored)).toEqual(["first", "second"]);
    expect((await readdir(join(root, "fresh"))).sort()).toEqual(["tickr.db"]);
  });

  it("never overwrites an existing local database", async () => {
    const snapshots = join(root, "db");
    const older = join(root, "older.db");
    createDatabase(older, ["snapshot"]);
    await backupDatabase({ source: older, directory: snapshots });

    const local = join(root, "local.db");
    createDatabase(local, ["newer local"]);
    expect(await restoreDatabase({ target: local, directory: snapshots })).toEqual({ status: "kept-local" });
    expect(readRows(local)).toEqual(["newer local"]);
  });

  it("reports no snapshot and skips backing up a missing database", async () => {
    expect(await restoreDatabase({ target: join(root, "x.db"), directory: join(root, "none") })).toEqual({ status: "none" });
    expect(await backupDatabase({ source: join(root, "missing.db"), directory: join(root, "db") })).toEqual({ status: "skipped", reason: "no-database" });
  });

  it("rotates snapshots and keeps only the last three", async () => {
    const source = join(root, "tickr.db");
    const snapshots = join(root, "db");
    createDatabase(source, []);
    for (const label of ["one", "two", "three", "four"]) {
      createDatabase(source, [label]);
      expect((await backupDatabase({ source, directory: snapshots })).status).toBe("saved");
    }
    expect((await readdir(snapshots)).sort()).toEqual(["tickr.db", "tickr.db.1", "tickr.db.2"]);
    const [latest, previous, oldest] = snapshotPaths(snapshots);
    expect(readRows(latest)).toEqual(["one", "two", "three", "four"]);
    expect(readRows(previous)).toEqual(["one", "two", "three"]);
    expect(readRows(oldest)).toEqual(["one", "two"]);
  });

  it("keeps existing snapshots when a new backup fails its integrity check", async () => {
    const source = join(root, "tickr.db");
    const snapshots = join(root, "db");
    createDatabase(source, Array.from({ length: 400 }, (_, index) => `row ${index} ${"x".repeat(80)}`));
    expect((await backupDatabase({ source, directory: snapshots })).status).toBe("saved");
    const good = await readFile(join(snapshots, "tickr.db"));

    await corrupt(source);
    expect(integrityOk(source)).toBe(false);
    expect((await backupDatabase({ source, directory: snapshots })).status).toBe("failed");
    expect((await readdir(snapshots)).sort()).toEqual(["tickr.db"]);
    expect((await readFile(join(snapshots, "tickr.db"))).equals(good)).toBe(true);
  });

  it("restores the newest intact snapshot and refuses when none is intact", async () => {
    const source = join(root, "tickr.db");
    const snapshots = join(root, "db");
    createDatabase(source, Array.from({ length: 400 }, (_, index) => `row ${index} ${"y".repeat(80)}`));
    await backupDatabase({ source, directory: snapshots });
    createDatabase(source, ["newest"]);
    await backupDatabase({ source, directory: snapshots });
    await corrupt(join(snapshots, "tickr.db"));

    const target = join(root, "restored.db");
    await writeFile(`${target}-journal`, "stale journal without a database");
    expect(await restoreDatabase({ target, directory: snapshots })).toEqual({ status: "restored", from: "tickr.db.1" });
    expect(readRows(target)).toHaveLength(400);
    expect((await readdir(root)).includes("restored.db-journal")).toBe(false);

    await corrupt(join(snapshots, "tickr.db.1"));
    const second = join(root, "second.db");
    expect(await restoreDatabase({ target: second, directory: snapshots })).toEqual({ status: "failed", reason: "no-intact-snapshot" });
    expect((await readdir(root)).includes("second.db")).toBe(false);
  });

  it("writes no snapshot once this container is fenced (lost the writer lease)", async () => {
    const source = join(root, "tickr.db");
    const snapshots = join(root, "db");
    const fenceFile = join(root, ".writer-fenced");
    createDatabase(source, ["owned by me"]);
    expect((await backupDatabase({ source, directory: snapshots, fenceFile })).status).toBe("saved");
    const before = await readFile(join(snapshots, "tickr.db"));
    await writeFile(fenceFile, "");
    createDatabase(source, ["written after losing the lease"]);
    expect(await backupDatabase({ source, directory: snapshots, fenceFile })).toEqual({ status: "skipped", reason: "fenced" });
    expect((await readFile(join(snapshots, "tickr.db"))).equals(before)).toBe(true);
    const migrations = join(root, "migrations");
    await mkdir(join(migrations, "20260101000000_init"), { recursive: true });
    expect(await preMigrateSnapshot({ source, directory: snapshots, migrationsDirectory: migrations, fenceFile })).toEqual({ status: "skipped", reason: "fenced" });
  });

  it("keeps hourly and daily rollback copies outside the 3-slot rotation", async () => {
    const source = join(root, "tickr.db");
    const snapshots = join(root, "db");
    const tiers = [{ tag: "hourly", everyMs: 3_600_000, keep: 2 }, { tag: "daily", everyMs: 86_400_000, keep: 1 }];
    const start = Date.UTC(2026, 10, 4, 0, 0, 0);
    expect(await promoteTiers({ directory: snapshots, tiers, now: () => start })).toEqual([]);
    createDatabase(source, ["h0"]);
    await backupDatabase({ source, directory: snapshots });
    expect(await promoteTiers({ directory: snapshots, tiers, now: () => start })).toEqual(["hourly", "daily"]);
    // Within the period nothing new is kept, however many rolling snapshots happen.
    for (let index = 1; index <= 5; index += 1) {
      createDatabase(source, [`s${index}`]);
      await backupDatabase({ source, directory: snapshots });
      expect(await promoteTiers({ directory: snapshots, tiers, now: () => start + index * 30_000 })).toEqual([]);
    }
    createDatabase(source, ["h1"]);
    await backupDatabase({ source, directory: snapshots });
    expect(await promoteTiers({ directory: snapshots, tiers, now: () => start + 3_600_000 })).toEqual(["hourly"]);
    createDatabase(source, ["h2"]);
    await backupDatabase({ source, directory: snapshots });
    expect(await promoteTiers({ directory: snapshots, tiers, now: () => start + 7_200_000 })).toEqual(["hourly"]);

    const hourly = await taggedSnapshots(snapshots, "hourly");
    expect(hourly.map((entry) => entry.name)).toEqual([`tickr.db.hourly-${stamp(start + 7_200_000)}`, `tickr.db.hourly-${stamp(start + 3_600_000)}`]);
    expect(readRows(join(snapshots, hourly[1].name)).at(-1)).toBe("h1");
    const daily = await taggedSnapshots(snapshots, "daily");
    expect(daily).toHaveLength(1);
    expect(readRows(join(snapshots, daily[0].name))).toEqual(["h0"]);
    expect(integrityOk(join(snapshots, daily[0].name))).toBe(true);
    // Rolling rotation is unaffected and restore never picks a tier copy.
    expect((await readdir(snapshots)).filter((name) => /^tickr\.db(\.\d)?$/.test(name)).sort()).toEqual(["tickr.db", "tickr.db.1", "tickr.db.2"]);
    expect(stamp(start)).toBe("20261104T000000Z");
  });

  it("saves a pre-migration copy only when migrations are pending", async () => {
    const source = join(root, "tickr.db");
    const snapshots = join(root, "db");
    const migrations = join(root, "migrations");
    for (const name of ["20260101000000_init", "20260201000000_more"]) await mkdir(join(migrations, name), { recursive: true });
    await writeFile(join(migrations, "migration_lock.toml"), "");

    expect(await preMigrateSnapshot({ source, directory: snapshots, migrationsDirectory: migrations })).toEqual({ status: "skipped", reason: "no-database" });
    createDatabase(source, ["before migrating"]);
    const database = new Database(source);
    try {
      database.exec("CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY, migration_name TEXT NOT NULL, finished_at DATETIME, rolled_back_at DATETIME)");
      database.prepare("INSERT INTO _prisma_migrations VALUES ('1', '20260101000000_init', '2026-01-01', NULL)").run();
      database.prepare("INSERT INTO _prisma_migrations VALUES ('2', '20260201000000_more', NULL, NULL)").run();
    } finally { database.close(); }
    expect(pendingMigrations(source, ["20260101000000_init", "20260201000000_more"])).toEqual(["20260201000000_more"]);

    const now = Date.UTC(2026, 10, 4, 12, 0, 0);
    expect(await preMigrateSnapshot({ source, directory: snapshots, migrationsDirectory: migrations, now: () => now }))
      .toEqual({ status: "saved", name: `tickr.db.pre-migrate-${stamp(now)}`, pending: 1 });
    expect(readRows(join(snapshots, `tickr.db.pre-migrate-${stamp(now)}`))).toEqual(["before migrating"]);

    const migrated = new Database(source);
    try { migrated.prepare("UPDATE _prisma_migrations SET finished_at = '2026-02-01' WHERE id = '2'").run(); } finally { migrated.close(); }
    expect(await preMigrateSnapshot({ source, directory: snapshots, migrationsDirectory: migrations })).toEqual({ status: "skipped", reason: "up-to-date" });
    expect((await taggedSnapshots(snapshots, "pre-migrate"))).toHaveLength(1);
    // A pre-migrate copy is never used by automatic restore.
    expect(await restoreDatabase({ target: join(root, "fresh.db"), directory: snapshots })).toEqual({ status: "none" });
  });

  it("resolves the local database path from the environment", () => {
    expect(resolveDatabasePath({ TICKR_DB_PATH: "/var/lib/tickr/tickr.db" })).toBe("/var/lib/tickr/tickr.db");
    expect(resolveDatabasePath({ DATABASE_URL: "file:/var/lib/tickr/other.db" })).toBe("/var/lib/tickr/other.db");
    expect(resolveDatabasePath({})).toMatch(/\.data\/tickr\.db$/);
  });
});
