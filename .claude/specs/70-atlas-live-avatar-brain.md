# Spec: Atlas Live Avatar Brain

## Overview
Avatar mode used two models in series: `gemini-3.6-flash` wrote the whole reply, then `gemini-3.8-live` read it aloud as a script. The avatar started about 5–7 s after a question, and every avatar turn paid for both models. With this spec, one `gemini-3.8-live` session answers directly: it gets Atlas's instruction (rewritten for speech) and all eleven Atlas tools, and speaks as it forms the answer. A session opened while the visitor types answers about 1.5 s sooner still. Everything is behind `ATLAS_LIVE_BRAIN=1`, so it can be switched off without a redeploy.

## Depends on
Spec 67 (avatar), spec 48 (voice input), spec 24 (meta protocol, text mode only).

## Routes
- `POST /api/agent-chat` with `avatar: true`: when `ATLAS_LIVE_BRAIN=1`, the turn goes to `app/live_brain.py` instead of the 3.6-flash script path.
  - It keeps the same SSE events (`avatarVideo`, `avatarWords`, `avatarEnd`, `done`), and the spoken words also go out as `delta`.
  - Prompt-injection attempts keep the text agent's fixed refusal.
  - If the Live session fails before a word is spoken, the turn becomes a normal text answer.
- `POST /api/agent-live/warm {sessionId}`: opens this visitor's Live session in the background. It has its own rate-limit bucket (`live_warm`, 16 per session and 24 per IP per day), a pool capped at 20 sessions per instance, and a 120 s expiry.

## Database changes
No database.

## Files to change
- `agents/atlas/app/api.py`: `_live_avatar_stream`, `_chat_history`, `_remember_live_turn`, the warm route, and the routing switch.
- `agents/atlas/app/rate_limit.py`: the `live_warm` bucket.
- `assets/js/agent-widget.js`: `warmLiveAvatar()` on typing or mic in Avatar mode, and the first word's start passed to the player.
- `assets/js/agent-avatar.js`: idle-only catch-up before the first word (the Windows delay).

## Files to create
- `agents/atlas/app/live_brain.py`: `SPEECH_INSTRUCTION`, `declarations()`, `ToolDispatcher`, `StreamTrimmer`, `LiveBrainTurn`, `WarmPool`.
- `agents/atlas/tests/unit/test_live_brain.py`.
- `agents/atlas/app/dev_scripts/live_brain_spike.py` (eval harness) and `capture_avatar_stream.py`.

## Decisions (measured, 2026-09-29)
- **Tools are the text agent's own.** The nine read tools come unchanged from `app/tools.py`. `send_resume` and `send_note_to_gaurav` call the same senders and the same note content check, bound to the session id because a raw Live session has no ADK `ToolContext`.
- **Vertex rejects** per-function `behavior` and `history_config`. Two answers to that:
  - The instruction forbids stating a fact, or a denial, before its tool result arrives. That fixed an intermittent "he holds no AWS certifications", which then came out right in 6 of 6 retries.
  - Earlier chat turns go in as plain prior turns in the same message, and follow-ups ("and AWS ones?") resolve correctly.
- **Grounding fixes from the eval:**
  - `get_projects(domain=)` now matches domain ids (spec 70 companion PR #151).
  - A filtered tool that finds nothing returns everything.
  - The instruction has explicit resume, note, build-story and "never deny what the data holds" rules.
- **Warm sessions** hand the browser only the header and the idle face since the last keyframe (`StreamTrimmer`). The browser never gets seconds of backlog or a hole in the timeline, and it jumps over the start offset.
- **One shared chat:** avatar turns are written to the ADK session as what was said, so Text and Voice mode follow-ups have the context.

## Rules for implementation
- All identity content lives in `content/profile.json`; the avatar reads it through the same tools.
- CSS variables only; no hardcoded hex.
- No npm, no bundler, no build step.
- Never state a model ID from docs; confirm with `gcloud ai model-garden models list --project=adk-deploy-trail`. Only `gemini-3.8-live` is avatar-capable there.

## Definition of done
- [x] 31 eval questions, typed: all grounded and correct. First word: median 1.85 s, slowest 10% at 2.1 s (spike, pre-opened session).
- [x] Real server, end to end: warm turn 1.9 s to the first word vs 3.6 s cold (server-side); a follow-up resolves from history.
- [x] Real widget in Chrome: warm-up fires on typing, first word 2.0 s from this laptop, the trimmed video plays (start delay 169 ms), and the captions are correct.
- [x] `uv run pytest tests/unit` (285) and `node --test` pass.
- [ ] Deploy with the flag off, turn it on with an env change, and compare `live-avatar:` log lines against today's avatar timing. Test on Mac, Windows and a phone.
