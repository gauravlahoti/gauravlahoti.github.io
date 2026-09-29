# ruff: noqa
"""Model cascade for the Atlas chat agent.

Both the primary and fallback models run on Vertex AI / `adk-deploy-trail` (paid,
reliable capacity — see `FallbackGemini.api_client`), after the AI Studio
free tier proved unreliable for gemini-3.7-flash in production (near-100%
`503 UNAVAILABLE`). The fallback exists purely for model-availability
redundancy now, not a free-tier safety net: on a `429 RESOURCE_EXHAUSTED` or
`503 UNAVAILABLE` from the primary, we transparently retry the same request
against the fallback instead of failing the visitor's turn.

The ADK Gemini model raises these errors *before* it yields any chunk (the
`generate_content_stream` await fails up front — see
`google.adk.models.google_llm.generate_content_async`), so the cascade never
emits partial output before switching models. If a model has already streamed
content and then errors, we re-raise rather than risk a torn response.
"""

import asyncio
import logging
import os
from collections.abc import AsyncGenerator
from functools import cached_property

from google.adk.models import Gemini
from google.adk.models.google_llm import _ResourceExhaustedError
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import Client, types
from google.genai.errors import ServerError
from pydantic import Field

logger = logging.getLogger(__name__)

# Every model in the cascade is pinned to Vertex AI on this project,
# regardless of environment (local dev or Cloud Run prod) — see
# FallbackGemini.api_client. Chosen after gemini-3.7-flash proved unreliable
# on the AI Studio free tier (near-100% 503 UNAVAILABLE in production logs
# shortly after launch); this is the same project tests/eval/eval_config.yaml's
# judge already runs on, for the same free-tier-unreliability reason.
ATLAS_VERTEX_PROJECT = "adk-deploy-trail"
ATLAS_VERTEX_LOCATION = "global"
# Private aliases kept so existing internal references below are untouched.
_ATLAS_VERTEX_PROJECT = ATLAS_VERTEX_PROJECT
# Spec 67: how long the primary gets to produce its first streamed chunk
# before the turn moves to the next model. gemini-3.7-flash on this project
# queues erratically (measured 2026-09-26: 4-42s to first token on a
# three-word prompt, and 112s on a real turn), while gemini-3.6-flash
# answered in 1.6-2.4s every time. A queued request is not an error, so the
# 429/503 cascade below never fired; it just waited. Only the first chunk is
# timed, so a long answer that has started is never cut off.
PRIMARY_FIRST_TOKEN_TIMEOUT_S = 4.0
# How long the primary gets before the next model is started *alongside* it,
# not instead of it. Waiting the full 4s and then starting over was the whole
# slow tail in production (2026-09-29, 7 days of chat-timing): every turn past
# ~7s to first text was "gemini-3.6-flash gave no first token in 4s", then
# 2-3.5s more for the lite model from a cold start. Racing from 2s means a
# slow primary costs at most the lite model's own time, and a primary that is
# merely a little slow still wins. The duplicate request only happens on a
# silent primary (lite input is ~$0.002 for a 17k-token turn). Env-overridable
# so it can be tuned from the "hedge ... won" log lines without a code change.
HEDGE_AFTER_S = float(os.environ.get("ATLAS_HEDGE_AFTER_S", "2.0"))
_ATLAS_VERTEX_LOCATION = ATLAS_VERTEX_LOCATION


class FallbackGemini(Gemini):
    """Gemini model that cascades to `fallback_models` on 429/503 errors.

    Every model in the chain — `model` (primary) and each entry in
    `fallback_models` — runs on Vertex AI / `adk-deploy-trail`, forced via
    `api_client` below regardless of ambient env config. Fallback candidates
    are built as fresh `FallbackGemini(model=name)` instances (inheriting the
    same forced-Vertex `api_client`) purely for model-availability
    redundancy, not a different cost tier. All other errors propagate
    unchanged.
    """

    fallback_models: list[str] = Field(default_factory=list)

    @cached_property
    def api_client(self) -> Client:
        """Forces this model onto Vertex/adk-deploy-trail, mirroring the base
        class's own api_client (same retry_options/tracking headers/base_url
        handling) but with a fixed backend instead of one derived from
        ambient env config. Applies to every instance in the cascade —
        primary and each fallback candidate alike.
        """
        base_url, api_version = self._base_url_and_api_version
        http_kwargs: dict[str, object] = {
            "headers": self._tracking_headers(),
            "retry_options": self.retry_options,
            "base_url": base_url,
        }
        if api_version:
            http_kwargs["api_version"] = api_version
        return Client(
            vertexai=True,
            project=_ATLAS_VERTEX_PROJECT,
            location=_ATLAS_VERTEX_LOCATION,
            http_options=types.HttpOptions(**http_kwargs),
        )

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        # (model_name, backend) — the primary uses `self`; each fallback is a
        # fresh FallbackGemini(model=name) instance, so every candidate gets
        # its own api_client cache but all resolve to the same forced-Vertex
        # backend above.
        candidates: list[tuple[str, Gemini]] = [(self.model, self)] + [
            (name, FallbackGemini(model=name)) for name in self.fallback_models
        ]
        start, last_err = 0, None
        if stream and len(candidates) > 1:
            outcome = await _race_first_token(candidates, llm_request)
            if outcome is _EMPTY:
                return
            if isinstance(outcome, _Won):
                async for resp in outcome.stream():
                    yield resp
                return
            start, last_err = outcome

        async for resp in _sequential(candidates, llm_request, stream, start, last_err):
            yield resp


async def _sequential(
    candidates: list[tuple[str, Gemini]],
    llm_request: LlmRequest,
    stream: bool,
    start: int,
    last_err: Exception | None,
) -> AsyncGenerator[LlmResponse, None]:
    """One model at a time from `start`: the original cascade. Serves
    non-streamed calls, and whatever is left after the hedged race."""
    for idx in range(start, len(candidates)):
        model_name, backend = candidates[idx]
        # Deep-copy on fallback attempts so per-request preprocessing from a
        # prior (exhausted) attempt never accumulates onto the retry.
        attempt = llm_request if idx == 0 else llm_request.model_copy(deep=True)
        attempt.model = model_name
        produced = False
        gen = Gemini.generate_content_async(backend, attempt, stream)
        try:
            # First-token watchdog: only on streamed turns, and only while
            # there is still a model to fall back to.
            if stream and idx < len(candidates) - 1:
                try:
                    first = await asyncio.wait_for(anext(gen), PRIMARY_FIRST_TOKEN_TIMEOUT_S)
                except StopAsyncIteration:
                    return
                except TimeoutError:
                    await _aclose_quietly(gen)
                    logger.warning(
                        "atlas: %s gave no first token in %.0fs; falling back to %s",
                        model_name,
                        PRIMARY_FIRST_TOKEN_TIMEOUT_S,
                        candidates[idx + 1][0],
                    )
                    continue
                produced = True
                yield first
            async for resp in gen:
                produced = True
                yield resp
            if idx > 0:
                logger.warning("atlas: turn served by fallback model %s", model_name)
            return
        except (ServerError, _ResourceExhaustedError) as err:
            # Only cascade on transient capacity errors (503 UNAVAILABLE or
            # 429 RESOURCE_EXHAUSTED). Other ServerError codes (e.g. 500)
            # indicate a request problem — propagate unchanged.
            if isinstance(err, ServerError) and err.code != 503:
                raise
            last_err = err
            if produced:
                # Mid-stream error: a clean model switch is impossible
                # without a torn reply, so surface the error.
                raise
            if idx < len(candidates) - 1:
                logger.warning(
                    "atlas: %s returned %s; falling back to %s",
                    model_name,
                    err.code if isinstance(err, ServerError) else 429,
                    candidates[idx + 1][0],
                )
                continue
            raise

    if last_err is not None:  # pragma: no cover - defensive
        raise last_err


def _is_capacity(err: BaseException) -> bool:
    """429 RESOURCE_EXHAUSTED or 503 UNAVAILABLE: worth trying another model.
    Other ServerError codes (e.g. 500) indicate a request problem."""
    return isinstance(err, _ResourceExhaustedError) or (
        isinstance(err, ServerError) and err.code == 503
    )


class _Racer:
    """One model's streamed call, read to the end inside its own task and
    handed over through a queue. The stream is only ever iterated by that
    task, so its HTTP stream and ADK's Aclosing blocks open and close in
    the same task, and a losing racer is torn down by cancelling it."""

    def __init__(self, idx: int, candidate: tuple[str, Gemini], llm_request: LlmRequest) -> None:
        self.idx = idx
        self.name, backend = candidate
        # Deep-copy for any model but the primary, so per-request
        # preprocessing from one attempt never accumulates onto another.
        attempt = llm_request if idx == 0 else llm_request.model_copy(deep=True)
        attempt.model = self.name
        self.queue: asyncio.Queue[tuple[str, object]] = asyncio.Queue()
        self.task = asyncio.ensure_future(
            self._run(Gemini.generate_content_async(backend, attempt, True))
        )

    async def _run(self, gen: AsyncGenerator[LlmResponse, None]) -> None:
        try:
            async for resp in gen:
                self.queue.put_nowait(("item", resp))
            self.queue.put_nowait(("end", None))
        except Exception as err:  # noqa: BLE001 - handed to the reader
            self.queue.put_nowait(("error", err))
        finally:
            await _aclose_quietly(gen)

    def cancel(self) -> None:
        self.task.cancel()


class _Won:
    """The racer that produced a first chunk, streamed to the end."""

    def __init__(self, racer: _Racer, first: LlmResponse) -> None:
        self.racer = racer
        self.first = first

    async def stream(self) -> AsyncGenerator[LlmResponse, None]:
        try:
            yield self.first
            while True:
                kind, value = await self.racer.queue.get()
                if kind == "item":
                    yield value
                elif kind == "end":
                    break
                else:
                    # Mid-stream error: a clean model switch is impossible
                    # without a torn reply, so surface the error.
                    raise value
            if self.racer.idx > 0:
                logger.warning("atlas: turn served by fallback model %s", self.racer.name)
        finally:
            self.racer.cancel()  # no-op once it has finished; stops it if the turn is abandoned


_EMPTY = object()  # a stream that ended without a single chunk


async def _race_first_token(
    candidates: list[tuple[str, Gemini]], llm_request: LlmRequest
) -> "_Won | object | tuple[int, Exception | None]":
    """Race the primary against the next model for the first chunk.

    The primary starts alone. If it is still silent after HEDGE_AFTER_S the
    next model starts alongside it, and whichever produces a first chunk wins;
    the other is cancelled. Returns the winner, `_EMPTY`, or `(index, error)`:
    where `_sequential` should carry on (the primary failed on capacity before
    the hedge, both racers failed on capacity, or neither spoke within
    PRIMARY_FIRST_TOKEN_TIMEOUT_S of the hedge starting). When the second
    racer is the last candidate there is nowhere left to go, so it is never
    timed out.
    """
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    waiting: dict[asyncio.Future, _Racer] = {}

    def start(idx: int) -> None:
        racer = _Racer(idx, candidates[idx], llm_request)
        waiting[asyncio.ensure_future(racer.queue.get())] = racer

    start(0)
    hedged = False
    deadline: float | None = None
    last_err: Exception | None = None
    try:
        while waiting:
            if not hedged:
                timeout: float | None = max(0.0, HEDGE_AFTER_S - (loop.time() - t0))
            elif deadline is not None:
                timeout = max(0.0, deadline - loop.time())
            else:
                timeout = None
            done, _ = await asyncio.wait(waiting, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
            if not done:
                if not hedged:
                    hedged = True
                    start(1)
                    if len(candidates) > 2:
                        deadline = loop.time() + PRIMARY_FIRST_TOKEN_TIMEOUT_S
                    logger.info(
                        "atlas: %s silent for %.1fs; racing %s alongside it",
                        candidates[0][0], HEDGE_AFTER_S, candidates[1][0],
                    )
                    continue
                logger.warning(
                    "atlas: no first token from %s or %s; falling back to %s",
                    candidates[0][0], candidates[1][0], candidates[2][0],
                )
                return (2, last_err)
            for fut in done:
                racer = waiting.pop(fut)
                kind, value = fut.result()
                if kind == "item":
                    if hedged:
                        logger.info(
                            "atlas: hedge %s won after %d ms",
                            racer.name, int((loop.time() - t0) * 1000),
                        )
                    return _Won(racer, value)
                racer.cancel()
                if kind == "end":
                    return _EMPTY
                err = value
                if not _is_capacity(err):
                    if racer.idx == 0:
                        raise err
                    # The hedge is a bonus; its own failure must not sink a
                    # turn the primary may still answer.
                    logger.warning("atlas: hedged %s failed (%s); waiting on %s", racer.name, err, candidates[0][0])
                    continue
                last_err = err
                if racer.idx == 0 and not hedged:
                    logger.warning(
                        "atlas: %s returned %s; falling back to %s",
                        racer.name, err.code if isinstance(err, ServerError) else 429, candidates[1][0],
                    )
                    return (1, last_err)
                logger.warning(
                    "atlas: %s returned %s during the race",
                    racer.name, err.code if isinstance(err, ServerError) else 429,
                )
        return (2, last_err)
    finally:
        for fut, racer in waiting.items():
            fut.cancel()
            racer.cancel()


async def _aclose_quietly(gen: AsyncGenerator) -> None:
    """Close an abandoned stream; a half-open request failing to close cleanly
    is not the visitor's problem."""
    try:
        await gen.aclose()
    except Exception:  # noqa: BLE001
        logger.debug("atlas: closing abandoned primary stream failed", exc_info=True)
