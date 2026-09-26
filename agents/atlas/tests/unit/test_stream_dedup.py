"""Spec 67: the reply stream uses ADK's `partial` flag, not text matching.

Partial events carry the next piece of text; the step's final event
(partial=False) repeats all of it. The old prefix-matching dedup dropped a
piece whenever it looked like a prefix of what had streamed ("[" vanished,
"[[NOTE]]" arrived as "[NOTE]]", and a broken "[[/NOTE]]" swallowed a reply).
Events here mirror a live ADK SSE run: tool call, then text in pieces, then
the full recap."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from app import api


def _event(partial: bool, text: str | None = None, call: str | None = None) -> SimpleNamespace:
    part = SimpleNamespace(text=text, thought=False, function_call=None, function_response=None)
    if call:
        part.function_call = SimpleNamespace(name=call, args={})
    return SimpleNamespace(content=SimpleNamespace(parts=[part], role="model"), partial=partial,
                           author="atlas", usage_metadata=None)


PIECES = ["[", "[NOTE]]Projects question, calling get_projects.[", "[/NOTE]]\nHe built", " an integration fabric [1].",
          "\n\n[[META]]", '{"citations":[{"id":1,"url":"https://gauravlahoti.dev","label":"Portfolio"}],',
          '"suggestions":["More?","GCP?"],"cta":null,"badges":[]}[[/META]]']


@pytest.fixture
def fake_runner(monkeypatch):
    async def run_async(**_kwargs):
        yield _event(True, call="get_projects")
        yield _event(False, call="get_projects")
        for piece in PIECES:
            yield _event(True, piece)
        yield _event(False, "".join(PIECES))  # the recap

    monkeypatch.setattr(api, "_runner", SimpleNamespace(run_async=run_async))

    async def no_log(*_a, **_k):
        return None

    monkeypatch.setattr(api, "_log_turn", no_log)


def test_pieces_stream_once_and_the_note_goes_to_thinking(fake_runner) -> None:
    async def collect():
        out = []
        async for chunk in api._stream_agent("s1", "What has he shipped?", turn_index=0, identity=None,
                                             client_meta={}, geo_task=None):
            out.append(json.loads(chunk[6:]))
        return out

    events = asyncio.run(collect())
    reply = "".join(e["delta"] for e in events if "delta" in e)
    thinking = "".join(e["thinking"] for e in events if "thinking" in e)
    assert reply.strip() == "He built an integration fabric [1]."
    assert "Projects question, calling get_projects." in thinking
    assert "[[" not in reply and "NOTE" not in reply
    assert any("citations" in e for e in events)
