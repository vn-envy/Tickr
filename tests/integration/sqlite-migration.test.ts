import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("the committed migration preserves evidence search through edits and cascading removal", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    database.exec(readFileSync(resolve("prisma/migrations/20261101000000_foundation/migration.sql"), "utf8"));
    database.prepare("INSERT INTO Business (id,name,locality,vertical,goal,updatedAt) VALUES (?,?,?,?,?,?)").run("b", "Diagnostic bakery", "Fixture locality", "bakery", "Test evidence storage", new Date().toISOString());
    database.prepare("INSERT INTO Run (id,businessId,updatedAt) VALUES (?,?,?)").run("r", "b", new Date().toISOString());
    database.prepare("INSERT INTO Evidence (id,runId,claim,excerpt,support,sourceType,metadata) VALUES (?,?,?,?,?,?,?)").run("e", "r", "Sourdough fixture", "Supplied diagnostic statement", "owner_stated", "fixture", "{}");
    expect(database.prepare("SELECT id FROM EvidenceSearch WHERE EvidenceSearch MATCH ?").all("sourdough")).toEqual([{ id: "e" }]);
    database.prepare("UPDATE Evidence SET claim = ? WHERE id = ?").run("Croissant fixture", "e");
    expect(database.prepare("SELECT id FROM EvidenceSearch WHERE EvidenceSearch MATCH ?").all("sourdough")).toEqual([]);
    expect(database.prepare("SELECT id FROM EvidenceSearch WHERE EvidenceSearch MATCH ?").all("croissant")).toEqual([{ id: "e" }]);
    database.prepare("DELETE FROM Business WHERE id = ?").run("b");
    expect(database.prepare("SELECT id FROM Evidence").all()).toEqual([]);
    expect(database.prepare("SELECT id FROM EvidenceSearch").all()).toEqual([]);
  } finally { database.close(); }
});
