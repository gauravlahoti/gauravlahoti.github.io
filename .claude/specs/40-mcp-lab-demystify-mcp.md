# Spec 40: MCP Lab — Interactive "Demystify MCP" Demo

## Overview
A **standalone, fully client-side, on-repo** teaching visualization at `/mcp-lab/` that
demystifies the **Model Context Protocol (MCP)** through a **guided 6-act story**, the way
the Agentic RAG Lab (spec 38) demystified RAG. Unlike RAG Lab (off-repo FastAPI + live LLM),
MCP is conceptual and deterministic — so this ships with the site on GitHub Pages, costs
nothing to run, and is built to be **screen-recorded for LinkedIn**.

Format: 4 core acts (the shareable narrative spine) + 2 "go deeper" acts + a persistent
**FAQ drawer** that covers the long tail of questions. All copy + scripted data live in
`content/mcp-lab.json`; the visualization is one ES module reusing the site's motion DNA
(SVG + GSAP, cyan accent-glow, glyph-scramble, traveling dots, scan-line wipe).

## Locked decisions
| Decision | Choice |
|---|---|
| Hosting | **On-repo, client-side simulation** — no backend, no real MCP server; all JSON-RPC scripted & deterministic |
| Page model | **Standalone page** at `/mcp-lab/`, cloning the `/live-agents/` pattern (shared nav, `<base href="/">`, own boot module) |
| Story | **6 acts** (1–4 core spine, 5–6 "deeper") + persistent FAQ/glossary drawer |
| Rendering | **SVG + GSAP** for graphs; **DOM + GSAP** for the JSON-RPC message log & cards |
| Animation library | **GSAP 3.12.5** — already a global site dep; no new CDN origins, no CSP change |
| Determinism | No `Math.random()` — layout math + JSON drive everything; Prev→Next replays identically |
| Content | All copy + scripted messages in `content/mcp-lab.json` (content-in-JSON convention) |

## The six acts
1. **The Mess** — *why we need it / why not just APIs.* N×M tangle (3 apps × 4 tools = 12 connectors); "add a tool" → +1 connector per app (combinatorial explosion).
2. **The Standard** — *what MCP is + origin.* Tangle collapses to N+M through the MCP layer; "USB-C for AI"; origin caption (Anthropic, Nov 2024, David Soria Parra; modeled on LSP).
3. **The Handshake** — *how agents connect.* JSON-RPC 2.0 lifecycle `initialize` → `notifications/initialized` → `tools/list` (**dynamic discovery**) → `tools/call` → result, streamed as real messages; side rail shows primitives (server: tools/resources/prompts; client: sampling/roots/elicitation) + transports (stdio, Streamable HTTP).
4. **The Adapter** — *rewrite or translate?* MCP server is a NEW thin layer over an **untouched** REST/SQL backend; toggle between *naive 1:1 wrapper* (cascade of calls; ≈5.3× more tool invocations — Queen's U. study of 1,899 servers) and *agent-optimized capability* (one round-trip).
5. **The Landscape** *(deeper)* — *vs function calling / RAG / A2A; who adopts it.* Complementary layers, not rivals; adoption: OpenAI (Mar 2025), Google, Linux Foundation / Agentic AI Foundation (Dec 2025).
6. **The Caveats** *(deeper)* — *is it safe?* Tool poisoning / prompt injection, confused deputy, over-permissioning (~2,000 exposed servers, zero auth); mitigations: least privilege via `roots`, human-in-the-loop approval, vet/pin servers.

## Files
### New
- `mcp-lab/index.html` — standalone page; `<head>`/CSP/nav cloned from `live-agents/index.html`; body class `mcp-lab-page`; `<main>` = header + `<div data-mcp-root>` + footer; boots `assets/js/mcp-lab-page.js`.
- `assets/js/mcp-lab-page.js` — bootstrap mirroring `agents-page.js`: `playEntranceWipe()`, page chrome (year, nav drawer, resume), fetch `content/mcp-lab.json`, lazy-import `./mcp-lab.js` → `initMcpLab(root, { content })`, wire `[data-page-link]` → `runPageTransition`.
- `assets/js/mcp-lab.js` — the visualization. `export async function initMcpLab(rootEl, opts={}) → { destroy() }`. Houses the act controller, 6 act scenes, FAQ drawer.
- `assets/css/mcp-lab.css` — page + viz styles; new tokens in `:root`; CSS variables only; responsive ≤768px.
- `content/mcp-lab.json` — all copy + scripted data.

### Edited (nav links only)
- `index.html` — add `MCP Lab` link after Live Agents in `nav.nav-links` and `nav.nav-drawer-links`.
- `live-agents/index.html` — same link in both nav blocks.

### Unchanged / no CSP change
GSAP already whitelisted; only network call is same-origin `content/mcp-lab.json`. `rag-lab/index.html` untouched.

## Animation (on-brand, reused from the site's motion DNA)
- **Cyan accent-glow stack** `box-shadow: 0 0 0 1px var(--accent-soft), 0 0 28px var(--accent-glow)`; traveler-dot `drop-shadow(0 0 5px rgba(0,255,209,0.95))`.
- **Glyph-scramble** for act titles + JSON method names (Neural-Slash label technique).
- **Traveling dot** `SPEED≈260` svg-units/s, per-segment `ease:"none"`, fade-in 80ms / out 120ms (from `agents-page.js animateDiagram`).
- **Stroke-dash draw-on** for connectors/rails; **scale-pop** `back.out(2)`; **stagger cascade** `power3.out` (stagger 0.05); **scan-line + blade wipe** for act transitions (Neural-Slash vocab), `--danger` tint for Act 6; **pulse/breathe** for idle chips.
- Per-act "wow": Act 2 chaos→order collapse; Act 4 frantic-cascade vs single-pulse contrast.

## State machine (`mcp-lab.js`)
- Controller: `current` (0–5), `content`, active-scene teardown, `reduceMotion`.
- Scene contract: `mountActN(stage, content, { reduceMotion }) → { tl?, destroy() }`.
- Fixed shell: `.mcp-stage`, `.mcp-act-copy` (`aria-live="polite"`), `.mcp-dots` (acts 5–6 marked `deeper`), Prev/Next, FAQ toggle (drawer: Esc/backdrop close, focus-trapped).
- `goTo(i)`: destroy active scene → set copy/dots → mount new scene → scan-line/blade transition (instant under reduced motion) → glyph-scramble title.
- One GSAP timeline per act, killed on unmount. IntersectionObserver + `visibilitychange` pause. Keyboard ←/→; nodes `role="button"` + Enter/Space.
- `initMcpLab` returns `{ destroy }` (kills scene, removes listeners, empties root).

## Accessibility & mobile
- Reduced motion → final-state render + full copy + complete static message log; no timelines.
- Buttons in DOM order; `:focus-visible`; SVG `<title>`/`<desc>`; JSON log is real `<pre>`.
- ≤768px: stage stacks above copy; Act 3 single-column (dir → accent border); cards stack; sticky control bar; tap targets ≥ `var(--tap-min)`.

## Definition of done
1. `/mcp-lab/` loads; header/footer render; mounts into `[data-mcp-root]`; no 404s; console clean (no CSP violations).
2. All 6 acts navigate via Next/Prev + dots; copy from JSON; acts 5–6 marked "deeper".
3. Each act's beat works (tangle/explosion, collapse, full JSON-RPC stream, adapter toggle, landscape layers + adoption, caveats risks).
4. FAQ drawer opens from any act, jumps to the right act, Esc/backdrop closes, focus-trapped.
5. Prev→Next replays identically (no `Math.random`).
6. `prefers-reduced-motion` → static final state + full copy + full message log.
7. 375px → single-column, sticky controls, ≥44px targets, no overflow.
8. Keyboard ←/→ + Tab/Enter operate all controls; act changes announced.
9. "MCP Lab" nav link on `/`, `/live-agents/`, `/mcp-lab/`; routes via `runPageTransition`; active on MCP Lab page.
10. Animation reads as part of the same site (cyan glow, glyph-scramble, linear travel, `power3.out`/`back.out(2)`); ~60fps desktop; no timeline leaks across many Prev/Next cycles.

## IA addendum — AI Concepts hub
MCP Lab is presented as one entry in a broader **AI Concepts** hub rather than a top-level nav item:
- New `ai-concepts/index.html` + `assets/js/ai-concepts-page.js` + `content/ai-concepts.json` render a concept gallery (card per concept). MCP Lab is concept 01 (`/mcp-lab/`); Agentic RAG is concept 02 (`/rag-lab/` redirect). Hub styles live in `assets/css/mcp-lab.css` under `.ai-concepts-page`/`.concept-*`.
- Nav across `index.html`, `live-agents/`, `mcp-lab/` shows **"AI Concepts"** → `/ai-concepts/` (replaces the earlier "MCP Lab" entry). The MCP Lab page's active nav item and footer "All AI Concepts" link point back to the hub.
- The MCP demo keeps its shareable `/mcp-lab/` URL; the hub links to it via `runPageTransition`.

## Research basis
- N×M / why-not-APIs / USB-C / runtime discovery: Google Cloud, Databricks, Anthropic, Pragmatic Engineer (origin: David Soria Parra, LSP lineage).
- JSON-RPC lifecycle & primitives: modelcontextprotocol.io, philschmid, WorkOS/Glama (tools/resources/prompts + sampling/roots/elicitation); transports stdio vs Streamable HTTP.
- Adapter nuance: "Beyond API Wrappers", "MCP is not REST API" — naive 1:1 wrappers are an anti-pattern; Queen's U. study (1,899 servers, ≈5.3× more tool calls).
- Landscape: MCP vs function calling vs RAG vs A2A; OpenAI Mar 2025, Google managed MCP servers, Linux Foundation / AAIF Dec 2025.
- Caveats: Simon Willison, OWASP MCP cheat sheet, Checkmarx — tool poisoning, confused deputy, over-permissioning, Nov 2025 WhatsApp MCP incident.
