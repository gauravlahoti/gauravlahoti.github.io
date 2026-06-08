# Agents (`agents/`)

Detailed reference for the ADK agents. Linked from `CLAUDE.md`. Read this when building, evaluating, or deploying Atlas, Pulse, or RAG Lab.

Three **independent** Google ADK (agents-cli) projects. Atlas and Pulse each deploy their own Cloud Run service (`min-instances=0`) and keep `App(name="app")` + `agent_directory: app`; the Cloud Run service name comes from the `gcloud run deploy <name>` arg in each Makefile. RAG Lab is a standalone teaching agent served off-repo.

- **`agents/atlas/`** — **Atlas**, the chat-widget agent (service `atlas`). Five retrieval tools (`get_profile`, `get_work_history`, `get_projects`, `get_recent_posts`, `get_certifications`) plus two async action tools (`send_resume`, `send_note_to_gaurav`), served via ADK Skills (`app/skills/<name>/SKILL.md` + `references/*.json`, rebuilt from the corpus at deploy — see Spec 37) over a frozen JSON corpus bundled at deploy. Routes: `POST /api/agent-chat` (SSE), `GET /api/agent-chat/warm`, `GET /healthz`. Frontend: `assets/js/agent-widget.js`, lazy-loaded via `requestIdleCallback`.
- **`agents/pulse/`** — **Pulse**, the ambient weekly-digest agent (service `pulse`). Routes: `POST /api/ambient/run` and `POST /api/ambient/metrics` (gated by `AMBIENT_TRIGGER_TOKEN` via the `x-internal-token` header), plus `GET /healthz`, triggered by two Cloud Scheduler jobs (`portfolio-ambient-agent` Mon/Thu 08:00, `portfolio-ambient-metrics` every 2 days). Fetches visitor stats + LinkedIn post metrics, generates insights, drafts leads, sends one dashboard email via Resend MCP. Its Makefile has no `corpus`/`eval` targets (atlas-only).
- **`agents/rag-lab/`** — **RAG Lab**, a standalone FastAPI agent for teaching agentic RAG with a 3D vector-space visualization (Spec 38). Deployed off-repo and reached via the `rag-lab/index.html` redirect to `https://agentic-rag.gauravlahoti.dev/`; not part of the Pages build.

Shared helpers (`app_utils/{resume_send,telemetry,typing}.py`) are duplicated into each project (no shared package).

## ⚠️ Critical — do not hand-edit

Do NOT hand-edit `pyproject.toml [tool.agents-cli]` or `App(name="app")` — the CLI owns those. `pyproject.toml [project].name` stays `portfolio-agent` in both so `uv.lock --frozen` (and the Docker build) match; project identity is the `agents-cli-manifest.yaml` `name` (`atlas`/`pulse`).

## Commands (from `agents/atlas/` or `agents/pulse/`)

| Task | Command |
|------|---------|
| Local dev (FastAPI) | `make dev` (atlas `:8000`, pulse `:8001`) |
| One-shot smoke test | `agents-cli run "your prompt"` |
| Lint | `make lint` |
| Eval gate (atlas only, before deploy) | `make eval` — free-tier key only, never Vertex (no model charges); `make eval-quick` for a cheap 2-case check |
| Refresh corpus (atlas only) | `make corpus` — **before every atlas deploy**; syncs `../../content/*.json` → `app/corpus/` |
| Deploy | `make deploy` (atlas → `atlas`; pulse → `pulse`). Sets the full env/secret set inline. |

## Post-deploy steps

- After deploying **atlas**: update `content/profile.json` (`links.agentApi`, `links.agentWarm`) and `index.html` CSP `connect-src` with the new Cloud Run URL.
- After deploying **pulse**: repoint the two Cloud Scheduler jobs (`gcloud scheduler jobs update http … --uri=…`).

## Pulse Cloud Scheduler jobs (region `us-central1`)

| Job | Schedule | Route | Effect |
|-----|----------|-------|--------|
| `portfolio-ambient-agent` | Mon/Thu 08:00 IST | `POST /api/ambient/run` | Full LLM cycle: visitor stats + leads + one dashboard email |
| `portfolio-ambient-metrics` | every 2 days 08:00 IST | `POST /api/ambient/metrics` | Scrape LinkedIn engagement → D1 `post_metrics` (no LLM, no email) |

Both jobs send `AMBIENT_TRIGGER_TOKEN` in the `x-internal-token` header. Pulse URL: `https://pulse-593919045544.us-central1.run.app`.

**Run ad-hoc:** force the job (reuses its URI + token, no secret handling) — `gcloud scheduler jobs run <job> --location=us-central1`. The `/refresh-post-metrics` and `/run-ambient-digest` slash commands wrap this. Pulse has `min-instances=0`, so the first call cold-starts (uv build); verify completion via Cloud Run logs filtered on the request URL. Post-metrics are read by the site from the Worker (`profile.links.metricsApi`), **not** the Pages domain.

## Environment variables

See each `.env.example`. Common to both: `GEMINI_API_KEY`, `AGENT_LOG_URL`, `AGENT_LOG_TOKEN`, `RESEND_MCP_URL`, `MCP_CALLER_TOKEN`, `RESEND_FROM_ADDRESS`, `NOTE_FROM_ADDRESS`, `GAURAV_CONTACT_EMAIL`. Atlas-only: `ALLOW_ORIGINS`, `RESUME_PDF_URL`, `CORPUS_LIVE_*`. Pulse-only: `AMBIENT_TRIGGER_TOKEN`. All secrets come from Secret Manager via `--update-secrets`.

Atlas live-corpus (`app/corpus_live.py`): `CORPUS_LIVE_BASE` (default `https://gauravlahoti.dev`), `CORPUS_LIVE_TTL` (default `60`s), `CORPUS_LIVE_OFF` (`"1"` = bundled corpus only, no live fetch).

## `[[META]]` block

Every agent reply ends with `[[META]]…[[/META]]` carrying `citations`, `suggestions`, and optional `cta`. `_stream_agent` strips it from the stream, validates citation URLs against `_ALLOWED_CITE_HOSTS`, and re-emits as SSE events (`citations`, `suggestions`, `cta`) before `done`. Widget renders `[N]` superscripts post-stream, a chip row, and a CTA button. `[[META]]`/`[[/META]]` are stripped from user input in `before_model_callback` as injection defense. CTA copy lives in `profile.agentCopy`; transparency modal copy in `profile.agentExplainer`.
