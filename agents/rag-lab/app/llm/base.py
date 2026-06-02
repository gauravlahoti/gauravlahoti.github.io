from __future__ import annotations

from typing import AsyncGenerator, Any, Protocol


class LLMGenerator(Protocol):
    async def generate(
        self,
        query: str,
        context: str,
        mode: str,
        retrieval_fn: Any,
    ) -> AsyncGenerator[dict[str, Any], None]: ...
