# Spec: Honest Visitor Counts

## Overview

The Pulse email for 23–26 Nov 2026 said "19 visitors", but the map showed only two cities: Delhi (17) and Singapore (2). The numbers add up, but they don't count people. Every visitor figure is `COUNT(DISTINCT visitor_hash)`, where `visitor_hash = sha256(ip|ua|UTC_date)` (`backend/src/index.js:1342`). So one person turns into several "visitors" whenever any of these changes:

1. **The UTC date.** A Mon 08:00 → Thu 08:00 IST report spans 4 UTC dates, so a daily repeat visitor counts up to 4 times.
2. **The full IP.** Indian mobile carriers use CGNAT and rotating IPv6 privacy addresses, and switching between Wi-Fi and mobile data changes the IP too.
3. **The exact UA string.** A browser auto-update partway through the week splits one person into two.

On top of that, Gaurav's own visits and Atlas test chats from Delhi count as visitor traffic.

This spec makes the number mean roughly "people this report period". It does that by keying the hash on a **report-week salt**, a **coarse IP prefix** and a **normalized UA**. It also lets the owner leave out their own traffic, and labels the figure honestly in the email. The design stays cookieless: no raw IP is stored and nothing persists on the visitor's device. The one exception is the owner's own opt-in flag.

## Depends on

- Spec 33: self-hosted analytics (`page_views`, beacon)
- Spec 84: Pulse v2 (digest data, map, KPI tiles)
- Spec 98: widget funnel beacon (`widget_events`, which shares the hash today)
- `daily_stats` rollup (migration 010, `.claude/docs/backend.md`)

## Routes

No new routes. Behaviour changes on existing Worker routes:

- `POST /api/pageview`: new `visitor_hash` derivation. Drops owner sessions at ingest.
- `POST /api/widget-event`: drops owner sessions at ingest. **Keeps its current daily full-IP hash** for the rate cap. A /24 prefix would let one office NAT trip the 60/day cap for everyone behind it.
- Digest / stats endpoints (`backend/src/digest.js`, the window/prev/all-time queries in `index.js` ~1170–1230): exclude owner sessions from chat counts.

## Database changes

No schema change, so no migration. The column means something different from the cutover onward:

- `page_views.visitor_hash` becomes week-scoped. Rows from before the cutover keep their daily meaning. Both are 16-hex strings, so they never collide in a meaningful way.
- `daily_stats.unique_visitors` stays a per-UTC-day distinct count, which is still correct for one day. **Summing it across days is no longer exact.** A hash can now appear on several days, so the sum is "visitor-days". Update the comment in the rollup code and the "exact to sum" paragraph in `.claude/docs/backend.md` to say so.

## Design

### 1. Visitor key (Worker + local server)

```
period   = floor((now_utc - ANCHOR) / 7d)      // ANCHOR = a Monday 02:30 UTC (= Mon 08:00 IST)
ipKey    = IPv4 → first 3 octets (/24); IPv6 → first 3 hextets (/48)
uaKey    = browser family + major platform (e.g. "chrome|android", "safari|ios"); no versions
visitor_hash = sha256(`${VISITOR_HASH_SECRET}|${period}|${ipKey}|${uaKey}`).slice(0, 16)
```

- **Why the period starts at Mon 08:00 IST:** Pulse reports run Mon and Thu at 08:00 IST. With the salt rotating at that same moment, each report window sits inside a single period, so a repeat visitor counts once per report. The Thu → Mon window still fits inside the Mon → Mon period.
- **Why add a secret:** with only a /24 and a coarse UA, the hash input space is small enough to brute-force. `VISITOR_HASH_SECRET` is a wrangler secret, so a leaked D1 dump can't be reversed to a network. Locally, fall back to a fixed dev string.
- Put `visitorKey(request, now)` and the UA normalizer in their own module, `backend/src/visitor-key.js`, so they can be unit-tested. `local-server.js` imports the same logic, or mirrors it with a comment pointing at the source.
- **Known limits, to state in the docs:** phone and laptop are still two visitors, and two people on the same /24 with the same browser and OS collapse into one. That's an acceptable trade for a single-person site's digest.

### 2. Owner exclusion

- New module `assets/js/owner.js`:
  - `?owner=1` on any page sets `localStorage["gl_owner"] = "1"`. `?owner=0` clears it. Wrap both in try/catch, because storage can throw.
  - `isOwner()` returns the flag.
  - `tagSessionId(id)` returns `owner-${id}` when the flag is set, otherwise `id` unchanged.
- Every place that mints a session id wraps it with `tagSessionId`: `main.js uuidv4()` caller, `agent-widget.js newSessionId()`, `agents-page.js`, `insight-atlas.js`. The prefix adds 6 chars to a 36-char UUID, which stays under the Worker's 64-char check (`index.js:426`). **Verify Atlas (`agents/atlas/app/api.py`) does not reject non-UUID session ids** before relying on this. If it does, relax that check in a separate atlas deploy.
- **Worker ingest:** `/api/pageview` and `/api/widget-event` return 204 without inserting when `sessionId` starts with `owner-`.
- **Chats are kept, but not counted.** `agent_interactions` rows for owner sessions are still written, because the transcripts are useful for debugging Atlas. Every *count* query adds `session_id NOT LIKE 'owner-%'`: digest.js chat/mode/geo/day queries, the window/prev/all-time blocks, the `daily_stats` rollup's conversations/turns/tokens, and the public `/api/agent-stats` badge. Define the fragment once (e.g. `NOT_OWNER`, like `NOT_AN_ERROR`) and reuse it.
- **Owner transcripts in the digest:** `get_recent_interactions()` (Pulse's question list) also skips owner sessions, so test chats don't show up as "a visitor asked…" insights. That's the bug behind the TL;DR's "a visitor asked for the resume but dropped off" line if that visitor was the owner.
- Show a small, unobtrusive owner indicator so the owner knows the flag is on: `console.info("[owner] analytics off for this browser")` on boot. Add no visible UI.

### 3. Honest labelling in the email (`agents/pulse/app/app_utils/ambient_send.py`)

- The KPI tile stays "Visitors". Add a muted footnote line under the KPI row: "Visitors are estimated: one per device and network for the report week. Your own visits are excluded." Follow the voice rules: no em-dash, plain words.
- **Cutover guard:** the first report after deploy compares a new-hash window against an old-hash previous window, which would show a fake drop. If the previous window starts before the cutover timestamp (a `VISITOR_HASH_V2_SINCE` constant in the digest payload, or a field the Worker returns), suppress the visitor delta, and show "new method" in place of the ▲/▼.
- The subject line keeps `N visitors`, now with the honest value.

## Templates

- **Create:** `backend/src/visitor-key.js`, `assets/js/owner.js`, unit tests (below)
- **Modify:** see Files to change

## Files to change

| File | Change |
|------|--------|
| `backend/src/index.js` | `handlePageview` uses `visitorKey()`; owner drop in pageview + widget-event; `NOT_OWNER` in rollup, window/prev/all-time, agent-stats; return `visitor_hash_since` for the cutover guard; update the rollup comment about summing |
| `backend/src/digest.js` | `NOT_OWNER` in every `agent_interactions` count and in `chattedSessions`; owner sessions out of the recent-interactions list |
| `backend/local-server.js` | Mirror the new key, the owner drop and the filters |
| `backend/wrangler.toml` | Document the `VISITOR_HASH_SECRET` secret (set via `wrangler secret put`, never committed) |
| `assets/js/main.js` | Import `owner.js`; wrap the page session id; bump `ASSET_VERSION` |
| `assets/js/agent-widget.js`, `agents-page.js`, `insight-atlas.js` | Wrap minted session ids with `tagSessionId` |
| `index.html` + standalone pages + `scripts/gen-post-pages.mjs` (if they pin `?v=`) | Cache-bust bumps for changed JS |
| `agents/pulse/app/app_utils/ambient_send.py` | Footnote under KPIs; cutover guard on the visitor delta |
| `agents/pulse/app/ambient_agent.py` | Prompt line: visitors are a per-week estimate; never call one question "a visitor" if it can't be sure (optional, light touch) |
| `.claude/docs/backend.md` | New hash definition, owner policy, "sum across days = visitor-days" correction, known limits. Leave `backend/migrations/006-page-views.sql` alone: migrations are history |

## Files to create

- `backend/src/visitor-key.js`: `ipPrefix(ip)`, `uaFamily(ua)`, `reportPeriod(nowSec)`, `visitorKey({ ip, ua, now, secret })`
- `backend/test/visitor-key.test.mjs` (Node built-in runner, no deps): IPv4/IPv6 prefixing, UA normalization across Chrome version bumps, the period boundary at Mon 02:30 UTC, same inputs giving the same hash, a different secret giving a different hash
- `assets/js/owner.js`
- `tests/owner.test.mjs`: `tagSessionId` with the flag on and off, with storage throwing
- `agents/pulse/tests/unit/test_visitor_footnote.py`: footnote rendered; delta suppressed across the cutover

## New dependencies

No new dependencies.

## Rules for implementation

- All identity content lives in `content/profile.json`.
- CSS variables only. Never hardcode hex. (Email HTML keeps its existing inline palette constants in `ambient_send.py`.)
- One JS module per visualization; lazy-load on viewport entry.
- No npm, no bundler, no Node toolchain for the site. Tests use `node --test` only.
- Respect `prefers-reduced-motion` (nothing animated here).
- Mobile fallbacks for every WebGL/Three.js feature (none here).
- Never store a raw IP or the full IP in `page_views`. The secret never reaches the frontend or the repo.
- Don't change the `widget_events` rate-cap hash (see Routes).
- Specs are append-only: don't edit specs 33 / 84 / 98.
- Deploy order: set `VISITOR_HASH_SECRET` → deploy the Worker → publish the site (owner tagging) → deploy Pulse. Pulse must tolerate a Worker that doesn't yet return the cutover field.

## Definition of done

- [ ] `node --test 'tests/**/*.test.mjs'` and `node --test 'backend/test/**/*.test.mjs'` pass; Pulse unit tests pass.
- [ ] Local server: load the site 3 times across a simulated UTC midnight from the same browser. `page_views` shows **one** distinct `visitor_hash` for the period (it was 2 before).
- [ ] Local server: change the last IPv4 octet (same /24) and the UA's Chrome minor version. Still the same hash.
- [ ] Open `/?owner=1`, browse two pages and ask Atlas a question. No new `page_views` / `widget_events` rows. The `agent_interactions` row exists with an `owner-` session id. The digest's chat count, geo and recent-interaction list don't include it.
- [ ] `/?owner=0` clears the flag, and the next load is counted again.
- [ ] Atlas accepts an `owner-<uuid>` session id (text, voice and avatar paths).
- [ ] `/api/agent-stats` public badge does not count owner chats.
- [ ] An ad-hoc Pulse run (`/run-ambient-digest`) shows the footnote, a visitor total equal to the sum of the city counts at most, and "new method" in place of a delta for the first post-cutover report.
- [ ] `.claude/docs/backend.md` describes the new hash, its limits, the owner policy and the visitor-days caveat for `daily_stats`.
- [ ] No raw IP, IP prefix or secret appears in any D1 column or log line added by this spec.
