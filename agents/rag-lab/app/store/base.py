from __future__ import annotations

from typing import Protocol


class VectorStore(Protocol):
    def add(
        self,
        ids: list[str],
        embeddings: list[list[float]],
        documents: list[str],
        metadatas: list[dict],
    ) -> None: ...

    def query(
        self,
        query_embedding: list[float],
        n_results: int,
    ) -> list[dict]: ...

    def reset(self) -> None: ...
