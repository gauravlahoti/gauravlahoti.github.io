-- Apply once on existing v1 (spec 11) databases. Fresh installs use schema.sql.
ALTER TABLE resume_downloads ADD COLUMN google_sub     TEXT;
ALTER TABLE resume_downloads ADD COLUMN email_verified INTEGER DEFAULT 0;
ALTER TABLE resume_downloads ADD COLUMN picture        TEXT;
CREATE INDEX IF NOT EXISTS idx_rd_sub ON resume_downloads(google_sub);
