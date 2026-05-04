-- Spec #24 migration: add meta-block analytics columns to agent_interactions.
-- Safe to re-run — ALTER TABLE in SQLite/D1 is idempotent when the column
-- already exists (D1 ignores duplicate column errors; re-run manually for SQLite).
--
-- Run on production D1:
--   wrangler d1 execute resume-leads --file=backend/migrations/003-agent-meta.sql --remote

ALTER TABLE agent_interactions ADD COLUMN citations_count   INTEGER;
ALTER TABLE agent_interactions ADD COLUMN suggestions_count INTEGER;
ALTER TABLE agent_interactions ADD COLUMN cta               TEXT;
