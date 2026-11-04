# Tickr — intelligence-first build plan

Updated 4 November 2026. All dates and times use IST (Asia/Kolkata).
The user’s November 2 direction expands research to arbitrary business categories and exact-location intelligence. The [final architecture](docs/reference/final-architecture-2026-11-01.txt) remains the earlier reference; the [October plan](docs/archive/BUILD_PLAN-2026-10-30.md) is historical.
This document separates proposed behavior from verified implementation. Read [architecture](docs/ARCHITECTURE.md) for contracts and [inputs needed](docs/INPUTS_NEEDED.md) for the immediate prerequisites.

## 1. Product and completion boundary

**Tickr investigates a local business, identifies a supported marketing opportunity, and turns one campaign strategy into native Facebook, Instagram, Reel and WhatsApp creative kits.**
The owner starts with a website, listing or social-profile link and may add a goal. The engine discovers the identity, locality, public story, offerings and useful sources itself. Optional owner knowledge and authorized photographs improve the result; they are not prerequisites for starting research.
The engine explains what the business should promote, to whom, and why before generating assets.
A URL starts real discovery. The engine reports unavailable material and ambiguous matches after attempting retrieval; it does not require the owner to write the research brief. Complete reviews, local demand and competitor coverage are not guaranteed.

The evidence chain is: customer need → comparable local evidence → demonstrated business capability → proposed campaign → measurable customer action.
Repeated complaints establish a candidate need. Owner confirmation establishes capability. Qualified inquiries and fulfilled bookings test the opportunity.
Tickr must not label an inferred gap “validated” or promise high conversion before those observations exist.

The hackathon endpoint is a generic engine that creates a complete exportable campaign kit for a business link, with real playable Reels and inspectable evidence. The original four verticals remain useful evaluation cases; they do not restrict the supported business types.
Publishing, outbound messaging, paid ad activation and operational booking integrations are optional later adapters.
The demo must distinguish generated scripts from working messaging integrations and experimental campaigns from measured business results.

## 2. Runtime decisions

| Area | Decision |
| --- | --- |
| Application | Next.js, TypeScript, Tailwind; accessible reusable UI components |
| Contracts | Zod schemas with JSON Schema handoffs and explicit artifact versions |
| State | Prisma + SQLite; local filesystem assets; optional SQLite FTS for ledger lookup |
| Orchestration | Bounded TypeScript state machine, persistent checkpoints, resumable worker |
| Still images | Tested Muse Image generation; original media where accessible; Sharp + SVG composition; hosted SAM verified separately and integrated with explicit fallbacks |
| Reels | Local Remotion + FFmpeg; no external video inference dependency |
| AI inference | Meta-hosted APIs only; account-tested model IDs chosen by role |
| Website research | Restricted HTTP retrieval of permitted public official business sites |
| Additional research | Meta-native search only when actual calls and attributable results are observable |
| Social APIs | Authorized Meta APIs only; optional and outside the core demo critical path |
| Deployment | One persistent Node environment with writable database/assets; no ephemeral job state |

The final architecture supersedes the October plan's prohibition on direct website reading.
No Google Places API, third-party search/research API, hosted open-weight alternative, local model inference or external image/video service is permitted.
Local open-source libraries, deterministic media processing and public official-site HTTP reading are allowed.
Use projects such as Treg for design inspiration after source/license review. The verified event rules allow open-source components when their licenses are followed and the submission enhances or builds upon them; record any reuse and attribution. Their hosted services are not runtime dependencies.
Website content is evidence, never an instruction to the agent. Rendering our own templates must not fetch arbitrary external resources.
The account catalog exposes `muse-spark-1.3`, `muse-wonder-1.0`, `muse-image-1.0` and `sam-3.1`. Spark discovery/analysis/copy, Muse Image generation and a SAM subject-mask probe have passed. A saved real SAM response also passed the full local composition/Reel path. Tiger Lily’s original SAM attempt failed and its kit uses a labelled crop fallback; editing, pricing and capacity still need role-specific validation.

## 3. Current state and first executable milestone

The working MVP now persists intake and source material, runs Meta evidence analysis in a durable worker, displays four analysis areas and up to three supported opportunities, and generates one selected campaign concept across seven channels.
The concept kit contains coordinated PNGs, four carousel slides, a real four-scene 12-second H.264 Reel, channel copy, WhatsApp reply suggestions, a source-bound product/brand dossier, evidence/review documents and a checksum-verified ZIP. Named offerings or attributed story phrases drive a structured brief and shared visual; source images and generated illustrations have explicit provenance. Outputs remain `concept_needs_review`; they do not contain authorized owner photographs or publication approval.
Four fictional cases passed the HTTP/worker concept flow. Enriched link-only runs for Grandma Daphne's and Theobroma now produce seven channels and 22 downloadable files, with a source-bound brief and shared Meta illustration. Grandma's retrieved profile supports a family-recipes story but no named offering; Theobroma supports an actual named product. These completed runs required deterministic validation fixes and reuse of saved copy responses. See [product grounding](docs/PRODUCT_GROUNDING.md) and the [demo guide](docs/DEMO.md) for exact runs, sources, recovery history and verification scope.
Meta-native discovery now runs before analysis with at most five native retrieval actions. The official-site reader now works through a validated-public-IP CONNECT tunnel with original-hostname TLS verification. Adaptive investigation adds up to ten native actions for branch identity, offerings, brand, customer signals, competitors and seasonal context. Coverage records what was established and what remains missing. Meta-linked summaries remain weaker evidence than original source text.
Muse Image generation is live-tested and integrated; original-photo acquisition is implemented with explicit access/identity limits. SAM subject layering is implemented and verified with a saved real response, while live failure recovery remains a focus. Owner uploads/connected-account media, contextual final critique, owner approval/revision workflows, broader real-business evaluation and conversion outcomes remain open. The existing Remotion diagnostic is separate; the working concept renderer uses local Sharp/SVG and FFmpeg.
[Setup verification](docs/SETUP_VERIFICATION.md) records executed checks and external blockers; each milestone below stays open until its exit evidence exists.

The user-selected hero is **Grandma Daphne's bakehouse**, reference `https://maps.app.goo.gl/nNy6iYx9r4GaU7YY8`.
The confirmed goal is **get the bakery's story out to differentiate it from other bakeries**. The fixed-host short-link resolver extracts a name hint from the routing redirect and never fetches the Maps page. Meta found `@grandmadaphnes` and reported British roots, family recipes and home-like bakehouse themes. Exact locality, official standalone website, products and prices remain unknown in the completed run.
Do not infer the founder story, craft, history or signature goods from the name or goal; those need attributable sources or owner confirmation.
`META_API_KEY` is saved and active. Reuse the existing credential; do not request another key. The available model IDs and successful synthetic text check do not establish research or media capability.

**Next research milestone:** strengthen the automatically discovered bakery profile with original source excerpts, locality and bounded competitor/customer coverage. The URL-to-story-concept slice is working; a local market gap remains unvalidated.
If evidence supports only one or two opportunities, return those and explicitly mark the remaining slots unknown.
Do not manufacture competitors, review quotations, prices, audience attributes or scores to fill the interface.

## 4. Scope and acceptance contract

| Required capability | Smallest complete deliverable | Exit evidence |
| --- | --- | --- |
| Intake | Business URL/reference and optional goal; optional details/uploads, manual name/locality alternative | URL-only live discovery passes before unresolved details produce targeted confirmations |
| Research | Business, customer, competitor and content analysis over attributable sources | Inspectable excerpts, retrieval times, coverage and unknowns |
| Diagnosis | Reputation, visibility and conversion findings; ranked opportunities | Each finding links to supporting and contradicting evidence |
| Strategy | One selected `CampaignBlueprint`, with alternatives and rationale | Audience/offer/CTA claims are supported or explicitly proposed |
| Native kit | Instagram feed/carousel, Facebook ad variants, Stories, CTWA assets/scripts, Status creative | Channel-specific copy and layout retain one objective |
| Motion | One multi-scene vertical Reel per benchmark business | Four playable MP4s, covers and storyboard manifests |
| Review | Deterministic checks plus model critique; bounded correction | Verdict covers the final exported bytes and copy |
| Export | Media, captions, scripts, calendar, evidence/strategy reports, manifests | ZIP opens and every listed file exists |
| Generalization | Arbitrary business category, exact branch and adaptive research; include the four original examples and a business outside them | Complete runs with different evidence-driven decisions and visible source coverage |
| Evaluation | Frozen-input baseline comparison and blind human review | Actual counts, failures, quality scores, latency and usage |

P0 includes every row above. Business types must not be a closed enumeration. Evaluate the shared engine across different businesses, including the original cases and the supplied café/bistro.
P1: polished live activity trace, richer revision UX and authorized Meta insights.
P2: Instagram publishing, Marketing API drafts, connected-account onboarding and WhatsApp automation.
Post-event: automated budget optimization, booking/payment integrations, multi-tenant billing and continuous performance learning.
Threads can be an optional distribution adapter later; it must not displace the agreed Facebook/Instagram/WhatsApp kit.

## 5. Evidence and research implementation

1. Resolve the supplied link, extract a routing name where available, and use bounded Meta-native search to establish business identity, category, locality and public story. A fixed-host Maps short-link redirect may provide a name hint; stop at the redirect target and do not read Maps pages or APIs.
2. Fetch a bounded set of permitted public official-site pages through the restricted fetcher. Revalidate every redirect and destination.
3. Extract offerings, hours, prices, credentials, booking paths and visual assets; retain the excerpt/image reference behind each claim.
4. Use verified Meta-native search to discover relevant official competitor sites and attributable customer evidence when available.
5. Run four named analysis tasks: business strengths; customer needs/objections; local competitor comparison; content/CTA presentation.
6. Reconcile identity, contradictory sources, freshness and gaps before writing the business profile and opportunity report.
7. Ask at most three material owner questions initially. Continue independent analysis while answers are pending; leave dependent claims unavailable.

Every ledger item stores source identity, URL or upload ID, retrieval/observation time, excerpt or image region, provenance, scope and contradictions. Meta search summaries retain their response/call IDs and source URLs; distinguish original snippets, provider-annotated synthesis and model-written references to actually retrieved URLs. Never display generated summaries as verbatim page quotes.
Use separate classifications: source-supported fact, observed signal, owner-stated fact, inference and proposal. “Unknown” is a valid result.
Source support does not guarantee a price is current, a service is available or a claim is appropriate for every advertising jurisdiction.
Attach owner confirmation and channel/category review separately from the source record.

Competitor absence means “not found in the inspected sources,” not “no competitor offers this.”
Review themes show the observed sample and source coverage; they cannot establish representative demand or private competitor performance.
If search is unavailable, use supplied competitor materials and permitted official-site reads; label the resulting research limits.
If no competitive evidence exists, offer a business-grounded campaign while leaving differentiation and market-gap validation unknown.

## 6. Opportunity ranking and campaign contract

Display reputation, visibility and conversion findings independently; do not subtract them into a purported business-value score.
Rank eligible hypotheses using the agreed heuristic:

`O = 0.30 × I + 0.25 × E + 0.20 × D + 0.15 × F + 0.10 × C`

| Input | 0 / 50 / 100 anchors |
| --- | --- |
| I — estimated relevance to business impact | No connection to owner goal / plausible route to the goal / direct route with owner-confirmed capacity and a measurable action |
| E — evidence strength | No attributable support / one direct or several limited sources / multiple fresh, independent and directly relevant sources |
| D — differentiation | Evidence shows no meaningful distinction / partial distinction in the inspected set / demonstrated relevant distinction in that bounded set |
| F — feasibility | Known blocking constraint / achievable with identified preparation / confirmed offer, capacity, assets and destination ready |
| C — confidence in diagnosis | Material contradictions unresolved / plausible explanation with disclosed alternatives / key uncertainties checked and alternatives addressed |

Intermediate 25/75 values require a written justification against adjacent anchors.
Missing inputs are `null`, not zero or an invented midpoint. Show dimension coverage and the inspected competitor/review sample separately.
Compute a total only when all five inputs have an assessable basis; otherwise show an unscored hypothesis and what would make it rankable.
Compare complete scores within the same run and rubric version. Do not suggest cross-business precision or calibrated conversion probability.
E concerns source support; C concerns unresolved ambiguity and alternative explanations. Neither is an LLM-generated probability of truth.

Each opportunity includes a need, affected audience hypothesis, business capability, bounded comparison, proposed response, evidence IDs, counterevidence and test.
Return three ranked opportunities only when supported; explain why the recommendation beats the available alternatives.
Owner selection produces one immutable blueprint version: objective, audience hypothesis, differentiator, message, offer status/terms, primary CTA and channel plan.
An unapproved discount or new service stays a proposal and cannot appear as an available offer in a ready-to-use asset.

## 7. Channel production and real motion

| Deliverable | Production target | Native execution |
| --- | --- | --- |
| Instagram feed | 1080×1350 image, caption and relevant hashtags | Visual discovery, concise hook, save/visit action |
| Instagram carousel | Four or five coordinated slides | Hook → evidence/value → explanation → action |
| Facebook feed ad | 4:5 and 1:1 variants | Local context, primary text, headline, destination/CTA |
| Stories | 1080×1920 image or video | Brief message, readable terms, deliberate CTA space |
| Reel | 1080×1920 MP4, approximately 12 seconds, cover | Multiple scenes with timing, on-screen copy and ending action |
| Click-to-WhatsApp | Placement-specific ad + copy + conversation kit | Campaign opener, three common replies, qualification question, next action |
| WhatsApp Status | Distinct vertical creative + copy | Exportable concept; placement eligibility remains unknown until checked |

These are internal render targets, not verified exhaustive publishing specifications.
Click-to-WhatsApp runs on Facebook/Instagram and opens a WhatsApp conversation. Status is a separate placement, subject to availability.
Neither deliverable is a Cloud API template approval, a sent message or a deployed booking agent.
Export Status material with an eligibility note; do not imply that this business can activate the placement.

The Reel storyboard must include at least four purposeful scenes: hook (0–2s), product/service proof (2–5s), occasion/value (5–9s), brand/CTA (9–12s).
Use cuts, product reveals, restrained parallax, animated titles and branded transitions. A single slow zoom does not meet the requirement.
Render from original authorized media and shared campaign assets; optional audio must have documented rights. Silent playback must remain understandable.
Check resolution, codec/container, frame count/duration, sampled frames, text readability and playback; inspect the final end card and transitions.
Verify production renderer licensing and outbound behavior. Remotion development diagnostics do not establish production entitlement or a full network trace; if compliant production use requires incompatible external service calls, use a permitted local FFmpeg implementation that preserves the multi-scene requirement.

Prefer deterministic placement of real product/person pixels over asking an image model to preserve identity perfectly.
Meta generation may create backgrounds and supplementary scenes; segmentation is optional per asset and must be account-tested.
If segmentation is unavailable, use the unchanged owner photo in a deliberate layout. Record capability limits rather than substitute another inference provider.
Segmentation masks, silhouette overlap and model similarity are helpful diagnostics, not proof of identity preservation.

## 8. Four vertical intelligence packs

| Vertical | Distinct question | Evidence and creative checks | Proposed action metric |
| --- | --- | --- | --- |
| Bakery/café | Which verified product or occasion deserves attention? | Real food, menu/price freshness, availability, no invented dietary claims | Visit intent, attributable offer redemption |
| Dentist | Which practical uncertainty prevents an informed consultation inquiry? | Stated credentials, service facts, privacy, jurisdiction-specific professional advertising review | Qualified consultation inquiries |
| Gym | What makes joining practical and worthwhile locally? | Actual coaching/facilities/schedule; no invented transformations or personal-attribute targeting | Qualified trials, attended trials |
| Salon | Which genuine work demonstrates its distinct service? | Authorized portfolio, actual services/prices, no synthetic results represented as client work | Appointment inquiries, attended bookings |

Implement the packs as data/configuration: research questions, required evidence, objection taxonomy, channel treatment and review checks.
The dentist pack provides marketing logistics and factual service information; it must not become diagnosis or medical advice.
Do not hardcode “organic is always permitted” or any universal legal conclusion. Unresolved professional-advertising questions require owner/professional review.
All four use the same pipeline, artifact types, renderer and export checks; strategies are generated from the evidence, not fixed category slogans.

## 9. Reliability, budgets and quality gates

Every run checkpoints validated artifacts after intake, collection, analysis, ranking, strategy, production, critique and export.
Record input/source hashes, schema/prompt/rubric versions, model ID, dependencies and stage outcome; resume only while dependencies match.
Separate live mode, recorded replay and synthetic fixtures in data, UI and exports. Replaying a fixture never counts as fresh research or a live API test.
Use one persistent worker with a database lease initially; unfinished work must not depend on an HTTP request remaining open.

The implemented worker caps a run at six reserved Meta requests and four attempts: up to four text requests plus two visual requests. Discovery allows five native actions and investigation ten; collected analysis input is bounded to forty source records. Broader multi-round critique/revision budgets remain future work, not enabled runtime capacity.
Limit Meta concurrency to two and avoid generating a complete campaign for every alternative opportunity.
Count retries against the caps. Reserve capacity for the final review; pause with a resumable reason before limits are exceeded.
Use timeouts, request IDs and input-bound stage outputs. Do not automatically repeat uncertain paid requests or retry authorization/schema failures unchanged. Completed responses may be revalidated locally without another model request.
Log actual token/request usage and elapsed time. Price-based ceilings require verified current rates; unknown cost is not zero or a fabricated estimate.

Quality review combines deterministic file/layout/schema checks with a contextual Meta critic and owner factual checks where required.
Check claim traceability, approved offer terms, channel suitability, factual/visual fidelity, category restrictions, brand coherence and CTA usability.
Every revision creates a new asset version and invalidates the old verdict.
The final review binds to hashes of exported media, copy and blueprint plus the review-rules version. Hash mismatches block readiness.
Unresolved critical failures are withheld from the ready-to-use kit; the report identifies blocked outputs and remaining actions.
No untested asset or still-failing revision may silently inherit a prior pass.

## 10. Delivery schedule — November 1–4 IST

| Date | Work in dependency order | Exit test |
| --- | --- | --- |
| Nov 1 | Foundation and application smoke verified; extend text access to research capabilities; restricted ingestion; ledger; research/diagnosis slice | Real hero evidence produces a profile, bounded comparisons and justified opportunities, or explicit unknowns |
| Nov 2 | Blueprint; authorized imagery; native still layouts/copy; four-scene Reel; CTWA/Status kit; quality review and export | Hero kit opens, MP4 plays, final artifact hashes match passing verdicts |
| Nov 3 | Apply all four vertical packs; four real/sourced benchmark cases; baseline comparison; recovery and failure fixes | Four complete kits/Reels; actual evaluation table and documented limitations |
| Nov 4 | Usability, repeatability, clean-machine instructions, demo recording and submission | Reproducible demo, reviewable repository, working export, final submission materials |

Target submission by **20:00 IST on November 4** as an internal buffer.
The [official Meta event page](https://dev.meta.ai/events/global-hackathon), checked November 1, states **November 4 at 21:00 US Eastern**, which is **November 5 at 07:30 IST** because New York is on EST. The page says dates may change; check for organizer updates before submission.

### Verified event requirements and remaining submission details

The [Cerebral Valley Official Rules](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver), dated October 25 and read November 1, establish:

- Judging: **Impact 30%, Use of Meta AI Tooling 25%, Technical Depth & Execution 20%, Demo 25%**. These are competition weights, separate from Tickr's opportunity-ranking heuristic and proposed quality targets.
- Participants build with Meta AI products; the event overview includes hosted and open-weight options. This project's user-required **Meta-hosted-only inference** remains the stricter runtime boundary.
- Indie allows individual builders/students and teams up to four; each submission enters one track.
- Submissions must be original work and respect third-party rights. Open-source components are expressly allowed when licenses are followed and the project enhances or builds upon them.
- Entrants retain IP ownership while granting organizers a broad perpetual, irrevocable, worldwide, royalty-free, non-exclusive license to use, modify, publish, distribute and create derivative works from submissions.
- The rules identify the [Cerebral Valley submission portal](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit).

The publicly retrieved [participant details page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details) includes the event overview and rules, but does not establish a three-minute video limit, mandatory public repo, “new work only during the event” clause, anti-project list or exact separate pass/fail model-use gate.
Keep those submission-specific items pending participant/portal instructions. A three-minute recording and a reviewable repository remain working deliverables, not verified duration/publication mandates.
Do not treat participant notes as official requirements or predict a judge score from the plan.

If a milestone slips, remove optional integrations, extra variations, generated audio and decorative UI first.
Reduce breadth within each kit by reusing approved assets; preserve all four verticals, channel completeness, one multi-scene Reel each, evidence and final quality review.
If a P0 capability remains blocked, report it honestly rather than silently redefine completion.

## 11. Evaluation and demonstration

Freeze a source snapshot and authorized assets for each business, with provenance and acquisition time.
Compare direct generation against the full pipeline using the same permitted inputs and source snapshot; record model roles, calls, usage and any budget differences.
If an additional end-to-end comparison gives only a URL to the baseline, label that separately: it also measures retrieval advantages.
Blind human review scores groundedness, differentiation, channel suitability, visual authenticity and actionability on a 1–5 anchored rubric.
Use the automated critic as a diagnostic, not the sole judge of its own pipeline. Include owner preference when available.

Acceptance targets: 4/4 complete kits, 4/4 playable Reels, zero critical fabricated claims in ready outputs, complete channel manifests, final quality/hash checks passing, and human mean at least 4/5.
Report measured results even when targets are missed; never replace absent reviews or unrun cases with passing scores.
Record total/failed/skipped cases, unsupported claims, first-pass and final asset failures, latency, usage, recovery behavior and actual costs when available.
Campaign intent, inquiry, booking and revenue remain separate metrics; no conversion uplift claim without a valid measured comparison.

The demo shows one real research decision, its evidence, selected/rejected opportunities, the coordinated kit, a playable Reel and one actual failure/correction.
End with the four vertical outputs and honest evaluation results. Label cached replays and synthetic fixtures explicitly.
Prepare the recording and repository materials against confirmed event requirements; keep any three-minute duration a working target until verified.

## 12. Immediate next actions

1. Preserve the working concept pipeline and its tested evidence, persistence and export boundaries; keep current results in README and the demo guide.
2. Strengthen the completed bakery URL-to-kit flow with locality, original source material and comparable customer/competitor evidence; retain explicit unknowns where unavailable.
3. Extend the tested image generation and official-media path to authorized owner uploads/connected media and reference editing, preserving real product/person identity. Do not treat an illustration as an original photo.
4. Add contextual final critique and exact-version owner approvals, including removal of review/implementation language from consumer copy while preserving provenance in the review report.
5. Improve the real hero concept with authorized imagery and evaluate real/sourced cases across all four verticals; synthetic demonstrations do not satisfy that benchmark.
