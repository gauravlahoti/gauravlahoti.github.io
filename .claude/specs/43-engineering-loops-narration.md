# Spec 43: Engineering Loops — Step-by-Step Voice Narration + Captions

## Overview
Adds natural-language, human-sounding narration to the Engineering Loops lab
(`/ai-labs/engineering-loops/`, spec 42): one spoken line per existing `put()` step reveal
in each layer (prompt 7, context 5, harness 8, loop 7), synced to that step's visual
fade-in, with always-visible on-screen captions. Each layer's own repeating GSAP-cycle
animation continues silently/ambiently after the one-time narrated walkthrough — inner
beats (context's gather/FULL/summarize, harness's task-tick/compaction legs) are not
individually narrated in this pass.

## Locked decisions
| Decision | Choice |
|---|---|
| Voice | Pre-recorded natural voice audio via **ElevenLabs**, generated once as a content-authoring step (not browser `speechSynthesis`, not runtime generation) |
| Granularity | Step-level only — one line per `put()` step, matching step call order exactly |
| Captions | Always visible, panel below the stage and above `.loops-controls` (never overlaid on the diagram) |
| Audio hosting | In-repo, `assets/audio/engineering-loops/<layerId>-<01-based index, zero-padded 2>.mp3` (convention-derived filename, no field in JSON) — follows the resume-PDF/SVG static-asset convention, not the GCS-bucket-for-video pattern |
| Replay behavior | Narration replays from step 0 every time a layer is (re)focused — matches today's visual-stagger behavior, no one-time-per-visit gating |
| Reduced motion | All of a layer's captions show at once, statically; no audio autoplay; voice toggle stays manually usable |

## Content — `content/engineering-loops.json`
**Done.** Each `layers[]` entry has a new `narration: [{text}, ...]` array co-located with
`analogy`, one line per that layer's `put()` step order (verified: prompt 7, context 5,
harness 8, loop 7 = 4 fixed + 3 chips). New `ui.voiceOn`/`ui.voiceOff` labels added
(`"Narrate"` / `"Mute narration"`, matching MCP Lab's strings).

## Playback engine — new module `assets/js/engineering-loops-narration.js`
**Not yet built.** Kept separate from `engineering-loops.js` (~1400 lines already), lazy-imported
like `posts-list.js`, deriving its own `?v=` from `import.meta.url`.

Contract: `createNarration({ content, ui }) → { mount(controlsEl) → panelEl, playLayer(id, flat, { onStepStart, onDone }), stopLayer(), showAllCaptions(id, flat), unlock(), destroy() }`. `flat` is `refs.steps[id]`, passed in by the caller — this module never touches `buildAll()` internals.

- **Sequencing**: one reusable `<audio>` element. Per step `i`: `onStepStart(i)` (caller fades in `flat[i]`, same `0.6s`/`power2.out` as today), caption `i` → `.is-active`, `audioEl.src` = convention path, `.play()` if voice on + unlocked. Advance on `ended` (primary), `error` (fallback), or ~12s safety timeout. If voice off/not unlocked/`play()` rejects: advance after `Math.min(1.3, Math.max(0.85, 7/flat.length))` (today's stagger formula), so caption-only playback looks like today's stagger. After the last step, call `onDone` (→ `startLayerAnim(curId)`, replacing `g.delayedCall(revealDur, startAnim)`).
- **Voice toggle**: `.loops-voice-btn` in `.loops-controls` next to `tourBtn`, mirrors MCP Lab's `voiceBtn` (default-on, hidden if `Audio`/content unavailable, `.is-on` styling).
- **Autoplay unlock**: must run synchronously inside the real gesture, not inside `whenGsap(...)`'s deferred callback (up to 900ms lag breaks Safari's same-call-stack rule).
  - Begin-button click handler (`engineering-loops.js:1404-1409`): `narration?.unlock();` as the first line, before `whenGsap(() => focusLayer(0))`.
  - Deep-link entrance (no Begin click, `engineering-loops.js:1386-1392`): one-time `pointerdown` on `lab` calling `unlock()`, mirrors MCP Lab's `onFirstGesture`. Until it fires, narration is caption-only for whichever layer loads first.
- **Interruption**: `stopLayer()` (pause + reset `currentTime` + clear safety timer + kill in-flight fade tween) called from `clearAnim()` (`engineering-loops.js:616-619`) and `destroy()`.
- **Tour mode** (`TOUR_DELAY`, `engineering-loops.js:1346-1365`): `onDone` schedules `tourStep()` after a short fixed hold (~3s) instead of `setTimeout(tourStep, TOUR_DELAY[id])`, only while `tourPlaying`. Keep `TOUR_DELAY` as fallback for any layer with no narration.
- **Reduced motion**: `showAllCaptions(id, flat)` — all captions shown at once, statically, no audio autoplay.

## Integration points in `assets/js/engineering-loops.js`
**Not yet done.**
- New state: `let narration = null;`, set after lazy `import()` guarded by `content.layers.some(l => l.narration?.length)`.
- `playAdditive(i)` (`628-682`): replace the `g.to(flat, {opacity, duration, stagger, ...})` block with `narration ? narration.playLayer(...) : <existing stagger, unchanged, as fallback>`. Add `narration?.showAllCaptions(curId, flat);` to the `REDUCE_MOTION`/no-gsap early return (line 665).
- `clearAnim()` (`616-619`): add `narration?.stopLayer();`.
- `destroy()`: add `narration?.destroy();`.
- Begin-button handler + deep-link branch (`1386-1409`): wire `unlock()`.
- `tourStep()`/`startTour()` (`1347-1365`): completion-driven advance.
- `buildAll()`, `revealDemarcation()`, `startLayerAnim()` (`563-611`): unchanged.

## CSS — `assets/css/engineering-loops.css`
**Not yet done.** New section after `.loops-controls` block (~line 366): `.loops-narr` panel
(bg-card/border, same treatment as `.loops-chart-plot`), `.loops-narr-list`/`.loops-narr-line`
(counter-numbered like MCP Lab's `.mcp-narr`), `.loops-narr-line.is-active`, `.loops-voice-btn`
(32px circular, matches `.loops-max`/`.loops-zoom-btn` sizing) + `.is-on` state. Add sizing to
the existing `@media (max-width: 720px)` block and drop transitions in the existing
`prefers-reduced-motion` block.

## Audio generation — `scripts/generate-engineering-loops-narration.mjs`
**Not yet done.** One-off Node script following `scripts/add-post.mjs`'s convention (stdlib-only
`.mjs`, no npm install). Reads `content/engineering-loops.json`, walks `layers[].narration[]`,
calls ElevenLabs' TTS REST endpoint via `fetch` (`ELEVENLABS_API_KEY` env var), writes to
`assets/audio/engineering-loops/<layerId>-<NN>.mp3`. Flags: `--layer=<id>`, `--force`,
`--dry-run`. Runs manually/locally, never at build/request time. No CSP change needed
(`ai-labs/engineering-loops/index.html`'s CSP already has `media-src 'self' ...`).

## Docs + cache-bust
Bump `?v=` on the CSS `<link>` and page `<script>` tag in `ai-labs/engineering-loops/index.html`
once the JS/CSS land. Add a narration-architecture section to
`ai-labs/engineering-loops/CLAUDE.md` afterward.

## Verification
```bash
python3 -m http.server 5173   # then open /ai-labs/engineering-loops/
```
- Generate one layer first (`--layer=context --dry-run`, then for real).
- Step through a layer: visual fade-in, caption `.is-active`, and audio start all in sync, in order.
- Toggle voice off mid-layer: audio stops immediately, captions keep advancing on fallback dwell.
- Click a dot/Prev/Next mid-narration: in-flight audio stops cleanly, no overlap, no console errors.
- Tour mode waits for narration to finish before advancing.
- Deep links (`#context` etc.): layout doesn't jump; audio joins after first gesture.
- `prefers-reduced-motion`: all captions show at once, no audio autoplay, toggle still works.
- Delete one `.mp3` to simulate partial rollout: graceful fallback, `console.warn` on
  narration/step-count mismatch, no crash.

## Status
- [x] Narration content + `ui` labels written into `content/engineering-loops.json`
- [ ] `assets/js/engineering-loops-narration.js` playback engine
- [ ] Integration into `assets/js/engineering-loops.js`
- [ ] CSS for caption panel + voice toggle
- [ ] `scripts/generate-engineering-loops-narration.mjs` generation script
- [ ] Generate audio via ElevenLabs (needs `ELEVENLABS_API_KEY`)
- [ ] `?v=` bump + `ai-labs/engineering-loops/CLAUDE.md` update
- [ ] End-to-end verification per checklist above

Resume with `/implement-spec 43`.
