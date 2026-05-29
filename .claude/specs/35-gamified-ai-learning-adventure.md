# 35 — Gamified "Learn AI" adventure at `/learn/`

## Overview

A polished, fun, standalone learning game at `/learn/` that teaches **any** visitor — technical or
not — the core ideas of modern AI: what an LLM is, what an AI agent is, how they differ, and the
real use-cases each solves. The player picks one of two original characters (*Sparkfist*, a
spiky-haired energy warrior; *Hopper*, a red-capped jumper) and a content mode (**Tech** for precise
framing, **Plain** for everyday analogies), then walks a world-map of six themed stages. Each stage
is a short interactive mini-challenge (quiz, flip-cards, build-a-bot drag puzzle, sort-the-loop,
LLM-vs-agent buckets, use-case matching) with juicy GSAP feedback. Score and progress persist in
`localStorage` with a resume option, and a recap screen reinforces every concept. The page mirrors
the proven `/agents/` standalone-page pattern: shared nav, one ES module, one stylesheet, GSAP via
CDN, no build step.

## Depends on

- Page-transition module from the `/agents/` work (`assets/js/page-transition.js`) — reused for the
  Neural-Slash wipe between `/` ⇄ `/learn/`.

## Routes

No backend. Fully client-side; no new network calls, no analytics requirement.

## Database changes

No database.

## Frontend changes

- **`learn/index.html`** (new) — standalone shell copied from `agents/index.html`: shared nav header +
  drawer, inline minimal nav-drawer script, `<base href="/">`, `scroll-restore.js` first in `<head>`,
  CSP copied verbatim from the agents page. Mounts `<div data-learn-root>`; loads `assets/css/learn.css`
  and `assets/js/learn-game.js`; GSAP via jsdelivr (SRI + `defer`). "Learn" nav link is active here.
- **`assets/js/learn-game.js`** (new) — entry module. `playEntranceWipe()` on load, fetch `learn.json`,
  build the state store, render one screen at a time into `data-learn-root`, wire `[data-page-link]`
  clicks to `runPageTransition`.
- **`assets/js/learn/state.js`** (new) — pure state machine + `localStorage` persistence (no DOM).
- **`assets/js/learn/characters.js`** (new) — original inline-SVG markup for both characters + pose
  helpers (idle / cheer / hurt).
- **`assets/js/learn/worldmap.js`** (new) — draws the SVG map path + nodes and animates the character
  token along it (snaps under reduced-motion).
- **`assets/js/data/learn.json`** (new) — all stages, questions, answers, and BOTH `tech`/`nontech`
  copy variants. No copy hardcoded in JS.
- **`index.html`** (modified) — add "Learn" link to `.nav-links` and `.nav-drawer-links`; add a
  teaser/CTA card in `<main>` between `#about` and `#perspectives` linking to `/learn/` via
  `data-page-link`.
- **`agents/index.html`** (modified) — add "Learn" link to `.nav-links` and `.nav-drawer-links`.

## CSS changes

- **`assets/css/learn.css`** (new) — page-scoped under `.learn-page`. Screens, world-map, character
  art (inline SVG retinted via a per-character `--char-accent`), interaction widgets, feedback states
  (`.is-correct`/`.is-wrong`), recap. Includes a `@media (prefers-reduced-motion: reduce)` block and a
  `@media (max-width: 767px)` block. Reuses `.btn .btn-ghost` for buttons.

## New dependencies

No new dependencies — GSAP is already loaded via jsdelivr with SRI on the existing pages.

## Rules for implementation

- All learning copy lives in `assets/js/data/learn.json`; never hardcode question/answer strings in JS.
- CSS variables only — never hardcode hex; all tokens come from `:root` in `base.css`.
- Native ES modules with relative imports — no bundler, no npm, no build step.
- Respect `prefers-reduced-motion`: no particle/shake/walk animation; screens stay fully usable; the
  map token snaps to nodes.
- Mobile (≤768px): single-column intro, compact map, full-width panel, no horizontal scroll, tap
  targets ≥ `--tap-min` (44px). Drag-drop works with mouse, touch, AND keyboard.
- Original art and names only — no copyrighted Goku/Mario assets.

## Definition of done

- [ ] `/learn/` loads standalone with shared nav/drawer; "Learn" link active on `/learn/`, present on `/` and `/agents/` nav + drawer.
- [ ] Main `index.html` shows a teaser/CTA card linking to `/learn/` via `data-page-link` (page transition plays).
- [ ] Intro lets the visitor pick one of two original characters + a mode; Start is disabled until both chosen.
- [ ] All 6 stages render the correct interaction type; switching mode swaps all copy from `learn.json` (no hardcoded strings in JS).
- [ ] Every interaction is keyboard-operable (Tab/Enter/arrows), has visible focus rings, ARIA roles/labels, and ≥44px targets; drag-drop works with mouse, touch, and keyboard.
- [ ] Correct answers award points + GSAP feedback + character advances on the map; wrong answers give corrective feedback with no soft-lock (stage always completable).
- [ ] Score and progress persist in `localStorage` (`learn:v1`); reloading mid-game offers "Continue (Stage k/6)"; storage failures fall back gracefully without crashing.
- [ ] Recap screen shows final score, a per-stage concept recap, and replay / switch-mode options.
- [ ] With `prefers-reduced-motion: reduce`: no particle/shake/walk; screens still usable; map token snaps to nodes.
- [ ] Responsive at ≤768px: single-column intro, compact map, full-width panel, no horizontal scroll, ≥44px targets.
- [ ] No CSP violations in console; only `self` + `cdn.jsdelivr.net` (GSAP) used.
- [ ] No hardcoded hex in `learn.css`/`learn-game.js`; all colours via `base.css` tokens.
</content>
