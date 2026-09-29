# Spec 75: Avatar filler and answer are one reply

In an Avatar conversation, a question that needs a lookup showed two Atlas bubbles: "Let me check his certifications for you." on its own, then the answer, with no question between them. The Cloud Run log said the same thing: `turn=1 tools=['get_certifications'] spoke=3.3s`, then `turn=2 first_word_ms=None tools=[]` with the 19s answer.

The filler itself stays. A silent, frozen face for a second or more after a question reads as a dropped call, and the filler gets the first word out in about 0.35s. What was wrong is that it stood alone as a reply, and that it was the same sentence every time.

## Cause

Spec 71 kept the visitor's turn open across a tool call by watching transcripts: after a tool call, the turn could close once the avatar had "spoken since the tools answered". Transcripts trail the audio by about a second, and the tools are fast, so the filler's own words often arrived after its tool had already answered. They counted as speech after the tools, and the `turn_complete` that closes the tool call ended the reply at the filler.

A trace of the real server order (`gemini-3.8-live` on Vertex, typed questions) showed what to count instead. Every generation that ends in a tool call closes with its own `turn_complete`, straight after the `tool_call`, with or without a filler first. The answer then comes as a new generation with its own `turn_complete`.

## Changes

- **`live_brain.py`:** `LiveConversation` and `LiveBrainTurn` count tool calls. Each one means one `turn_complete` that doesn't end the reply. This replaces `_tool_pending` / `_spoke_after_tools` and `tools_called` / `spoke_after_tools`. The single-question path had the same fault, which could end a turn at the filler before the answer was spoken.
- **Joining:** `_append_spoken` adds a space when a chunk follows a sentence that ended without one, so the saved reply reads "…for you. Gaurav holds…".
- **Prompt:** the filler is a few words at most, worded differently each time. It is no longer the example phrase "let me check" on every answer.
- No widget change. The widget already draws one bubble per `turnEnd`.

## Definition of done

- [x] `uv run pytest tests/unit` passes, with new tests in the real order: tool call, then the late filler transcript, then `turn_complete`, then the answer is one turn; a tool call with no filler is one turn; two rounds of tools are one turn; a single `LiveBrainTurn` ends after the answer, not at the filler. The two real-order tests fail against the old code.
- [x] A live run of `LiveConversation` against Vertex gives one `turn_end` per question (3 of 3), including a question with two tools, and none with an empty question.
- [ ] On the live site, a spoken certifications question in Avatar mode shows one Atlas bubble, and the log shows one turn with `tools=['get_certifications']` and a non-null `first_word_ms`.
