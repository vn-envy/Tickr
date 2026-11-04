#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export NEXT_TELEMETRY_DISABLED=1
mkdir -p .data .cache
export npm_package_config_node_gyp_devdir="$PWD/.cache/node-gyp"
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Use Node 24 (see .nvmrc)")'
npm ci
npm run db:setup
command -v ffmpeg >/dev/null || { echo 'FFmpeg is required for local media validation.' >&2; exit 1; }
command -v setsid >/dev/null || { echo 'The Linux setsid utility is required for managed web/worker startup.' >&2; exit 1; }
if [[ ! -x "${REMOTION_BROWSER_EXECUTABLE:-/usr/bin/chromium}" ]]; then
  echo 'Set REMOTION_BROWSER_EXECUTABLE to an installed Chromium executable.' >&2
  exit 1
fi
echo 'Tickr dependencies and local database are ready. Meta access is verified separately.'
