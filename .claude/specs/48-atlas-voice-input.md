# Spec 48: Atlas voice input

## Overview

On mobile, typing a question into a 44px composer is the main friction point
between a visitor landing on the site and actually asking Atlas something.
This adds a mic button to the composer: tap, speak, tap again, and the
transcript lands in the textarea for the visitor to review and send.

This is ears only, not a voice conversation. Atlas's replies stay text-only —
there is no TTS, no Live API hands-free mode, and no interpreter/translate
model in this design. A full voice pipeline is three stages (speech-to-text →
LLM → text-to-speech); this spec builds the first stage only, and reuses the
existing text reply path for the rest.

## Depends on

- Spec 21 — the agent widget and its composer (`renderShell`, `sendCurrent`).
- Spec 45 — WebMCP's `draft_note_to_gaurav`, which established the invariant
  this reuses: a real human keystroke is always required to actually send a
  turn. Voice input must not become a second way to bypass that.
- Spec 47 — the send button's `data-mode` glyph-swap pattern, cloned here for
  the mic button's idle/recording/busy states.

## Routes

- `POST /api/agent-transcribe` (new, `agents/atlas/app/api.py`) —
  `{"sessionId": str, "mimeType": str, "audio": base64 str}` →
  `200 {"text": str}` | `400` bad input | `429` voice budget exhausted |
  `502` transcription unavailable. Never calls `lookup_geo` or
  `log_interaction` — a transcription isn't a chat turn.

## Approach

**Why a dedicated STT model and not the multimodal model Atlas already
runs.** `gemini-3.7-flash` can transcribe audio — this isn't a capability
gap. But it's a reasoning model: asked to transcribe "um, so what did he, uh,
do at Deloitte," it decides what to keep as a byproduct of reasoning.
`gemini-3.5-transcribe` has two switches Flash has no equivalent for:
`mode: "SMART"` strips fillers and self-corrections as a model setting, and
`customVocabulary` (≤1,000 terms) biases recognition toward this site's
proper nouns ("Deloitte", "Topmate", "ADK", "Gaurav Lahoti"). Every visitor
gets 4 chat questions; a mangled transcript wastes one.

**The pinned SDK can't express that config, so this calls Vertex REST
directly.** `google-genai` 1.74.0 (pinned via `google-adk`) has
`types.AudioTranscriptionConfig` with only `language_codes` — that's the
*Live API's* config, a different thing — and `GenerateContentConfig` has no
`audio_transcription_config` field at all. `mode` and `customVocabulary` are
unreachable through the SDK at this version. Bumping `google-genai` to chase
one endpoint means moving a transitive dependency of `google-adk` and
revalidating the eval gate, so `app/app_utils/transcribe.py` calls
`aiplatform.googleapis.com` with `httpx` instead — already a dependency, and
the same pattern every other `app_utils` helper uses (`geo_lookup.py`,
`resume_send.py`). Noted as deferred cleanup below.

**The publisher model ID has a `-preview` suffix Google's own docs don't
mention.** The 2026-08-26 GA announcement and public docs call it
`gemini-3.5-transcribe`, which 404s in every Vertex location tried (`global`,
`us-central1`, `us`, `eu`) on `adk-mas-demo` — looked at first like a
project-access/allowlist gap. It wasn't: `gcloud ai model-garden models list`
against this project shows the actual catalog entry as
`gemini-3.5-transcribe-preview` (`CAN_PREDICT: Yes`), and that ID returns 200
immediately, custom vocabulary and all. `TRANSCRIBE_MODEL` is set to the
`-preview` name; worth re-checking Model Garden if a future bare
`gemini-3.5-transcribe@default` entry appears.

**The `FALLBACK_MODEL` cascade exists for the same reason
`FallbackGemini`'s does — model-availability redundancy, not because the
primary is currently unreachable.** `transcribe_audio()` tries
`TRANSCRIBE_MODEL` first and falls back to `gemini-3.7-flash` (the same model
Atlas's chat already runs) only on a 404/429/503, with an instruction prompt
asking it to drop fillers as a best-effort substitute for real SMART mode if
the fallback ever fires.

**Auth forces Vertex on `adk-mas-demo`, not the ambient `GEMINI_API_KEY`.**
`app/fallback_model.py` pins Atlas's chat model there because the AI Studio
free tier hit near-100% 503s in production. A transcribe route reading
`GEMINI_API_KEY` would inherit that failure mode and the AI Studio spend cap.
`ATLAS_VERTEX_PROJECT`/`ATLAS_VERTEX_LOCATION` were promoted to public names
in `fallback_model.py` (private aliases kept) so `transcribe.py` reuses the
same constants instead of re-declaring the project id.

**Batch unary, not Live API streaming.** Tap mic → record → tap stop → one
POST. The WebSocket lane (`gemini-3.5-transcribe-live`) needs ephemeral
tokens, an AudioWorklet doing PCM16 downsampling, and reconnect handling for
a marginal UX gain on ~15-second clips — deferred, see below.

**Transcript fills the composer, never auto-sends.** The mic's `onTranscript`
callback calls the existing `prefillComposer()` — the same function spec 45's
`draft_note_to_gaurav` WebMCP tool uses — which already guards on `isPending`,
focuses the textarea, and moves the caret to the end. This also lets a
visitor fix a misheard word before spending one of their 4 daily questions.

**Voice gets its own rate-limit bucket, separate from chat.** `rate_limit.py`
generalised from a single hardcoded 4/24h shape to a `BUCKETS` table keyed by
name, with `check_and_record(..., bucket="chat"|"voice")` defaulting to
`"chat"` so the existing call site is untouched. `chat` stays 4/24h per
session and per IP-hash; `voice` is 12/24h — transcribing must never spend a
chat question, and re-recording after a bad transcript is normal, expected
usage, not abuse.

**Mic button clones the send button's established pattern.** Two SVGs
(mic glyph, stop-square glyph) in one 44×44 button, `data-mode` picking which
renders — same zero-layout-shift trick as spec 47. Secondary styling
(transparent, muted border) keeps the cyan send button the row's one primary
action. `recording` mode gets a soft accent-cyan pulse; `busy` (transcribing)
mode reuses the send button's orbiting-arc `::after`. **Not** `--danger` red
for the recording state — `CLAUDE.md` scopes that token to "error /
destructive / broken-wire states only," and recording is neither.

**Hidden, not disabled, when the browser lacks the APIs.** A synchronous
check (`navigator.mediaDevices.getUserMedia` + `window.MediaRecorder`) at
widget init adds `is-hidden` to the mic button outright — no dead control for
Firefox visitors.

**Recording engine is a separate, lazily-imported module.** `agent-voice.js`
is only `import()`ed on the first mic tap, mirroring how `main.js` defers
`agent-widget.js` itself — MediaRecorder code never ships in the initial page
payload. It reuses `agent-widget.js`'s own `?v=` (read off `import.meta.url`,
same `_selfV`/`_vq` pattern `agents-page.js` already uses) for its own
cache-bust, rather than being pinned to whatever the browser cached first.

**Stopping every media track is not optional.** `agent-voice.js` calls
`stream.getTracks().forEach(t => t.stop())` the moment recording ends — this
is what clears the browser's recording indicator. Skipping it would leave the
tab looking like it's still listening after the visitor is done, which is the
single most damaging thing this feature could do to trust. Closing the panel
mid-recording also disposes the voice engine and resets the mic to idle, so
dismissing the widget can't leave the mic live in the background.

**30-second hard cap, client-side.** A recording auto-stops and transcribes
whatever was captured; the server independently caps the base64 payload at
~1.6MB (roughly 3x the client cap) so a crafted request can't post an
oversized body straight into a Gemini call.

## Files changed

- `agents/atlas/app/app_utils/transcribe.py` (new) — Vertex REST call with
  cascade fallback, MIME normalization/allowlist, cached ADC credentials,
  static `CUSTOM_VOCABULARY`.
- `agents/atlas/app/fallback_model.py` — promoted `_ATLAS_VERTEX_PROJECT`/
  `_ATLAS_VERTEX_LOCATION` to public `ATLAS_VERTEX_PROJECT`/
  `ATLAS_VERTEX_LOCATION` (private aliases kept for existing references).
- `agents/atlas/app/rate_limit.py` — `BUCKETS` table replacing the hardcoded
  4/24h shape; `check_and_record(..., bucket="chat")` default keeps the
  existing call site working unchanged.
- `agents/atlas/app/api.py` — `POST /api/agent-transcribe` route; header
  contract comment updated to document all four routes.
- `assets/js/agent-voice.js` (new) — recording engine: `isVoiceSupported()`,
  `initVoiceInput()` returning `{start, stop, dispose}`.
- `assets/js/agent-widget.js` — `voiceInput` feature flag, mic button +
  status-line DOM in `renderShell()`, `setMicMode()` state machine,
  `startVoiceInput()` lazy-import wire-up, mic disabled while a chat turn
  streams, mic disposed on panel close, `_selfV`/`_vq` cache-bust helper for
  the nested `agent-voice.js` import, `transcribeApiUrl` derived from the
  existing `agentApi` link.
- `assets/css/components.css` — `.agent-mic` and its three `data-mode`
  states, `.agent-voice-status`, `flex-wrap: wrap` on `.agent-input-row` so
  the status line wraps onto its own line.
- `index.html`, `assets/js/main.js`, `live-agents/index.html`,
  `ai-labs/index.html` — cache-bust bumps (`agent-widget.js`/
  `components.css` are lazy-loaded with a `?v=` query; `agents-page.js`'s own
  bump propagates to its `agent-widget.js`/`agent-voice.js` imports via
  `_vq`).

## Rules for implementation

- Reuse `prefillComposer()` — never introduce a second "set the composer
  text" path.
- Never read `GEMINI_API_KEY` in the transcribe route; always force
  Vertex/`adk-mas-demo` via `fallback_model.py`'s constants.
- Never spend a chat rate-limit slot on a transcription attempt.

## Definition of done

- Mic button renders in the composer (idle state) on both `/` and
  `/live-agents/`, styled as a secondary control next to the cyan send
  button. Verified visually.
- Tapping mic requests permission, then flips to a pulsing recording state
  with a "Listening… 0:0N" status line; tapping again (or hitting the 30s
  cap) flips to a transcribing state, then the transcript lands in the
  composer, focused, caret at the end — **not sent**. Verified end-to-end via
  curl and directly against `transcribe_audio()`, confirming
  `gemini-3.5-transcribe-preview` (not the fallback) handles the request and
  applies custom-vocabulary biasing correctly (permission-gated browser flow
  could not be driven by the available automation in this environment — no
  real or virtual microphone in that sandbox, so `getUserMedia` never
  resolves; the harder, riskier leg — POST → Vertex → transcript — was
  verified directly).
- Every media track stops the instant recording ends or the panel closes —
  no lingering browser recording indicator.
- Denying mic permission shows an inline "Mic blocked" status, no thrown
  error, mic returns to idle.
- Mic is inert (disabled) while a chat turn is streaming.
- `prefers-reduced-motion: reduce` freezes both the recording pulse and the
  transcribing arc.
- Voice requests get a 429 after 12 in 24h (session or IP), and a chat
  question on the same session still works — independent buckets. Verified
  via curl: 12 successful transcribes, 13th blocked, subsequent
  `/api/agent-chat` on the same session succeeds.
- Oversized body, unsupported MIME type, missing fields, and empty audio all
  return 400. Verified via curl.
- Backend unit + integration tests pass (`uv run pytest tests/unit
  tests/integration`).
- Browser lacking `getUserMedia`/`MediaRecorder` never renders the mic
  button (hidden, not disabled).

## Deferred

- Live streaming transcription via `gemini-3.5-transcribe-live` with partial
  captions rendering as the visitor speaks. The `/api/agent-transcribe`
  contract doesn't need reworking to add this later.
- Bumping `google-genai` past 1.74.0 to use the typed
  `AudioTranscriptionConfig` surface instead of raw REST, once the ADK pin
  can absorb it and `gemini-3.5-transcribe` is reachable from this project.
- TTS / spoken replies (box 3 of the full STT → LLM → TTS pipeline) and any
  hands-free continuous-conversation mode. Both are a different, larger
  feature than what this spec builds.
