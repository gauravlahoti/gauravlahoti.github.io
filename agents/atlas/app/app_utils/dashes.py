"""No dashes in anything Atlas writes (spec 67).

The site's copy rule is "no em dashes": they read as machine-written. The
prompt asks for that too, but models slip, so this is the guarantee. Every
visible stream (reply, thinking, suggestions, source labels) and everything
built from the reply (speech, avatar script, logs) goes through it.

- An em or en dash between two numbers is a range: "2019<en dash>2021" -> "2019-2021".
- Any other em or en dash, or a spaced hyphen standing in for one
  ("AWS - Azure"), becomes a comma: "Gaurav <em dash> a Senior Architect" ->
  "Gaurav, a Senior Architect". Before a capitalised phrase it becomes a
  colon: "MCP <em dash> A six-act walkthrough" -> "MCP: A six-act walkthrough".
- A comma that would land next to other punctuation is dropped.

`DashGuard` does the same on a stream split into arbitrary chunks. It holds
back only a trailing run of spaces and dashes, since the next character
decides what the dash becomes. Its output always equals `strip_dashes()` of
the whole text.
"""

from __future__ import annotations

import re

_DASHES = chr(0x2014) + chr(0x2013)  # em dash, en dash
# Number range: digit, optional spaces, a dash, optional spaces, digit.
_RANGE_RE = re.compile(rf"(?<=\d)[ \t]*[{_DASHES}][ \t]*(?=\d)")
# Any remaining em/en dash (with the spaces around it), or a spaced hyphen
# between words. Replaced by a marker first, so the clean-up below only ever
# touches commas this module inserted, never the visitor-facing text around
# them (which DashGuard may already have streamed out).
_DASH_RE = re.compile(rf"[ \t]*[{_DASHES}]+[ \t]*|(?<=\w)[ \t]+-[ \t]+(?=\w)")
_MARK = "\x00"   # becomes ", "
_COLON = "\x01"  # becomes ": " (a dash introducing a capitalised phrase)
_MARKS_RE = re.compile(rf"[{_MARK}{_COLON}]+")
# An inserted mark right before punctuation, a line break or the end: drop it.
_MARK_BEFORE_PUNCT_RE = re.compile(rf"[{_MARK}{_COLON}](?=[.,;:!?)\n]|$)")
# An inserted mark right after punctuation: just a space.
_MARK_AFTER_PUNCT_RE = re.compile(rf"(?<=[.,;:!?])[{_MARK}{_COLON}]")
# An inserted mark opening a line.
_MARK_LINE_START_RE = re.compile(rf"(?<=\n)[{_MARK}{_COLON}]")
# A dash before a capital introduces a phrase ("MCP <dash> A six-act
# walkthrough" -> "MCP: A six-act ..."); "I" on its own is a pronoun.
# What DashGuard can't resolve yet: trailing spaces, dashes and hyphens.
_TAIL_RE = re.compile(rf"[\s{_DASHES}-]*$")


def strip_dashes(text: str, *, at_start: bool = True) -> str:
    """`at_start=False` when `text` continues something already emitted."""
    if not text:
        return text
    if not any(ch in text for ch in _DASHES) and " -" not in text:
        return text
    out = _RANGE_RE.sub("-", text)

    def mark(m: re.Match[str]) -> str:
        nxt = out[m.end():m.end() + 2]
        if not any(ch in m.group(0) for ch in _DASHES):
            return _MARK  # a spaced hyphen ("AWS - Azure") is a list: comma
        capital = bool(nxt[:1].isupper()) and not (nxt[:1] == "I" and not nxt[1:2].isalpha())
        return _COLON if capital else _MARK

    out = _DASH_RE.sub(mark, out)
    out = _MARKS_RE.sub(lambda m: _COLON if _COLON in m.group(0) else _MARK, out)
    out = _MARK_BEFORE_PUNCT_RE.sub("", out)
    out = _MARK_AFTER_PUNCT_RE.sub(" ", out)
    out = _MARK_LINE_START_RE.sub("", out)
    if at_start and out[:1] in (_MARK, _COLON):
        out = out[1:]
    return out.replace(_MARK, ", ").replace(_COLON, ": ")


class DashGuard:
    """Streaming `strip_dashes`. push() each chunk, flush() at the end."""

    def __init__(self) -> None:
        self._held = ""
        self._prev = ""  # last character emitted, for range and comma context

    def push(self, chunk: str) -> str:
        buf = self._held + chunk
        cut = _TAIL_RE.search(buf).start()
        body, self._held = buf[:cut], buf[cut:]
        return self._emit(body)

    def flush(self) -> str:
        body, self._held = self._held, ""
        return self._emit(body)

    def _emit(self, body: str) -> str:
        if not body:
            return ""
        # Process with the previous character as context, then drop it again.
        ctx = self._prev
        out = strip_dashes(ctx + body, at_start=False)[len(ctx):] if ctx else strip_dashes(body)
        if out:
            self._prev = out[-1]
        return out
