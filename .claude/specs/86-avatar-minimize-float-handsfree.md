# Spec 86: Minimizing never silences a call, Avatar floats on demand, and goes hands-free

Found in live use: a visitor in an Avatar call minimized the panel and the call went quiet. After restoring and asking again, Atlas answered in text and the face looked alive, but there was no sound. Two requests came with it: a way to float the avatar yourself during a call, and an Avatar mode with no text box or send button, only a Stop while the recorded greeting plays.

## 1. Minimize tore down the call's audio while the call ran on

`minimize()` called `pauseAvatar()` → `stage.pause()`. In a live call that ran `endLive()`, which closed the face handle and tore down `liveVideo`, the only element that carries Atlas's voice, and fell back to the muted idle loop. Nothing told the conversation. The WebSocket and mic stayed open, the server kept answering, `onConvoEvent` kept painting words, and `face.pushBytes()` silently dropped every video+audio chunk because the handle was closed. The result was text with no voice, a face that only breathed on the idle clip, and an orphaned call still spending the day's avatar time. The 30s live watchdog (`armWatchdog`) could close the face the same way, with no minimize at all.

**Fix:**
- During a call, the header's minimize button floats the panel (the spec 78/81 floating card) instead of minimizing it, and reads "Float the avatar". With no call there's nothing to keep alive, so it minimizes as it always did (pausing a greeting is fine). Text and Voice are unchanged.
- `startLive({ onClose })`: `endLive()` calls the owner back once, whatever closed the face. `startConversation()` uses it to end the call cleanly: socket closed with `{end:true}`, mic released, the hint "The call dropped. Start a new one whenever you like.", and Start conversation back. The normal end path nulls `convo` first, so the callback is a no-op there.
- A float the visitor chose (`userFloat`) outlasts a page Atlas opened beside the call. Any way back to the full panel clears it. Leaving Avatar mode always un-floats, since the floating card shows only the face.

## 2. Float during a call only

A first cut floated on minimize even before a call. That was dropped: floating is for keeping a call going while the page is visible, and with no call a normal minimize is what a visitor expects. The floating card is unchanged from spec 81 (face, status tag, Mute/End, ⤡ restore).

## 3. Hands-free Avatar

- Where a spoken call is supported, mounting the call controls adds `.is-handsfree` and the composer row is hidden in Avatar mode. A browser that can't hold a call keeps the composer, so Avatar is never a dead end.
- A **Stop** button joins the face's control row, shown only while the recorded greeting plays (`state === "speaking"` with no call). It runs `pauseAvatar()`. A call has End, and talking over Atlas, as before. Living in the face's row, it also works while floating.
- `prefillComposer()` (WebMCP's `draft_note_to_gaurav`) switches to Text first when hands-free, so a drafted note lands somewhere visible.

## Definition of done

- [x] `node --test 'tests/**/*.test.mjs'` (19) passes.
- [x] Browser, Avatar mode: no text box, send or mic. The greeting plays with Stop showing; Stop silences it, the face returns to its muted idle loop, and Stop hides.
- [x] Minimize with no call collapses to the header bar ("Minimize panel"). During a call the button reads "Float the avatar" and floats; ⤡ and a face tap both restore; End brings the full panel and the "Minimize panel" label back.
- [x] Minimize during a call (fake WebSocket and silent fake mic, since the live service was capped for the day): the panel floats, the socket stays open, the mic stays live, the live video stays attached, Mute and End stay visible.
- [x] Safety net: with no video arriving, the watchdog closed the face at 30s and the call ended cleanly (`end` sent, socket closed, mic tracks ended, hint shown, Start conversation back).
- [x] Text mode: minimize still collapses to the header bar and the composer is back.
- [x] Phone width (390px): hands-free row, Stop and the floating card all fit.
- [ ] A real call on production: minimize mid-answer, keep talking, and the voice is heard throughout.
- [ ] A page opened during a call ("open Pulse"), floated by the visitor, then closed: the float stays.
