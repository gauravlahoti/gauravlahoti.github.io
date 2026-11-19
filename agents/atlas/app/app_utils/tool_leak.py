"""Catch a tool call written out as the reply (found while testing spec 98).

Now and then the model skips the real tool call and types one into the answer
instead. Visitors saw replies that opened like
`out:default_api:get_ai_labs[{description:..., url:https://.../loops-lab/}]`,
or a "```json" block of lab records, with made-up lab names and dead links.
Same question, other runs: fine. So it is intermittent and not tied to any
one question.

`ToolLeakGuard` sits on the visible stream, in front of the working-note
filter. It holds back only the first few words of the reply, which is enough
to tell. A reply that is not a leak is released untouched. A leak is dropped
and the caller (api.py) runs the turn once more with a short server nudge,
the same way it already does for a reply that came back empty.

Only the opening is checked, on purpose: every leak seen so far starts the
reply, and scanning the whole reply for code-looking text would flag honest
answers that mention a tool name in passing.
"""

from __future__ import annotations

import re

# Held until this many non-space characters have arrived, then decided. Short
# enough that the first word still reaches the visitor (and the voice) at once
# for ordinary replies: five or six words.
_DECIDE_AT = 24
# Whatever happens, never hold more than this.
_HOLD_LIMIT = 120

# A reply never opens with these. Each one is how a model prints a tool call
# or its result: the tool-code wrapper, the ADK function namespace, a call
# line, a code fence, raw JSON, or a bare run of digits trailing an ellipsis
# (the stray id seen in front of a leaked JSON block).
_LEAK_HEAD_RE = re.compile(
    r"""^\s*(?:
        (?:out:|tool_code|tool_outputs?|print\()          # wrapper
      | default_api\b                                      # ADK namespace
      | (?:[a-z_]+\.)?get_[a-z_]+\(                        # get_ai_labs(...), api.get_x(
      | ```                                                # a code fence
      | \[\s*\{ | \{\s*["']                                # raw JSON
      | \.{2,}\s*\d{6,}                                    # "...4000302832599763595"
    )""",
    re.IGNORECASE | re.VERBOSE,
)
# ...or the namespace turning up anywhere in the opening words.
_LEAK_ANYWHERE_RE = re.compile(r"default_api|tool_code|function_call", re.IGNORECASE)


class ToolLeakGuard:
    """push(chunk) -> (text to show, leaked). Once `leaked` is True the caller
    discards the attempt: this guard returns "" for everything after."""

    def __init__(self) -> None:
        self._buf = ""
        self._decided = False
        self.leaked = False

    def _verdict(self) -> bool:
        head = self._buf[:_HOLD_LIMIT]
        return bool(_LEAK_HEAD_RE.match(head) or _LEAK_ANYWHERE_RE.search(head))

    def push(self, chunk: str) -> tuple[str, bool]:
        if self.leaked:
            return "", True
        if self._decided:
            return chunk, False
        self._buf += chunk
        if len(self._buf.strip()) < _DECIDE_AT and len(self._buf) < _HOLD_LIMIT:
            # An unmistakable leak can be called early; otherwise keep holding.
            if self._verdict():
                self.leaked, self._buf = True, ""
                return "", True
            return "", False
        if self._verdict():
            self.leaked, self._buf = True, ""
            return "", True
        self._decided = True
        out, self._buf = self._buf, ""
        return out, False

    def flush(self) -> tuple[str, bool]:
        """End of stream: a short reply still being held is decided now."""
        if self.leaked:
            return "", True
        if self._decided or not self._buf:
            return "", False
        if self._verdict():
            self.leaked, self._buf = True, ""
            return "", True
        self._decided = True
        out, self._buf = self._buf, ""
        return out, False
