"""The chat so far as plain user/model text turns.

One ADK session holds every mode (text, voice, avatar, hands-free), so the
same extraction serves the live path's history (`api._chat_history`) and the
note briefing (spec 111), which reads what a visitor asked before writing.
"""

from __future__ import annotations

import re
from typing import Any

from google.genai import types

from app.app_utils.citations import split_markers

# Everything from the trailing meta block on is widget plumbing, not reply.
_META_BLOCK_RE = re.compile(r"\[\[META\]\].*", re.DOTALL)


def turns_from_events(events: Any) -> list[types.Content]:
    """ADK session events -> user/model text turns, thoughts and meta dropped."""
    turns: list[types.Content] = []
    for event in events or []:
        content = getattr(event, "content", None)
        if not content or not content.parts:
            continue
        text = "".join(p.text or "" for p in content.parts if p.text and not p.thought)
        if content.role == "model":
            text = split_markers(_META_BLOCK_RE.sub("", text))
        text = text.strip()
        if text:
            turns.append(types.Content(role="user" if content.role == "user" else "model",
                                       parts=[types.Part.from_text(text=text)]))
    return turns


def plain_turns(turns: list[types.Content]) -> list[tuple[str, str]]:
    """[(role, text)] for prompts and emails: 'visitor' or 'atlas'."""
    out = []
    for t in turns or []:
        text = "".join(p.text or "" for p in (t.parts or []) if p.text).strip()
        if text:
            out.append(("visitor" if t.role == "user" else "atlas", text))
    return out
