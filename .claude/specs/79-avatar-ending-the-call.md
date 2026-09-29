# Spec 79: The avatar ends the call like a person would

A spoken conversation only ended when the visitor pressed End, or it cut off silently after a quiet minute. Saying "bye" got a goodbye, and then the mic stayed open.

## Changes

- **Goodbye ends the call.** New tool `end_conversation`. The prompt tells the model to call it when the visitor says goodbye, says they're done or that's all, asks to close the chat, or answers the check-in with nothing more. It says one short goodbye first, and nothing after.
- **It's never answered.** The first build answered it and ended after the model's next reply. On Vertex that reply was noise: the model read the tool result aloud ("The call ends when you finish speaking…"), said a second goodbye, or carried on ("let me know when you're ready to continue"). Now `LiveConversation` takes the call itself and never responds to it. It ends `END_TAIL_S` (1.2s) after the model's own turn completes, so the goodbye's trailing transcript lands, or at most `END_MAX_S` (5s) after the call. A single typed turn has no call to end, so the dispatcher answers `unavailable`.
- **Silence gets one check-in.** After `CONVO_CHECK_IN_S` (30s) with nobody talking, the server sends a bracketed note as the site. Atlas asks, in one sentence, whether there's anything else or whether to wrap up. `CONVO_AFTER_CHECK_IN_S` (15s) later with no answer, the call ends (`idle`, "Ended after a quiet stretch."). If the visitor speaks, the check-in resets. The check-in turn has no question, so it doesn't charge the visitor's avatar budget. This replaces the flat 60-second cut-off.
- **The widget lets the goodbye play out.** The WS `end` carries `goodbye: true` and no reason text. `onEnd` waits until the face has played everything it was sent (`playedOut`, at most 8s), then ends the call with the hang-up animation. The mic is already off, because `agent-live.js` stops it on end.

## Definition of done

- [x] `uv run pytest tests/unit`: goodbye → one turn with the whole goodbye (including its late transcript), then `end: goodbye`, with no tool response ever sent; it still ends without a `turn_complete`; a single turn answers `unavailable`; silence → one check-in note → `end: idle`; speaking after the check-in keeps the call open.
- [x] Live on Vertex (`LiveConversation`, typed): "Thanks! And what about his certifications?" gets answered, not ended. "Great, that's all I needed. Bye!" → "Goodbye, feel free to reach out if you need anything else later." then `goodbye`. "Can you close the chat please?" → a goodbye then `goodbye`. Silence → "Is there anything else you'd like to know, or should we wrap up?" then `idle`.
- [ ] On the live site, by voice: say "bye" and the goodbye plays in full before the hang-up.
