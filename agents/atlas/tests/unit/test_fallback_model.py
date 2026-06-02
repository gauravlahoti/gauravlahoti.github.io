"""Unit tests for the free-tier model cascade (app/fallback_model.py).

All model calls are mocked — no network, no quota consumption. We patch the
parent `Gemini.generate_content_async` (which `FallbackGemini` calls via
`super()`) so each fake "model" either serves a response or raises the same
`_ResourceExhaustedError` (429) the real ADK layer raises on free-tier
exhaustion.
"""

import pytest
from google.adk.models import Gemini
from google.adk.models.google_llm import _ResourceExhaustedError
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from google.genai.errors import ClientError

from app.fallback_model import FallbackGemini

CHAIN = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"]


def _model():
    return FallbackGemini(model=CHAIN[0], fallback_models=CHAIN[1:])


def _exhausted(model_name):
    ce = ClientError(
        429,
        {
            "error": {
                "code": 429,
                "status": "RESOURCE_EXHAUSTED",
                "message": f"quota exceeded for {model_name}",
            }
        },
        None,
    )
    return _ResourceExhaustedError(ce)


def _resp(text):
    return LlmResponse(
        content=types.Content(role="model", parts=[types.Part(text=text)])
    )


def _fake(exhausted: set, served: list, *, yield_then_fail: set = frozenset(),
          raise_other: set = frozenset()):
    """Build a fake parent generate_content_async that records the model used."""

    async def fake(self, llm_request, stream=False):
        m = llm_request.model
        served.append(m)
        if m in raise_other:
            raise ValueError(f"non-429 boom for {m}")
        if m in yield_then_fail:
            yield _resp(f"partial from {m}")
            raise _exhausted(m)
        if m in exhausted:
            raise _exhausted(m)
        yield _resp(f"answer from {m}")

    return fake


async def _drain(model, monkeypatch, fake):
    monkeypatch.setattr(Gemini, "generate_content_async", fake)
    req = LlmRequest(model=CHAIN[0])
    return [r async for r in model.generate_content_async(req, stream=True)]


@pytest.mark.asyncio
async def test_primary_succeeds_no_fallback(monkeypatch):
    served = []
    out = await _drain(_model(), monkeypatch, _fake(set(), served))
    assert served == ["gemini-3.5-flash"]
    assert out[0].content.parts[0].text == "answer from gemini-3.5-flash"


@pytest.mark.asyncio
async def test_falls_back_to_second_on_429(monkeypatch):
    served = []
    out = await _drain(_model(), monkeypatch, _fake({"gemini-3.5-flash"}, served))
    assert served == ["gemini-3.5-flash", "gemini-2.5-flash"]
    assert out[0].content.parts[0].text == "answer from gemini-2.5-flash"


@pytest.mark.asyncio
async def test_cascades_through_all_to_last(monkeypatch):
    served = []
    out = await _drain(
        _model(), monkeypatch,
        _fake({"gemini-3.5-flash", "gemini-2.5-flash"}, served),
    )
    assert served == CHAIN
    assert out[0].content.parts[0].text == "answer from gemini-2.5-flash-lite"


@pytest.mark.asyncio
async def test_all_exhausted_raises_429(monkeypatch):
    served = []
    with pytest.raises(_ResourceExhaustedError):
        await _drain(_model(), monkeypatch, _fake(set(CHAIN), served))
    assert served == CHAIN  # every model was attempted


@pytest.mark.asyncio
async def test_non_429_error_does_not_fall_back(monkeypatch):
    served = []
    with pytest.raises(ValueError):
        await _drain(
            _model(), monkeypatch,
            _fake(set(), served, raise_other={"gemini-3.5-flash"}),
        )
    assert served == ["gemini-3.5-flash"]  # no cascade on non-quota errors


@pytest.mark.asyncio
async def test_mid_stream_429_is_not_retried(monkeypatch):
    """If a model streamed content before 429, re-raise (don't tear the reply)."""
    served = []
    with pytest.raises(_ResourceExhaustedError):
        await _drain(
            _model(), monkeypatch,
            _fake(set(), served, yield_then_fail={"gemini-3.5-flash"}),
        )
    assert served == ["gemini-3.5-flash"]  # did not advance after partial output
