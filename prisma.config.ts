import { defineConfig } from "prisma/config";
import { resolve } from "node:path";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL || `file:${resolve(".data/tickr.db")}` },
});
