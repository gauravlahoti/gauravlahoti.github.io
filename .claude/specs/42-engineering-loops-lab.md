# Spec 42: Engineering Loops — Interactive "How Agents Grew Up" Explainer

## Overview
A **standalone, fully client-side, on-repo** teaching visualization at `/engineering-loops/`,
the third entry in the site's **AI Lab** (`/ai-concepts/`) after MCP Lab (spec 40) and the
Agentic RAG Lab (spec 38). It explains the evolution of agent engineering as **four nested
loops**: **Prompt → Context → Harness → Loop**, each ring wrapping the one inside it.

It refines a static "four loops, nested" sketch that crammed every layer's actors and labels
on screen at once (unreadable). The interactive version keeps the nested rings as a persistent
structure but reveals **one focused layer at a time** (its actors, annotations and animation),
plus a guided center→outward **Tour**. Deterministic, no backend, screen-recordable.

## Locked decisions
| Decision | Choice |
|---|---|
| Hosting | On-repo, client-side, deterministic. No backend. |
| Page model | Standalone page at `/engineering-loops/`, cloning the `/mcp-lab/` shell (shared nav, `<base href="/">`, own boot module) |
| Interaction | **Focus one layer at a time** + guided center→outward Tour + free clicking. Nested rings always visible; non-focused rings dim. |
| Rendering | SVG + GSAP for the ring diagram + per-layer scenes; DOM + GSAP for the detail panel |
| Animation library | GSAP 3.12.5 (already a global site dep; no new CDN origin, no CSP change) |
| Determinism | No `Math.random()` outside the shared `glyphScramble`; layout math + JSON drive everything; navigation replays identically |
| Content | All copy in `content/engineering-loops.json` (content-in-JSON convention) |
| Fallbacks | `prefers-reduced-motion` and missing-GSAP are first-class: everything lands static and readable |

## The four layers (center → outward)
1. **Prompt Engineering** (2022–2024, human-guided) — "Just tell it what to do." Shape the words:
   role, steps, examples, think step by step. Actors: a user + speech bubble to the model.
   Ceiling: a perfect prompt can't supply facts the model never received.
2. **Context Engineering** (2025, human-assembled, agent starts fetching) — "Give it what it needs
   to know." Curate everything the model sees: history, retrieved docs, tool output, state. The
   agent reads files and calls tools to gather its own context. Ceiling: one context window fills.
3. **Harness Engineering** (2026, hybrid) — "Build the world it runs in." Everything around the
   agent except the model (Agent = Model + Harness): tools, a sandboxed worktree, memory on disk,
   a task list worked one item at a time into a fresh context, verifiers that feed back. Insight:
   most "prompt failures" in production are really harness failures.
4. **Loop Engineering** (2026+, self-guided) — "Set a goal, let it run." Put the harness in motion:
   goal → reason → act → observe → decide → repeat, until a stop condition. A scheduler wakes it;
   it grows itself (skills + plugins, subagents that verify work, parallel worktrees).

## Files
### New
- `engineering-loops/index.html` — standalone page; `<head>`/CSP/nav cloned from `mcp-lab/index.html`;
  body class `loops-lab-page`; `<main>` = `<div data-loops-root>` + footer; boots
  `assets/js/engineering-loops-page.js`.
- `assets/js/engineering-loops-page.js` — bootstrap mirroring `mcp-lab-page.js`: `playEntranceWipe()`,
  page chrome (year, nav drawer, resume, Insights flyout), fetch `content/engineering-loops.json`,
  lazy-import `./engineering-loops.js` → `initEngineeringLoops(root, { content })`, wire
  `[data-page-link]` → `runPageTransition`. Self `?v=` cache-busts JSON + engine.
- `assets/js/engineering-loops.js` — the visualization. `export function initEngineeringLoops(rootEl,
  opts={}) → { destroy() }`. Ring diagram + focus controller + four per-layer scenes + Tour.
- `assets/css/engineering-loops.css` — page + viz styles; CSS variables only; responsive ≤768px.
- `content/engineering-loops.json` — all copy + layer data.

### Edited
- `content/ai-concepts.json` — add concept card `id: "loops"`, `num: "03"`,
  `title: "Engineering Loops"`, `href: "/engineering-loops/"`, `internal: true`,
  `cta: "Open Engineering Loops"`. (Card rendering already generic in `ai-concepts-page.js`.)

### Unchanged / no CSP change
GSAP already whitelisted; only network call is same-origin JSON. MCP/RAG labs untouched.

## Interaction model (`engineering-loops.js`)
- Controller: `focus` (0–3), `content`, active-scene teardown, `REDUCE_MOTION`, tour timer.
- Persistent SVG: four concentric rounded-rect rings drawn center→outward, each `role=button`,
  keyboard-focusable, accessible-labelled. Focused ring brightens + glows; others dim.
- Scene contract: `mountLayer(scene, layer, { reduceMotion }) → { tl?, destroy() }`. Only the
  focused layer mounts actors/annotations/animation; the rest show ring + corner label only.
- Detail panel (below diagram): glyph-scrambled `NN · TITLE`, era chip, guidance chip, hook,
  definition, insight line, collapsible analogy (reuse `buildAnalogy`).
- Controls: `◀ prev` · dot tablist `● ○ ○ ○` · `next ▶` (→ `↺ Restart` on last) · `▶ Tour`
  (auto-advance center→outward ~5s/layer, → `⏸ Pause`). Keyboard `←/→` change focus, `Esc` stops
  tour.
- Per-layer signature motion (all land static under reduced-motion / no-GSAP):
  Prompt = user + speech bubble, dot travels human→model; Context = tool→read→tool, dots pulled
  into center; Harness = task list 1..5 + memory cylinder, one task into a fresh-context box;
  Loop = outer spinning arrow + scheduler clock + three "it grows itself" chips.

## Reused primitives (ported from `mcp-lab.js`)
`el()`/`s()`, `glyphScramble()`, `travelDot()`, `drawOn()`, `whenGsap()`, `wrapText()`/`svgLines()`,
`buildAnalogy()`, `REDUCE_MOTION` gating. Nav-drawer / Insights-flyout / page-transition copied
from `mcp-lab-page.js`.

## Definition of done
- `/ai-concepts/` lists the Engineering Loops card (03); it opens with the Neural-Slash transition.
- `/engineering-loops/` renders four nested rings center→outward; detail panel starts on layer 01.
- Clicking a ring / `←/→` / dot tablist changes focus; only the focused layer shows actors +
  animation, others dim. Tour auto-advances center→outward and pauses.
- Analogy card expands; "All AI Lab" back-link returns to `/ai-concepts/`.
- `prefers-reduced-motion` and GSAP-blocked both land static + readable, no null-tween errors.
- Mobile ≤768px: rings scale via `viewBox`; detail panel stacks under the diagram.
- Voice: natural, no em-dashes in copy; tokens only; `--font-mono` eyebrows/chips, `--font-sans`
  headings/body.
