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

A video card rises out of the Atlas launcher corner (bottom-right, same
surface as `agent-widget.js`'s FAB/panel). It does not replace the hero
portrait — a second face there would confuse visitors about who's who.

- **First visit only:** after the page settles, the card slides up and plays
  a muted, captioned clip ("Hi, I'm Atlas, Gaurav's AI agent…"). A speaker
  button turns on sound. Remembered in `localStorage` so it greets once.
- **Chapter chips:** *Who is Gaurav · How this site was built · What I can
  do*. Each plays its own short clip. No live model call is involved —
  these are pre-recorded, not a conversation.
- **Ask me anything** hands off to the existing Atlas chat panel
  (`agent-widget.js`'s `openPanel`, loading the widget module if it isn't
  loaded yet).
- **Respect reduced-motion / save-data:** a poster image with a play button
  replaces autoplay; the card doesn't self-open at all on save-data.
- **Labeled honestly:** a small "AI avatar, generated with Gemini" caption
  sits on the card. (Google also embeds a SynthID watermark in the output,
  independent of this label.)
- **Mounts wherever the chat widget mounts:** home page and `/live-agents/`.

## Avatar & clip production (manual, not run by this spec's code)

The avatar identity (which prebuilt avatar, which voice) is picked by hand
in Console → Agent Platform → Studio → Stream realtime, model
`gemini-3.8-live`, Live Avatar panel — Google doesn't publish the gallery
anywhere else. `content/avatar.json`'s `avatarName`/`voiceName` are
placeholders (documented example values `"Ben"` / `"Puck"`) until that pick
is made; nothing here is deployed with placeholders live.

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
