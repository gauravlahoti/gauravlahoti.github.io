# Spec: Auto Sitemap And Insight Pages

## Overview
Spec 103 added `sitemap.xml`, but nothing regenerated it, and `/add-post` never ran the insight page generator. So 6 of 19 posts had no page and were missing from the sitemap. The generator had also drifted from the committed pages: a hardcoded `?v=349`, no CSP meta, and an old inline nav script that layout.css can't open. Re-running it would have broken all 13 existing pages. This spec brings the generator in line with the live pages, generates the 6 missing pages, and runs the generator on every deploy, so the pages and the sitemap can't fall behind `posts.json` again.

## Depends on
- Spec 103 (SEO foundations): `scripts/gen-sitemap.mjs`, `sitemap.xml`.

## Routes
No backend.

## Database changes
No database.

## Templates
- **Create:** 6 pages under `insights/<slug>/index.html`, plus this spec
- **Modify:** `scripts/gen-post-pages.mjs`, `.github/workflows/deploy.yml`, `.claude/commands/add-post.md`, `content/posts.json` (6 new `slug` fields), `sitemap.xml`, the 13 existing insight pages (asset versions only), `CLAUDE.md`

## Files to change
- `scripts/gen-post-pages.mjs`
  - Add the same CSP meta the committed pages carry.
  - Replace the inline nav toggle with `assets/js/insight-nav.js` and `announcement.js`, as on the committed pages.
  - Asset versions: shared files (`base.css`, `layout.css`, `components.css`, `announcement.js`) take the `?v=` that `index.html` uses. Insight-only files (`insight.css`, `insight-nav.js`) get an 8-character content hash.
- `.github/workflows/deploy.yml`: a step before staging runs `node scripts/gen-post-pages.mjs`.
- `.claude/commands/add-post.md`: Step 6 runs the generator locally, which stamps the slug and lets you preview the page.

## Files to create
- `insights/{your-agents-small-decisions-dont-need-an-llm, i-built-an-agent-harness-in-plain-python-where-you-can-watch, my-website-now-has-a-face-a-voice-and-control-of-the-screen, the-badges-came-after-the-building-not-before, my-websites-ai-agent-used-to-only-type-now-it-talks-back-in, i-made-my-website-agentready-with-webmcp-five-tools-no-dom-p}/index.html`

## New dependencies
No new dependencies. Node on the GitHub runner runs the existing zero-dependency scripts.

## Rules for implementation
- All identity content lives in `content/profile.json`.
- CSS variables only. Never hardcode hex.
- One JS module per visualization; lazy-load on viewport entry.
- No npm, no bundler, no Node toolchain for the site itself. Build-time scripts stay dependency-free.
- Respect `prefers-reduced-motion`.
- Mobile fallbacks for every WebGL/Three.js feature.
- The generator must be idempotent: a re-run on unchanged inputs leaves every file byte-identical.

## Addendum: one headline, lastmod everywhere
- **One headline.** The owner chose `Cloud & AI-Native Architect`, to match LinkedIn. `<title>`, og/twitter titles and the descriptions in `index.html` use it, as do the JSON-LD `jobTitle`, `profile.json` and `llms.txt`, which already said it.
  - The mismatch people saw came from cached copies of the pre-spec-103 `main.js`, whose `setTitle()` rewrote the tab title. `main.js?v=` is bumped from 415 to 416 so every browser fetches the fixed script.
- **lastmod on static pages.** `gen-sitemap.mjs` dates each of the 7 static pages from the newest git commit touching the page or the content JSON it renders. `deploy.yml` checks out with `fetch-depth: 0` so CI can see that history. Insights keep their post date.

## Definition of done
- [ ] Running `node scripts/gen-post-pages.mjs` twice in a row produces no diff on the second run
- [ ] The 13 existing pages differ from `main` only in `?v=` values, plus two meta descriptions re-truncated from the current excerpts
- [ ] Each of the 6 new insight pages loads locally with styles, a working nav drawer, and no CSP errors in the console
- [ ] `sitemap.xml` passes `xmllint --noout` and lists 26 URLs (7 pages + 19 insights)
- [ ] After deploy, the live sitemap lists 26 URLs and a new insight URL returns 200
- [ ] Every sitemap `<url>` has a `<lastmod>`, and the static pages show real commit dates, not the deploy date
- [ ] The home tab title and the og:title both read `Gaurav Lahoti | Cloud & AI-Native Architect`, and the tab title doesn't change after the page loads
