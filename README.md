# Tickr

**Turn a business link into a researched campaign and a playable Reel.**

Tickr helps local businesses that cannot afford a photographer, videographer or ad agency start with a useful campaign concept. Paste a website, Maps reference or social profile; the engine investigates the business, proposes a supported direction, and produces coordinated Instagram, Facebook and WhatsApp creative.

Built for the Meta Global AI Hackathon. All runtime AI uses Meta-hosted APIs.

## Autopilot: one link, one goal, a finished campaign

The default experience is **Autopilot**. Paste a Google Maps listing or website link and pick a goal. Optionally drop in phone photos and videos, or connect Instagram/Facebook with Meta login.

Tickr then works without further input until there is a review-ready kit:

1. It researches the business and chooses the best-supported campaign.
2. Muse Spark studies **every** photo and clip against the goal.
3. SAM 3.1 cuts out the real products, using Spark's grounded boxes as prompts, and **tracks them through the owner's footage**.
4. It renders a cinematic Reel from real pixels, plus a multi-photo carousel and every channel asset.
5. Spark watches and critiques the result, and fixes that need no new copy are applied.

The owner then approves once; the approval is bound to the exact file hashes. Nothing is published. See [Autopilot](docs/AUTOPILOT.md) for the pipeline, safety rules and verification status.

## What it does

1. **Discover** the business, its category and the likely shop location from one link.
2. **Investigate** products, brand story, customer signals, competitors and seasonal context, with sources and gaps visible.
3. **Choose a direction** grounded in an actual offering or attributed story.
4. **Create** feed images, a carousel, Stories, Facebook ads, click-to-WhatsApp creative, Status artwork and a four-scene Reel.
5. **Export** PNGs, a 12-second MP4, captions, suggested replies, evidence and a checksummed ZIP.

Business categories are free-form. The engine distinguishes a confirmed branch from a likely or unresolved match, and a proposed seasonal idea from an established promotion.

## Meta-powered media

| Component | Role |
| --- | --- |
| Muse Spark | Native web research, evidence analysis and campaign copy |
| Muse Image | Illustrations and empty campaign backdrops |
| SAM 3.1 | Subject masks for composition while retaining source-image pixels |
| Sharp + FFmpeg | Local layouts, typography, motion and video encoding |

A product illustration can use a SAM cutout over a campaign palette. An acquired source photo can use a SAM cutout over a generated backdrop. Story imagery and failed selections use composed crops. Generated imagery stays labelled as illustrative.

Research uses bounded Meta-native retrieval and a restricted public official-site reader. Maps links supply routing hints; Tickr does not call Google Places or scrape Maps pages. No additional model provider, external search service or video-generation API is used.

![Four compositions using a Meta illustration and its SAM subject mask](docs/assets/sam-composition-example.png)

*Local rendering diagnostic using a saved, genuine SAM response and a Muse illustration. These are example layouts, not authenticated product photography or an approved brand campaign.*

## Run locally

Requires **Linux, Node.js 24, npm 11.9, FFmpeg, Chromium and `setsid`**. Package-registry and Prisma binary access are needed during setup.

```bash
git clone https://github.com/vn-envy/Tickr.git
cd Tickr
bash scripts/setup.sh
npm run build
TICKR_SERVER_MODE=production bash scripts/start.sh
```

The app runs on port **3000**. The start script manages both the app and the background worker. Use `bash scripts/start.sh` without the production flag for development.

For live generation, supply **`META_API_KEY` through the process environment** before starting both processes. In Codex, use environment settings. Never put credentials in source files. See [.env.example](.env.example) for optional configuration. The shell, tests and media diagnostics work without a key.

Setup installs pinned dependencies and applies migrations without resetting existing data. SQLite, generated media and private responses live under ignored `.data/`; they are not included in a clone. The current app is a private development instance and has no multi-user authentication.

## Demo and verification

Real link-only runs have produced reviewable kits for **Grandma Daphne’s Bakehouse**, **Theobroma** and **Tiger Lily Coffee & Bistro**. The Tiger Lily example found five named offerings and produced seven channel versions, 22 downloadable files and a playable Reel. Its exact branch remains unresolved, and Diwali is a proposed theme.

Muse Image and SAM have passed separate live capability checks. Tiger Lily’s original SAM attempt failed, so that saved kit honestly uses the crop fallback. SAM failures are not proof of a working cutout; [media verification](docs/MEDIA_PIPELINE.md) records the tested paths and remaining limits.

```bash
npm run check         # ESLint, TypeScript and unit tests
npm run media:check   # Local four-scene rendering diagnostic
npm run smoke        # Persistence/API check; app + worker must be running
npm run meta:check   # Read-only model listing; requires META_API_KEY
```

To create a new campaign with actual provider usage:

```bash
npm run link:smoke -- --live-meta --url=https://theobroma.in --report=my-demo
```

A link-only run reserves at most **six Meta requests**: four text requests and up to two visual requests. Research tool actions are separately bounded. Completed responses and hashed artifacts support local recovery; uncertain requests are not automatically repeated. Ordinary tests make no paid model calls.

See the [demo guide](docs/DEMO.md) for saved examples and [verification report](docs/SETUP_VERIFICATION.md) for executed checks.

## Current scope

Outputs are **campaign concepts requiring review**, not approved advertisements. Source-linked AI summaries are distinguished from original excerpts. Public evidence may be incomplete; the engine does not claim comprehensive review coverage, a validated competitive gap or measured conversion uplift.

Contextual final critique, exact-version owner approval, authorized uploads and connected social accounts remain open. WhatsApp output is creative and suggested conversation copy. Publishing, messaging automation and ad spending are not connected.

## Project map

- `app/`, `components/` — five-stage workspace and local APIs
- `lib/research/`, `lib/network/` — research, evidence and restricted source access
- `lib/meta/`, `lib/media/` — Meta adapters and source-image acquisition
- `lib/campaign/` — copy, visual composition, Reel and archive generation
- `lib/jobs/`, `prisma/` — durable worker, checkpoints and SQLite
- `tests/`, `scripts/` — tests, setup and reproducible verification

Read the [architecture](docs/ARCHITECTURE.md), [generic research design](docs/GENERIC_RESEARCH.md), [media pipeline](docs/MEDIA_PIPELINE.md) and [build plan](BUILD_PLAN.md).

Tickr uses Meta SAM Materials through the pinned, unmodified `@meta-sam/parser` package under the [Meta SAM License](docs/licenses/meta-sam-LICENSE.txt). Hosted SAM performs inference; the local parser decodes its masks. Remotion is used for a separate rendering diagnostic; the campaign renderer uses Sharp and FFmpeg.
