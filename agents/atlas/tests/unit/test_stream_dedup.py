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


def test_a_turn_with_no_answer_text_is_retried_once(monkeypatch) -> None:
    calls = []

    async def run_async(**kwargs):
        calls.append(kwargs["new_message"].parts[0].text)
        if len(calls) == 1:
            # Seen live: the model wrote only its note block, then stopped.
            yield _event(True, "[[NOTE]]Availability question, calling get_profile.[[/NOTE]]")
            yield _event(False, "[[NOTE]]Availability question, calling get_profile.[[/NOTE]]")
            return
        yield _event(True, "[[NOTE]]Retry, answering now.[[/NOTE]]He takes select consulting work [1].")
        yield _event(True, '\n\n[[META]]{"citations":[],"suggestions":[],"cta":null,"badges":[]}[[/META]]')

    monkeypatch.setattr(api, "_runner", SimpleNamespace(run_async=run_async))

    async def no_log(*_a, **_k):
        return None

    monkeypatch.setattr(api, "_log_turn", no_log)

    async def collect():
        return [json.loads(c[6:]) async for c in api._stream_agent(
            "s2", "Is he open to consulting?", turn_index=0, identity=None, client_meta={}, geo_task=None)]

    events = asyncio.run(collect())
    reply = "".join(e["delta"] for e in events if "delta" in e)
    assert reply.strip() == "He takes select consulting work [1]."
    assert len(calls) == 2 and "empty" in calls[1]


# ── Spec 98: a tool call typed out as the reply ──────────────────────────────
# Captured from a live turn: the reply opened with the ADK function namespace.
_LEAKED = ("out:default_api:get_ai_labs[{description:A visual explainer,id:web-mcp,"
           "url:https://gauravlahoti.dev/ai-labs/web-mcp/}]")


def _collect_turn(monkeypatch, runs):
    """Run one turn against a fake model whose successive attempts are `runs`
    (lists of text pieces). Returns (events, nudges the model was sent)."""
    nudges = []

    async def run_async(**kwargs):
        nudges.append(kwargs["new_message"].parts[0].text)
        pieces = runs[min(len(nudges), len(runs)) - 1]
        for p in pieces:
            yield _event(True, p)
        yield _event(False, "".join(pieces))

    monkeypatch.setattr(api, "_runner", SimpleNamespace(run_async=run_async))
    logged = []

    async def log(*args, **kwargs):
        logged.append(kwargs or args)

    monkeypatch.setattr(api, "_log_turn", log)

    async def collect():
        return [json.loads(c[6:]) async for c in api._stream_agent(
            "s98", "What are engineering loops?", turn_index=0, identity=None, client_meta={}, geo_task=None)]

    return asyncio.run(collect()), nudges, logged


_CLEAN = ["Gaurav's Engineering Loops lab covers four nested ways to steer AI [1].",
          '\n\n[[META]]{"citations":[],"suggestions":[],"cta":null,"badges":[]}[[/META]]']


def test_a_typed_out_tool_call_is_dropped_and_the_turn_retried_once(monkeypatch) -> None:
    pieces = [_LEAKED[i:i + 9] for i in range(0, len(_LEAKED), 9)]
    events, nudges, _ = _collect_turn(monkeypatch, [pieces, _CLEAN])
    reply = "".join(e["delta"] for e in events if "delta" in e)
    assert "default_api" not in reply and "web-mcp" not in reply
    assert reply.strip() == "Gaurav's Engineering Loops lab covers four nested ways to steer AI [1]."
    assert len(nudges) == 2 and "raw tool call" in nudges[1]
    assert events[-1] == {"done": True}


def test_two_leaks_in_a_row_show_an_apology_not_the_leak(monkeypatch) -> None:
    pieces = [_LEAKED[i:i + 9] for i in range(0, len(_LEAKED), 9)]
    events, nudges, logged = _collect_turn(monkeypatch, [pieces, pieces])
    reply = "".join(e["delta"] for e in events if "delta" in e)
    assert reply == api._GENERIC_ERROR_REPLY
    assert len(nudges) == 2  # tried once more, not a third time
    assert "default_api" not in json.dumps(logged, default=str)  # the leak is not stored in the audit row


def test_a_normal_short_reply_is_not_held_back(monkeypatch) -> None:
    events, nudges, _ = _collect_turn(monkeypatch, [["Yes, he does.",
        '\n\n[[META]]{"citations":[],"suggestions":[],"cta":null,"badges":[]}[[/META]]']])
    assert "".join(e["delta"] for e in events if "delta" in e).strip() == "Yes, he does."
    assert len(nudges) == 1
