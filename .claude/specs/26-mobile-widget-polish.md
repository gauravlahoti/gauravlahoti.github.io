# Spec 26: Mobile widget polish

> **Builds on spec 22.** Spec 22 introduced the bottom-sheet agent panel and the persistent mobile bottom-bar. This spec hardens the bottom-sheet against eight production-mobile gotchas (URL-bar quirks, soft-keyboard occlusion, force-zoom, sub-44px tap targets, landscape collapse, body-scroll bleed, missing keyboard hints) so the widget feels as polished on iPhone and Samsung as a native chat surface. Desktop is untouched.

## Overview

Real-world feedback after spec 22: the mobile widget is "sometimes too small or too big". The bottom-sheet skeleton is correct; the symptoms come from layered Mobile Safari + Chrome quirks the implementation didn't account for:

- The panel uses static `vh`, which on iOS Safari measures against the largest viewport (URL bar hidden), so when the URL bar is visible the panel runs off the bottom of the screen.
- There is no `visualViewport` listener, so the soft keyboard slides up and covers the input.
- The textarea is 14px (`var(--text-sm)`), so iOS Safari force-zooms on focus.
- The viewport meta lacks `interactive-widget=resizes-content`, so the keyboard overlays without the layout reacting.
- Header controls (close / expand / minimize) are 36px — below the 44px WCAG / spec-24 standard.
- No landscape rule — phones in landscape see ~80vh of which ~70% is keyboard.
- No body-scroll lock — page scrolls behind the open sheet, panel feels detached.
- Textarea has no `enterkeyhint`, `inputmode`, `autocapitalize`, `autocorrect`, `spellcheck` — soft keyboard shows generic Return key, no auto-cap, no correction.

## Depends on

- Spec 13 (mobile compatibility) — `--tap-min`, `--safe-bottom`, safe-area patterns. Reused, not modified.
- Spec 20 + 21 (agent widget + Cloud Run) — the mounted widget this spec polishes.
- Spec 22 (mobile overhaul) — the bottom-sheet shell + drag-to-dismiss + bottom-bar this spec hardens.
- Spec 24 (conversation upgrades) — already declared "all new elements ≥ 44px tap target"; this spec aligns the older controls (close / expand / minimize) with that rule.

## Routes

No backend.

## Database changes

No database.

## Templates

- **Modify:**
  - `index.html`
    - Viewport meta — append `interactive-widget=resizes-content`. Final value: `width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content`.
    - Bump every `?v=N` cache-buster in line with `ASSET_VERSION`.

## CSS

- `assets/css/components.css`
  - **A. Dynamic viewport units.** In the `@media (max-width: 767px)` block, replace `max-height: 80vh` (line 2589) and `min-height: 60vh; max-height: 92vh` (line 2595) with stacked declarations: a `vh` fallback line followed by a `dvh` line clamped via `min(_, 720px)` (default state) and `min(_, 920px)` (expanded state). The `min()` clamp prevents 6.7"-class phones (iPhone 15 Pro Max, Galaxy S24 Ultra) from getting an over-tall sheet.
  - **B-css. Hook for visualViewport.** Add a second stacked `max-height` line that prefers a CSS custom property: `max-height: min(calc(var(--agent-vv-height, 80dvh) - 24px), 720px);`. The custom property is set by JS (item B-js); when JS hasn't set it, the variable's fallback (`80dvh`) takes over so CSS-only browsers still behave.
  - **C. 16px input on coarse pointers.** Add `@media (any-pointer: coarse) { .agent-input { font-size: 16px; } }`. Prevents iOS Safari focus-zoom.
  - **E. 44×44 header controls.** Change `.agent-panel-close, .agent-panel-expand, .agent-panel-minimize` from `min-width: 36px; min-height: 36px;` to use `var(--tap-min)`. Add a small horizontal `padding` so the icon glyph stays visually centered without a hard-coded width.
  - **F. Landscape phone rule.** Inside the same `@media (max-width: 767px)` block, nest `@media (orientation: landscape) and (max-height: 500px) { .agent-panel { max-height: min(96dvh, calc(var(--agent-vv-height, 96dvh) - 8px)); } .agent-panel.is-expanded { max-height: 96dvh; } .agent-panel-head { padding: var(--space-2) var(--space-3); } }`.
  - **G. Body scroll-lock.** At the top of the mobile breakpoint, add `body[data-agent-panel-open="true"] { overflow: hidden; overscroll-behavior: none; }`. Don't use the `position: fixed; top: -scrollY` trick (it conflicts with `scroll-restore.js`).
  - **I. Drag-zone safe-area.** Pad `.agent-panel-drag-zone` and `.agent-panel-head` with `padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right);` so notched-iPhone landscape doesn't clip them.

## JS

- `assets/js/agent-widget.js`
  - **B-js. visualViewport tracker.** New helper `trackVisualViewport(panel)`. On mount, if `window.visualViewport` exists, listen to its `resize` and `scroll` events and write `--agent-vv-height` (in px) onto `panel.style`. The CSS `max-height` (item B-css) reads it. Tear down on widget destroy.
  - **H. Textarea keyboard hints.** When constructing the textarea (around lines 672–677), set `enterkeyhint="send"`, `inputmode="text"`, `autocapitalize="sentences"`, `autocorrect="on"`, `spellcheck="true"`.

## Behaviour

No new user flows. The widget renders the same on every device; only sizing and keyboard behaviour change on touch screens.

## Definition of done

Manual verify in Chrome DevTools mobile emulation (or a real device pair):

- [ ] **iPhone SE (375 × 667) portrait** — open panel → input row sits above keyboard. Tap input → no zoom.
- [ ] **iPhone 15 Pro Max (430 × 932) portrait** — panel `max-height` ≤ 720 px, doesn't fill the whole screen. Drag-to-dismiss still works.
- [ ] **iPhone 15 Pro (393 × 852) landscape** — panel uses ≥ 96dvh; conversation visible above keyboard; no notch overlap.
- [ ] **Galaxy S24 Ultra (412 × 883) portrait** — same as iPhone Pro Max checks.
- [ ] **iPhone with URL bar visible → scroll to hide URL bar** — panel max-height adjusts; no dead space below.
- [ ] **All header controls** hit-test at ≥ 44 × 44 px (DevTools rulers).
- [ ] **Body cannot scroll** behind the sheet (try swiping the underlying page).
- [ ] **Soft keyboard shows "Send"** affordance on iOS / "→" on Android.
- [ ] **First letter auto-capitalised**, autocorrect on.
- [ ] **Closing the panel** restores scroll to its prior position (no jump).
- [ ] **Lighthouse Performance ≥ 90 desktop**, **Accessibility ≥ 95 mobile** — tap-target audit must now pass.
- [ ] Cache-buster `?v=N` bumped on `assets/css/*` and `assets/js/main.js` and `assets/js/scroll-restore.js`.

## Rationale

Why dvh + visualViewport, not `100vh`-with-JS-shim:
- `dvh` is supported by every browser version that matters in 2026 (iOS 15.4+, Chrome 108+) — covers > 99% of mobile traffic.
- `visualViewport` ships keyboard awareness that no CSS unit currently exposes (the keyboard does not change `dvh` on iOS Safari — only the URL bar does). The two together cover both the URL-bar collapse case (CSS) and the keyboard case (JS), with graceful fallback if either is unavailable.

Why `interactive-widget=resizes-content` and not `resizes-visual`:
- `resizes-content` shrinks the layout viewport when the keyboard opens, which means the bottom-anchored panel naturally reflows above the keyboard with no extra JS. `resizes-visual` (the default) keeps the layout viewport intact, which is what causes the input to be hidden today.
