# content/

Source of truth for all identity, career, and project content on the site.
Plain JSON, edited directly — there is no build step. Markup (`index.html`,
`agent-portfolio/index.html`) stays template-only; copy lives here.

These files are served as static assets, so they're fetchable in production at
`https://gauravlahoti.dev/content/<file>.json`.

## Files

| File | What it holds | Read by | Written by |
|------|---------------|---------|-----------|
| `profile.json` | Identity, links, bio, certifications, experience, models/capabilities, and all agent UI copy (`agentCopy`, `agentExplainer`, `agentIntro`, `agentActions`, `agentPrompts`). | `assets/js/main.js`, `agent-widget.js`; the chat agent corpus (live + bundled). | By hand / `portfolio-content-update` skill. |
| `graph.json` | Career knowledge graph — 29 nodes / 52 edges (companies, projects, skills, domains). | Chat agent corpus **only** — not fetched by the frontend. | `/add-project` skill. |
| `posts.json` | LinkedIn posts shown in the Perspectives section. | `assets/js/posts-list.js`; chat agent corpus; the ambient agent's `post_metrics.py`. | `/add-post` (`scripts/add-post.mjs`). |
| `agents.json` | Cards + architecture diagrams for the `/live-agents/` page, including per-agent `techDecisions` (the recorded architecture rationale). | `assets/js/agents-page.js`; chat agent corpus. | By hand. |
| `build-story.json` | How this site and its agents were built: the spec-driven workflow and the harness behind it. **No counts, dates or cost figures** — those are repo telemetry, they age into false claims, and a unit test enforces their absence. | Chat agent corpus **only** — no page renders it. | By hand. |
| `ai-concepts.json` | AI Lab hub cards (MCP, Agentic RAG, Engineering Loops, Agent-Ready Web). | `ai-labs/index.html`; chat agent corpus. | By hand. |
| `mcp-lab.json`, `engineering-loops.json`, `webmcp-lab.json` | Per-lab page content. | That lab's own JS module only. | By hand. |

## Notes

- **Post-engagement metrics are not a static file.** Reaction/comment/repost
  counts come from the live `GET /api/post-metrics` endpoint (see
  `profile.links.metricsApi`), populated by the ambient agent. The frontend
  fetches that endpoint, not a JSON file here.
- **Agent corpus sync.** Six files make up Atlas's corpus: `profile.json`,
  `graph.json`, `posts.json`, `agents.json`, `build-story.json`, and
  `ai-concepts.json`. They're copied into `agents/atlas/app/corpus/` by
  `make corpus`. At runtime the deployed agent live-fetches them from
  `gauravlahoti.dev/content/` via `corpus_live.py`, falling back to the bundled
  snapshot if the network is unavailable. **Because retrieval is live, a content
  edit reaches Atlas within the TTL with no redeploy** — the snapshot is only
  the offline fallback, so `make corpus` matters before a deploy, not before a
  content change.
- **Adding a file to the corpus** takes four edits: `_FILES` and an accessor in
  `corpus_live.py`, a tool in `tools.py`, registration in `agent.py`, and the
  `corpus` target in `agents/atlas/Makefile`. A tool addition *is* a code change,
  so it does need a redeploy.
- **Changing this path** requires updating every consumer: the frontend
  fetches, `agents/atlas/Makefile`, `corpus_live.py`, `post_metrics.py`, and
  `scripts/add-post.mjs`. A path change also requires an agent redeploy (the
  deployed agent's live-fetch URL is baked in).
