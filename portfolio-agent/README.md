# portfolio-agent

Google ADK Python agent powering the "Ask my agent" chat widget on [gauravlahoti.dev](https://gauravlahoti.dev). Answers questions about Gaurav using five retrieval tools over a frozen JSON corpus. Deployed on Cloud Run (`min-instances=0`).

## Project Structure

```
portfolio-agent/
├── app/
│   ├── agent.py               # Root agent definition
│   ├── fast_api_app.py        # FastAPI + SSE streaming endpoint
│   ├── ambient_agent.py       # Background ambient agent (visitor digest)
│   ├── guardrails.py          # [[META]] injection defense + citation validation
│   └── app_utils/
│       ├── audit_log.py       # POST /api/agent-log after each turn
│       ├── resume_send.py     # send-resume-by-email via Resend MCP
│       ├── note_send.py       # send-note-to-gaurav via Resend MCP
│       ├── ambient_send.py    # weekly digest email via Resend MCP
│       └── ambient_data.py    # visitor stats from Worker /api/ambient/stats
├── tests/
│   ├── unit/                  # Pure unit tests (no network)
│   └── integration/           # Live agent smoke tests
│       └── evalsets/          # Eval set for agents-cli eval gate
├── .env.example               # All required env vars with docs
├── Makefile                   # dev, corpus, audit shortcuts
└── pyproject.toml             # Dependencies (managed by agents-cli / uv)
```

## Quick Start

```bash
cp .env.example .env           # fill in real values
make dev                       # FastAPI dev server on :8000
agents-cli playground          # interactive web UI
```

## Commands

| Command | Purpose |
|---------|---------|
| `make dev` | FastAPI dev server on `:8000` |
| `agents-cli playground` | Interactive ADK web UI |
| `agents-cli run "prompt"` | One-shot smoke test |
| `agents-cli eval run --evalset tests/eval/evalsets/portfolio.evalset.json` | Eval gate (required before deploy) |
| `uv run pytest tests/unit tests/integration` | Unit + integration tests |
| `make corpus` | Sync `content/*.json` → `app/corpus/` (run before every deploy) |
| `make audit` | Smoke-test the audit log endpoint |
| `agents-cli deploy ... -- --allow-unauthenticated --cpu-boost --min-instances=0` | Deploy to Cloud Run |

## Environment Variables

Copy `.env.example` → `.env` and fill in real values. Production values are mounted via GCP Secret Manager.

| Var | Purpose |
|-----|---------|
| `GEMINI_API_KEY` | Gemini API key (AI Studio free tier for local dev) |
| `AGENT_LOG_URL` | Worker audit log endpoint (`/api/agent-log`) |
| `AGENT_LOG_TOKEN` | Shared secret for the audit log endpoint |
| `ALLOW_ORIGINS` | CORS allowlist (comma-separated) |
| `RESEND_MCP_URL` | Resend MCP server endpoint on Cloud Run |
| `MCP_CALLER_TOKEN` | Bearer token for the Resend MCP server auth gate |
| `RESEND_FROM_ADDRESS` | Verified sender address for resume emails |
| `NOTE_FROM_ADDRESS` | Verified sender address for visitor notes |
| `RESUME_PDF_URL` | Public resume PDF URL for email attachments |
| `GAURAV_CONTACT_EMAIL` | Inbox that receives visitor notes |
| `AMBIENT_TRIGGER_TOKEN` | Gates `POST /api/ambient/run` (ambient agent trigger) |

## Deploy Workflow

1. `make corpus` — sync corpus from latest `content/*.json`
2. `agents-cli eval run` — eval gate must pass (iterate until it does)
3. `uv run pytest tests/unit tests/integration` — tests must pass
4. Deploy:
   ```bash
   agents-cli deploy \
     --service-name portfolio-agent \
     --region us-central1 \
     -- --allow-unauthenticated --cpu-boost --min-instances=0
   ```
5. Update `profile.json` (`links.agentApi`, `links.agentWarm`) and `index.html` CSP `connect-src` with the new Cloud Run URL.

## Ambient Agent

`app/ambient_agent.py` runs on a Cloud Scheduler trigger (twice weekly). It:

1. Fetches visitor stats from `GET /api/ambient/stats?days=4`
2. Fetches LinkedIn post engagement metrics
3. Generates qualitative insights
4. Drafts follow-up notes for pending leads
5. Sends a single digest email to Gaurav via the Resend MCP server

Trigger endpoint: `POST /api/ambient/run` (requires `X-Internal-Token: <AMBIENT_TRIGGER_TOKEN>`).

## Rules

- **Never hand-edit** `pyproject.toml [tool.agents-cli]` or `App(name="app")` — the CLI owns them.
- **Eval must pass** before every deploy — no exceptions.
- **Run `make corpus`** before every deploy — stale corpus = stale answers.
- **Never change the model** unless explicitly asked.
