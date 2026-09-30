# Spec 81: A real send-confirmation gate, a barge-in fix, and floating controls

Three problems from live use of specs 78–80, in order of severity.

## 1. Resume emailed to the wrong address with no real confirmation

The visitor asked for the resume by email, gave an address, and Atlas sent it without confirming, to a wrong address. The prompt already said "read it back once to confirm, then call send_resume" (spec 77), but that was pure wording: nothing stopped the model from narrating a read-back and calling the tool in the very same reply, which is indistinguishable from not confirming at all. The same gap existed for `send_note_to_gaurav`'s reply-to address, and in **Voice mode too**: its mic input is transcribed and posted to the text agent's `send_resume`/`send_note_to_gaurav` (`tools.py`), which had no confirmation step at all. Text mode is not at this risk, since the visitor types the address themselves.

**Fix — a real two-step contract, not a prompt hope**, on both `agents/atlas/app/live_brain.py` (avatar) and `agents/atlas/app/tools.py` (text/voice, via `ToolContext.state`):
- `send_resume`/`send_note_to_gaurav` gained a `confirmed: bool = False` argument.
- The first call, whatever `confirmed` says, never sends. It remembers the normalized address as "awaiting confirmation" for that tool in that session, and returns a `needs_confirmation` result telling the model to read the address back and get an explicit yes.
- A later call only sends when `confirmed=true` **and** the address matches what's actually pending; a hallucinated `confirmed=true` with nothing pending, or a different address, is refused the same way. A model can't fabricate the visitor's next turn, so a second, matching call can only follow their real answer.
- `SPEECH_INSTRUCTION` and `instruction.py`'s Resume/Drop-a-note routing describe the two-call protocol and forbid both calls in one reply.

Verified live on Vertex: an unconfirmed address is read back and nothing sends; a clear "yes" then sends to exactly that address; a corrected address ("actually it's john, not jhon") restarts confirmation with nothing sent to either spelling; a plain "no" cancels with nothing sent.

## 2. Avatar slower, barge-in not flawless

`LiveConversation._reset_turn()` zeroed `self._completes_to_skip` on every turn end, including on **interrupt**. That counter tracks tool calls whose closing `turn_complete` hasn't arrived yet (spec 75); the answering task is fire-and-forget, not tracked in a `pending` set. Barging in while a tool call was still in flight — exactly "open Pulse" / "show me its diagram," which now does a live `agents.json` fetch — zeroed the counter mid-flight. That tool's `turn_complete`, arriving late, either split the next reply early or was silently swallowed, eating a **later, unrelated** `turn_complete` instead: the avatar going quiet or answering late.

**Fix:** `_completes_to_skip` is now set once in `__init__`, never reset by a turn ending. A batched `[some_tool, end_conversation]` message used to drop the other tool entirely (never answered); it's now still run and answered, with only `end_conversation` itself going unanswered. `LiveConversation.open()` prefetches `corpus_live.get_agents()` (fire-and-forget) so the first "open Pulse" of a call hits a warm cache instead of paying the fetch inside the tool call.

Two regression tests reproduce the exact race (a stale tool completion arriving after a barge-in, and two tool calls straddling one) and were confirmed to fail against the pre-fix code before being checked in. Verified live on Vertex: barging in right after "open Pulse and tell me about its architecture" with a follow-up gives one clean reply to the follow-up, no stuck or split turn.

## 3. Floating mode: no visible listening state, controls read as absent

`.agent-avatar-tag`, the only "listening / speaking / thinking" readout, was force-hidden while the panel floats (a page open beside the call) — confirmed the cause of "seems unable to listen at all." The Mute/End row was technically kept by the CSS cascade but had no guaranteed sizing at the floating card's ~150–190px width.

**Fix:** the status tag stays, shrunk to fit. The control row gets explicit sizing (`flex: 1 1 0`, a 36px minimum height) instead of ambient wrapping. A small, explicit restore icon sits in the frame's corner, in addition to the existing tap-the-face restore, so leaving floating mode isn't only discoverable by accident.

Verified in a real browser: the floating card shows "Atlas · Listening", visible Mute and End buttons, and the restore icon, during an actual live conversation with a lab open beside it.

## Definition of done

- [x] `uv run pytest tests/unit` (366) and `node --test 'tests/**/*.test.mjs'` (19) pass.
- [x] New `TestEmailConfirmation` (avatar) covers: first call never sends even with `confirmed=true`; a mismatched confirm never sends; a matching confirm sends once; a bare repeat without `confirmed` never sends; `send_note_to_gaurav` needs the same; the two tools' pending confirmations don't cross-satisfy each other.
- [x] New `TestInterruptDuringATool` reproduces the barge-in race and is confirmed to fail on the pre-fix code.
- [x] `TestEndingTheCall` gained a case for a real tool batched with `end_conversation`.
- [x] Live Vertex checks for all three fixes (confirmation, barge-in, small-talk/open-anything regression check).
- [x] Live browser check of the floating card's controls during an active conversation.
