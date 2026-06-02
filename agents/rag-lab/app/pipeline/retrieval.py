from __future__ import annotations

import asyncio
from typing import Any, AsyncGenerator

from app.pipeline.fusion import rrf
from app.pipeline.lexical import bm25_search
from app.state import SessionState

# Deliberate pacing so each retrieval phase is watchable in a recording.
PACE_EMBED = 1.0     # after the query lands in the 3D space
PACE_DENSE = 0.9     # after semantic results
PACE_SPARSE = 0.9    # after lexical results
PACE_FUSE = 0.7      # after fusion, before generation


async def hybrid_search(
    query: str,
    state: SessionState,
    embedder: Any,
    top_k: int = 5,
    iteration: int = 0,
) -> AsyncGenerator[dict[str, Any], None]:
    """Async generator yielding SSE event dicts for the full retrieval pipeline."""

    # Embed query — use cached vector if available (avoids burning rate-limit quota
    # on repeated calls in agentic tool-use loops).
    cached = state.get_query_embedding(query)
    if cached is not None:
        q_vec = cached
        first_embed = False
    else:
        q_vec = await _embed_query(query, embedder)
        state.set_query_embedding(query, q_vec)
        first_embed = True

    q_3d = state.pca.transform(q_vec.reshape(1, -1))[0].tolist()

    yield {
        "type": "query_embedded",
        "vectorPreview": q_vec[:8].tolist(),
        "dim": int(q_vec.shape[0]),
        "point": q_3d,
        "cached": not first_embed,
    }
    if first_embed:
        await asyncio.sleep(PACE_EMBED)

    # Dense retrieval
    dense = _dense_search(state, q_vec, top_k * 2)
    dense_with_points = _attach_points(dense, state)
    yield {
        "type": "dense_results",
        "iteration": iteration,
        "results": dense_with_points,
    }
    await asyncio.sleep(PACE_DENSE)

    # Sparse (BM25) retrieval
    sparse = bm25_search(state.bm25, state.chunks, query, top_k * 2)
    yield {
        "type": "sparse_results",
        "iteration": iteration,
        "results": sparse,
    }
    await asyncio.sleep(PACE_SPARSE)

    # Fusion
    fused = rrf(dense, sparse, top_k)
    yield {
        "type": "fused_results",
        "iteration": iteration,
        "results": fused,
    }
    await asyncio.sleep(PACE_FUSE)


async def _embed_query(query: str, embedder: Any) -> Any:
    import asyncio
    import numpy as np

    loop = asyncio.get_event_loop()
    vec = await loop.run_in_executor(None, embedder.embed_query, query)
    return np.array(vec, dtype=float)


def _dense_search(state: SessionState, q_vec: Any, top_k: int) -> list[dict[str, Any]]:
    import numpy as np

    results = state.chroma_collection.query(
        query_embeddings=[q_vec.tolist()],
        n_results=min(top_k, len(state.chunks)),
    )
    ids = results["ids"][0]
    distances = results["distances"][0]
    documents = results["documents"][0]

    output = []
    for rank, (doc_id, dist, text) in enumerate(zip(ids, distances, documents)):
        idx = int(doc_id.split("_")[-1])
        output.append(
            {
                "chunkIndex": idx,
                "rank": rank,
                "score": float(1 - dist),
                "text": text,
            }
        )
    return output


def _attach_points(dense: list[dict[str, Any]], state: SessionState) -> list[dict[str, Any]]:
    out = []
    for r in dense:
        idx = r["chunkIndex"]
        pt = state.points_3d[idx].tolist() if state.points_3d is not None else [0, 0, 0]
        out.append({**r, "point": pt})
    return out
