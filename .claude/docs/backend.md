# Backend, analytics & Resend MCP

Detailed reference for `backend/`, the analytics beacon, and `resend_mcp_server/`. Linked from `CLAUDE.md`. Read this when working on the resume gate, the agent audit log, page-view analytics, GCP cost alerts, or outbound email.

## Resume-gate backend (`backend/`)

Gates the resume PDF behind Google Sign-In. Two runtimes share `schema.sql`:

- **Local** (`backend/local-server.js`): `cd backend && npm install && npm start` → `:8787`, SQLite (`leads.db`)
- **Production** (`backend/src/index.js` + `wrangler.toml`): Cloudflare Worker writing to D1

`assets/js/resume-gate.js` calls the backend; the PDF fires only after JWT verification and lead row write.

### Endpoints (`backend/src/index.js`)

| Endpoint | Purpose |
|----------|---------|
| `POST /api/resume-download` | Verify Google JWT, write lead row, release PDF |
| `POST /api/resume-send-check` / `POST /api/resume-send-record` | Resume-by-email send fallback (Spec 28) |
| `GET/POST /api/leads` | Admin read / lead write (`ADMIN_TOKEN`) |
| `POST /api/pageview` | Analytics beacon sink |
| `GET/POST /api/post-metrics` | LinkedIn post engagement metrics |
| `GET/POST /api/agent-log` | Agent audit log (write: `AGENT_LOG_TOKEN`; read: `ADMIN_TOKEN`) |
| `GET /api/agent-stats` | Public cumulative conversation count |
| `GET /api/gcp-cost` + `POST /api/gcp-cost-send` | BigQuery billing read + Resend cost alert |

`local-server.js` mirrors these and adds `/health`.

### Agent audit log

D1 holds `agent_interactions` — one row per agent turn (question, response, tool calls, tokens, latency, status, optional `google_sub`/`email`). Written via `POST /api/agent-log` (bearer `AGENT_LOG_TOKEN`). Read via `GET /api/agent-log` (same `ADMIN_TOKEN` as `/api/leads`). Rows expire after 90 days via monthly cron. Source: `agents/atlas/app/app_utils/audit_log.py`. Migration `003-agent-meta.sql` adds `citations_count`, `suggestions_count`, `cta`.

### Migrations (`backend/migrations/`)

8 files: Google sign-in fields (001), agent audit log (002), agent meta columns (003), agent geo fields (004), ambient agent table (004-ambient — duplicate `004` prefix; both run), resume sends (005), page views (006), post metrics (007). Run via Wrangler D1 migrations in prod; local SQLite auto-applies on start.

### Scripts

- `npm run leads` — recent resume downloads
- `npm run agent-log` — last 50 agent turns

## Analytics beacon

`analytics.js` fires `navigator.sendBeacon` → `profile.links.pageviewApi` (`POST /api/pageview`) on each page load. Worker stores `{path, referrer, visitor_hash}` in `page_views` (bot traffic filtered; raw IP never stored; hash rotates daily). Lazy-loaded via `requestIdleCallback`.

## Resend MCP Server (`resend_mcp_server/`)

Standalone Node.js MCP server on Cloud Run. Exposes a `send-email` tool. API key passed via `Authorization: Bearer` (no server-side secrets). Both Atlas and Pulse connect via `RESEND_MCP_URL` for outbound email.

| Task | Command (from `resend_mcp_server/`) |
|------|--------------------------------------|
| Local dev | `make dev` → `:3000` |
| Deploy to Cloud Run | `make deploy` (injects secrets from Secret Manager) |
