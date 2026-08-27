# Backend, analytics & Resend MCP

Detailed reference for `backend/`, the analytics beacon, and `resend_mcp_server/`. Linked from `CLAUDE.md`. Read this when working on the resume gate, the agent audit log, page-view analytics, GCP cost alerts, or outbound email.

## Resume-gate backend (`backend/`)

⚠️ **The resume-download gate was retired 2026-06-10** — the site links straight to
`/resume.pdf` now (`assets/js/resume-gate.js` is deleted; there is no `POST
/api/resume-download` anymore). This folder kept its name because it grew into the site's
general-purpose backend: the agent audit log, resume/note send-and-rate-limit endpoints,
analytics beacon, LinkedIn post metrics, GCP cost alerts, and the `daily_stats` rollup all
live here too. `resume_downloads` stays read-only for its 2026-05→06 historical leads —
nothing writes to it anymore, and it's deliberately exempt from the retention cron (see
below). Two runtimes share `schema.sql`:

- **Local** (`backend/local-server.js`): `cd backend && npm install && npm start` → `:8787`, SQLite (`leads.db`)
- **Production** (`backend/src/index.js` + `wrangler.toml`): Cloudflare Worker writing to D1

### Endpoints (`backend/src/index.js`)

| Endpoint | Purpose |
|----------|---------|
| `POST /api/resume-send-check` / `POST /api/resume-send-record` | Resume-by-email send fallback (Spec 28) |
| `POST /api/note-send-check` / `POST /api/note-send-record` | Visitor-note send fallback |
| `POST /api/send-fail` | Records a send that FAILED → `send_failures` (`AGENT_LOG_TOKEN`) |
| `GET/POST /api/leads` | Admin read of historical `resume_downloads` (`ADMIN_TOKEN`); read-only, nothing writes here anymore |
| `POST /api/pageview` | Analytics beacon sink — accepts an optional `sessionId` (see Analytics beacon below) |
| `GET/POST /api/post-metrics` | LinkedIn post engagement metrics |
| `GET/POST /api/agent-log` | Agent audit log (write: `AGENT_LOG_TOKEN`; read: `ADMIN_TOKEN`) |
| `GET /api/agent-stats` | Public cumulative conversation count (rollup-aware, see Retention below) |
| `GET /api/ambient/interactions` / `GET /api/ambient/stats` | Pulse's digest data reads (`AGENT_LOG_TOKEN`) |
| `GET /api/gcp-cost` + `POST /api/gcp-cost-send` | BigQuery billing read + Resend cost alert |

`local-server.js` mirrors these and adds `/health`.

### Agent audit log

D1 holds `agent_interactions` — one row per agent turn (question, response, tool calls, tokens, latency, status, `model`, `model_fallback_depth`, optional `google_sub`/`email`). Written via `POST /api/agent-log` (bearer `AGENT_LOG_TOKEN`). Read via `GET /api/agent-log` (same `ADMIN_TOKEN` as `/api/leads`). Source: `agents/atlas/app/app_utils/audit_log.py`. Migration `003-agent-meta.sql` adds `citations_count`, `suggestions_count`, `cta`; migration `011-analytics-columns.sql` adds `model`, `model_fallback_depth`.

`model` is whichever model actually answered — Atlas cascades `gemini-3.7-flash` → `3.6-flash` on 429/503 (`agents/atlas/app/fallback_model.py`), so this is not always the primary. Captured in `agents/atlas/app/api.py` from `event.model_version` (ADK's `Event` subclasses `LlmResponse`, which carries it), paired with whichever event's `usage_metadata` is being recorded — a turn with a tool call makes two internal LLM calls, and last-wins matching keeps the model and its token counts from staying in sync. `model_fallback_depth` is the index into `[primary, *fallback_models]` (0 = primary).

**Retention has changed since this was first written — see the table below, not "90 days."**

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

`POST /api/send-fail` writes `{kind, code, email_hash, failed_at, session_id, attempts,
latency_ms}` where `kind` is `"resume"` or `"note"`. Called by the agents at the moment a send
fails — `session_id` links the failure to the conversation (Atlas's action tools get it via
ADK's `ToolContext.session.id`, injected server-side and never exposed to the model's schema);
`attempts` distinguishes "the retry logic rescued this" from "it just delayed the failure";
`latency_ms` is the wall-clock time of those attempts. `kind="note"` also covers Pulse's own
digest-send failures (`ambient_send.py::_send_to_gaurav`), which had no durable record at all
before this — `session_id` is naturally absent there, since an ambient run has no visitor.

This is deliberately separate from the `agent_interactions` audit log, which is written
fire-and-forget only *after* a chat turn finishes streaming — a turn that dies mid-stream
leaves no audit row, but the failure still happened. Between the two, plus the alert policy
below and the digest surfacing a per-window count (see `chat_models`/`send_failures` in the
ambient stats response), a failed send now leaves four independent traces.

### Migrations (`backend/migrations/`)

11 files: Google sign-in fields (001, its write path retired 2026-06-10), agent audit log (002), agent meta columns (003), agent geo fields (004), ambient agent table (004-ambient — duplicate `004` prefix; both run), resume sends (005), page views (006), post metrics (007), note sends (008), send failures (009), `daily_stats` rollup table (010), `model`/`model_fallback_depth`/`send_failures.session_id`+`attempts`+`latency_ms`/`page_views.session_id` (011). Run via Wrangler D1 migrations in prod; local SQLite auto-applies on start (`schema.sql` bakes the same columns in directly for fresh installs — keep both in sync, see the `ALTER TABLE` blocks after each base `CREATE TABLE`).

⚠️ **Migration comments must never contain a literal `;` mid-sentence.** `local-server.js`'s
bootstrap naively splits `schema.sql` on `;` before executing each statement (no real SQL
parser), so a semicolon inside a `--` comment silently truncates whatever statement follows
it. This isn't hypothetical — it happened while writing migration 010/011's comments and
silently dropped the entire `daily_stats` table definition until caught by testing. Use a
period, not a semicolon, in prose inside `schema.sql`. (Actual migration *files* aren't at
risk — `wrangler d1 migrations apply` / `d1 execute --file` send the whole file to a real
SQL parser, not a naive string split; only `schema.sql`'s fresh-install path goes through
`local-server.js`'s splitter.)

### Retention (monthly cron, `backend/src/index.js` `scheduled()`)

| Table | Cutoff | Notes |
|---|---|---|
| `page_views` | roll up daily, then delete raw at **180d** | was 365d; raw rows only needed for recent path/geo detail once rolled up |
| `agent_interactions` | redact `question`/`response` to `NULL` at **30d**, delete row at **365d** | was a flat 90d hard delete; metrics (tokens, status, model, latency) now live to 365d, only the free-text PII surface shrinks early |
| `resume_sends` / `note_sends` | **30d** | was 90d; these are 24h/1h rate-limit ledgers, so 90d was 89 days of dead weight |
| `send_failures` | **365d** | previously never purged at all — an omission from when the table was added (PR #85) |
| `resume_downloads` | **exempt, no delete** | write path (the gate) retired 2026-06-10; a finite historical dataset now, not one that needs ongoing purging. **Do not add a DELETE for this table without first re-checking whether the gate is still dead** — the old 365d rule would otherwise silently erase every lead this feature ever captured, as a side effect nobody decided on |
| `post_metrics` | none (deliberate) | upsert-bounded by post count, not time |
| `daily_stats` | never | it *is* the long-term record |

### The `daily_stats` rollup — why "all-time" numbers didn't used to survive the cron

Before this table existed, every "all-time" figure — the public `/api/agent-stats` badge, the
digest's all-time pageviews/tokens/conversations — was an **unwindowed `COUNT(*)`/`SUM()`**
over `agent_interactions`/`page_views`, tables the cron deletes from. Anything older than the
retention window was silently gone from a number labelled "all-time." The public conversation
badge was, in effect, a trailing count quietly mislabelled as a lifetime total.

Fix: `scheduled()` calls `rollupDailyStats(env)` **before** any delete/redact statement, writing
one `daily_stats` row per UTC day (idempotent — a day already present is never touched again).
Every "all-time" query became `SUM(daily_stats.<col>) + COUNT(live rows whose day isn't in
daily_stats yet)`. Verified end-to-end: seed a day into `daily_stats`, delete the same day's raw
rows, confirm the aggregate query still returns the pre-delete total.

Two columns need special handling, do not treat them like the others:

- **`unique_visitors` is exact to sum across days, not an approximation.** `visitor_hash =
  sha256(ip|ua|UTC_date)` bakes the date into the hash, so the same physical visitor gets a
  different hash on different days — no hash value can appear on two different days. Summing
  per-day distinct counts is therefore mathematically identical to a global `COUNT(DISTINCT
  visitor_hash)`, which is itself always a "visitor-days" count, not true lifetime-unique
  people. This was already true before the rollup existed; the rollup didn't change what the
  metric means, only fixed it surviving deletion.
- **`cost_usd` is a labelled approximation, not a queried fact.** It's priced with a single
  blended rate (`BLENDED_PRICE_IN_PER_1M`/`_OUT`, mirroring `ambient_send.py`'s `_PRICE_IN`/
  `_PRICE_OUT`) because Atlas's fallback cascade means a day's tokens can span more than one
  real Gemini model, and there is no verified per-model rate table to price them individually
  without guessing. Once a day's `agent_interactions` rows are redacted, the digest can no
  longer re-derive an exact per-model figure for that day — the rollup's blended estimate is
  what survives. For anything still within the 30d redact window, the digest prices by the real
  `model` column instead (see `chat_models` below) and is exact for a window where a single
  model answered every turn.

### `page_views.session_id` — aggregate-only, by policy

The only column that can join `page_views` to anything else: `visitor_hash`,
`agent_interactions.session_id`, and `resume_downloads.google_sub` are three mutually
incompatible identity schemes, and `page_views` previously carried none of them. `session_id`
is the same id the chat widget uses, generated once in `assets/js/main.js` at page load
(`window.__portfolioSessionId`) and passed to both `analytics.js`'s beacon and
`agent-widget.js`'s chat calls — not generated independently by either.

**This must stay aggregate-only.** Do not add any endpoint, digest section, or admin read that
renders one visitor's pageview path, and do not join `page_views` to `email`/`name` at the row
level in any shipped query. The column creates the *capability* for individual tracking;
`daily_stats.pageview_sessions` / `pageview_sessions_chatted` (same-day counts, computed once in
the rollup) are what keep the actual *usage* of it aggregate-only — a same-day rate ("how many
visitors who loaded a page also chatted"), never a row-level "visitor X did Y then Z." There is
no equivalent "downloaded" funnel step: the gate that would have made that an instrumented event
was retired 2026-06-10, so a static `/resume.pdf` link fires no backend call to count.

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

`analytics.js` fires `navigator.sendBeacon` → `profile.links.pageviewApi` (`POST /api/pageview`) on each page load. Worker stores `{path, referrer, visitor_hash, session_id}` in `page_views` (bot traffic filtered; raw IP never stored; hash rotates daily). Lazy-loaded via `requestIdleCallback`.

`session_id` is generated once in `main.js` (`window.__portfolioSessionId`, before either the
beacon or the chat widget lazy-load) and passed to both, so it's the *same* id as whatever
`agent_interactions.session_id` the chat widget produces this page load — see the aggregate-only
policy above. `/live-agents/`'s standalone `agents-page.js` has no beacon to correlate with, so
it generates its own session id locally, matching the widget's pre-existing per-page-load
behavior; do not wire it to the main site's `window.__portfolioSessionId` (different page,
different load).

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
