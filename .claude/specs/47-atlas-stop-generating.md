# Spec 47: Stop generating

## Overview

The Atlas chat widget has no way to cancel a response in flight. Once a visitor
hits send, `sendCurrent()` sets `isPending = true`, disables the send button,
and the only exit is the stream finishing or the network dying. A visitor who
mistypes a question, or realises mid-answer they asked the wrong thing, has to
sit through the full response, including the "Thinking" phase, which on a cold
Cloud Run instance can run 10s+ before the first token.

This adds a stop control in the shape the site already uses: the cyan send
button morphs into a stop button while a turn streams, and morphs back when
the turn ends.

## Depends on

- Spec 21 — the agent widget and its SSE streaming loop (`streamAgent`).
- Spec 24 — the typing cursor and "Thinking" panel state machine this sits
  alongside without disturbing.

## Approach

**Button, not a separate control.** The existing 44×44 `.agent-send` button
holds two SVGs (paper-plane, filled square) and a `data-mode` attribute picks
which renders — zero layout shift on a 380px-wide panel. A thin CSS ring
(`::after`, `border-top-color` accent against a low-alpha track) spins around
the stop glyph while streaming, matching the site's other loading affordances
(`.agent-cursor`, `.agent-loading-dots`) in following the
`prefers-reduced-motion` convention: the ring freezes to a static full circle
instead of animating.

**Cancellation is a real `AbortController`.** `sendCurrent()` creates one per
turn, passes `signal` into `streamAgent()`'s `fetch`, and the click handler on
the button (now dual-purpose) calls `abortController.abort()` when
`data-mode === "stop"`. Escape does the same when a turn is streaming, falling
back to its old "close the panel" behaviour otherwise.

**An abort is a clean stop, not an error.** `streamAgent()` has three
catch sites (the initial `fetch`, `reader.read()`, and the outer frame-parsing
loop), and before this spec all three treated any failure — including an
intentional abort — as a dropped connection, which meant a mid-stream abort
would paste a "Connection slipped — try again?" retry button under the text
the visitor just chose to stop. Each catch site now checks `signal?.aborted`
first and calls `onDone()` cleanly instead of `onError()`.

**Stopped turns keep the partial answer.** `onDone` short-circuits on a
`wasStopped` flag: it finalizes whatever text streamed, pushes it into the
`messages` history so the next turn's context stays coherent, appends a muted
mono `.agent-stopped-note` ("Stopped."), and refocuses the composer. It does
**not** tick the hero "responded to N questions" counter, and does not render
follow-up suggestion chips or a CTA — those are reserved for a turn Atlas
actually completed.

**Closing the panel does not abort.** The conversation survives a close/
minimize; letting an in-flight stream finish means the answer is waiting if
the visitor reopens the panel.

## Files changed

- `assets/js/agent-widget.js` — `abortController`/`wasStopped` state,
  `setSendMode()`/`stopStreaming()`, dual-glyph send button markup, `onDone`
  stopped-turn branch, `appendStoppedNote()`, `signal` threaded through
  `streamAgent()` and its three catch sites, `stop` added to the widget's
  public API (`window.__agentWidget.stop()`).
- `assets/css/components.css` — `.agent-send-glyph*`, the `data-mode="stop"`
  spinning ring, `.agent-stopped-note`.
- `assets/js/main.js`, `index.html`, `live-agents/index.html` — cache-bust
  version bumps (`agent-widget.js` and `components.css` are both lazy-loaded
  with a `?v=` query).

## Definition of done

- Sending a question flips the send button to a spinning stop square; it
  flips back to the paper plane the instant the turn ends, with no layout
  shift.
- Clicking stop (or pressing Escape) while streaming — during "Thinking" or
  during the answer — ends the turn immediately, keeps whatever text had
  streamed, appends "Stopped.", and does **not** show a retry button or error
  copy.
- A new question can be sent immediately after a stop.
- A stopped turn does not increment the hero question counter or render
  suggestion chips / a CTA; a completed turn still does both.
- `prefers-reduced-motion: reduce` renders the ring as a static circle, not
  spinning.
- Same behaviour verified on `/live-agents/` (widget boots via
  `agents-page.js`'s own lazy import).
