# 33 — Rich visitor-intelligence digest + self-hosted site analytics

## Overview

The ambient agent's weekly digest (Spec #31/#32) emailed two plain, prose-only messages with no real
metrics. This replaces them with **one** dashboard email: a deterministic HTML metrics panel (all-time
totals, this-week-vs-prior with % deltas, top questions, geo, errors) plus the LLM's qualitative insights
and any lead follow-up drafts, under the subject **"Your weekly portfolio pulse is in"**.

Real visitor numbers require analytics, and the site had none. Rather than Google Analytics (cookies,
consent, external Data API) or Cloudflare Web Analytics (CF API token), we add a **self-hosted, cookieless
pageview beacon → Worker → D1** — it reuses the existing Worker+D1+ambient pattern, needs no new
credentials, no CSP change, and matches the site's privacy posture. Pageview history starts at deploy, so
the first email shows small numbers and grows weekly.

## Depends on
- Spec #31 (ambient ADK agent on Cloud Run), Spec #32 (Cloud Scheduler trigger).

## Routes (Cloudflare Worker + local-server mirror)
- **`POST /api/pageview`** — public, CORS-gated to the site origins like `/api/resume-download`. Body
  `{path, referrer}`. Drops bots (user-agent regex) and disallowed origins. Stores one `page_views` row:
  geo from `request.cf` (country/region/city), referrer reduced to hostname, and a daily-rotating
  `visitor_hash = sha256(ip + ua + UTC_date)[:16]` (raw IP never stored — mirrors `resume_sends`). Always
  returns `204` (a beacon must never surface errors).
- **`GET /api/ambient/stats?days=4`** — gated by `X-Internal-Token === AGENT_LOG_TOKEN`. Returns
  pre-aggregated JSON: `all_time {pageviews, unique_visitors, downloads, conversations}`,
  `window {…, agent_turns, agent_errors}`, `prev_window {pageviews, unique_visitors, downloads}`,
  `top_questions` (≤10), `geo` (≤8), `errors` (≤8). All computed in SQL.

## Database changes
- New table **`page_views`** `(id, viewed_at, path, referrer, country, region, city, visitor_hash)` with
  indexes on `viewed_at` and `visitor_hash`. In `backend/schema.sql` (local bootstrap) and migration
  `backend/migrations/006-page-views.sql` (prod D1). Added to the monthly retention cron (365-day window).

## Frontend changes
- New `assets/js/analytics.js`: `initAnalytics(profile)` sends one `navigator.sendBeacon` to
  `profile.links.pageviewApi` (added to `profile.json`) with `{path, referrer}`. Body is a `text/plain`
  Blob (CORS-safelisted → no preflight; the Worker parses it as JSON regardless). Honours Do Not Track.
- `main.js`: `initAnalyticsWhenIdle(profile)` lazy-imports `analytics.js` on `requestIdleCallback` so it
  stays off the FCP path. **No CSP change** — the Worker origin is already in `connect-src`.

## Python changes (`portfolio-agent/app/`)
- `app_utils/ambient_data.py`: add **`get_visitor_stats(days=4)`** → GET `/api/ambient/stats`.
- `app_utils/ambient_send.py`: rewrite around one send. `_build_dashboard(stats)` renders inline-styled
  stat cards, a this-week row with ▲/▼ deltas, a top-questions table with CSS bars, a geo bar chart, and
  an errors table (or a green "no errors" note). **`send_review_email(insights_html, lead_drafts_html="")`**
  fetches stats, assembles dashboard + insights + drafts, and sends ONE email (subject above) with the
  `text` part from `_html_to_text` (keeps the #60 fix). `send_digest_email`/`send_lead_drafts` removed.
- `ambient_agent.py`: instruction rewritten to the single-email flow — insights → lead drafts →
  `send_review_email` → `mark_leads_done`. Tools: `[get_recent_interactions, get_pending_leads,
  send_review_email, mark_leads_done]`. `max_output_tokens=4000` and the ≤5 lead cap stay.
- `api.py` `_run_ambient_cycle`: count `send_review_email` as the single email; keep the anomaly log and
  the mark-leads guard.

## Definition of done
- [ ] `POST /api/pageview` writes a `page_views` row (geo on prod via `request.cf`); bots/foreign origins
  dropped; returns 204. Beacon fires on the live site without CSP errors.
- [ ] `GET /api/ambient/stats` returns correct aggregates (verified locally with seeded rows).
- [ ] Migration 006 applied to prod D1; retention cron covers `page_views`.
- [ ] `POST /api/ambient/run` sends exactly **one** email rendering the dashboard (cards/bars/tables) +
  insights + (when present) lead drafts; subject "Your weekly portfolio pulse is in" (no dashes).
- [ ] `uv run pytest tests/unit` green (dashboard empty + populated, single send, gated stats fetch).

## Rationale
- **Self-hosted beacon over GA4/CF.** Cookieless and consent-free, no external credentials, no CSP change,
  geo is free from `request.cf`, and it reuses the one thing only the Worker can do — reach D1. Consistent
  with the IP-truncation / hashed-identifier posture already in `resume_downloads`/`resume_sends`.
- **Deterministic dashboard, LLM only for prose.** The earlier digest was weak because the LLM authored
  freeform HTML. Numbers, tables, and bars are now computed in code (exact, consistent); the model
  contributes only qualitative insights and lead drafts — its actual strength.
- **One email.** A single weekly artifact is easier to read than two; the dashboard, insights, and lead
  drafts live in one place.
- **Privacy.** No cookies, no localStorage; `visitor_hash` rotates daily and the raw IP is never stored;
  Do Not Track is honoured client-side.
