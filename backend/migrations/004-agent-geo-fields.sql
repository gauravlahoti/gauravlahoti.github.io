-- Spec: capture visitor geo-location per agent turn.
-- Resolved on Cloud Run from the untruncated client IP, then forwarded
-- to the Worker; never derived from the stored truncated IP.
ALTER TABLE agent_interactions ADD COLUMN country TEXT;
ALTER TABLE agent_interactions ADD COLUMN region  TEXT;
ALTER TABLE agent_interactions ADD COLUMN city    TEXT;
