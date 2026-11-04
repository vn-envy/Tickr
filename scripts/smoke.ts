import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../lib/db";

const base = process.env.TICKR_SMOKE_URL || "http://127.0.0.1:3000";
const parsed = new URL(base);
if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("Smoke tests only target the local development instance.");

async function main() {
  let id: string | undefined;
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).database, "ready");
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Tickr/i);
    const payload = { name: `Setup smoke ${randomUUID()}`, locality: "Synthetic locality", vertical: "bicycle repair workshop", goal: "Verify generic-category draft persistence only; not a real campaign.", website: "https://example.com" };
    const created = await fetch(`${base}/api/businesses`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    assert.equal(created.status, 201);
    const result = await created.json();
    id = result.business.id;
    assert.equal(typeof id, "string");
    const loaded = await fetch(`${base}/api/businesses/${id}`);
    assert.equal(loaded.status, 200);
    assert.equal((await loaded.json()).business.goal, payload.goal);
    const invalid = await fetch(`${base}/api/businesses`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, name: "", website: "" }) });
    assert.equal(invalid.status, 400);
    const crossOrigin = await fetch(`${base}/api/businesses`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.org" }, body: JSON.stringify(payload) });
    assert.equal(crossOrigin.status, 403);
    const run = await db.run.create({ data: { businessId: id! } });
    const evidence = await db.evidence.create({ data: { runId: run.id, claim: "Synthetic sourdough fixture", excerpt: "Diagnostic evidence only", support: "owner_stated", sourceType: "fixture", metadata: { diagnostic: true } } });
    const rows = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM EvidenceSearch WHERE EvidenceSearch MATCH 'sourdough' AND id = ${evidence.id}`;
    assert.equal(rows.length, 1);
    console.log("PASS: page, health, persisted draft/readback, validation, cross-origin rejection, SQLite relations and FTS.");
  } finally {
    if (id) await db.business.delete({ where: { id } });
    await db.$disconnect();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
