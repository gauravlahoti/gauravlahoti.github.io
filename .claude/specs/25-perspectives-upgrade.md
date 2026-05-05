# Spec: Perspectives row upgrade + LinkedIn recommendations section

> **Depends on / extends:** spec **#14** (LinkedIn posts list, `posts.json`, `posts-list.js`, `/add-post` slash command + `scripts/add-post.mjs`), spec **#18** (credibility microcopy patterns).

## Overview

The Perspectives section today is a list of `<details>` rows. The summary line shows only a title and a date; clicking expands a 1-line excerpt and a "Read full post on LinkedIn" link. Two compounding problems:

1. **The click is unearned.** A visitor has zero signal that any specific row is worth their attention. Title-only rows force a leap of faith on a page where every other section is doing the persuading.
2. **The single strongest unused social-proof asset on the page — named LinkedIn recommendations — is absent.** Recommendations are the highest-trust form of endorsement: real names, real titles, written by humans who put their job on the line behind the words. They beat logos and certifications because they're verifiable in one click.

This spec rebuilds rows so a visitor can decide in under 2 seconds whether a post is for them (always-visible 2-line preview, date, topic tag, external-link affordance, full row is a single anchor to LinkedIn — no inline expand, no dead-end). It then adds a curated **What people say** section with 3–4 hand-picked recommendation pull-quotes immediately after Perspectives, each with name + title + relationship + a "Read full ↗" link to the LinkedIn recommendations tab.

A first-time visitor scrolling through the Perspectives section now sees rows that read like a feed (title, two lines of body, date, `#tag`) and can click anywhere on a row to land on the actual LinkedIn post. Immediately below, three or four short pull-quotes from named senior people supply the human-written social proof the page was missing. The two sections sit next to each other deliberately: *here is what I think*, then *here is what people who worked with me say*, then the resume CTA.

## Goals

1. **Always-visible row preview.** Each Perspectives row shows: title (1-line clamp), 2-line body preview from `excerpt`, date, optional `#tag`, and a trailing `↗` glyph in the corner that signals "opens elsewhere." No `<details>`/`<summary>`. No inline expand.
2. **Whole-row anchor.** Each row is a single `<a target="_blank" rel="noopener">` linking to the LinkedIn post. Click anywhere → LinkedIn in a new tab. One affordance, no dead-ends.
3. **Topic tags.** Each row carries a single optional `tag` (`agents`, `infra`, `delivery`, `ai`, `leadership`, `craft`, etc.) rendered as `#tag` in mono mint. Decorative + scannable. No filter UI.
4. **`#recommendations` section.** New section after `#writing` and before the resume CTA. 3–4 quote cards, each with: 1–2 sentence pull-quote (the punchiest line from the actual recommendation), recommender's name, title, relationship to Gaurav, and a "Read full ↗" link to the LinkedIn recommendations tab.
5. **Nav link.** Add an anchor link in the main nav for `#recommendations`.
6. **Lazy-init preserved.** New module follows the IntersectionObserver pattern used for `#writing` — Three.js, posts, and recommendations all stay off the critical path.
7. **Content stays in JSON.** Adding a post or replacing a recommendation never touches HTML.

## Non-goals

- **Engagement metrics on rows** (likes / comments / reposts / impressions). Considered and dropped. There is no clean third-party LinkedIn API for personal `ugcPost` engagement counts; the Marketing API is gated behind partner approval and only serves a signed-in user's own pages, not arbitrary post stats. Scraping is fragile, against ToS, and a static GitHub Pages site has nowhere stable to run a scraper from. Manual monthly refresh works in theory but the moment the cadence slips, "1.2k views" from six months ago next to a post dated last week destroys trust faster than no number ever could. Cleanest move: don't show numbers we can't keep honest. (If a sustainable source emerges later, this is a follow-up spec.)
- **Tag filter chips.** Visible row count is small (~6–12 curated posts). A filter UI is dead weight at this scale; revisit only if the count exceeds ~15.
- **Programmatic recommendation pulling.** LinkedIn doesn't expose recommendations via any public API. Manual curation in `profile.json` is the realistic path.
- **Changes to OG-meta scrape behaviour** in `/add-post` beyond accepting an optional `--tag` flag.
- **A second nav flyout** for recommendations. The existing posts flyout (`initPostsFlyout`) stays as-is.
- **Storing the full text** of recommendations on the page. Spec stores only the curated 1–2 sentence pull-quote + a link to the full text on LinkedIn.

## Data shape

### `assets/js/data/posts.json`

Stays a flat array. One optional field added per entry:

```jsonc
[
  {
    "url": "https://www.linkedin.com/posts/glahoti_anthropic-claudecode-...",
    "firstLine": "Unleashing the power of Claude Code Sub-agents",
    "excerpt": "I discovered a single question rule for sub-agents that cuts orchestration loops in half. Here's how to apply it.",
    "date": "2026-05-04",
    "tag": "agents"
  }
]
```

Rules:

- `tag` — optional, single lowercase token, free-form (no enum enforcement). Suggested vocabulary: `agents`, `infra`, `delivery`, `ai`, `leadership`, `craft`. Posts without a tag render with the tag slot empty (no placeholder text, no dash).
- `excerpt` — already exists, but is now load-bearing because it's always visible. Spec checklist requires backfilling any thin or empty `excerpt` strings on the curated set. Target length: ~120–180 characters (so the 2-line clamp lands cleanly without obvious truncation on most rows).
- `firstLine`, `url`, `date` — unchanged.
- No wrapper object. The JSON file stays a bare array exactly as today.

### `assets/js/data/profile.json`

Add a new top-level key, alongside existing `name`, `title`, `bio`, `links`, `experience`, `certifications`, etc.:

```jsonc
"recommendations": [
  {
    "name": "Jane Doe",
    "title": "VP Engineering, Acme",
    "relationship": "Worked with Gaurav at Deloitte (2022–2024)",
    "quote": "He's the architect I send into the room when the problem is fuzzy and the stakes are real. Two weeks in, he had the team building the right thing.",
    "url": "https://www.linkedin.com/in/glahoti/details/recommendations/"
  }
]
```

Rules:

- All five fields required per entry. No optional fields — a recommendation without an attribution is decoration, not proof.
- `quote` — verbatim 1–2 sentences pulled from the actual LinkedIn recommendation. Spec instructs the maintainer: don't paraphrase, don't combine, don't soften. The visitor will click `url` to verify; if the quote isn't on that page, the section becomes a liability.
- `url` — the LinkedIn recommendations tab on the profile (typically the same URL for every entry); spec leaves the field per-entry so a future per-recommender deep link is possible without schema change.
- 3–4 entries. Spec checklist says: each entry highlights a *different dimension* (e.g., one technical depth, one delivery / leadership, one client / stakeholder, one human — mentorship, calm under pressure). Avoid four entries that say the same thing.

## Architecture

### Row markup (rebuilt in `posts-list.js`)

Old (today): `<details>` → `<summary>` (title + date + ▸ chevron) → `<p class="post-excerpt">` → `<a class="post-link">`. Click the summary to expand.

New: a single block-level `<a>` containing four spans. No `<details>`, no `<summary>`, no JS click handlers — just an anchor.

```html
<a class="post-row" href="https://www.linkedin.com/posts/..."
   target="_blank" rel="noopener" data-tag="agents">
  <span class="post-row-title">Unleashing the power of Claude Code Sub-agents</span>
  <span class="post-row-preview">I discovered a single question rule for sub-agents that cuts orchestration loops in half. Here's how to apply it.</span>
  <span class="post-row-foot">
    <time class="post-row-date" datetime="2026-05-04">2026-05-04</time>
    <span class="post-row-tag">#agents</span>
  </span>
  <span class="post-row-arrow" aria-hidden="true">↗</span>
</a>
```

Rendering rules:

- Whole row clickable. Same accessible name as the title (the link text concatenation works fine; no extra `aria-label` needed since the visible text is unambiguous).
- Tag slot empty when no tag.
- `<time>` shows the ISO date verbatim (matches existing `formatDate` behaviour from `posts-list.js`).
- The trailing `↗` is an absolutely-positioned span in the top-right corner of the row, styled in `var(--ink-muted)`; on hover it brightens to `var(--accent)` and slides `translate(2px, -2px)` matching the convention from `.nav-flyout-link::after`.

### `initPostsList(root)` — internal rewrite

Keep the export name and entry contract. Internals:

1. Fetch `assets/js/data/posts.json` (`cache: "no-cache"`, same as today).
2. Sort newest-first by `date` (same logic as today).
3. For each entry, create a `<a class="post-row">` element with the four spans above. Set `href` to `entry.url`, `target="_blank"`, `rel="noopener"`. If `entry.tag`, set `data-tag` and render `#${tag}` inside `.post-row-tag`; otherwise leave that span empty.
4. Replace the `posts.json` placeholder content. Remove all `<details>`-toggle wiring.

`initPostsFlyout(root)` — unchanged. Keep top-3 dropdown behaviour.

Failure mode: same as today — silently leave the placeholder if fetch fails. (The page functions without it; no toasts.)

### Recommendations section

**HTML wrapper** in `index.html`, inserted after `<section id="writing">` and before whatever currently follows it (resume-gate / contact CTA):

```html
<section id="recommendations" class="section section-recos" aria-label="Recommendations">
  <header class="recos-header">
    <p class="recos-eyebrow">// recommendations</p>
    <h2 class="recos-title">What people say.</h2>
    <p class="recos-sub">A few of the people I've worked with, in their own words. Each quote is pulled verbatim from a LinkedIn recommendation — click through to verify.</p>
  </header>
  <div class="recos-grid" data-recos-root></div>
</section>
```

**Module** at `assets/js/recommendations.js`:

```js
export async function initRecommendations(root) {
  const profile = await fetchProfile();          // reuse existing profile loader if present, else inline fetch
  const recos = profile?.recommendations ?? [];
  if (!recos.length) return;
  for (const reco of recos) root.appendChild(renderReco(reco));
}
```

`renderReco(reco)` builds:

```html
<article class="reco-card">
  <blockquote class="reco-quote">"…verbatim 1–2 sentences…"</blockquote>
  <footer class="reco-attrib">
    <span class="reco-name">Jane Doe</span>
    <span class="reco-title">VP Engineering, Acme</span>
    <span class="reco-rel">Worked with Gaurav at Deloitte (2022–2024)</span>
  </footer>
  <a class="reco-link" href="https://www.linkedin.com/in/glahoti/details/recommendations/" target="_blank" rel="noopener">Read full ↗</a>
</article>
```

Profile loader: if `assets/js/main.js` already has a memoized `fetchProfile()` (it currently fetches `profile.json` for several modules), import and reuse it. If not, do a local `fetch` with `cache: "no-cache"` matching the convention used in `posts-list.js`.

### Lazy-init wiring (`assets/js/main.js`)

Find the existing IntersectionObserver block that wires `#writing` to `initPostsList`. Add a sibling entry for `#recommendations` → `initRecommendations`. Same observer instance is fine; just add the target. No new observer, no module-level fetch on page load — recommendations don't load until the section enters the viewport.

### Nav link

Add a new `<a href="#recommendations">Recommendations</a>` (or `Endorsements` — implementer's call, spec defaults to **Recommendations**) to the main nav, between the existing Perspectives link and whatever follows (Contact / Resume). Mobile nav copy mirrors desktop.

### `/add-post` flow

`scripts/add-post.mjs` accepts a new optional `--tag <token>` flag. When provided, the flag value is written into the new post's `tag` field. When absent, no `tag` field is written; operator can fill in by hand. No tag validation — free-form.

`.claude/commands/add-post.md` gets a one-paragraph addendum that prompts the operator to supply a tag when possible:

> After OG-meta extraction, prompt the user: *"Tag for this post? (agents / infra / delivery / ai / leadership / craft / blank to skip)"*. Pass through to `add-post.mjs` as `--tag <token>` if provided.

## Visual treatment

### Row layout (desktop)

```
┌────────────────────────────────────────────────────────┐
│ Unleashing the power of Claude Code Sub-agents      ↗  │
│ I discovered a single question rule for sub-agents     │
│ that cuts orchestration loops in half. Here's how…     │
│ 2026-05-04                                  #agents    │
└────────────────────────────────────────────────────────┘
```

CSS rules to add in `components.css` (replace the existing `.post`, `.post-summary`, `.post-summary::before`, `.post-excerpt`, `.post-link` blocks):

- `.post-row` — block anchor, `display: grid`, `grid-template-areas: "title arrow" "preview preview" "foot foot"`, `padding: var(--space-12) var(--space-14)`, `border: 1px solid var(--border)`, `border-radius: var(--radius-md)`, `background: var(--bg-elev)`, `color: inherit`, `text-decoration: none`, `position: relative`, `transition: border-color 160ms, box-shadow 160ms`.
- `.post-row:hover, .post-row:focus-visible` — `border-color: var(--border-strong)`, `box-shadow: 0 0 0 1px var(--accent-glow) inset`.
- `.post-row-title` — `grid-area: title`, `color: var(--ink-strong)`, `font-weight: 600`, `font-size: var(--text-lg)`, `line-height: 1.35`, `overflow: hidden`, `text-overflow: ellipsis`, `white-space: nowrap`.
- `.post-row-preview` — `grid-area: preview`, `color: var(--ink-muted)`, `line-height: 1.55`, `display: -webkit-box`, `-webkit-line-clamp: 2`, `-webkit-box-orient: vertical`, `overflow: hidden`, `margin-top: var(--space-6)`.
- `.post-row-foot` — `grid-area: foot`, `display: flex`, `justify-content: space-between`, `align-items: baseline`, `gap: var(--space-8)`, `font-family: var(--font-mono)`, `font-size: var(--text-xs)`, `margin-top: var(--space-10)`.
- `.post-row-date` — `color: var(--ink-muted)`.
- `.post-row-tag` — `color: var(--accent)`, `letter-spacing: 0.02em`. (Empty span renders nothing.)
- `.post-row-arrow` — `grid-area: arrow`, `align-self: start`, `justify-self: end`, `color: var(--ink-muted)`, `font-family: var(--font-mono)`, `transition: transform 160ms, color 160ms`.
- `.post-row:hover .post-row-arrow, .post-row:focus-visible .post-row-arrow` — `color: var(--accent)`, `transform: translate(2px, -2px)`.
- Mobile (`@media (max-width: 600px)`): same layout, smaller padding (`var(--space-10) var(--space-12)`), title font drops one step, preview clamp stays at 2 lines.
- `prefers-reduced-motion`: disable the `transform` and the `box-shadow` transition; border colour change still applies.

### Recommendation card (desktop)

```
┌─────────────────────────────────────────┐
│ "He's the architect I send into the     │
│  room when the problem is fuzzy and     │
│  the stakes are real."                  │
│                                         │
│  Jane Doe                               │
│  VP Engineering, Acme                   │
│  Worked with Gaurav at Deloitte         │
│                          Read full ↗    │
└─────────────────────────────────────────┘
```

CSS rules to add in `components.css`:

- `.recos-header` — mirrors `.posts-header` (max-width 760px, gap `var(--space-10)`, eyebrow + title + sub).
- `.recos-grid` — `display: grid`, `grid-template-columns: repeat(auto-fit, minmax(320px, 1fr))`, `gap: var(--space-12)`, `max-width` matches the posts list container.
- `.reco-card` — `display: grid`, `grid-template-rows: auto 1fr auto`, `padding: var(--space-14)`, `border: 1px solid var(--border)`, `border-radius: var(--radius-md)`, `background: var(--bg-elev)`, `min-height: 220px`.
- `.reco-quote` — `font-size: var(--text-lg)`, `color: var(--ink-strong)`, `line-height: 1.55`, no italic, no quotation marks added by CSS (the literal `"…"` is in the JSON).
- `.reco-attrib` — `display: flex`, `flex-direction: column`, `gap: 2px`, `margin-top: var(--space-12)`.
- `.reco-name` — `color: var(--ink-strong)`, `font-weight: 600`.
- `.reco-title` — `color: var(--ink-muted)`, `font-size: var(--text-sm)`.
- `.reco-rel` — `color: var(--ink-muted)`, `font-family: var(--font-mono)`, `font-size: var(--text-xs)`.
- `.reco-link` — same visual as existing `.post-link` (mint border, accent-soft on hover, "Read full ↗" with sliding arrow). Self-aligns to the bottom-right of the card via `justify-self: end` + `margin-top: var(--space-10)`.
- Mobile (`@media (max-width: 600px)`): `grid-template-columns: 1fr` (one card per row), `min-height: 0`, padding drops to `var(--space-12)`.

### Section rhythm (`layout.css`)

`.section-recos` mirrors the spacing of `.section-writing`. Same vertical rhythm, same content max-width.

## Files to change

- `index.html` — add `<section id="recommendations">` after `#writing`; add nav anchor; mobile nav mirror.
- `assets/js/posts-list.js` — replace `renderPost` and the `<details>` template; keep `initPostsFlyout` untouched.
- `assets/js/data/posts.json` — backfill `tag` on existing entries; backfill any thin `excerpt` strings.
- `assets/js/data/profile.json` — add `recommendations` array (3–4 entries; OK to seed with placeholders that the maintainer replaces with real recommendations before the next deploy).
- `assets/js/main.js` — add lazy-init wiring for `#recommendations` → `initRecommendations`.
- `assets/css/components.css` — replace `.post*` row styles; add `.reco*` styles.
- `assets/css/layout.css` — add `.section-recos` rhythm rule.
- `scripts/add-post.mjs` — accept optional `--tag <token>` flag; write into the new entry when provided.
- `.claude/commands/add-post.md` — addendum prompting for tag during add-post flow.

## Files to create

- `assets/js/recommendations.js` — single-export module: `export async function initRecommendations(root)`.

## Definition of done

- [ ] Every Perspectives row renders with the new flat-link template; clicking anywhere on a row opens the LinkedIn post in a new tab.
- [ ] No row uses `<details>` / `<summary>` anymore.
- [ ] Every row has a non-empty 2-line preview from `excerpt`.
- [ ] Each row in the curated set has a `#tag`. Rows without a tag render cleanly (empty slot, no placeholder).
- [ ] No metrics block, badge, or count anywhere in the rendered HTML — verify visually and via grep.
- [ ] `#recommendations` section appears between `#writing` and the resume CTA, with 3+ cards rendering from `profile.json`.
- [ ] Each card shows quote + name + title + relationship + "Read full ↗" link.
- [ ] Main nav has a link to `#recommendations` (desktop and mobile).
- [ ] Both modules lazy-init via IntersectionObserver — verified in Network tab (`profile.json` is fetched once when `#recommendations` enters the viewport, not on initial load).
- [ ] Nav flyout (`initPostsFlyout`) still renders the top-3 posts correctly.
- [ ] No JS errors in the console on initial load, scroll, or section enter.
- [ ] Lighthouse Performance ≥ 90 on desktop, unchanged from baseline.
- [ ] `prefers-reduced-motion` respected — no row hover transform; only border colour change applies.
- [ ] Mobile layout (375px width) inspected: rows readable, cards stack to 1 column, no overflow.

## Verification steps

1. `python3 -m http.server 5173` → open `http://localhost:5173`.
2. Scroll to `#writing`. Confirm the row layout matches the ASCII mockup. Click a row → opens LinkedIn in a new tab; no inline expand fires; back button returns to the same scroll position.
3. Hover a row → border brightens, ↗ arrow brightens and slides up-and-right. No expand/collapse occurs.
4. Tab to a row with the keyboard → focus ring visible, Enter opens LinkedIn.
5. Scan the rendered DOM in DevTools — confirm zero `<details>` / `<summary>` elements remain in `#writing`.
6. Confirm one row deliberately has no `tag` and renders cleanly (footer shows date only, no orphan `#`).
7. Scroll to `#recommendations`. Confirm 3+ cards render with quote, name, title, relationship, and a "Read full ↗" link. Click the link → opens the LinkedIn recommendations tab in a new tab.
8. Click the new nav link → page scrolls to `#recommendations`.
9. Resize the viewport to 375px wide. Both sections readable, no horizontal scroll, recommendation cards stack 1 column, row preview stays 2 lines clamped.
10. DevTools → Network tab, hard reload: confirm `posts.json` and `profile.json` are each fetched only once, when their owning section enters the viewport (not on initial page load).
11. `grep -ri "metric\|likes\|reposts\|impressions" assets/js assets/css index.html` returns nothing post-implementation. Confirms metrics didn't leak in by accident.
12. Run `node scripts/add-post.mjs <some-linkedin-url> --print --tag agents` and confirm the entry includes `"tag": "agents"`. Run again without the flag and confirm the entry has no `tag` field.
13. Lighthouse desktop run — Performance ≥ 90, Accessibility ≥ 95.
14. Open the page in a clean browser session, enable `prefers-reduced-motion: reduce` in DevTools rendering tab, hover a row — confirm no transform animation; only the border colour transitions.

## Reused functions / patterns

- `initPostsList(root)` — keep export name; rewrite internals only. (`assets/js/posts-list.js:8`)
- `initPostsFlyout(root)` — unchanged.
- IntersectionObserver lazy-init pattern — copy the `#writing` wiring in `assets/js/main.js` for `#recommendations`.
- Existing `↗` Unicode glyph + slide-on-hover convention from `.post-link::after` and `.nav-flyout-link::after`.
- `atomicWriteJson` in `scripts/add-post.mjs` — already in use; reuse for the `--tag` write.
- CSS variables from `base.css`: `--accent`, `--accent-soft`, `--accent-glow`, `--border`, `--border-strong`, `--ink-strong`, `--ink-muted`, `--bg-elev`, `--font-mono`, `--text-xs|sm|lg`, `--space-*`, `--radius-md`. **Spec adds no new variables.**

## Out-of-scope follow-ups

- **Engagement metrics on rows.** Revisit only if a sustainable, ToS-compliant data source emerges (or if a separate spec accepts the manual-monthly-refresh maintenance cost with a freshness gate that hides stale metrics).
- **Tag filter chips.** Worth considering only if visible curated post count grows past ~15.
- **Per-recommender deep links.** The schema already supports a per-entry `url`; a future spec could deep-link to the specific recommendation's anchor on LinkedIn if LinkedIn ever exposes one.
- **Auto-refresh of `posts.json`** via a GitHub Actions cron that re-runs `add-post.mjs` against an RSS or activity feed. Already noted in spec #24's non-goals; same answer applies here.
