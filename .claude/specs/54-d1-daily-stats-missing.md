# Spec 54 — `/api/agent-stats` 500: the `daily_stats` table was never created

**Status:** fixed in production
**Date:** 2026-08-29
**Found:** incidentally, while verifying an unrelated frontend change. The 500
was in the console on every page load and had been for some time.

## Symptom

`GET /api/agent-stats` returned 500 on production and locally. The public
"questions answered" counter on the site (`main.js:123`) silently rendered
nothing.

## Root cause

`handleAgentStats` (`backend/src/index.js:852`) reads from `daily_stats`.
**That table did not exist in the production D1 database.** The handler
catches any D1 error and returns a generic `{ok:false,error:"Internal"}`,
so the real message (`no such table: daily_stats`) never surfaced.

Migration `010-daily-stats.sql` had never been applied.

## The complication

`011-analytics-columns.sql` and `012-agent-thinking-columns.sql` were also
absent from `d1_migrations` — **but their columns already existed** in the
live tables (`agent_interactions.model`, `.thinking_tokens`, `.had_thinking`,
`page_views.session_id`, `send_failures.attempts`, …). They had been applied
by hand and never recorded.

So the ledger was wrong in both directions, and the obvious fix was a trap:
`wrangler d1 migrations apply` would have tried all three, and 011/012 are
bare `ALTER TABLE ADD COLUMN` (SQLite has no `IF NOT EXISTS` for that), so it
would have failed with duplicate-column errors partway through.

## Blast radius — three consumers, not one

1. **`/api/agent-stats`** (`index.js:865`) — public counter. 500.
2. **All-time stats** (`index.js:1046-1073`) — feeds the Pulse digest. Same
   failure, so every "all-time" figure in the digest was broken.
3. **The monthly retention cron** (`crons = ["0 2 1 * *"]`) — the serious one.
   `rollupDailyStats()` catches its candidate-day query failure and `return`s
   early, but the redact/delete blocks that follow it each sit in their own
   `try/catch` and **ran anyway**. That is exactly the bug `index.js:110-115`
   documents as already fixed once: *"the old cron deleted straight from
   agent_interactions/page_views with no rollup at all, so those 'all-time'
   numbers were silently just 'however far back the last purge reached.'"*
   It regressed, because the rollup it depends on could not run.

## No data was lost

Verified against the source tables rather than assumed:

| Table | Rows | Range | Delete cutoff | First loss |
|---|---|---|---|---|
| `agent_interactions` | 367 | 2026-05-05 → 08-29 | 365d | ~2027-05-05 |
| `page_views` | 900 | 2026-05-26 → 08-29 | 180d | **~2026-11-22** |
| `send_failures` | 0 | — | 365d | — |

Nothing had reached its cutoff, so every count was still recoverable from
source. The 30d text redaction had run, but that only nulls
`question`/`response` and leaves all metric columns intact.

The real deadline was **2026-11-22**, when `page_views` rows would have
started being deleted without ever being rolled up.

## Fix applied

```bash
# 1. the missing table, straight from the existing migration file
npx wrangler d1 execute resume-leads --remote --file migrations/010-daily-stats.sql

# 2. reconcile the ledger with what is actually in the database
INSERT OR IGNORE INTO d1_migrations (name, applied_at) VALUES
  ('010-daily-stats.sql', datetime('now')),
  ('011-analytics-columns.sql', datetime('now')),
  ('012-agent-thinking-columns.sql', datetime('now'));
```

No Worker code changed. The bug was purely the missing migration.

An empty `daily_stats` is already correct for the read path: the query
degrades to `0 + COUNT(*) over all agent_interactions`, so the counter was
right the moment the table existed.

## Verified

- `/api/agent-stats` → **200**, `{"ok":true,"total_conversations":367}`,
  matching `SELECT COUNT(*) FROM agent_interactions` exactly
- All-time digest query runs: 900 pageviews, 232 conversations
- Cron candidate-day query runs: **94 days pending rollup**
- `rollupOneDay`'s full SELECT executed cleanly against a real day
  (2026-05-05), so every column, the correlated `EXISTS`, and the percentile
  `OFFSET` subqueries all resolve. The Sept 1 cron will roll up the backlog;
  it is idempotent (`INSERT OR IGNORE`, and skips days already present).

## Open recommendation (not done, needs a Worker deploy)

**The retention cron should not delete when the rollup fails.** Today
`rollupDailyStats()` returning early does not stop the destructive blocks
that follow, so any future rollup error silently reopens this exact failure
mode: purge source rows that were never rolled up. Suggested shape:

```js
const rolledUp = await rollupDailyStats(env);   // return false on failure
if (!rolledUp) {
    console.error("[retention] rollup failed — skipping destructive phase");
    return;
}
```

Secondary: `handleAgentStats` swallows the D1 error into a generic
"Internal". Logging `err.message` into the response body (or at least not
flattening every cause to one string) would have made this a one-minute
diagnosis instead of a schema audit.

## Follow-up worth noting

`agents/pulse/DESIGN_SPEC.md` is a stale copy of Atlas's spec — it documents
a chat widget, SSE endpoint, and per-visitor chat rate limits, none of which
Pulse has. Unrelated to this bug, but it will mislead the next reader.
