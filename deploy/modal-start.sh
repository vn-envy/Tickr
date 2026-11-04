#!/usr/bin/env bash
# Container entrypoint for the Modal deployment (started by deploy/modal_app.py).
#
#   1. .data -> Volume: the whole runtime data directory lives on the persistent Volume, so run
#      outputs, owner uploads and encrypted connections survive restarts. (Linking only
#      .data/businesses would break the media store's realpath integrity check, which compares
#      against realpath(.data).) The Volume is probed for the POSIX operations the stores rely
#      on (exclusive create, fsync, hard link, atomic rename) before anything is written.
#   2. SQLite stays on container-local disk and is restored from the newest intact Volume
#      snapshot only when no local database exists.
#   3. A pre-migration snapshot when migrations are pending, prisma migrate deploy, then the 30 s
#      snapshot loop, then scripts/start.sh (production).
#   4. SIGTERM/SIGINT: stop the snapshot loop (no snapshot of its own), stop the app (bounded),
#      then exactly one final snapshot. Worst case about 21 s (3 + 10 + 8).
#
# deploy/modal_app.py holds the single-writer lease before running this script. If that lease is
# ever lost to another container, it creates $TICKR_DB_FENCE_FILE: from then on no snapshot is
# written (the other container owns /data/db) and the container stops.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DATA_ROOT="${TICKR_DATA_ROOT:-/data}"
LOCAL_DB_DIR="${TICKR_LOCAL_DB_DIR:-/var/lib/tickr}"
GRACE_SECONDS="${TICKR_SHUTDOWN_GRACE_SECONDS:-10}"
log() { printf 'modal-start: %s\n' "$*"; }

export NEXT_TELEMETRY_DISABLED=1
export PRISMA_HIDE_UPDATE_MESSAGE=1
export TICKR_SERVER_MODE=production
export TICKR_DB_PATH="$LOCAL_DB_DIR/tickr.db"
export TICKR_DB_BACKUP_DIR="$DATA_ROOT/db"
export TICKR_DB_FENCE_FILE="${TICKR_DB_FENCE_FILE:-$LOCAL_DB_DIR/.writer-fenced}"
if [[ -n "${DATABASE_URL:-}" && "$DATABASE_URL" != "file:$TICKR_DB_PATH" ]]; then
  log "ignoring DATABASE_URL override; the database must stay container-local."
fi
export DATABASE_URL="file:$TICKR_DB_PATH"

[[ -d "$DATA_ROOT" ]] || { log "the persistent Volume is not mounted at $DATA_ROOT; refusing to start."; exit 1; }
[[ ! -e "$TICKR_DB_FENCE_FILE" ]] || { log "this container lost the writer lease; refusing to start."; exit 1; }
mkdir -p "$DATA_ROOT/state" "$DATA_ROOT/db" "$LOCAL_DB_DIR"
chmod 700 "$DATA_ROOT/state" "$DATA_ROOT/db" "$LOCAL_DB_DIR"

probe_volume() {
  node --input-type=module - "$DATA_ROOT/state" <<'NODE'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, constants, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
const dir = join(process.argv[2], `.fs-probe-${process.pid}`);
let step = "mkdir";
try {
  mkdirSync(dir, { mode: 0o700 });
  step = "exclusive create + fsync";
  const fd = openSync(join(dir, "a"), "wx", 0o600); writeSync(fd, "probe"); fsyncSync(fd); closeSync(fd);
  step = "directory fsync";
  const dfd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY); fsyncSync(dfd); closeSync(dfd);
  step = "hard link"; linkSync(join(dir, "a"), join(dir, "b"));
  step = "atomic rename"; renameSync(join(dir, "b"), join(dir, "c"));
} catch {
  console.error(`modal-start: the Volume does not support ${step}.`);
  process.exitCode = 1;
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
NODE
}

if [[ -L .data ]]; then
  [[ "$(readlink .data)" == "$DATA_ROOT/state" ]] || { log ".data links somewhere unexpected; refusing to start."; exit 1; }
elif [[ -e .data ]]; then
  rmdir .data 2>/dev/null || { log ".data already holds files in the image; refusing to replace it."; exit 1; }
fi
if probe_volume; then
  [[ -L .data ]] || ln -s "$DATA_ROOT/state" .data
elif [[ "${TICKR_ALLOW_EPHEMERAL_DATA:-}" == "1" ]]; then
  log "WARNING: TICKR_ALLOW_EPHEMERAL_DATA=1; run files and uploads stay on container disk and are lost on restart."
  [[ -L .data ]] && rm .data
  mkdir -p .data
else
  log "refusing to start without durable storage (set TICKR_ALLOW_EPHEMERAL_DATA=1 to override)."
  exit 1
fi

node --import tsx scripts/db-persist.ts restore || {
  log "database restore failed; refusing to start with an empty database. Inspect $DATA_ROOT/db."
  exit 1
}
node --import tsx scripts/db-persist.ts pre-migrate || { log "pre-migration snapshot failed; not migrating."; exit 1; }
RUST_LOG=info npx --no-install prisma migrate deploy

backup_pid=""
app_pid=""
node --import tsx scripts/db-persist.ts --loop &
backup_pid=$!
setsid bash scripts/start.sh &
app_pid=$!

wait_bounded() { # pid seconds
  local pid="$1" seconds="$2" waited=0
  while kill -0 "$pid" 2>/dev/null && (( waited < seconds * 10 )); do sleep 0.1; waited=$((waited + 1)); done
  ! kill -0 "$pid" 2>/dev/null
}

shutdown() {
  trap '' TERM INT
  log "stopping."
  # SIGUSR1: the loop exits without its own snapshot (an in-flight one finishes or is abandoned
  # safely: snapshots are installed by atomic rename). One final snapshot follows below.
  if [[ -n "$backup_pid" ]]; then kill -USR1 "$backup_pid" 2>/dev/null || true; wait_bounded "$backup_pid" 3 || kill -KILL "$backup_pid" 2>/dev/null || true; fi
  if [[ -n "$app_pid" ]]; then
    kill -TERM "$app_pid" 2>/dev/null || true # start.sh stops the worker and web process groups
    wait_bounded "$app_pid" "$GRACE_SECONDS" || log "app did not stop within ${GRACE_SECONDS}s; the worker lease will be reconciled on restart."
  fi
  if [[ -e "$TICKR_DB_FENCE_FILE" ]]; then
    log "writer lease lost; no final snapshot (the current writer owns the snapshots)."
  else
    timeout 8 node --import tsx scripts/db-persist.ts backup || log "final snapshot did not complete; the earlier snapshot is kept."
  fi
  exit "${1:-0}"
}
trap 'shutdown 143' TERM
trap 'shutdown 130' INT

# If the app or the snapshot loop exits on its own, stop the container so Modal replaces it.
set +e
wait -n "$app_pid" "$backup_pid"
status=$?
set -e
log "a managed process exited (status $status); shutting down."
shutdown 1
