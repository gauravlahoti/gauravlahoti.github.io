# Spec 49: Atlas spoken replies

> **Correction (spec 50).** The Approach section below claims "one synthesis
> request stays in flight while the previous clip plays." That was the design;
> it was not what shipped. `pump()` awaited `synthesize()` and then `play()` in
> a single loop, so each chunk only began synthesizing after the previous had
> finished playing, leaving 2-4s of dead air between clips. Fixed in spec 50.

## Overview

Spec 48 gave Atlas ears. This gives it a mouth.

Today a visitor can tap the mic, speak a question, and watch the answer
stream back as text. The last box of the pipeline is missing: nothing reads
the answer out. This adds a speaker toggle to the panel header, and with it
on, each reply is synthesized and played as it streams.

That completes the loop — speak a question, hear the answer, never touch the
keyboard. Text chat stays exactly as it is and remains the default. Voice
output is opt-in, off on first load, and rate-limited on its own budget.

This is turn-based, not a live conversation. There is no WebSocket, no
barge-in, and no Live API session here. Atlas speaks when it has finished
thinking of a sentence, the same way it currently types one.

## Depends on

- Spec 21 — the agent widget, its panel header, and `sendCurrent()`'s SSE
  callbacks (`onDelta`, `onDone`), which this hooks into.
- Spec 47 — the send button's `data-mode` glyph-swap pattern, cloned again
  here for the speaker toggle's off/on/speaking states.
- Spec 48 — voice input, `app_utils/transcribe.py`'s Vertex REST structure,
  and the `BUCKETS` rate-limit table this adds a third bucket to.

## Routes

- `POST /api/agent-speak` (new, `agents/atlas/app/api.py`) —
  `{"sessionId": str, "text": str}` →
  `200 {"audio": base64 wav, "mime": "audio/wav", "model": str}` |
  `400` bad input | `429` speak budget exhausted | `502` synthesis
  unavailable. Never calls `lookup_geo` or `log_interaction` — synthesizing a
  sentence isn't a chat turn, same call spec 48 made for transcription.

## Approach

**Vertex `generateContent`, not the Cloud Text-to-Speech API.** Cloud TTS
serves the same Gemini TTS models and would return MP3/OGG directly, which
would save prepending a WAV header. It also needs `texttospeech.googleapis.com`
enabled, an `x-goog-user-project` quota header, and cross-project IAM that
Atlas has never exercised — three new failure modes on a path that has to work
on the first deploy. Vertex `generateContent` reuses `transcribe.py`'s
already-proven auth path unchanged: cached ADC credentials, a module-level
`httpx.AsyncClient`, and `ATLAS_VERTEX_PROJECT`/`ATLAS_VERTEX_LOCATION` from
`fallback_model.py`. The price is a 44-byte RIFF header built server-side,
which is ten lines of `struct.pack`, and in exchange the browser plays a plain
`<audio>` element with no AudioWorklet and no PCM handling at all.

**Model IDs came from Model Garden, not the docs.** Spec 48 lost an afternoon
to `gemini-3.5-transcribe` 404ing because the callable publisher ID carries a
`-preview` suffix the public docs never print. Resolved the same way before
writing any code:

```
$ gcloud ai model-garden models list --project=adk-mas-demo
google/gemini-3.1-flash-tts-preview@default   CAN_PREDICT: Yes
google/gemini-2.5-flash-tts@default           CAN_PREDICT: Yes
```

`gemini-3.1-flash-tts-preview` (April 2026) is the newest TTS model and the
only one with expressive audio tags on top of natural-language style
prompting. `gemini-2.5-flash-tts` is GA at half the output price and serves as
the cascade fallback on 404/429/503 — availability redundancy, exactly like
`FallbackGemini` and `transcribe.py`, not a hedge against the primary being
bad. This rule is now written into `CLAUDE.md` so the next model doesn't
repeat the hunt.

**The style prompt is the reason for picking Gemini TTS at all.** Chirp 3 HD
is cheaper (1M free characters a month against this site's ~80k) but has no
style prompting whatsoever, and makes Atlas sound like a newsreader. Gemini
TTS takes a natural-language instruction, so Atlas gets a persona defined once
as a constant: calm, precise, unhurried, no hype. An agent that sounds like a
person is the entire point of the feature; saving $2.82 a month to lose that
is a bad trade.

**Sentence-chunked synthesis, not speak-after-done.** Waiting for the whole
reply before starting to speak would add ten seconds or more of dead air after
the text has already finished rendering. Instead `onDelta` feeds a buffer that
flushes on sentence boundaries, with one synthesis request in flight while the
previous clip plays.

Measured against the real model, synthesis runs at a steady **0.69× realtime**
(39 chars → 2.4s, 62 → 4.1s, 95 → 4.7s, 171 → 9.3s). Two things follow. First,
because generation is faster than playback, a single in-flight request always
stays ahead of the queue — no need to parallelise, which would also multiply
rate-limit spend. Second, the only latency that a visitor actually feels is
the *first* chunk, so the first chunk is deliberately capped short (~90 chars,
first sentence boundary wins) and later chunks run up to ~320. That puts first
audio roughly 2 to 3 seconds after the first sentence exists, instead of the
9+ seconds a whole-reply synthesis would cost.

Chunking also keeps payloads sane: a whole 28-second reply as one WAV is
~1.8 MB of base64, while sentence chunks are ~200-300 KB each.

**Chunking trades one quota risk for the latency win.** Because a reply
becomes ~5 sequential requests rather than 1, it presses harder on Vertex's
`generate_content_requests_per_minute_per_base_model` quota. Confirmed while
testing: a 40-request burst exhausted the per-minute quota on the primary,
cascaded to `gemini-2.5-flash-tts`, and exhausted that too. Real traffic is
nothing like that shape — chunks are sequential per visitor, gated by playback,
and capped at 40/24h — and the failure is soft: the route returns 502 and the
reply simply stays text-only, already rendered on screen. Worth knowing before
raising the chunk count or parallelising synthesis, either of which would make
this materially worse.

**Only sanitized text is ever spoken.** URLs, `[[META]]` blocks, markdown
syntax, and `[1]`-style citation markers are stripped before synthesis. A
model reading "https colon slash slash" aloud is the fastest way to make this
feel broken.

**Autoplay is respected, not worked around.** The toggle can only be switched
on by a click inside the panel, which is the user gesture browsers require
before audio may play. The preference persists in `localStorage`, but audio
never plays in a page session where the visitor hasn't clicked.

**No browser `speechSynthesis` fallback.** The on-device voice is free, but it
sounds nothing like the persona, differs on every browser, and is unreliable
on iOS Safari — it silently drops outside a gesture handler, `getVoices()`
often returns empty, and it stops when the tab backgrounds. Falling back to it
mid-conversation would make Atlas sound like two different agents. The
model-level cascade to `gemini-2.5-flash-tts` is the only fallback; if that
fails too the turn stays text-only with a note in the status line. The reply
is already on screen, so silence is a smaller failure than a wrong voice.

**Speaking gets its own rate-limit bucket.** `BUCKETS` gains `speak` at 40 per
24h per session and per IP-hash. A single reply costs several requests because
of sentence chunking, so this is roughly eight spoken replies a day, against a
budget of four chat questions. Synthesis must never spend a chat question, and
the buckets are already namespaced (`f"{bucket}|{session_id}"`) so they stay
independent.

**The speaker toggle needs its own state slot.** `isPending` already means "a
chat stream is in flight" and is overloaded across the send button, the mic,
and the composer. Playback outlives the stream — audio is still playing after
`onDone` fires — so `isSpeaking` is tracked separately rather than folded in.

## Files changed

- `agents/atlas/app/app_utils/speak.py` (new) — Vertex REST synthesis with
  model cascade, `wav_header()`, `sanitize_for_speech()`, length cap, cached
  ADC credentials and client.
- `agents/atlas/app/rate_limit.py` — `speak` bucket added to `BUCKETS`.
- `agents/atlas/app/api.py` — `POST /api/agent-speak`; header contract comment
  updated to document all five routes.
- `assets/js/agent-speech.js` (new) — playback engine: `initSpeaker()`
  returning `{feed, flush, cancel, dispose}`, sentence splitter, single-flight
  fetch queue, `Blob` object-URL playback with revocation.
- `assets/js/agent-widget.js` — `speakReplies` feature flag, speaker toggle in
  the panel header, `setSpeakerMode()` state machine, lazy import of
  `agent-speech.js`, `onDelta`/`onDone` wiring, cancel on stop and on panel
  close, `isSpeaking` state.
- `assets/css/components.css` — `.agent-speaker` and its three `data-mode`
  states.
- `index.html`, `live-agents/index.html` — CSP `media-src 'self' blob:`
  (`index.html` has no `media-src` at all today and silently inherits
  `default-src 'self'`, which blocks every clip).
- `index.html`, `live-agents/index.html`, `ai-labs/index.html`,
  `assets/js/main.js` — cache-bust bumps.
- `agents/atlas/tests/unit/test_speak.py` (new) — WAV header, sanitization,
  length cap, chunk splitting.
- `CLAUDE.md` — the model-ID resolution rule.
- `.claude/docs/agents.md` — was stale since spec 48 (missing
  `/api/agent-transcribe` and the voice bucket); brought current with both
  routes and all three buckets.

## Rules for implementation

- Never take a Google model ID from docs or memory — resolve it with
  `gcloud ai model-garden models list` first.
- Never read `GEMINI_API_KEY` in the speak route; force Vertex/`adk-mas-demo`
  via `fallback_model.py`'s constants, same as transcribe.
- Never spend a chat rate-limit slot on synthesis.
- Never speak raw reply text — always sanitize first.
- Never auto-enable the toggle, and never play audio without a prior click.

## Definition of done

- Speaker toggle renders in the panel header on `/` and `/live-agents/`, off
  by default, state persisted across reloads.
- With it on, Atlas starts speaking within about 2-3 seconds of the first
  complete sentence, and playback never starves afterwards (synthesis runs
  ahead of playback at 0.69x realtime).
- Pressing stop, closing the panel, or toggling off cuts audio immediately and
  aborts in-flight synthesis requests.
- URLs, citation markers, and markdown are never spoken aloud.
- A 429 on the speak bucket leaves the turn text-only with a visible note and
  never throws; a chat question on the same session still works.
- `gemini-3.1-flash-tts-preview` serves the request, not the 2.5 fallback.
- `prefers-reduced-motion: reduce` freezes the speaking animation.
- Backend unit tests pass (`uv run pytest tests/unit tests/integration`).

## Deferred

- `streamGenerateContent` for progressive audio, which could cut the
  first-chunk wait below 2s. It would put PCM assembly back in the browser and
  reintroduce the AudioWorklet this design exists to avoid, for ~1s.
- Full-duplex live voice via `gemini-live-2.5-flash-native-audio` — a
  WebSocket session with barge-in that replaces this three-model chain with
  one native-audio model. A different and much larger feature, with per-minute
  billing and Cloud Run socket-lifetime costs.
- Streaming STT via `gemini-3.5-transcribe-live-preview` (still deferred from
  spec 48).
- Bumping `google-genai` past 1.74.0.
- An `/ai-labs/` page explaining the STT → LLM → TTS pipeline.
