# Spec 82: Avatar launch-night fixes

The avatar went live to the audience on 2026-09-30 (`atlas-00070-nf6`). A review
of the first 14 hours (Cloud Run logs plus the D1 audit log) found two real
visitors (Bengaluru, Android; New Delhi, Mac), 14 avatar turns, no errors and a
median first word of ~1.3s. It also found the problems below. Ordered by how
much each one hid from us.

## 1. Four statuses never reached the audit log

`POST /api/agent-log` accepted `ok`, `error`, `injection_blocked`, `too_long`
and `rate_limited`. Atlas also writes `scope_blocked` (text mode, off-topic),
`injection` (live conversation), `interrupted` (live conversation, talked
over) and `cancelled` (push-to-talk). Each of those got a `400 Invalid status`
and was dropped. Launch night showed it once
(`audit-log post failed: 400 {"ok":false,"error":"Invalid status"}`), but it
has been true for every off-topic or injection attempt since those statuses
were added.

**Fix:** the Worker and `local-server.js` accept all nine. The three digest
error counts (`daily_stats` rollup, `/api/ambient/stats` totals and its error
list) now count `status NOT IN ('ok', 'interrupted', 'cancelled')` instead of
`!= 'ok'`. A visitor talking over the avatar isn't a failure. `scope_blocked`
and `injection` count the same way `injection_blocked` and `too_long` always
have.

## 2. Barged-in push-to-talk turns were logged `ok`

Two launch-night answers stopped mid-sentence ("...Fiber Broadband Fabric on
GCP for a major"). Both were logged `status=ok`, which made it look like the
avatar was cutting itself off. Six live Vertex reruns of the same questions
gave complete answers every time. The request logs show why: each time, the
visitor started their next voice recording within about a second of the
answer stopping (a transcribe call landing 7s and 28s later). They talked over
it.

Barge-in sends `{"abort": true}`. `agent-chat-ws` then calls `aclose()` on the
turn's generator, which raises `GeneratorExit` at a `yield` in
`_live_avatar_stream`. Neither `except CancelledError` nor `except Exception`
catches that, so the `finally` logged the turn as `ok`.

**Fix:** `except GeneratorExit` sets `status = "interrupted"` and re-raises.

## 3. The spoken answer lost the space between filler and answer

The audit row read "explore further?You can choose". `LiveConversation`
already joined transcript chunks with `_append_spoken`, but `LiveBrainTurn`
appended them raw. It now uses `_append_spoken` too. This is cosmetic: the
browser gets the words as separate events.

## 4. "Built on GCP and Claude?" got "Cloudflare, rather than GCP"

`build-story.json`'s summary said "the Cloudflare backend, and the agents
running on it", which reads as if the agents run on Cloudflare. The summary is
the whole bare `get_build_story` answer, so the avatar repeated it. It now
gets its own sentence on where each part runs: GitHub Pages, a Cloudflare
Worker with D1 for logs and analytics, and the agents on Google Cloud (ADK,
Cloud Run, Gemini on Vertex). It also says Claude Code is the tool he built it
with. The speech prompt adds: where each part runs comes only from that
summary; never guess a platform. The text agent reads the same corpus, so it
gets the fix too.

## 5. "I want to explore RAG" got "it's linked from the AI Labs page"

Both visitors asked to explore RAG and were told to go find a link. The
hands-on lab is off-site, but its agent card on the Live Agents page is
on-site and links to it ("Try it yourself"). The prompt also said flatly that
the lab "can't open here".

**Fix:** in `ToolDispatcher._show`, `show_on_site("rag-lab")` now opens
`agent:agentic-rag`, telling the model the hands-on lab is linked from that
card. This is deterministic, not a prompt hope, and needs no second tool call
(the prompt allows one opening per turn). `OFF_SITE` is now a redirect map.
The prompt counts "explore" as an ask to open, with "I want to explore RAG"
as the example.

## 6. Two smaller prompt gaps

- "Yes, I'd like to explore a specific agent" got "Which specific agent would
  you like to explore?" with no options, so the visitor had to ask "what
  agents do you have?". Rule added: when the visitor has to choose, name the
  choices in that same sentence.
- One of seven live reruns of "Tell me about his projects. What are the
  certifications he holds?" fetched only projects first and said "There are
  no certifications listed", then corrected itself in a second reply. That's
  a false denial the prompt already forbids. Rule added: for a two-part
  question, call the tools for both parts together, in the first call.

## 7. Live conversation turns had no geo

Push-to-talk turns carried city and country, but hands-free conversation turns
passed `None`. `agent_live` now starts one `lookup_geo` per conversation and
every turn's audit row awaits it.

## Not in scope

- A text-mode turn the visitor stops is never logged at all (its audit write
  sits after the stream, not in a `finally`). That's older and separate.
- Live conversation check-ins have an empty `question`, so the Worker rejects
  them as `Invalid question`. They aren't visitor turns, so that's left alone.

## Definition of done

- [x] `uv run pytest tests/unit` (372) passes, including new tests:
      `test_a_barge_in_is_logged_as_interrupted` (fails on the pre-fix code),
      `test_a_finished_turn_is_still_ok`, the joined-transcript assertion in
      `test_filler_then_tool_then_answer`,
      `test_the_off_site_lab_opens_its_agent_card`, and four new
      `TestSpeechInstruction` rules.
- [x] `node --test 'tests/**/*.test.mjs'` (19) passes.
- [x] Live Vertex check, 2/2 each: "I want to explore RAG" opens
      `agent:agentic-rag`; "built on GCP and Claude?" puts the agents on
      Google Cloud; a bare "which one?" names the choices. The two-part
      certifications question answered correctly 3/3 with no denial.
- [ ] Worker deployed, then a `status: "interrupted"` row is accepted (200)
      by `/api/agent-log`.
- [ ] Atlas redeployed (`make corpus` first), Pages deployed for
      `build-story.json`.
