from __future__ import annotations

import os

# Output dimensionality per model (used only for display; PCA handles any dim).
_MODEL_DIMS = {
    "gemini-embedding-2": 3072,
    "gemini-embedding-001": 3072,
    "text-embedding-004": 768,
}


class GoogleEmbedder:
    """Google embeddings via the google-genai SDK (`from google import genai`)."""

    def __init__(self, model: str = "gemini-embedding-2", api_key: str | None = None) -> None:
        from google import genai

        resolved = api_key  # resolved by auth.resolve_key — no env fallback here
        if not resolved:
            raise RuntimeError(
                "No API key provided. Enter your Google key or the owner passphrase in the UI."
            )
        self._client = genai.Client(api_key=resolved)
        self._model = model
        self.name = model
        self.dim = _MODEL_DIMS.get(model, 768)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        result = self._client.models.embed_content(
            model=self._model,
            contents=texts,
            config={"task_type": "RETRIEVAL_DOCUMENT"},
        )
        return [list(e.values) for e in result.embeddings]

    def embed_query(self, text: str) -> list[float]:
        result = self._client.models.embed_content(
            model=self._model,
            contents=text,
            config={"task_type": "RETRIEVAL_QUERY"},
        )
        return list(result.embeddings[0].values)
