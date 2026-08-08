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
| `POST /api/send-fail` | Records a send that FAILED → `send_failures` (`AGENT_LOG_TOKEN`) |
| `GET/POST /api/leads` | Admin read / lead write (`ADMIN_TOKEN`) |
| `POST /api/pageview` | Analytics beacon sink |
| `GET/POST /api/post-metrics` | LinkedIn post engagement metrics |
| `GET/POST /api/agent-log` | Agent audit log (write: `AGENT_LOG_TOKEN`; read: `ADMIN_TOKEN`) |
| `GET /api/agent-stats` | Public cumulative conversation count |
| `GET /api/gcp-cost` + `POST /api/gcp-cost-send` | BigQuery billing read + Resend cost alert |

`local-server.js` mirrors these and adds `/health`.

### Agent audit log

D1 holds `agent_interactions` — one row per agent turn (question, response, tool calls, tokens, latency, status, optional `google_sub`/`email`). Written via `POST /api/agent-log` (bearer `AGENT_LOG_TOKEN`). Read via `GET /api/agent-log` (same `ADMIN_TOKEN` as `/api/leads`). Rows expire after 90 days via monthly cron. Source: `agents/atlas/app/app_utils/audit_log.py`. Migration `003-agent-meta.sql` adds `citations_count`, `suggestions_count`, `cta`.

### Send rate limits and denial reasons

`/api/resume-send-check` and `/api/note-send-check` enforce two independent limits: a
per-recipient daily dedupe on the hashed address, and `checkGlobalSendCap` — an aggregate
ceiling of `SEND_AGGREGATE_LIMIT` (20) sends per table per hour across *all* recipients.

Both return `{allowed: false, reason}` where `reason` is `"global_cap"` or
`"recipient_recent"`. **The `reason` matters**: the response used to be a bare
`allowed:false`, so the agent couldn't tell the two apart and told visitors who tripped the
global throttle that "the resume already went out to that address today", which was false.
`_check_rate_limit` in the agents returns `(allowed, error, reason)` to keep that honest.

### Failed sends (`send_failures`)

`POST /api/send-fail` writes `{kind, code, email_hash, failed_at}` where `kind` is
`"resume"` or `"note"`. Called by the agents at the moment a send fails.

This is deliberately separate from the `agent_interactions` audit log, which is written
fire-and-forget only *after* a chat turn finishes streaming — a turn that dies mid-stream
leaves no audit row, but the failure still happened. Between the two, plus the alert policy
below, a failed send now leaves three independent traces.

### Migrations (`backend/migrations/`)

9 files: Google sign-in fields (001), agent audit log (002), agent meta columns (003), agent geo fields (004), ambient agent table (004-ambient — duplicate `004` prefix; both run), resume sends (005), page views (006), post metrics (007), note sends (008), send failures (009). Run via Wrangler D1 migrations in prod; local SQLite auto-applies on start.

### Email-failure alerting (`backend/monitoring/`)

`email-send-failure-policy.yaml` is a Cloud Monitoring **log-based** alert policy, wired to
the existing email notification channel. It matches two markers in Cloud Run logs and pages
on every occurrence (volume is ~6/month, so there is no threshold to tune):

| Marker | Emitted by |
|--------|-----------|
| `EMAIL_SEND_FAILED` | `agents/{atlas,pulse}/app/app_utils/resume_send.py`, `agents/atlas/app/app_utils/note_send.py`, `agents/pulse/app/api.py` |
| `MCP_UPSTREAM_UNAVAILABLE` | `resend_mcp_server/server.js` |

**Grep for those two strings before renaming either.** Apply with:

```bash
gcloud alpha monitoring policies create \
  --policy-from-file=backend/monitoring/email-send-failure-policy.yaml \
  --project=gcp-experiments-490306
```

Why it goes through Monitoring rather than Resend: the thing being reported on *is* the
email path. Pulse's digest used to be the only notification channel, and it died of the
same fault it would have reported (2026-07-30, 2026-08-03) while still returning 200 to
Cloud Scheduler. Intermediate send retries log at WARNING on purpose so a transient that
recovers doesn't page anyone; only the final give-up emits `EMAIL_SEND_FAILED`.

### Scripts

- `npm run leads` — recent resume downloads
- `npm run agent-log` — last 50 agent turns

## Analytics beacon

`analytics.js` fires `navigator.sendBeacon` → `profile.links.pageviewApi` (`POST /api/pageview`) on each page load. Worker stores `{path, referrer, visitor_hash}` in `page_views` (bot traffic filtered; raw IP never stored; hash rotates daily). Lazy-loaded via `requestIdleCallback`.

## Resend MCP Server (`resend_mcp_server/`)

Standalone Node.js MCP server on Cloud Run. Exposes a `send-email` tool. API key passed via `Authorization: Bearer` (no server-side secrets). Both Atlas and Pulse connect via `RESEND_MCP_URL` for outbound email.

### ⚠️ Readiness contract — do not bind the port early

`server.js` is a proxy: it listens on `PORT` and forwards to the real `resend-mcp` process on
`:3001`. Cloud Run's default startup probe is a **TCP check on `PORT`**, so the moment the
proxy binds is the moment live traffic arrives.

The MCP child takes anywhere from **~3s to ~25s** to boot (it varies with how much CPU the
instance gets). The original code bound `PORT` after a hardcoded `setTimeout(…, 3000)`, which
made this a coin flip — and on 2026-08-05 it lost twice in a row, so a visitor asking Atlas
to email the resume got "the email couldn't be sent" on both tries while the logs showed
`ECONNREFUSED 127.0.0.1:3001`. Observed boots: 23s (failed) and 2.8s (squeaked through).

So `server.js` now **polls the upstream with an HTTP request and binds `PORT` only once it
answers**. Cloud Run queues inbound requests until the port is listening, so a cold caller
waits a few extra seconds instead of getting a 502. Rules if you touch this file:

- The probe must be an **HTTP request, not a bare TCP connect** — a socket that merely
  accepts proves something is on the port, not that the MCP server is serving.
- Never bind `PORT` on a timer. The readiness poll is the contract.
- If the upstream dies after boot, the process **exits 1** so Cloud Run replaces the
  instance, rather than serving 502s from a proxy that can never recover.
- `GET /readyz` returns 200 only when the upstream answers. It sits ahead of the auth gate
  so it works as an unauthenticated warm target; it discloses a boolean and nothing else.
- **⚠️ Do not name it `/healthz`.** On Cloud Run the *exact* path `/healthz` is intercepted by
  the Google Frontend and 404s (an HTML Google error page) without ever reaching the
  container. Verified against all three services — `atlas` and `pulse` also 404 on their
  documented `/healthz` routes, while every other path (`/health`, `/readyz`, `/healthz2`,
  `/`) routes through normally. This matters beyond cosmetics: a GFE 404 never starts an
  instance, so a warm ping at `/healthz` would wake nothing at all.
- `resend-mcp` is **pinned** in `package.json` (not `"latest"`) and spawned from the local
  install rather than `npx -y`, so a cold boot never depends on the npm registry and a
  rebuild can't silently pull a new major with a different `send-email` schema.

Both agents call `warm_mcp_server()` (in their `resume_send.py`) to wake this service before
they need it — Atlas from `/api/agent-chat/warm`, Pulse before its ambient cycle — so a real
send rarely pays the cold start at all.

| Task | Command (from `resend_mcp_server/`) |
|------|--------------------------------------|
| Local dev | `make dev` → `:3000` |
| Deploy to Cloud Run | `make deploy` (injects secrets from Secret Manager) |
