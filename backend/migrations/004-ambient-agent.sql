-- Migration 004: ambient agent support
-- Tracks whether a lead has received an automated follow-up digest email.
-- followup_sent_at is a Unix timestamp (INTEGER); NULL means not yet sent.
ALTER TABLE resume_downloads ADD COLUMN followup_sent_at INTEGER;
