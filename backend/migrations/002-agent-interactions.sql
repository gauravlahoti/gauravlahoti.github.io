-- Migration 002: add agent_interactions table for Q&A audit log (Spec #23).
-- Safe to run multiple times (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS).

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
