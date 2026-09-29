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
from google.genai.errors import ClientError, ServerError

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


def _server_error(model_name, code, status):
    return ServerError(
        code,
        {
            "error": {
                "code": code,
                "status": status,
                "message": f"{status.lower()} for {model_name}",
            }
        },
        None,
    )


def _resp(text):
    return LlmResponse(
        content=types.Content(role="model", parts=[types.Part(text=text)])
    )


def _fake(exhausted: set, served: list, *, yield_then_fail: set = frozenset(),
          raise_other: set = frozenset(), server_errors: dict = None):
    """Build a fake parent generate_content_async that records the model used.

    `server_errors` maps a model name → (code, status) for a `ServerError`
    (e.g. 503 UNAVAILABLE for capacity, 500 INTERNAL for a request problem).
    """
    server_errors = server_errors or {}

    async def fake(self, llm_request, stream=False):
        m = llm_request.model
        served.append(m)
        if m in server_errors:
            raise _server_error(m, *server_errors[m])
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


@pytest.mark.asyncio
async def test_falls_back_on_503_server_error(monkeypatch):
    """A 503 UNAVAILABLE (model overloaded) cascades to the next model."""
    served = []
    out = await _drain(
        _model(), monkeypatch,
        _fake(set(), served,
              server_errors={"gemini-3.5-flash": (503, "UNAVAILABLE")}),
    )
    assert served == ["gemini-3.5-flash", "gemini-2.5-flash"]
    assert out[0].content.parts[0].text == "answer from gemini-2.5-flash"


@pytest.mark.asyncio
async def test_non_503_server_error_does_not_fall_back(monkeypatch):
    """A 500 INTERNAL signals a request problem — propagate, don't cascade."""
    served = []
    with pytest.raises(ServerError):
        await _drain(
            _model(), monkeypatch,
            _fake(set(), served,
                  server_errors={"gemini-3.5-flash": (500, "INTERNAL")}),
        )
    assert served == ["gemini-3.5-flash"]  # no cascade on non-capacity errors


def test_production_model_chain():
    """Guards the real cascade wired into root_agent (app/agent.py) against
    silent drift. CHAIN above is a synthetic 3-model chain used only to
    exercise FallbackGemini's cascade-twice code path — this checks the
    actual production configuration, which is intentionally shorter.
    """
    from app.agent import root_agent

    assert root_agent.model.model == "gemini-3.6-flash"
    assert root_agent.model.fallback_models == ["gemini-3.5-flash-lite", "gemini-3.7-flash"]


def test_primary_pinned_to_vertex_adk_deploy_trail():
    """The primary always runs on Vertex/adk-deploy-trail (reliable capacity),
    regardless of the AI Studio/Vertex-via-ADC choice agent.py makes based on
    ambient env — that ambient config no longer affects any model in the
    cascade, since every candidate now forces the same Vertex backend.
    """
    model = _model()
    client = model.api_client
    assert client.vertexai is True
    assert client._api_client.project == "adk-deploy-trail"
    assert client._api_client.location == "global"


def test_fallback_candidate_also_pinned_to_vertex(monkeypatch):
    """A fallback attempt must ALSO run on Vertex/adk-deploy-trail — the fallback
    exists for model-availability redundancy, not a different (free-tier)
    cost tier, so ambient env (e.g. GEMINI_API_KEY set -> AI Studio) must NOT
    change its backend, unlike a plain, unmodified Gemini(model=name) would.
    """
    monkeypatch.setenv("GEMINI_API_KEY", "dummy-test-key")
    monkeypatch.delenv("GOOGLE_GENAI_USE_VERTEXAI", raising=False)
    fallback_client = FallbackGemini(model=CHAIN[1]).api_client
    assert fallback_client.vertexai is True
    assert fallback_client._api_client.project == "adk-deploy-trail"


# --- spec 67: first-token watchdog ------------------------------------------

def _stalling(served: list, *, stall: set, stall_s: float = 5.0, slow_after_first: set = frozenset()):
    """A fake whose `stall` models sit silent before their first chunk (a
    queued request, not an error), and whose `slow_after_first` models start
    at once but then take a while between chunks."""
    import asyncio

    async def fake(self, llm_request, stream=False):
        m = llm_request.model
        served.append(m)
        if m in stall:
            await asyncio.sleep(stall_s)
        yield _resp(f"first from {m}")
        if m in slow_after_first:
            await asyncio.sleep(stall_s)
        yield _resp(f"rest from {m}")

    return fake


@pytest.mark.asyncio
async def test_stalled_primary_falls_back_after_first_token_timeout(monkeypatch):
    import app.fallback_model as fm
    monkeypatch.setattr(fm, "PRIMARY_FIRST_TOKEN_TIMEOUT_S", 0.05)
    monkeypatch.setattr(fm, "HEDGE_AFTER_S", 0.02)
    served = []
    out = await _drain(_model(), monkeypatch, _stalling(served, stall={"gemini-3.5-flash"}))
    assert served == ["gemini-3.5-flash", "gemini-2.5-flash"]
    assert [r.content.parts[0].text for r in out] == [
        "first from gemini-2.5-flash", "rest from gemini-2.5-flash",
    ]


@pytest.mark.asyncio
async def test_started_answer_is_never_cut_off(monkeypatch):
    import app.fallback_model as fm
    monkeypatch.setattr(fm, "PRIMARY_FIRST_TOKEN_TIMEOUT_S", 0.05)
    monkeypatch.setattr(fm, "HEDGE_AFTER_S", 0.02)
    served = []
    out = await _drain(
        _model(), monkeypatch,
        _stalling(served, stall=set(), stall_s=0.2, slow_after_first={"gemini-3.5-flash"}),
    )
    assert served == ["gemini-3.5-flash"]  # slow between chunks is fine once it has started
    assert [r.content.parts[0].text for r in out][-1] == "rest from gemini-3.5-flash"


@pytest.mark.asyncio
async def test_last_candidate_is_never_timed_out(monkeypatch):
    import app.fallback_model as fm
    monkeypatch.setattr(fm, "PRIMARY_FIRST_TOKEN_TIMEOUT_S", 0.05)
    monkeypatch.setattr(fm, "HEDGE_AFTER_S", 0.02)
    served = []
    out = await _drain(
        _model(), monkeypatch,
        _stalling(served, stall=set(CHAIN), stall_s=0.1),
    )
    # The first two stall past the race deadline; the last one has nowhere to
    # go, so it is allowed to take its time rather than fail the turn.
    assert served == CHAIN
    assert out[-1].content.parts[0].text == "rest from gemini-2.5-flash-lite"


# --- hedged first token: race the next model instead of waiting it out ------

def _timed(served: list, first_after: dict, *, closed: list | None = None, fail_after: dict | None = None):
    """A fake whose models each produce their first chunk after
    `first_after[model]` seconds (or raise a 429 after `fail_after[model]`),
    recording which were started and which were torn down unfinished."""
    import asyncio

    fail_after = fail_after or {}

    async def fake(self, llm_request, stream=False):
        m = llm_request.model
        served.append(m)
        try:
            if m in fail_after:
                await asyncio.sleep(fail_after[m])
                raise _exhausted(m)
            await asyncio.sleep(first_after.get(m, 0))
            yield _resp(f"first from {m}")
            yield _resp(f"rest from {m}")
        except (asyncio.CancelledError, GeneratorExit):
            if closed is not None:
                closed.append(m)
            raise

    return fake


def _texts(out):
    return [r.content.parts[0].text for r in out]


@pytest.fixture
def fast_race(monkeypatch):
    import app.fallback_model as fm
    monkeypatch.setattr(fm, "HEDGE_AFTER_S", 0.05)
    monkeypatch.setattr(fm, "PRIMARY_FIRST_TOKEN_TIMEOUT_S", 0.5)


@pytest.mark.asyncio
async def test_fast_primary_never_starts_the_hedge(monkeypatch, fast_race):
    served = []
    out = await _drain(_model(), monkeypatch, _timed(served, {CHAIN[0]: 0.0}))
    assert served == [CHAIN[0]]
    assert _texts(out) == [f"first from {CHAIN[0]}", f"rest from {CHAIN[0]}"]


@pytest.mark.asyncio
async def test_slow_primary_still_wins_if_it_speaks_first(monkeypatch, fast_race):
    served, closed = [], []
    out = await _drain(
        _model(), monkeypatch,
        _timed(served, {CHAIN[0]: 0.1, CHAIN[1]: 0.4}, closed=closed),
    )
    assert served == [CHAIN[0], CHAIN[1]]  # hedge started at 0.05s...
    assert _texts(out) == [f"first from {CHAIN[0]}", f"rest from {CHAIN[0]}"]
    import asyncio
    await asyncio.sleep(0.05)
    assert closed == [CHAIN[1]]  # ...and the losing hedge was torn down


@pytest.mark.asyncio
async def test_stalled_primary_loses_to_the_hedge(monkeypatch, fast_race):
    served, closed = [], []
    out = await _drain(
        _model(), monkeypatch,
        _timed(served, {CHAIN[0]: 5.0, CHAIN[1]: 0.05}, closed=closed),
    )
    assert served == [CHAIN[0], CHAIN[1]]
    assert _texts(out) == [f"first from {CHAIN[1]}", f"rest from {CHAIN[1]}"]
    import asyncio
    await asyncio.sleep(0.05)
    assert closed == [CHAIN[0]]


@pytest.mark.asyncio
async def test_primary_429_after_the_hedge_leaves_the_hedge_serving(monkeypatch, fast_race):
    served = []
    out = await _drain(
        _model(), monkeypatch,
        _timed(served, {CHAIN[1]: 0.2}, fail_after={CHAIN[0]: 0.1}),
    )
    assert served == [CHAIN[0], CHAIN[1]]
    assert _texts(out)[-1] == f"rest from {CHAIN[1]}"


@pytest.mark.asyncio
async def test_hedge_429_leaves_the_primary_serving(monkeypatch, fast_race):
    served = []
    out = await _drain(
        _model(), monkeypatch,
        _timed(served, {CHAIN[0]: 0.2}, fail_after={CHAIN[1]: 0.0}),
    )
    assert served == [CHAIN[0], CHAIN[1]]
    assert _texts(out)[-1] == f"rest from {CHAIN[0]}"


@pytest.mark.asyncio
async def test_both_silent_past_the_deadline_goes_to_the_last_model(monkeypatch, fast_race):
    served, closed = [], []
    out = await _drain(
        _model(), monkeypatch,
        _timed(served, {CHAIN[0]: 5.0, CHAIN[1]: 5.0, CHAIN[2]: 0.0}, closed=closed),
    )
    assert served == CHAIN
    assert _texts(out)[-1] == f"rest from {CHAIN[2]}"
    import asyncio
    await asyncio.sleep(0.05)
    assert sorted(closed) == sorted(CHAIN[:2])


@pytest.mark.asyncio
async def test_hedge_winner_is_never_cut_off_between_chunks(monkeypatch, fast_race):
    import asyncio

    served = []

    async def fake(self, llm_request, stream=False):
        m = llm_request.model
        served.append(m)
        if m == CHAIN[0]:
            await asyncio.sleep(5.0)
        yield _resp(f"first from {m}")
        await asyncio.sleep(0.7)  # longer than the race deadline, after starting
        yield _resp(f"rest from {m}")

    out = await _drain(_model(), monkeypatch, fake)
    assert served == [CHAIN[0], CHAIN[1]]
    assert _texts(out) == [f"first from {CHAIN[1]}", f"rest from {CHAIN[1]}"]


@pytest.mark.asyncio
async def test_two_model_chain_never_times_out_the_hedge(monkeypatch, fast_race):
    served = []
    model = FallbackGemini(model=CHAIN[0], fallback_models=[CHAIN[1]])
    out = await _drain(model, monkeypatch, _timed(served, {CHAIN[0]: 5.0, CHAIN[1]: 0.8}))
    # 0.8s is past the 0.5s race deadline, but lite is the last candidate.
    assert _texts(out)[-1] == f"rest from {CHAIN[1]}"
