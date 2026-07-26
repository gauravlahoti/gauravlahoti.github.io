-- Track note-to-Gaurav sends for per-recipient rate limiting (the visitor's
-- email is used as CC + Reply-To on the note, so it's the address that can
-- be spammed). Mirrors resume_sends: email is hashed with the UTC date as
-- salt so the hash rotates daily; raw recipient addresses are never persisted.
CREATE TABLE IF NOT EXISTS note_sends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash  TEXT    NOT NULL,
  sent_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ns_hash ON note_sends(email_hash);
CREATE INDEX IF NOT EXISTS idx_ns_at   ON note_sends(sent_at);
