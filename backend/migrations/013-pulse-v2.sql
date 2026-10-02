-- Spec 84: Pulse v2 reads how people talk to Atlas, not just how much.
--   reply_mode      text | voice | avatar | convo (hands-free conversation)
--   avatar_seconds  seconds the avatar spoke this turn (it is billed per second)
--   first_ms        time to the first word (avatar) or first token (text/voice).
--                   latency_ms stays as it was, the whole turn for text, so
--                   history keeps one meaning.
-- Rows before this migration are NULL, and the digest infers their mode from
-- `model` (the avatar's Live model vs everything else).
ALTER TABLE agent_interactions ADD COLUMN reply_mode     TEXT;
ALTER TABLE agent_interactions ADD COLUMN avatar_seconds REAL;
ALTER TABLE agent_interactions ADD COLUMN first_ms       INTEGER;

-- Where a page view came from, for Pulse's visitor map. From Cloudflare's
-- request.cf, rounded to one decimal (about 11 km, city level). Older rows
-- stay NULL and are plotted at their country's centroid.
ALTER TABLE page_views ADD COLUMN latitude  REAL;
ALTER TABLE page_views ADD COLUMN longitude REAL;
