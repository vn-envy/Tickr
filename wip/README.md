# Work in progress (not part of the deployed app)

`website-identity-fallback.patch` adds a fallback for when Meta discovery returns no usable sources for a link the owner supplies (a website). Tickr then reads that page once, through its own bounded official-site reader. It takes the brand name from the site's own metadata (`og:site_name`, `<title>`, `<h1>`) and accepts the name only if it matches the domain or appears in the page text. The page is recorded as a cited `direct_website` source, and the branch stays unresolved.

It was written to fix a hosted run (Labonel Fine Baking, 5 November 2026) that stopped at "needs more information". In that run, Meta search returned the site without any page text.

Status: the implementation and its related unit tests passed, but the independent review and the full test suite were not completed before the demo deadline. It is not applied to the codebase.

To try it:

```bash
git apply wip/website-identity-fallback.patch
```

Then run `npm run check`.
