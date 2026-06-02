from __future__ import annotations

from typing import Any


def rrf(
    dense: list[dict[str, Any]],
    sparse: list[dict[str, Any]],
    top_k: int = 5,
    k: int = 60,
) -> list[dict[str, Any]]:
    """Reciprocal Rank Fusion over dense + BM25 result lists."""
    dense_rank = {r["chunkIndex"]: r["rank"] for r in dense}
    sparse_rank = {r["chunkIndex"]: r["rank"] for r in sparse}

    all_indices = set(dense_rank) | set(sparse_rank)
    scores: dict[int, float] = {}
    for idx in all_indices:
        dr = dense_rank.get(idx, len(dense) + k)
        sr = sparse_rank.get(idx, len(sparse) + k)
        scores[idx] = 1 / (k + dr) + 1 / (k + sr)

    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]

    # Build provenance-rich output
    dense_map = {r["chunkIndex"]: r for r in dense}
    sparse_map = {r["chunkIndex"]: r for r in sparse}
    results = []
    for fused_rank, (idx, score) in enumerate(ranked):
        d = dense_map.get(idx, {})
        s = sparse_map.get(idx, {})
        results.append(
            {
                "chunkIndex": idx,
                "rank": fused_rank,
                "rrfScore": score,
                "denseRank": dense_rank.get(idx),
                "sparseRank": sparse_rank.get(idx),
                "text": d.get("text") or s.get("text", ""),
                "denseScore": d.get("score"),
                "bm25Score": s.get("bm25Score"),
            }
        )
    return results
