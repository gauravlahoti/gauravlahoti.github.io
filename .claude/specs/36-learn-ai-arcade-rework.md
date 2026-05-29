# 36 — Rework `/learn/` into a real arcade game (walkable map + canvas mini-games)

## Overview

Spec #35 shipped `/learn/` as a **quiz on a passive map**: the visitor clicks multiple-choice / flip /
drag answers and a token auto-slides between six SVG nodes (Spark Plains → Logic Lake → Tool Forge →
Memory Mesa → Crossroads → Use-Case Summit). It reads like a slideshow, not a game.

This spec turns it into a genuine "visual treat" arcade game that teaches the **same** LLM/Agent
concepts **through play**. The visitor still picks a character (*Sparkfist* / *Hopper*) and a mode
(**Tech** / **Plain**), then enters a **walkable neon overworld**: the hero is player-controlled and
walks the six-node map; reaching a node opens a real **Canvas 2D arcade mini-game** whose mechanic
*is* the concept. Score, hearts, and per-level completion persist with a resume option, and the recap
screen reinforces every concept. The page keeps the proven standalone-page pattern: shared nav, ES
modules, one stylesheet, GSAP via CDN, **no build step, no new dependencies, no CSP change**.

Direction confirmed with the user: **walkable overworld + arcade mini-games**, **neon vector procedural
art** (all art drawn in code, zero image assets, colours from `base.css` tokens), **concepts baked into
mechanics**, **all 6 levels in one pass**.

## Concept → mini-game mapping

Archetype is derived from the existing `stage.type`; the existing per-type data drives each mechanic
(no structural `learn.json` change):

| Stage | `type` | Archetype | Mechanic |
|-------|--------|-----------|----------|
| Spark Plains (LLM = next-token) | quiz | **PICK** | Forming sentence; 3 token orbs (`options[]`) approach; steer/jump into the next-likely token (`correct`). Wrong = lose heart + `feedback.wrong`. |
| Logic Lake (LLM limits) | reveal | **BOP** | 3 floating "myth" enemies (`card.front`); bop each → reality (`card.back`) pops up. |
| Tool Forge (assemble an agent) | buildPuzzle | **COLLECT** | Gather 4 power-up parts (`pieces[]`) → snap into agent frame (`slots[]`) → power meter fills. |
| Memory Mesa (agent loop) | sortOrder | **ORDER** | Step on 4 gates (`steps[]`) in order; wrong resets; correct closes the loop cycle. |
| Crossroads (LLM vs Agent) | sortBuckets | **SORT** | Route capability tokens (`items[]`) into LLM vs Agent gate (`buckets[]`); wrong = lose heart. |
| Use-Case Summit (pick the tool) | sortBuckets | **SORT (boss)** | Same SORT, faster/harder — the finale. |

→ 5 reusable archetypes (PICK, BOP, COLLECT, ORDER, SORT) + 1 walkable **OVERWORLD** scene.

## Depends on

- Spec #35 content/data (`assets/js/data/learn.json`), `state.js`, `characters.js`, the intro/recap DOM
  flow, and `page-transition.js` — all reused or extended.

## Routes

No backend. Fully client-side; no new network calls (only the existing same-origin `learn.json` fetch).

## Database changes

None.

## Frontend changes

**New — engine core (`assets/js/learn/engine/`):**
- `loop.js` — fixed-timestep game loop (`STEP=1/60`, delta clamp); owns the single `requestAnimationFrame`;
  auto-pauses on `document.hidden`; `start/stop/pause/resume`.
- `canvas.js` — single `<canvas>`, **DPR capped at 1.5**, `ResizeObserver` (rAF-coalesced), fixed logical
  play-field (reuse the `node{x,y}` 0..860/0..520 space) with letterbox scaling.
- `input.js` — unified action set (`left/right/up/down/action`) from keyboard (Arrows/WASD + Space/Enter)
  **and** on-screen touch controls; pointer/tap routing for SORT/PICK; edge-triggered `justPressed`; `destroy()`.
- `palette.js` — reads `base.css` tokens once via `getComputedStyle` into a singleton (`--accent`, `--danger`,
  `--era-deloitte`, `--bg*`, `--ink*`). Single source of truth — no hardcoded hex in JS.
- `draw.js` — neon-vector primitives (`neonStroke/Poly/Circle`, `scanlineBg`, `gridFloor`, `particleBurst`);
  every glow/particle/shake effect takes a `decorative` flag the engine forces off under reduced-motion.
- `scene.js` — Scene contract `{ mount(ctx, env), update(dt), render(ctx, alpha), resize(w,h), destroy() }`
  + `createSceneManager(surface, loop, env)`. `env = { input, palette, width, height, data, mode, store,
  reduceMotion, onComplete, onExit }`. Scenes never touch the store directly — they call injected
  `onComplete({stageId, attempts, hearts, points})`.

**New — scenes & mini-games:**
- `scenes/overworld.js` — walkable map (replaces the passive token). Draws neon route + nodes with
  done/current/locked states from the store; player walks; reaching the current node enters its level;
  locked nodes block entry.
- `minigames/base-level.js` — `createLevelScene(stage, archetypeModule, env)`: owns the player entity +
  hero draw, backdrop, HUD model (hearts/power/progress), the per-level "check/boss" beat, win aggregation,
  and `onComplete`. Delegates mechanic-specific logic to the archetype module.
- `minigames/index.js` — `archetypeFor(stage)` maps `type → module` (`quiz→pick`, `reveal→bop`,
  `buildPuzzle→collect`, `sortOrder→order`, `sortBuckets→sort`); `use-cases` → `sort` with `boss:true`.
- `minigames/{pick,bop,collect,order,sort}.js` — each exports `{ init, update, render, onAction, destroy }`,
  mechanic-only; shared scaffolding lives in `base-level.js`.

**New — DOM overlays over the canvas (crisp text + a11y):**
- `ui/hud.js` — mode label, stage X/6, score, hearts, power meter; `position:absolute; inset:0;
  pointer-events:none` (interactive children re-enable); writes only on change; `aria-live="polite"`.
- `ui/touch-controls.js` — dpad + action button, shown on `(pointer:coarse)` or first touch; real
  `<button aria-label>`, `--tap-min` sized, `touch-action:none` + scoped `preventDefault`; tap-to-route
  for SORT/PICK.
- `ui/concept-panel.js` — **always-present accessibility + learning fallback**: "Read it instead" pauses
  the loop and shows `title/prompt/recap/feedback.correct` (dual-mode); "Mark as learned →" calls
  `onComplete({points: meta.pointsReveal})`. Guarantees keyboard-only / screen-reader / non-gamer visitors
  learn every concept and reach the recap. Also hosts per-level win text.

**Modified:**
- `assets/js/learn-game.js` — add `renderGame()` (mounts `.learn-stage` = canvas host + HUD + touch-controls
  + concept-panel; boots `surface/loop/manager`; routes to overworld or active level) and `teardownGame()`
  (stops loop, destroys scenes/UI, removes listeners — called before any screen switch to prevent duplicate
  loops/leaks). `render()` dispatcher: `overworld|level → renderGame()`, else recap, else intro. "Start" now
  sets `screen:"overworld"`. Intro/recap DOM renderers stay. The five DOM interaction renderers leave the
  gameplay path.
- `assets/js/learn/state.js` — **bump key `learn:v1` → `learn:v2`**. `freshState` gains `levels:{}`
  (`{[stageId]:{done,attempts,points,hearts}}`), `hearts`, `power`. New methods `completeLevel(stageId,{points,hearts})`,
  `enterLevel(stageId)`, `currentNodeIndex()`. Migration: read old `learn:v1` once, map `answers→levels`
  (`done = answer.correct`), carry `score`, set `screen:"overworld"`, clear v1; guard every field, else start
  fresh. Resume persists only `screen:"overworld"` + completed `levels{}` — live entity state is not serialized;
  a half-finished level restarts.
- `assets/js/learn/characters.js` — reuse the existing Sparkfist/Hopper SVG art as the in-game hero (blit each
  character's SVG to an offscreen canvas once and draw it; fallback to a coded vector hero in `draw.js`).
- `assets/js/data/learn.json` — no structural change required. Optional additive per-stage `"arcade":
  {spawnSpeed, hearts, boss}` for difficulty tuning (defaulted in code; `use-cases.arcade.boss=true`).
- `learn/index.html` — bump cache versions (`learn-game.js?v=2`, `learn.css?v=2`, `learn.json?v=2`). No CSP
  change (canvas, rAF, `getComputedStyle`, observers are in-page; only same-origin JSON fetched).

**Retired:**
- `assets/js/learn/worldmap.js` — passive token tweening (its node-drawing is cannibalized into the canvas overworld).

## CSS changes

- `assets/css/learn.css` (modified, `?v=2`) — add `.learn-stage` (16:9-ish canvas frame, `--radius-lg`,
  `1px solid var(--border)`), `.learn-canvas-host`, `.learn-hud` overlay variant (hearts/power via
  `--accent`/`--danger`, `--font-mono`), `.learn-touch` (safe-area insets, `--tap-min`, `:active` accent
  glow, hidden until `.is-touch`), `.learn-concept-panel` (focus-trapped, `--bg-elev`/`--border-strong`,
  reuses `.btn .btn-ghost`/`.btn-primary`). Extend the existing `@media (prefers-reduced-motion: reduce)` and
  `@media (max-width: 767px)` blocks (force touch controls visible, size stage to viewport on mobile). Prune
  dead quiz/flip CSS in a later pass once nothing references it.

## New dependencies

None — GSAP (DOM chrome only, never inside the game loop) is already loaded via jsdelivr with SRI.

## Rules for implementation

- **CSS variables only — never hardcode hex.** Canvas colours come from `palette.js` reading `base.css` tokens.
- Native ES modules with relative imports — no bundler, no npm, no build step.
- **One game loop, one canvas.** The SceneManager owns the loop; every scene/UI module exposes `destroy()`;
  `teardownGame()` runs before any screen switch. No GSAP inside the rAF loop.
- **Performance:** fixed timestep; DPR ≤ 1.5; pause the loop on `document.hidden` and on scroll-out
  (IntersectionObserver); no per-frame allocations; HUD writes only on change. Keep JS < 400 KB gzipped, FCP < 1.5s.
- **Respect `prefers-reduced-motion`:** disable parallax / particles / shake / glow-pulse / scanline / crossfade
  (instant scene swap); gameplay motion stays calm but playable.
- **Accessibility:** the "Read it instead / Mark as learned" path is always present so keyboard-only /
  screen-reader / non-gamer visitors complete every level and reach the recap; HUD/controls are focusable
  `<button aria-label>`; canvas has `role="img"` + descriptive `aria-label`; manage focus after win/panel close.
- **Mobile (≤768px / coarse pointer):** on-screen dpad + action button; tap-to-route for SORT/PICK; no page
  scroll during play; tap targets ≥ `--tap-min`.
- Original art and names only — neon-vector shapes, no copyrighted Goku/Mario assets.

## Build order (de-risk the engine first)

1. `engine/loop.js` + `engine/canvas.js` + `engine/scene.js` + a placeholder scene → verify clean
   start/stop/pause across screen switches and resize, no leaks. **Before any mini-game.**
2. `engine/input.js`, `engine/draw.js`/`palette.js`, hero blit.
3. `scenes/overworld.js` wired into `renderGame()` + `state.js` v2.
4. `minigames/base-level.js` + `ui/hud.js` + `ui/concept-panel.js`.
5. The 5 archetypes + `ui/touch-controls.js`.
6. Recap wiring, reduced-motion gating, mobile pass, CSS polish.

## Definition of done

- [ ] Intro lets the visitor pick a character + mode; Start → walkable **canvas overworld** (no console errors).
- [ ] Overworld: hero is keyboard/touch controlled; locked nodes block entry; reaching the current node opens its level.
- [ ] All 6 mini-games are playable end-to-end: PICK (catch correct vs heart loss + `feedback.wrong`), BOP (flip all 3 myths), COLLECT (gather 4 parts, power meter fills), ORDER (correct sequence completes / wrong resets), SORT ×2 (`use-cases` boss faster). Each awards points and marks its node done.
- [ ] Switching mode swaps all copy from `learn.json` (no hardcoded learning strings in JS).
- [ ] "Read it instead / Mark as learned" completes every level via keyboard alone and reaches the recap.
- [ ] Completing all 6 → recap screen shows final score + per-stage recap + replay / switch-mode.
- [ ] Score, hearts, and per-level completion persist (`learn:v2`); reload resumes into the overworld with done nodes + score retained; old `learn:v1` migrates or is ignored cleanly; storage failures play in-memory.
- [ ] With `prefers-reduced-motion: reduce`: no particles/shake/parallax/pulse/crossfade; gameplay still playable; canvas `aria-label` present; sane focus order.
- [ ] Responsive at ≤768px / coarse pointer: on-screen dpad + action button, tap-to-route works, no horizontal scroll, ≥44px targets, safe-area respected.
- [ ] Steady ~60fps; loop pauses on tab-hidden and scroll-out; DPR ≤ 1.5 on HiDPI.
- [ ] No CSP violations; only `self` + `cdn.jsdelivr.net` (GSAP). No hardcoded hex in `learn.css`/`learn-game.js`/engine — all colours via `base.css` tokens.
