# Spec 62 — Seamless spoken replies on long answers

## Problem

Asking Atlas "share what we built with these credentials specifically and how"
produced a ~190-word reply with four section headers. Spoken, it stuttered:
audible dead air and prosody resets that got worse the longer the answer ran.

Two independent causes, both length-dependent, which is why short answers
sounded fine and nobody caught this in smoke tests.

### 1. The reply should never have been that long

`get_build_story()` returned 15 `{label, detail}` objects across four sections.
The model mirrored that structure straight into the reply — `method[3].label`
"A reviewer agent gates the work" came back as the heading "Reviewer agent
gating". The tool handed over an outline, so the model wrote an outline.

That broke three rules the prompt already stated: 2-4 sentences, ≤120 words,
and no topic headers. Header lines also carry no terminal punctuation, so
`findSplit()` can't treat them as sentence ends and falls through to its
clause/word fallback — unnatural breaks, and the TTS model reads the heading
glued onto the next sentence.

Length is quota, too. The `speak` bucket is 60/24h charged per chunk, so a
reply like that burns ~10 and leaves roughly six spoken replies a day before
chunks start 429-ing and going silently unspoken mid-answer.

### 2. `runwaySec()` could not see its own pipeline

`drain()` holds text back to fill a chunk (better prosody) only while there is
runway to spare:

```js
if (!final && !starving() && buffer.length < limit
    && runwaySec() > synthCostSec(limit) + RUNWAY_MARGIN_S) break;
```

`runwaySec()` summed scheduled audio plus `pending` characters. But `produce()`
**shifts a chunk off `pending`** when it dispatches it, and the result isn't
decoded yet either, so a chunk in flight counted for nothing in either term.
With `LOOKAHEAD = 3` that is up to three chunks — easily 40 seconds of real
audio — invisible to the estimate.

So the predicate read near-famine exactly when the pipeline was busiest,
concluded it was about to starve, and emitted at the first boundary it could
find. Not a tuning problem. An accounting one.

### 3. The chunk ramp broke its own rule

`CHUNK_RAMP = [24, 140, 240, 350]`. The file states the constraint plainly —
chunk N+1 must synthesize faster than chunk N plays — and then violates it in
the second step. A 24-char opener plays for ~1.6s; a 140-char follow-up takes
~7.6s to synthesize. The listener reliably heard the opening words and then
four seconds of nothing, every single time, on every reply.

### 4. Clip edges were never trimmed

Each chunk's WAV kept whatever leading and trailing silence the model emitted.
The browser butts clips together sample-accurately, but sample-accurate is not
silence-accurate, so that dead air accumulated at every seam.

## Decision

Fix the generation side and the delivery side. Deliberately **not** in scope:
`streamingSynthesize` (spec 50's deferred item, still the architecturally
correct end state), and raising the speak quota — shorter replies halve that
spend on their own.

## Changes

**`agents/atlas/app/tools.py`** — `get_build_story(section=None)`, reusing the
`get_live_agents(agent_name=...)` idiom already in the file. Bare call returns
`summary`, `sourceUrl` and the `sections` names; a named section adds that
one section's items. Unknown section falls back to the summary form. No change
to `content/build-story.json`, so there is no live-corpus/prompt ordering
hazard of the kind spec 61 had to sequence around.

**`agents/atlas/app/instruction.py`**
- New style rule: a tool result's `label`/`detail` shape is source material,
  not an outline. Never promote a `label` to a heading or give each item its
  own paragraph.
- Build-story routing: call it bare, pass `section=` only on a depth
  follow-up, never twice in a turn.
- Example 11c: the exact question from the report, answered in four sentences
  of prose off one `section="method"` call.
- Removed two leftovers spec 61 missed — the tool list and the topic guidance
  both still promised "the real counts behind it" and told the model that
  "substance" meant the counts, against a corpus that no longer has any.

**`assets/js/agent-speech.js`**
- `inFlightChars` tracked and counted in `runwaySec()`.
- `synthCostSec` becomes `0.36 + 0.0521·chars` — a line with an intercept
  rather than a bare ratio. The old form underestimated every chunk by
  ~0.4-0.5s and, worse, priced a tiny chunk as nearly free. It is not: a
  25-char fragment still pays a whole round trip and a whole model invocation.
- `CHUNK_RAMP` retuned to `[70, 120, 200, 300, 350]`.
- `EMIT_FLOOR` (140, applied as `min(floor, limit·0.6)`): once drain() gives up
  on filling a chunk it still won't emit a fragment, unless this is the opener,
  the final flush, or playback has genuinely run dry.

**`agents/atlas/app/app_utils/speak.py`** — `normalize_edges()` strips leading
silence to a 20ms guard and replaces the trailing silence with a fixed 120ms
pause. Normalized rather than removed: chunks break at sentence boundaries,
where a speaker would pause anyway, so cutting the tail to zero sounds hurried.

**`assets/js/agent-widget.js`** — two architecture tooltips still described
spec 49's behaviour ("runs after the reply streams"). Synthesis starts
mid-stream.

## Measurements

From `tests/agent-speech.chunker.test.mjs`, ~1,200-char reply, worst gap
between consecutive clips:

| Ramp | First audio | Worst gap | Worst gap @1.4x latency |
|---|---|---|---|
| `[24, 140, 240, 350]` (old) | 2.75s | 4.11s | 6.07s |
| `[70, 120, 200, 300, 350]` | 3.88s | 0.83s | 2.04s |

Chunk sizes went from `[34, 128, 170, 144, 306, 311, 75]` to
`[52, 110, 170, 226, 302, 309]` — climbing rather than sawtoothing, and one
fewer rate-limited call. The trade is ~1.1s more before the first spoken word
for the removal of a four-second hole mid-sentence. That is the right way
round: text is already on screen the instant it streams (spec 57), so the
voice starting a beat later costs the visitor nothing they can see.

Zero gap is reachable (`[45, 85, 155, 255, 350]` measured 0.00s) but only by
fragmenting the opening into 29-char clips and pushing first audio on *short*
replies out to 5.0s. Short replies are the common case, so that trade was
rejected.

## Definition of done

- [x] `get_build_story()` bare returns no `detail` prose; `section=` returns one section
- [x] Prompt carries the no-outline rule, the routing, and Example 11c
- [x] `runwaySec()` counts in-flight characters
- [x] Ramp retuned with measurements recorded in-file
- [x] `normalize_edges()` wired into `speak_text`
- [x] `uv run pytest tests/unit tests/integration` (2 pre-existing integration failures, see below)
- [x] `node --test tests/agent-speech.chunker.test.mjs` — 7 passing, and verified failing against the pre-fix code
- [ ] **Blocked:** live verification of both the reply shape and the audio

## Blocked on a production outage

Billing is disabled on the `adk-mas-demo` GCP project
(`gcloud beta billing projects describe adk-mas-demo` → `billingEnabled: False`),
so every Vertex call 403s with `BILLING_DISABLED`. As of this spec:

- `POST /api/agent-speak` → 502, no audio at all
- `POST /api/agent-chat` → the "something went wrong on my end" fallback
- the two integration tests that call a live model fail — **pre-existing**,
  reproduced on an unmodified tree before any change here

So Atlas is entirely down in production, not just its voice, and none of this
spec's work can be verified against a real model until billing is restored.
Nothing here was deployed.

Two related findings, both left alone deliberately:

- `GET /api/agent-chat/warm` reports `speakReady: true` while synthesis is
  impossible, because `warm()` only fetches ADC credentials and builds the
  HTTP client — it never makes a synthesis call. The speaker UI therefore
  offers itself as available during a total TTS outage.
- `speak.py`'s model cascade fires on 404/429/503 but not 403. Adding 403
  would not help — the fallback model is in the same project and fails
  identically — it would only double the latency of a doomed call.

Both are worth a spec of their own once the service is back.

## Still open

- `streamingSynthesize` (deferred in spec 50, restated in spec 59) removes
  chunk seams structurally instead of managing them. If seams are still
  audible after this, that is the next move.
- No client-side audio telemetry, so starves are invisible in production. The
  constants here are simulated and offline-measured, not a feedback loop.
- `make eval` was skipped: five runs during spec 61 produced five different
  failing sets, including same-run controls where identical tool calls scored
  1.000 and 0.000. It needs its own spec.
