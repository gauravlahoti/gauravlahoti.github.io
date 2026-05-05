-- Track resume-by-email sends for per-recipient rate limiting.
-- Email is hashed with the UTC date as salt so the hash rotates daily;
-- raw recipient addresses are never persisted.
CREATE TABLE IF NOT EXISTS resume_sends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash  TEXT    NOT NULL,
  sent_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rs_hash ON resume_sends(email_hash);
CREATE INDEX IF NOT EXISTS idx_rs_at   ON resume_sends(sent_at);
