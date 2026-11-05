# Judge guide

Tickr Autopilot turns one link and one goal into a reviewed campaign kit with one owner approval. This page lists what to look at, where each Meta capability lives in the code, and how to check it without a key.

## What to look at

Open the live app at https://vn-envy--tickr.us-east.modal.run. It needs an access code, which the team can provide on request. Paste a business website, a Google Maps link or a `share.google` link, and pick a goal.

1. **Live run flow.** After you start, the screen moves through phases on its own. You don't need to enter anything else.
2. **Director's room.** The phase rail, the director's log and the media wall. The wall shows every harvested photo with Spark's verdict and grounded box. Hover or focus a tile to see its reasons. Excluded photos show why, for example a person without consent, a logo or signage.
3. **SAM 3.1 selections panel.** Each SAM cutout, taken from Spark's box (or from a concept prompt when there is no usable box). Use the "How SAM saw it" switch to see the mask overlay.
4. **The idea Autopilot chose and the production plan.** The campaign direction with its score, and the chosen Reel mode: tracked Reel or depth Reel.
5. **Reel.** A phone-frame player. Every frame carries a concept label and a provenance label. The product is always real source pixels.
6. **Channel kit.** The Instagram feed, carousel, Stories and Reel, the Facebook ad, click-to-WhatsApp and WhatsApp Status.
7. **Critic.** Spark's findings on the stills and the Reel, drawn on the assets. Files the critic withheld are listed separately.
8. **Approval.** One statement to approve. The server re-hashes every file before it records the approval. Nothing is published.

## Where each Meta capability lives

| Capability | Code |
| --- | --- |
| Discovery and research (Muse Spark native search with citations) | `lib/research/discover.ts`, `lib/research/enrich.ts`, `lib/research/analyze.ts` |
| Link resolution (Maps and `share.google`, redirect headers only) | `lib/research/reference.ts` |
| Image analysis with grounded boxes (Muse Spark, up to 24 images per request) | `lib/meta/media-analysis.ts` |
| Box prompts and concept prompts (SAM 3.1) | `lib/meta/segmentation.ts`, `lib/meta/sam-prompts.ts`, `lib/media/object-layers.ts` |
| Video tracking (SAM 3.1) | `lib/meta/sam-video.ts`, `lib/media/masklets.ts` |
| Shot logs for owner clips (Muse Spark video understanding) | `lib/meta/video-understanding.ts` |
| Labelled backdrops and illustrations (Muse Image) | `lib/meta/image.ts`, `lib/campaign/visual.ts` |
| Self-critique of stills and Reel (Muse Spark) | `lib/agents/critic.ts`, `lib/agents/critic-fixes.ts` |
| Reel rendering (local Sharp and FFmpeg, no model) | `lib/campaign/cinema/` (`tracked.ts`, `still-depth.ts`, `overlay.ts`, `mask-refine.ts`, `ledger.ts`) |
| Pipeline, budget and director | `lib/autopilot/` (`pipeline.ts`, `budget.ts`, `director.ts`, `harvest.ts`, `produce.ts`, `critique.ts`) |
| Hash-bound approval | `lib/jobs/approval.ts`, `app/api/runs/[id]/approve/route.ts` |
| UI | `components/autopilot/` (`directors-room.tsx`, `autopilot-ready.tsx`) |

## How to verify offline

No key and no paid calls are needed for these.

```bash
npm ci
npm run db:setup
npm run check                      # ESLint, TypeScript and the test suite (951 tests passed on 6c0aaec)
npm run autopilot:check -- --dry   # the full capability probe with fake Meta clients
npm run media:check                # local renderer contracts, including the depth Reel
```

The live probe, `npm run autopilot:check`, needs `META_API_KEY`. It writes a report to `.data/autopilot-live-check/<time>/report.json`. The script is `scripts/autopilot-live-check.ts`.

## Recorded results

- **4 Nov 2026, live probe on synthetic media:** 7 of 7 steps passed. SAM 3.1 box prompt confidence was 0.988, and concept prompt confidence 0.922. Video tracking held the subject in 120 of 120 frames. The list-price estimate was about USD 0.06 (an estimate, not an invoice).
- **5 Nov 2026, hosted run on Grandma Daphne's Bakehouse (Hyderabad):** website link with a story goal. It completed in 3 min 40 s. Spark analysed 12 official-site photos and excluded 3 with reasons. SAM 3.1 produced 3 cutouts, and Tickr rendered a still-depth Reel. The critic raised 10 findings, none blocking.

Details are in [AUTOPILOT.md](AUTOPILOT.md) and [SETUP_VERIFICATION.md](SETUP_VERIFICATION.md).

## Known limitations

- **Maps discovery.** Maps-link discovery depends on Meta search returning usable sources. In 3 of the last 5 Maps attempts it did not, and Tickr stopped and asked for a better link. A website link is the most reliable input today.
- **Website fallback (in progress).** A fallback that reads the owner's own website to find the business is being built.
- **Cutout edges (in progress).** The critic flagged ragged edges on a hero cutout in the 5 Nov run. A SAM mask-quality gate is being built.
- **Blocked image hosts.** Some sites block image downloads. Theobroma's image CDN does, so its kit used a labelled illustration.
- **Graph connector.** The optional Instagram/Facebook connection is implemented but not yet verified live.
- **Not yet live-tested.** SAM 3.1 has not been tested live on long or crowded real footage.
- **No outcome data.** Outputs are campaign concepts for the owner to review. Tickr makes no claim about conversion results.
