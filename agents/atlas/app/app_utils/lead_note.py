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

# A note opens with the kind of message: "<Topic> question, ...", "<Topic>
# request. I'll ...". A reply can open the same way ("Good question. He
# is..."), so the head alone never decides: the note must also be planning.
_KIND = r"(?:question|request|query|intent)"
_HEAD_RE = re.compile(rf"^\s*[A-Za-z][\w'\u2019/&+ -]{{0,60}}?\b{_KIND}\b\s*([,:;.-])\s*", re.IGNORECASE)
_KIND_RE = re.compile(rf"\b{_KIND}\b", re.IGNORECASE)
# ...and is about planning, not about Gaurav: which tool, what's missing, why
# declining. A sentence with none of these is part of the reply.
_PLAN_RE = re.compile(
    r"\b(?:call(?:ing)?|check(?:ing)?|using|pull(?:ing)?|look(?:ing)?\s+up|fetch(?:ing)?|rout(?:e|ing)|"
    r"tools?|get_[a-z_]+|missing|no\s+(?:email|address|message)|not\s+provided|asking\b|ask\s+(?:for|the\s+visitor)|"
    r"declin(?:e|ing)|out\s+of\s+scope|punt(?:ing)?|possible\s+yet|invit(?:e|ing)|"
    r"guidelines|per\s+(?:the\s+)?(?:rules?|policy|instructions)|I'll\s+(?:call|check|use|pull|decline|route))\b",
    re.IGNORECASE,
)
# A follow-on sentence that is still the note ("No tool call possible yet.").
_PLAN_FOLLOW_RE = re.compile(
    r"\b(?:tool\s+calls?|no\s+tool|get_[a-z_]+|calling\s+\w+|possible\s+yet|"
    r"I'll\s+(?:call|check|decline|route)|per\s+(?:safety\s+)?guidelines)\b",
    re.IGNORECASE,
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


NOTE_OPEN, NOTE_CLOSE = "[[NOTE]]", "[[/NOTE]]"
# Longest note block we will hold back before giving up on its close tag.
_NOTE_BLOCK_LIMIT = 600


class NoteBlockGuard:
    """The working note as a protocol (spec 67): the prompt asks Atlas to open
    every reply with `[[NOTE]] ... [[/NOTE]]`. This lifts every such block
    out of the stream, wherever it appears, and hands it back as a note for
    the Thinking panel. Only a possibly half-written open tag, or an open
    block (up to `_NOTE_BLOCK_LIMIT` chars), is ever held back."""

    def __init__(self) -> None:
        self._buf = ""
        self._inside = False
        self._trim = False  # a block just closed: drop the whitespace after it

    def push(self, chunk: str) -> tuple[str, str]:
        self._buf += chunk
        if self._trim and not self._inside:
            self._buf = self._buf.lstrip()
            self._trim = not self._buf
        shown, notes = [], []
        while True:
            if self._inside:
                end = self._buf.find(NOTE_CLOSE)
                if end == -1:
                    if len(self._buf) <= _NOTE_BLOCK_LIMIT:
                        break
                    end, skip = len(self._buf), 0  # never closed: give up holding
                else:
                    skip = len(NOTE_CLOSE)
                notes.append(self._buf[:end].strip())
                self._buf = self._buf[end + skip:].lstrip() if skip else ""
                self._inside = False
                self._trim = not self._buf
                continue
            start = self._buf.find(NOTE_OPEN)
            if start == -1:
                keep = _partial_tag_len(self._buf)
                shown.append(self._buf[:len(self._buf) - keep])
                self._buf = self._buf[len(self._buf) - keep:]
                break
            shown.append(self._buf[:start])
            self._buf = self._buf[start + len(NOTE_OPEN):]
            self._inside = True
        return "".join(shown), " ".join(n for n in notes if n)

    def flush(self) -> tuple[str, str]:
        if self._inside:
            note, self._buf, self._inside = self._buf.strip(), "", False
            return "", note
        out, self._buf = self._buf, ""
        return out, ""


def _partial_tag_len(text: str) -> int:
    """How much of the end of `text` could be the start of NOTE_OPEN."""
    for n in range(min(len(NOTE_OPEN) - 1, len(text)), 0, -1):
        if NOTE_OPEN.startswith(text[-n:]):
            return n
    return 0


class LeadNoteGuard:
    """Backstop for a working note written WITHOUT the [[NOTE]] tags."""

    def __init__(self) -> None:
        self._buf = ""
        self._decided = False
        self._in_note = False  # a note was found; checking whether it goes on
        self._raw = ""  # the diverted text, exactly as written
        self._shown_any = False
        self.note = ""

    def push(self, chunk: str) -> tuple[str, str]:
        """Feed visible text. Returns (text to show now, note to divert)."""
        shown, note = self._push(chunk)
        self._shown_any = self._shown_any or bool(shown.strip())
        return shown, note

    def _push(self, chunk: str) -> tuple[str, str]:
        if self._decided:
            return chunk, ""
        self._buf += chunk
        if self._in_note:
            return self._continue_note(final=False)
        head = self._buf.lower()
        if len(self._buf) >= _EARLY_WINDOW and not _KIND_RE.search(head[:_EARLY_WINDOW]):
            return self._release()
        if _SENTENCE_END_RE.search(self._buf) or len(self._buf) >= _HOLD_LIMIT:
            return self._decide(final=False)
        return "", ""

    def flush(self) -> tuple[str, str]:
        """End of stream: whatever is still held is decided now. A reply is
        never left empty: if all it had was what looked like a note, that
        text is the reply after all."""
        if self._decided:
            shown, note = "", ""
        elif self._in_note:
            shown, note = self._continue_note(final=True)
        else:
            shown, note = self._decide(final=True)
        self._shown_any = self._shown_any or bool(shown.strip())
        if not self._shown_any and self.note:
            shown, note, self.note = self.note, "", ""
            self._shown_any = True
        return shown, note

    def without_note(self, text: str) -> str:
        """The same reply without the diverted note (for speech and logs)."""
        if self.note and text.lstrip().startswith(self.note):
            return text.lstrip()[len(self.note):].lstrip()
        return text

    def _decide(self, final: bool) -> tuple[str, str]:
        head = _HEAD_RE.match(self._buf)
        if not head:
            return self._release()
        end = _first_sentence(self._buf)
        if end is None:
            end = len(self._buf) if (final or len(self._buf) >= _HOLD_LIMIT) else None
        if end is None:
            return "", ""  # still inside the first sentence
        if head.group(1) == ".":
            # "<Topic> request." on its own: a note only if the NEXT sentence
            # is planning ("I'll decline writing code per safety guidelines").
            rest = self._buf[end:]
            lead = len(rest) - len(rest.lstrip())
            nxt = _first_sentence(rest[lead:])
            if nxt is None and not final and len(self._buf) < _HOLD_LIMIT:
                return "", ""
            second = rest[lead:lead + nxt] if nxt is not None else rest[lead:]
            if not _PLAN_RE.search(second):
                return self._release()
            self._take(end + lead + len(second))
        else:
            if not _PLAN_RE.search(self._buf[head.end():end]):
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


_NOTE_BLOCK_RE = re.compile(re.escape(NOTE_OPEN) + r".*?(?:" + re.escape(NOTE_CLOSE) + r"|$)", re.DOTALL)


class NoteFilter:
    """What api.py runs the reply through: [[NOTE]] blocks first (the
    protocol), then the untagged-note backstop. Same push/flush/without_note
    interface as LeadNoteGuard."""

    def __init__(self) -> None:
        self._blocks = NoteBlockGuard()
        self._lead = LeadNoteGuard()
        self._shown_any = False

    def push(self, chunk: str) -> tuple[str, str]:
        shown, block_note = self._blocks.push(chunk)
        shown, lead_note = self._lead.push(shown) if shown else ("", "")
        self._shown_any = self._shown_any or bool(shown.strip())
        return shown, " ".join(n for n in (block_note, lead_note) if n)

    def flush(self) -> tuple[str, str]:
        tail, block_note = self._blocks.flush()
        shown, lead_note = self._lead.push(tail) if tail else ("", "")
        more, last_note = self._lead.flush()
        shown += more
        notes = " ".join(n for n in (block_note, lead_note, last_note) if n)
        if not self._shown_any and not shown.strip() and block_note:
            # A note block never closed and took the whole reply with it:
            # its first sentence was the note, the rest is the answer.
            m = re.search(r"[.!?](?=\s|$)", block_note)
            rest = block_note[m.end():].strip() if m else ""
            shown, notes = (rest, block_note[:m.end()]) if rest else (block_note, "")
        self._shown_any = self._shown_any or bool(shown.strip())
        return shown, notes

    def without_note(self, text: str) -> str:
        return self._lead.without_note(_NOTE_BLOCK_RE.sub("", text).lstrip())
