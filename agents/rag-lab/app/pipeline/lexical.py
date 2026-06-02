from __future__ import annotations

import re
from typing import Any

from rank_bm25 import BM25Okapi


def _tokenize(text: str) -> list[str]:
    return re.split(r"[\s\W]+", text.lower())


def build_bm25(chunks: list[dict[str, Any]]) -> BM25Okapi:
    corpus = [_tokenize(c["text"]) for c in chunks]
    return BM25Okapi(corpus)


def bm25_search(
    bm25: BM25Okapi,
    chunks: list[dict[str, Any]],
    query: str,
    top_k: int = 10,
) -> list[dict[str, Any]]:
    """Return ranked results with matched term highlighting."""
    query_tokens = _tokenize(query)
    scores = bm25.get_scores(query_tokens)

    # Only keep chunks with a real keyword match (score > 0); never pad with zeros.
    ranked = [
        (idx, score)
        for idx, score in sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
        if score > 0
    ][:top_k]

    results = []
    for rank, (idx, score) in enumerate(ranked):
        chunk = chunks[idx]
        chunk_tokens = set(_tokenize(chunk["text"]))
        matched = [t for t in query_tokens if t and t in chunk_tokens]
        results.append(
            {
                "chunkIndex": idx,
                "rank": rank,
                "bm25Score": float(score),
                "text": chunk["text"],
                "matchedTerms": matched,
            }
        )
    return results
