# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Static, single-page portfolio for Gaurav Lahoti (Cloud & AI Architect). Dark "AI terminal" aesthetic. No framework, no bundler, no build step — `git clone` → `python3 -m http.server 5173` → running site. Every feature ships through a spec in `.claude/specs/`.

## Run locally

```bash
python3 -m http.server 5173
```

## Slash commands

| Command | Purpose |
|---------|---------|
| `/run-site` | Boot the static dev server |
| `/create-spec <step> <slug>` | Scaffold a spec file + feature branch |
| `/implement-spec <step>` | Read spec, plan, implement |
| `/add-project` | Add a node to `graph.json` |
| `/add-post <linkedin-url>` | Fetch post title, confirm, prepend to `posts.json` |
| `/refresh-post-metrics` | Trigger Pulse ad-hoc to scrape LinkedIn engagement → D1 (updates Perspectives chips; no email) |
| `/run-ambient-digest` | Run the full Pulse cycle ad-hoc (visitor stats + insights + one dashboard email) |
| `/ship` | Commit branch → PR → squash-merge to main |
| `/publish` | Commit + push → trigger Pages deploy |

## Architecture

| Layer | Location | Notes |
|-------|----------|-------|
| HTML | `index.html` | Single page; semantic anchors |
| Standalone pages | `agent-portfolio/index.html` | `/agent-portfolio/` portfolio; shares the nav but boots its own module |
| CSS | `assets/css/{base,layout,components,agents}.css` | `base.css` holds all variables; `agents.css` styles the `/agent-portfolio/` page |
| JS modules | `assets/js/{main,trajectory,hero-graph,cursor,agent-widget}.js` | One module per surface. (`resume-gate.js` deleted 2026-08-09 — the Google Sign-In download gate it powered was retired 2026-06-10; the Resume link goes straight to `/resume.pdf` now.) |
| Agent-portfolio JS | `assets/js/{agents-page,page-transition}.js` | `agents-page` renders agent cards from `agents.json`; `page-transition` is the "Neural Slash" transition between main ↔ `/agent-portfolio/` |
| Additional JS | `assets/js/{analytics,posts-list,skills-hex,token-bridge,scroll-restore}.js` | Beacon, Perspectives, hex grid, auth token, scroll |
| Content data | `content/*.json` | `profile.json`, `graph.json`, `posts.json`, `agents.json`. See `content/README.md` for the file-by-file map. Live post-engagement metrics come from the `/api/post-metrics` endpoint, not a static file. |
| Static media | `assets/img/`, `diagram-icons/`, `agent-portfolio/diagrams/` | Resume PDF, OG image, favicon, badges (`assets/img/`); vendor/cloud logos for architecture art (`diagram-icons/`); per-agent architecture SVGs referenced by `agents.json` → `diagramSvg` (`agent-portfolio/diagrams/`) |
| Backend | `backend/` | Resume-gate + agent audit log + analytics + GCP cost alerts |
| MCP server | `resend_mcp_server/` | Standalone Node.js MCP server wrapping Resend API |
| AI Lab hub | `ai-labs/index.html` | `/ai-labs/` — lists all labs as cards, sourced from `content/ai-concepts.json` |
| Redirect stub | `ai-labs/rag-lab/index.html` | Static redirect → `https://agentic-rag.gauravlahoti.dev/` (the RAG Lab agent is served off-repo) |
| MCP Lab | `ai-labs/mcp-lab/index.html`, `assets/js/mcp-lab.js`, `assets/css/mcp-lab.css`, `content/mcp-lab.json` | 6-act interactive SVG explainer for the Model Context Protocol. Content in JSON; each act has a `mountXxx()` function in `mcp-lab.js`. Nav is prev/next buttons top-right of heading with GSAP slide transitions. Friction labels use `--mcp-tool` amber. Narration supports `**word**` markdown-bold → `.mcp-accent` cyan highlight. |
| Engineering Loops | `ai-labs/engineering-loops/index.html`, `assets/js/engineering-loops.js` (+`-page.js` boot), `assets/css/engineering-loops.css`, `content/engineering-loops.json` | Single-page interactive explainer of prompt → context → harness → loop engineering as **four ADDITIVE layers on one shared canvas** (`viewBox 0 0 1440 1080`) — advancing a layer keeps every layer before it, so the picture builds outward around the shared **Model** anchor (`M.cx/M.cy`). `buildAll()` draws every layer once into its own `<g class="m-<id>">` (each split into `loops-step` groups), returning `{ groups, steps, anims }`. `focusLayer()`→`playAdditive(i)` shows layers `0..i`, hides the rest, staggers in layer `i`'s step groups, then starts `anims[id]()`; only the focused layer's animation runs, **except context's own loop keeps running once reached** (it's the throughline). **Prompt**: stick-figure `human` ⇄ the `Model` box (centred label + official Claude+Gemini+OpenAI marks via `brandLogo()`), `prompt` out / `output` back, `✗ not what you wanted` / `↻ tweak & send again`, an `a loop` arc. **Context**: the Model calls `tools + files` in a `↻ agent loop` (gather → append → read → repeat); each call drops a `docGlyph` into the `context window` (6 tiles: system prompt, history, 2×docs, 2×tool result — the amber pair, not red, since they accumulate rather than fail) that fills → `FULL!` → `summarize → detail lost` / `context rot → goal drifts`. **Harness**: purple outermost ring wrapping the teal context box, with `tools + resources` in the gather lane, `task list on disk` (named tasks — frontend/backend/database/qa/deploy, with a tick/strikethrough "done" animation) wired dead-straight below the Model's own centreline, and `memory on disk` + `into a fresh context` positioned beside the context window as real stations on a 3-leg compaction loop (`write` → `rehydrate`) that lands flush on the window's right edge without crossing the Model→tools arrow. **Loop**: outer feedback arc, scheduler clock, "it grows itself" chips. Glyph builders `stickFigure/docGlyph/memoryGlyph/targetGlyph/brandLogo`; connectors via `orthoConnector()` (sharp right-angle bends only — `stroke-linejoin: miter`, never curved). Contract `initEngineeringLoops(root,{content})`; deep-linkable via `#prompt/#context/#harness/#loop`. Coda "looped vs manual" line chart draws on scroll. Bump `?v=` in `ai-labs/engineering-loops/index.html` after editing its JS/CSS/JSON. |
| WebMCP | `assets/js/webmcp.js` | Registers this site's WebMCP tools (`document.modelContext`, feature-detected against `navigator.modelContext` for older Chrome builds) so an AI agent can call named, typed functions instead of scraping the DOM. Pure `defineTools(ctx)` returns 13 tool defs (8 read-only, 2 UI-coupled, 1 human-in-the-loop `draft_note_to_gaurav` that only pre-fills the Atlas composer and never sends, plus 2 AI Lab hub-only tools); `registerWebMcp({scope, profile})` filters by page scope and registers with the browser. No write tools. `main.js` and each standalone page module call `registerWebMcp` with their own scope on boot; see `.claude/specs/45-webmcp-agent-ready.md` for the full scope table. |
| Agent-Ready Web lab | `ai-labs/agent-ready/index.html`, `assets/js/webmcp-lab.js` (+`-page.js` boot), `assets/css/webmcp-lab.css`, `content/webmcp-lab.json` | Demo page for `webmcp.js`: a live tool registry read straight from `document.modelContext.getTools()`, and a console that runs any tool (locally, or through the browser's own `executeTool` where supported) and shows the real JSON output against Chrome's 1,500-char budget. See its own `CLAUDE.md`. |

## Backend, analytics & MCP → `.claude/docs/backend.md`

`backend/` is the site's general-purpose backend: Cloudflare Worker + D1 in prod (`backend/src/index.js`), Node + SQLite locally (`backend/local-server.js` → `:8787`). Holds the agent audit log (`agent_interactions`), resume/note send-and-rate-limit endpoints, self-hosted page-view analytics (`page_views`, `daily_stats` rollup), post metrics, and GCP cost alerts. It kept the "resume-gate" name from its original purpose — gating the resume PDF behind Google Sign-In — but that gate was retired 2026-06-10; the Resume link is a direct `/resume.pdf` now, and `resume_downloads` is read-only historical data. `resend_mcp_server/` is a Cloud Run MCP server exposing `send-email`, used by both agents.

→ **Full endpoint list, migrations, audit-log schema, scripts, analytics beacon, and MCP commands: `.claude/docs/backend.md`.**

## Agents (`agents/`) → `.claude/docs/agents.md`

Three independent Google ADK projects: **Atlas** (chat widget, service `atlas`), **Pulse** (ambient weekly digest, service `pulse`), **RAG Lab** (off-repo teaching agent, reached via `ai-labs/rag-lab/index.html` redirect).

⚠️ **Footgun:** never hand-edit `pyproject.toml [tool.agents-cli]` or `App(name="app")` — the CLI owns them. `[project].name` stays `portfolio-agent` in both (so `uv.lock --frozen` matches); identity is the `agents-cli-manifest.yaml` `name`.

⚠️ **Before every atlas deploy:** `make corpus` (syncs `content/*.json` → `app/corpus/`). After deploying atlas, update `profile.json` agent links + `index.html` CSP; after pulse, repoint the two Cloud Scheduler jobs.

→ **Tools, routes, env vars, deploy commands, eval gate, and the `[[META]]` protocol: `.claude/docs/agents.md`.**

## Standalone scripts (`scripts/`)

`scripts/add-post.mjs` — Node script that fetches Open Graph metadata from a LinkedIn URL and prepends a post entry to `posts.json`. The `/add-post` slash command wraps this. Supports `--print` flag for preview without writing.

## Design system

All design tokens live in `assets/css/base.css :root`. **Never hardcode hex or px values** — always reference a token.

### Typography

| Token | Value | Use for |
|-------|-------|---------|
| `--font-sans` | Inter, -apple-system, system-ui | Body text, UI labels, buttons, headings |
| `--font-mono` | JetBrains Mono, SF Mono, Consolas | Code, technical labels, eyebrows (`// tag`), captions, counters, nav pill |

**Rule**: interactive UI elements (buttons, CTAs, body copy, headings) use `--font-sans`. Technical / terminal-aesthetic labels (`// 01 · act`, formula counters, code snippets) use `--font-mono`. When in doubt, use `--font-sans`.

### Colour tokens

| Token | Value | Use for |
|-------|-------|---------|
| `--bg` | `#000000` | Page background |
| `--bg-card` | `#111111` | Cards, panels |
| `--ink` | `#E5E5E5` | Primary body text |
| `--ink-muted` | `#888888` | Secondary / supporting text |
| `--ink-subtle` | `#555555` | Placeholder, disabled labels |
| `--accent` | `#00FFD1` | Cyan — primary accent, active states, links |
| `--accent-soft` | `rgba(0,255,209,0.12)` | Tinted backgrounds on accent elements |
| `--accent-glow` | `rgba(0,255,209,0.35)` | Box-shadow glows on accent elements |
| `--border` | `rgba(255,255,255,0.08)` | Subtle dividers |
| `--border-strong` | `rgba(255,255,255,0.16)` | Visible borders (cards, inputs) |
| `--danger` | `#FF5C5C` | Error / destructive / broken-wire states only |

Axis colours (`--axis-ai` = cyan, `--axis-cloud` = blue, `--axis-biz` = purple) are for the skills/trajectory visualisations — do not use them for generic UI.

### Type scale

`--text-xs` (0.75rem) · `--text-sm` (0.875rem) · `--text-base` (1rem) · `--text-lg` (1.125rem) · `--text-xl` (1.5rem) · `--text-2xl` (2.25rem) · `--text-3xl` (3.5rem)

### Spacing scale

`--space-1` (0.25rem) through `--space-24` (6rem) — always use these, never raw px/em.

### Voice & copy

All user-facing text (headings, body, captions, button labels, JSON content in `content/`) must read in a **natural, human tone** — the way a knowledgeable person actually talks, not how an LLM writes.

- **No em-dashes (`—`) in copy.** They read as machine-generated. Use a comma, a period, or rephrase the sentence instead. (Hyphens in compound words like `purpose-built` are fine.)
- Prefer short, plain sentences over clause-stacked ones. Break a long thought into two sentences.
- Avoid filler and stock LLM phrasing ("delve", "leverage", "in the realm of", "it's worth noting"). Say it the way you'd say it out loud.
- Read it back: if it sounds like marketing or a model talking, rewrite it.

## Conventions

- **Content in JSON, not HTML.** `content/` is the source of truth for all identity and project data.
- **CSS variables only — never hardcode hex.** All tokens defined in `:root` in `base.css`.
- **One JS module per visualization.** Each lazy-loads on IntersectionObserver entry.
- **No npm, no bundler, no build step.** CDN deps only (`defer`). If a feature needs a build step, find a simpler approach.

## Spec workflow

1. `/create-spec <step> <slug>` → `.claude/specs/<NN>-<slug>.md`
2. `/implement-spec <step>` → plan + implement
3. Verify against spec's "Definition of done"

Specs are append-only. Never rewrite an old spec — write a new one. Zero-padded numbering (`00`, `01`, …).

## Recent specs (31–38)

- **Spec 31** — Ambient agent on Cloud Run (background runs, visitor digest email)
- **Spec 32** — Cloud Scheduler trigger for ambient agent (replaced Lambda)
- **Spec 33** — Self-hosted analytics (`analytics.js` beacon → `page_views` D1 table → dashboard digest)
- **Spec 34** — LinkedIn post metrics in Perspectives (engagement chips: hearts, comments, shares). _No `34-*.md` file on disk; numbering jumps 33 → 35._
- **Spec 37** — Atlas corpus served via ADK Skills (progressive disclosure, replaces bulk corpus injection)
- **Spec 38** — Agentic RAG Lab — standalone FastAPI agent + 3D vector-space viz (`agents/rag-lab/`, served off-repo)
- **Spec 45** — WebMCP: this site registers its own agent-callable tools (`assets/js/webmcp.js`), plus the Agent-Ready Web lab that demos them (`ai-labs/agent-ready/`)

> The "Learn AI" game (`/learn/`, specs 35–36) was removed from the site. Specs 35–36 retained as history.

## Performance budget

- FCP < 1.5s on 4G
- Total JS < 400 KB gzipped
- Lighthouse Performance ≥ 90 desktop

## Visualization constraints

- Hero graph ≤ 60fps; degrade to static gradient on `prefers-reduced-motion`
- 3D knowledge graph has 2D SVG fallback for `< 768px` or low-power mode

## Deploy

GitHub Pages from `main`. `.nojekyll` at repo root prevents Jekyll from dropping `_`-prefixed paths. `.github/workflows/deploy.yml` auto-deploys on push to `main`; excludes `.claude`, `backend`, `agents`, `resend_mcp_server`, `scripts`, `node_modules` from Pages output (rsync-based, no build step).
