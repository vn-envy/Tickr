# Hosting Tickr on Modal

This deploys the whole app (Next.js, the durable worker and local FFmpeg/Sharp rendering) as **one persistent Modal container** behind a public HTTPS URL. The project rules still apply:

- **Inference stays Meta-hosted.** The container calls `api.meta.ai` and runs no model of its own.
- **SQLite stays local to the app.** The live database is on container disk and is snapshotted to a Modal Volume.
- **Credentials live only in a Modal Secret.** None are baked into the image, written to files or printed.

Files: `deploy/modal_app.py` (image, container and single-writer lease), `deploy/modal-start.sh` (startup and shutdown), `scripts/db-persist.ts` (SQLite snapshots), and the owner access gate (`proxy.ts`, `lib/access.ts`, `/access`, `POST /api/access`, plus an in-route check in `app/api/businesses/[id]/media/route.ts`).

> **Always deploy with `--strategy recreate`.** The default rolling strategy starts the new container while the old one still serves. Each would run its own SQLite copy, worker and snapshot loop against the same Volume. The writer lease (below) stops the new container from starting its app in that case, so a rolling deploy fails after about 5 minutes instead of corrupting data, but it is never what you want.

## What gets deployed

| Item | Setting |
| --- | --- |
| Image | Debian slim with apt FFmpeg (the build fails if the `zscale`/`tonemap` filters are missing), DejaVu fonts, `sqlite3` and Node.js **24.22.1** from nodejs.org (SHA-256 pinned). It then runs `npm ci`, `npm run build` (including `prisma generate`) and a trial `prisma migrate deploy` at build time. `.data`, `.cache`, `.next`, `node_modules`, `.git` and `.env*` are never copied in. |
| Container | Class `Tickr`, `min_containers=1`, `max_containers=1`, 8 CPU, 16 GiB, `@modal.concurrent(max_inputs=500)`, 3600 s per-request timeout. Preemptible (the SDK default); see "Preemption" below. |
| Web | `@modal.web_server(3000, startup_timeout=600, label="tickr")` → `https://<workspace>--tickr.modal.run` (outside the default environment, Modal adds the environment name; use the URL `modal deploy` prints) |
| Volume | `tickr-data` (VolumeFS v2) at `/data`: `/data/state` holds everything under `.data` (run outputs, uploads, encrypted connections, research records); `/data/db` holds SQLite snapshots |
| Secret | `tickr-runtime` (required keys are checked at deploy time) |
| Writer lease | Modal Dict `tickr-writer-lease` holding one record: a container id and a heartbeat time (no secrets, no owner data) |
| Environment | `TICKR_SERVER_MODE=production`, `TICKR_DEPLOYMENT=modal`, `DATABASE_URL=file:/var/lib/tickr/tickr.db` (container-local; `modal-start.sh` enforces it) |

### Why exactly one container, and the writer lease

- SQLite allows a single writer.
- The worker's lease design assumes one worker host.
- Modal Volumes are last-write-wins across containers.

Do not raise `max_containers`. It does not prevent overlap on its own: a rolling deploy, a preemption replacement or an ephemeral `modal run` of this file can start a second container while the first still runs. So `deploy/modal_app.py` holds a **single-writer lease** before it starts anything:

1. **Acquire.** A new container atomically creates the lease record (`Dict.put(..., skip_if_exists=True)`). If another container holds it, the new one waits. It takes over only when the holder's heartbeat (every 10 s) is more than 60 s old. After 300 s it gives up and refuses to start.
2. **Load the latest Volume state.** After acquiring, it reloads the Volume, so it sees the previous holder's final snapshot.
3. **Release.** On shutdown, after the final snapshot, the container commits the Volume and only then releases the lease.
4. **Fence.** If a holder ever finds that another container took its lease (for example after a stall of more than 60 s), it creates `/var/lib/tickr/.writer-fenced`. It then writes no further snapshots and stops. Files it already wrote under `.data` are still committed by Modal on exit; this needs a stall longer than the TTL and is not expected in normal operation.

If the Dict is briefly unreachable, a running holder keeps serving and logs the failed heartbeat. A starting container keeps waiting and never starts unguarded.

## 1. Prerequisites

```bash
python3 -m pip install 'modal==1.6.3'   # the SDK version these files were checked against
modal setup                              # browser login; stores the Modal token in ~/.modal.toml
```

## 2. Create the runtime Secret (names only here; never paste values into chat or files)

| Key | Required | Meaning |
| --- | --- | --- |
| `META_API_KEY` | yes | Meta-hosted inference |
| `TICKR_SECRET_KEY` | yes | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts owner tokens and keys the media-library integrity records. Also feeds the access-cookie key. |
| `TICKR_ACCESS_CODE` | yes | Owner access code, **16–256 characters** (for example `openssl rand -base64 24`). A shorter code counts as misconfigured and the app fails closed. |
| `TICKR_ALLOWED_HOSTS` | yes | The public host, for example `<workspace>--tickr.modal.run`. Without it, every browser write is rejected as cross-origin. |
| `META_APP_ID`, `META_APP_SECRET`, `META_OAUTH_REDIRECT_URI` | optional | Owner Instagram/Facebook connection. All three plus `TICKR_SECRET_KEY` enable it. |
| `META_CRITIC_MODEL` | optional | `muse-spark-1.3` (default) or `muse-wonder-1.0` |

Find the workspace name with `modal profile current`; the host is then `<workspace>--tickr.modal.run`. If you are unsure, deploy once, read the printed URL, then update the Secret and redeploy.

In a shell where the values are already exported (for example, loaded from your password manager), check them by **name** only:

```bash
for k in META_API_KEY TICKR_SECRET_KEY TICKR_ACCESS_CODE TICKR_ALLOWED_HOSTS; do
  [[ -n "${!k:-}" ]] && echo "$k set" || echo "$k MISSING"
done
```

Then create or replace the Secret. Each `KEY="$KEY"` passes the value from the environment without echoing it. Values do appear briefly in the local process list while the command runs, so run it on your own machine with `set +x`.

```bash
modal secret create tickr-runtime --force \
  META_API_KEY="$META_API_KEY" \
  TICKR_SECRET_KEY="$TICKR_SECRET_KEY" \
  TICKR_ACCESS_CODE="$TICKR_ACCESS_CODE" \
  TICKR_ALLOWED_HOSTS="$TICKR_ALLOWED_HOSTS"
# Optional owner Meta connection (add to the same command when used):
#   META_APP_ID="$META_APP_ID" META_APP_SECRET="$META_APP_SECRET" \
#   META_OAUTH_REDIRECT_URI="https://$TICKR_ALLOWED_HOSTS/api/connections/meta/callback"
```

Do not put `DATABASE_URL` in the Secret. The database location is fixed by the deployment.

Do not run `modal run deploy/modal_app.py` or `modal serve deploy/modal_app.py`. Either would start a second, ephemeral copy of the app against the same Volume. The writer lease keeps that copy from starting its app, but it still costs a container.

`modal deploy` refuses to deploy when a **required** key is missing (`required_keys`). After the first deploy you can confirm the optional keys by **name** inside the running container:

```bash
modal container list                      # copy the Tickr container id
modal container exec <container-id> -- bash -c \
  'for k in META_API_KEY TICKR_SECRET_KEY TICKR_ACCESS_CODE TICKR_ALLOWED_HOSTS META_APP_ID META_APP_SECRET META_OAUTH_REDIRECT_URI META_CRITIC_MODEL; do
     [[ -n "${!k:-}" ]] && echo "$k present" || echo "$k missing"; done'
```

`TICKR_ACCESS_CODE` must have no leading or trailing whitespace (a stray newline from a file is a common cause). If it does, the app fails closed with 503 and logs `access: TICKR_ACCESS_CODE has leading or trailing whitespace` (the value is never logged).

## 3. Deploy

From the repository root, with a clean checkout that passes `npm run check`:

```bash
modal deploy --strategy recreate deploy/modal_app.py
```

`recreate` stops the running container (its exit handler takes the final snapshot, commits the Volume and releases the lease), waits for it, then starts the new version. The app is unavailable for that minute or two. To restart without code changes, use `modal app rollover tickr --strategy recreate`. Never use plain `modal deploy` or `modal app rollover` (both default to `rolling`).

The first build installs dependencies and runs `next build`, so it takes several minutes. `next build` type-checks the whole repository; a type error anywhere fails the deploy.

`modal deploy` prints the URL. Then:

1. If the printed host differs from `TICKR_ALLOWED_HOSTS`, recreate the Secret with the printed host and deploy again (with `--strategy recreate`).
2. **Meta app (optional connection).** In the Meta developer dashboard, add `https://<host>/api/connections/meta/callback` as a valid OAuth redirect URI. It must exactly equal `META_OAUTH_REDIRECT_URI`. The callback is a top-level GET in the same browser, so the access cookie (`SameSite=Lax`) accompanies it.

## 4. Verify

```bash
HOST=<workspace>--tickr.modal.run

curl -fsS "https://$HOST/api/health"
# Expect {"status":"ok",...,"database":"ready"}; credentialPresent should be true.

curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "https://$HOST/"
# Expect 307 to /access (no session)

curl -s -w ' %{http_code}\n' "https://$HOST/api/businesses"
# Expect 401 {"error":"Access code required."}

# Sign in without putting the code on the command line, then exercise a same-origin write:
printf '{"code":"%s"}' "$TICKR_ACCESS_CODE" | curl -s -c /tmp/tickr.jar -o /dev/null -w 'login %{http_code}\n' \
  -X POST -H 'Content-Type: application/json' -H "Origin: https://$HOST" --data-binary @- "https://$HOST/api/access"
curl -s -b /tmp/tickr.jar -o /dev/null -w 'list %{http_code}\n' "https://$HOST/api/businesses"
curl -s -b /tmp/tickr.jar -o /dev/null -w 'cross-origin write %{http_code} (expect 403)\n' -X POST \
  -H 'Content-Type: application/json' -H 'Origin: https://example.org' --data '{}' "https://$HOST/api/businesses"
rm -f /tmp/tickr.jar
```

Expected results:

- Login returns 200, and `list` returns 200.
- A 403 on the signed-in login (same Origin) means Modal is not forwarding the public `Host` header the way `TICKR_ALLOWED_HOSTS` expects. Check the Secret value against the printed URL.
- In `modal app logs tickr`, the first sign-in attempt logs `access: throttle client key from x-forwarded-for with N entries` (no addresses). Record the result; see "Throttling" below for what it means.
- Finally, open the URL in a browser, enter the code, and create one draft business.

`npm run smoke` cannot target the hosted URL: it accepts only loopback URLs and reads the database directly. With the gate active it also fails inside the container, because its unauthenticated POST gets 401. Use the curl checks above instead.

## 5. Logs and operations

```bash
modal app logs tickr -f       # live logs (app, worker, snapshots); secrets are never logged
modal app info tickr          # functions and state
modal container list          # find the container id
modal volume ls tickr-data /db  # snapshot files
```

### Startup (`deploy/modal_app.py`, then `deploy/modal-start.sh`)

0. **Acquire the writer lease and reload the Volume** (see "Why exactly one container").

1. **Link `.data` to the Volume.** The script first probes the Volume for exclusive create, fsync, hard link and atomic rename. It then links the whole `.data` to `/data/state`.
   - Linking only `.data/businesses` would break the media store's `realpath(.data)` integrity check.
   - If the probe fails, the container refuses to start. Setting `TICKR_ALLOW_EPHEMERAL_DATA=1` in the Secret overrides this with non-durable local files.
2. **Restore the database.** The newest snapshot (`tickr.db`, then `.1`, then `.2`) that passes `PRAGMA integrity_check` is copied to `/var/lib/tickr/tickr.db`.
   - An existing local database is never overwritten.
   - If snapshots exist but none is intact, the container refuses to start instead of starting empty.
3. **Migrate.** If the restored database has migrations pending, `/data/db/tickr.db.pre-migrate-<UTC time>` is saved first (3 kept). Then `RUST_LOG=info prisma migrate deploy` runs.
4. **Start the snapshot loop and the app.** The snapshot loop starts, then `scripts/start.sh` runs in production mode.

### Shutdown (SIGTERM via `@modal.exit`)

1. The snapshot loop stops without taking a snapshot of its own (at most 3 s).
2. The app and worker are stopped, with a 10 s grace period.
3. Exactly one final snapshot (at most 8 s), skipped if the container is fenced.
4. The exit handler commits the Volume and releases the writer lease.

The worst case is about 21 s, and the exit handler waits at most 24 s for it. Modal's exit grace period is not stated in the SDK; check the first `modal app stop` or redeploy in the logs (`db-persist: snapshot saved` should appear after `modal-start: stopping.`) and record it here.

If the app process dies on its own, the container stops itself, so that Modal starts a replacement (`min_containers=1`).

## Data persistence and backup semantics

**Database snapshots**

- The snapshot loop saves at most every **30 s**, and only after the database changed. Each snapshot uses SQLite's online backup API into a temp file in `/data/db`, then an integrity check, `fsync` and an atomic rename.
- The last **3** rolling snapshots are kept (`tickr.db`, `.1`, `.2`). A stop rotates one slot.
- **Rollback copies** that the rotation never touches:
  - `tickr.db.hourly-<UTC time>`: 24 kept, one per hour;
  - `tickr.db.daily-<UTC time>`: 7 kept, one per day;
  - `tickr.db.pre-migrate-<UTC time>`: 3 kept, taken before pending migrations.
- A backup that fails its integrity check is discarded, and the older snapshots stay.
- **Worst case:** a hard kill without SIGTERM, such as a host failure, loses database writes from the last 30 s. A normal stop, redeploy or preemption takes the shutdown snapshot.

**Rolling back the database** (deliberate and manual; automatic restore only uses the rolling snapshots):

1. `modal app stop tickr` (takes a final snapshot).
2. `modal volume ls tickr-data /db` and pick a copy, for example `tickr.db.hourly-20261104T120000Z`.
3. Keep the current snapshot aside and put the chosen copy in its place (restore reads `tickr.db` first):
   ```bash
   modal volume cp tickr-data /db/tickr.db /db/tickr.db.before-rollback
   modal volume rm tickr-data /db/tickr.db
   modal volume cp tickr-data /db/tickr.db.hourly-20261104T120000Z /db/tickr.db
   ```
4. `modal deploy --strategy recreate deploy/modal_app.py`.

Files under `.data` are not rolled back with it; a database row whose files are newer is fine, and files without rows are ignored.

**Files under `.data`**

- Run outputs, uploads and encrypted connections are written directly to the Volume.
- Modal commits Volume v2 changes in the background, and on container exit.

**Consistency after a crash**

- A restored database can be up to 30 s older than the files. Worker leases and stored paid responses are designed for crash recovery: uncertain paid requests are never repeated automatically.
- A file without a database row is ignored.

**Upload streaming**

Next buffers in memory the body of every non-GET request the proxy matches, and waits for the whole body even when the proxy refuses it. So:

- The raw upload route (`POST /api/businesses/:id/media`, up to 300 MiB) is **excluded from the proxy matcher**. It checks the access cookie itself (`accessDenial` in `lib/access.ts`) before reading any body byte, then streams the body to disk as it did before the gate existed. Unauthenticated uploads get 401 without being buffered.
- Every other route goes through the proxy. `experimental.proxyClientMaxBodySize` is 1 MiB, above the largest JSON body any route accepts (128 KiB), so an unauthenticated request can make the proxy hold at most about 2 MiB.

**Backup copies**

The Volume is the only copy. To back up off-platform, use `modal volume get tickr-data /db ./tickr-db-backup` (this downloads the database, including owner data, so treat it as private).

## Access gate

- **Gate active.** `TICKR_ACCESS_CODE` is set (16–256 characters).
- **Fail closed.** With `TICKR_DEPLOYMENT=modal` and no valid code, every route except `/api/health` returns 503 "Access is not configured."
- **Signing in.** The owner enters the code at `/access`. The server then sets `tickr_access`:
  - an HttpOnly, Secure, `SameSite=Lax` cookie named `__Host-tickr_access` (the prefix pins `Path=/` and forbids a `Domain`, so a sibling `*.modal.run` app cannot shadow it) with a 7-day HMAC-SHA256 token;
  - the key is derived from the code plus `TICKR_SECRET_KEY`, so rotating either value signs everyone out.
- **Throttling** (in memory, same error message every time):
  - 5 wrong codes per client per 10 minutes, keyed by the right-most `X-Forwarded-For` entry.
  - No global hard block, because anyone with the URL could use one to lock the owner out. Once 100 wrong codes arrive within 10 minutes, every attempt waits 1 s instead.
  - **Check on the first deploy** (the `access: throttle client key from ...` log line). If Modal appends the real client address as the last entry, the per-client limit works as intended. If Modal sends no such header, Next fills in the connecting address, which is Modal's proxy, so all clients share one bucket and 5 wrong attempts by anyone block sign-in for 10 minutes (the line then shows 1 entry for every visitor). If the client controls the last entry, the per-client limit can be dodged and only the slowdown applies. In every case a **random** code of 16+ characters (`openssl rand -base64 24`) is what makes guessing infeasible; do not use a memorable phrase.
- **Without a session.** Pages redirect to `/access?next=<same-origin path>`, and APIs return 401 JSON.
- **Exempt paths.** `/api/health`, `/access`, `/api/access`, `/_next/static/*` and `/favicon.ico`.
- **Sign-in redirect.** `next` must be a same-origin path. It is re-checked after URL normalization, so `/.//evil.example` and similar tricks become `/`.
- **Local development.** Without these variables nothing changes.

## Cost

`min_containers=1` keeps one 8-CPU, 16 GiB container running and billed around the clock, even when idle. See Modal's pricing page for current rates.

After a demo:

- **Stop everything.** `modal app stop tickr` permanently stops the app and its URL. The shutdown snapshot runs, and the Volume and Secret remain, so a later `modal deploy --strategy recreate deploy/modal_app.py` brings everything back.
- **Scale to zero.** Alternatively, set `min_containers=0` in `deploy/modal_app.py` and redeploy (with `--strategy recreate`). The container then starts on the first request (including restore and migrations) and stops after `scaledown_window` (20 min) without requests. A long Autopilot render with no open browser can then be cut off by scale-down; its lease is reconciled on the next start, without repeating paid requests.

### Preemption

The container is preemptible (the SDK default). A preemption sends SIGTERM, so the normal shutdown runs and the replacement waits for the writer lease. `App.cls(nonpreemptible=True)` exists in this SDK and would make that rarer, at a higher price; it is not set, to keep the demo cost down. Turn it on for a long-running production deployment.

### Node.js version

The image pins Node.js 24.22.1 (the runtime these checks ran on). The repository's `.nvmrc` says 24.19.0. Both are Node 24; align them when convenient. The tarball's SHA-256 is pinned in `deploy/modal_app.py`. It was taken from `SHASUMS256.txt.asc` for v24.22.1, whose OpenPGP signature was checked with `gpgv` against the active Node.js release keyring from `github.com/nodejs/release-keys` ("Good signature", key `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`, Antoine du Hamel). The image build then only needs the pinned hash. When you bump the version, repeat that check before changing the hash.

## Verified Modal SDK facts (modal 1.6.3, read from the installed package)

- `App.cls(...)` accepts `image`, `secrets`, `volumes`, `env`, `cpu`, `memory` (MiB), `min_containers`, `max_containers`, `scaledown_window` (2–3600), `timeout` and `startup_timeout`.
- `modal.concurrent(max_inputs=..., target_inputs=...)` is applied at class level.
- `modal.web_server(port, startup_timeout=..., label=...)` produces the subdomain `<workspace>--<label>.modal.run`.
- `Volume.from_name(name, create_if_missing=True, version=2)` creates a v2 Volume.
- `Secret.from_name(name, required_keys=[...])` checks the required keys.
- Exit handlers (`@modal.exit`) run before the final Volume commit.
- Volume mounts allow background commits.
- `modal app logs`, `modal app stop`, `modal container exec`, `modal volume get` and `modal secret create --force KEY=VALUE` exist in this CLI.
- `modal deploy` and `modal app rollover` default to `--strategy rolling`; `recreate` stops and waits for the old containers before the new version runs (`runner.py`, `_stop_and_wait_for_containers`).
- `Dict.from_name(..., create_if_missing=True)`; `Dict.put(key, value, skip_if_exists=True)` returns whether it created the key; `Dict.get` and `Dict.pop(key, default)`.
- `Volume.commit()` and `Volume.reload()` work inside a container that mounts the Volume; `reload()` fails while files on the Volume are open (it runs before the app starts).
- `App.cls(nonpreemptible=...)` exists (default `False`).

**Not verifiable offline:**

- whether Modal forwards the browser's `Host` and `X-Forwarded-For`;
- the exact SIGTERM grace period (the exit handler waits up to 45 s);
- whether Volume v2 supports hard links. The startup probe checks this, and the container refuses to start if it is unsupported.
