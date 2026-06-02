from __future__ import annotations

from app.pipeline.embeddings.base import Embedder


def get_embedder(model_id: str, api_key: str | None = None) -> Embedder:
    if model_id == "voyage-3":
        from app.pipeline.embeddings.voyage import VoyageEmbedder
        return VoyageEmbedder("voyage-3", key_env="VOYAGE_API_KEY", api_key=api_key)
    if model_id == "voyage-3-anthropic":
        from app.pipeline.embeddings.voyage import VoyageEmbedder
        return VoyageEmbedder("voyage-3", key_env="ANTHROPIC_API_KEY", api_key=api_key)
    if model_id in ("gemini-embedding-2", "gemini-embedding-001", "text-embedding-004"):
        from app.pipeline.embeddings.google import GoogleEmbedder
        return GoogleEmbedder(model_id, api_key=api_key)
    raise ValueError(f"Unknown embedding model: {model_id!r}")
