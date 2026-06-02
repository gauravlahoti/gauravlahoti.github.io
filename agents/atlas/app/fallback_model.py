# ruff: noqa
"""Free-tier model cascade for the Atlas chat agent.

Each Gemini model carries its OWN AI Studio free-tier daily quota
(`GenerateRequestsPerDayPerProjectPerModel-FreeTier`). So when the primary
model returns `429 RESOURCE_EXHAUSTED`, we transparently retry the same request
against the next model in the chain instead of failing the visitor's turn. This
keeps the widget alive on the free tier (no Vertex AI, no paid billing) by
spreading load across several models' separate daily caps.

The ADK Gemini model raises the 429 *before* it yields any chunk (the
`generate_content_stream` await fails up front — see
`google.adk.models.google_llm.generate_content_async`), so the cascade never
emits partial output before switching models. If a model has already streamed
content and then errors, we re-raise rather than risk a torn response.
"""

import logging
from collections.abc import AsyncGenerator

from google.adk.models import Gemini
from google.adk.models.google_llm import _ResourceExhaustedError
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from pydantic import Field

logger = logging.getLogger(__name__)


class FallbackGemini(Gemini):
    """Gemini model that cascades across `fallback_models` on free-tier 429s.

    `model` is the primary (tried first); `fallback_models` are tried in order
    only when the preceding model is quota-exhausted. All other errors propagate
    unchanged.
    """

    fallback_models: list[str] = Field(default_factory=list)

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        candidates = [self.model, *self.fallback_models]
        last_err: _ResourceExhaustedError | None = None

        for idx, model_name in enumerate(candidates):
            # Deep-copy on fallback attempts so per-request preprocessing from a
            # prior (exhausted) attempt never accumulates onto the retry.
            attempt = llm_request if idx == 0 else llm_request.model_copy(deep=True)
            attempt.model = model_name
            produced = False
            try:
                async for resp in super().generate_content_async(attempt, stream):
                    produced = True
                    yield resp
                if idx > 0:
                    logger.warning("atlas: turn served by fallback model %s", model_name)
                return
            except _ResourceExhaustedError as err:
                last_err = err
                if produced:
                    # Mid-stream exhaustion: a clean model switch is impossible
                    # without a torn reply, so surface the error.
                    raise
                if idx < len(candidates) - 1:
                    logger.warning(
                        "atlas: %s hit free-tier 429; falling back to %s",
                        model_name,
                        candidates[idx + 1],
                    )
                    continue
                raise

        if last_err is not None:  # pragma: no cover - defensive
            raise last_err
