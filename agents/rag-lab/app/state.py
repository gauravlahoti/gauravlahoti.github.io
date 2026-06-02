from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np


@dataclass
class SessionState:
    # Pipeline artefacts
    chunks: list[dict[str, Any]] = field(default_factory=list)
    embeddings: np.ndarray | None = None       # shape (N, dim)
    points_3d: np.ndarray | None = None        # shape (N, 3), bbox-normalised
    bm25: Any = None                           # BM25Okapi instance
    chroma_collection: Any = None              # chromadb.Collection
    pca: Any = None                            # PCA3D instance

    # Model metadata
    embedding_model: str = "voyage-3"
    embedding_dim: int = 0

    # Query embedding cache — keyed by query string to avoid re-embedding in agentic loops.
    _query_cache: dict = field(default_factory=dict)

    def get_query_embedding(self, query: str):
        return self._query_cache.get(query)

    def set_query_embedding(self, query: str, vec) -> None:
        self._query_cache[query] = vec

    def reset(self) -> None:
        self.chunks = []
        self.embeddings = None
        self.points_3d = None
        self.bm25 = None
        self.pca = None
        self.embedding_model = "voyage-3"
        self.embedding_dim = 0
        self._query_cache = {}
        if self.chroma_collection is not None:
            try:
                import chromadb
                client = chromadb.EphemeralClient()
                client.delete_collection("rag_lab")
            except Exception:
                pass
            self.chroma_collection = None


# Single global instance — single-user demo
session = SessionState()
