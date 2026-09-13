# Spec 57 — Decouple reply text from the audio clock

**Status:** implemented
**Branch:** `56-atlas-cert-badges`

## Problem

With "speak replies" on — the default for every first-time visitor
(`SPEAK_DEFAULT_ON = true`) — reply text did not appear until the first TTS round trip
had completed. The panel sat on loading dots for seconds, and the voice itself dragged.

## Root cause

Spec 55 routed all reply text through a reveal queue paced to the audio schedule. With a
queue active, `onDelta` did not paint at all: every visible word arrived via
`onChunkScheduled`. `markFirstDelta` — which clears the loading dots — was wired as the
queue's `onFirstReveal`, so even the loading state couldn't resolve early.

First word on screen therefore cost: buffer ~24-38 chars, **plus a full
`/api/agent-speak` round trip (~2.4s warm, ~5.6s cold)**, plus decode. That call is
single-shot per chunk (`api.py` returns the whole WAV in one JSON body), so it could not
be partially consumed.

`onDone` compounded it by awaiting `revealQueue.whenDrained()`, which only settles when
the speaker goes idle. Citations, follow-up chips, the CTA and spec 56's badge strip all
waited for the last audio sample — tens of seconds after the reply had finished arriving.

Separately, nothing controlled speaking rate. This TTS surface exposes no numeric field
(`speakingRate` belongs to Cloud TTS `audioConfig`, unused here), and `STYLE_PROMPT`
asked for an **"Unhurried"** delivery. Because the queue paced off `audioBuffer.duration`,
that instruction slowed the text too.

## Decision, and why it reverses spec 55

Spec 50 ruled "**Text is never slowed to match audio.**" Spec 55 reversed it to close a
2-3s desync. That trade was wrong: it swapped a visible gap for a worse one, putting
*all* text behind synthesis. We return to spec 50's principle deliberately.

Text streams instantly; the voice trails it and the "Reading aloud" strip keeps the
relationship legible. On long replies the voice falls behind the text. That is accepted —
reading is never worth blocking on synthesis.

**Do not "fix" the desync by reintroducing paced text.** That is this spec's whole point.

## Changes

| File | Change |
|------|--------|
| `assets/js/agent-widget.js` | `onDelta` always paints; `createRevealQueue()` and all its wiring removed (~120 lines); `onDone` no longer awaits audio; stale consent comment corrected |
| `assets/js/agent-speech.js` | `SPEECH_RATE = 1.1` applied via `source.playbackRate`; `nextStartTime` and `runwaySec()` divided by the same factor; `onChunkScheduled` callback and `rawText` plumbing removed |
| `agents/atlas/app/app_utils/speak.py` | `STYLE_PROMPT` "Unhurried" → "Natural pace" |
| `agents/atlas/app/instruction.py` | Anti-parroting directive on the worked-examples section; cert example prose shortened to plain fact |
| `index.html`, `assets/js/main.js` | asset version 282 → 283 |

Two independent speed levers on purpose: the prompt removes the model's own drag,
`SPEECH_RATE` is the deterministic trim. Keep the rate modest — past ~1.2 the voice sounds
processed rather than brisk.

### Two correctness details

- `nextStartTime += audioBuffer.duration / SPEECH_RATE`. `playbackRate` compresses
  wall-clock playback by exactly that factor; accumulating raw duration would leave a
  widening silent gap between every chunk.
- `runwaySec()`'s queued-text estimate needed the same divide. Left alone it reads ~10%
  longer than reality, so `drain()` waits too long before emitting — erring toward
  starvation, the failure `RUNWAY_MARGIN_S` exists to prevent.

### Anti-parroting

Worked examples are few-shot structure, but distinctive phrasing in them gets reproduced
verbatim. The examples section now states they are illustrative filler rather than
approved copy, and the certification examples were cut back to plain fact so imitation
degrades gracefully.

## Definition of done

- [x] With the speaker ON, first word paints before any `/api/agent-speak` response
      returns — measured twice at ~2.58s ahead
- [x] Badge strip, citations and CTA render at end-of-stream, not end-of-audio
- [x] Speaker-OFF path behaviorally unchanged
- [x] No dangling references to `revealQueue` / `onChunkScheduled` / `rawText`
- [x] `uv run pytest tests/unit tests/integration` green (97 passed)
- [x] No new console errors
- [ ] Listened to end to end for chunk seams (needs real Vertex audio — deploy first)
- [ ] `make corpus`, eval baselined, deploy approved

## Verification performed

A local stub served the real site, a canned `/api/agent-chat` SSE stream, and a
deliberately slow `/api/agent-speak` (2.5s, matching measured warm Vertex latency,
returning real silent PCM WAV so `decodeAudioData` succeeds). The slowness is the test:
text must paint before it returns.

Instrumented `window.fetch` plus a `MutationObserver` on the assistant message. With the
speaker genuinely on (verified `aria-pressed="true"`, 3 speak calls), text painted
**2,584ms before** the first audio response resolved; a second run measured 2,582ms.

Note for future runs: the speaker must be enabled by a real CDP input event.
A synthetic `.click()` is not trusted user activation, so the AudioContext never unlocks,
no speak call is made, and the gated path silently isn't exercised.
