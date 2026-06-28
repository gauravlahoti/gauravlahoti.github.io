# CLAUDE.md — MCP Lab

Guidance for working on the **MCP Lab**: an interactive, six-act visual story that demystifies the
Model Context Protocol. This file is scoped to the lab; the repo-wide rules in the root
`CLAUDE.md` (design tokens, voice, no-build-step) still apply and win on any conflict.

## What it is

A fully client-side, deterministic teaching surface. No backend, no real MCP server — every
JSON-RPC message and metric is scripted in `content/mcp-lab.json`. It reuses the site's motion DNA:
SVG + GSAP, cyan accent-glow, glyph-scramble headings, traveling dots, scan-line wipe.

The same lab renders on two pages:
- `/mcp-lab/` — the standalone lab (`mcp-lab/index.html`).
- `/ai-concepts/` — the AI Concepts hub embeds it (`ai-concepts/index.html`).

## File map

| Concern | File | Notes |
|---------|------|-------|
| Page shell | `mcp-lab/index.html` | Chrome, CSP, font/GSAP CDN, mounts `mcp-lab-page.js` |
| Page boot | `assets/js/mcp-lab-page.js` | Year/nav/flyout chrome; fetches JSON; lazy-imports the lab |
| Lab engine | `assets/js/mcp-lab.js` | All visualization + animation. Contract: `initMcpLab(rootEl, { content }) → { destroy() }` |
| Content | `content/mcp-lab.json` | Source of truth for every act's copy, data, and scripted JSON-RPC |
| Styles | `assets/css/mcp-lab.css` | Section-commented per act; tokens only |

### Boot chain
`index.html` loads `mcp-lab-page.js?v=N` → it reads `?v=N` from its own URL and reuses `N` to
cache-bust both `content/mcp-lab.json` and the dynamic `import("./mcp-lab.js")` (see `_vq()` /
`_selfV` in `mcp-lab-page.js`). **So the JSON and the engine always load at the same version.**

> **Cache-bust rule:** after editing `mcp-lab.js`, `mcp-lab.css`, or `mcp-lab.json`, bump `?v=`
> in **both** `mcp-lab/index.html` and `ai-concepts/index.html`. Forgetting this serves a stale
> engine against fresh JSON (the classic `[object Object]` / broken-render symptom).

## Style guidelines

- **Content lives in JSON, never in JS or HTML.** All copy, labels, data, and scripted messages
  come from `content/mcp-lab.json`. The engine is generic; acts are data.
- **Tokens only.** Never hardcode hex/px. Pull from `base.css :root` (`--accent` `#00FFD1`,
  `--bg-card`, `--ink`, `--ink-muted`, `--border-strong`, `--space-*`, `--text-*`). The one
  pragmatic exception already in the engine: GSAP tweens that need the literal cyan use
  `"#00FFD1"` (e.g. `travelDot`), because GSAP can't read CSS vars mid-tween. Mirror that pattern
  rather than inventing new literals.
- **Fonts follow the repo rule.** `--font-mono` for eyebrows (`// 04 · under the hood`), counters,
  code/JSON, technical labels. `--font-sans` for headings, body, bullets, buttons.
- **Voice.** Natural and human. No em-dashes in *site copy* (JSON strings); short plain sentences.
  (This doc is internal, so it uses them freely — the rule is for user-facing text.)
- **CSS naming.** Everything is `mcp-` prefixed and grouped by a banner comment per act
  (`/* ─── act 5: handshake ─── */`). Keep new rules in the matching section.
- **DOM construction.** Build with the `el(tag, attrs, ...kids)` / `s(...)` (SVG) helpers at the
  top of `mcp-lab.js`. `el` supports `class`, `text`, `data-*`/`aria-*`/`role`/`tabindex`
  passthrough; everything else sets a property. Don't hand-write `innerHTML` for structured nodes.

## Animation guidelines

GSAP is loaded `defer` from CDN. The engine must render correctly **even if GSAP never arrives**.

- **`REDUCE_MOTION`** (`prefers-reduced-motion: reduce`) and **missing GSAP** are first-class
  states. Every motion helper returns `null` and lands the scene in its final, readable form when
  either is true. Always gate motion on `gsap() && !REDUCE_MOTION`.
- **`whenGsap(cb)`** defers mounting until GSAP is available (or ~900ms timeout), then renders.
- Acts that animate expose a timeline as `active.tl`. An **IntersectionObserver** (`observeStage`)
  plays it when the stage scrolls into view and pauses it when it leaves.
- **Act transitions:** `goTo(i)` crossfades `[actHeader, stageWrap, copy]` (Apple-style: the box
  holds size, contents swap). `playWipe()` runs the cyan **blade** scan-line. `renderAct(i)`
  destroys the old mount (`active.destroy()`), clears `stage`/`extra`, and remounts.

### Shared motion primitives (reuse these — don't reinvent)

| Helper | Effect |
|--------|--------|
| `glyphScramble(node, text, dur)` | Random→locked character reveal for headings (Neural-Slash technique) |
| `travelDot(svg, pts, opts)` | Glowing dot riding a polyline; returns a timeline |
| `drawOn(pathEl, opts)` | Stroke draw-on via `strokeDasharray`/`Dashoffset` |
| `serpentinePath / wirePath` | Snaking pipe / bowed quadratic wires between nodes |
| `nodeGroup / subNode` | Labeled rounded-rect SVG nodes (stash `_cx/_cy/_w/_h` for wiring) |
| `svgLines / wrapText` | Multi-line SVG `<text>` without DOM measuring |
| `playWipe()` | Cyan blade scan-line between acts |

## Stage chrome (shared across all acts)

- **Header bar** (`renderAct`): `eyebrow` + glyph-scrambled `title` + `body`.
- **Stage** (`.mcp-stagewrap`): the SVG visualization, with top-right **Replay** + **Expand**
  (`setExpanded` toggles a full-screen overlay with a backdrop; `Esc` collapses).
- **Copy column** (`.mcp-copy`): per-act `extra` content **plus a stable `.mcp-analogy-slot`**.
- **Controls**: prev/next (next becomes "Restart ↺" on the last act) + a dot tablist (dots with
  `deeper: true` get `.is-deeper`). Keyboard: `←/→` change acts, `Esc` exits expand.

### The analogy card (every act)
Each act carries an `analogy` object in JSON, rendered centrally by `buildAnalogy()` into the
stable slot (it lives **outside** `extra`, so per-act mounters never disturb it). Shape:

```json
"analogy": { "glyph": "≈", "lead": "Like a restaurant menu.", "points": ["…", "…"] }
```

Renders as: `// in plain terms` eyebrow → bold `lead` → cyan-dot bullet list. A legacy
`{ glyph, text }` prose form is still supported as a fallback. Tone: everyday and relatable.

## The six acts (stages)

Acts are objects in `content/mcp-lab.json` `acts[]`, dispatched by `id` through the `MOUNTERS`
map in `mcp-lab.js`. Order = array order. To reorder, move the JSON object; to restyle, edit the
matching CSS section.

| # | `id` | Eyebrow | Mounter | Teaches | Visualization | Signature motion |
|---|------|---------|---------|---------|---------------|------------------|
| 1 | `mess` | `// model context protocol` | `mountMess` | The M×N integration sprawl; swap a model and bespoke glue breaks | Models ↔ services wired by `◆` connectors; counter of integrations | Phrase-journey **intro overlay** (once per load), then progressive story beats; swap/multiply toggles fan wires in |
| 2 | `standard` | `// 02 · the fix` | `mountStandard` | One standard collapses M×N → M+N | "Old World" tangle vs "MCP World" hub, side by side | `drawOn` wires; Origin/Adoption facts in copy |
| 3 | `humanapi` | `// 03 · the mismatch` | `mountHumanApi` | APIs were built for human integrators who cache the call as code | Iteration loop → frozen code artifact → flawless run counter | Looping draw; counter ticking to 1,000,000 |
| 4 | `underhood` | `// 04 · under the hood` | `mountUnderHood` | Client ↔ server; the three server primitives | Client/server boxes; tools/resources/prompts legend (model/app/user-controlled) | `discover → call` loop, `travelDot` between client and server |
| 5 | `handshake` | `// 05 · the wire` | `mountHandshake` | JSON-RPC 2.0 lifecycle; `tools/list` is dynamic discovery | Two lanes (client/server) with stepped message exchange | Step list lights up in sync with traveling messages; transports note |
| 6 | `vsapis` | `// 06 · mcp vs apis` | `mountVsApis` | MCP is an abstraction over existing APIs, not a replacement | Isometric 3D layer stack (model → MCP → infra) | Layered reveal; callout that the model never sees REST |

> **Dead code:** `mountAdapter`, `mountLandscape`, `mountCaveats` (and their CSS) are retained but
> **not in `MOUNTERS`**. Don't wire them back without a spec. CSS still has stale "act 6/7"
> banners from that history — match an act by its `id`, not by a CSS comment's number.

### Per-act JSON contract (high level)
Common: `id`, `eyebrow`, `title`, `body`, `analogy`. Act-specific keys, e.g. `mess` →
`intro/apps/tools/painPoints/swap*/reveal*`; `standard` → `old*/mcp*/analogy/origin/adoption`;
`humanapi` → `loop/artifact/run/narration/insight/bridge`; `underhood` → `primitives/narration`;
`handshake` → `transports/messages[]` (each a real JSON-RPC frame); `vsapis` → `layers/callout`.
Read the act's mounter before adding keys — the engine only renders what the mounter consumes.

## Adding or changing content

1. Edit `content/mcp-lab.json` (copy, data, scripted messages). Keep the act's existing key shape.
2. If structure changes, update the matching `mountX` in `mcp-lab.js` and its CSS section.
3. Keep it accurate: this lab makes dated protocol claims (spec version, governance, adoption).
   Verify against `modelcontextprotocol.io` before changing facts.
4. **Bump `?v=`** in `mcp-lab/index.html` **and** `ai-concepts/index.html`.
5. `python3 -m json.tool content/mcp-lab.json` and `node --check assets/js/mcp-lab.js`.

## Verify

```bash
python3 -m http.server 5173   # then open /mcp-lab/ and /ai-concepts/
```

Step every act (← / →): heading scrambles in, the visualization plays, the analogy card sits at
the foot of the copy column. Check Expand/Replay, the dot tablist, mobile width (`.mcp-bodygrid`
stacks), and `prefers-reduced-motion` (everything lands static and readable, no `null`-tween
crashes).
