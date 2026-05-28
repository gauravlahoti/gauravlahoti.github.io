# Portfolio — Gaurav Lahoti

Static, single-page AI & Cloud Architect portfolio. Dark terminal aesthetic. Built spec-driven with [Claude Code](https://claude.com/claude-code). Deployed on GitHub Pages with a Cloudflare Worker backend and a Google ADK agent on Cloud Run.

## Run locally

```bash
python3 -m http.server 5173
open http://localhost:5173
```

No build step. No local dependencies — Three.js, GSAP, and Lenis load from CDN at runtime.

## Architecture

| Layer | Location | Notes |
|-------|----------|-------|
| Frontend | `index.html` + `assets/` | Single-page; no framework |
| Content data | `assets/js/data/*.json` | `profile.json`, `graph.json`, `posts.json` |
| Backend Worker | `backend/` | Resume gate + agent audit log + analytics (Cloudflare Worker + D1) |
| Portfolio agent | `portfolio-agent/` | Google ADK Python agent on Cloud Run |
| Resend MCP server | `resend_mcp_server/` | Node.js MCP proxy for outbound email (Cloud Run) |

## Content

Personal content lives in `assets/js/data/`:

| File | Holds |
|------|-------|
| `profile.json` | Name, title, tagline, bio, social links, API URLs |
| `graph.json` | Career nodes + edges for the 3D trajectory graph |
| `posts.json` | LinkedIn posts for the Perspectives section |

The resume PDF lives at `assets/img/resume.pdf`. Replace in place — no code change needed.

## Backend (`backend/`)

Cloudflare Worker gating the resume PDF behind Google Sign-In, logging agent interactions, and collecting page-view analytics. See [`backend/README.md`](backend/README.md) for full setup, endpoint docs, and secret rotation instructions.

```bash
cd backend && npm install && npm start   # local dev on :8787
```

## Portfolio Agent (`portfolio-agent/`)

Google ADK Python agent powering the "Ask my agent" chat widget. Answers questions about Gaurav using five retrieval tools over a frozen JSON corpus.

```bash
cd portfolio-agent
make dev              # FastAPI dev server on :8000
agents-cli playground # interactive web UI
uv run pytest tests/unit tests/integration
```

See [`portfolio-agent/CLAUDE.md`](portfolio-agent/CLAUDE.md) for corpus refresh, eval gate, and deploy instructions.

**Required env vars** (copy `.env.example` → `.env`):

| Var | Purpose |
|-----|---------|
| `GEMINI_API_KEY` | Gemini API key for local dev |
| `AGENT_LOG_URL` / `AGENT_LOG_TOKEN` | Audit log endpoint on the Worker |
| `RESEND_MCP_URL` | Resend MCP server endpoint |
| `MCP_CALLER_TOKEN` | Bearer token for the Resend MCP server auth gate |
| `RESEND_FROM_ADDRESS` | Verified sender domain |
| `RESUME_PDF_URL` | Public PDF URL for email attachments |
| `GAURAV_CONTACT_EMAIL` | Inbox for visitor notes |
| `AMBIENT_TRIGGER_TOKEN` | Gates `POST /api/ambient/run` |

## Resend MCP Server (`resend_mcp_server/`)

Standalone Node.js MCP proxy deployed on Cloud Run. Exposes the Resend `send-email` tool. The Resend API key lives only on the server (Secret Manager); callers authenticate with `MCP_CALLER_TOKEN`. See [`resend_mcp_server/README.md`](resend_mcp_server/README.md).

```bash
cd resend_mcp_server
make deploy   # deploys to Cloud Run with secrets wired
```

## Spec workflow

Every feature is built through a spec under `.claude/specs/`. Recent specs:

| Spec | Title |
|------|-------|
| 31 | Ambient agent on Cloud Run |
| 32 | Cloud Scheduler trigger |
| 33 | Self-hosted analytics |
| 34 | LinkedIn post engagement metrics |

```bash
/create-spec <step> <slug>   # scaffold a new spec + branch
/implement-spec <step>       # plan + implement a spec
```

## Deploy

Push to `main` → GitHub Pages deploys automatically via `.github/workflows/deploy.yml`. Agent source (`portfolio-agent/`, `resend_mcp_server/`) and backend (`backend/`) are excluded from the Pages output.

## License

All rights reserved.
