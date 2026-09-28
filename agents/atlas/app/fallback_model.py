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
        last_err: _ResourceExhaustedError | None = None

        for idx, (model_name, backend) in enumerate(candidates):
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


async def _aclose_quietly(gen: AsyncGenerator) -> None:
    """Close an abandoned stream; a half-open request failing to close cleanly
    is not the visitor's problem."""
    try:
        await gen.aclose()
    except Exception:  # noqa: BLE001
        logger.debug("atlas: closing abandoned primary stream failed", exc_info=True)
