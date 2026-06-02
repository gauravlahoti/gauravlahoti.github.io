from __future__ import annotations

import os


class VoyageEmbedder:
    name = "voyage-3"
    dim = 1024

    def __init__(self, model: str = "voyage-3", key_env: str = "VOYAGE_API_KEY", api_key: str | None = None) -> None:
        import voyageai

        resolved = (
            api_key
            or os.environ.get(key_env)
            or os.environ.get("ANTHROPIC_API_KEY")
            or os.environ.get("VOYAGE_API_KEY")
        )
        if not resolved:
            raise RuntimeError(
                "No Voyage/Anthropic API key found. Provide a key in the UI or "
                "set VOYAGE_API_KEY / ANTHROPIC_API_KEY in the server environment."
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
