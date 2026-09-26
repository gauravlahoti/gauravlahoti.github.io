# Spec 67 — Atlas gets a face (Gemini 3.8 Live Avatar)

## Problem

Google shipped Gemini 3.8 Live with Live Avatar (GA on Vertex, 2026-09-24):
a real-time, lip-synced talking-head video alongside the model's voice
(`response_modalities: ["VIDEO"]`, `avatar_config`). Nothing on this site
gives Atlas a visual presence today — it is a text/audio widget with no face.
The ask is a landing-page moment strong enough to be worth a LinkedIn post,
without opening a new cost or safety surface that runs unattended.

## Decisions

- **Atlas keeps its own face. This is not Gaurav's likeness.** Custom avatars
  (`avatar_config.customized_avatar`) are allowlist-only, requested through a
  Google Cloud account team, with no guaranteed approval or timeline. The
  hero portrait stays exactly as it is; nothing about Gaurav's own photo
  changes.
- **Phase 1 ships a recorded greeting first.** A short, scripted clip costs
  nothing to serve (same-origin video, no runtime API calls) and can't go
  off-script in front of a recruiter.
- **Phase 2 (a visitor talking to the avatar by voice) is out of scope.**
  It needs a WebSocket proxy in `agents/atlas`, a D1-backed invite-code and
  spend-cap system, and a security review, all before it can run safely.
  This spec deliberately stops at the recorded experience so that piece can
  be scoped and reviewed on its own.

## Design

*The layout parts of this section (compact 64px face, caption line) were superseded by "Live answers, as a video call" below; the mode switch and voice-precedence rules still hold.*

**Revised during implementation** (Gaurav's review): a floating card that
popped up on its own overshadowed Atlas, and its topic chips duplicated the
prompt chips Atlas already has. So the avatar is now a *mode of Atlas*, not a
separate surface.

- **A Text / Voice / Avatar mode switch** is the panel header's second row.
  It replaces the bare speaker icon (two unlabelled icons read as unclear in
  review): a segmented control with a gliding lit segment, a live equalizer
  on Voice while Atlas talks, and a small beacon on Avatar until it's been
  tried. It drives the existing spoken-reply code (specs 49-62) rather than
  replacing it; the old speaker button stays in the DOM, hidden, as the
  state holder that code already reads. Avatar is remembered in
  `localStorage` (`atlasAvatarMode_v1`); Voice keeps its own spec-49 pref.
- **In Avatar mode the stage is the header's third row**: a 64px face (4:5
  crop of the 9:16 clip) and a two-line live caption. One surface, one
  divider; the transcript's top edge fades under it instead of being cut.
  No buttons of its own beyond a play overlay. Atlas's existing prompt chips
  already cover the topics, so only the greeting clip ships (the three
  topic clips were recorded but dropped as duplicates).
- **Turning it on plays the greeting with sound** (the toggle is the user
  gesture). Reopening the panel later restores the stage on its poster
  without replaying.
- **Atlas's voice wins.** Sending a message, Atlas starting to speak,
  minimizing or closing the panel all pause the avatar; the avatar starting
  a clip cancels Atlas's TTS. Two voices never overlap.
- `assets/js/agent-avatar.js` is lazy-imported by `agent-widget.js` only
  when the mode is turned on, so plain chat pays nothing.
- It resolves `content/avatar.json` and clips against the site root, so it
  also works where the widget mounts on `/live-agents/`.
- Labelled honestly: "Atlas · AI avatar", tooltip "Generated with Gemini
  3.8 Live Avatar". (SynthID is embedded in the video regardless.)

## Live answers, as a video call

Review feedback drove four revisions, in order: the TTS voice spoke while the
face sat still (wrong); text appeared twice (caption plus transcript); the
thinking indicator appeared twice (face plus transcript); and Avatar mode
should be the avatar plus a transcript and nothing else. The result:

**Avatar mode is a video call.** The face fills the panel (240x300, 4:5
anchored at the top so the whole face and mouth stay in frame). The only text
is a centred transcript of what the avatar says, appearing as it says it,
with the visitor's questions quieter above. Chips, sources, badges, the CTA,
the intro message, loading dots, "still on it" copy, the thinking panel and
the reading-aloud strip are hidden in Avatar mode (CSS only; Text and Voice
bring them all back). A tag on the video is the single status: live,
thinking, speaking.

**The face never looks recorded or frozen.** At rest it plays a muted 12s
ping-pong loop cut from a live idle session (274 KB). The greeting plays once,
with sound, when Avatar is picked, and its words land in the transcript like
any answer. No "hear my intro" button.

**One stream per turn, no second request.** In Avatar mode the chat request
carries `avatar: true`, and `_with_avatar` in `api.py`:
1. opens the Live session the moment the turn starts, in parallel with the
   agent thinking, and relays its idle video straight away;
2. hands the reply's cleaned speech text to that already-open session as a
   script the moment the reply is written (verbatim, 28/28 words measured);
3. relays `avatarVideo` (base64 fMP4) and `avatarWords` (the avatar's own
   speech transcription, which is the transcript) on the same SSE stream,
   holding the text stream's `done` until the avatar finishes.
The browser plays the frames on a second <video> layered over the idle loop,
fading in on its first frame, so the face never blanks while the session
spins up.

**Only Atlas's own words.** The server only ever speaks the reply it just
generated, so there is no endpoint that can be made to say arbitrary text,
no signing scheme, and no secret to deploy. (An earlier iteration had a
separate signed endpoint; it was removed when the stream merged.)

**Caps (decided: public with hard caps).** Per visitor, the `avatar` bucket:
3 turns / 24h per session and per IP. Per day, `AvatarBudget`: 13
speaking-minutes (about $5 at $0.37/min), reserved at 30s per turn and
settled to measured speaking time; per instance, so the ceiling is budget x
max-instances (5), about $25/day worst case. A refusal becomes
`avatarUnavailable` up front and the widget reads that turn aloud with the
TTS voice instead, with a note. Any avatar failure before it speaks does the
same; a failure mid-answer just ends the face.

**Voices never overlap.** Avatar turns do not feed the TTS speaker; the
avatar starting cancels TTS; send, Stop, minimize and close end the face.

## Latency (the "lightning fast" pass)

Measured on adk-deploy-trail, full Atlas prompt, 2026-09-26:

| | first answer text |
|---|---|
| gemini-3.6-flash | ~1.3-1.5s, consistent |
| gemini-3.5-flash-lite | ~1.4-1.5s (no faster: ~1.3s is this prompt's floor) |
| gemini-3.7-flash | 1.7-3.4s, with queueing spikes to 40-112s |
| gemini-3.8-flash | 3.7-16s at LOW, ~1 in 4 calls failed, MINIMAL unsupported |

Findings:
- The spikes were Vertex queueing, not retries (the primary already ran with
  `attempts=1`), so the 429/503 cascade never fired; it just waited.
- Prompt size is not the lever: the 53.6k-char instruction (~13.4k tokens)
  is implicitly cached by Vertex (10,210 cached tokens per turn), and a 2k
  prompt was no faster. No prompt surgery.
- Thinking level made no measurable difference on 3.6.

Changes:
- **Cascade is now 3.6-flash -> 3.5-flash-lite -> 3.7-flash** (was 3.7 ->
  3.6). Promote 3.8 once its latency settles.
- **First-token watchdog** in `FallbackGemini`: on a streamed turn, a model
  with somewhere to fall back to gets 4s to produce its first chunk before
  the turn moves on. Only the first chunk is timed, so a started answer is
  never cut off; the last model is never timed out.

End to end, Avatar mode (send to the avatar's first spoken word): about 6s
for a no-tool turn and about 9-10s when Atlas makes a tool call, down from
11-100s+. The floor is the avatar itself: ~2.8s session open plus ~2.6s
before its first frame. Beating that needs a pre-warmed session, which is
not built: if idle avatar video is billed, an always-open session could cost
hundreds of dollars a day, so it waits on confirming billing.

## Review round: isolation, karaoke, and clean text

- **The three modes are exclusive.** Picking Avatar silences the TTS speaker
  (without touching its saved preference, so Voice comes back as it was);
  opening the panel restores one mode, never two; an avatar turn that can't
  be spoken (cap, error) shows as text with a note and is never read by the
  TTS voice. Previously the voice ran behind Avatar as a fallback, which
  read as two modes on at once.
- **Each mode renders the whole conversation its own way.** Avatar turns show
  their karaoke transcript in Avatar mode and the full formatted reply
  (citations, sources) in Text or Voice. The greeting exists only in Avatar
  mode. The transcript uses the same message format as Text and Voice
  (left-aligned, paragraphs, the usual question bubble); centred captions
  were tried and dropped in review.
- **Karaoke captions.** Each chunk of the avatar's words is stamped with the
  live video's buffered edge when it arrives and lights up when playback
  reaches it: spoken words read normally, the current words glow, upcoming
  words wait dimmed. The greeting does the same from its caption cues.
- **Captions are the script, not raw transcription.** The Live API's output
  transcription drops spaces between chunks and never sees paragraph breaks,
  so `ScriptAligner` matches each chunk against the script the avatar is
  reading (whitespace-insensitive) and emits the script's own slice. A chunk
  it can't place passes through spaced and is never repeated.
- **Thinking level LOW by default** (`ATLAS_THINKING_LEVEL` still overrides).
  On real questions MEDIUM spent 140-980 thinking tokens, about 4-6s of
  silence before the first word; LOW spends ~20-40. Resume and note routing
  and the injection refusal were re-checked on LOW.
- **`LeadNoteGuard`.** At LOW the model sometimes writes the prompt's
  required working note ("Availability question, calling get_profile...")
  into the reply instead of its thinking. The guard holds only the reply's
  opening until it can tell, diverts a matching note to the Thinking panel,
  and keeps it out of speech, captions and the audit log.

Measured end to end on the final config (local Atlas, warm): first word
3.6-4.1s; the avatar speaking 6.3-7.8s after send on real questions.

## Review round: greeting and the daily cap

**Greeting re-recorded.** It now only says who Atlas is and what it can do
(his experience, projects and agents, certifications, emailing the resume,
passing a note), with no build story and no "tap a topic", since Avatar mode
has no topic chips. Script in `content/avatar.json`. The recorder now sends
the script as the user turn under the live path's `SCRIPT_INSTRUCTION`
(the old "script in the system prompt, then 'Go ahead'" could improvise),
takes `--only <chapter>`, and the clip is trimmed of its ~0.75s of leading
silence. Caption cues are timed to the pauses `silencedetect` finds, which
also confirm the sentence structure was read verbatim.

**The greeting plays once per visitor.** Only the first pick of Avatar
plays it (`atlasAvatarGreeted_v1` in `localStorage`). Switching back to
Avatar later, re-picking it, or reopening the panel goes straight to the idle
face, like rejoining a call rather than restarting it.

**Stop and Clear, in every mode.** The send button is the one Stop control:
it shows Stop while a reply streams and also while Atlas is still talking
afterwards, by voice or as the avatar (the greeting included), and Escape
does the same. Typing a new question turns it back into Send. A **Clear
conversation** button (trash icon) appears in the header once there is a
conversation: it stops everything, empties the transcript, starts a fresh
server-side session (new `sessionId`, since Atlas keeps history per session)
and brings back the intro. Clearing mid-answer stops the turn first and
clears once it has wound down, so late callbacks can't leak into the new
conversation. Note: after a clear, `agent_interactions.session_id` no longer
matches the page view's id for that visitor.

**Over the cap, offer Voice for the same question.** A capped avatar turn
(per-visitor bucket or the daily budget) no longer runs the agent and shows
the answer as text. The server replies with only
`avatarUnavailable {reason, capped: true}` and `done`, so the question is
never paid for twice or put in the session history twice. The widget drops
the empty turn and shows a card under the question: "You've reached today's
avatar limit. Want me to answer this in Voice mode instead?" with **Switch
to Voice** and **Show as text**. Either button switches modes (the click is
Voice's audio gesture) and asks the same question again, so nobody retypes
it. After that, further Avatar-mode questions go straight to the card
without a request.

## Avatar & clip production (manual, not run by this spec's code)

Clip facts from the recording pass: Live API video arrives as fragmented
MP4 (one `ftyp`/`moov`, then `moof`/`mdat` pairs), H.264 704x1280 + AAC, at
roughly 8 Mbps. Concatenated parts are a valid single stream. For the web it
is re-encoded to 432x768, x264 CRF 27, 64k mono AAC, `+faststart` (13 MB ->
~520 KB), with a webp poster taken at 4s (frame 0 catches a furrowed brow).

The avatar identity (which prebuilt avatar, which voice) is picked by hand
in Console → Agent Platform → Studio → Stream realtime, model
`gemini-3.8-live`, Live Avatar panel — Google doesn't publish the gallery
anywhere else. **Confirmed:** avatar `Sam`, voice `Puck`, both set in
`content/avatar.json`.

`agents/atlas/app/dev_scripts/record_avatar_clips.py` is a one-off dev tool
(not part of the deployed service) that opens one `google-genai`
`client.aio.live.connect(model="gemini-3.8-live")` session per chapter with
`avatar_config` + `response_modalities: ["VIDEO"]`, feeds it the exact
script under a "say this verbatim" system instruction, and writes the
resulting video + a `.vtt` caption track to `assets/video/`. It needs a
real Vertex access token to run — that's a Gaurav-side step, not something
executed as part of implementing this spec.

## Definition of done

- [x] Text / Voice / Avatar switch in the Atlas header drives the existing
      spoken-reply code; Avatar is opt-in and remembered.
- [x] Avatar mode is a video call: face fills the panel, centred live
      transcript, nothing else; Text/Voice unchanged.
- [x] Idle loop so the face never looks frozen; greeting once, transcribed.
- [x] Live answers on the chat's own SSE stream, session opened in parallel
      with the agent, idle frames relayed, cross-fade in, verbatim speech.
- [x] Per-visitor cap and daily budget; over the cap, a card offers Voice
      (or Text) and re-asks the same question there.
- [x] Greeting says who Atlas is and what it can do, nothing about the build.
- [x] Model cascade 3.6-flash -> 3.5-flash-lite -> 3.7-flash plus a
      first-token watchdog, with measurements recorded above.
- [x] Unit tests: stream merge, fallback, budget, watchdog (169 pass);
      frontend tests pass; verified end to end against a local Atlas.
- [ ] Deploy Atlas (needs sign-off). No new secrets or env vars are needed.
- [ ] Confirm on the Cloud Billing report whether idle avatar video is
      billed before building a pre-warmed session.
