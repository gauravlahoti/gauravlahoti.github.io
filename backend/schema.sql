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
