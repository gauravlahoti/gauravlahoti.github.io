# Spec: LinkedIn posts ("Writing" section)

## Overview
Add a new top-level **Writing** section to the portfolio that surfaces the user's LinkedIn posts about agents and AI. Each post renders as a collapsed accordion row showing only the first line of the post + its date; clicking a row expands inline to a short excerpt followed by a "Read full post on LinkedIn ↗" outbound link. Source of truth is a new `assets/js/data/posts.json` file (newest-first), populated by a one-shot Node helper at `scripts/add-post.mjs` that takes a LinkedIn post URL, scrapes its OpenGraph meta with a crawler User-Agent, and prepends the parsed entry. No runtime fetch from LinkedIn, no third-party RSS bridge, no backend, no npm dependencies — keeps the "git clone → python3 -m http.server → working site" rule intact. The accordion uses native `<details>`/`<summary>` so keyboard navigation, focus management, and screen-reader semantics come for free.

## Depends on
- Spec 01 (foundation) — design tokens, section layout, nav structure
- Spec 06 (bento) — `.cap-card` styling pattern that `.post` borrows from
- Spec 13 (mobile compatibility) — tap-target rules and breakpoints

## Routes
No backend.

## Database changes
No database.

## Templates
- **Create:**
  - `assets/js/data/posts.json` — flat array of post entries, newest-first. Initially empty `[]` or seeded with 2–3 hand-picked entries.
  - `assets/js/posts-list.js` — render module. Exports `initPostsList(root) → { destroy }`. Fetches `posts.json`, builds `<details class="post">` rows into the section root.
  - `scripts/add-post.mjs` — Node 18+ ESM CLI. Takes a LinkedIn post URL, fetches OG meta with `User-Agent: facebookexternalhit/1.1`, prompts for confirmation, prepends to `posts.json`. Zero dependencies (built-in `fetch`, `node:readline/promises`, `node:fs/promises` only).
- **Modify:**
  - `index.html` — insert the new `<section id="writing" class="section section-writing">` between `#bento` and `<footer>`. Section contains an eyebrow (`// writing`), heading (`Field notes`), one-line lede pointing out these are LinkedIn posts, and an empty `<div class="posts-list" data-posts-root></div>` that the JS module fills. Add a `<a href="#writing" data-cursor="magnet">Writing</a>` nav entry inside `.nav-links`, between the existing `About` link and the `Resume` trigger.
  - `assets/js/main.js` — add an `initPostsListWhenVisible()` function modeled exactly on the existing `initTrajectoryWhenVisible()` (300px IntersectionObserver `rootMargin`, disconnect on first hit, dynamic `import("./posts-list.js")`, store result on `window.__postsList` for debugging). Call it from the bootstrap block immediately after `initTrajectoryWhenVisible(profile)`. The module loads its own data file, so no `profile` argument is needed.
  - `assets/css/components.css` — append rules for `.posts-list`, `.post`, `.post-summary`, `.post-title`, `.post-date`, `.post-body`, `.post-excerpt`, `.post-link`. Token reuse only.
  - `assets/css/layout.css` — add a `.section-writing` block only if vertical rhythm needs tightening. Likely inherits `.section` defaults with no override.

## Files to change
- `index.html`
- `assets/js/main.js`
- `assets/css/components.css`
- `assets/css/layout.css` (only if needed)

## Files to create
- `assets/js/data/posts.json`
- `assets/js/posts-list.js`
- `scripts/add-post.mjs`

## New dependencies
None. The helper script is intentionally Node-stdlib only — no npm install step, no `package.json`, nothing that lives at runtime.

## Rules for implementation
- All post content lives in `assets/js/data/posts.json`. Markup stays template-only.
- CSS variables only — never hardcode hex. All colors, spacing, type scale come from `assets/css/base.css` (`--bg-elev`, `--border`, `--border-strong`, `--accent`, `--ink`, `--ink-muted`, `--space-*`, `--radius-md`, `--text-*`, `--font-sans`, `--font-mono`, `--dur-base`, `--ease-out`).
- One JS module per surface. `posts-list.js` lazy-loads on viewport entry — does not block first paint or compete with the hero canvas.
- No npm, no bundler, no build step. The render path is HTML + ES module + JSON fetch only.
- Use native `<details>` / `<summary>` for the accordion. Hide the default disclosure marker (`summary { list-style: none }` and `summary::-webkit-details-marker { display: none }`); render a custom `::before` triangle that rotates 90° on `[open]`. No JS state machine for expand/collapse.
- All text from `posts.json` rendered via `textContent` only — no `innerHTML`. The JSON is trusted but the helper script writes parsed strings from external HTML, so treat content as untrusted at render time.
- Outbound LinkedIn anchors must use `target="_blank"` and `rel="noopener noreferrer"`.
- Multiple rows can be open simultaneously (no force-close on expand).
- Empty or missing `posts.json` → render nothing, log a single console warning, no broken layout shell.
- Respect `prefers-reduced-motion`. Default browser accordion behavior is non-animated, so this needs no explicit handling — but do not add custom expand animations that ignore the preference.
- Minimum tap target on summary rows ≥ 44px (WCAG 2.5.5).
- Keyboard interaction: Tab focuses the summary, Enter/Space toggles open/closed, focus ring uses `var(--accent)` on `:focus-visible` (matches existing nav and chip focus treatment).
- The helper script must:
  - Validate that the input URL is `linkedin.com/posts/...` or `linkedin.com/feed/update/...`. Reject anything else with a clear message.
  - Dedupe against the existing `posts.json` by URL and abort cleanly if already present.
  - Use `User-Agent: facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)` — LinkedIn exposes OG tags to known crawler UAs that it gates from a normal browser User-Agent.
  - Parse `og:title`, `og:description`, decode HTML entities. Derive `firstLine` from the first sentence/line of `og:description`, truncated at 120 chars on a word boundary. Excerpt = full `og:description`. Date defaults to today's ISO date.
  - Print the parsed entry and prompt `Append? [Y/n/edit]`. `edit` opens `$EDITOR` on a temp JSON draft for manual fixup before write.
  - Write atomically (temp file + rename), pretty-printed 2-space JSON, prepending the new entry so newest is first.
  - Never mutate `profile.json` or any other file outside `assets/js/data/posts.json`.
  - Fall back to interactive manual-entry mode if the fetch returns non-2xx or HTML lacks `og:description` (handles deleted/private posts gracefully).

## Definition of done
Verifiable in a browser at `http://localhost:5173` (via `python3 -m http.server 5173`).

1. **Nav entry.** A new "Writing" link sits between "About" and "Resume" in the top nav. Clicking it scrolls smoothly to the new section. Hover treatment matches the other nav links (cursor magnet + accent on hover).
2. **Section placement.** The Writing section appears between the Capabilities (`#bento`) and the footer. Eyebrow `// writing`, heading "Field notes", and the one-line lede are visible and styled consistently with the other section headers.
3. **Lazy load.** With DevTools Network panel open and cleared, `posts.json` and `posts-list.js` only fetch when the Writing section approaches the viewport (300px rootMargin). They do not load on initial page render.
4. **Empty state.** With `posts.json` set to `[]`, the section renders header + lede + empty list, no console errors, no layout break.
5. **Populated state.** With 3+ entries in `posts.json`, each renders as a collapsed row showing `firstLine` + formatted date right-aligned. Marker (▸) is visible to the left of the title.
6. **Expand / collapse.** Clicking any row expands it inline showing the excerpt and a cyan "Read full post on LinkedIn ↗" link. Marker rotates from ▸ to ▾. Clicking again collapses. Multiple rows can be open at once.
7. **Outbound link.** The "Read full post on LinkedIn ↗" anchor opens the URL in a new tab. DevTools Elements panel confirms `target="_blank"` and `rel="noopener noreferrer"`.
8. **Keyboard navigation.** Tab focuses a summary row → cyan focus ring visible. Enter and Space both toggle open/closed. Tab from an open summary moves focus into the body and onto the LinkedIn link. Shift+Tab returns cleanly. No focus traps.
9. **Mobile.** At 360 / 390 / 768 widths (DevTools device emulation): no horizontal scroll on the page; summary rows are at least 44px tall (`getBoundingClientRect().height ≥ 44`); title and date wrap onto separate lines if the row is too narrow rather than overlapping; expanded body content fits within the viewport with no clipping.
10. **a11y audit.** Lighthouse Accessibility score on the page stays at the existing baseline (≥ 95) with the section populated. axe DevTools scan reports zero new violations attributable to the Writing section.
11. **`prefers-reduced-motion`.** With the OS preference enabled, the accordion still toggles (browser default behavior). No custom expand animations run anywhere on the section.
12. **No console errors** during full-page scroll-through with the Writing section populated.
13. **Helper script — happy path.** `node scripts/add-post.mjs https://www.linkedin.com/posts/glahoti_<slug>` (against a real public post) prints the parsed `firstLine`, excerpt, and date; prompts for confirmation; on `Y` prepends the entry to `posts.json` (verified via `git diff assets/js/data/posts.json`). Reloading the site shows the new post at the top of the accordion list.
14. **Helper script — dedupe.** Re-running with the same URL exits with `Already in posts.json (firstLine: "...")`. `git diff` shows no changes.
15. **Helper script — bad URL.** Running with a non-LinkedIn URL exits with a clear error message and a non-zero exit code. No files modified.
16. **Helper script — fetch failure.** Running against a private/deleted post URL drops into the interactive manual-entry prompt instead of crashing. Cancelling exits with status 1 and no file changes.
17. **No new dependencies.** `git status` shows no new `package.json` or `node_modules`. The helper script runs on a stock Node 18+ install with zero `npm install` step.
