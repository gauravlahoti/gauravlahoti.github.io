# Spec: Hero — Agent Mesh

## Overview

The hero is the headline experience. Within 3 seconds the visitor
should feel like an agent system is running in front of them and
they've landed on its status panel. The hero **demonstrates**
"Agentic AI architect" instead of decorating around it.

Visual concept: a dark void crossed by a slow-rotating 3D
agent-graph — sparse cyan nodes connected by thin edges, with a
pulse traveling node-to-node every ~1.4s like an A2A handshake.
Foreground type is laid out as a terminal manifest: a chrome
status header, an oversized name, a role rendered as a code
declaration, and a tagline that streams in token-by-token like an
LLM is generating it live.

This replaces the curl-noise gradient from the original spec 02
draft. Why: the agent-graph is a literal visual metaphor for A2A
and LangGraph (which Gaurav actually builds with) — nodes are
agents, edges are protocol calls, the pulse is a message in
flight. Same JS budget, no postprocessing pass, one shader file
deleted.

## Depends on

- Spec 01 (foundation shell with `#hero` anchor).
- `assets/js/data/profile.json` (name, title, tagline, models,
  careerStart, links).

## Routes

No backend.

## Database changes

No database.

## Templates

- **Create:** none.
- **Modify:** `index.html` — populate `#hero` with the canvas,
  four corner chrome divs, the foreground stack (status / name /
  role / tagline / CTAs), and the `> try typing` hint.

## Files to change

- `index.html` — flesh out `#hero`:
  ```
  <section id="hero">
    <canvas id="hero-gl" aria-hidden="true"></canvas>
    <div class="hero-chrome">
      <div class="chrome chrome-tl">// AGENT_STATUS: <span class="dot"></span> ONLINE</div>
      <div class="chrome chrome-tr">// MODEL: gemini-3-pro · claude-haiku-4.5</div>
      <div class="chrome chrome-bl">// uptime: <span data-bind="uptime">11y</span></div>
      <div class="chrome chrome-br">&gt; try typing <span class="caret">_</span></div>
    </div>
    <div class="hero-stack">
      <p class="status-line">// initializing portfolio.agent</p>
      <h1 class="hero-name" data-bind="profile.name">Gaurav Lahoti</h1>
      <p class="hero-role"><span class="kw">class</span> <span class="cls">GauravLahoti</span> <span class="kw">extends</span> <span class="cls">CloudArchitect</span> { }</p>
      <p class="hero-tagline" data-bind="profile.tagline">…</p>
      <div class="hero-ctas">
        <a class="btn btn-primary" href="#stories">View Work</a>
        <a class="btn btn-ghost" data-bind-href="profile.links.topmate" target="_blank" rel="noopener">Book on Topmate</a>
      </div>
    </div>
  </section>
  ```
  All foreground text is rendered server-side from JSON-shaped
  defaults so a no-JS visitor still sees real content.
- `assets/css/layout.css` — `.hero` (full 100svh, grid layout
  for chrome corners + centered foreground stack).
- `assets/css/components.css` — `.btn-primary`, `.btn-ghost`,
  `.chrome`, `.dot` (pulse keyframe), `.caret` (blink),
  `.hero-name`, `.hero-role` (mono with `.kw` accent / `.cls`
  fg variants), `.hero-tagline`.
- `assets/js/main.js` — lazy-load the hero graph when `#hero` is
  in viewport; orchestrate the GSAP reveal timeline; wire
  `// uptime` ticker; gate the reveal behind `sessionStorage`
  so it plays once per session.
- `assets/js/shader.js` → **rename to** `assets/js/hero-graph.js`.
  Implement `initHeroGraph(canvas)` with Three.js: scene,
  perspective camera, Fibonacci-sphere node positions with
  noise jitter, edge list via k=2 nearest neighbors,
  `PointsMaterial` for nodes, custom `ShaderMaterial` for edges
  with per-vertex `aPathT`. Expose `.destroy()` and
  `.setPaused(bool)`.

## Files to create

None. The edge-pulse GLSL lives inline as a tagged-template
string inside `hero-graph.js` — no separate `hero.frag.js` file.

## New dependencies

CDN:
- Three.js core (only what we need: `Scene`, `PerspectiveCamera`,
  `WebGLRenderer`, `BufferGeometry`, `Points`, `LineSegments`,
  `PointsMaterial`, `ShaderMaterial`, `Group`).
- GSAP TextPlugin (for the name scramble) — already loaded for
  this site.

## Layered breakdown

| Layer | What | CDN libs |
|---|---|---|
| **Backdrop** | ~80 nodes on a Fibonacci sphere with noise jitter, edges via k=2 nearest neighbors. Slow Y-rotation. Mouse parallax (±6°) on the group. | three.js |
| **Edge pulse** | Custom `ShaderMaterial` on edges. `uProgress` uniform lights one edge along a precomputed path every ~1.4s. No bloom, no scan-lines, zero postprocessing. | three.js |
| **Foreground type** | Status line · name (Inter 700, oversized) · role as code declaration · tagline streaming in word-by-word. | GSAP, GSAP TextPlugin |
| **Chrome** | Four corner overlays from `profile.json` and computed values. Top-left status with pulsing dot. Top-right model list. Bottom-left live uptime ticker. Bottom-right blinking caret hint. | vanilla JS |
| **Interaction** | Mouse parallax → graph group rotation. Magnetic CTAs deferred to spec 08. Hovering any chrome line glitches it for one frame. | vanilla JS |

## Reveal sequence (0–3s, runs once per session)

| t | Event |
|---|---|
| 0.0s | Static frame — CSS gradient + chrome text + name in DOM. SSR-safe, no-JS readable. |
| 0.2s | Graph fades in over 600ms; rotation begins. |
| 0.4s | Chrome lines slide in from screen edges, stagger 80ms. |
| 0.7s | Name scrambles for 400ms, then locks. |
| 1.1s | Role line appears (syntax-highlighted mono). |
| 1.3s | Tagline streams word-by-word at ~28 tok/s (~900ms total). |
| 2.2s | CTAs ease-up + glow pulse on `--accent`. |
| 2.5s | First edge pulse fires; loop continues. |
| 3.0s | `> try typing _` caret begins blinking. |

## Rules for implementation

- Hero fills `100svh`. Mobile-safe (no `100vh` browser-bar bug).
- `prefers-reduced-motion` → render a single static frame, no
  rotation, no pulses, no streaming. Tagline appears whole; name
  appears unscrambled.
- `navigator.connection.saveData === true` OR viewport `< 768px`
  OR `gl === null` → swap the canvas for a CSS gradient
  (`background: radial-gradient(circle at 30% 20%, var(--accent-soft), var(--bg))`)
  and skip loading `hero-graph.js` entirely.
- DPR capped at 1.5. `requestAnimationFrame` paused via
  IntersectionObserver when `#hero` leaves viewport.
- `// uptime` is computed from `profile.careerStart` (e.g.
  `"2015-04"`); update once per minute via `setInterval(60_000)`.
  Format: `Ny Mm` (years, months).
- The reveal timeline gates on `sessionStorage.heroRevealed`.
  After first run it sets the flag; refreshes within the session
  show the final state instantly.
- Mouse parallax: `mousemove` → normalize to `[-1, 1]` → lerp
  `graphGroup.rotation.x/y` at 0.08 each rAF. Disabled on
  `(any-pointer: coarse)` (touch).
- No JS literals for colours. Pass `--accent` from CSS to the
  shader via a `uniform vec3 uAccent` (read from
  `getComputedStyle(document.documentElement)` once at init).
- Headline name uses `data-bind="profile.name"` so it renders
  from JSON. Scramble runs only on first paint of the session.
- The role line `class GauravLahoti extends CloudArchitect` is
  styled with `.kw` (keyword cyan) and `.cls` (class identifier
  white) spans — no JS-level syntax highlighter.

## Definition of done

- [ ] Hero fills `100svh`; no-JS visitors see chrome + name +
      role + tagline + CTAs over a static gradient.
- [ ] Three.js agent-graph renders with rotation + at least one
      edge pulsing at any moment, ≥55fps on a 2020 MacBook Air.
- [ ] Reveal sequence runs once per session (sessionStorage
      gate) and matches the timeline above.
- [ ] Name scrambles in ≤500ms; tagline streams word-by-word;
      all chrome lines populated from `profile.json`.
- [ ] `// uptime` reads from `profile.careerStart` and is
      correct to the month (cross-check: April 2015 →
      May 2026 displays `11y 1m`).
- [ ] Mouse parallax visibly tilts the graph; touch devices
      skip the parallax handler entirely.
- [ ] `prefers-reduced-motion`, `saveData`, viewport `<768px`,
      and `gl === null` all fall back to the static gradient +
      full text — verified manually in DevTools and on a real
      mobile device.
- [ ] Total JS at this milestone ≤ 260 KB gzipped (Three.js
      + GSAP TextPlugin + ~7KB of `hero-graph.js`).
- [ ] Lighthouse Performance ≥ 90 desktop / ≥ 80 mobile;
      LCP `< 2.5s` on simulated 4G; zero console errors.
- [ ] Keyboard: Tab reaches both CTAs with a visible focus ring
      before any chrome element steals focus.
- [ ] `assets/js/shader.js` no longer exists; `hero-graph.js`
      took its place with the same export contract
      (`init…(el) → { destroy(), setPaused(bool) }`).
