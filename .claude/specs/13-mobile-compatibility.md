# Spec: Mobile Compatibility

## Overview
Pass the portfolio through a focused mobile-compatibility audit so the site reads, navigates, and converts cleanly on phones (≤480px) and small tablets (≤768px) — **with the portrait visible and the hero animations running, not stripped out**. Earlier specs took the easy path of hiding the portrait below 1100px and removing the hero canvas below 768px; that left mobile visitors looking at a flat gradient and no face. This spec restores both: a re-composed hero on small screens that shows the portrait above (or beneath) the text stack, and a mobile-tuned hero canvas + GSAP reveal + identity-line agent flight that runs on phones at a budgeted frame rate. It also consolidates the polish gaps: nav overflow at 360px, cert-rail/home-indicator collision, hover-only cert popovers, capabilities chip tap targets, identity-line wrapping, dialog viewport handling on iOS Safari, and `100vh` quirks. No new visualizations — existing surfaces, made to feel native on touch.

## Depends on
- Spec 01 (foundation) — nav, sections, design tokens
- Spec 02 (hero shader) — hero canvas + fallback, identity line
- Spec 04 (knowledge graph / trajectory) — mobile rail collapse
- Spec 06 (bento / capabilities) — single-column at ≤880px
- Spec 08 (polish) — custom cursor (already disabled on coarse pointers)
- Spec 10 (cert rail) — ticker tile sizing
- Spec 11 + 12 (resume gate) — modal sizing on small viewports

## Routes
No backend.

## Database changes
No database.

## Templates
- **Create:** none (no new HTML structures — only CSS + small JS additions).
- **Modify:**
  - `index.html` — add `theme-color` meta, ensure `viewport-fit=cover` for iPhone safe-area, add `aria-label` improvements where touch tap targets are unclear. The portrait `<figure class="hero-portrait">` stays in markup at all breakpoints (no `display:none` path).
  - `assets/css/base.css` — add `--safe-top` / `--safe-bottom` env-var fallbacks; tune `:root` for a mobile minimum tap-target rule.
  - `assets/css/layout.css` —
    - **Hero portrait on mobile:** drop the existing `@media (max-width: 1100px) { .hero-portrait { display: none } }` rule. Replace with a re-composition: at ≤768px the hero stack switches to `grid-template-rows: portrait | text | rail`, the portrait sits centered above the text stack at ~220–280px square, soft circular mask with a cyan rim glow (re-using the existing `::after` glow), and `object-position` shifts so the face stays clearly framed at the smaller size.
    - Fix nav overflow ≤480px, hero-stack vertical rhythm under 600px, cert-rail bottom offset on small screens with bottom safe-area.
  - `assets/css/components.css` —
    - Give `.cert-tile` a tap-to-open path (popover on `.is-open`), enlarge cap-chip tap targets to ≥40px tall on touch, ensure `.btn` minimum height meets WCAG (44×44).
    - Keep the identity-line hat (`@keyframes hat-fly-in`, `hat-bob`) and agent flight (`agent-fly-1/2/3`) animations active on mobile — only `prefers-reduced-motion` should kill them, never a width breakpoint. Re-tune the `agent-fly-*` translate distances with `clamp()` or a mobile media query so the agents stay inside the viewport on a 360px screen instead of flying off-screen.
  - `assets/js/main.js` —
    - Wire cert-tile click on touch to toggle `.is-open` and dismiss on outside tap.
    - Ensure `100svh` is used everywhere `100vh` was assumed.
    - **Hero animations on mobile:** the `scheduleHeroReveal()` GSAP timeline (chrome lines, name scramble, identity fade, tagline word stream) must run on phones. It already does — verify by removing any incidental `isNarrow` guards and confirming nothing in the timeline depends on Lenis (which is intentionally disabled on narrow viewports).
  - `assets/js/hero-graph.js` —
    - **Stop hard-disabling on `isNarrow`.** Replace the current `reduceMotion || isNarrow || saveData` early-return in `initHeroGraphWhenVisible()` with a finer-grained mobile profile: keep the canvas, but on `(max-width: 767px)` reduce node count by ~50%, cap `devicePixelRatio` at `min(window.devicePixelRatio, 1.5)`, target 30fps instead of 60fps, and skip post-processing/bloom if any. `saveData` and `prefers-reduced-motion` still fall back to the static gradient — those are the only two kill switches.
    - Add an FPS watchdog: if measured fps stays under 24 for 3 consecutive seconds, dispose the canvas and reveal the gradient fallback (graceful, not a hard cliff).
  - `assets/js/trajectory.js` — verify mobile collapse leaves no orphan rail listeners.

## Files to change
- `index.html`
- `assets/css/base.css`
- `assets/css/layout.css`
- `assets/css/components.css`
- `assets/js/main.js`
- `assets/js/hero-graph.js` — relax narrow-viewport kill switch + add FPS watchdog
- `assets/js/trajectory.js` (read-only verification; edit only if a leak is found)

## Files to create
None.

## New dependencies
No new dependencies.

## Rules for implementation
- All identity content lives in `assets/js/data/profile.json`.
- CSS variables only — never hardcode hex.
- One JS module per visualization; lazy-load on viewport entry.
- No npm, no bundler, no Node toolchain.
- Respect `prefers-reduced-motion`.
- Mobile fallbacks for every WebGL/Three.js feature.
- Honour `prefers-reduced-data` / `navigator.connection.saveData` for any heavy asset paths.
- Use `100svh` (small viewport units) instead of `100vh` so iOS Safari's dynamic toolbars don't push the hero out of frame.
- Respect iOS safe-area insets (`env(safe-area-inset-bottom)` etc.) for the cert rail and any fixed UI.
- Minimum tap target: 44×44px (WCAG 2.5.5). Apply to nav-channel, cap-chip, btn, cert-tile.
- All hover-only affordances must have a tap-equivalent on coarse pointers (cert-tile popover is the main offender).
- **The portrait must remain visible at every breakpoint.** No `display: none` path. Re-compose the layout instead.
- **Animations must run on mobile by default.** Only `prefers-reduced-motion` (and the FPS watchdog for the hero canvas) is allowed to disable them. Width-based animation kill switches are forbidden.
- Test against three reference widths: 360px (small Android), 390px (iPhone 14), 768px (iPad portrait).

## Definition of done
Verifiable in a browser via Chrome DevTools device emulation **and** at least one real device (or BrowserStack) at 360 / 390 / 768 widths:

1. **No horizontal scroll** at any of the three widths on any section. `document.body.scrollWidth === window.innerWidth`.
2. **Nav fits without truncation** at 360px — brand, links, channel icons, and Topmate CTA all visible (or Topmate hides with a documented fallback). No element overlaps the brand.
3. **Hero hero-stack** vertically centers without overlapping the cert rail at 360×640. Identity line (`Cloud & AI-Native Architect.`) wraps cleanly without orphaning the hat icon onto its own line.
4. **Portrait visible on mobile.** At 360 / 390 / 768 widths, `<figure class="hero-portrait">` is rendered (not `display:none`) and the face is clearly recognizable — full head and shoulders in frame, no hard crop. Sits above the text stack on phones, stays on the right at desktop. Cyan rim glow still present.
5. **Hero canvas runs on mobile.** At 360 / 390 / 768 widths, `#hero-gl` is present and animating (network panel shows hero-graph.js loaded; DOM shows canvas with `is-ready` class). Measured fps ≥ 24 over a 5-second sample on a 2020-era Android (or DevTools "Mid-tier mobile" CPU throttling). Only `prefers-reduced-motion`, `saveData`, or the FPS watchdog drop it back to the gradient.
6. **Hero reveal animations run on mobile.** Name scramble, identity-line fade, and tagline word stream play on first load at 390px. Hat fly-in plays. Identity-line agents (`hi-agent-1/2/3`) stay within the visible viewport — none flies past the right edge of the screen.
7. **Cert rail** keeps its marquee animation on mobile, does not get clipped by the iPhone home indicator (bottom safe-area respected), tiles stay tappable, and tapping a tile opens its popover (a second tap or outside-tap closes it). Cert-tile shimmer animation continues to run.
8. **Capabilities scan-line + fade-in animations** still play on mobile when the section enters the viewport. Chips are at least 40px tall on touch (verified by `getBoundingClientRect().height`). Tapping a tech chip still scrolls to `#graph` and dispatches `portfolio:highlight-skill`.
9. **Trajectory section** collapses to single-column at ≤768px with no leftover rail SVG taking layout space (already in CSS — verify). Role-tile entrance animations still fire on scroll.
10. **Resume modal** opens fully visible at 360×640 with no clipping; the Google Sign-In button is reachable and the Cancel button is at least 44px tall.
11. **Footer** wraps without overflowing; all four links remain tappable.
12. **No console errors** during scroll-through of the entire page on a touch-emulated viewport.
13. **Lighthouse mobile** Performance ≥ 85, Accessibility ≥ 95, Best Practices ≥ 95 on `http://localhost:5173` with throttling (Slow 4G, 4× CPU).
14. **`prefers-reduced-motion`** still honored — toggling the OS setting disables every animation listed above (canvas, hero reveal, hat, agents, cert ticker, cert shimmer, cap scan, role-tile entrance) on mobile and desktop alike.
