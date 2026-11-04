import type { NextConfig } from "next";

/**
 * The access gate (proxy.ts) makes Next buffer each matched non-GET request body in memory before
 * the route runs (and wait for all of it, even when the proxy refuses the request), truncating it
 * at this limit. Raw owner uploads are excluded from the proxy matcher and gate themselves, so the
 * proxy only sees small JSON bodies (largest route limit: 128 KiB in lib/http.ts readLocalJson
 * callers). 1 MiB keeps every legitimate body whole (an oversize JSON body still reaches its
 * route above that route's limit and gets 413) while bounding unauthenticated buffering.
 */
const PROXY_BODY_LIMIT_BYTES = 1024 * 1024;

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-better-sqlite3", "better-sqlite3", "sharp"],
  experimental: { proxyClientMaxBodySize: PROXY_BODY_LIMIT_BYTES },
};

export default nextConfig;
