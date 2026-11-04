import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { runNextJob } from "../lib/jobs/worker";
import { db } from "../lib/db";

const once = process.argv.includes("--once");
const owner = randomUUID();
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function main() {
  console.log("Tickr worker ready. Durable jobs only; Meta-only inference; uncertain paid requests are never retried automatically.");
  do {
    try {
      const id = await runNextJob({ owner });
      if (id) console.log(`Worker finished processing run ${id}. Inspect its saved status for the outcome.`);
      if (once) break;
      if (!id) await delay(1000);
    } catch {
      console.error("Worker could not access its queue. Check database setup; no new job was started.");
      if (once) { process.exitCode = 1; break; }
      await delay(3000);
    }
  } while (!stopping);
}

main().catch(() => { console.error("Worker stopped unexpectedly. Saved leases will be reconciled without repeating paid requests."); process.exitCode = 1; }).finally(async () => { await db.$disconnect(); });
