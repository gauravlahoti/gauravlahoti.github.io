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

# A note opens with the question type: "<Topic> question, ..." (the comma,
# colon or dash matters: "Good question. He is..." is a reply, not a note).
_HEAD_RE = re.compile(r"^\s*[A-Za-z][\w'\u2019/&+ -]{0,60}?\bquestion\b\s*[,:;-]\s*", re.IGNORECASE)
# ...and is about planning, not about Gaurav: which tool, what's missing, why
# declining. A sentence with none of these is part of the reply.
_PLAN_RE = re.compile(
    r"\b(?:call(?:ing)?|check(?:ing)?|using|pull(?:ing)?|look(?:ing)?\s+up|fetch(?:ing)?|rout(?:e|ing)|"
    r"tools?|get_[a-z_]+|missing|no\s+(?:email|address|message)|ask(?:ing)?\s+for|"
    r"declin(?:e|ing)|out\s+of\s+scope|punt(?:ing)?|possible\s+yet)\b",
    re.IGNORECASE,
)
# A follow-on sentence that is still the note ("No tool call possible yet.").
_PLAN_FOLLOW_RE = re.compile(
    r"\b(?:tool\s+calls?|no\s+tool|get_[a-z_]+|calling\s+\w+|possible\s+yet)\b", re.IGNORECASE
)
# A sentence end, including a missing space after it ("route.Gaurav").
_SENTENCE_END_RE = re.compile(r"[.!?](?=\s|$|[A-Z])|\n")
# Within this many characters a note has always said "question".
_EARLY_WINDOW = 48
# Never hold more than this, whatever the model writes.
_HOLD_LIMIT = 240


def _first_sentence(text: str) -> int | None:
    """End index (exclusive) of the first sentence in `text`, if complete."""
    m = _SENTENCE_END_RE.search(text)
    return m.end() if m else None


class LeadNoteGuard:
    def __init__(self) -> None:
        self._buf = ""
        self._decided = False
        self._in_note = False  # a note was found; checking whether it goes on
        self._raw = ""  # the diverted text, exactly as written
        self.note = ""

    def push(self, chunk: str) -> tuple[str, str]:
        """Feed visible text. Returns (text to show now, note to divert)."""
        if self._decided:
            return chunk, ""
        self._buf += chunk
        if self._in_note:
            return self._continue_note(final=False)
        head = self._buf.lower()
        if len(self._buf) >= _EARLY_WINDOW and "question" not in head[:_EARLY_WINDOW]:
            return self._release()
        if _SENTENCE_END_RE.search(self._buf) or len(self._buf) >= _HOLD_LIMIT:
            return self._decide(final=False)
        return "", ""

    def flush(self) -> tuple[str, str]:
        """End of stream: whatever is still held is decided now."""
        if self._decided:
            return "", ""
        if self._in_note:
            return self._continue_note(final=True)
        return self._decide(final=True)

    def without_note(self, text: str) -> str:
        """The same reply without the diverted note (for speech and logs)."""
        if self.note and text.lstrip().startswith(self.note):
            return text.lstrip()[len(self.note):].lstrip()
        return text

    def _decide(self, final: bool) -> tuple[str, str]:
        head = _HEAD_RE.match(self._buf)
        end = _first_sentence(self._buf)
        if end is None:
            end = len(self._buf) if (final or len(self._buf) >= _HOLD_LIMIT) else None
        if not head or end is None or not _PLAN_RE.search(self._buf[head.end():end]):
            return self._release()
        self._take(end)
        self._in_note = True
        return self._continue_note(final)

    def _continue_note(self, final: bool) -> tuple[str, str]:
        """After a note sentence: divert more planning sentences, then release."""
        while True:
            lead = len(self._buf) - len(self._buf.lstrip())
            body = self._buf[lead:]
            end = _first_sentence(body)
            if end is None and not final and len(self._buf) < _HOLD_LIMIT:
                return "", ""  # wait for the next sentence to finish
            sentence = body[:end] if end is not None else body
            if sentence.strip() and _PLAN_FOLLOW_RE.search(sentence) and "\n\n" not in self._buf[:lead]:
                self._take(lead + len(sentence))
                continue
            self._decided = True
            self.note = self._raw.strip()
            rest, self._buf = self._buf.lstrip(), ""
            return rest, self.note

    def _take(self, n: int) -> None:
        self._raw += self._buf[:n]
        self._buf = self._buf[n:]

    def _release(self) -> tuple[str, str]:
        self._decided = True
        out, self._buf = self._buf, ""
        return out, ""
