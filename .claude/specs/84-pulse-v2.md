# Spec 84: Pulse v2

Pulse's email was designed when the site was a chat widget and a gated resume.
Since then the gate was retired (2026-06-10), and Atlas gained voice, a video
avatar and hands-free live calls. The site also gained AI Labs, a Live Agents
page and LinkedIn engagement metrics. The email still led with all-time
"Downloads", raised a "conversion gap" built on downloads, priced tokens at a
hardcoded rate, and said nothing about how people talk to Atlas or what the
site costs.

Pulse v2 keeps the same schedule (Mon and Thu, 08:00 IST) and the same single
email, and rebuilds what's in it.

## The email

Single 600px column of email-safe tables (no SVG, no `<style>`), with a black
header carrying the site's cyan accent over light cards. Every section hides
itself when empty.

1. **Header**: date, the window, and a one-line headline written by Pulse.
2. **At a glance**: visitors, chats with Atlas, avatar minutes, cloud spend
   (with month-end forecast). Each card has a delta vs the previous 4 days.
3. **How people talk to Atlas**: a stacked bar by mode (text, voice, avatar,
   live call), chats, turns, minutes spoken and median time to first word per
   mode, and how often visitors talked over the avatar.
4. **What they asked**: top questions, then Pulse's themes and standout
   questions.
5. **What they explored**: top pages by name (labs, Live Agents), traffic
   sources (LinkedIn, Google, direct; same-site navigation excluded), top
   locations.
6. **Reach**: top 3 LinkedIn posts by engagement, titled from `posts.json`,
   and how many resumes and notes Atlas sent.
7. **Health**: errors, failed emails and injection attempts. When there are
   none it collapses to one green "All clear" line. Off-topic declines, rate
   limits and the fallback-model share appear as a muted line.
8. **Cost watch** (spec 83):
   - month-to-date against the budget;
   - forecast at the last 7 days' run-rate, so a step change shows within
     days;
   - top services, week-over-week movers;
   - any Cloud Run service at min-instances > 0 that isn't atlas (read
     straight from the Cloud Run API, so it works even without billing data);
   - a stale-export notice;
   - in the first email of the month, a nudge to run `/cost-optimizer`.
9. **One thing to do**: Pulse's confidence-scored action card. It can now be
   about cost or health, not only the corpus.

The subject carries the numbers, e.g. `Pulse · 150 visitors · 5 avatar chats ·
₹312 this month`.

Removed: downloads (all-time, window and the conversion-gap observation), and
the static per-token cost estimate (`_PRICE_OUT` and friends), now replaced by
real billing.

## Visuals (added after the first review)

Gaurav asked for a map and more charts. Gmail strips SVG and CSS gradients, so
the map, the donuts and the line charts are PNGs from `app/app_utils/charts.py`
(matplotlib, drawn at 2x). They are attached inline with a Content-ID
(`resend-mcp` 2.16 `send-email` takes `attachments[{content, contentType,
contentId}]`) and referenced as `cid:` in the HTML, with alt text that states
the numbers. Bars, the funnel and the heatmap stay HTML. Every chart returns
None on no data or any error, and its section falls back to HTML.

- **Visitor map**, last 30 days:
  - world bubbles by city, sized by visitors, coloured where someone chatted
    with Atlas;
  - a zoomed India inset with state lines;
  - a top-cities list with a colour key.
  Boundaries are Natural Earth's **India point-of-view** variant, and state
  lines are clipped to it (`app/assets/geo/build_geo.py` rebuilds both).
  Points come from `page_views.latitude/longitude` (Cloudflare `request.cf`,
  rounded to 0.1°). Older rows use the country centroid.
- **Country split** (HTML bar with flags), last 4 days.
- **14-day trend**: visitors as columns, Atlas chats as a line.
- **Modes donut** plus **TTFT** (median time to first token or spoken word)
  per mode as bars against a 1.5s target.
- **When they visit**: a 24-hour IST heatmap with India-day vs US-day shares.
- **Journey** funnel: visited, chatted, avatar or live call, resume or note.
- **Cost watch**: spend pace (cumulative vs budget line vs dashed forecast)
  and a spend-by-service donut.
- **Website speed** line in Health: mobile Lighthouse score, LCP, FCP, TBT,
  CLS.

The HTML stays under 31 KB with every section filled, far below Gmail's
~102 KB clip, and images don't count toward that limit.

## Reporting period

One period for everything about visitors and Atlas: **since the last report**.
Pulse runs Mon and Thu 08:00 IST, so Monday covers Thu 08:00 → Mon 08:00
(4 days) and Thursday covers Mon 08:00 → Thu 08:00 (3 days).
- Consecutive reports tile, with no overlap and no gap. The old fixed 4-day
  window double-counted Sunday and Monday in Thursday's report.
- The comparison is **the same days one week earlier**, like for like across
  3- and 4-day periods.
- The map, top cities, countries, heatmap, journey, modes and questions all
  use the period. Before this they mixed 4 and 30 days.
- Two deliberate exceptions, each labelled: the 14-day trend ("for context,
  beyond this period") and cost ("this month", because budgets and invoices
  are monthly).

How it works:
- `report_period()` in `ambient_data.py` computes the period.
- The Worker's `/api/ambient/stats` and `/api/ambient/interactions` take
  `from`/`to`/`prev_from`/`prev_to`, with `days` still as the fallback.
  `reportWindow()` in `backend/src/digest.js` caps spans at 31 days and
  rejects future ends.
- Every query is bounded `> from AND <= to`.

The header names the report and its period: **Gauravlahoti.dev Weekly
Pulse**, "Every Monday and Thursday, 08:00 IST", the period with its start
and end time, and what it's compared with.

## Cost sources

Cost watch covers more than the GCP bill. "Where the money goes" lists:
- **Google Cloud infrastructure** (`gcp-experiments`), actual, from the
  billing export.
- **Gemini and the avatar** (`adk-deploy-trail`, billed to an account the
  export can't read), estimated from Atlas's own month-to-date usage
  (`usage_mtd`: tokens per model and avatar seconds). Priced per model from
  the Gemini API pricing page, checked 2026-10-02:
  - 3.6, 3.7 and 3.8 Flash: $0.75 input / $3.75 output per 1M, thinking
    included, through 2026-12-31, doubling from 2027-01-01;
  - the avatar at Atlas's own per-second rate.
  Converted at the billing export's own `currency_conversion_rate`.
- **Cloudflare, Resend and GitHub Pages**: free tier, ₹0.
- A total, and what isn't counted yet: voice transcription and speech, eval
  runs.

Cloud Run is one line on the bill, so it is **split by service** (atlas,
pulse, …) by each one's billable instance-hours this month from Cloud
Monitoring. The donut legend shows ₹ and % for each part, and slivers under 1%
fold into Other.

Finding along the way: the Worker's blended token rate for
`daily_stats.cost_usd` ($0.15 / $0.60 per 1M) understates today's Gemini 3.x
Flash pricing about 5-6×. It isn't changed here, because it's a historical
rollup, but the digest no longer uses it.

## Later review changes

- **No headline.** The header ends at the period lines. The TL;DR does that
  job, and its first bullet is still the inbox preview. Pulse no longer
  writes one, and `send_review_email(tldr, themes_html, recommendations)` no
  longer takes it.
- **Free tiers and free credits stay out of the total.**
  - Cloudflare, Resend and GitHub Pages move to a note under the table:
    "Free tier, not in the total".
  - The Gemini and avatar row still shows its list-price estimate, but
    `adk-deploy-trail` runs on free credits today. The row says so, and
    "Total charged so far this month" is the infrastructure bill only. Set
    `PULSE_MODELS_BILLED=1` on Pulse when that project starts billing, and it
    counts.
  - "About this report" says the same about Pulse's own run cost.
- The AI tag reads "✦ Powered by <model that answered>", and the header has
  none.

## What's AI and what it costs

Four parts are written by Gemini. Each carries a "✦ Gemini 3.8 Flash" tag, a
label taken from the model that actually answered:
- the headline;
- the TL;DR (only when Pulse wrote it; the number-built fallback has no tag);
- the conversation themes;
- the recommendations.

An **About this report** block at the end says that everything else is
computed from data, with no AI. It also gives **this run's own cost**, from
ADK's per-event usage metadata for the current invocation: model calls, input
tokens, output tokens (and how many were thinking), and dollars (plus rupees
once billing is connected). A live run cost $0.072: 2 calls, 14k in, 16.5k
out, of which 15.4k was thinking. That's about ₹50 a month at two reports a
week.

**Safety net:**
- One live run ended at MAX_TOKENS: the model wrote its reasoning as visible
  text and never called the send tool.
- Fixes:
  - the instruction now keeps reasoning private;
  - `max_output_tokens` went from 16k to 32k;
  - if a run ends without sending, `api.py` sends the numbers-only digest
    (`send_numbers_only`, with a note saying why) and reports
    `email_failure: agent_did_not_send`, so the scheduler goes red.

## Delivery fix (first production run)

The first real run failed with `413 Request Entity Too Large` from
resend-mcp-server:
- the five charts, base64-encoded, made the send request about 430 KB;
- `resend-mcp` builds its HTTP app with `@modelcontextprotocol/express`, which
  calls `express.json()` with no limit, so Express's 100 KB default applied;
- the library's `jsonLimit` option isn't passed through by `resend-mcp`.

Two fixes:
- `resend_mcp_server/mcp-body-limit.cjs`, preloaded with `node --require` into
  the MCP child process by `server.js`, wraps `express.json()` with a 5 MB
  default (`MCP_JSON_LIMIT`). It is our code, not a patch to `node_modules`.
  Verified locally: a 500 KB request went from 413 to reaching the auth check.
- Pulse's `_send_with_fallback()`: if a send with charts fails, it rebuilds the
  email image-free (`build_email(charts_on=False)`, every section as HTML) and
  sends that. The email isn't lost if the limit ever comes back.

## TL;DR

Three plain-text bullets right under the header, so the email can be read in
five seconds:
1. what happened with visitors and conversations;
2. the one thing that needs Gaurav, from the top recommendation;
3. health and spend.

Pulse writes them last, once its recommendations are settled.
`clean_tldr()` strips HTML and keeps three. If the agent gives none,
`fallback_tldr()` builds them from the numbers, so the summary is never
missing. The first bullet is also a hidden preheader, which Gmail and Apple
Mail show as the inbox preview next to the subject.

Live run on real data: "Conversations surged to 74 across 53 visitors…" /
"Set an expected consulting turnaround time in your profile…" / "Atlas ran
reliably…, but GCP billing and PageSpeed audits were disabled by missing
credentials."

## Recommendations (Gemini 3.8 Flash)

The single action card became **Recommendations**: two to four, most valuable
first, across agents, website and cost. Each has:
- problem, with the evidence;
- the concrete action;
- a **tangible** benefit, which must carry a number from the tools with its
  arithmetic;
- an **intangible** benefit (visitor trust, Gaurav's time, reliability);
- effort and confidence.

They come from the agent as a typed list (a Pydantic `Recommendation`, so the
function declaration carries enums and required fields), and
`clean_recommendations()` validates them. They render as text only, so the
model never writes HTML for them.

- Model: `gemini-3.8-flash`, falling back to `3.7-flash` then `3.6-flash`. All
  three IDs were verified callable on `adk-deploy-trail` on 2026-10-02.
  Thinking level is HIGH, since nobody waits on this run.
- New tools for evidence:
  - `get_site_performance()`: a mobile Lighthouse run via the PageSpeed
    Insights API, called with Pulse's own identity.
  - `get_recent_changes()`: the last 3 weeks of commits on `main`, so it
    doesn't recommend what already shipped.
  Both results are cached for one run, failures included.
- The instruction carries a short "how the site is built" block. A live run
  had blamed the Cloudflare Worker for Atlas's rate limits, which live in
  Atlas.
- Never invent facts about Gaurav: an action that needs one says "decide X,
  then add it".

Three live dry runs on real data, with the email captured, not sent:
- **Run 1:** recommended two already-shipped fixes and invented a 24 to 48
  hour response time.
- **Run 2**, after adding the recent-changes tool and the never-invent rule:
  no shipped fixes, every tangible benefit numeric, but it blamed the Worker
  for Atlas's rate limits.
- **Run 3**, with the architecture block: three grounded recommendations, each
  naming the right component.

One limit: a fix is only recognised if its commit title describes it.

## Data

- **Atlas audit row** (`agents/atlas/app/api.py`, all four log sites) gains:
  - `replyMode` (`text`/`voice`/`avatar`/`convo`);
  - `avatarSeconds` (spoken seconds, billed per second);
  - `firstMs` (first token for text and voice, first word for the avatar).
    `latencyMs` keeps its old meaning (whole turn for text), so history stays
    comparable.
- **D1 migration 013** adds `reply_mode`, `avatar_seconds` and `first_ms`.
  Older rows infer their mode from `model` (the Live model means avatar).
- **`backend/src/digest.js`** holds the new stats queries and the field
  validator. Both the Worker and `local-server.js` import it, so the two can't
  drift. `GET /api/ambient/stats` gains `modes`, `prev_modes`, `statuses`,
  `top_pages`, `top_referrers`, `emails`, `fallback` and `top_posts`, and
  loses `downloads`.
- **`GET /api/gcp-cost?view=digest`** returns net cost (after credits) for
  Google's Pacific billing day: month-to-date by service, daily totals,
  week-over-week by service, and the export's latest timestamp.
- **Pulse** gains tools `get_visitor_stats` and `get_cost_summary` as
  context, and `send_review_email(headline, themes_html, action_html)`. The
  cost maths (`summarize_costs`) is a pure function with its own test.

## Deploy order

Each hop tolerates the next one being old:
1. Migration: `cd backend && npx wrangler d1 migrations apply resume-leads --remote`.
2. Worker: `npx wrangler deploy` (accepts the new fields, serves the new stats).
3. Enable PageSpeed Insights for Pulse's website speed check:
   `gcloud services enable pagespeedonline.googleapis.com --project gcp-experiments-490306`.
   Without it, that section and tool report "unavailable".
4. Cost token, so Pulse can call `/api/gcp-cost`:
   - `T=$(openssl rand -hex 32)`;
   - `printf %s "$T" | npx wrangler secret put COST_MONITOR_TOKEN`;
   - `printf %s "$T" | gcloud secrets create cost-monitor-token --data-file=- --project gcp-experiments-490306`.
5. Atlas: `make corpus && make deploy` (starts sending the new fields).
6. Pulse: `make deploy`. Its `--set-secrets` now includes
   `COST_MONITOR_TOKEN=cost-monitor-token:latest`, so step 4 must come first.
7. `/run-ambient-digest` for one real email. Check it in Gmail web, Gmail on
   a phone and Apple Mail: the charts should show inline with no "display
   images" prompt.

## Definition of done

- [x] `agents/pulse`: 33 unit tests. They add: TL;DR, header and period (tiling Mon/Thu), no fixed-window labels, cost sources and the Cloud Run split, run-cost tally, and the never-sent fallback.
      - v2 email: every section renders, empty sections hide, no "download"
        anywhere, the subject, cost unavailable still flags an always-on
        service, atlas isn't flagged, the forecast uses the recent run-rate.
      - Images: every `cid:` has an attachment and alt text, and a failed chart
        falls back to HTML.
      - Recommendations are validated and escaped, and the PageSpeed summary
        is parsed.
      - Charts (`test_charts.py`): PNGs, None when empty, centroid fallback,
        Indian cities inside the inset.
- [x] Three live `gemini-3.8-flash` dry runs on real data (above).
- [x] `agents/atlas`: 373 unit tests (new: the avatar audit row carries mode,
      seconds and first word). Run with `CORPUS_LIVE_BASE` pointing at the local
      snapshot, because the build-story test reads the live site until this
      merges.
- [x] `digest.js` queries run against a SQLite database built from
      `schema.sql` with fixture rows: modes, the pre-013 avatar inference,
      same-site referrers excluded, and window boundaries all correct.
- [x] Rendered from fixture data, with all charts, and screenshotted at
      desktop width and inside a 375px frame. Nothing overflows.
- [x] `digest.js` map, daily, hours and funnel queries checked against SQLite,
      including the 23:59 / 00:01 IST day and hour boundary and a pre-013 row
      with no coordinates.
- [ ] Deployed in the order above, and one real digest received and checked in
      Gmail on desktop and phone.

Also fixed here: spec 82's new build-story sentence contained "D1" and "two
clouds". Spec 61's no-counts rule forbids both, and its test caught them once
the live site served the new text. Reworded without a digit or a count word.
