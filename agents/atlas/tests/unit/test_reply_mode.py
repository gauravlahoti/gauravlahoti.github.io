"""Spec 67: Voice and Avatar answers get a tighter, spoken length budget.

The note is server-written, only for spoken modes, and must never leak into
the session history ADK builds `contents` from."""

from __future__ import annotations

from types import SimpleNamespace

from google.adk.models.llm_request import LlmRequest
from google.genai import types

from app import api
from app.guardrails import SPOKEN_REPLY_NOTE, before_model_callback


def _request(text: str = "Which certifications does he hold?") -> tuple[LlmRequest, types.Content]:
    stored = types.Content(role="user", parts=[types.Part.from_text(text=text)])
    tool_reply = types.Content(role="user", parts=[types.Part.from_function_response(name="get_certifications", response={"ok": True})])
    return LlmRequest(contents=[stored, types.Content(role="model", parts=[types.Part.from_text(text="calling")]), tool_reply]), stored


def _run(mode: str | None) -> tuple[LlmRequest, types.Content]:
    req, stored = _request()
    state = {} if mode is None else {"reply_mode": mode}
    assert before_model_callback(SimpleNamespace(state=state), req) is None
    return req, stored


def _texts(content: types.Content) -> list[str]:
    return [p.text for p in content.parts if p.text]


def test_spoken_modes_get_the_note_on_the_visitors_message() -> None:
    for mode in ("voice", "avatar"):
        req, stored = _run(mode)
        assert _texts(req.contents[0])[-1] == SPOKEN_REPLY_NOTE
        # The tool response is left alone, and so is the stored history.
        assert req.contents[2].parts[0].function_response is not None
        assert _texts(stored) == ["Which certifications does he hold?"]


def test_text_mode_and_no_mode_are_untouched() -> None:
    for mode in ("text", None):
        req, _ = _run(mode)
        assert SPOKEN_REPLY_NOTE not in _texts(req.contents[0])


def test_reply_mode_from_the_request_body() -> None:
    assert api._reply_mode({"mode": "voice"}, want_avatar=False) == "voice"
    assert api._reply_mode({"mode": "avatar"}, want_avatar=False) == "avatar"
    assert api._reply_mode({"mode": "shout"}, want_avatar=False) == "text"
    assert api._reply_mode({}, want_avatar=False) == "text"
    assert api._reply_mode(None, want_avatar=False) == "text"
    # An avatar turn is always spoken, whatever else the body says.
    assert api._reply_mode({"mode": "text"}, want_avatar=True) == "avatar"
