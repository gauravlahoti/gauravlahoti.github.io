CREATE TABLE IF NOT EXISTS resume_downloads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub      TEXT NOT NULL,
  email           TEXT NOT NULL,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  name            TEXT NOT NULL,
  picture         TEXT,
  downloaded_at   INTEGER NOT NULL,
  ip              TEXT,
  user_agent      TEXT,
  referrer        TEXT
);
CREATE INDEX IF NOT EXISTS idx_rd_email ON resume_downloads(email);
CREATE INDEX IF NOT EXISTS idx_rd_at    ON resume_downloads(downloaded_at);
CREATE INDEX IF NOT EXISTS idx_rd_sub   ON resume_downloads(google_sub);

-- Ambient agent (Spec #31): NULL until the agent has drafted a follow-up for
-- this lead. Also shipped as migration 004-ambient-agent.sql for prod D1, kept
-- here so the local SQLite server (local-server.js) picks it up on boot.
ALTER TABLE resume_downloads ADD COLUMN followup_sent_at INTEGER;

CREATE TABLE IF NOT EXISTS agent_interactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT    NOT NULL,
  turn_index      INTEGER NOT NULL DEFAULT 0,
  logged_at       INTEGER NOT NULL,            -- unix seconds, UTC (matches resume_downloads)
  question        TEXT    NOT NULL,
  response        TEXT    NOT NULL DEFAULT '',
  tool_calls      TEXT,                        -- JSON array string: [{"name":"...","args":{...}}]
  tokens_input    INTEGER,
  tokens_output   INTEGER,
  latency_ms      INTEGER,
  status          TEXT    NOT NULL DEFAULT 'ok',
                                               -- ok | error | injection_blocked | too_long | rate_limited
  error_message   TEXT,
  google_sub      TEXT,                        -- present iff visitor signed in for resume gate
  email           TEXT,                        --     "
  ip              TEXT,                        -- /24 (IPv4) or /64 (IPv6) — same truncation as resume_downloads
  user_agent      TEXT,
  referrer        TEXT,
  agent_version   TEXT                         -- COMMIT_SHA from Cloud Run env
);
CREATE INDEX IF NOT EXISTS idx_ai_session ON agent_interactions(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_at      ON agent_interactions(logged_at);
CREATE INDEX IF NOT EXISTS idx_ai_sub     ON agent_interactions(google_sub);
CREATE INDEX IF NOT EXISTS idx_ai_status  ON agent_interactions(status);

-- Spec #24 — meta-block extracted server-side, persisted as flat columns.
ALTER TABLE agent_interactions ADD COLUMN citations_count   INTEGER;
ALTER TABLE agent_interactions ADD COLUMN suggestions_count INTEGER;
ALTER TABLE agent_interactions ADD COLUMN cta               TEXT;

-- Visitor geo-location, resolved server-side from the untruncated client IP.
ALTER TABLE agent_interactions ADD COLUMN country TEXT;
ALTER TABLE agent_interactions ADD COLUMN region  TEXT;
ALTER TABLE agent_interactions ADD COLUMN city    TEXT;

-- Which model actually answered (Atlas cascades gemini-3.7-flash -> 3.6-flash
-- on 429/503). Without this, the digest could not tell how often the cascade
-- fires or price a turn by the right model.
-- Shipped as migration 011-analytics-columns.sql for prod D1.
ALTER TABLE agent_interactions ADD COLUMN model TEXT;
ALTER TABLE agent_interactions ADD COLUMN model_fallback_depth INTEGER;

-- Gemini thought-summary token count (usage_metadata.thoughts_token_count) and
-- whether the turn produced any visible thinking. Raw thought text is never
-- persisted here (unedited, exploratory reasoning) — only this aggregate, so
-- cost stays visible without storing the reasoning itself.
-- Shipped as migration 012-agent-thinking-columns.sql for prod D1.
ALTER TABLE agent_interactions ADD COLUMN thinking_tokens INTEGER;
ALTER TABLE agent_interactions ADD COLUMN had_thinking     INTEGER;

-- Per-recipient rate-limit ledger for the agent's send_resume action.
-- Email hashed (sha256 of email + UTC date, first 16 chars) before storage, raw
-- addresses never persisted. Cleaned by the same retention cron as agent_interactions.
CREATE TABLE IF NOT EXISTS resume_sends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash  TEXT    NOT NULL,
  sent_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rs_hash ON resume_sends(email_hash);
CREATE INDEX IF NOT EXISTS idx_rs_at   ON resume_sends(sent_at);

-- Per-recipient rate-limit ledger for the agent's send_note_to_gaurav action.
-- Same shape/salt scheme as resume_sends. Also shipped as migration
-- 008-note-sends.sql for prod D1.
CREATE TABLE IF NOT EXISTS note_sends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash  TEXT    NOT NULL,
  sent_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ns_hash ON note_sends(email_hash);
CREATE INDEX IF NOT EXISTS idx_ns_at   ON note_sends(sent_at);

-- Self-hosted, cookieless pageview analytics (Spec #33). One row per page load
-- via POST /api/pageview. Geo from Cloudflare request.cf, and visitor_hash
-- rotates daily (sha256 of ip + ua + UTC date, first 16 chars) so the raw IP is
-- never stored. Powers the weekly digest via GET /api/ambient/stats. Also
-- shipped as migration 006-page-views.sql for prod D1.
CREATE TABLE IF NOT EXISTS page_views (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  viewed_at     INTEGER NOT NULL,
  path          TEXT,
  referrer      TEXT,
  country       TEXT,
  region        TEXT,
  city          TEXT,
  visitor_hash  TEXT
);
CREATE INDEX IF NOT EXISTS idx_pv_at   ON page_views(viewed_at);
CREATE INDEX IF NOT EXISTS idx_pv_hash ON page_views(visitor_hash);

-- The only column that can join page_views to anything else — visitor_hash,
-- agent_interactions.session_id, and resume_downloads.google_sub are three
-- mutually incompatible identity schemes. Aggregate-only by policy: rolled up
-- into daily_stats' pageview_sessions* columns, never joined to email/name at
-- the row level in any shipped query. Shipped as migration 011 for prod D1.
ALTER TABLE page_views ADD COLUMN session_id TEXT;

-- Spec #34 — LinkedIn engagement metrics (reactions, comments, reposts).
-- post_id is the stable numeric LinkedIn activity id from the post URL.
-- Shipped as migration 007-post-metrics.sql for prod D1.
CREATE TABLE IF NOT EXISTS post_metrics (
  post_id    TEXT PRIMARY KEY,
  urn_type   TEXT,
  reactions  INTEGER,
  comments   INTEGER,
  reposts    INTEGER,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_at ON post_metrics(fetched_at);

-- Failed outbound email sends. Written at the moment of failure so a chat turn
-- that dies mid-stream still leaves a trace (the agent_interactions row is
-- fire-and-forget after streaming completes).
-- Shipped as migration 009-send-failures.sql for prod D1.
CREATE TABLE IF NOT EXISTS send_failures (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,
  code        TEXT    NOT NULL,
  email_hash  TEXT,
  failed_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sf_at   ON send_failures(failed_at);
CREATE INDEX IF NOT EXISTS idx_sf_kind ON send_failures(kind);

-- attempts distinguishes "the retry logic rescued this" from "it just
-- delayed the failure". session_id links a failure back to the conversation
-- the visitor was in. Shipped as migration 011-analytics-columns.sql.
ALTER TABLE send_failures ADD COLUMN session_id TEXT;
ALTER TABLE send_failures ADD COLUMN attempts INTEGER;
ALTER TABLE send_failures ADD COLUMN latency_ms INTEGER;

-- Daily rollup written by the retention cron immediately before it
-- deletes/redacts that day's source rows, so "all-time" counters survive
-- the cron instead of silently shrinking as data ages out. unique_visitors
-- is a same-day DISTINCT count, NOT additive across days. pageview_sessions*
-- are same-day aggregate rates only, see the session_id comment on
-- page_views above, and are never a row-level join. There is no "downloaded"
-- funnel step: the gate that made that an instrumented event was retired
-- 2026-06-10. Shipped as migration 010-daily-stats.sql for prod D1.
CREATE TABLE IF NOT EXISTS daily_stats (
  day                       TEXT    PRIMARY KEY,
  pageviews                 INTEGER NOT NULL DEFAULT 0,
  unique_visitors           INTEGER NOT NULL DEFAULT 0,
  downloads                 INTEGER NOT NULL DEFAULT 0,
  conversations             INTEGER NOT NULL DEFAULT 0,
  turns                     INTEGER NOT NULL DEFAULT 0,
  tokens_in                 INTEGER NOT NULL DEFAULT 0,
  tokens_out                INTEGER NOT NULL DEFAULT 0,
  cost_usd                  REAL    NOT NULL DEFAULT 0,
  errors                    INTEGER NOT NULL DEFAULT 0,
  send_failures             INTEGER NOT NULL DEFAULT 0,
  pageview_sessions         INTEGER NOT NULL DEFAULT 0,
  pageview_sessions_chatted INTEGER NOT NULL DEFAULT 0,
  latency_p50_ms            INTEGER,
  latency_p95_ms            INTEGER,
  rolled_up_at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ds_day ON daily_stats(day);
