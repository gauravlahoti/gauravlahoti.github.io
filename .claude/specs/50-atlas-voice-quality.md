# Spec 50: Atlas voice quality

## Overview

Spec 49 shipped spoken replies and they sounded broken in use: speech came out
in stop-start fragments with long silences between them, the voice fell further
and further behind text that had already finished rendering, nothing in the
chat window showed Atlas was talking, and audio began without the visitor
having clearly agreed to it.

The stop-start delivery was a bug, not a tuning problem. This fixes it and
closes the three UX gaps reported with it.

## Depends on

- Spec 49 — the speaker toggle, `/api/agent-speak`, and the sentence chunker,
  whose `findSplit` boundary logic is kept and extended here rather than
  rewritten.
- Spec 47 — the `data-mode` glyph-swap pattern the toggle uses.

## What spec 49 got wrong

`pump()` in `agent-speech.js` was strictly sequential:

```js
while (queue.length && ...) {
    const text = queue.shift();
    const wav = await synthesize(text);   // 2-4s of silence
    await play(wav);                      // then 3-6s of audio
}
```

Chunk N+1 did not begin synthesizing until chunk N had finished **playing**, so
every clip was followed by two to four seconds of dead air. Spec 49's Approach
section and PR #94 both state that "one synthesis request stays in flight while
the previous clip plays." The code never did that. The 0.69x realtime
measurement was taken correctly and then used to justify a pipelined design
that was not implemented.

Measured in a timing simulation of the old code: worst gap between clips 2.8s
on a four-clip reply. After this spec: 0.000s.

## Approach

**Producer and consumer are now separate loops.** A producer keeps up to
`LOOKAHEAD = 2` synthesis requests outstanding regardless of what playback is
doing; a consumer schedules whatever is decoded. This is the actual fix.

**Playback moved from `<audio>` to Web Audio.** Prefetching alone is not
enough: `new Audio().play()` has a variable start delay, so clips would still
join unevenly. Each chunk is decoded with `decodeAudioData()` and scheduled
with `source.start(nextStartTime)`, where `nextStartTime` accumulates real
buffer durations rather than being recomputed from the clock. That is
sample-accurate, so consecutive chunks butt together with no gap. The cursor is
only pulled forward to `currentTime` when the producer genuinely falls behind,
which is now the exception. Three things fall out of this: blob URLs and their
lifecycle disappear from the playback path, a `GainNode` gives a 40ms fade on
stop instead of an audible click, and `AudioContext.resume()` inside the click
handler replaces spec 49's silent-WAV priming clip entirely.

**Buffers are released strictly in sequence.** Synthesis runs two-wide and
completes out of order, because a short chunk finishes before a long one sent
before it. Scheduling on arrival therefore spoke the reply with its sentences
shuffled. This was caught by a test that deliberately inverts synthesis time
against chunk length; buffers are now keyed by sequence number and released
only in order, with a failed chunk stored as `null` so it is skipped rather
than blocking every chunk behind it.

**Chunk sizes ramp, and never split mid-sentence.** For playback not to starve,
chunk N+1 must synthesize faster than chunk N plays: `0.69 * dur(N+1) <=
dur(N)`, so each chunk can be at most ~1.45x the previous. A flat "just use
bigger chunks" starves badly right after a short opener, because 600 characters
is ~44s of audio and ~30s of synthesis. Sizes therefore ramp `70 → 140 → 240 →
350`.

An early build set the first limit at 45 and produced `"Gaurav has spent about
eight years at"` / `"Deloitte."` as two separate clips, which sounds far worse
than starting slightly later. `findSplit` now prefers a sentence end, then a
clause break, and will keep waiting for more text rather than breaking on a
bare word until the buffer passes 1.6x the limit.

**Chunks fill before they are emitted, unless the listener is waiting.**
Draining on every sentence as it arrived produced eight short clips where four
long ones sound better; every boundary is a prosody reset, since each chunk is
synthesized in isolation. But filling unconditionally starves. The rule is
runway-aware: fill to the ramp limit while there is more than `MIN_RUNWAY_S`
of audio still scheduled or queued, and emit at the first natural boundary when
there is not. That keeps the fast start and still yields long chunks in the
body of a reply.

**The TTS path is warmed.** The first Vertex call in a container pays an ADC
token fetch and a TLS handshake: 5.57s against 2.39s warm for a comparable
chunk. With sentence chunking that cost lands squarely on the first thing a
visitor hears. `speak.warm()` primes the cached credentials and client, called
from the existing `GET /api/agent-chat/warm` and again when the speaker is
switched on.

**An indicator inside the message.** A `.agent-speaking` strip is appended to
the assistant `<li>` while it is being read, mirroring `.agent-thinking`:
bouncing bars, a "Reading aloud" label, and a Stop button. The header icon
alone was too easy to miss. Deliberately no progress bar — total duration is
unknown until every chunk is synthesized, and a bar that guessed would be worse
than none.

**Consent is asked once, explicitly.** The first time the speaker is switched
on, an inline card above the composer says Atlas will read answers out loud in
a synthesized voice, with Turn on / Not now. Remembered afterwards. Inline
rather than a `<dialog>`, for the same reason the explainer dialog has to be
portalled onto `document.body`: `showModal()` centres against the viewport, not
the panel.

**Text is never slowed to match audio.** Skimming a reply has to stay possible;
the indicator is what makes the relationship between the two legible.

## Files changed

- `assets/js/agent-speech.js` — producer/consumer split, Web Audio scheduling,
  in-order buffer release, ramping chunk sizes, runway-aware draining,
  `unlock()`, gain fade on cancel.
- `assets/js/agent-widget.js` — consent card, `.agent-speaking` indicator and
  its lifecycle, `enableSpeaker()` split out of `toggleSpeaker()`, warm-on-
  enable, `SILENT_WAV_B64`/`primeAudio()` deleted.
- `assets/css/components.css` — `.agent-speaking`, `.agent-consent`.
- `agents/atlas/app/app_utils/speak.py` — `warm()`.
- `agents/atlas/app/api.py` — warm route primes TTS, returns `speakReady`.
- Cache-bust bumps across the three pages and `main.js`.

## Definition of done

- Consecutive clips are contiguous: measured gap ~0.000s, against 2-4s before.
- Clips play in the order the text was written, even when synthesis completes
  out of order.
- No chunk splits mid-sentence on ordinary prose.
- First audio within ~2s of the reply starting, with the path warm.
- The consent card appears exactly once ever, and audio only starts after it
  is accepted.
- A "Reading aloud" strip appears on the message being spoken, with a working
  Stop, and is cleared on stop, on toggle-off, and on panel close.
- `prefers-reduced-motion: reduce` freezes the bars.
- Backend tests pass.

## Deferred

- Cloud TTS `streamingSynthesize`, which returns one continuous stream for the
  whole reply and removes chunk seams entirely. The architecturally correct end
  state, and worth revisiting if seams are still audible — it needs a new API
  enabled, a streaming response through Cloud Run, and PCM assembly in the
  browser.
- Karaoke-style per-sentence highlighting (must survive the citation/markdown
  renderer).
- Revealing text at speaking pace.
