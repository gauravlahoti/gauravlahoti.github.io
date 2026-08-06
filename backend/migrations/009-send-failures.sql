-- Durable record of outbound email sends that FAILED, so failures are countable
-- rather than inferred from a missing resume_sends row.
--
-- Why this is separate from the agent_interactions audit log: that row is written
-- fire-and-forget after the chat turn has finished streaming, so a turn that dies
-- mid-stream leaves no trace at all. This row is written at the moment the send
-- fails, and it also covers senders that never touch the chat audit log.
--
-- kind distinguishes which send it was ("resume" / "note"). code is the short
-- failure code the tool returned (send_failed, not_configured, ...). email_hash
-- follows the same daily-rotating-salt convention as resume_sends and note_sends;
-- raw recipient addresses are never persisted.
CREATE TABLE IF NOT EXISTS send_failures (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,
  code        TEXT    NOT NULL,
  email_hash  TEXT,
  failed_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sf_at   ON send_failures(failed_at);
CREATE INDEX IF NOT EXISTS idx_sf_kind ON send_failures(kind);
