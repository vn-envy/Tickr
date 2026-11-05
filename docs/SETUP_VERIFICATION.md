# Setup verification — 4 November 2026 (Autopilot build)

These checks ran in cloud instances on the `claude/epic-davinci-lhcj86` branch. Dates are UTC.

| Check | Observed result |
| --- | --- |
| Code checks | `npm run check` passed: ESLint, TypeScript and **614 tests across 56 files** |
| Production build | `npm run build` passed; it includes the new Autopilot routes |
| Media diagnostic | `npm run media:check` passed, including the offline depth Reel contract (1080×1920, 30 fps, 360 frames, H.264) |
| Persistence/API | `npm run smoke` passed against the production server |
| Browser flow (production) | Playwright ran intake → consented synthetic upload → Autopilot start → director's room with no console errors. Without a key, the worker stopped before discovery with no Meta request, and the UI showed the stopped state |
| Same-origin fix | Browser writes failed in production because Next binds to `0.0.0.0`. Fixed to compare Origin with the Host header plus a host allowlist; regression-tested |
| Live Meta capability probe | `npm run autopilot:check`, run in a separate session with `META_API_KEY`: **7/7 steps passed** (Spark media analysis, SAM 3.1 box and concept segmentation, Spark shot log, SAM 3.1 video tracking, local Reels, Spark critic). 6 paid requests; list-price estimate about USD 0.06 |
| Adversarial review | 6 lenses; 20 findings confirmed by two independent skeptics; all fixed with regression tests and independently re-checked |

The live probe used synthetic local media only. It verifies request and response shapes and basic quality on simple subjects. It does not show Spark box accuracy on busy real photos, campaign effectiveness, or that the Graph connector works. A live end-to-end Autopilot run on real businesses is recorded separately once complete.

---

# Setup verification — 2 November 2026

Dates use IST; saved artifacts retain UTC timestamps. These checks ran in the current cloud instance. Snapshot restoration has not been independently tested. Outputs remain campaign concepts requiring review.

| Check | Observed result |
| --- | --- |
| Runtime | Node 24.19.0, npm 11.9.0; pinned dependencies and non-destructive Prisma/SQLite migrations |
| Setup | Initial and repeated `bash scripts/setup.sh` passed; database integrity, relations, FTS and immutable stage constraints checked |
| Code checks | `npm run check` passed ESLint, TypeScript and 126 tests across 16 files |
| Production build | `npm run build` passed; production web app and worker started successfully |
| Persistence/API | Fresh `npm run smoke` against production passed page/health, draft/readback, invalid inputs, cross-origin rejection, relations and FTS; temporary test records removed |
| Link-only discovery | Maps routing or official URL discovers identity without supplied name, locality, story or source text; exact retrieval/citation attribution retained |
| Product enrichment | Focused Meta retrieval extracts named offerings and brand signals; missing catalog data stays missing |
| Official-site reading | Theobroma original HTML retrieved through validated public-IP proxy transport; redirects, DNS, TLS, robots, MIME and byte limits retained |
| Source photographs | Exact product image reference found in official HTML. Its CDN robots response was HTTP 500, so the image was not downloaded |
| Meta text | Live `muse-spark-1.3` discovery, enrichment, analysis and structured campaign copy completed |
| Meta images | Live `muse-image-1.0` generation completed and is integrated into campaign composition; reference editing is implemented and offline-tested, not live-verified |
| Real brand/product exports | Grandma Daphne’s and Theobroma produced seven channel concepts, 22 downloadable files each, including labelled illustrations, source dossiers, actual MP4s and ZIPs |
| Video/archive integrity | All three H.264 Reels independently verified: 1080×1920, 30fps, 360 frames, 12 seconds. All three ZIPs pass CRC checks with 21 enclosed entries |
| Browser verification | All three saved campaigns restored at desktop/mobile sizes with no POSTs, errors, failed requests or overflow; product/brand panels, illustration provenance, video playback and ZIP downloads checked |
| Media diagnostic | `npm run media:check` passed four-scene 1080×1920/30fps/12-second composition metadata and 540×960 still; observed only local renderer requests |
| Earlier fictional cases | Bakery, dentist, gym and salon completed live Meta concept flows with supplied synthetic evidence; these are software checks, not real-business benchmarks |

The enriched completions required fixes to deterministic validation and recovery of their actual completed copy responses. No research or copy was regenerated during recovery. Unused earlier reservations on the first two remain recorded conservatively. The latest Mava Cake run completed with six named offerings, original official HTML and 22 checksum-verified files; its actual completed copy was likewise recovered after a production-note cleanup fix. See [product grounding](PRODUCT_GROUNDING.md) for precise run IDs, evidence scope and recovery results; do not present recovered runs as uninterrupted first-pass successes.

## Environment configuration

`META_API_KEY` is active and was tested without exposing its value. Node commands set `NODE_USE_ENV_PROXY=1` before startup. Meta requests go only to the configured Meta host; public official-site reading is a separate restricted path. The official-site transport resolves and validates all public IPv4 answers, tunnels to one validated IP through the trusted environment proxy, and verifies TLS against the original hostname. It does not send Meta credentials to websites or fall back to unchecked hostname tunnels.

Prisma migration deployment uses `RUST_LOG=info` to avoid a blank schema-engine error observed on fresh SQLite databases in this instance. Checksum verification remains enabled. Native compilation uses a writable workspace cache. `scripts/start.sh` owns separate web/worker process groups and cleans them up on termination; production mode uses `TICKR_SERVER_MODE=production`. The app is a private development instance without multi-user access controls.

## Scope and remaining work

Runtime inference uses Meta-hosted APIs. Images are generated through `/images/generations` as bounded inline bytes, with implicit web/image tools disabled. The account lists additional models, but catalog presence does not verify their operations. Segmentation, live reference editing, rates and capacity remain unverified. Local Sharp/SVG and FFmpeg perform deterministic composition and encoding; no external video service is involved.

Grandma Daphne’s public profile supports an attributed story theme but no named offering in the completed run. Theobroma supplies named product evidence. Neither establishes a local customer/competitor gap or conversion uplift. Meta-linked summaries are reported interpretations, not original quotations or independent verification. Original site text is labelled separately. Proposed palettes are not verified brand guides. Generated illustrations are not actual product photographs. Contextual final critique, exact-version owner approval, authorized owner uploads and publication remain unfinished.

Protected local reports are under `.data/`: `brand-link-smoke.json`, `product-link-smoke.json`, discovery/enrichment/copy diagnostics, network/image capability checks and `ui-check/`. They are ignored by Git. Credentials are not persisted in those reports. Model calls are bounded and uncertain paid requests are never retried automatically.

## Repeat checks

```bash
bash scripts/setup.sh
npm run check
npm run build
TICKR_SERVER_MODE=production bash scripts/start.sh
# In another terminal:
npm run smoke
npm run meta:check
```

Run `npm run media:check` for renderer changes. Explicit live generation commands and saved-run walkthroughs are in [DEMO.md](DEMO.md). Ordinary tests do not make paid inference calls.

The Meta hackathon overview and linked official rules were previously retrieved successfully. Judging weights are impact 30%, Meta AI tooling 25%, technical depth/execution 20%, and demo 25%. The stated deadline is November 4, 2026 at 9 PM US Eastern, or November 5 at 07:30 IST. See the build plan for remaining submission details.

No repository push, public deployment, social publication, outbound message or ad activation was performed.

---

# Correction and update — 5 November 2026

This entry is appended. It corrects two statements in the entries above, which are left as they were.

| Earlier statement | Current status |
| --- | --- |
| 4 Nov entry: "614 tests across 56 files" | `npm run check` passes with **951 tests** on the deployed commit `6c0aaec`. |
| 2 Nov entry: "No repository push, public deployment, social publication, outbound message or ad activation was performed." | Tickr's own code is now deployed on Modal as one persistent container behind an access-code gate (see [deploy/README.md](../deploy/README.md)). Modal runs no models; inference stays on Meta-hosted APIs. No social publication, outbound message or ad activation has been performed. |
| 2 Nov entry: "The app is a private development instance without multi-user access controls." | An access-code gate now exists (`proxy.ts`, `lib/access.ts`) and is on for the hosted deployment. There are still no per-user accounts. |

| Check | Observed result |
| --- | --- |
| Hosted end-to-end Autopilot | Grandma Daphne's Bakehouse (Hyderabad), website link with a story goal, on the Modal deployment. It completed in 3 min 40 s. Spark analysed 12 official-site photos. 3 were excluded with recorded reasons: a person without consent, a logo, interior signage. SAM 3.1 produced 3 cutouts, and Tickr rendered a still-depth Reel. The critic raised 10 findings, none blocking, including ragged edges on the hero cutout and text contrast. |
| Maps-link discovery | In 3 of the last 5 Maps attempts, Meta search returned no usable sources, and Tickr stopped and asked for a better link instead of guessing. |
| `share.google` links | Resolved from redirect headers only. No Google page is fetched. |

In progress at the time of writing: a SAM mask-quality gate, and a website-identity fallback that uses Tickr's permitted, SSRF-safe reading of the owner's own site.
