"""One source per citation marker (spec 67).

The prompt says never to combine markers, but the model sometimes writes
"[1, 2]". The widget only links single markers, and speech only strips
single markers, so a combined one showed up as literal text and could be
read aloud. `split_markers` rewrites it to "[1][2]" before anything sees it.

`CitationGuard` does the same on a stream split into arbitrary chunks. It
holds back only a trailing unclosed "[" followed by digits, commas and spaces
(a marker still being written), never more than `_MAX_HELD` characters.
"""

from __future__ import annotations

import re

_COMBINED_RE = re.compile(r"\[(\d+(?:\s*,\s*\d+)+)\]")
_OPEN_TAIL_RE = re.compile(r"\[[\d,\s]*$")
_MAX_HELD = 16


def split_markers(text: str) -> str:
    if not text or "," not in text or "[" not in text:
        return text
    return _COMBINED_RE.sub(lambda m: "".join(f"[{n.strip()}]" for n in m.group(1).split(",")), text)


class CitationGuard:
    """Streaming `split_markers`. push() each chunk, flush() at the end."""

    def __init__(self) -> None:
        self._held = ""

    def push(self, chunk: str) -> str:
        buf = self._held + chunk
        m = _OPEN_TAIL_RE.search(buf)
        if m and len(buf) - m.start() <= _MAX_HELD:
            body, self._held = buf[:m.start()], buf[m.start():]
        else:
            body, self._held = buf, ""
        return split_markers(body)

    def flush(self) -> str:
        body, self._held = self._held, ""
        return split_markers(body)
