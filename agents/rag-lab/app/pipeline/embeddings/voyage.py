from __future__ import annotations

import os


class VoyageEmbedder:
    name = "voyage-3"
    dim = 1024

    def __init__(self, model: str = "voyage-3", key_env: str = "VOYAGE_API_KEY", api_key: str | None = None) -> None:
        import voyageai

        # api_key is already resolved by auth.resolve_key — do not fall back to env here.
        resolved = api_key
        if not resolved:
            raise RuntimeError(
                "No API key provided. Enter your Voyage/Anthropic key or the owner passphrase in the UI."
            )
        self._client = voyageai.Client(api_key=resolved)
        self._model = model
        self.name = model

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        result = self._client.embed(texts, model=self._model, input_type="document")
        return result.embeddings

    def embed_query(self, text: str) -> list[float]:
        result = self._client.embed([text], model=self._model, input_type="query")
        return result.embeddings[0]
