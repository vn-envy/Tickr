# Tickr demo video

`tickr-demo.mp4` (2:18, 1920x1080) records a real Autopilot run on Tickr's hosted Modal deployment on 5 November 2026. The deployment has since been stopped to save cost.

- **Run:** Grandma Daphne's Bakehouse, Hyderabad, from its official website (`grandmadaphnes.com`) with the goal "Get the bakery's story out to differentiate it from other bakeries".
- **Code:** deployed commit `d338437`.
- **Result:** the kit was ready 3 min 41 s after pressing Run.
  - 12 site photos were studied and 3 set aside with reasons.
  - SAM 3.1 made 4 cutouts. The mask-quality gate rejected 1 fragmented mask, and that photo was shown uncut.
  - It produced a depth Reel and the full channel kit.
  - The Spark critic found no blocking issues.
- **Approval:** none recorded. The video shows the approval block but never presses it.

The video is a screen recording of the live app. The waiting time is sped up about 7x and labelled as sped up; intake and the finished kit play at real speed. Labels name the Meta model working at each step.

## Timeline

| Time | Section | On screen |
| --- | --- | --- |
| 0:00-0:32 | Problem | Four problem beats, then the Tickr reveal |
| 0:32-1:01 | Intake | Link and goal typed into the real intake at real speed. Discover and Research start: "MUSE SPARK · Native web search with citations" |
| 1:01-1:29 | Autopilot at work | Sped up. Muse Spark picks the idea and draws grounded boxes on every photo, sets risky photos aside, SAM 3.1 cuts out the products, a depth Reel renders from real pixels, and the Spark critic reviews it |
| 1:29-2:08 | The kit | The real Reel plays, then the carousel and channels, critic findings and the one approval bound to the exact files |
| 2:08-2:18 | Close | Run stats; "Powered by Muse Spark · SAM 3.1 · Muse Image, hosted on Modal" |

## Narration

The voiceover was generated with OpenAI `gpt-4o-mini-tts` (voice "coral") for this video only. Tickr itself uses only Meta-hosted models. The audio files are in `demo/voiceover/`.

**Problem.** Every neighbourhood cafe is now competing online. Customers decide where to eat from what they see on Instagram, Facebook and WhatsApp, this week. But an agency costs more than a week of sales. AI video tools redraw the product, so the cake in the ad isn't the cake in the shop. And one good post isn't a campaign. Meet Tickr: one link, one goal, a finished campaign, built on Meta's models.

**Live run.** Here's Grandma Daphne's Bakehouse in Hyderabad. We paste their website, tell Tickr the goal, and press run. That's the last thing the owner does. Muse Spark takes over. It searches the web with citations to learn who the business is, reads the site, and picks the strongest campaign idea for the goal. Then it studies every real photo, rates each one against the goal and draws a grounded box around the product. Anything risky is set aside, with the reason. Now the magic: Spark's box becomes a SAM 3.1 prompt, and SAM cuts out the exact product. Real pixels, not a redraw. And if a mask isn't clean, Tickr shows the real photo instead. Tickr renders a depth Reel and the full kit, and before the owner sees anything, a Spark critic watches the Reel and checks every still. Under four minutes, start to finish.

**Outcomes.** Here's what comes back. A vertical Reel built from the bakery's own desserts. A carousel, a feed post, Stories, a Facebook ad and WhatsApp creative. Every format, one story, every frame labelled with where its pixels came from. And one approval, bound to the exact files, because Tickr never publishes, spends budget or messages anyone on its own.

**Close.** Tickr. One link, one goal, a finished campaign. Powered by Muse Spark, SAM 3.1 and Muse Image.

## Sound

The music bed and launch sound effects were synthesised with ffmpeg for this video, so the video contains no third-party audio. The final mix is about -14 LUFS.
