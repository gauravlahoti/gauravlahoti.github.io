# Spec: Atlas Avatar Conversation

## Overview
Avatar mode (spec 70) answers from `gemini-3.8-live` directly, but it was push-to-send: every question was typed or recorded, then sent. This spec adds a hands-free conversation.
- **Start conversation** opens the mic, and the avatar takes turns on its own. Talking over it interrupts it.
- **Mute** pauses the mic, **Type** brings back the composer, and **End** closes the conversation.
- Every turn lands in the shared chat.
- One Live session serves the whole conversation over one WebSocket, which also passes live through the corporate inspection proxy that held SSE back.

## Depends on
Specs 67 and 70 (avatar, live brain), the chat WebSocket transport (PR #155) and the stream probes (#153, #154).

## Routes
`WS /api/agent-live`, gated by `ATLAS_LIVE_CONVO=1`:
- **Origin:** checked against `ALLOW_ORIGINS`.
- **In:** first `{"start": {sessionId}}`, then binary 16 kHz PCM16 frames (≤ 100 ms each) plus `{"text"}`, `{"mute"}` and `{"end"}`.
- **Out:** binary fMP4 video, plus JSON `state`, `userWords`, `words {text, at}`, `interrupted`, `turnEnd` and `end {reason, capped}`.
- **Charging:** each question is charged to the `chat` and `avatar` buckets, and the daily avatar budget is reserved and settled per turn.
- **Limits:** a conversation ends after 5 min, or after 60 s of silence. Cloud Run's `--timeout 900` covers it.

## Database changes
No database.

## Files to create
- `agents/atlas/app/dev_scripts/live_convo_spike.py`: the Phase A proof.
- `agents/atlas/tests/unit/test_live_conversation.py`.
- `assets/js/pcm-worklet.js`, `assets/js/agent-live.js` and `tests/pcm-worklet.test.mjs`.

## Files to change
- `agents/atlas/app/live_brain.py`:
  - `conversation_config()` (input transcription, VAD at `END_SENSITIVITY_HIGH` with 500 ms silence, context-window compression) and `LiveConversation`.
  - Tool results are now sent back together, one response per message, in `LiveBrainTurn` too.
- `agents/atlas/app/api.py`: the `/api/agent-live` route.
- `agents/atlas/Makefile`: `--timeout 900`.
- `assets/js/agent-avatar.js`: `pushBytes`, `interrupt`, `newTurn`, `convoState` ("hearing" = listening), and trimming of played media.
- `assets/js/agent-widget.js`: the controls row, conversation wiring, typed lines routed into the conversation, and end on close, clear or mode switch.
- `assets/css/components.css`: the controls, and the composer hidden mid-conversation unless Type is on.

## Measured (2026-09-29)
- **Phase A, Vertex:**
  - Voice-activity turn-taking works over a mic stream that never stops.
  - Seeded history isn't answered, and a follow-up uses it.
  - Barge-in fires `interrupted`.
  - Compression is accepted.
  - End of speech → first word is about 2.1 s.
  - Tool results sent one at a time made a two-tool question answered twice; sending them together fixed it.
- **Browser, end to end** (real widget, worklet and WebSocket to a local Atlas; the mic replaced by recorded questions):
  - Listening → Thinking → Speaking.
  - First spoken answer 2.1 s after the question ended.
  - The follow-up resolved.
  - The interruption was marked "Stopped" and logged `interrupted`.
  - The third turn completed.
  - End closed the session server-side.
  - 56 s, 4.6 MB of video, max lag 0.31 s.

## Rules for implementation
- CSS variables only. No npm or build step. Push-to-send stays the default.
- Model IDs come from `gcloud` only.
- Spoken words can't be unsaid: output checks only log. Model Armor doesn't cover Live sessions (spec 70).

## Definition of done
- [x] Unit tests: server 304, frontend 12.
- [x] Local end-to-end conversation as above.
- [ ] Production: deploy, set `ATLAS_LIVE_CONVO=1`, and test on Mac, the Windows work laptop (Netskope) and a phone, on real speakers. Check for self-interruptions caused by echo.
