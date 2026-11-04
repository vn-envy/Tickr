import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { environment: "node", include: ["tests/**/*.test.ts"], maxWorkers: 2, env: { XDG_CACHE_HOME: fileURLToPath(new URL(".cache/", import.meta.url)) } },
});
