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

        resolved = api_key or os.environ.get("GOOGLE_API_KEY")
        if not resolved:
            raise RuntimeError(
                "No Google API key found. Provide a key in the UI or set GOOGLE_API_KEY in the server environment."
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
