# pulse

Google ADK Python agent that runs on a schedule with no human in the loop
and emails Gaurav one review-ready digest. No chat widget, no visitor-facing
endpoint — its only callers are two Cloud Scheduler jobs. Deployed on Cloud
Run (`min-instances=0`, service `pulse`).

See `DESIGN_SPEC.md` for the full behaviour spec and `.claude/docs/agents.md`
(repo root) for the cross-agent reference (Atlas / Pulse / RAG Lab).

## Project Structure

```
pulse/
├── app/
│   ├── agent.py                     # Points App(name="app") at ambient_agent
│   ├── ambient_agent.py             # The one task: insights -> send_review_email
│   ├── fast_api_app.py              # FastAPI app; mounts api.py's routes
│   ├── api.py                       # POST /api/ambient/{run,metrics}, GET /healthz
│   └── app_utils/
│       ├── ambient_data.py          # get_recent_interactions — reads Atlas's D1 conversations
│       ├── ambient_send.py          # send_review_email — builds the dashboard + sends via Resend MCP
│       ├── post_metrics.py          # LinkedIn engagement scrape -> D1 (no LLM)
│       ├── resume_send.py           # shared MCP send path (warm_mcp_server, record_send_failure) —
│       │                            #   kept identical to atlas's copy; see docs/agents.md
│       └── telemetry.py, typing.py
├── tests/unit/                      # test_ambient.py, test_dummy.py — no eval gate
├── .env.example                     # All required env vars with docs
├── Makefile                         # dev, smoke, lint, deploy — no corpus/eval targets
└── pyproject.toml                   # Dependencies (managed by agents-cli / uv)
```

## Quick Start

```bash
cp .env.example .env           # fill in real values
make dev                       # FastAPI dev server on :8001
agents-cli playground          # interactive web UI
```

## Commands

| Command | Purpose |
|---------|---------|
| `make dev` | FastAPI dev server on `:8001` |
| `agents-cli playground` | Interactive ADK web UI |
| `make smoke` | Drive one ambient cycle locally — **sends a real digest email** |
| `uv run pytest tests/unit` | Unit tests |
| `make lint` | Ruff, auto-fix |
| `make deploy` | Deploy to Cloud Run |

No `corpus` or `eval` target — that machinery is Atlas-only (Pulse has no
retrieval corpus and no eval gate; see `DESIGN_SPEC.md`'s Success criteria).

## Environment Variables

Copy `.env.example` → `.env` and fill in real values. Production values are
mounted via GCP Secret Manager (see the `deploy` target in `Makefile`).

| Var | Purpose |
|-----|---------|
| `GEMINI_API_KEY` | Gemini API key (AI Studio free tier for local dev) |
| `AGENT_LOG_URL` | Worker endpoint `get_recent_interactions` reads Atlas's conversation data through |
| `AGENT_LOG_TOKEN` | Shared secret for that endpoint |
| `ALLOW_ORIGINS` | CORS allowlist (comma-separated) — mostly irrelevant here since nothing calls this from a browser |
| `RESEND_MCP_URL` | Resend MCP server endpoint on Cloud Run |
| `MCP_CALLER_TOKEN` | Bearer token for the Resend MCP server's auth gate |
| `RESEND_FROM_ADDRESS` | Verified sender address for the digest email |
| `NOTE_FROM_ADDRESS` | Verified sender address for send-failure notices |
| `GAURAV_CONTACT_EMAIL` | Inbox that receives the digest |
| `AMBIENT_TRIGGER_TOKEN` | Gates both `POST /api/ambient/run` and `POST /api/ambient/metrics` via the `x-internal-token` header — dedicated secret, distinct from `AGENT_LOG_TOKEN` |

## Deploy Workflow

1. `uv run pytest tests/unit` — must pass
2. Get explicit approval
3. `make deploy`

No eval gate. A bad prompt change won't fail loudly here — it just sends a
worse email — so watch the next one or two scheduled runs land correctly
rather than trusting green tests alone.

## What each scheduled run does

`app/ambient_agent.py`'s one task, triggered by `POST /api/ambient/run`
(Cloud Scheduler, Mon/Thu 08:00):

1. `get_recent_interactions(days=4)` — reads what visitors actually asked
   Atlas.
2. Writes a short qualitative insights block (top themes, standout
   questions, one confidence-scored improvement suggestion).
3. `send_review_email(insights_html)` — called exactly once. Every metric
   number in the dashboard (pageviews, visitors, downloads, top questions,
   geo, errors) comes from this tool's own D1 query, never from the model.

`POST /api/ambient/metrics` (every 2 days) is unrelated and simpler: scrapes
LinkedIn engagement counts into D1, no LLM call, no email.

Lead-follow-up drafting was removed 2026-08-09 — it depended on the
resume-download gate retired 2026-06-10, and had been a silent no-op for two
months by the time it was caught. See `.claude/docs/agents.md`.

## Rules

- **Never hand-edit** `pyproject.toml [tool.agents-cli]` or `App(name="app")`
  — the CLI owns them.
- **Never change the model** unless explicitly asked.
- **Every dashboard number comes from `send_review_email`'s own query, never
  the model.** Don't let the instruction start asking it to restate a metric.
