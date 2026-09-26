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
- **Phase 2 (a live, talk-back session) is out of scope for this spec.**
  It needs a WebSocket proxy in `agents/atlas`, a D1-backed invite-code and
  spend-cap system, and a security review, all before it can run safely.
  This spec deliberately stops at the recorded experience so that piece can
  be scoped and reviewed on its own.

## Design

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

- [ ] `content/avatar.json` holds the avatar identity and the four chapter
      scripts (voice rules: no em dashes, plain tone; "how it was built"
      draws on `content/build-story.json`).
- [ ] `assets/js/avatar-greeter.js` renders the card, chips, first-visit
      logic, reduced-motion/save-data fallbacks, and the handoff to
      `window.__agentWidget.open()`.
- [ ] Booted from `main.js` on idle, same pattern as
      `initAgentWidgetWhenIdle`, mounted at `#avatar-root` in `index.html`
      and `live-agents/index.html`.
- [ ] `assets/css/components.css` card styles use existing tokens only
      (`--bg-elev`, `--border-strong`, `--radius-lg`, `--accent-glow`).
- [ ] `agents/atlas/app/dev_scripts/record_avatar_clips.py` exists and is
      documented, but the actual `assets/video/atlas-*.mp4` clips are
      produced and committed separately once Gaurav has picked the avatar
      in Console and provided (or run) the recording pass.
- [ ] No CSP change needed — clips are same-origin,
      `media-src 'self' blob:` already covers them.
- [ ] `node --test 'tests/**/*.test.mjs'` still passes; Lighthouse
      Performance ≥ 90 / FCP < 1.5s on `/` (card must not load before idle).
- [ ] Follow-up spec opens Phase 2 (live talk-back) once Phase 1 has shipped
      and the avatar identity is final.
