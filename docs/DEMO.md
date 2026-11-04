# Working demo — 4 November 2026

Tickr turns a business link into attributed research, a product or brand-story direction, and a coordinated visual concept kit. The current real-business examples use Meta-hosted discovery, enrichment, analysis, copy and image generation, followed by local rendering. They demonstrate software execution and reviewable concepts, not owner approval or measured business outcomes. [PRODUCT_GROUNDING.md](PRODUCT_GROUNDING.md) records implementation, provenance, actual usage and recovery limits.

## Start and demonstrate

1. Run `bash scripts/setup.sh` if dependencies or migrations are missing, then `bash scripts/start.sh` to start both app and worker. The existing server-side `META_API_KEY` is required for a new live run.
2. In Discover, choose a blank business, paste a public website, Maps listing or Instagram link and optionally add a goal. Name, locality, story and source excerpts are not prerequisites. For Grandma Daphne's use `https://maps.app.goo.gl/nNy6iYx9r4GaU7YY8`; for the product example use `https://theobroma.in`.
3. In Investigate, inspect identity, products/services, brand signals, linked sources and unknowns. Grandma's saved run has no established named offering; Theobroma's has Blueberry Cheesecake Jar. Show how source records differ from unique URLs and how AI summaries differ from original excerpts.
4. In Opportunities, inspect the rationale, missing evidence and proposed test, then choose a direction. These examples support one hypothesis each; neither validates a local market gap.
5. In Creative studio, inspect the selected offering or story, source links, proposed palette and four-scene Reel plan. Compare Instagram feed/carousel, Facebook, Stories, Reel, click-to-WhatsApp and Status. Each campaign uses one shared visual; the current saved examples label it as an AI illustration.
6. Play the actual vertical MP4. In Launch kit, download the ZIP and open `brand-product-dossier.json`, captions, suggested WhatsApp scripts, evidence/review reports and the checksum manifest. Downloads do not approve or publish the campaign.

A product-illustration URL-only run with SAM uses up to **six Meta requests**; story illustration normally needs five. Discovery allows up to five native retrieval actions and enrichment up to ten; those actions are not separate top-level inference requests. An accessible matching source image can avoid image generation. New live investigations incur actual provider usage.

## Current saved real-business examples

Open `/?run=<run-id>` in the running local app to restore stored outputs without new model calls. The UI labels this **Saved run**. These IDs depend on the current SQLite database and local files; they are not portable public links.

| Business | Saved run ID | Focus | Channels / files |
| --- | --- | --- | --- |
| Tiger Lily Coffee & Bistro | `c146c1d1-166b-45ad-902f-f2f7e1af7144` | Truffle Parmesan Fries; proposed Diwali theme, unresolved branch; Muse illustration with crop fallback | 7 / 22 |
| Grandma Daphne's Bakehouse | `f250e94c-09e3-4f54-b78f-8bfa539c6064` | Attributed family-recipes story; **zero named offerings** | 7 / 22 |
| Theobroma Patisserie | `c0f52338-da16-45c1-ab59-7d364ec2a4b0` | Blueberry Cheesecake Jar, linked to the official homepage | 7 / 22 |
| Theobroma — latest production run | `c5264ec3-3d72-4d1b-9628-c313c227f337` | Mava Cake selected from six discovered offerings; original homepage text also retained | 7 / 22 |

All four started with empty name/locality and zero supplied sources. Grandma's three retained records reference one Instagram profile and report British roots/family recipes. Theobroma's eight records reference its homepage/founder page. These are explicitly labelled model-linked summaries, not original quotations or independently verified facts. Exact locality remains unresolved.

The first two runs passed HTTP byte/hash checks for every downloadable asset. Each records five Meta requests: Grandma 50,983 reported input/output tokens and 50.588 seconds combined provider latency; Theobroma 59,717 tokens and 69.247 seconds. These timings exclude rendering/polling and are not cost estimates.

**Both required recovery after deterministic copy-validator fixes.** Actual completed paid copy was revalidated after correcting editorial-number handling and production-note placement. Research and copy were reused without another paid request; an unused reservation was conservatively retained. Do not present these as fresh first-pass successes. The latest Mava Cake run also completed after its actual saved response was recovered following a production-note cleanup fix; no research or copy request was repeated. It is not an uninterrupted first-pass success. Its 16 source records include original official HTML, alongside Meta-linked product descriptions. All 22 downloads passed byte/hash checks; the 12-second Reel and 21-entry ZIP passed independent encoding/CRC checks. See the grounding report for the 76,313-token usage and recovered timing caveat.

Production browser verification passed for the latest Mava Cake run: desktop/mobile restoration, six offerings, original website text, source/brief panels, illustration labels, real Reel playback and ZIP download. There were zero POSTs, page errors, failed requests or horizontal overflow. The report is `.data/ui-check/final-product-browser-report.json`.

Theobroma's official HTML exposed an exact image reference labelled Blueberry Cheesecake Jar. CDN robots returned HTTP 500, so the product photo was not downloaded; the kit uses a labelled Muse Image illustration. Grandma's symbolic illustration does not assert a product appearance. None of these kits contains authenticated original product photography, and proposed palettes are not verified brand guidelines.

## Tiger Lily and SAM composition

Tiger Lily’s saved run includes five named offerings, eleven source records and one customer signal. Research is generic rather than category-gated. The exact branch and current Diwali promotion remain unverified. Its original paid copy was recovered after deterministic validator fixes; research and copy were not requested again. Muse generated the illustration, but SAM failed without a retained raw response, so the stored kit uses an honest crop fallback. Do not describe it as a successfully segmented campaign.

All 22 downloads passed byte/hash checks. The Reel is 1080×1920 H.264, 30fps, 360 frames and 12 seconds; the 21-entry ZIP passes CRC checks. Read-only desktop/mobile verification passed with zero errors, failed requests, POSTs or overflow. The UI exposes the exact branch uncertainty, proposed theme and actual segmentation state.

A separate real SAM probe on the saved Theobroma illustration produced a usable jar mask. On November 4, that exact saved response passed the full production layer/render path offline: twelve visual assets, four distinct compositions, a 12-second Reel and source RGB/alpha preservation within the mask. It made zero network calls and did not alter the original run. The [media guide](MEDIA_PIPELINE.md) distinguishes this diagnostic from a fresh live campaign.

## Historical execution checks

Earlier real-bakery run `f53fed70-b890-4650-9a6d-1834c8519d5f` completed the prior discovery → analysis → typography-concept path: three Meta requests, seven channels and twenty files. Desktop/mobile restore, MP4 playback and ZIP download checks passed for that version. Those browser results do not establish the newer product/illustration interface. Initial failed discovery run `e7e80726-573c-4b22-908c-84b9aa614a8d` remains saved; its precise upstream rejection was not established because raw diagnostics were not yet retained.

| Fictional case | Historical saved run ID | Channels / files |
| --- | --- | --- |
| Bakery | `8275671b-5006-48cd-80b2-80c01efb7d6a` | 7 / 20 |
| Dentist | `f09f1085-7a7f-4175-8ca4-5a27cf00ea1a` | 7 / 20 |
| Gym | `cd201dcf-0028-4bd3-b67e-d062737ce814` | 7 / 20 |
| Salon | `7a6b0186-e435-45b7-a93c-7730c237e61c` | 7 / 20 |

Each fictional case used three supplied fictional sources and two Meta requests. Their original HTTP/hash, ZIP CRC and 12-second H.264 Reel checks passed. They test four-category execution, not the planned four-real-business benchmark. They predate enrichment and the shared image path; retain their visible fictional labels and review status.

## Verification commands

```bash
npm run check
npm run build
npm run smoke

# With app + worker running; these explicitly incur up to six paid Meta requests:
npm run link:smoke -- --live-meta --report=brand-link-verification
npm run link:smoke -- --live-meta --url=https://theobroma.in --expect-offering --expect-visual --report=product-link-verification
```

Use a new `--report` name to preserve existing verification evidence. Ordinary automated tests do not perform live generation. The [link verifier](../scripts/link-smoke.ts) checks blank intake, retrieved provenance, enrichment, seven-channel inventory and every file's HTTP bytes/hash. Runtime reports, upstream responses, media-access diagnostics and recovery records stay under ignored `.data/`; do not commit them or expose credentials.

## Pitch boundaries

- Demonstrate “a link to a sourced offering/story and coordinated concept kit.” Do not promise comprehensive research, a validated market gap or higher conversions.
- Show generated-visual provenance and unresolved facts. Official-page access now works through a validated public-IP/TLS connection, but source access restrictions can still prevent photos from being acquired.
- Every kit remains `concept_needs_review`. Contextual critique, final copy/visual fidelity review, exact-version owner approval and authorized photography workflows remain unfinished. Deterministic checks do not establish semantic truth or publication readiness.
- WhatsApp output is suggested conversation copy and creative, not a deployed agent or approved Cloud API template. No social publishing, paid ads or outbound messages were activated.
- The historical fictional runs and these real-business cases are not four real-business benchmarks, blind human evaluation or measured owner/conversion outcomes.
