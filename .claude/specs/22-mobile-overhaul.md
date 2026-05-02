# Spec: Mobile Overhaul

> **Reverses parts of spec 13.** Spec 13 fought to keep the hero WebGL canvas alive on phones with a finer-grained mobile profile and an FPS watchdog. Real-world feedback says the result still feels heavy, text-dense, and slow to a first tap. This spec accepts the trade and ships a true static fallback on `<768px` plus a top-to-bottom mobile-only restructure (section rhythm, density collapse, a persistent bottom-bar CTA, a bottom-sheet agent panel). The portrait stays visible at every breakpoint (spec 13's hard rule is preserved).

## Overview
Most arrivals to the portfolio come from LinkedIn — overwhelmingly mobile. Today the mobile experience is roughly 4–6 full screen-heights of scroll before the footer because every section enforces `min-height: 80vh` and `--space-24` (6rem) padding at every viewport. Capabilities (3 axes × 6 cards) collapses to a single column at <880px and becomes an 18-card text wall; Career Trajectory keeps all 7 roles fully expanded; the hero still loads Three.js even though the only visual that survives is a few dozen nodes; and the only above-the-fold call-to-action on mobile is a floating button that doesn't even mount until `requestIdleCallback` fires. This spec rebuilds the mobile experience as a tight, opinionated landing page: compress section rhythm, collapse the dense sections behind tap-to-expand summaries, replace the WebGL hero with an intentional static SVG mesh on phones, and replace the floating FAB with a persistent two-button bottom-bar (`Ask my agent` / `Resume`) that opens the agent as a drag-dismissible bottom sheet. Desktop is untouched — every change gates on `@media (max-width: 767px)` or `matchMedia("(max-width: 767px)")`.

## Depends on
- Spec 01 (foundation) — design tokens, section shell, nav.
- Spec 02 (hero shader) — hero canvas, identity line, fallback element this spec upgrades.
- Spec 04 (knowledge graph / trajectory) — `trajectory.js` measure + rail-animation logic that must re-run when companies are toggled.
- Spec 06 (bento / capabilities) — 3-axis card grid this spec collapses on mobile.
- Spec 10 (cert rail) — the 8-badge rail this spec hides behind a single chip on mobile.
- Spec 13 (mobile compatibility) — keeps spec 13's portrait-always-visible, safe-area-inset, 100svh, and WCAG tap-target rules. Reverses spec 13's "hero canvas runs on mobile" rule (see Rationale below).
- Spec 20 + 21 (agent chat widget + ADK Cloud Run) — the panel this spec rehouses as a bottom sheet on mobile and the open-handler the new bottom-bar reuses.

## Routes
No backend.

## Database changes
No database.

## Templates
- **Create:** none.
- **Modify:**
  - `index.html` —
    - Add a mobile-only in-hero CTA: `<button class="hero-cta-mobile">Ask my agent →</button>` rendered under the tagline. Wired to the same panel-open handler the FAB uses today.
    - Add the persistent mobile bottom-bar markup near the end of `<body>`: a fixed two-button bar (`Ask my agent` + `Resume`) inside an `<aside class="mobile-bottombar">` with `aria-label="Primary actions"`. Buttons reuse the existing agent-open and `data-resume-trigger` handlers.
    - Add a mobile-only sticky section-progress strip near the top: `<nav class="mobile-section-progress" aria-hidden="true">` with one dot per section. Updated by an IntersectionObserver in `main.js`.
    - Replace the inline cert rail with a single chip on mobile: `<button class="cert-rail-chip-mobile">8 certifications · AWS · GCP · Azure</button>` that opens the same cert-tile popover behaviour spec 13 wired (so the underlying interaction surface stays the same). Desktop continues to render the existing `.cert-rail`.
    - Add `srcset` (and `sizes`) to the hero portrait `<img>` so phones pull a smaller image (target widths: 360, 480, 720, 1080).
  - `assets/css/base.css` — no token changes; only a new `--space-12` if not already present (4rem) for use as the mobile section padding.
  - `assets/css/layout.css` —
    - Add a `@media (max-width: 767px)` block: every section gets `min-height: auto`; section vertical padding switches to `--space-12` (≈4rem) from the desktop `--space-24` (≈6rem); hero stack bottom padding drops from 130–140px to ~64px.
    - Upgrade `.hero-fallback` (currently radial gradient blobs at line ~344) into an intentional lightweight static SVG mesh — a few dozen positioned dots + faint connecting lines using `var(--accent)` / `var(--accent-soft)` variables, rendered inline in `index.html` (or via a one-liner SVG datauri). Reads as design, not as a failure state.
  - `assets/css/components.css` —
    - **Capabilities collapsed state** for `<768px`: each axis (`#bento` axis card) renders as `axis-title` + a `cap-chip` 3-item preview + a "Show 6 capabilities" tap target. Toggling adds an `is-open` class on the axis container that reveals the full 6-card grid below. Reuse the existing `cap-chip` and `+N more` patterns (do not invent new chip styles).
    - **Trajectory collapsed state** for `<768px`: each company row uses a native `<details>` element (mirrors `posts-list.js` accordion). `<summary>` shows company + tenure + role count; the role list lives inside `<details>` body. Hide the gradient rail decoration entirely on mobile (no `min-height` reservation, no SVG measurement work).
    - **Bottom-sheet agent panel** at `<768px`: replace the existing `inset: 3px ... 3px` rule (currently around components.css:2017) with `inset: auto 0 0 0; max-height: 80vh; border-radius: var(--radius-xl) var(--radius-xl) 0 0; touch-action: pan-y;`. Add a visible drag handle at the top of `.agent-panel` (a small `<span class="agent-panel-handle">` rendered by `agent-widget.js`).
    - **Hide FAB while the panel is open on mobile** — extend the existing `[data-agent-state="open"]` selector with a `@media (max-width: 767px)` rule that sets the FAB to `display: none`. Same rule hides `.mobile-bottombar`.
    - **Mobile bottom-bar** styles (`<768px` only): fixed bottom, two equal-width buttons, `padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom))`, frosted backdrop reusing the design tokens already used by `.agent-panel` header.
    - **Sticky section-progress strip** styles: 6px tall, fixed top, dots ~6px wide, current-section dot uses `var(--accent)`, others use `var(--text-muted)`. Pure CSS — no JS layout.
    - **Mobile cert chip** styles: small pill, same height as `cap-chip` (≥40px), reuses existing chip tokens. Desktop `.cert-rail` is unchanged.
  - `assets/js/main.js` —
    - Resolve `mobileMQ = matchMedia("(max-width: 767px)")` once near the top (alongside the existing `prefers-reduced-motion` and `(any-pointer: coarse)` matchers). Reuse this matcher everywhere mobile gating is needed; no new ad-hoc `innerWidth` reads.
    - Hard-gate hero-graph init on `mobileMQ.matches` — early-return before importing/initialising Three.js. The fallback SVG mesh is now the mobile hero visual.
    - Wire the in-hero `.hero-cta-mobile` and the bottom-bar `Ask my agent` button to the existing agent-open handler (same code path as the FAB).
    - Wire the bottom-bar `Resume` button to the existing `data-resume-trigger` open path (same code path as the nav-drawer link).
    - Mount the `mobile-section-progress` IntersectionObserver: one observer with all section refs as targets, `threshold: 0.5`. Update the active dot when a section crosses threshold. Skip mounting on desktop.
    - Mount the scroll-aware bottom-bar hide/reveal — `requestAnimationFrame`-throttled scroll listener, mirrors the lightweight pattern already used elsewhere in `main.js`. Hide on `scrollY` increasing past ~120px, reveal on any upward scroll. Skip when `prefers-reduced-motion: reduce`.
    - Capabilities & Trajectory collapse: bind once at init for the `<768px` media; toggle the `is-open` class (capabilities) or rely on native `<details>` (trajectory). On `<details>` toggle, fire a `portfolio:trajectory-remeasure` custom event so `trajectory.js` can re-run its rail-measure pass.
  - `assets/js/agent-widget.js` —
    - Render an `agent-panel-handle` element inside the panel header on mobile only.
    - On mobile, listen for `pointerdown`/`pointermove`/`pointerup` on the handle. Drag distance > 80px → close the panel. Use `pointer-events` + `touch-action: pan-y` (set in CSS) so vertical drag works without breaking message-list scroll.
    - When the panel opens on `<768px`, ensure the FAB and `.mobile-bottombar` are hidden via the `[data-agent-state="open"]` attribute (already toggled by the existing open/close handler — the CSS rule does the visual hiding).
  - `assets/js/hero-graph.js` —
    - Top of `initHeroGraphWhenVisible()`: early-return if `matchMedia("(max-width: 767px)").matches`. Spec 13's FPS watchdog and finer-grained mobile profile are removed — they are no longer needed because mobile never enters the WebGL path.
  - `assets/js/trajectory.js` —
    - Listen for the `portfolio:trajectory-remeasure` event and re-run the existing measure + rail layout pass when fired. No other changes; the rail SVG decoration is hidden on mobile via CSS so it has nothing to measure there.

## Files to change
- `index.html`
- `assets/css/base.css` (only if `--space-12` does not already exist)
- `assets/css/layout.css`
- `assets/css/components.css`
- `assets/js/main.js`
- `assets/js/agent-widget.js`
- `assets/js/hero-graph.js`
- `assets/js/trajectory.js`

## Files to create
- New responsive portrait variants under `assets/img/` (e.g. `portrait-360.webp`, `portrait-480.webp`, `portrait-720.webp`, `portrait-1080.webp`) for the new `srcset`. Source from the existing portrait. No code generation.

## New dependencies
No new dependencies.

## Rules for implementation
- All identity content lives in `assets/js/data/profile.json`.
- CSS variables only — never hardcode hex.
- One JS module per visualization; lazy-load on viewport entry.
- No npm, no bundler, no Node toolchain.
- Respect `prefers-reduced-motion`.
- Mobile fallbacks for every WebGL/Three.js feature.
- **Reuse the existing `matchMedia` plumbing** in `main.js`, `trajectory.js`, `agent-widget.js`, `cursor.js`. Do not introduce new `window.innerWidth` polls or new ad-hoc breakpoints. Standardise on `(max-width: 767px)` for the mobile gate (matches the existing trajectory + main matcher).
- **Desktop is untouched.** Every change is gated by `@media (max-width: 767px)` or `matchMedia("(max-width: 767px)")`. Resizing a desktop viewport from 320px → 1280px must show the existing desktop UX from 768px onward.
- **Portrait remains visible at every breakpoint** (spec 13's hard rule). This spec does not introduce any `display: none` path for `.hero-portrait`.
- **Animations gated only by `prefers-reduced-motion`.** The collapse toggles, bottom-bar reveal, and section-progress dot transitions all check the existing reduced-motion matcher.
- **Tap targets ≥ 44×44px** on the new bottom-bar buttons, hero CTA, capability axis toggles, trajectory `<summary>`, agent panel drag handle hit area, and cert chip (WCAG 2.5.5; spec 13 rule).
- **Honour `safe-area-inset-bottom`** on the bottom-bar and bottom-sheet panel.
- **Use `100svh` (small viewport units)** anywhere a viewport-height value is added (spec 13 rule).
- **No regression to spec 13 DoD items 4 (portrait), 7 (cert rail interaction), 14 (reduced-motion).** Cert tap-to-open behaviour is preserved — the chip is just a new entry point to the same surface.
- **Spec preservation.** Do not edit spec 13 to match this work; this is a follow-up spec per the project's append-only history rule.

## Rationale for reversing spec 13's hero-canvas-on-mobile rule
Spec 13 chose to keep the WebGL canvas alive on phones with a finer-grained mobile profile (50% node count, capped DPR, 30fps target, FPS watchdog). The watchdog works, but it produces a degraded outcome by design: the canvas either runs visibly slower than desktop, or it disposes itself mid-session and reveals the gradient blobs — which look like a failure state. A static SVG mesh built into `.hero-fallback` from the start, designed to look intentional, gives mobile a cleaner first paint, removes the largest dependency from the mobile critical path (Three.js per CLAUDE.md performance budget), and matches what most LinkedIn arrivals will give the page anyway: a few seconds of attention before the first tap.

## Definition of done
Verifiable in Chrome DevTools mobile emulation at iPhone SE (375×667) and iPhone 14 Pro (393×852), plus a real device pass at one of the two widths.

1. **Scroll length cut.** Total scroll from hero-top to footer-bottom on a 393×852 viewport is ≤ 2.5 screen-heights (down from current ~4–6). Measured via `document.body.scrollHeight / window.innerHeight`.
2. **Above-the-fold tap targets.** From a cold load on mobile, the visitor can tap `Ask my agent` or `Resume` without scrolling. Both are visible in the first viewport (in-hero CTA + bottom-bar).
3. **Bottom-bar persistent.** The bottom-bar is rendered for the entire scroll on `<768px`, respects `safe-area-inset-bottom` on iOS, and hides on scroll-down / reveals on scroll-up. With `prefers-reduced-motion: reduce`, it stays put (no hide/reveal motion).
4. **Bottom-sheet agent panel.** Tapping `Ask my agent` opens the panel as a bottom sheet (`inset: auto 0 0 0`, max-height ~80vh, rounded top corners, drag handle visible). Dragging the handle down >80px closes the panel. The FAB and bottom-bar are not visible underneath while the panel is open.
5. **No WebGL on mobile.** Network panel on a `<768px` viewport shows Three.js is **not loaded** (no `three`/`hero-graph.js` Three.js import resolved). The hero shows the upgraded SVG mesh fallback, which reads as intentional design (no gradient-blob look). Spec 13 DoD item 5 is intentionally inverted here for `<768px`.
6. **Hero portrait visible** on `<768px`. `<figure class="hero-portrait">` is rendered (not `display: none`). Spec 13 DoD item 4 still passes.
7. **Capabilities collapsed by default on mobile.** Each of the 3 axes shows axis title + 3-chip preview + tap target. Tapping reveals the full 6-card grid for that axis. Total cards visible before any tap: 0 (just 3 axis headers).
8. **Trajectory collapsed by default on mobile.** Each of the 3 companies shows name + tenure + role count. Tapping reveals roles. Native `<details>` so it works without JS as a baseline; `trajectory.js` re-measures on toggle (no orphan rail layout space).
9. **Cert chip on mobile.** The inline 8-badge rail does not render on `<768px`. A single chip ("8 certifications · AWS · GCP · Azure") renders in its place and opens the same cert popover surface spec 13 wired. Desktop cert rail unchanged at `≥768px`.
10. **Section progress strip.** A 6px-tall sticky strip at the top of mobile viewports tracks the active section. Dots are tappable and scroll the page to the corresponding section.
11. **Hero CTA above the fold.** "Ask my agent →" button is rendered under the tagline at `<768px`, ≥44×44px, and opens the agent panel via the same handler as the FAB.
12. **WCAG tap targets.** All new mobile-only interactive elements (bottom-bar buttons, hero CTA, capability axis toggles, trajectory `<summary>`, drag handle hit area, cert chip, progress dots) measure ≥44×44px in `getBoundingClientRect()` at 393×852.
13. **Image responsiveness.** Hero portrait `<img>` has `srcset` + `sizes`. On a 393px viewport, DevTools "Network" shows a portrait variant ≤480px wide is served (not the desktop-sized image).
14. **No horizontal scroll** at 360 / 393 / 768 widths on any section. `document.body.scrollWidth === window.innerWidth`.
15. **No console errors** during a full scroll-through, panel open/close cycles (5+), capability axis toggles (all three), trajectory company toggles (all three), and cert chip popover toggles.
16. **Reduced-motion honoured.** With OS-level reduced-motion enabled: bottom-bar hide/reveal does not animate, panel open does not animate, capability/trajectory toggles do not animate. The page still functions.
17. **No desktop regression.** Resize from 320px → 1280px: the existing desktop hero canvas, cert rail, capability grid, trajectory rail, and FAB all behave exactly as they did before this spec at `≥768px`. Take side-by-side screenshots before merging.
18. **Lighthouse mobile.** Performance ≥ 90 on the deployed branch (CLAUDE.md budget). Accessibility ≥ 95 (spec 13 baseline).
19. **Spec 13 DoD items 1, 4, 7, 11, 14** still pass (no horizontal scroll, portrait visible, cert tap-to-open, footer wraps cleanly, reduced-motion honoured).
