# Agents (`agents/`)

Detailed reference for the ADK agents. Linked from `CLAUDE.md`. Read this when building, evaluating, or deploying Atlas, Pulse, or RAG Lab.

Three **independent** Google ADK (agents-cli) projects. Atlas and Pulse each deploy their own Cloud Run service (`min-instances=0`) and keep `App(name="app")` + `agent_directory: app`; the Cloud Run service name comes from the `gcloud run deploy <name>` arg in each Makefile. RAG Lab is a standalone teaching agent served off-repo.

- **`agents/atlas/`** — **Atlas**, the chat-widget agent (service `atlas`). Seven live retrieval tools (`get_profile`, `get_work_history`, `get_projects`, `get_recent_posts`, `get_certifications`, `get_live_agents`, `get_site_stats`) plus two async action tools (`send_resume`, `send_note_to_gaurav`), all registered at agent level. Retrieval tools read content **live** via `app/corpus_live.py` (fetches `gauravlahoti.dev/content/*.json` with a short TTL; `app/corpus/*.json` is the offline fallback), so content edits — profile, work, projects, posts, certs, agents — reflect with NO redeploy. `get_site_stats` fetches the live question count from the resume-gate Worker. (Spec 37's frozen ADK Skills were retired in favor of live tools.) Routes: `POST /api/agent-chat` (SSE), `GET /api/agent-chat/warm`, `GET /healthz`. Frontend: `assets/js/agent-widget.js`, lazy-loaded via `requestIdleCallback`.
- **`agents/pulse/`** — **Pulse**, the ambient weekly-digest agent (service `pulse`). Routes: `POST /api/ambient/run` and `POST /api/ambient/metrics` (gated by `AMBIENT_TRIGGER_TOKEN` via the `x-internal-token` header), plus `GET /healthz`, triggered by two Cloud Scheduler jobs (`portfolio-ambient-agent` Mon/Thu 08:00, `portfolio-ambient-metrics` every 2 days). Fetches visitor stats + LinkedIn post metrics, generates qualitative insights, sends one dashboard email via Resend MCP. Its Makefile has no `corpus`/`eval` targets (atlas-only). Lead-follow-up drafting (`get_pending_leads`/`mark_leads_done`) was removed 2026-08-09 — it depended on the resume-download gate, retired 2026-06-10, and had been a silent no-op tool call twice a week for two months by the time it was caught.
- **`agents/rag-lab/`** — **RAG Lab**, a standalone FastAPI agent for teaching agentic RAG with a 3D vector-space visualization (Spec 38). Deployed off-repo and reached via the `ai-labs/rag-lab/index.html` redirect to `https://agentic-rag.gauravlahoti.dev/`; not part of the Pages build.

Shared helpers (`app_utils/{resume_send,telemetry,typing}.py`) are duplicated into each project (no shared package). The two copies of `resume_send.py` have drifted: pulse's is older and its `send_resume_email` is vestigial (pulse only imports `_env`, `_send_via_mcp`, `warm_mcp_server`, `record_send_failure`). **Keep `_send_via_mcp`, `warm_mcp_server`, and `record_send_failure` identical across both copies** — that is the shared send path. Pulse's `ambient_send.py::_send_to_gaurav` calls `record_send_failure("note", ...)` on failure (no `session_id` — an ambient run has no visitor to attribute it to); this covers the digest's own send failures, which had no durable record at all before 2026-08-09.

### Injecting session context into a tool without exposing it to the model

`send_resume`/`send_note_to_gaurav` (`agents/atlas/app/tools.py`) take a `tool_context:
ToolContext` parameter (from `google.adk.tools.tool_context`) alongside the LLM-visible args,
and read `tool_context.session.id` to get the real session id — never something the model
supplies. Verified live (both via schema introspection and an actual tool call): ADK detects
the `ToolContext` type annotation and excludes it entirely from the generated function-call
schema, regardless of its position among the other parameters — the model never sees it exists,
can't set it, and doesn't need to. This is the pattern to reach for any time a tool needs
caller-side context (session id, request metadata) that must not be model-controlled; don't
invent a side-channel (contextvars, module globals) when this exists.

## Outbound email: retries, warming, and failure signals

The `resend-mcp-server` runs at `min-instances=0`, so a send can land while it is cold. See the readiness contract in `.claude/docs/backend.md` for the server side. On the agent side:

- **`_send_via_mcp` retries transport failures** — 3 attempts, ~1s/4s backoff, bounded by a hard `_MCP_TOTAL_BUDGET_S` (32s) because this runs inside a streaming chat turn with a visitor waiting.
- **It does NOT retry a tool-level rejection** (`result.isError`). That is Resend refusing the message; re-sending could deliver the same email twice.
- `_MCP_TIMEOUT_S` is now actually applied (passed to `streamablehttp_client(timeout=…)` and `ClientSession(read_timeout_seconds=…)`). It used to be declared and never referenced, leaving the MCP call with no timeout at all.
- **`warm_mcp_server()`** wakes the MCP service ahead of need: Atlas from `/api/agent-chat/warm`, Pulse before its ambient cycle.
- **Intermediate retries log at WARNING; only the final give-up logs `EMAIL_SEND_FAILED` at ERROR.** That marker is what the Cloud Monitoring alert policy matches, so a transient that recovers must not emit it.
- Failures are recorded to D1 via `POST /api/send-fail` (`record_send_failure`).

### A failed turn must not be logged as `ok`

`agents/atlas/app/api.py` reads `function_response` parts and collects any action tool that returned `ok=false` into `tool_failures`, then sets the audit-log `status` to `"error"` with the tool's code in `errorMessage`.

This matters more than it looks: the audit row previously recorded only tool *names and args*, never results, so a failed send was stored as `status = "ok"`. Pulse's digest counts errors with `WHERE status != 'ok'`, so it printed "✓ No errors this window" while sends were failing. The status is applied **after** the `[[META]]` block is parsed and emitted, so a failed send still gets its citations, chips, and CTA.

Pulse's `/api/ambient/run` likewise returns **500** when the digest email failed, so the Cloud Scheduler job goes red instead of reporting a successful run that delivered nothing.

## ⚠️ Critical — do not hand-edit

Do NOT hand-edit `pyproject.toml [tool.agents-cli]` or `App(name="app")` — the CLI owns those. `pyproject.toml [project].name` stays `portfolio-agent` in both so `uv.lock --frozen` (and the Docker build) match; project identity is the `agents-cli-manifest.yaml` `name` (`atlas`/`pulse`).

## Commands (from `agents/atlas/` or `agents/pulse/`)

| Task | Command |
|------|---------|
| Local dev (FastAPI) | `make dev` (atlas `:8000`, pulse `:8001`) |
| One-shot smoke test | `agents-cli run "your prompt"` |
| Lint | `make lint` |
| Eval gate (atlas only, before deploy) | `make eval` — agent under test and grading judge both run on Vertex (adk-mas-demo project); `make eval-quick` for a cheap 2-case check |
| Refresh corpus (atlas only) | `make corpus` — **before every atlas deploy**; syncs `../../content/*.json` → `app/corpus/` |
| Deploy | `make deploy` (atlas → `atlas`; pulse → `pulse`). Sets the full env/secret set inline. |

## Post-deploy steps

- After deploying **atlas**: update `content/profile.json` (`links.agentApi`, `links.agentWarm`) and `index.html` CSP `connect-src` with the new Cloud Run URL.
- After deploying **pulse**: repoint the two Cloud Scheduler jobs (`gcloud scheduler jobs update http … --uri=…`).

## Pulse Cloud Scheduler jobs (region `us-central1`)

| Job | Schedule | Route | Effect |
|-----|----------|-------|--------|
| `portfolio-ambient-agent` | Mon/Thu 08:00 IST | `POST /api/ambient/run` | Full LLM cycle: visitor stats + insights + one dashboard email |
| `portfolio-ambient-metrics` | every 2 days 08:00 IST | `POST /api/ambient/metrics` | Scrape LinkedIn engagement → D1 `post_metrics` (no LLM, no email) |

Both jobs send `AMBIENT_TRIGGER_TOKEN` in the `x-internal-token` header. Pulse URL: `https://pulse-593919045544.us-central1.run.app`.

**Run ad-hoc:** force the job (reuses its URI + token, no secret handling) — `gcloud scheduler jobs run <job> --location=us-central1`. The `/refresh-post-metrics` and `/run-ambient-digest` slash commands wrap this. Pulse has `min-instances=0`, so the first call cold-starts (uv build); verify completion via Cloud Run logs filtered on the request URL. Post-metrics are read by the site from the Worker (`profile.links.metricsApi`), **not** the Pages domain.

## Environment variables

See each `.env.example`. Common to both: `GEMINI_API_KEY`, `AGENT_LOG_URL`, `AGENT_LOG_TOKEN`, `RESEND_MCP_URL`, `MCP_CALLER_TOKEN`, `RESEND_FROM_ADDRESS`, `NOTE_FROM_ADDRESS`, `GAURAV_CONTACT_EMAIL`. Atlas-only: `ALLOW_ORIGINS`, `RESUME_PDF_URL`, `CORPUS_LIVE_*`. Pulse-only: `AMBIENT_TRIGGER_TOKEN`. All secrets come from Secret Manager via `--update-secrets`.

Atlas live-corpus (`app/corpus_live.py`): `CORPUS_LIVE_BASE` (default `https://gauravlahoti.dev`), `CORPUS_LIVE_TTL` (default `60`s), `CORPUS_LIVE_OFF` (`"1"` = bundled corpus only, no live fetch).

## `[[META]]` block

Every agent reply ends with `[[META]]…[[/META]]` carrying `citations`, `suggestions`, and optional `cta`. `_stream_agent` strips it from the stream, validates citation URLs against `_ALLOWED_CITE_HOSTS`, and re-emits as SSE events (`citations`, `suggestions`, `cta`) before `done`. Widget renders `[N]` superscripts post-stream, a chip row, and a CTA button. `[[META]]`/`[[/META]]` are stripped from user input in `before_model_callback` as injection defense. CTA copy lives in `profile.agentCopy`; transparency modal copy in `profile.agentExplainer`.
