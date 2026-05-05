# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Static, single-page Cloud & AI architect portfolio for Gaurav Lahoti. Dark "AI terminal" aesthetic — landing hero is an "Agent Mesh" (3D node-edge graph with A2A-style edge pulses, chrome status panel, LLM-style token-streaming tagline). Built spec-driven — every feature ships through a spec in `.claude/specs/`. No framework, no bundler, no Node toolchain. Open `index.html` and it runs.

## Running locally

```bash
python3 -m http.server 5173
# then open http://localhost:5173
```

## Slash commands

- `/run-site` — boot the static server
- `/create-spec <step> <slug>` — scaffold a new spec + feature branch
- `/implement-spec <step>` — read spec, plan, implement
- `/add-project` — add a project node to `graph.json`
- `/add-post <linkedin-url>` — fetch a LinkedIn post's title via OG meta, show it for approval, then prepend to `posts.json`
- `/ship` — commit feature-branch work, open PR, squash-merge to main
- `/publish` — commit, push, trigger Pages deploy

## Architecture

| Layer            | Location                                                | Notes                              |
|------------------|---------------------------------------------------------|------------------------------------|
| HTML             | `index.html`                                            | Single page; semantic anchors      |
| CSS              | `assets/css/{base,layout,components}.css`               | base = variables + typography      |
| JS modules       | `assets/js/{main,trajectory,hero-graph,cursor,resume-gate}.js` | One module per surface       |
| Content data     | `assets/js/data/*.json`                                 | See data files below               |
| Static media     | `assets/img/`                                           | Resume PDF, OG image, favicon      |
| Backend (gate)   | `backend/`                                              | Resume-download auth (see below)   |

Data files: `profile.json` (identity, bio, socials, full work history, certifications), `graph.json` (project metadata).

## Resume-gate backend

`backend/` is a separate sub-project that gates the resume PDF behind Google Sign-In. Two interchangeable runtimes share `schema.sql`:

- **Local Node** (`backend/local-server.js`) — `cd backend && npm install && npm start` → `http://localhost:8787`, writes `leads.db` (SQLite).
- **Cloudflare Worker** (`backend/src/index.js`, `wrangler.toml`) — production target, writes to D1.

The static portfolio stays plain HTML/CSS/JS and ships to GitHub Pages independently. `assets/js/resume-gate.js` calls the backend; the PDF download fires only after the JWT verifies and the lead row is written. Specs 11 and 12 cover the gate and Google auth.

**Agent audit log (Spec #23):** the same D1 database holds a second table, `agent_interactions`, with one row per agent turn (question, response, tool calls, tokens, latency, status, optional `google_sub`/`email` when the visitor has signed in). The Cloud Run agent writes to it via `POST /api/agent-log` (gated by `AGENT_LOG_TOKEN`, a shared secret set via `wrangler secret put` on the Worker and in Secret Manager on Cloud Run). Admin read: `GET /api/agent-log` with the same `Authorization: Bearer $ADMIN_TOKEN` as `/api/leads`. Rows auto-delete after 90 days via the existing monthly cron. Source: `portfolio-agent/app/app_utils/audit_log.py`.

## Agent chat widget (`portfolio-agent/`)

Spec 21 adds a floating "Ask my agent" widget powered by a Google ADK Python agent deployed on Cloud Run (free tier, `min-instances=0`). The agent answers questions about Gaurav using five retrieval tools (`get_profile`, `get_work_history`, `get_projects`, `get_recent_posts`, `get_certifications`) over a frozen JSON snapshot bundled into the container. Frontend module: `assets/js/agent-widget.js`, lazy-loaded via `requestIdleCallback` and wired in `assets/js/main.js`. Sub-project: `portfolio-agent/` (scaffolded by `agents-cli scaffold create`; do NOT hand-edit `pyproject.toml [tool.agents-cli]` or `App(name="app")` — the CLI reads them).

- **Local dev** (from inside `portfolio-agent/`): `make dev` (FastAPI on `:8000`) or `agents-cli playground` (ADK web UI). For a one-shot smoke: `agents-cli run "your prompt"`.
- **Eval gate** (must pass before deploy): `agents-cli eval run --evalset tests/eval/evalsets/portfolio.evalset.json`.
- **Deploy**: production lives in **`us-central1`** as service `portfolio-agent` (URL `https://portfolio-agent-lw4bt7nrba-uc.a.run.app`). `agents-cli` defaults to `us-east1`, so always pin the region — the `make deploy` target in `portfolio-agent/Makefile` does this. `agents-cli` also defaults to `--no-allow-unauthenticated`; if you skip the Makefile, pass `-- --allow-unauthenticated --cpu-boost --min-instances=0` (else the public widget gets 403). After URL changes, update `profile.json` `links.agentApi` / `links.agentWarm` and `index.html` CSP `connect-src`.
- **Refresh corpus**: `make corpus` syncs `assets/js/data/*.json` → `portfolio-agent/app/corpus/`. The agent ships a frozen snapshot per deploy; redeploy to update.

**Conversation upgrades (Spec #24):** every reply ends with a server-stripped `[[META]]…[[/META]]` JSON block carrying `citations`, `suggestions` (follow-up chips), and an optional `cta`. `_stream_agent` detects the sentinel, strips it from the delta stream, parses the block (last-wins via `rfind`), validates citation URLs against `_ALLOWED_CITE_HOSTS`, and re-emits as `citations` / `suggestions` / `cta` SSE events before `done`. The widget renders inline `[N]` superscripts (after `done`, not during streaming), a chip row, and a Topmate / LinkedIn CTA button when applicable. Audit log gains `citations_count`, `suggestions_count`, and `cta` columns (Spec #23 schema extended via `backend/migrations/003-agent-meta.sql`). `[[META]]` / `[[/META]]` are stripped from user input in `before_model_callback` as a first-line injection defense. Copy for CTA buttons and scroll nudge lives in `profile.agentCopy`; transparency modal copy lives in `profile.agentExplainer`.

## Conventions

- **Content lives in JSON, not HTML.** All identity, career, and project data flows out of `assets/js/data/`. Markup stays template-only so updating the bio never touches code.
- **CSS variables only — never hardcode hex.** All colours, spacing, type scale defined in `:root` in `base.css`.
- **One JS module per visualization.** Each module lazy-loads when its section enters the viewport (IntersectionObserver) so the hero isn't blocked by Three.js.
- **No npm, no bundler.** External deps load from CDN with `defer`. The repo is `git clone` → `python3 -m http.server` → working site.
- **No build step ever.** If a feature needs one, push back and find a simpler version.

## Spec workflow

Every feature follows the same loop:

1. `/create-spec <step> <slug>` writes `.claude/specs/<NN>-<slug>.md`
2. `/implement-spec <step>` reads the spec, plans, then implements
3. Manual verification per spec's "Definition of done"

Spec files are append-only history. Don't rewrite an old spec to match new code — write a new spec. Specs are zero-padded (`00-`, `01-`, …); `00` documents initial scaffolding, new features pick the next unused number.

## Visualization rules

- **Hero shader** runs ≤ 60fps on a 2020 MacBook Air. Degrade to a static gradient on `prefers-reduced-motion`.
- **3D knowledge graph** has a 2D SVG fallback that triggers on small viewports (< 768px) or low-power mode.

## Performance budget

- First Contentful Paint < 1.5s on 4G
- Total JS < 400 KB gzipped (Three.js is the largest dep)
- Lighthouse Performance ≥ 90 on desktop

## Deploy

Deploys to GitHub Pages from `main`. `.nojekyll` at the repo root disables Jekyll processing so paths starting with `_` aren't dropped. Spec 09 covers Pages + custom domain setup.
