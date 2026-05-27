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
