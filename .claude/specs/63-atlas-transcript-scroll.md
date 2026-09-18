# Spec 63 — Chat transcript stops losing the bottom of long replies

## Problem

On longer replies the panel misbehaved: the final CTA button looked half-cut
and dimmed at the bottom edge, and the same "Continue on LinkedIn →" button
stacked up across consecutive turns.

The dimming was never a clipping bug. `.agent-panel-body.has-overflow::after`
is a sticky 40px `linear-gradient(transparent, var(--bg-elev))`, and
`syncScrollHint()` only switched it on when the container overflowed **and was
not scrolled to the bottom**. So the screenshot was proof that the transcript
had been left short of its own bottom. The gradient was the symptom.

### Why it ended up short

`scrollToEnd()` had to be called by hand at every insertion site, and four of
the seven end-of-stream paths never called it — including `finalizeAssistant`,
which is the largest height change of the whole turn (it replaces the
paragraph's children, re-wrapping every line, then appends the sources
disclosure). The last scroll of a turn ran against the pre-finalization height.

That is why it was length-dependent. A short reply doesn't overflow, so there
is nothing to fall short of.

Three further height changes landed after the last scroll, all asynchronous and
none of them an insertion site anyone would think to annotate: the
"Reading aloud" strip appended from the voice engine's `onPlaying`; the
composer growing a full line when `.agent-voice-status` ("Speaking…") switches
from `display: none` to `flex: 1 0 100%`; and the mobile keyboard resizing the
panel through `--agent-vv-height`.

### The fade fought its own measurement

The `::after` is a flex item with `height: 40px`, so switching `has-overflow`
on added 40px plus one `gap` — about 52px — to `scrollHeight`. Reaching the
bottom switched it off, removed those 52px, and shifted the content down by
that much. A visible jump at the exact moment you arrived.

### And the CTA was never cleaned up

`renderCta` appends into that turn's own `<li>` and nothing removed it, while
its sibling `.agent-suggestions` *is* cleared on the next send
(`agent-widget.js:893`). The CTA was simply left out of that line.

## Changes

**`assets/js/agent-widget.js`**

- One stick-to-bottom model with a `ResizeObserver` on the scrollport and on
  the transcript, replacing seven hand-placed calls. Adding three more calls
  would have fixed the screenshot and broken again at the next insertion site,
  which is how it broke in the first place.
- `maybeScrollToEnd()` follows only when the visitor is already at the bottom.
  The old `scrollToEnd()` was unconditional, so a late badge or CTA render
  yanked the view away from anyone reading back. `scrollToEnd()` is kept for
  the two places that should force it: sending a message, opening the panel.
- `syncScrollHint()` runs **before** the scroll, not after. Switching the fade
  on adds ~52px, so doing it second left every auto-scroll exactly that far
  short of the bottom — the last element landed under the fade, which is the
  reported bug. Measured at 862 against a max of 914 before the reorder.
- `has-overflow` is measured from `dom.transcript.scrollHeight` rather than
  `body.scrollHeight`, since the fade is itself part of the latter. Feeding it
  back made the test self-referential.
- `renderCta` stamps `data-cta` and removes an earlier button for the **same**
  target. Not a blanket clear: a Topmate offer from two turns back is still
  live, while a second identical LinkedIn button above the new one is noise.
- Deleted `pendingCitations` / `pendingCta`, dead since `turnState`.

**`assets/css/components.css`** — `has-overflow` no longer depends on
`!atBottom`, so the fade stops appearing and disappearing mid-scroll. Its ~52px
now sit permanently below the last message when the transcript overflows, which
is what guarantees the final element clears it.

Negative margins were tried first and do not work: Chrome does not shrink
`scrollHeight` for a negative end margin. Measured 28px of 52 recovered.

## The race, caught in testing

The first implementation guarded against self-triggered scroll events with an
`isAutoScrolling` boolean cleared on the next animation frame. Against the real
agent this failed — `atBottom: false` after a cited reply. Scroll events
dispatch asynchronously and arrive *after* that frame, so if the reply grew
once more in between, the handler read "not at bottom", cleared the flag, and
the transcript stopped following mid-turn.

Replaced with direction: an auto-scroll only ever moves down, so treating
"scrolled up" as the signal to stop following is immune to the ordering. No
timer, no flag.

## Verification

Driven through Chrome DevTools against `localhost:5173`.

Synthetic, deterministic (40 rapid growths simulating a stream, then a late
end-of-stream block):

| | Result |
|---|---|
| Frames off-bottom while streaming | **0 of 40** |
| CTA clear of the 40px fade | yes |
| Visitor scrolled up, late content arrives | **300 → 300**, undisturbed |
| Returns to bottom, following resumes | yes |
| `scrollHeight` across the whole scroll range | **single value** — no jump |

Against the live agent, a 645-char cited reply:

- 11 samples during streaming, **0 off-bottom**
- final `scrollTop` 154 against a max of 154 — exactly at the bottom
- the "Sources" block fully visible inside the scrollport

CTA de-duplication was exercised live across three turns: a `linkedin` button
and a `topmate` button coexist (different targets, both still useful), and
`data-cta` is stamped by the production render path.

Not covered by an automated test. The widget is one 2,500-line closure with no
DOM harness, and the repo has no jsdom and no npm to add one. Stated plainly
rather than inventing a test that asserts nothing.

## Definition of done

- [x] End-of-stream content never lands under the fade or below the fold
- [x] A visitor reading back is never scrolled away from
- [x] No scrollHeight jump on reaching the bottom
- [x] Identical CTAs de-duplicated, different ones kept
- [x] `?v=` bumped to 285 (JS and `components.css`)

## Still open

- Extracting the widget into testable units. It is a single large closure and
  that is its own spec; until then, changes here are browser-verified by hand.
- `FEATURES.suggestions` is still `false`, so line 893 only ever clears the
  intro starter row. Untouched here.
