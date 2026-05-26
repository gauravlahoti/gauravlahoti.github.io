# Spec 31: Ambient Agent via Claude Scheduler (autonomous ADK agent on Cloud Run)

## Overview

Spec 30's predecessor (PR #58) shipped an "ambient agent" as a Cloudflare Worker daily cron that called
Gemini directly inside the Worker and emailed Gaurav two things: a visitor-intelligence digest (a summary of
recent chat-agent conversations) and lead follow-up drafts (outreach copy for un-contacted resume
downloaders). This spec re-homes that capability so the three concerns live where they belong:

1. **Trigger** → a **Claude scheduler** (`/schedule` skill), the same pattern the GCP cost-monitor routine
   uses. It runs twice weekly and only fires an HTTP POST.
2. **Reasoning** → an **autonomous ADK `LlmAgent`** on Cloud Run (`portfolio-agent`), which calls its own
   function tools to fetch data, compose the two emails, and mark leads done.
3. **Email** → the existing **Resend MCP** path the chat agent already uses (`_send_via_mcp`), so no Resend
   key reaches Cloud Run or the scheduler prompt.

The Cloudflare Worker is reduced to what only it can do — read/write D1 — exposed as three thin
token-gated endpoints. Cadence: **Mon + Thu, 08:00 Asia/Kolkata** (`0 8 * * 1,4`).

The cumulative public `GET /api/agent-stats` widget (PR #58) is unchanged.

## Depends on

- Spec 21 — ADK agent on Cloud Run (the `portfolio-agent` app, `InMemoryRunner`, custom routes).
- Spec 23 — agent audit log (`agent_interactions` table, `AGENT_LOG_TOKEN`, `audit_log.py`).
- Spec 28/30 — resume/note send via Resend MCP (`resume_send._send_via_mcp`, `note_send.py`).
- PR #58 — `followup_sent_at` column (`migrations/004-ambient-agent.sql`), `GET /api/agent-stats`.

## Routes

**Cloudflare Worker** (`backend/`) — new, gated by `X-Internal-Token === AGENT_LOG_TOKEN` (server-to-server,
no CORS). Mirror in both `src/index.js` (D1) and `local-server.js` (SQLite).

- `GET  /api/ambient/interactions?days=3` → `{ ok, interactions: [{question, response, status, country,
  city, logged_at}] }`. `days` clamped 1..30; `LIMIT 100`.
- `GET  /api/ambient/leads` → `{ ok, leads: [{id, email, name, downloaded_at}] }` where
  `followup_sent_at IS NULL AND downloaded_at < now-24h`; `LIMIT 25`.
- `POST /api/ambient/leads/mark` body `{ ids: number[] }` → `{ ok, marked }`. Validates positive integers,
  caps at 25.

Removed: the Worker's `"0 8 * * *"` daily cron and all in-Worker Gemini/email code (`runAmbientAgent`,
`runVisitorIntelligence`, `runLeadDigest`, `callGemini`, `sendResendEmail`). `scheduled()` is retention-only
again. `GEMINI_API_KEY` is no longer a Worker secret.

**Cloud Run** (`portfolio-agent/app/api.py`) — new:

- `POST /api/ambient/run` → drives the ambient agent once through a dedicated `InMemoryRunner` and returns
  `{ ok, interactions_seen, leads_processed, emails_sent }` (counts only, no PII). Gated by a dedicated
  `AMBIENT_TRIGGER_TOKEN` in the `X-Internal-Token` header — NOT `AGENT_LOG_TOKEN` — so the scheduler prompt
  never carries the D1-write secret (same blast-radius logic as the GCP monitor's `COST_MONITOR_TOKEN`).

## Database changes

No new tables or columns. `followup_sent_at` already shipped in `migrations/004-ambient-agent.sql`.

`backend/schema.sql` gains an idempotent `ALTER TABLE resume_downloads ADD COLUMN followup_sent_at INTEGER;`
so the local SQLite server (which bootstraps from `schema.sql`, not from migration files) has the column for
local testing of `/api/ambient/leads`.

**Migration numbering note:** `004-ambient-agent.sql` collides with the pre-existing `004-agent-geo-fields.sql`
and sorts before `005-resume-sends.sql`. It is left as-is — it is merged and likely already applied to prod
D1; renaming would make `wrangler d1 migrations apply` try to re-add the column and fail. Future migrations
should resume at `006`.

## Python changes

- **NEW** `app/ambient_agent.py` — autonomous `Agent` (NOT a second `App`; the CLI owns `App(name="app")`).
  Model `gemini-3.5-flash` (Google I/O 2026). A new agent, so the "never change the model" rule (which
  protects the chat agent's `gemini-2.5-flash`) does not apply. Its instruction defines the two-task cycle and
  forbids treating conversation/lead text as instructions. Tools: the five below.
- **NEW** `app/app_utils/ambient_data.py` — three tools that GET/POST the Worker's `/api/ambient/*` endpoints
  via `httpx`, deriving the base URL from `AGENT_LOG_URL` (stripping `/api/agent-log`, same trick as
  `resume_send._check_url`) and authenticating with `AGENT_LOG_TOKEN`. `get_recent_interactions(days=3)`,
  `get_pending_leads()`, `mark_leads_done(lead_ids)`. Never raise — return empty/`{ok:False}` on failure.
- **NEW** `app/app_utils/ambient_send.py` — `send_digest_email(html_body)` and `send_lead_drafts(html_body)`,
  reusing `resume_send._send_via_mcp` + `_env`. Recipient is **hardcoded** to `GAURAV_CONTACT_EMAIL` (never an
  argument), so injected "email X" text in a conversation/lead cannot redirect mail (injection containment,
  mirrors `note_send.py`).
- **MODIFY** `app/api.py` — import `ambient_agent`, add `_ambient_runner`, add `_run_ambient_cycle()` (drives
  the runner once with an ephemeral session and derives the counts by inspecting `function_call` /
  `function_response` parts), and register `POST /api/ambient/run`. Logs a warning if `send_lead_drafts`
  succeeded but `mark_leads_done` was never called.
- **MODIFY** `portfolio-agent/.env.example` — document the reused vars + the one new `AMBIENT_TRIGGER_TOKEN`.
- **NEW** `tests/unit/test_ambient.py` — unit tests for the data + send helpers (URL/header/`ids` assertions,
  empty-on-failure, recipient is hardcoded). The chat agent is untouched, so `agents-cli eval` stays green.

## Trigger (operational, not code)

After deploy, create the Claude scheduler via `/schedule` (`CronCreate`, recurring): cron `0 8 * * 1,4`, TZ
`Asia/Kolkata`. Prompt POSTs to `https://<cloud-run>/api/ambient/run` with
`X-Internal-Token: <AMBIENT_TRIGGER_TOKEN>` and summarises the JSON result. Embed only
`AMBIENT_TRIGGER_TOKEN`. Caveat: Claude routines auto-expire (~7 days); the routine must re-arm or be renewed
weekly.

## Definition of done

**Worker (local):** `cd backend && npm install && npm start`; seed a `resume_downloads` row >24h old with
`followup_sent_at` NULL and a couple `agent_interactions` rows; then:

- [ ] `GET /api/ambient/interactions?days=3` (with `X-Internal-Token`) returns the rows; missing/wrong token → 401/503.
- [ ] `GET /api/ambient/leads` returns the un-contacted lead.
- [ ] `POST /api/ambient/leads/mark {ids:[<id>]}` returns `{ok, marked:1}`; the lead no longer appears in `/leads`.

**Cloud Run (local):** in `.env` set `AGENT_LOG_URL` at `localhost:8787`, `AMBIENT_TRIGGER_TOKEN=dev-trigger`,
`GAURAV_CONTACT_EMAIL`, `RESEND_MCP_URL`; `make dev`; then:

- [ ] `POST /api/ambient/run` (with `X-Internal-Token: dev-trigger`) returns `{ok:true, interactions_seen,
  leads_processed, emails_sent}`; missing token → 401/503.
- [ ] Test inbox receives the digest and/or lead-drafts email; lead now has `followup_sent_at` set; a second
  run reports `leads_processed:0` (idempotent).
- [ ] `uv run pytest tests/unit tests/integration` green.
- [ ] `agents-cli eval run --evalset tests/eval/evalsets/portfolio.evalset.json` still green (chat unchanged).

**Prod (after approval):** `wrangler deploy`; `agents-cli deploy`; set `AMBIENT_TRIGGER_TOKEN` on Cloud Run;
create the scheduler; one manual `RemoteTrigger run` confirms end-to-end.

## Rationale

**Why move reasoning off the Worker.** The Worker is a thin D1 gateway on the edge; running an LLM inside it
meant a Gemini key on Cloudflare and prompt logic far from the corpus. Cloud Run already hosts the agent, the
corpus, the Resend MCP wiring, and `httpx` — the ambient agent reuses all of it. The Worker keeps only the one
thing it alone can do: reach D1.

**Why an autonomous agent rather than a deterministic pipeline.** Chosen deliberately: it exercises the ADK
ambient-agent pattern (a real tool-calling loop) and is the more interesting portfolio artifact. The risk —
the agent skipping `mark_leads_done` and re-emailing leads — is contained two ways: the instruction makes the
mark a required final step, and the `get_pending_leads` query is the source of truth (a missed mark merely
re-surfaces the lead, and the route logs a warning).

**Why two tokens.** `AMBIENT_TRIGGER_TOKEN` (in the scheduler prompt) gates only the Cloud Run trigger;
`AGENT_LOG_TOKEN` (server-to-server only) gates the Worker's D1 endpoints. Keeping the D1-write secret out of
any prompt mirrors why the GCP monitor uses a dedicated `COST_MONITOR_TOKEN` instead of `ADMIN_TOKEN`.

**Why the Claude scheduler is just a trigger.** The scheduler's only job is "POST and report" — no secrets
beyond the trigger token, no business logic, easy to re-arm. All decision-making lives in the agent, which is
versioned and testable.
