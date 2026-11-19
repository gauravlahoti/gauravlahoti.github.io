-- Spec 98: how visitors get into Atlas, not just whether they chatted.
-- One row per funnel step the page reports through POST /api/widget-event:
--   event   open | chip | first_send
--   source  where it came from: fab, hero, bottombar, webmcp, hero-try, or,
--           for chip, which suggested question (hero-try-lab-mcp, panel-0)
-- Both are fixed strings checked against an allowlist in the Worker. No free
-- text, no question, no IP. visitor_hash is the same daily-rotating hash as
-- page_views (sha256 of ip + ua + UTC date), kept only to cap rows per
-- visitor. Aggregate-only, like page_views.session_id. Deleted after 30 days
-- by the monthly retention cron.
CREATE TABLE IF NOT EXISTS widget_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  session_id    TEXT    NOT NULL,
  visitor_hash  TEXT,
  event         TEXT    NOT NULL,
  source        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_we_at      ON widget_events(at);
CREATE INDEX IF NOT EXISTS idx_we_session ON widget_events(session_id);
CREATE INDEX IF NOT EXISTS idx_we_visitor ON widget_events(visitor_hash, at);
