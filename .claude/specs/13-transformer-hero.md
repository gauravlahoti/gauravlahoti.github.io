# Spec 13 — Transformer Hero

Status: Draft
Created: 2026-05-02
Branch: `feature/13-transformer-hero` (to be created at implementation time via `/create-spec` or manually)
Supersedes the visual layer of: `02-hero-shader.md`

## Goal

Turn the hero (`#hero` in `index.html`) into a Transformers-movie title sequence — mechanical, cinematic, eye-catching, with an unmistakable "AI / autonomous-system" payoff in the first two seconds. The current Fibonacci-sphere "Agent Mesh" reads as a generic dark AI portfolio; this rebuild makes the landing moment feel like a piece of hardware booting up. The signature beat is a **title shard-assembly**: "Gaurav Lahoti" lands as metallic shards that fly in from offscreen and lock into the wordmark, finished with a glint sweep — over a slowly rotating Cybertron-style core and a HUD frame.

## Visual reference (layered composition, back → front)

1. **Background — Cybertron core** (Three.js, replaces `assets/js/hero-graph.js` body, keeps the exported `initHeroGraph(canvas, opts)` signature):
   - ~6 interlocking hex/rect panels orbiting a central glowing seed, plus a ring of thin metallic struts. `InstancedMesh` for panels; `MeshStandardMaterial` with low roughness, high metalness; faux env-map built from `--accent` and `--bg-elev`.
   - Idle: gentle counter-rotation on two axes; radial fresnel glow tinted `--accent`.
   - Mouse: parallax tilt (port the existing pattern from the prior `hero-graph.js`).
   - Reduced-motion: render one frame, freeze.

2. **HUD frame** (CSS + SVG only, no JS):
   - Four corner brackets that draw in via `stroke-dashoffset` on load, then breathe at ~0.5 Hz.
   - Faint scanline overlay at ~5% opacity (CSS gradient + animated `background-position`).
   - Mono labels in JetBrains Mono, `--ink-muted`:
     - top-left `SYS:ARCHITECT.MESH`
     - top-right `LAT 04ms`
     - bottom-left `BUILD <profile.buildTag || ISO date>`
     - bottom-right `AGENT.READY`
   - A targeting reticle that slides into place and locks on the title at the end of the assembly.

3. **Title shard-assembly** (new module `assets/js/hero-title.js`, exports `initHeroTitle(svgEl, { text, reduced })`):
   - "Gaurav Lahoti" rendered as SVG `<text>` with per-glyph `<tspan>`s.
   - Each glyph is duplicated into 3 metallic shards (clip-path triangles) starting translated/rotated off-axis with `filter: blur(2px)` and `opacity: 0`. GSAP animates each shard to its final transform with a slight overshoot + settle. Stagger: 40 ms between glyphs, 15 ms between shards inside a glyph.
   - Final lock: a CSS mask-based **glint sweep** runs left → right across the wordmark.
   - During assembly: subtle chromatic aberration via two offset cyan/magenta `text-shadow` copies fading to white.
   - Settled state: title in `--ink` with `text-shadow: 0 0 24px var(--accent-glow)`.

4. **Identity line + tagline** (reuse existing markup):
   - "Cloud & AI-Native Architect." reveals after the title locks. Keep the existing hat SVG and orbiting-agent ornament from `assets/css/components.css` (the current `.hero-identity` rules) — they already read as "AI."
   - Tagline boots like a HUD diagnostic: monospace `> ` types in, then the sentence streams character-by-character (extend the existing token-stream routine in `assets/js/main.js`), then `> ` softens to the body font.

5. **Portrait** (`.hero-portrait`):
   - Keep position. Add a hex `clip-path` mask and a thin animated stroke that traces the hex outline once on reveal. Scanline overlay at 8% opacity to match the HUD.

## Modules / files to add or modify

| File | Change |
|---|---|
| `index.html` (`#hero` block, currently lines 94–131) | Add `<div class="hero-hud">` with corner-bracket SVGs + four mono labels. Replace `<h1 class="hero-name">` text with `<svg class="hero-title" role="heading" aria-level="1"><title>Gaurav Lahoti</title>…</svg>`. Keep `.hero-identity` and `.hero-tagline` markup intact. |
| `assets/js/hero-graph.js` | Replace contents with the new Cybertron-core scene. Keep the exported `initHeroGraph(canvas, opts)` signature. |
| `assets/js/hero-title.js` | New. Exports `initHeroTitle(svgEl, { text, reduced })`; builds shards and runs the GSAP assembly + glint timeline. |
| `assets/js/main.js` (reveal timeline ~lines 348–415, lazy hook ~line 475) | Wire `initHeroTitle` alongside `bindDOM`; chain its timeline ahead of identity/tagline reveal. Pass `prefersReducedMotion` into both hero modules. Extend (don't fork) the token-stream routine for the tagline. |
| `assets/css/components.css` (`.hero-*` blocks) | HUD frame, scanline, title shard layers, hex portrait mask, glint mask animation. Keep the hat + orbiting-agent rules untouched. |
| `assets/css/base.css` (`:root`) | Add two derived tokens: `--metal-1: #C8D0D6`, `--metal-2: #5A6670` for shard fill gradient. No other new color literals. |
| `assets/js/data/profile.json` | Optional: add `"buildTag"` for the HUD label. JS falls back to today's ISO date if absent. |

## Timing budget (load → settled)

| t (s) | Event |
|---|---|
| 0.0 | Cybertron core fades in; HUD brackets begin drawing |
| 0.4 | Shards begin streaming in |
| 1.4 | Title locked; glint sweep |
| 1.6 | Identity line fades up |
| 1.9 | Tagline diagnostic stream starts |
| ~2.8 | Settled idle state |

Total under 3 s so the scroll prompt isn't gated.

## Tokens

Only new tokens introduced: `--metal-1`, `--metal-2` in `:root` (`assets/css/base.css`). Everything else reuses existing `--accent`, `--accent-glow`, `--ink`, `--ink-muted`, `--bg`, `--bg-elev`, `--font-mono`.

## Reduced-motion behavior

`@media (prefers-reduced-motion: reduce)`:
- No shard animation, no glint sweep — title renders in its final state.
- Cybertron core renders one frame, no rotation.
- HUD brackets static (drawn, no breathing).
- Tagline appears in full, no streaming.

## Performance & accessibility

- Three.js scene caps: ~30 instanced panels + 24 strut lines. No post-processing, no shadows. Target ≥ 60 fps on a 2020 MacBook Air; pause via the existing IntersectionObserver when scrolled out of view.
- Title shards are SVG + GPU-composited CSS transforms; no per-frame JS work after the 1.4 s assembly window.
- A11y: SVG title carries `<title>Gaurav Lahoti</title>` and `role="heading" aria-level="1"`. Tagline stays a real `<p>`. HUD labels are `aria-hidden="true"`.
- Performance budget per `CLAUDE.md` unchanged: Lighthouse Performance ≥ 90 desktop, total JS < 400 KB gzipped, FCP < 1.5 s.

## Definition of done

- [ ] Hero loads with shard-assembly playing within 2 s and settles by 3 s.
- [ ] Cybertron core idles at ≥ 60 fps on a 2020 MacBook Air; sustained GPU < 35% in Activity Monitor.
- [ ] All four HUD corner brackets and labels are visible at viewport widths ≥ 360 px.
- [ ] `prefers-reduced-motion: reduce` shows the final-state title with no animation, no rotation, no glint, no streaming.
- [ ] Title remains the page's heading-1 in DOM order; VoiceOver reads "Gaurav Lahoti, heading level 1" first.
- [ ] Lighthouse Performance ≥ 90 on desktop after the change.
- [ ] Combined hero modules (`hero-graph.js` + `hero-title.js`) ≤ 80 KB gzipped (Three.js excluded; loads from CDN as today).
- [ ] No new color literals outside `--metal-1` / `--metal-2`.

## Manual verification

1. `python3 -m http.server 5173` → `http://localhost:5173`.
2. Hard reload; confirm sequence: HUD brackets draw → shards assemble → glint sweeps → identity fades → tagline streams. Total ≤ 3 s.
3. DevTools → Rendering → "Emulate CSS prefers-reduced-motion: reduce" → reload; verify static final state.
4. DevTools Performance trace 5 s post-load: average frame time < 16.7 ms.
5. Resize to 360 px wide: HUD frame intact, title scales, no horizontal scroll.
6. Run Lighthouse desktop: Performance ≥ 90.
7. Tab through the page; VoiceOver (`Ctrl+Opt+A`) reads name → identity → tagline in order.
8. Scroll away from hero, then back: animation pauses and resumes (IntersectionObserver still working).
