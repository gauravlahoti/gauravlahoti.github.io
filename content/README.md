# content/

Source of truth for all identity, career, and project content on the site.
Plain JSON, edited directly — there is no build step. Markup (`index.html`,
`agents/index.html`) stays template-only; copy lives here.

These files are served as static assets, so they're fetchable in production at
`https://gauravlahoti.dev/content/<file>.json`.

## Files

| File | What it holds | Read by | Written by |
|------|---------------|---------|-----------|
| `profile.json` | Identity, links, bio, certifications, experience, models/capabilities, and all agent UI copy (`agentCopy`, `agentExplainer`, `agentIntro`, `agentActions`, `agentPrompts`). | `assets/js/main.js`, `agent-widget.js`, `resume-gate.js`; the chat agent corpus (live + bundled). | By hand / `portfolio-content-update` skill. |
| `graph.json` | Career knowledge graph — 29 nodes / 52 edges (companies, projects, skills, domains). | Chat agent corpus **only** — not fetched by the frontend. | `/add-project` skill. |
| `posts.json` | LinkedIn posts shown in the Perspectives section. | `assets/js/posts-list.js`; chat agent corpus; the ambient agent's `post_metrics.py`. | `/add-post` (`scripts/add-post.mjs`). |
| `agents.json` | Cards + architecture diagrams for the `/agents/` page. | `assets/js/agents-page.js` only. | By hand. |

## Notes

- **Post-engagement metrics are not a static file.** Reaction/comment/repost
  counts come from the live `GET /api/post-metrics` endpoint (see
  `profile.links.metricsApi`), populated by the ambient agent. The frontend
  fetches that endpoint, not a JSON file here.
- **Agent corpus sync.** `profile.json`, `graph.json`, and `posts.json` are
  copied into `portfolio-agent/app/corpus/` by `make corpus` (run before every
  agent deploy). At runtime the deployed agent live-fetches these from
  `gauravlahoti.dev/content/` via `corpus_live.py`, falling back to the bundled
  snapshot if the network is unavailable. `agents.json` is **not** part of the
  corpus.
- **Changing this path** requires updating every consumer: the three frontend
  fetches, `portfolio-agent/Makefile`, `corpus_live.py`, `post_metrics.py`, and
  `scripts/add-post.mjs`. A path change also requires an agent redeploy (the
  deployed agent's live-fetch URL is baked in).
