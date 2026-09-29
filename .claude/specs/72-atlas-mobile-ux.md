# Spec 72: Atlas on a phone, never a dead end

Mobile is where most visitors meet Atlas. Four things made it worse than it should be.

## Problems

1. **The avatar limit went nowhere.** A hands-free conversation charged the shared `chat` bucket, so a visitor who used it up saw "That's the question budget for today (10 per visitor)" under the face, next to a Start button that could never work, and no route to Voice. Voice draws on that same budget, so a redirect would have been refused anyway. The mid-conversation check also reported a spent chat budget as the avatar's limit.
2. **The conversation controls didn't fit a spoken call.** Spec 71 offered Mute / Type / End, and the composer could still show a Stop control. In a two-way call, talking over Atlas already interrupts it.
3. **The mode switch overlapped on first open.** The Avatar option's orb, label and "new" beacon were wider than a `1fr` grid cell at phone widths, and the centred overflow pushed the orb into the Voice cell. It went away once Avatar had been tried, because the beacon left with it.
4. **The panel could trap you.** In Avatar mode the header (face, controls, hint) plus the composer and footer were taller than the bottom sheet. The footer (diagram trigger, Clear chat) was clipped, and because `overflow: hidden` is still a scroll container, focusing the clipped composer scrolled the whole panel and took the header's close button off the top.

## Changes

- **Budgets don't overlap.** An avatar turn, typed (`/api/agent-chat` with `avatar: true`) or spoken (`WS /api/agent-live`), spends only the `avatar` bucket and the site's daily avatar seconds, never a chat question. Refusals carry `kind`: `avatar` for the visitor's share, `site` for the day's spend.
- **Every avatar cap hands off to Voice at once** (`handOffToVoice` in `agent-widget.js`): the switch moves to Voice, one line in the chat says why, and a pending typed question is asked again there. The rest is remembered for the UTC day (`atlasAvatarRest_v1`), so a reload or reopen lands in Voice and picking Avatar hands off again without a request. Replaces spec 67's "Switch to Voice / Show as text" offer card.
- **A conversation shows Mute and End only.** No Type toggle, no composer, no Stop. End brings the composer back.
- **Mode switch:** `minmax(0, 1fr)` cells, `min-width: 0` options, the beacon pinned to the cell's corner out of flow, and tighter tracking under 400px.
- **Panel:** `overflow: clip` (not a scroll container), header / composer / footer never shrink, and only the transcript gives up height. On phones the face is sized from the visible height (`--agent-vv-height`). Below 520px of visible height (`is-short`, set by `trackVisualViewport`) the face steps aside, and while typing there the conversation row and footer do too.

## Definition of done

- [x] `uv run pytest tests/unit` passes, with new tests: a spent chat budget doesn't stop a conversation; a spent avatar budget refuses with `kind: "avatar"`; the site cap refuses with `kind: "site"`; a typed avatar turn charges only `avatar`; a spent chat budget still refuses text and voice.
- [x] `node --test 'tests/**/*.test.mjs'` passes.
- [x] 360×640: no overlap between the Voice and Avatar cells with the beacon showing; Avatar mode shows close, switch, face, composer and footer.
- [x] 360×360 (keyboard up) with the composer focused: close button and composer both on screen; the panel never scrolls.
- [x] Avatar rested for today: reopening lands in Voice; picking Avatar hands off with one line and loads no face.
- [x] Conversation controls are Start / Mute / End; the composer is hidden while conversing.
- [ ] On a real phone after deploy: a capped conversation ends and the next question is answered and spoken in Voice.
