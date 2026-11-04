#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export NEXT_TELEMETRY_DISABLED=1
export NODE_USE_ENV_PROXY=1
export XDG_CACHE_HOME="$PWD/.cache"
case "${TICKR_SERVER_MODE:-development}" in
  development) tickr_next_command=dev ;;
  production) tickr_next_command=start ;;
  *) echo 'TICKR_SERVER_MODE must be development or production.' >&2; exit 1 ;;
esac
worker_pid=""
web_pid=""
cleanup() {
  trap - EXIT INT TERM
  [[ -z "$worker_pid" ]] || kill -TERM -- "-$worker_pid" 2>/dev/null || true
  [[ -z "$web_pid" ]] || kill -TERM -- "-$web_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Separate process groups let cleanup stop Next's child server and render subprocesses too.
setsid node --import tsx scripts/worker.ts &
worker_pid=$!
setsid node node_modules/next/dist/bin/next "$tickr_next_command" --hostname 0.0.0.0 --port "${PORT:-3000}" &
web_pid=$!
wait -n "$worker_pid" "$web_pid"
