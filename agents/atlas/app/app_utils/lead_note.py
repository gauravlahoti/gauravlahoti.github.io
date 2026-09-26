"""Keep Atlas's working note out of the visible reply (spec 67).

The system prompt asks for one short working note per turn, e.g.
"Certification question, calling get_certifications for the full list.",
and it belongs in the visible Thinking panel. At thinking level LOW the
model has almost no thinking budget and sometimes writes that note into the
reply instead, so visitors (and the avatar) got "Availability question,
calling get_profile for the consulting status and route." as the first line
of the answer.

`LeadNoteGuard` sits on the visible stream. It holds back only the opening
of the reply, and only until it can tell: a note always names its question
type within the first few words, so anything without "question" early is
released at once. A matching opening sentence is handed back as a note (the
caller streams it as thinking), and the rest of the reply goes on untouched.
"""

from __future__ import annotations

import re

# "<Topic> question, calling|checking|using|pulling <tool> ...<end>"
_NOTE_RE = re.compile(
    r"^\s*[A-Za-z][\w'\u2019/&+ -]{0,60}?\bquestion\b\s*[,:;-]\s*"
    r"(?:calling|checking|using|pulling|looking|fetching|routing)\b[^.!?\n]*[.!?]?[ \t]*\n*",
    re.IGNORECASE,
)
# A sentence end, including a missing space after it ("route.Gaurav").
_SENTENCE_END_RE = re.compile(r"[.!?](?=\s|$|[A-Z])|\n")
# Within this many characters a note has always said "question".
_EARLY_WINDOW = 48
# Never hold more than this, whatever the model writes.
_HOLD_LIMIT = 240


class LeadNoteGuard:
    def __init__(self) -> None:
        self._buf = ""
        self._decided = False
        self.note = ""

    def push(self, chunk: str) -> tuple[str, str]:
        """Feed visible text. Returns (text to show now, note to divert)."""
        if self._decided:
            return chunk, ""
        self._buf += chunk
        head = self._buf.lower()
        if len(self._buf) >= _EARLY_WINDOW and "question" not in head[:_EARLY_WINDOW]:
            return self._release()
        if _SENTENCE_END_RE.search(self._buf) or len(self._buf) >= _HOLD_LIMIT:
            return self._decide()
        return "", ""

    def flush(self) -> tuple[str, str]:
        """End of stream: whatever is still held is decided now."""
        if self._decided:
            return "", ""
        return self._decide()

    def without_note(self, text: str) -> str:
        """The same reply without the diverted note (for speech and logs)."""
        if self.note and text.lstrip().startswith(self.note):
            return text.lstrip()[len(self.note):].lstrip()
        return text

    def _decide(self) -> tuple[str, str]:
        m = _NOTE_RE.match(self._buf)
        if not m:
            return self._release()
        self._decided = True
        self.note = m.group(0).strip()
        rest = self._buf[m.end():].lstrip()
        self._buf = ""
        return rest, self.note

    def _release(self) -> tuple[str, str]:
        self._decided = True
        out, self._buf = self._buf, ""
        return out, ""
