-- Daily rollup so lifetime/"all-time" counters survive the retention cron.
--
-- Before this, every "all-time" figure (the public agent-stats badge, the
-- digest's all-time pageviews/tokens/conversations) was an unwindowed
-- COUNT(*)/SUM() over agent_interactions/page_views — tables the same cron
-- hard-deletes from. Anything older than the retention window was silently
-- gone from a number labelled "all-time". One row per UTC day, written by
-- the cron immediately before it deletes/redacts that day's source rows, so
-- lifetime totals become SUM(daily_stats) + a live tail query.
--
-- unique_visitors is a same-day DISTINCT count and is NOT additive across
-- days — summing it over a range overcounts repeat visitors. There is no
-- way to recover a true lifetime-unique-visitor count from this rollup.
--
-- pageview_sessions / pageview_sessions_chatted exist only to answer "what
-- fraction of visitors who loaded a page also talked to the agent" as a
-- same-day aggregate rate — never as a row-level join. Both are 0 until
-- page_views.session_id starts being populated (migration 011) and will
-- stay 0 for any day before that. There is no equivalent "downloaded"
-- funnel step: the resume-download gate that would have made that an
-- instrumented event was retired 2026-06-10, so a static PDF link fires no
-- backend call to count.
CREATE TABLE IF NOT EXISTS daily_stats (
  day                      TEXT    PRIMARY KEY, -- 'YYYY-MM-DD' (UTC)
  pageviews                INTEGER NOT NULL DEFAULT 0,
  unique_visitors          INTEGER NOT NULL DEFAULT 0,
  downloads                INTEGER NOT NULL DEFAULT 0,
  conversations            INTEGER NOT NULL DEFAULT 0,
  turns                    INTEGER NOT NULL DEFAULT 0,
  tokens_in                INTEGER NOT NULL DEFAULT 0,
  tokens_out               INTEGER NOT NULL DEFAULT 0,
  cost_usd                 REAL    NOT NULL DEFAULT 0,
  errors                   INTEGER NOT NULL DEFAULT 0,
  send_failures            INTEGER NOT NULL DEFAULT 0,
  pageview_sessions        INTEGER NOT NULL DEFAULT 0,
  pageview_sessions_chatted INTEGER NOT NULL DEFAULT 0,
  latency_p50_ms           INTEGER,
  latency_p95_ms           INTEGER,
  rolled_up_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ds_day ON daily_stats(day);
