# Spec: Jev tour, a five-minute animated explainer

## Overview
A video-style page at `/tour/` that explains **Jev**, TypeSafe's first System 1 model. It plays like a
video, led by a guide panel: thirteen timed scenes, about 5:45 in total, with play, pause, scene jump and full screen. No
narration yet. Everything is on-screen picture and short text.

Story, in order:
1. The idea: who created System 1 and System 2 thinking (Kahneman, the 2011 book, and Stanovich and West who
   proposed the labels), what the two modes mean, then the driving analogy: the reflex (a ball rolls into the road, you brake before you think) is System 1,
   the route planner (an unfamiliar city, a road closed) is System 2. The point is latency: some decisions
   cannot wait for a plan, so do not ask the planner to brake. The next scene carries it on: Jev is the
   reflex, reasoning models are the route planner.
2. Where the models fit: Jev is System 1. Claude, ChatGPT and Gemini are System 2. Fast and cheap against
   slow and deep, with examples of what each is for.
3. What Jev is: a new class of model that does not write text. It returns typed answers with probabilities.
   This is where the customer-email example appears.
4. How a request works: state and questions in, typed answers out, all questions in parallel.
5. Where Jev fits in a system: between code and a reasoning model. Six examples shown visually.
6. The four primitives, one scene each with an example: Noul, Choice, Score, Box.
7. Trade-offs: five things you get, five you give up.
8. Close.

The earlier idea of a live Jev demo (a chat interface running real calls) is **dropped for now**. This page
makes no network calls and holds no key.

## Locked decisions
| Decision | Choice |
|---|---|
| URL | `/tour/` on the desk app, port 5180 locally (see Where it lives) |
| Format | Video-style, starts on Start Tour. One clock drives every scene, so play, pause and seek share one code path |
| Stage | Fixed 16:9 picture scaled as one unit. `1em` on `.stage` is 1% of its width, set with container query units |
| Logos | TypeSafe's own mark and wordmark in `assets/img/typesafe/`. Claude, OpenAI and Gemini marks reuse `assets/img/logo-*.svg` |
| Numbers | Only two facts from TypeSafe's docs are shown, and they are attributed: about 100 ms per call, $0.042 per million input tokens. Vendor speed multiples are never shown |
| Example outputs | Illustrative, and labelled so |
| Copy | Natural, no em-dashes (spec 90) |

## Routes
None in the backend. Static files only.

## Database changes
None.

## Files
Created in the desk project (`C:\Users\galahoti\desk`):
- `tour/index.html`, `tour.css`, `tour.js`, `tour-theme.js`, `tokens.css`, `README.md`, plus `img/`, `fonts/`,
  `audio/`.
- `scripts/tour-voice/` (`generate.mjs`, `package.json`): the narration generator.

Edited in desk: `server.py` (mount `/tour`), `.gitignore` (`.env.local`).

Edited here: `CLAUDE.md` (a pointer row).

## Behaviour
- Opens on a welcome frame (the finished title scene) and waits. The guide panel's **Start Tour** button
  starts playback from the top. Click the picture or press Space to pause.
- **Guide panel** (modelled on the Brain in a Jar tour panel): a glossy orb carrying the Jev mark, the scene
  label, one plain sentence for the current scene (`data-say` on each scene), previous and next scene, the
  primary button (Start Tour, Pause, Resume, Replay), full screen, a segmented progress bar (one button per
  scene, sized by length), a collapse chevron, and Exit Tour (back to `/ai-labs/`). It sits below the stage,
  never over it, and the stage resizes when the panel collapses.
- **Dark and light toggle** at the top right. Default is the OS setting, the choice is saved in
  `localStorage` (wrapped in try/catch), and `tour-theme.js` sets it before first paint so there is no flash.
  Light mode swaps the token set and inverts the white TypeSafe marks.
- Keys: Space or K toggle, Left and Right change scene, Home restarts, F full screen, T theme.
- Paused means still: CSS animations are paused too (WCAG 2.2.2). The orb only pulses while playing.
- `prefers-reduced-motion: reduce`: scene jumps open on the finished frame and reveals are opacity only.
  Playback starts only when the visitor presses Start Tour.
- Debug params: `?t=SECONDS` start there, `?pause` start paused, `?play` with `?t` start playing, `?hold`
  freeze the clock but keep CSS animations running with the panel hidden (for stills), `?theme=light|dark`.
- Portrait phones see a "turn sideways" note. The picture is a fixed landscape composition.

## Where it lives
**Not in this repo.** The tour is a folder of plain files, `tour/`, in the Reflex desk project (local clone
`C:\Users\galahoti\desk`), served by that app at `/tour/` (a `StaticFiles` mount in `server.py`). It was first
built here, then moved on request so it is hosted where the Reflex agent is hosted and never ships with the
portfolio's Pages deploy. This spec stays here because specs for Reflex live here (spec 96).

Local: from `desk`, `uv run uvicorn server:server --port 5180`, then `http://127.0.0.1:5180/tour/`. The server
does not auto-reload, so restart it after changing `server.py`. Or serve only the folder:
`cd tour && python -m http.server 5199`.

The folder is self-contained (`tokens.css` replaces the portfolio's `base.css`, with its own fonts and logos),
uses only relative URLs, and makes no network calls. "Exit Tour" links to the portfolio's AI Lab hub.

Note: `C:\Users\galahoti\reflex` is a separate agents-cli scaffold of the same project and is not the running
app. An earlier pass put the tour there by mistake and was reverted.

## Narration (ElevenLabs)
- Scenes opt in with `data-voice="audio/<file>.mp3"` (and optional `data-voice-at` seconds). The spoken text is
  the scene's own `data-say` line, so the guide panel shows exactly what the voice says.
- `scripts/tour-voice/generate.mjs` (desk project) finds the ElevenLabs voice whose name contains "gaurav",
  speaks each voiced scene, and writes `ui/tour/audio/*.mp3` plus a manifest. It skips clips whose text, voice
  and model are unchanged. It never falls back to another voice.
- `tour.js` plays the clip against the tour clock: starts at its offset, pauses with the tour, resumes and
  seeks in sync, stops when the scene ends. A sound button (key `M`) mutes it and the choice is remembered. If a
  clip is missing, the button disables itself and the tour plays silently.
- First voiced scene: "Meet Jev". Other scenes follow by adding the attribute and re-running the script.
- The key lives only in the desk project's git-ignored `.env.local`.
- **Blocked at the time of writing:** from the Deloitte network `api.elevenlabs.io` is answered with a
  certificate issued by `infoblox.com`, so TLS verification fails and no clip could be generated. It needs the
  host allowed by IT, or the script run from a network without that filter.

## Definition of done
- [x] `/tour/` has no console errors. Checked in both themes at 900x560, 1600x900 and 1920x1080.
- [x] Every scene fits the 16:9 frame at 1600x900 with nothing clipped.
- [x] Pause holds the clock. Seeking back resets a scene. The end shows replay. Checked with a stubbed-DOM run
      of `tour.js` (Chrome remote debugging is blocked on this machine, so no live browser clock check).
- [ ] Checked in a real browser at 1280x720 and in full screen, by eye, in both themes.
- [ ] Theme choice survives a reload (saved in `localStorage`).
- [ ] `prefers-reduced-motion: reduce` checked in a real browser.
- [ ] Deploy so `/tour/` is public. desk's Dockerfile copies only `./app`, so it also needs `server.py`, `static/` and `tour/` (including the audio clips) in the image.
- [ ] Generate the "Meet Jev" clip once `api.elevenlabs.io` is reachable, then listen to it.

## Open questions
1. Narration or a recorded voice track, and whether to export a video file for LinkedIn.
2. Whether the page gets an AI Lab card and an `/ai-labs/<slug>/` entry, or stays a standalone link.
3. Whether the live demo returns, and in which mode (replay of recorded runs, owner-only, or public).
4. Confirm "Jev is named after William Stanley Jevons". It is in the notes but not in any source read.
5. The origin scene says Kahneman won the 2002 Nobel Prize in Economics and published the book in 2011. Those
   two facts come from general knowledge, not from the sources read. The Stanovich and West credit is sourced
   (Kahneman credits them himself). Stanovich now prefers "Type 1 and Type 2", which the scene softens with
   "a way to think about thinking, not two parts of the brain".
