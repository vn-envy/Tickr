# Product and brand grounding — 2 November 2026

Tickr carries a discovered offering or attributed brand story through research, a structured creative brief, one shared campaign visual, seven channel concepts and a downloadable kit. The completed real-business checks below began with a link and goal, empty name/locality and no supplied source text. They establish a working concept-production path, not a validated local market gap or publication approval.

## Implemented path

| Stage | Behavior and implementation |
| --- | --- |
| Identity | [Discovery](../lib/research/discover.ts) makes one Meta request with at most three native search/open actions. [Maps routing](../lib/research/reference.ts) obtains a name hint from a fixed-host redirect without reading Maps content. Name matching preserves distinctive brand words and trims supported SEO suffixes. |
| Offerings and brand | [Enrichment](../lib/research/enrich.ts) makes one Meta request with at most five native actions, targeting actual menu/product pages, posts and published features. Named offerings and story/positioning/tone signals retain source IDs; unavailable products remain unknown. |
| Evidence and selection | [Analysis](../lib/research/analyze.ts) distinguishes business, customer and competitor evidence. [Copy validation](../lib/campaign/copy.ts) binds the selected offering/story, narrative and four-scene plan to the retained dossier and evidence. A proposed palette is not a verified brand guide. |
| Visual | [Visual preparation](../lib/campaign/visual.ts) prefers an acquired image whose page label literally matches the selected offering. Otherwise one Meta image request creates an explicitly labelled illustration; a story-only concept uses symbolic imagery. One visual is reused across that campaign's channel assets. |
| Rendering and export | [Still rendering](../lib/campaign/render.ts), [Reel rendering](../lib/campaign/reel.ts) and [kit assembly](../lib/campaign/index.ts) produce local PNGs, a four-scene MP4, source image, copy/scripts, `brand-product-dossier.json`, evidence/review reports, manifest and ZIP. |
| Durability and budget | The [worker](../lib/jobs/worker.ts) checkpoints discovery, enrichment, analysis and production. A normal illustrated URL-only run uses five Meta requests: discovery, enrichment, analysis, copy and image. The [store](../lib/jobs/store.ts) caps reservations at six; a reservation is not proof of a completed API request. |

Inference uses Meta-hosted Spark 1.3 and Muse Image 1.0. No additional model or external search/service API is involved. Permitted official-site HTTP reads use the separate bounded source tool.

## Verified real-business outputs

| Check | Grandma Daphne's Bakehouse | Theobroma Patisserie |
| --- | --- | --- |
| Saved run | `f250e94c-09e3-4f54-b78f-8bfa539c6064` | `c0f52338-da16-45c1-ab59-7d364ec2a4b0` |
| Input | [Supplied Maps link](https://maps.app.goo.gl/nNy6iYx9r4GaU7YY8) | [Official homepage](https://theobroma.in/) |
| Named offerings | **0**; enrichment remained `limited` | **1**: Blueberry Cheesecake Jar |
| Campaign focus | Reported “treasured family recipes” story | The discovered Blueberry Cheesecake Jar |
| Brand material | One self-described British-roots/family-recipes story | Two signals: traditional home-style recipes and stated quality/tone pillars |
| Sources retained | Three records from one Instagram profile URL | Eight records from homepage/founder-page URLs |
| Evidence / opportunities | 3 / 1 | 6 / 1 |
| Output | 7 channels, 22 downloadable files | 7 channels, 22 downloadable files |
| Visual | Symbolic Meta illustration | Offering-informed Meta illustration; actual appearance unverified |
| Recorded API usage | 5 requests; 50,983 input + output tokens | 5 requests; 59,717 input + output tokens |
| Summed provider latency | 50.588 seconds | 69.247 seconds |

Both runs passed the [HTTP smoke verifier](../scripts/link-smoke.ts): each downloaded file matched its recorded byte count and SHA-256. The saved reports are `.data/brand-link-smoke.json` (08:12:43 UTC) and `.data/product-link-smoke.json` (08:20:21 UTC). Latencies exclude local rendering, queueing and polling; they are single observations, not service guarantees or dollar-cost estimates.

**These are recovered completions, not fresh first-pass successes.** Both initially stopped on deterministic copy validation. After fixing editorial-number recognition and separating production notes from consumer copy, the actual completed paid responses were revalidated and recovered. Research and copy were not requested again. Recovery records preserve response IDs/hashes under each run's `copy-recovery.json`; an unused reservation remained conservatively counted. Reported five-request usage must not be confused with that reservation counter.

### Latest product run: Mava Cake

Run `c5264ec3-3d72-4d1b-9628-c313c227f337` completed through the production server/worker. Starting from `https://theobroma.in` alone plus the storytelling goal, it discovered **six named offerings**: Overload Brownie, Eggless Millionaire Brownie, Dutch Truffle Cake, Mava Cake, Eggless Dense Loaf and Chocoholic Cake. Sixteen source records include an original 9,100-character official homepage extraction; named-offering descriptions are separately labelled Meta-linked summaries from the official ordering site. A retrieved branch-specific menu does not establish the owner's target locality or chain-wide availability.

The selected **Mava Cake** direction uses its reported classic Parsi recipe/signature tea-cake description and traditional home-style positioning. It produced seven channel concepts, 22 downloadable files, a shared labelled Muse Image illustration and a 12-second 1080×1920/30fps H.264 Reel. Every HTTP asset passed byte/hash verification; the 21-entry ZIP passed independent CRC checks (21,966,951 bytes). The report is `.data/product-final-smoke.json`.

This run also required recovery: a standalone production-only sentence leaked into the Reel caption and triggered validation. A finite-vocabulary cleanup now moves such standalone notes into review notes while preserving source qualifications and factual clauses. The actual completed response was revalidated and checkpointed, then one initial image request and local rendering finished without repeating discovery, enrichment, analysis or copy. It is **not an uninterrupted first-pass success**. Five actual requests used 76,313 reported tokens. Summed recorded duration was 67.872 seconds, but the recovered copy's 10.073 seconds is stage-to-response wall time including local overhead, not exact provider latency. Recovery records preserve that distinction.

The final code check passed 126 tests, lint and TypeScript; production build and API/persistence smoke passed. The Remotion diagnostic and independently probed exported MP4 are separate checks. All three completed campaigns passed desktop/mobile restoration, source/brief inspection, illustration provenance, video playback and ZIP download with zero POSTs or browser errors. The latest production browser report is `.data/ui-check/final-product-browser-report.json`; it also verifies six offerings, three brand signals, original website text and cleaned media-access explanations.

## Original media: reachable page, blocked product image

The official Theobroma HTML was reachable through the [pinned HTTPS transport](../lib/network/pinned-https.ts). Its actual image element labelled **Blueberry Cheesecake Jar** referenced:

`https://cdn.uengage.io/uploads/7175/crops/160/image-449316-1693683251.jpeg.webp`

The [extractor](../lib/media/extract.ts) prioritized that literal product match. The narrow [CDN policy](../lib/media/policy.ts) permits only `/uploads/` or `/brand_logo/` URLs on that host when the exact image reference was extracted from the official page. The [reader](../lib/media/reader.ts) checks CDN robots separately; the live robots response was HTTP 500, so original product-image acquisition was blocked. None of these completed campaigns contains an acquired original product photograph.

[Acquisition](../lib/media/acquire.ts) retains public-IP/TLS validation, redirect and byte limits, raster decoding/re-encoding and explicit unknown reuse rights. Accessible page metadata is not a photo licence or proof of product identity. The fallback illustration is labelled as generated; it does not silently stand in as authenticated product photography. No Instagram page scraping or invented Grandma Daphne product was used.

## Evidence limits and remaining work

The retained Meta findings in these runs are `model_reference` summaries linked to actual completed retrieval URLs. They are not original source excerpts, provider-annotated quotations, independent corroboration or owner-approved facts. Multiple records from one page do not create multiple independent sources. Exact target locality remains unresolved. The latest Mava Cake run additionally retains an original official-page extraction, explicitly distinguished from generated summaries.

Customer/competitor coverage does not establish a local demand gap, competitive superiority or conversion uplift. Current validation checks structure, evidence references, media encoding and file integrity; it does not provide a complete semantic or visual-fidelity verdict. Contextual final critique, exact-version owner approval, revision workflows, authorized owner/connected-account media and real-business outcome evaluation remain open. Every current export is `concept_needs_review`; no posting, ad activation or working WhatsApp automation is claimed.

See [DEMO.md](DEMO.md) for the walkthrough and historical fictional checks. Focused regression coverage lives in [discovery tests](../tests/unit/discovery.test.ts), [enrichment tests](../tests/unit/enrichment.test.ts), [official-media tests](../tests/unit/official-media.test.ts), [transport tests](../tests/unit/pinned-https.test.ts) and [campaign-visual tests](../tests/unit/campaign-visual.test.ts). Mocked checks and recovered live runs are distinct forms of evidence.
