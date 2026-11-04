import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/lib/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { tickrPrisma?: PrismaClient };
mkdirSync(resolve(".data"), { recursive: true });
const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL || `file:${resolve(".data/tickr.db")}`,
});

export const db = globalForPrisma.tickrPrisma ?? new PrismaClient({ adapter });
if (process.env.NODE_ENV !== "production") globalForPrisma.tickrPrisma = db;
