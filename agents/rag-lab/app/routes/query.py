from __future__ import annotations

import asyncio
import math
from typing import Any, AsyncGenerator

from fastapi import APIRouter
from pydantic import BaseModel

from app.auth import resolve_key
from app.pipeline.embeddings.registry import get_embedder
from app.pipeline.retrieval import hybrid_search
from app.sse import sse, streaming_response
from app.state import session

router = APIRouter()


class QueryRequest(BaseModel):
    query: str
    llm: str = "claude-sonnet-4-5"
    mode: str = "agentic"
    topK: int = 5
    embeddingApiKey: str = ""
    llmApiKey: str = ""


@router.post("/api/query")
async def query(req: QueryRequest):
    return streaming_response(_query_stream(req))


async def _query_stream(req: QueryRequest) -> AsyncGenerator[str, None]:
    if not session.chunks:
        yield sse({"type": "error", "stage": "query", "message": "No document ingested yet. Please ingest a document first."})
        return

    yield sse({
        "type": "query_started",
        "query": req.query,
        "llm": req.llm,
        "mode": req.mode,
    })

    # Resolve keys: owner passphrase → env key; real key → use directly; empty → env fallback.
    embed_key = resolve_key(req.embeddingApiKey, "VOYAGE_API_KEY")
    llm_key   = resolve_key(req.llmApiKey, "ANTHROPIC_API_KEY")

    # Clear embedding cache so a new run always re-embeds (not a leftover from a prior query).
    session._query_cache = {}
    embedder = get_embedder(session.embedding_model, api_key=embed_key)

    async def retrieval_fn(q: str, top_k: int, iteration: int = 0):
        """Yields SSE event dicts and also collects fused results."""
        async for ev in hybrid_search(q, session, embedder, top_k, iteration):
            yield ev

    try:
        if req.mode == "linear":
            # Run retrieval once, build context, then generate
            fused_results: list[dict] = []
            async for ev in hybrid_search(req.query, session, embedder, req.topK, 0):
                if ev.get("type") == "fused_results":
                    fused_results = ev.get("results", [])
                yield sse(ev)

            context, citations = _build_context(fused_results)
            token_est = math.ceil(len(context) / 4)
            yield sse({
                "type": "augmentation",
                "contextPreview": context[:500],
                "chunkIndices": [r["chunkIndex"] for r in fused_results],
                "tokenEstimate": token_est,
                "citations": citations,
            })
            await asyncio.sleep(0.9)  # linger on the assembled context before generating

            async for ev in _generate(req.query, context, req.mode, retrieval_fn, req.llm, llm_key):
                yield sse(ev)

        else:
            # Agentic: let the LLM call hybrid_search via tool use
            context = ""  # Not pre-built; LLM decides when to retrieve
            fused_results_holder: list[dict] = []

            async def agentic_retrieval_fn(q: str, top_k: int, iteration: int = 0):
                async for ev in hybrid_search(q, session, embedder, top_k, iteration):
                    if ev.get("type") == "fused_results":
                        fused_results_holder.clear()
                        fused_results_holder.extend(ev.get("results", []))
                    yield ev

            async for ev in _generate(req.query, context, req.mode, agentic_retrieval_fn, req.llm, llm_key):
                yield sse(ev)

            # After agentic generation, emit augmentation for the final retrieved context
            if fused_results_holder:
                ctx, citations = _build_context(fused_results_holder)
                yield sse({
                    "type": "augmentation",
                    "contextPreview": ctx[:500],
                    "chunkIndices": [r["chunkIndex"] for r in fused_results_holder],
                    "tokenEstimate": math.ceil(len(ctx) / 4),
                    "citations": citations,
                })
    except Exception as e:
        msg = str(e)
        if "RateLimit" in type(e).__name__ or "rate limit" in msg.lower():
            msg = "Voyage rate limit hit while embedding the query (free tier: 3 req/min, 10K tokens/min). Wait ~60s and try again."
        yield sse({"type": "error", "stage": "query", "message": msg})


async def _generate(
    query: str,
    context: str,
    mode: str,
    retrieval_fn,
    llm_id: str,
    api_key: str | None = None,
) -> AsyncGenerator[dict[str, Any], None]:
    if llm_id.startswith("claude"):
        from app.llm.anthropic_gen import generate
    else:
        from app.llm.google_gen import generate

    async for ev in generate(query, context, mode, retrieval_fn, model=llm_id, api_key=api_key):
        yield ev


def _build_context(fused_results: list[dict]) -> tuple[str, list[dict]]:
    """Number passages [1..k] for inline citation; return (context, citations)."""
    parts = []
    citations = []
    for n, r in enumerate(fused_results, start=1):
        idx = r.get("chunkIndex", "?")
        text = r.get("text", "")
        # Only the [n] label is shown to the model so it cites [n], not "chunk N".
        parts.append(f"[{n}]:\n{text}")
        citations.append({
            "n": n,
            "chunkIndex": idx,
            "preview": text[:140].replace("\n", " ").strip(),
            "fullText": text,
        })
    return "\n\n---\n\n".join(parts), citations
