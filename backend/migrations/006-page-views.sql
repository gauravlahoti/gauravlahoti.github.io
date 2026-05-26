-- Migration 006: self-hosted, cookieless pageview analytics (Spec #33).
-- One row per page load, written by POST /api/pageview. Geo is resolved from
-- Cloudflare's request.cf; visitor_hash = sha256(ip + ua + UTC_date)[:16] so it
-- rotates daily and the raw IP is never stored (mirrors resume_sends hashing).
-- Powers the weekly visitor-intelligence digest via GET /api/ambient/stats.
--
-- Run on production D1:
--   wrangler d1 execute resume-leads --remote --file=backend/migrations/006-page-views.sql

CREATE TABLE IF NOT EXISTS page_views (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  viewed_at     INTEGER NOT NULL,            -- unix seconds, UTC
  path          TEXT,                        -- request path, capped
  referrer      TEXT,                        -- referrer hostname only
  country       TEXT,
  region        TEXT,
  city          TEXT,
  visitor_hash  TEXT                         -- daily-rotating, raw IP never stored
);
CREATE INDEX IF NOT EXISTS idx_pv_at   ON page_views(viewed_at);
CREATE INDEX IF NOT EXISTS idx_pv_hash ON page_views(visitor_hash);
