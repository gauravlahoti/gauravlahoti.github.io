# Spec 29: Token Bridge — kinetic-typography scroll moment between Hero and Career

## Overview

The hero (`#top`) and the career trajectory (`#career`) currently meet with a hard cut. The hero is motion-rich (Three.js Agent Mesh, A2A edge pulses, token-streaming caret), the trajectory is motion-rich (scroll-scrubbed rail draw + station activation), and the seam between them feels abrupt. This spec adds a short scroll-driven kinetic-typography moment that bridges the two: the hero tagline visually disassembles into glowing tokens that flow downward like A2A data packets and reassemble as the word "TRAJECTORY" right above the career rail.

It echoes the existing aesthetic — accent-colored monospace glyphs, terminal feel, "data in motion" — without competing with either headline animation. GSAP `TextPlugin` is loaded in `index.html` but currently unused; this spec puts it to work without adding a single byte of dependency.

## Depends on

- Spec 00 / 01 — base hero + tagline (`profile.tagline` is the source string).
- Spec 02 — career trajectory (the bridge feeds visually into the rail headline).
- GSAP + ScrollTrigger already loaded in `index.html` (no new deps).

## Routes

No backend.

## Database changes

No database.

## Templates

- **Modify:** `index.html`
  - Insert one new `<section class="token-bridge" id="token-bridge" aria-hidden="true">` between the hero close (line 298) and `#career` open (line 300). Mark `aria-hidden="true"` because it's purely decorative — assistive tech reads the original tagline in the hero and the "Eleven years…" headline in `#career`.
  - Inside, three children:
    - `<div class="token-bridge-source" data-token-source data-bind="profile.tagline">…</div>` — gets text from `profile.json` via the existing `bindDOM()` pipeline, then split into glyph spans by JS.
    - `<div class="token-bridge-target" data-token-target>TRAJECTORY</div>` — assembly target.
    - `<a class="token-bridge-fallback" href="#career" hidden>→ Career trajectory</a>` — shown only when reduced motion or when GSAP/ScrollTrigger fail.
  - Bump every `?v=89` to `?v=90` (CSS, JS, scroll-restore).

## CSS

- `assets/css/components.css` — append a new section (~70 lines):
  - `.token-bridge` — block, full width, `min-height: 50vh`, vertical padding `var(--space-24) 0`. Relative position; no pin (keeps Lenis/sticky context untouched).
  - `.token-bridge-stage` — flex column, gap `var(--space-16)`, items center, max-width matching the hero/trajectory containers.
  - `.token-bridge-source` — monospace (`var(--font-mono)`), `font-size: clamp(0.95rem, 1.5vw, 1.15rem)`, max-width 60ch, color `var(--fg-muted)`, line-height 1.5. Container for split glyphs.
  - `.token-bridge-glyph` — `display: inline-block`, `will-change: transform, opacity, filter`, color inherits; the active glyphs (mid-flight) get `color: var(--accent)`, `text-shadow: 0 0 8px var(--accent-glow)`, set by JS via a class.
  - `.token-bridge-target` — monospace, `font-size: clamp(2rem, 6vw, 3.6rem)`, letter-spacing `0.18em`, color `var(--accent)`, `text-shadow: 0 0 24px var(--accent-glow)`. Each letter wrapped in `.token-bridge-target-letter` (will-change opacity + transform).
  - `.token-bridge-fallback` — when `[hidden]` removed, displays as a plain accent-colored monospace link (matching the existing `.btn-ghost` hover pattern, but inline).
  - `[data-paused="true"] .token-bridge-glyph, [data-paused="true"] .token-bridge-target-letter { animation-play-state: paused; }` — only relevant if any CSS keyframes get added later; the GSAP timeline is already paused via `initOffscreenAnimationPause` machinery.
  - `@media (max-width: 767px)` — collapse to `min-height: 28vh`, scale target word smaller, hide source body text (mobile users see the same text in the hero just above; we keep only the target headline assembling).
  - `@media (prefers-reduced-motion: reduce)` — set `.token-bridge { min-height: auto; padding: var(--space-8) 0; }`, hide source + target, show fallback link.

## JS

- **NEW** `assets/js/token-bridge.js` (~140 lines)
  - Export `initTokenBridge(section)` returning `{ destroy }`.
  - On init:
    - Resolve `[data-token-source]` and `[data-token-target]` inside the passed section.
    - If GSAP / ScrollTrigger missing, OR `prefers-reduced-motion: reduce`, OR `(max-width: 480px)` → reveal fallback link, return a no-op destroy. (Tablet-mobile down to 481px gets a simplified non-scrub timeline; only narrow phones go static.)
    - Split source into `<span class="token-bridge-glyph">` per character (preserve whitespace).
    - Split target into `<span class="token-bridge-target-letter">` per letter; set initial `opacity: 0`, `y: 18`.
    - Pre-compute per-glyph scatter values (`xOffset`, `yOffset`, `delay`) seeded from index for stable randomness — no Math.random churn on each tick.
    - Build a master `gsap.timeline({ paused: true })`:
      - `0.0–0.4` — source glyphs fade to `var(--accent)` color (toggle a `.is-token` class) and tween `y: -8 → +180`, `opacity: 1 → 0`, with a 0.3s stagger window and `power2.in` ease (acceleration sells the "data packet downward flight").
      - `0.4–1.0` — target letters tween `opacity: 0 → 1`, `y: 18 → 0`, `filter: blur(6px) → blur(0)`, stagger 0.04s, `power3.out`.
    - Drive the timeline via a single ScrollTrigger:
      ```js
      ScrollTrigger.create({
          trigger: section,
          start: "top 80%",
          end: "bottom 30%",
          scrub: 0.5,
          onUpdate(self) { tl.progress(self.progress); },
      });
      ```
    - On `window.load` and on `ResizeObserver` ticks, call `ScrollTrigger.refresh()` (mirrors `trajectory.js` pattern).
  - Cleanup: kill triggers, kill timeline, restore source `textContent`, remove created nodes. Mirrors `trajectory.js` destroy.

- `assets/js/main.js`
  - Add `initTokenBridgeWhenVisible()` mirroring `initTrajectoryWhenVisible` shape — IntersectionObserver with `rootMargin: 300px`, lazy-imports `./token-bridge.js?v=90`, calls `initTokenBridge(section)`, stores instance on `window.__tokenBridge`.
  - Wire it in `bootstrap()` after `initHeroGraphWhenVisible()`.
  - Bump `ASSET_VERSION` from `"89"` to `"90"`.

## Behaviour

- Desktop (≥768px, no reduce-motion): user scrolls past hero → source text disassembles into accent-colored glyphs that scatter downward → at ~50% scrub, "TRAJECTORY" letters resolve into place. Career rail appears just below.
- Mobile (≤767px, no reduce-motion): same effect but compressed — source text is hidden by CSS (the hero already showed the tagline just above), and the target word assembles on scroll-into-view via a single non-scrubbed tween. Letter-spacing + font-size are clamped tight so "TRAJECTORY" fits on 320 px-class viewports without wrapping.
- Reduce-motion (any width) OR GSAP missing: section collapses to a thin band with a single accent link "→ Career trajectory" that anchors to `#career`.
- Off-screen: `initOffscreenAnimationPause()` already toggles `data-paused` on `#top` and `.cert-rail`; the token-bridge timeline is GSAP-driven and pauses naturally when ScrollTrigger reports out-of-range, so no extra wiring is needed.

## Definition of done

Manual verify on `python3 -m http.server 5173`:

- [ ] **Desktop ≥1024px** — scroll past hero. Source line disassembles into glowing accent glyphs. By the time the career rail enters viewport, "TRAJECTORY" is fully assembled.
- [ ] **Tablet 768–1023px** — same effect, slightly less travel.
- [ ] **Mobile 320–767px** — source text hidden, only "TRAJECTORY" assembles on scroll. Word fits on one line at 320 px, 360 px, 375 px, 414 px viewports.
- [ ] **Reduced motion** — DevTools rendering panel → enable `prefers-reduced-motion: reduce`. Section collapses to fallback link; no GSAP timeline runs.
- [ ] **GSAP-missing fallback** — block `cdn.jsdelivr.net` in DevTools network panel, reload. Page still renders, fallback link shown.
- [ ] **Re-scroll** — scroll back up past the bridge, then back down. Effect repeats cleanly (timeline scrubs both ways).
- [ ] **Lighthouse Performance ≥ 90 desktop** (matches existing budget).
- [ ] **`git diff --stat`** shows ≤ ~250 LOC across exactly 5 files: `index.html`, `assets/js/main.js`, `assets/js/token-bridge.js` (new), `assets/css/components.css`, `.claude/specs/29-token-bridge.md` (new).
- [ ] Cache-buster `?v=N` bumped to `90` everywhere.

## Rationale

**Why kinetic typography over a new visual element.** The existing motion language already speaks "data in motion." Adding a particle field, a liquid blob, or a cursor gimmick would dilute the metaphor. Kinetic typography reuses the words you already wrote — "Architecting autonomous workflows…" — and gives them a physical-feeling moment. It deepens the existing identity instead of layering a new one.

**Why scrub instead of pin.** Pinning would interact with Lenis smooth-scroll, the sticky `.trail-rail`, and the existing `ScrollTrigger.refresh()` cycle in `trajectory.js`. Pure scrub on a non-pinned section sidesteps all of that — the bridge just lives in the document flow and scrubs as it passes through the viewport. Lower risk, easier to maintain, no scroll-length hijack on the user.

**Why TextPlugin is enough.** The split is a simple character-by-character split — vanilla JS handles it cleanly. The "TextPlugin" we already load is overkill for this spec (it's there in case future kinetic-typography work wants `gsap.to(el, { text: "..." })` morphs). We keep it loaded for the future spec; this one doesn't depend on it.
