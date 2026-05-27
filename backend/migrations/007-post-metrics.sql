-- Spec #34 — LinkedIn engagement metrics for the Perspectives section.
-- Scraped twice weekly by the ambient Cloud Run agent from LinkedIn's public
-- embed endpoint. post_id is the stable numeric LinkedIn activity/share/ugcPost
-- id extracted from the post URL — used as the join key in the frontend.
-- NOT added to the monthly retention cron (counts are the displayed data and
-- must persist indefinitely).
CREATE TABLE IF NOT EXISTS post_metrics (
  post_id    TEXT PRIMARY KEY,   -- numeric LinkedIn activity id
  urn_type   TEXT,               -- share | ugcPost | activity
  reactions  INTEGER,
  comments   INTEGER,
  reposts    INTEGER,
  fetched_at INTEGER NOT NULL    -- unix seconds UTC
);
CREATE INDEX IF NOT EXISTS idx_pm_at ON post_metrics(fetched_at);
