"""Tickr on Modal: one persistent container serving the whole app over a public HTTPS URL.

    modal deploy --strategy recreate deploy/modal_app.py   # the ONLY supported deploy command
    modal app rollover tickr --strategy recreate            # restart without code changes

Never use the default ("rolling") strategy: it starts the new container while the old one still
serves, and each runs its own SQLite copy, worker and snapshot loop against the same Volume.
(Even so, the writer lease below keeps a second container from starting its app.)

Design rules (AGENTS.md):
- All inference stays Meta-hosted (api.meta.ai). Nothing here runs a model; the container only
  hosts Next.js, the durable worker and local FFmpeg/Sharp rendering.
- Exactly one container (min_containers=1, max_containers=1): SQLite has a single writer, the
  worker lease design assumes one worker host, and Modal Volumes are last-write-wins.
  max_containers does not stop a rolling deploy, a preemption replacement or an ephemeral
  `modal run` from overlapping, so a single-writer lease in a Modal Dict ("tickr-writer-lease",
  which holds only a container id and a heartbeat time) guards the start: a new container waits
  until the previous holder released the lease (after its final snapshot and Volume commit) or
  its heartbeat is over LEASE_TTL_SECONDS old, then reloads the Volume and starts. A holder that
  sees another holder fences itself (no more snapshots) and stops.
- SQLite lives on container-local disk; deploy/modal-start.sh snapshots it to the Volume every
  30 s and on shutdown. Run files, uploads and encrypted connections live on the Volume.
- Credentials come only from the Modal Secrets "tickr-runtime" and "tickr-keys"; nothing secret is baked into the
  image, written to files or logged.

Verified against the Modal Python SDK 1.6.3 signatures (see deploy/README.md).
"""

from __future__ import annotations

import os
import secrets
import signal
import subprocess
import threading
import time
from pathlib import Path

import modal

APP_NAME = "tickr"
WEB_LABEL = "tickr"  # public URL: as `modal deploy` prints it, https://<workspace>--tickr[.<region>].modal.run (plus -<env> outside "main")
APP_DIR = "/app"
PORT = 3000
REPO_ROOT = Path(__file__).resolve().parent.parent

# Exact Node.js runtime. The hash is from https://nodejs.org/dist/v24.22.1/SHASUMS256.txt.asc,
# whose signature was verified with gpgv against github.com/nodejs/release-keys (see deploy/README.md).
NODE_VERSION = "24.22.1"
NODE_SHA256 = "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6"
NODE_TARBALL = f"node-v{NODE_VERSION}-linux-x64.tar.xz"

# Rotatable runtime settings live in "tickr-runtime" (safe to recreate with --force).
REQUIRED_SECRET_KEYS = ["META_API_KEY", "TICKR_ACCESS_CODE", "TICKR_ALLOWED_HOSTS"]
# TICKR_SECRET_KEY encrypts owner tokens and keys media-library integrity records. Modal secrets
# cannot be read back, so it lives in its own create-once Secret "tickr-keys" that is never
# recreated with --force; replacing it would orphan stored owner connections and records.
KEY_SECRET_KEYS = ["TICKR_SECRET_KEY"]

LOCAL_DB_DIR = "/var/lib/tickr"
FENCE_FILE = f"{LOCAL_DB_DIR}/.writer-fenced"  # read by deploy/modal-start.sh and scripts/db-persist.ts
LEASE_KEY = "writer"
LEASE_HEARTBEAT_SECONDS = 10
LEASE_TTL_SECONDS = 60  # a holder silent this long is presumed dead
LEASE_WAIT_SECONDS = 300  # then refuse to start (a rolling deploy fails instead of double-writing)
STOP_WAIT_SECONDS = 24  # modal-start.sh needs at most ~21 s to stop and take the final snapshot

# Never shipped into the image: runtime data, local caches, build output, VCS and env files.
IMAGE_IGNORE = [
    ".git",
    ".data",
    ".cache",
    ".next",
    "node_modules",
    "lib/generated",
    "coverage",
    ".env",
    ".env.*",
    "**/*.tsbuildinfo",
    "**/*.log",
    "**/__pycache__",
    "**/.DS_Store",
]

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install(
        "ffmpeg",
        "fonts-dejavu-core",
        "fontconfig",
        "ca-certificates",
        "curl",
        "xz-utils",
        "sqlite3",
        # Fallback toolchain in case a native module (better-sqlite3) has no prebuilt binary.
        "make",
        "g++",
    )
    .run_commands(
        # HDR tone mapping (lib/media/poster.ts) needs FFmpeg's zscale filter; fail the build without it.
        "filters=\"$(ffmpeg -hide_banner -filters)\" && echo \"$filters\" | grep -Eq '^ ... zscale ' && echo \"$filters\" | grep -Eq '^ ... tonemap '"
        " || (echo 'FFmpeg lacks the zscale/tonemap filters' >&2; exit 1)",
        f"curl -fsSLo /tmp/{NODE_TARBALL} https://nodejs.org/dist/v{NODE_VERSION}/{NODE_TARBALL}",
        f"echo '{NODE_SHA256}  /tmp/{NODE_TARBALL}' | sha256sum -c -",
        f"mkdir -p /opt/node && tar -xJf /tmp/{NODE_TARBALL} -C /opt/node --strip-components=1 --no-same-owner",
        f"rm /tmp/{NODE_TARBALL}",
        "ln -sf /opt/node/bin/node /usr/local/bin/node",
        "ln -sf /opt/node/bin/npm /usr/local/bin/npm",
        "ln -sf /opt/node/bin/npx /usr/local/bin/npx",
        f"test \"$(node --version)\" = 'v{NODE_VERSION}'",
    )
    .env({"NEXT_TELEMETRY_DISABLED": "1", "NPM_CONFIG_UPDATE_NOTIFIER": "false"})
    .add_local_dir(str(REPO_ROOT), APP_DIR, copy=True, ignore=IMAGE_IGNORE)
    .workdir(APP_DIR)
    .run_commands(
        "npm ci",
        # The build only needs a throwaway database path; runtime data never enters the image.
        "DATABASE_URL=file:/tmp/tickr-build.db npm run build",
        # Prove the migration engine works in this image, then discard the build-time database.
        "DATABASE_URL=file:/tmp/tickr-build.db RUST_LOG=info npx --no-install prisma migrate deploy",
        "rm -rf /tmp/tickr-build.db* .data .cache/npm",
        "chmod +x deploy/modal-start.sh",
    )
)

app = modal.App(APP_NAME)
data_volume = modal.Volume.from_name("tickr-data", create_if_missing=True, version=2)
runtime_secret = modal.Secret.from_name("tickr-runtime", required_keys=REQUIRED_SECRET_KEYS)
key_secret = modal.Secret.from_name("tickr-keys", required_keys=KEY_SECRET_KEYS)
writer_lease = modal.Dict.from_name("tickr-writer-lease", create_if_missing=True)


def log(message: str) -> None:
    print(f"modal_app: {message}", flush=True)


class WriterLease:
    """Single-writer lease in a Modal Dict. put(skip_if_exists=True) is the atomic acquire."""

    def __init__(self, store, holder: str) -> None:
        self.store = store
        self.holder = holder

    def _record(self) -> dict:
        return {"holder": self.holder, "heartbeat": time.time()}

    def acquire(self, wait_seconds: float = LEASE_WAIT_SECONDS) -> None:
        deadline = time.monotonic() + wait_seconds
        announced = False
        while True:
            try:
                if self.store.put(LEASE_KEY, self._record(), skip_if_exists=True):
                    return
                current = self.store.get(LEASE_KEY)
                if current is None:
                    continue
                if current.get("holder") == self.holder:
                    return
                age = time.time() - float(current.get("heartbeat", 0))
                if age > LEASE_TTL_SECONDS:
                    log(f"previous writer silent for {int(age)} s; taking over its lease.")
                    if self.store.get(LEASE_KEY) == current:
                        self.store.pop(LEASE_KEY, None)
                    continue
                if not announced:
                    log("another Tickr container holds the writer lease; waiting for it to stop.")
                    announced = True
            except Exception as error:  # Dict unavailable: keep waiting, never start unguarded
                log(f"writer lease check failed ({type(error).__name__}); retrying.")
            if time.monotonic() > deadline:
                raise RuntimeError(
                    "another Tickr container still holds the writer lease; refusing to start a second writer. "
                    "Deploy with `modal deploy --strategy recreate deploy/modal_app.py`."
                )
            time.sleep(5)

    def heartbeat(self) -> bool:
        """Refreshes the lease. False only when another holder is positively observed."""
        current = self.store.get(LEASE_KEY)
        if current is not None and current.get("holder") != self.holder:
            return False
        self.store.put(LEASE_KEY, self._record())
        return True

    def release(self) -> None:
        current = self.store.get(LEASE_KEY)
        if current is not None and current.get("holder") == self.holder:
            self.store.pop(LEASE_KEY, None)


@app.cls(
    image=image,
    secrets=[runtime_secret, key_secret],
    volumes={"/data": data_volume},
    env={
        "TICKR_SERVER_MODE": "production",
        "TICKR_DEPLOYMENT": "modal",
        "DATABASE_URL": "file:/var/lib/tickr/tickr.db",
        "PORT": str(PORT),
    },
    cpu=8.0,
    memory=16384,
    min_containers=1,
    max_containers=1,
    scaledown_window=1200,
    timeout=3600,  # per request: long uploads and downloads
    startup_timeout=900,  # restore + migrations before the port opens
)
@modal.concurrent(max_inputs=500)
class Tickr:
    @modal.enter()
    def start(self) -> None:
        self.stopping = False
        self.fenced = False
        self.process: subprocess.Popen | None = None
        holder = f"{os.environ.get('MODAL_TASK_ID') or 'container'}-{secrets.token_hex(4)}"
        self.lease = WriterLease(writer_lease, holder)
        self.lease.acquire()
        # The previous writer committed its final snapshot before releasing the lease; this
        # container may have mounted the Volume earlier, so load the latest committed state.
        data_volume.reload()
        # Own session: Modal's signal handling stays separate from the app's process tree.
        self.process = subprocess.Popen(["bash", "deploy/modal-start.sh"], cwd=APP_DIR, start_new_session=True)
        threading.Thread(target=self._watch, daemon=True).start()
        threading.Thread(target=self._heartbeat, daemon=True).start()

    def _watch(self) -> None:
        assert self.process is not None
        code = self.process.wait()
        if not self.stopping:
            log(f"Tickr exited unexpectedly (status {code}); stopping the container for a restart.")
            os.kill(os.getpid(), signal.SIGINT)

    def _heartbeat(self) -> None:
        while not self.stopping:
            time.sleep(LEASE_HEARTBEAT_SECONDS)
            if self.stopping:
                return
            try:
                still_held = self.lease.heartbeat()
            except Exception as error:  # transient Dict errors: the TTL tolerates several misses
                log(f"writer lease heartbeat failed ({type(error).__name__}).")
                continue
            if not still_held:
                # Another container took over (this one stalled past the TTL): stop writing
                # snapshots at once, then stop the container.
                self.fenced = True
                Path(FENCE_FILE).parent.mkdir(parents=True, exist_ok=True)
                Path(FENCE_FILE).touch()
                log("writer lease taken over by another container; fenced, stopping.")
                os.kill(os.getpid(), signal.SIGINT)
                return

    @modal.web_server(PORT, startup_timeout=600, label=WEB_LABEL)
    def web(self) -> None:
        """The server was started in start(); Modal routes HTTPS traffic to PORT."""

    @modal.exit()
    def stop(self) -> None:
        # modal-start.sh stops the snapshot loop, stops the app and takes one final snapshot.
        # Then commit the Volume and only then release the lease, so the next writer restores
        # from this container's final state.
        self.stopping = True
        process = getattr(self, "process", None)
        if process is not None and process.poll() is None:
            process.send_signal(signal.SIGTERM)
            deadline = time.monotonic() + STOP_WAIT_SECONDS
            while process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.2)
        if getattr(self, "fenced", False) or getattr(self, "lease", None) is None:
            return
        try:
            data_volume.commit()
        except Exception as error:
            log(f"Volume commit at exit failed ({type(error).__name__}); Modal commits again on exit.")
        try:
            self.lease.release()
        except Exception as error:
            log(f"writer lease release failed ({type(error).__name__}); it expires after {LEASE_TTL_SECONDS} s.")
