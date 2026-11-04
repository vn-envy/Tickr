# Tickr — hackathon build plan

Prepared 29 October 2026; revised 30 October for a Meta-hosted-only runtime and a visual-first demonstration. All project dates and times below use IST (Asia/Kolkata).

Status: implementation plan, not a record of completed work. The repository contains planning material only; GitHub read access, Node.js 24 and Python 3.12 were checked during onboarding. No application, model inference, API integration, rendered campaign or evaluation has been implemented or validated yet.

## 1. The product we are building

**Tickr turns ordinary business photos into a coordinated campaign the owner can use today, guided by a credible customer need and an offer the business can deliver.**

The primary customer has a phone and limited time or budget for photography, video editing or an agency. The visible product is a small creative studio: real business imagery, a considered visual direction, coordinated campaign assets and a finished short video. Research explains what to promote and why; it must materially influence the creative.

The owner journey:

> Add a few phone photos and a goal → confirm the selling point and offer → choose a visual direction → see the original-to-campaign transformation → play the reel → edit once and export all formats.

When relevant evidence is available, the engine connects five things:

1. An attributable customer problem or preference.
2. How a bounded sample of comparable local businesses addresses it.
3. A capability this business actually has.
4. An offer or message that connects that capability to the need.
5. A customer action that could test the hypothesis.

Repeated complaints support a research hypothesis. A contact click measures interest. A qualified inquiry provides stronger evidence of intent. A fulfilled booking or purchase demonstrates a business outcome. Keep these outcomes separate throughout the product and demo.

**Hackathon endpoint:** an evidence-backed visual campaign and a playable MP4 that an owner can understand and use. If competitive evidence is unavailable, produce a business-grounded campaign and clearly mark the market-gap hypothesis unvalidated. Bookings, revenue uplift and autonomous growth are not claims we can make without observing those outcomes.

### Non-negotiable runtime boundary

All external runtime API/model calls must go to **Meta-hosted, account-verified endpoints**. No third-party inference, third-party hosting of Meta weights, local model inference, Google Places, Treg API, scraping/search services, hosted image/video utilities or external model fallback.

Use a strict default: no direct website crawling either. Business URLs are references until verified Meta-native retrieval supplies attributable content; otherwise use owner uploads, pasted descriptions, menu images, review exports and supplied competitor evidence. Do not pretend a model has read a URL that it has not retrieved.

Local deterministic computation is allowed: file parsing, image compositing, typography, layouts, motion, MP4 encoding, storage and export. These are rendering operations, not additional AI models. Playwright renders our own templates with external requests disabled. Bundle fonts, scripts, icons and demo assets locally; no external analytics, image hotlinks, automatic link previews or destination-validation requests. A local image library must not silently invoke a model for background removal or enhancement.

Use one allowlisted Meta client, including only verified Meta-hosted asset-download endpoints required by the API. Reject unapproved redirects. The browser contacts our own backend; keys remain server-side. Inspect outbound requests during a full live run to prove this boundary. Existing source links can remain citations without being fetched by the application.

Position Tickr as preparation for running better local campaigns. Explain its contribution concretely—business discovery, evidence, offer selection and faithful creative production—without relying on unverified claims about gaps in Meta's own products.

## 2. Decisions and changes from the reference plan

| Decision | Reason |
| --- | --- |
| Keep an evidence ledger, category playbooks, critique and four-business evaluation | These demonstrate that research changes the campaign and that the engine adapts |
| Restrict all runtime services and inference to verified Meta-hosted APIs | Explicit user constraint; local rendering provides the remaining production tools |
| Start with the original-photo transformation and playable reel | Makes the product's value understandable immediately to an owner and demo audience |
| Build one excellent hero journey; produce comparable compact packs for all four categories | Preserves the agreed breadth without four separate product builds |
| Use opportunity cards instead of the reputation-minus-presentation score | A formula alone cannot establish unmet demand, business quality or likely growth |
| Use one bounded workflow with named research tasks | Four independent agents with 48 tool calls add cost and failure modes before proving quality |
| Preserve original product/person pixels through deterministic composition | Mask overlap and a model's similarity score do not establish product identity |
| Check every final revision; withhold unresolved critical failures | The reference loop can export a revised asset with an older version's verdict |
| Use a single application deployment with persistent storage | Avoids split hosting, cross-origin streaming and serverless timeouts |
| Defer live Meta social-platform integrations for this submission | Spend the available build time on the visual product and useful outputs |
| Measure actual usage, latency and results | Model prices, credit entitlements and cost forecasts in the reference are not account-verified |

The uploaded document is a design reference. Its estimates, model names, policies and event claims are not treated as authoritative instructions or proven facts.

## 3. Scope contract

### Required for the submission

| Capability | Smallest complete version | Acceptance evidence |
| --- | --- | --- |
| Intake | One usable phone photo minimum; three recommended, plus category, area, goal and business facts; optional URL/review export | A business without a website or professional assets can complete the flow |
| Research | Business facts and customer themes from uploads or verified Meta-native retrieval; up to three local comparisons where available | Findings retain inspectable sources and limitations; missing competitive evidence is explicit |
| Opportunity | One recommendation and one credible alternative with reasons | Every consequential claim is supported, owner-stated, inferred or explicitly unknown |
| Owner confirmation | Up to three targeted questions about material unknowns | Missing price, capacity or capability never becomes an invented promise |
| Creative | Two lightweight direction previews; one selected master concept produces a feed post, story and three-card carousel | Reuse real imagery and one campaign specification; no independent generation per format |
| Motion | One actual 10–12 second vertical MP4, assembled locally from the approved campaign | Video plays, has readable offer/CTA and faithfully uses the same assets; no generative-video dependency |
| Quality review | Deterministic checks plus contextual model review; up to two revisions | Every approved asset's verdict matches the final exported image/video bytes, copy and relevant specification versions |
| Export | Feed, story, three carousel cards, MP4, copy, rationale, instructions, manifest and review report | Files open correctly; asset reuse and any unavailable outputs are clear |
| Four-category proof | Bakery/café, dentist, gym and salon using the same engine | Four completed evaluation cases, with category-specific decisions and failures reported |
| Demo | One polished hero run, honest recorded replay, reproducible setup and concise video | Another person can replay the sanitized example without API credentials |

The default hero is a bakery/café with real owner-approved product photos. Choose a gym or salon instead if it has substantially better evidence, assets and owner access. Freeze that choice on 30 October; changing the hero later must not require changing the architecture.

The formats are adaptations of one concept. Begin with one master scene and at most one additional generated background after selection; carousel cards and video reuse those assets. Two direction previews can use local layout/color variations without two image-generation calls. A campaign may use an unchanged source photograph in a designed layout when Meta-hosted segmentation or image generation is unavailable.

### Further outcomes from the same assets

After the required pack passes, support a WhatsApp share card, a square Facebook/ad-placement crop or an in-store digital offer card as additional deterministic layouts. They do not require a new research agent or image model. Print-ready brochures, many custom templates and a full branding suite remain outside this build.

The hero reel is now core, because a real video is a particularly clear outcome for owners who cannot commission one. Live Instagram publishing, WhatsApp automation and ad-account work are deferred. Do not spend the visual-production budget collecting integrations or claiming unverified judging bonuses.

A WhatsApp contact link is a useful CTA in the core pack. It is not a Cloud API integration, automated conversation or booking system. A draft message is not an approved WhatsApp template.

### Deferred

Automatic publishing/ad spend, Ads Manager drafts, social account onboarding, WhatsApp API automation, broad social listening, arbitrary competitor performance analytics, booking systems, Conversions API, continuous optimization, scheduling, generated voice/music, billing, multi-tenant accounts, all custom model hosting and an extensive content calendar.

## 4. First-day gates: establish what actually works

These gates are implementation tasks. They have not passed yet.

### G0 — event and submission facts

Read the actual participant rules/dashboard and record the exact language and source for eligibility, required Meta AI usage, theme, permitted prior work/dependencies, public-repository requirements, video duration, restricted categories, IP terms and deadline.

The user prioritizes Impact 30% and Demo 25%, consistent with participant notes that also report Meta AI Tooling 25% and Technical Depth 20%. Use those as working priorities; exact official wording remains unverified. Participant notes mention Meta Model API/open-weight use, but the user's stricter Meta-hosted-only runtime requirement governs this build. New-work, public-repository and video rules still need primary-source confirmation. There is no verified separate bonus for WhatsApp/Instagram/Threads integration.

Reported deadline: 4 November 2026 at 21:00 Eastern Time. **If that report is correct, it is 5 November at 07:30 IST**, because New York is on EST. The reference's 06:30 conversion is not the same deadline. Our internal submission target is **4 November at 20:00 IST**, subject to an earlier official cutoff if one is discovered.

### G1 — real Meta capability probe

Check existing configured credentials by name/presence and use secure environment settings for anything missing. Never place secrets in chat, source, exports or replay fixtures.

Run minimal examples of the capabilities we intend to use:

| Role | Operation to prove | Fallback |
| --- | --- | --- |
| Reasoning | Extract a small evidence bundle into the agreed schema; select a strategy with supported citations | Use one accessible Meta-hosted model for extraction, strategy and separate review passes |
| Tool use / retrieval | Verify Meta-native search/retrieval returns actual attributable evidence | Owner-supplied source bundles only; no external fetch/API fallback |
| Visual understanding | Read one screenshot/photo and describe only relevant visible facts | Human-checked visual facts plus deterministic layout checks |
| Image generation | Generate one usable background through the actual Meta-hosted API and compose it with a source photo | Compose approved photographs and typography locally; record the capability limitation |
| Segmentation | Obtain a usable mask for one real product through a verified Meta-hosted endpoint | Use the full original photo; no local inference or third-party hosted segmentation |

Freeze exact model IDs and request schemas only after these calls succeed. A model-list entry alone does not pass the gate. Record model/version, supported operation, sanitized request shape, latency, usage and observed failures in a capability report. Do not assume an OpenAI-compatible endpoint supports every OpenAI feature.

The reference names Spark, Wonder, Muse Image and SAM. These are candidates, not four mandatory dependencies; only models served by the permitted Meta-hosted API can be used. An additional Meta model must solve a demonstrated problem. No Fireworks/Baseten or other partner-hosted inference. Do not silently move owner assets into a contributor/training tier to reduce cost. Do not assume a video-generation, audio or transcription endpoint exists or is accessible.

If no required Meta inference route works, continue independent UI, evidence and export work, but mark the live AI path blocked. Replay fixtures do not establish event eligibility or real inference.

### G2 — hero evidence and asset rights

Obtain one usable business evidence bundle and owner-approved phone photos. Minimum: one sharp product/service photo, business name and a credible offer or goal. Recommended: three photos (hero product/work, a detail or second view, premises/team as appropriate), the actual price if needed and a logo if available. Record permission for product use, demo display and public-repository redistribution separately. Permission for one purpose does not imply the others.

Offer a short phone-shoot guide: window light, a clean background, steady framing and a close view with enough space for cropping. Local checks flag low resolution; verified Meta vision can give photo-specific guidance. If a photo lacks necessary detail, ask for a better phone shot or keep the output small. Do not claim to recover unseen product details or authentic new camera angles. Without any usable real photos, a labeled concept/typographic campaign is possible, but the authentic product-transformation demo remains unproven.

Prepare four category fixtures immediately. They may begin as clearly labeled illustrative fixtures for development; replace them with sourced cases before making real-business evaluation claims. Four responsive owners are not a prerequisite to writing the engine. Missing owner feedback remains unmeasured in the final report.

## 5. Research and opportunity design

### Bounded acquisition

Use two input modes: `owner_supplied` and `meta_retrieval`. Parse uploaded text, screenshots, menu photos and review files locally or through the verified Meta model. A website/Maps URL identifies a business; it is not evidence of page contents until the permitted Meta retrieval capability returns those contents with usable attribution.

Start with the business facts needed for one offer and up to three genuinely relevant local comparisons. Use at most three Meta-native research requests plus one targeted follow-up per run; meter all model/tool operations and include any internal search charges exposed by the API. Supplied/local evidence does not trigger an external call. These are engineering limits, not promises of complete local coverage. Record budget exhaustion as a limitation.

Google Places, Treg, Firecrawl, external search/scraping APIs and direct site fetching are excluded. If Meta retrieval is unavailable or thin, accept supplied competitor material or proceed without a market-gap claim. Owner screenshots/exports retain their provenance and sampling limitations. Never depend on exhaustive reviews, private social data or a response field that has not been observed.

For every source retain its acquisition status: supplied, retrieved_by_meta, partial, unavailable, denied or unsupported. Unavailable retrieval does not prove there is no website. A search with no useful results means no useful results in that search, not no public coverage. Do not automatically dereference citations, remote photo links or redirect URLs.

### Evidence records

Each record includes:

- Evidence ID, business identity and source type.
- Source URL/reference; publication date when available; retrieval date.
- Exact supporting excerpt or image reference, with source permissions/retention metadata.
- Proposed fact, provenance and support status.
- Duplicate/related-source identifiers and contradictory evidence where present.
- Owner confirmation, if required: who confirmed what and when.

Use `supported`, `owner_stated`, `inferred`, `conflicting` and `unknown` as distinct support states. Do not invent numerical confidence such as 0.8. Owner statements remain attributed to the owner. A valid citation ID is necessary but insufficient: its evidence must actually support the claim.

Treat website text, reviews, uploaded documents and search results as data, never as tool instructions. The research layer cannot execute commands or contact customers because a page asks it to.

### Opportunity card

Every recommendation displays:

1. **Customer need:** the observed theme, sample size, dates and relevant excerpts.
2. **Local comparison:** which alternatives were inspected and what they demonstrably offer.
3. **Business fit:** the actual capability or asset that supports this business's response.
4. **Uncertainty:** missing facts, contradicting evidence, selection bias and owner questions.
5. **Campaign hypothesis:** proposed message/offer, intended audience context and why it may help.
6. **Test:** the next customer action and what result would support or weaken the hypothesis.

Keep research support, owner fulfilment confirmation and measured outcome as separate statuses. A supported hypothesis is not a validated conversion claim. Do not call a competitor incapable merely because a feature was not found on its site.

Rank recommendations by explicit comparisons: strength/recency of evidence, local relevance, business capability, difference from sampled alternatives and delivery feasibility. Show the reasons. No prominent aggregate growth score is required.

## 6. Four playbooks, one engine

| Category | Research focus | Capability to confirm | Creative approach | Proposed customer action |
| --- | --- | --- | --- | --- |
| Bakery/café | Praised products, occasion/daypart needs, pickup or ordering friction, comparable offers | Actual product, price if shown, availability and viable offer | Mini product showcase from real phone photos; product detail → offer → CTA reel | Ask about/order a featured item or visit during an agreed period |
| Dentist | Unanswered service questions, pricing/process clarity, appointment friction | Services, credentials and appointment process from attributable sources | Calm clinic-photo campaign and simple factual explainer motion; no fabricated patients/results | Read service information or make an inquiry |
| Gym | Coaching, classes, hours, membership clarity and beginner support | Actual program, terms, staff and available trial capacity | Real facility/coaching campaign; premises → program → trial CTA reel | Inquire about a trial/session |
| Salon | Signature services, portfolio evidence, booking clarity and occasion needs | Actual services, prices where used, availability and photo permission | Editorial presentation of real work; detail montage → service → booking CTA reel | Inquire about an appointment |

Playbooks change the research questions, claim requirements, layouts and customer action. They do not create unsupported stereotypes or guaranteed category-specific strategies.

For the dentist, keep the evaluation example informational and identify jurisdiction-specific review requirements before distribution. Do not encode the reference's blanket assumption that organic content is automatically permitted. Automated checks do not certify professional advertising compliance, legality or platform approval.

## 7. Implementation architecture

### Stack and deployment

- **Backend:** Python 3.12, FastAPI, Pydantic and an explicit asynchronous state machine.
- **Frontend:** React + TypeScript + Vite; build static assets and serve them from the same application origin.
- **State:** one SQLite database with runs, evidence, stages, assets, verdicts and ordered events. Serialize writes; retain files on a persistent volume.
- **Evidence input:** local file/text parsers and verified Meta-hosted retrieval/vision; no general web crawler.
- **Rendering:** Playwright renders local HTML/CSS templates with network access disabled; use bundled fonts and assets.
- **Composition:** deterministic image processing for approved photo/cutout placement and ffmpeg for the required short reel. No local ML background-removal, OCR or enhancement model.
- **External services:** one Meta client with an explicit, verified endpoint allowlist; no runtime third-party API dependencies.
- **Execution:** one long-running application deployment and one bounded background run executor. No Redis, distributed agent framework, vector database or separate frontend hosting in the MVP.

Use existing `/workspace/Tickr`; each cloud task is already isolated. Do not create a Git worktree unless explicitly requested. Pin dependencies and save tested install/start instructions during implementation, once the real runtime is known.

For a hosted demo, protect the single-team instance and upload/run endpoints with access control and rate/cost limits. An unguessable run ID is not authorization. A public showcase can expose sanitized recorded runs while keeping model execution and owner uploads private.

### Run states

`created → ingesting → researching → proposing → awaiting_owner/awaiting_selection → creating → checking → ready/needs_review`

Also support `failed`, `cancelled` and `interrupted`. Save stage checkpoints before advancing. After a restart, mark unfinished work interrupted and offer explicit resume from the last completed stage; do not silently repeat paid generation. Cache reuse requires matching inputs, model configuration and relevant rule versions.

Owner questions block only dependent promises. If the owner does not confirm a discount, the engine can omit it and propose an evidence-supported campaign. Final pack generation requires an explicit strategy selection; no timeout is treated as owner approval.

### Modules and implementation order

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `domain/` and persistence | Run, Source, Evidence, Opportunity, Strategy, Asset, Verdict and Event contracts | Nothing external |
| `meta/` | One Meta-hosted client with verified capabilities for reasoning, vision, image generation, retrieval and optional masks | Capability probe + endpoint allowlist |
| `research/` | Bounded permitted evidence input, extraction, deduplication and contradiction handling | Domain + Meta client |
| `strategy/` | Category playbooks, opportunity construction and owner questions | Evidence |
| `creative/` | Shared scene specification, source-faithful composition, still layouts and local video rendering | Approved strategy + assets |
| `quality/` | Deterministic and contextual checks; exact-version verdicts | Claims + final rendered assets |
| `exports/` | Approved asset bundle, rationale, instructions and review report | Quality results |
| `web/` | Intake, opportunity review, confirmation, campaign studio and download | Stable API contracts |
| `evals/` | Frozen inputs, matched baseline, manual scoring and result report | Same production pipeline |

Suggested API boundary: create/read a run, upload a source, stream ordered events, answer owner questions, select a strategy, cancel/resume, and download an authorized export. Return quickly from run creation; do not hold a web request open for the whole pipeline.

### Reliability and cost controls

Start with one active generation run and at most two concurrent research calls. Use bounded timeouts and at most one automatic retry for confirmed transient failures. Honor rate-limit responses and stop on confirmed authentication/permission errors. Persist correlation IDs and request status. If a paid generation request times out with an unknown outcome, query its status where supported or mark it unresolved; retry only with supported idempotency or confirmed failure. A correlation ID alone does not prevent duplicate charges.

Emit actual stage/tool outcomes through SSE with sequence IDs and reconnect support. Display short action summaries and evidence links, not invented agent activity or private chain-of-thought. Keep observed usage, estimated cost and unknown billing separate.

Configure a conservative spend ceiling before the first live probe or run. Suggested initial development ceiling: the smaller of $3 and 5% of the verified remaining allowance, subject to the user's actual budget. Preflight calls with verified current unit prices and bounded token/image inputs; reserve their maximum estimated charge against the whole-run cap, including requests whose outcome is uncertain. Do not treat missing price/usage information as zero. Recalibrate after the first three complete runs without silently increasing the budget.

Begin with a six-minute soft runtime target for the still pack and a ten-minute deadline for the complete run, returning saved partial results or a useful failure if exceeded. Measure video rendering separately and revise targets after testing. These are proposed engineering targets, not measured performance. Keep at least 25% of verified credits for final evaluation and recording; do not assume the quoted $150 credit allocation or $2.20/run forecast.

Reuse the same generated master scene across aspect ratios, carousel cards and motion. Price, CTA, color and layout edits are local updates; recheck them without regenerating backgrounds. Track cost per approved complete pack including failed attempts, retries and revisions, plus local rendering time. Free hackathon credits do not establish sustainable customer pricing or a particular saving over professional services.

### Treg inspiration

Borrow the workflow: discover a suitable tool → inspect its contract/cost → make a small call → qualify the result → expand only if useful. Carry provider, source, freshness and usage metadata with the result. Distinguish `found`, `empty`, `error` and `unknown`.

Implement those controls around the Meta client. Treg is architectural inspiration only, not a runtime dependency or future fallback under this constraint. Do not import its B2B enrichment/outreach system. Its current license adds hosted/embedded-use restrictions; independently implement the useful patterns unless direct code reuse is separately cleared.

## 8. Creative production and quality gates

### Outcomes we can offer a small business

| Outcome | What the owner receives | Production path | Scope |
| --- | --- | --- | --- |
| Product/portfolio showcase | A more considered presentation of the actual cake, work, premises or service | Original photo + local layout; Meta-generated background and Meta-hosted cutout only when verified | Core |
| Campaign art direction | Two fast previews with a consistent palette, type hierarchy, framing and message | Meta selects a supported direction; local templates preview it using the same assets | Core |
| Coordinated still campaign | Feed post, story and three-card carousel: hook → reason to choose → action | One scene/specification reused with format-specific layouts and exact copy | Core |
| Short promotional reel | A playable vertical MP4 with product/detail reveals, readable message and CTA | Local motion, pans, transitions and encoding of the real assets; silent by default | Core |
| Useful copy and handover | Headline, caption, factual offer/terms and a clear next action | Meta-hosted reasoning plus owner confirmation and local exact-text rendering | Core |
| One-edit updates | Change a confirmed price/CTA once; update every affected format and rerender the reel | Shared fields and local rendering; changed outputs are rechecked | Core |
| Additional distribution sizes | WhatsApp share card, square placement or in-store digital card | Reuse the approved concept; deterministic adaptation | After the core passes |

This is a scoped creative-production service. It does not recreate an unseen product view, a real customer testimonial, an authentic haircut transformation or footage of an event that never happened. Generated atmosphere must not invent facilities, ingredients, services or results. Preserve people and the work being advertised.

The dependable software work is composition, format adaptation, copy placement, motion and file delivery. Model-generated backgrounds, segmentation, visual understanding and grounded retrieval remain conditional on the actual Meta-hosted account capabilities. Generative video, new camera angles, voice and music are not dependencies.

### Default creative path

1. Derive a compact asset specification from the selected strategy: claim IDs, source photo, headline, exact offer terms, CTA and brand tokens.
2. Keep the source photo intact, or use an owner-checked mask from the verified Meta-hosted segmentation endpoint where useful. Full-photo editorial framing is the default fallback.
3. Generate a background only when the verified Meta-hosted image API adds clear value. Place the original photo/cutout with a recorded uniform transform; keep the product/person region unaltered. A pleasing generated scene still needs believable scale, lighting, contact shadow and framing.
4. Render logos, headlines, numbers, dates, terms and CTAs deterministically.
5. Render feed, story and three carousel cards from the same specification; inspect readable size, crop, safe areas and contrast. Use design adaptation rather than a blind resize.
6. Render one 10–12 second vertical MP4 from the checked imagery and copy: a readable hook, product/service evidence, then the offer and CTA. Use one reusable motion template with category-appropriate pacing. Do not deform people/products to simulate new footage.
7. Check the final reel, including representative frames, text visibility, transitions, duration and successful playback. A pass on its source stills does not automatically approve the video.
8. Record original asset hash, permissions, generated components, motion specification and transformations in the manifest.

Do not equate silhouette IoU with product identity. Inspect mask boundaries, cropping, occlusion and source-region preservation. Service photos often work best as full photos rather than segmented objects. Generative editing of actual products/people is outside the required fidelity path.

Preserve and inspect available provenance metadata, but do not promise that composition retains a provider's marks or causes a particular Instagram label. The export manifest and visible disclosures are our explicit record of what was generated.

### Review responsibilities

Deterministic checks cover exact prices/dates, required owner confirmation, image/video dimensions, nonempty text, overflow, permitted assets, destination format and final-version matching. They check CTA syntax/configuration without making external reachability requests. Meta-hosted visual/contextual review checks whether evidence supports claims, whether the campaign answers the chosen need, and whether imagery introduces misleading implications. Human inspection supplements uncertain cases.

Maintain a small versioned advertising/content checklist from sources we can verify. Clearly distinguish an automated pass from owner approval, legal review or platform acceptance.

The final-check invariant:

```text
for attempt in 0..2:                 # initial draft plus at most two revisions
    verdict = check(exported_asset_bytes_hash, copy_hash, evidence_version, motion_spec_version)
    persist(verdict)
    if verdict passes all required checks:
        mark this exact version approved_for_export
        stop
    if verdict requires owner information:
        hold the dependent claim/asset for confirmation
        stop
    if attempt == 2:
        withhold this asset from approved export
        stop
    revise the failed parts
    invalidate all previous verdicts for the changed version
```

An unresolved critical failure belongs in the review report, not the usable-assets folder. An export with withheld assets is explicitly partial. Do not label it a complete ready campaign. Any manual change after approval requires rechecking. For video, timing, transitions, crop or encoding changes invalidate the reel verdict even if its source stills and copy are unchanged; bind approval to the actual final MP4 bytes and motion-spec version.

## 9. The owner-facing product

### Instantly understandable, honestly timed

Open on a strong original-phone-photo versus finished-campaign comparison and a playable example reel. Label it **Recorded example**, name the actual model/renderer used and show the original generation time. A separate **Create my campaign** path makes real Meta calls. An instant example is not a promise of instant live generation.

After upload, show the real source photo in a local draft layout immediately while the model prepares the brief. Label it **Draft layout** until the final content passes review. Stream real stage progress without fabricated activity. One click toggles original/master scene, feed/story/carousel and video previews; avoid making the owner browse technical logs to understand the result.

### Five screens

1. **Photo desk:** phone photos, goal and essential business facts; a small phone-shoot guide where needed.
2. **Campaign brief:** one supported selling point, customer need, local comparison if available and a compact evidence drawer.
3. **Confirm and choose:** consequential owner questions and two visual-direction previews; choose one concept.
4. **Campaign studio:** original-to-campaign comparison; feed/story/carousel previews; playable reel; shared price/CTA fields and review status.
5. **Handover:** approved download, clear withheld items, where to post, intended customer action and a short experiment note.

A collapsible activity view shows actual progress; owners should not need to understand models or agents to use the flow. Handle unavailable sources, thin evidence, waiting for owner input, failed generation and partial exports as ordinary product states.

Core export contents:

```text
campaign/
  approved/feed.png
  approved/story.png
  approved/carousel-01.png
  approved/carousel-02.png
  approved/carousel-03.png
  approved/reel.mp4
  captions.md
  strategy.md            # recommendation, alternative, evidence references, uncertainty
  today.md               # exact posting/handoff steps and proposed test
  manifest.json          # asset versions, provenance, disclosures, review status
  review-report.json     # blocked assets, unresolved items and check versions
```

Private source material is not included by default. Public replay bundles use licensed or permission-cleared content, remove customer identifiers and secrets, and follow applicable source/Meta retention and redistribution terms. Bundle all example/rendering assets locally; the showcase must not fetch source photos from unrelated hosts.

## 10. Evaluation that can support the demo's claims

Freeze one evidence bundle per category with timestamps, permitted phone photos, owner facts and the same output requirements. Acquire evidence only through the allowed Meta-hosted path or supplied material. Evaluate four case studies; do not describe this sample as proof of general conversion superiority.

### Comparisons

- **A — Engine:** the full evidence → strategy → creative → review process.
- **B — Evidence-matched single-pass baseline:** the same verified Meta-hosted main model, source bundle, owner facts, assets and permitted rendering/image tools, asked once for the same campaign output. No separate evidence-ledger workflow or revision loop. If we add a stronger Meta-hosted model to A, give B access to it or disclose the model difference as a confound. No local, third-party-hosted or other-provider model may serve as the baseline or judge.
- **C — Critique ablation:** compare A's first draft with its final checked output. This can reuse the same run and demonstrates what review actually changed.

Use equal image-generation limits and a shared maximum spend ceiling for A and B; record their actual calls, cost and latency. Do not substitute a different open model in the baseline and call the result an orchestration comparison. A URL-only comparison can be additional convenience evidence, but is not the primary test.

### Measures and release gates

| Measure | Method | Submission target |
| --- | --- | --- |
| Factual support | Human-check every material factual claim against the frozen evidence; report supported/total and material errors | Zero known unsupported material claims in approved exports |
| Owner-promise integrity | Inspect prices, availability, services and confirmation records | No inferred owner approval or invented offer |
| Source-photo fidelity | Inspect original/final pairing and composition transform; check crop/mask artifacts | No materially altered product/person representation |
| Visual usefulness | Inspect on a phone-sized display; ask an owner whether the assets represent the actual business and are worth posting | Readable offer/CTA, coherent styling and no obvious compositing artifacts |
| Video delivery | Play each exported MP4; inspect representative frames, offer timing, transitions and final CTA | A complete playable reel for each category; unresolved failures withheld |
| Useful differentiation | Reviewer compares the offer to the inspected alternatives and customer need | A defensible category-specific rationale in all four cases; otherwise report insufficient evidence |
| Campaign usefulness | Owner/independent reviewer rates relevance, clarity, distinctiveness and willingness to use on a defined 1–5 rubric | Aim for 4/5; report actual scores and unavailable feedback |
| Review effectiveness | Count corrected errors, remaining errors, new errors introduced and withheld assets | Show a real correction or a clearly labeled injected-defect test |
| Reliability and economics | Record completion state, live runtime, tool calls and measured/estimated cost separately | Four completed cases; hero route succeeds twice within the final configured limits |
| Runtime boundary | Capture browser/backend/renderer outbound destinations across a live run | Only the application's own backend and explicitly verified Meta endpoints are contacted |

Blind and randomize paired pack labels for independent reviewers where possible. The builder cannot reliably be blind to their own output. A Meta-hosted model judge is supplementary; the same critic cannot be the sole certifier of its own success. Report owner preferences only when an owner actually supplied them.

For the affordability/impact story, measure owner active time, elapsed generation/rendering time, edits required before approval, cost per complete approved pack and willingness to use the results. Compare with the owner's existing workflow when they can describe it. Do not invent photographer/agency quotes, extrapolate free credits into sustainable pricing, or present visual polish as measured sales uplift.

### Meaningful regression cases

- Missing price: omit it or request confirmation; never fabricate it.
- Meta retrieval unavailable: the owner-upload path still produces a grounded campaign; competitor gaps stay unknown.
- URL-only input without retrieval: ask for source content; never imply the site was read.
- Conflicting hours: expose the conflict and block time-specific claims until resolved.
- Duplicated review/source: do not count it as independent corroboration.
- Insufficient competitive evidence: decline to call the opportunity a confirmed gap.
- Final revision fails: withhold it; do not reuse an older verdict.
- Changed copy after approval: invalidate approval and recheck.
- Provider timeout/rate limit: bounded retry, saved progress and useful failure state.
- Worker restart: explicit interrupted/resume behavior without silently duplicating generation.
- Untrusted URL/source text: ignore embedded tool instructions and prohibit arbitrary fetches, including local/private destinations.
- Hidden egress: reject non-Meta API/asset redirects, remote fonts, renderer subrequests, hotlinked photos and automatic link previews.
- Shared offer edit: update all stills/carousel/video, invalidate old verdicts and recheck; do not regenerate unchanged imagery.
- Export: verify image/video dimensions, playback, readable text, allowed files, exact manifest hashes and no secret/private-source leakage.

## 11. Execution schedule and critical path

Assumption: one primary builder with assistance for independent reviews. As of 30 October, only planning has been completed; unfinished 29 October gates move into today's work. No parallel feature work should fork domain contracts. Establish the visual quality bar with a real still and rendered reel before expanding research breadth.

| Date (IST) | Work and deliverable | Done when |
| --- | --- | --- |
| **Fri 30 Oct** | Confirm Meta-only capabilities/rules; freeze hero and four fixtures; define the campaign spec; produce the first hero still and local MP4; storyboard demo | A real photo becomes a readable campaign visual and playable clip. Required Meta calls are proven or explicitly blocked; no third-party runtime fallback |
| **Sat 31 Oct** | Photo/source intake, evidence/brief, two direction previews, master-scene rendering and saved state | One supported selling point drives the visual choice; original-to-campaign comparison works; missing facts stay unknown |
| **Sun 1 Nov** | Feed/story/carousel/reel generation, one-edit updates, quality checks and exporter | Hero yields the complete downloadable pack; price/CTA changes propagate and recheck; image regeneration is avoided for layout-only changes |
| **Mon 2 Nov** | Run bakery, gym, salon and dentist; refine category treatments, final review loop and partial-output states; feature freeze at **20:00 IST** | All four cases produce reviewable packs; the hero live path passes; network trace satisfies the Meta-only boundary |
| **Tue 3 Nov** | Matched baseline, critique ablation, manual review, reliability fixes, README and rehearsal | Evaluation report contains actual results; failed/unrun outcomes are explicit; sanitized replay works and is labeled |
| **Wed 4 Nov** | Record video, verify submission requirements, freeze release and submit by **20:00 IST** | Submission receipt/link checked; exact submitted code/video preserved; no new capabilities started |

Critical path: **working Meta capability + real source photo → first still and MP4 → supported brief → shared multi-format scene → final-version review → export → four-case evaluation → submission**.

Independent work can proceed while keys or owner assets are pending: source parsers, contracts, UI states, deterministic rendering, exporter, evaluation tooling and labeled replay. Missing model access still blocks a claim of a working Meta-powered submission.

### Cut order

1. Keep all live social integrations deferred; drop extra share/poster sizes and elaborate motion effects.
2. Reduce image variants, unique generated backgrounds, research breadth and alternate directions.
3. Keep one reusable motion template and one selected master concept per case; reuse layouts while preserving category-specific decisions.
4. Drop supplementary model judging and optional metrics before manual factual/visual review.

Preserve all four category evaluation cases, the evidence chain, a playable hero MP4, exact final-version checks and usable exports. If video rendering fails for another category, withhold it and report that case's partial result rather than calling the full contract complete. If necessary, reduce the carousel from three cards to two and disclose the reduced scope. Do not pad the benchmark with unexecuted runs. At the freeze, fix defects rather than starting new capabilities.

## 12. Demo and submission evidence

Plan a three-minute submission video provisionally; adjust to the verified official limit. Lead with the transformation and actual useful outputs, then show why the engine chose that campaign. Use real findings rather than an invented digital-gap score.

| Time | Demonstration |
| --- | --- |
| 0:00–0:15 | Ordinary phone photo beside the finished hero scene; play a short excerpt of the actual reel |
| 0:15–0:35 | Owner's goal and constraints: a phone, limited time and a campaign needed today |
| 0:35–1:00 | Source-backed selling point/customer need; local comparison where available; owner confirms the promise |
| 1:00–1:30 | Two visual directions, selection, source-photo preservation and coordinated formats |
| 1:30–1:55 | Change an offer/CTA once; show consistent updates and one real review correction or labeled defect-injection test |
| 1:55–2:20 | Play the finished MP4, inspect the carousel and download the usable pack |
| 2:20–2:45 | Four distinct category treatments, owner feedback if collected, actual cost/time and baseline results |
| 2:45–3:00 | Meta-hosted model roles, local rendering boundary, project reference and stated limits |

Clearly distinguish live requests from recorded runs. A replay demonstrates a captured run, not current service availability; show its recorded runtime separately from playback duration. Record a genuine successful end-to-end run before making the video. Do not stage autonomous decisions that the engine did not make.

Prepare: reproducible setup/start instructions; architecture and model-role map; capability report; evaluation results and failure log; sanitized replay; source/dependency attribution; accurate new-work statement; verified submission checklist. Repository publication, external posting and ad spend require their own explicit authorization; none is implied by this planning task.

## 13. Immediate next actions and ownership

1. **Owner:** confirm official event rules/access and choose the hero business. Supply three permitted phone photos if possible, one goal and the essential offer facts.
2. **Builder:** run the Meta-hosted capability probe and freeze the allowlist; implement the local renderer while access is pending, without claiming model functionality works.
3. **Builder:** produce the first source-faithful hero visual and actual MP4, then connect the evidence/brief and one-edit multi-format workflow.
4. **Owner + builder:** review whether the business and product are represented accurately and whether the campaign is useful enough to post.
5. **Reviewer:** verify outbound runtime destinations, claim support, visual quality and final-version checks, then evaluate all four cases with the permitted matched baseline.

No outreach, publishing, paid campaign, credential creation or source-code reuse has been performed as part of creating this plan.

## 14. Source and verification notes

- Primary input: uploaded *Local Growth Engine — Meta Global AI Hackathon build plan.md*, dated 29 October 2026, plus this conversation's scope decisions. The user's 30 October Meta-hosted-only and visual-first instructions supersede earlier external-service/integration proposals.
- Official rules targets: [Meta event](https://dev.meta.ai/events/global-hackathon), [Cerebral Valley waiver/rules](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver), [participant guide](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details). These were inaccessible through this environment's network proxy; that does not establish that the event pages are unavailable generally.
- Corroborating participant material: [event guide](https://github.com/meta-ai-hackathon/meta-hack/blob/main/info/event%20guide.md), [grading notes](https://github.com/meta-ai-hackathon/meta-hack/blob/main/info/grading%20criteria.md). Secondary evidence; exact official requirements remain a first-day gate.
- Model integration evidence: [Promptfoo Meta provider](https://github.com/promptfoo/promptfoo/blob/main/site/docs/providers/meta.md) corroborates a Meta provider implementation, but does not prove account access; it is research material, not an additional runtime service. [Official SAM repository](https://github.com/facebookresearch/sam3) and [SAM 3.1 release notes](https://github.com/facebookresearch/sam3/blob/main/RELEASE_SAM3p1.md) establish segmentation capabilities, not a verified Meta-hosted endpoint, price or fidelity thresholds. Local SAM inference is excluded.
- Deferred ecosystem references: [official Threads sample](https://github.com/fbsamples/threads_api), [Meta Business SDK](https://github.com/facebook/facebook-python-business-sdk), [WhatsApp examples](https://github.com/fbsamples/whatsapp-api-examples), [WhatsApp Flows examples](https://github.com/WhatsApp/WhatsApp-Flows-Tools). Source review establishes implementation possibilities, not approved access or current scope.
- Treg inspiration: [lead-signals workflow](https://github.com/superdesigndev/treg/blob/main/skills/lead-signals/SKILL.md), [gateway architecture](https://github.com/superdesigndev/treg/blob/main/docs/context/architecture/proxy-model.md), [license](https://github.com/superdesigndev/treg/blob/main/LICENSE). Workflow inspiration is included; code reuse is not assumed permitted.
