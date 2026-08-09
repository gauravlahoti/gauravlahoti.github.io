-- Tier 1 analytics columns — see .claude/docs/backend.md for the full
-- rationale. Each closes a gap where data was being lost permanently every
-- day it stayed missing (unlike retention, which can be changed at any time
-- without losing anything that hasn't happened yet).
--
-- agent_interactions.model: Atlas runs FallbackGemini with a 4-model cascade
-- (gemini-3.6-flash -> 3.5-flash -> 2.5-flash -> 2.5-flash-lite), but the
-- digest hardcoded "gemini-2.5-flash" for both display and pricing. Without
-- this column there was no way to tell how often the cascade fires or to
-- price a turn correctly.
ALTER TABLE agent_interactions ADD COLUMN model TEXT;
ALTER TABLE agent_interactions ADD COLUMN model_fallback_depth INTEGER;

-- send_failures: attempts distinguishes "the retry logic rescued this" from
-- "it just delayed the failure". session_id links a failure back to the
-- conversation the visitor was in.
ALTER TABLE send_failures ADD COLUMN session_id TEXT;
ALTER TABLE send_failures ADD COLUMN attempts INTEGER;
ALTER TABLE send_failures ADD COLUMN latency_ms INTEGER;

-- page_views.session_id: the only column that can join page_views to
-- anything else (visitor_hash, agent_interactions.session_id, and
-- resume_downloads.google_sub are three mutually incompatible identity
-- schemes today). Aggregate-only by policy — see daily_stats' rollup
-- columns and .claude/docs/backend.md. No shipped query joins this to
-- email/name at the row level.
ALTER TABLE page_views ADD COLUMN session_id TEXT;
