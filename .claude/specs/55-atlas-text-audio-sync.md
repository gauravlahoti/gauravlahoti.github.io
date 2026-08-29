# Spec: Atlas Text/Audio Sync

## Overview

Atlas's spoken replies (spec 49) stream reply text instantly via SSE while
TTS audio lags 2-3s+ behind (spec 50's chunked, pipelined synthesis).
Spec 50 chose that gap deliberately — "Text is never slowed to match audio"
— and relied on a "Reading aloud" indicator to make the relationship legible.
In practice the gap reads as laggy, not intentional: a visitor sees the full
answer appear, then the voice starts catching up seconds later.

This spec reverses that call, narrowly: when the speaker toggle is on, reply
text reveals word-by-word in step with the voice reading it (karaoke-style),
using the exact schedule `agent-speech.js` already computes for each audio
chunk. With the speaker off, text streams exactly as it does today — instant,
untouched. This is not a redesign of the synthesis pipeline; it reuses spec
50's chunking, ramp, lookahead, and Web Audio scheduling as-is and only adds
an outward-facing timing signal plus a first-chunk latency trim.

## Depends on

Spec 49 (Atlas spoken replies), spec 50 (Atlas voice quality — chunking,
producer/consumer pipeline, Web Audio scheduling).

## Routes

No backend. (Static site; the existing `/api/agent-chat` and
`/api/agent-speak` endpoints are unchanged.)

## Database changes

No database.

## Templates

- **Modify:** `assets/js/agent-speech.js`, `assets/js/agent-widget.js`

## Files to change

- `assets/js/agent-speech.js`
  - `initSpeaker({...})` gains an `onChunkScheduled` callback.
  - `decoded` map stores `{ buf, text }` instead of a bare buffer so the
    chunk's source text survives through to scheduling.
  - `schedule(audioBuffer, text)` fires `onChunkScheduled({ text, ctxNow,
    ctxStartAt, durationSec })` using the same `nextStartTime` cursor and
    `audioBuffer.duration` it already uses to schedule playback.
  - `drainReady()` also fires `onChunkScheduled` for a chunk whose synthesis
    failed (`buf === null`), with an estimated `durationSec` from
    `CHARS_PER_SEC_OF_SPEECH`, so its text still surfaces instead of being
    silently dropped.
  - `CHUNK_RAMP[0]` shrinks from `70` to `36` so the first clip (and thus the
    first reveal) starts sooner. `CHUNK_RAMP[1..]` (`140/240/350`) are
    unchanged — the starvation invariant only gets safer with a smaller
    opener, not riskier.

- `assets/js/agent-widget.js`
  - New `createRevealQueue(li)` helper: `scheduleChunk(info)` waits until a
    chunk's `ctxStartAt` and then reveals its text word-by-word, paced across
    `durationSec`, via `requestAnimationFrame`, appending to the same
    `.agent-message-text` paragraph `appendDelta` already targets.
    `whenDrained()` resolves once all chunks (including the post-`flush()`
    tail) have finished revealing. `flushRemaining()` shows everything
    buffered immediately, for Stop and for synthesis errors.
  - `sendCurrent()` creates a `revealQueue` for the turn only when
    `FEATURES.speakReplies && speakerOn`; otherwise it stays `null` and the
    existing instant `appendDelta` path runs completely unchanged.
  - `onDelta` skips the direct `appendDelta` call when a reveal queue is
    active (text arrives via `scheduleChunk` instead); `speaker.feed(delta)`
    is untouched either way.
  - `onDone` awaits `revealQueue.whenDrained()` (only when a queue is active)
    before running the existing finalize block (`finalizeAssistant`,
    `messages.push`, suggestions/CTA, `portfolio:agent-question`).
  - `stopStreaming()` and the speaker's `onError` callback both call
    `revealQueue?.flushRemaining()` so Stop and synthesis failures always
    resolve to fully-visible text immediately, never left pending on a timer.

## Files to create

None.

## New dependencies

No new dependencies.

## Rules for implementation

- All identity content lives in `content/profile.json`. (Unaffected — no
  content changes in this spec.)
- CSS variables only — never hardcode hex. (No CSS changes in this spec.)
- One JS module per visualization; lazy-load on viewport entry.
  `agent-speech.js` stays lazy-loaded exactly as spec 50 set it up.
- No npm, no bundler, no Node toolchain.
- Respect `prefers-reduced-motion`. (Word-reveal pacing is a text-content
  change, not a CSS/motion animation, so this doesn't interact with the
  reduced-motion media query — same as today's instant `appendDelta`.)
- The speaker-off path must be provably byte-for-byte identical to current
  behavior: `revealQueue` stays `null`, so every new code path is skipped.

## Definition of done

- [ ] With the speaker on (default), asking Atlas a question shows no reply
      text until the first audio chunk is about to play, then reveals words
      roughly in time with the voice — not dumped all at once per chunk.
- [ ] Citations, suggestion chips, and the CTA only render once the full
      reply has finished being read aloud.
- [ ] Hitting Stop mid-reply silences audio and reveals all remaining text
      immediately, with no residual delay.
- [ ] With the speaker off, asking a question streams text exactly as before
      this spec — instantly, with zero pacing.
- [ ] A forced synthesis failure (e.g. a broken `/api/agent-speak` call)
      still results in the rest of that turn's text becoming visible, not
      permanently hidden.
- [ ] No new console errors across the above in a manual browser check.
