# CLAUDE.md

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
| `/ship` | Commit branch → PR → squash-merge to main |
| `/publish` | Commit + push → trigger Pages deploy |

## Architecture

| Layer | Location | Notes |
|-------|----------|-------|
| HTML | `index.html` | Single page; semantic anchors |
| CSS | `assets/css/{base,layout,components}.css` | `base.css` holds all variables |
| JS modules | `assets/js/{main,trajectory,hero-graph,cursor,resume-gate,agent-widget}.js` | One module per surface |
| Content data | `assets/js/data/*.json` | `profile.json`, `graph.json` |
| Static media | `assets/img/` | Resume PDF, OG image, favicon |
| Backend | `backend/` | Resume-gate + agent audit log |

## Resume-gate backend (`backend/`)

Gates the resume PDF behind Google Sign-In. Two runtimes share `schema.sql`:

- **Local** (`backend/local-server.js`): `cd backend && npm install && npm start` → `:8787`, SQLite (`leads.db`)
- **Production** (`backend/src/index.js` + `wrangler.toml`): Cloudflare Worker writing to D1

`assets/js/resume-gate.js` calls the backend; the PDF fires only after JWT verification and lead row write.

**Agent audit log:** D1 also holds `agent_interactions` — one row per agent turn (question, response, tool calls, tokens, latency, status, optional `google_sub`/`email`). Written via `POST /api/agent-log` (bearer `AGENT_LOG_TOKEN`). Read via `GET /api/agent-log` (same `ADMIN_TOKEN` as `/api/leads`). Rows expire after 90 days via monthly cron. Source: `portfolio-agent/app/app_utils/audit_log.py`. Schema migration: `backend/migrations/003-agent-meta.sql` adds `citations_count`, `suggestions_count`, `cta` columns.

## Agent chat widget (`portfolio-agent/`)

Floating "Ask my agent" widget — Google ADK Python agent on Cloud Run (`min-instances=0`). Five retrieval tools: `get_profile`, `get_work_history`, `get_projects`, `get_recent_posts`, `get_certifications` over a frozen JSON corpus bundled at deploy time.

Frontend: `assets/js/agent-widget.js`, lazy-loaded via `requestIdleCallback`.

**Critical:** do NOT hand-edit `pyproject.toml [tool.agents-cli]` or `App(name="app")` — the CLI owns those.

| Task | Command (from `portfolio-agent/`) |
|------|----------------------------------|
| Local dev (FastAPI) | `make dev` → `:8000` |
| Interactive UI | `agents-cli playground` |
| One-shot smoke test | `agents-cli run "your prompt"` |
| Eval gate (required before deploy) | `agents-cli eval run --evalset tests/eval/evalsets/portfolio.evalset.json` |
| Refresh corpus | `make corpus` — syncs `assets/js/data/*.json` → `app/corpus/` |
| Deploy | `agents-cli deploy ... -- --allow-unauthenticated --cpu-boost --min-instances=0` |

After deploy: update `profile.json` (`links.agentApi`, `links.agentWarm`) and `index.html` CSP `connect-src` with the Cloud Run URL.

**`[[META]]` block:** every agent reply ends with `[[META]]…[[/META]]` carrying `citations`, `suggestions`, and optional `cta`. `_stream_agent` strips it from the stream, validates citation URLs against `_ALLOWED_CITE_HOSTS`, and re-emits as SSE events (`citations`, `suggestions`, `cta`) before `done`. Widget renders `[N]` superscripts post-stream, a chip row, and a CTA button. `[[META]]`/`[[/META]]` are stripped from user input in `before_model_callback` as injection defense. CTA copy lives in `profile.agentCopy`; transparency modal copy in `profile.agentExplainer`.

## Conventions

- **Content in JSON, not HTML.** `assets/js/data/` is the source of truth for all identity and project data.
- **CSS variables only — never hardcode hex.** All tokens defined in `:root` in `base.css`.
- **One JS module per visualization.** Each lazy-loads on IntersectionObserver entry.
- **No npm, no bundler, no build step.** CDN deps only (`defer`). If a feature needs a build step, find a simpler approach.

## Spec workflow

1. `/create-spec <step> <slug>` → `.claude/specs/<NN>-<slug>.md`
2. `/implement-spec <step>` → plan + implement
3. Verify against spec's "Definition of done"

Specs are append-only. Never rewrite an old spec — write a new one. Zero-padded numbering (`00`, `01`, …).

## Performance budget

- FCP < 1.5s on 4G
- Total JS < 400 KB gzipped
- Lighthouse Performance ≥ 90 desktop

## Visualization constraints

- Hero graph ≤ 60fps; degrade to static gradient on `prefers-reduced-motion`
- 3D knowledge graph has 2D SVG fallback for `< 768px` or low-power mode

## Deploy

GitHub Pages from `main`. `.nojekyll` at repo root prevents Jekyll from dropping `_`-prefixed paths.
