# Spec 52 — Atlas architecture diagram: show the STT + TTS layer

**Status:** implemented
**Branch:** `feat/52-atlas-diagram-voice`
**Date:** 2026-08-29

## Problem

Specs 48-51 turned Atlas from a text chat agent into a voice agent: mic input
(`gemini-3.5-transcribe-preview`), spoken replies (`gemini-3.1-flash-tts-preview`),
pipelined Web Audio playback, and a right-sized Cloud Run deployment. None of it
reached the architecture diagram. `agent-portfolio/diagrams/chat-agent-v1.svg`
still showed the pre-voice, five-step picture.

It was also factually stale. The SVG said `Gemini 3.5 → 2.5 Flash`, while
`agents/atlas/app/agent.py:80` runs `gemini-3.7-flash` cascading to
`gemini-3.6-flash`. `content/agents.json` already said 3.7 → 3.6, so the diagram
contradicted the copy sitting next to it on the same panel.

## The point worth drawing

The voice layer is **not inside the ADK agent loop**. `/api/agent-transcribe` and
`/api/agent-speak` are plain FastAPI routes that call the Vertex REST endpoint
directly with `httpx` (`app/app_utils/transcribe.py`, `app/app_utils/speak.py`),
bypassing ADK entirely. That is why voice degrades gracefully, why the text path
was untouched by specs 48-51, and why voice spends its own rate-limit buckets
(`app/rate_limit.py`: `voice` 12/day, `speak` 40/day) instead of a visitor's four
chat questions.

A diagram that hung STT/TTS off the agent box would have misrepresented the
system. So v2 groups them in their own sub-box labelled
`voice routes · plain REST, no ADK loop`, with their own arrows to Vertex.

## Changes

| File | Change |
|---|---|
| `agent-portfolio/diagrams/chat-agent-v2.svg` | New. Full redraw, `viewBox 0 0 1280 800` |
| `content/agents.json` (atlas entry) | `diagramSvg`, `diagramAlt`, `stack`, `steps` 5 → 7, `techDecisions` +3, `traits` +1, `description`, `value`, `headline`, `searchMeta` |
| `agent-portfolio/diagrams/chat-agent-v1.svg` | Left on disk as history |

No JS or CSS changes. `animateDiagram()` is generic over step count.

## Layout

Three columns, three lanes. The **Browser moved outside the Google Cloud
boundary** (v1 drew it inside, which was wrong: capture and playback are
client-side).

```
 Browser (client)      ┌ Cloud Run · atlas ────────┐  ┌ Vertex AI ───────────┐
   mic       ─①──▶     │ ┌ voice · plain REST ────┐ │  │                      │
             ◀─②─      │ │ /api/agent-transcribe  │──┼─▶│ Gemini 3.5 Transcribe
   speaker   ─⑥──▶     │ │ /api/agent-speak       │──┼─▶│ Gemini 3.1 Flash TTS
             ◀─⑦─      │ └────────────────────────┘ │  │                      │
   composer  ─③──▶     │   ADK Agent /api/agent-chat──┼─▶│ Gemini 3.7 → 3.6    │
             ◀─⑤─      └────┬──────────────┬────────┘  └──────────────────────┘
                            ④ retrieval    │ MCP call
                        ADK Skills      Resend MCP
```

Numbering is temporal, not spatial: the voice-in pair (①②) and voice-out pair
(⑥⑦) sit together at the top because they are the same architectural layer, but
⑥⑦ happen last. v1 already had non-monotonic placement (⑤ below ③), so this
follows the established style.

## Constraints that shaped it

1. **Aspect ratio must stay 16/10.** `assets/css/agents.css:595`
   `.agent-diagram-pane` is `aspect-ratio: 16/10` with `object-fit: contain`, so
   the card thumbnail letterboxes if the viewBox drifts. `1280 × 800` is exactly
   1.6. Verified: 0px letterbox on both axes.
2. **Step circles are a contract.** `agents.json` `steps[].n` must match the
   SVG's `data-step-circle="N"`, which `animateDiagram()`
   (`assets/js/agents-page.js:303-403`) reveals as traveler dots arrive. Change
   one without the other and the reveal silently breaks.
3. **New filename, not a `?v=` bump.** `agents-page.js:93` appends `?v=177` for
   the card thumbnail while the panel (line 462) fetches the bare path, so a
   query string in `diagramSvg` produced the odd `...svg?v=2?v=177`. A new
   basename is its own cache-buster; `diagramSvg` now carries no query string.
4. **Token values, hardcoded.** The SVG is served as an `<img>` for the card
   thumbnail, so it cannot reference `base.css` variables and must hardcode
   values, exactly as v1 did. The palette is v1's set (`#00FFD1`, `#E5E5E5`,
   `#888888`, `#555555`, `#000000`, plus the diagram-only `#0F0F0F` node fill,
   `#0E1A19` accent fill, `#666666` dashed boundary and `#4285F4` Google blue),
   with two additions for the new inner chips, both taken from real tokens:
   `#111111` (`--bg-card`) and `rgba(255,255,255,0.16)` (`--border-strong`).
   A first draft used invented `#151515` / `#333333`; those were replaced.

`gemini.png` stands in for a Vertex AI icon, which the repo does not have. It is
honest: all three models are Gemini.

## Definition of done

- [x] All 7 step circles present in the SVG and matched by `steps[].n`
- [x] All 4 icon types resolve (`google-cloud.png`, `cloud-run.svg`, `adk.png`, `gemini.png`)
- [x] No box overlaps and no text overflow (checked programmatically via `getBBox()`)
- [x] Animation runs: 11 travelers, all 7 circles reveal over one cycle
- [x] Card thumbnail fills the 16/10 pane with zero letterboxing
- [x] Fullscreen expand clones and re-animates; all 7 circles reveal there too
- [x] Mobile (≤767px): expand button hidden, pinch-zoom hint shown, no horizontal page overflow
- [x] Console clean, no errors or warnings
- [x] No em-dashes in the new copy (also removed one pre-existing em-dash in the atlas `techDecisions`)

## Not done

- `chat-agent-v1.svg` kept on disk.
- Pulse and RAG Lab diagrams untouched.
- No Atlas redeploy. This is a static content change; the agent is unaffected and
  needs no `make corpus` or Cloud Run deploy.
