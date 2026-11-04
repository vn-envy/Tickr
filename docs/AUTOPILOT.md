# Tickr Autopilot

Updated 4 November 2026 (IST). **Autopilot** is the one-shot product flow. The owner shares a Google Maps listing or website link and a campaign goal, and Tickr works autonomously until there is a **review-ready** campaign kit with reel-worthy content. The owner then gives **one** approval, bound to the exact file hashes. Nothing is published, no ad budget is spent and no message is sent.

Live verification status (4 November 2026): `npm run autopilot:check` passed all 7 steps against the live Meta API on synthetic media. It made 6 paid requests: 3 Muse Spark and 3 SAM 3.1. The full end-to-end Autopilot path through the app and worker is verified offline (614 tests, production build, browser flow). A live end-to-end run on real businesses is the next recorded check; see [setup verification](SETUP_VERIFICATION.md).

## The owner's experience

1. **One screen.** The owner pastes the link and picks a goal ("Tell our story", "Launch something new", "Fill quiet hours", "Promote an event", "Win new regulars", or their own words). Two things are optional:
   - **Drop in photos and videos.** Two consent confirmations are required first: the owner has the rights, and anyone shown has agreed (or no one is shown).
   - **Connect Instagram/Facebook** with Meta login. This needs an attestation covering the media on those accounts.
2. **Run Autopilot.** A "director's room" shows the work live: the phase rail, a log, every harvested photo with Spark's verdicts, SAM mask previews, and the production plan.
3. **Review.** The finished kit shows:
   - a phone-frame Reel player, with a toggle to the "How SAM saw it" tracking overlay;
   - the carousel and channel previews;
   - the critic's findings drawn on the assets, plus any withheld files;
   - the director's report.
4. **Approve once.** The owner ticks the approval statement, and the server re-hashes every file before recording the approval.

The step-by-step studio (the earlier manual flow) is still available behind "Advanced".

## What the engine does

| Step | Implementation | Meta capability | Paid requests |
| --- | --- | --- | --- |
| Discover and enrich | `lib/research/discover.ts`, `enrich.ts` | Muse Spark native search | 2 |
| Analyse and auto-select | `lib/research/analyze.ts`, `lib/autopilot/select.ts` | Muse Spark (strict JSON) | 1 |
| Harvest media | `lib/autopilot/harvest.ts`, `lib/media/{library,uploads,gallery,meta-cdn}.ts`, `lib/meta/graph.ts` | Graph API, owner-authorized (optional) | 0 inference |
| Campaign copy | `lib/campaign/index.ts` `ensureCampaignCopy` | Muse Spark | 1 |
| Analyse every image | `lib/meta/media-analysis.ts` | Spark vision with **grounded boxes**, up to 24 images per request | ≤ 3 |
| Shot logs for clips | `lib/meta/video-understanding.ts` | Spark video understanding (inline MP4) | ≤ 2 |
| Direct | `lib/autopilot/director.ts` | none (deterministic) | 0 |
| Cut out the real products | `lib/meta/segmentation.ts` + `sam-prompts.ts`, `lib/media/object-layers.ts` | **SAM 3.1 box prompts** taken from Spark's boxes; concept prompts as fallback | ≤ 8 |
| Track the product through footage | `lib/meta/sam-video.ts`, `lib/media/masklets.ts`, `lib/media/clip.ts` | **SAM 3.1 video tracking** | ≤ 2 |
| Cinema Reel | `lib/campaign/cinema/{tracked,still-depth,overlay}.ts` | none (local FFmpeg and Sharp) | 0 |
| Channel kit | `lib/campaign/render.ts` (one image per channel, multi-photo carousel) | none | 0 |
| Fallback illustration | `lib/campaign/visual.ts` | Muse Image | ≤ 2 |
| Self-critique | `lib/agents/critic.ts`, `critic-fixes.ts` | Spark vision **and video** (watches the Reel) | ≤ 2 |

Budget and recovery:

- **Caps.** Per-role caps live in `lib/autopilot/budget.ts`. On top of them, an Autopilot run has a ceiling of 28 requests, compared with 6 for a manual run.
- **Order of operations.** Every paid step reserves budget and writes an input-bound "requested" marker before calling. It stores the raw response before decoding it, and it is never retried automatically.
- **Retries.** A retry reuses stored responses, so a crash never pays twice for a completed step. A step whose outcome is uncertain fails closed.

## Why SAM 3.1 is central

- **Spark points, SAM cuts.** Spark returns a box on its 0–1000 grid around the photo's main subject. Tickr converts that box into a SAM 3.1 box prompt, so SAM selects that specific object rather than guessing from a product name. Each object is kept as its own layer with its own mask.
- **Real pixels only.** Cutouts keep the decoded source RGB and only change alpha. In the Reels and stills, the subject is always source pixels multiplied by the mask. Every Reel's composition ledger asserts `generatedPixelsOnSubject: 0`. Muse Image is used only for labelled empty backdrops or a labelled illustration when no real media qualifies.
- **Tracked cinema.** When the owner's footage has a steady product moment, SAM 3.1 tracks the product through the clip. The Reel then:
  - pops the real product out of a treated background;
  - sets the headline *behind* the moving subject;
  - pins a callout to its smoothed track;
  - reframes horizontal footage to 9:16 by following the subject;
  - ends on an honest end card.

  The "How SAM saw it" overlay video is a labelled analysis preview, never campaign creative.
- **Depth Reel from a photo.** Without usable footage, the hero photo's SAM layers drive a depth Reel:
  - the background is filled behind the subject, so a moving subject leaves no ghost;
  - the headline sits behind the subject, with a push-in and parallax;
  - transitions use a wipe shaped like the subject's silhouette.

## Safety rules the engine enforces

- **Google listings.** The Maps link provides only an identity hint. Maps pages and Places are never read (AGENTS.md).
- **Website media.** Only images referenced by the official site are used, through the SSRF-safe pinned reader. Images on exact Squarespace, Wix and Shopify CDN origins are allowed. Rights stay "unknown – review".
- **Owner media.** Owner uploads and connected-account media require consent attestations. Tokens are encrypted at rest with `TICKR_SECRET_KEY`, never logged and never sent to a CDN.
- **Exclusions.** The director always excludes possible minors, people without a recorded consent, third-party logos or signage, and visible price or offer text when no offer is approved.
- **Withholding.** The critic's deterministic fixes withhold assets rather than invent copy. Withheld files are excluded from the approval digest. The concept ZIP is withheld when it contains a withheld file.
- **Labels.** Every frame and still carries a concept label and a provenance label, such as OWNER PHOTO · SAM CUTOUT, WEBSITE IMAGE, AI BACKDROP or ILLUSTRATIVE IMAGE.

## Configuration

`META_API_KEY` is required for live runs. The owner Meta connection is optional and is enabled only when all of `META_APP_ID`, `META_APP_SECRET`, `META_OAUTH_REDIRECT_URI` and `TICKR_SECRET_KEY` are set. See [.env.example](../.env.example). Put values in the environment, never in files or chat.

## Verification

```bash
npm run check                 # lint, typecheck and offline tests
npm run media:check           # local renderer contracts, including the depth Reel
npm run autopilot:check -- --dry   # the whole capability probe with fake Meta clients
npm run autopilot:check       # LIVE: every Autopilot Meta operation on synthetic media (needs META_API_KEY)
```

`autopilot:check` writes `.data/autopilot-live-check/<time>/report.json` with each step's model, timing, response ID, usage and a fixed diagnostic code. It also prints a clearly labelled list-price estimate. It never records keys, prompts containing owner data, or raw provider bodies.

### Live capability results (4 November 2026, synthetic media)

| Step | Result |
| --- | --- |
| Spark media analysis (2 images) | 6.0 s. Grounded boxes and labels for both subjects ("white coffee cup", "orange preserve jar") |
| SAM 3.1 box prompt from Spark's box | 1.0 s. One object, confidence 0.988 |
| SAM 3.1 concept prompt | 1.0 s. One object, confidence 0.922; bounds within about 6 px of the drawn subject |
| Spark shot log (inline 4 s MP4) | 3.4 s. One moment, correct subject, no people or speech |
| SAM 3.1 video tracking (concept) | 5.6 s. Subject tracked in 120 of 120 frames, mean confidence 0.94; usage reported as `video_frames_processed` |
| Local depth Reel, tracked Reel and overlay | Contracts met; zero generated pixels on the subject |
| Spark critic (still + inline Reel) | 15.7 s. Grounded findings with timestamps |

The list-price estimate for the whole probe was about USD 0.06; this is an estimate, not an invoice. The run also surfaced visual issues, which are now fixed:

- jagged edges on an upscaled mask;
- specks in the cutout;
- the moving subject hiding the hook headline;
- a low-contrast subtitle;
- a wrong end-card label.

### Still live-unverified

- How accurate Spark's boxes are on real busy product photos, as opposed to synthetic ones.
- SAM 3.1 behaviour on long or crowded real footage and on video frames with no objects.
- The Graph API's acceptance of the form-POST code exchange and token upgrade, and the real CDN hostnames.
- Inline payload limits for long Reels sent to the critic.
