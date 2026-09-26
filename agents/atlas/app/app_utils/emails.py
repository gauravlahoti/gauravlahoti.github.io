"""Atlas never shows an email address it wasn't given (spec 67).

A visitor asked for Gaurav's email and Atlas answered with a work address it
had made up from his name and employer. That is a sensitive leak even when
it is wrong. The only addresses Atlas may ever write are:

- Gaurav's public contact address (`CONTACT_EMAIL`, profile.json
  links.email), and
- addresses the visitor typed themselves in this conversation (so "I've
  sent the resume to jane@example.com" still reads right).

Any other address in the reply is replaced with `CONTACT_EMAIL` when the
visitor asked how to reach him, or with a pointer to LinkedIn / Topmate
otherwise. `guardrails.after_model_callback` still redacts even the real
address when there was no contact intent; this module catches everything
else.

`EmailGuard` does it on a stream split into arbitrary chunks by holding back
only the trailing unbroken run of characters (a possibly half-written
address) until the next whitespace arrives.
"""

from __future__ import annotations

import re

CONTACT_EMAIL = "gaurav.lahoti25@gmail.com"
NO_CONTACT_REPLACEMENT = "his LinkedIn"

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
_TAIL_RE = re.compile(r"\S*$")


def emails_in(text: str) -> set[str]:
    return {m.lower() for m in _EMAIL_RE.findall(text or "")}


def fix_emails(text: str, allowed: set[str], contact_intent: bool) -> str:
    if not text or "@" not in text:
        return text
    ok = {a.lower() for a in allowed} | {CONTACT_EMAIL}

    def swap(m: re.Match[str]) -> str:
        addr = m.group(0)
        if addr.lower() in ok:
            return addr
        return CONTACT_EMAIL if contact_intent else NO_CONTACT_REPLACEMENT

    return _EMAIL_RE.sub(swap, text)


class EmailGuard:
    """Streaming `fix_emails`. push() each chunk, flush() at the end."""

    def __init__(self, allowed: set[str], contact_intent: bool) -> None:
        self._allowed = allowed
        self._contact = contact_intent
        self._held = ""

    def push(self, chunk: str) -> str:
        buf = self._held + chunk
        cut = _TAIL_RE.search(buf).start()
        body, self._held = buf[:cut], buf[cut:]
        return fix_emails(body, self._allowed, self._contact)

    def flush(self) -> str:
        body, self._held = self._held, ""
        return fix_emails(body, self._allowed, self._contact)
