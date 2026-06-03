from __future__ import annotations

import asyncio
import uuid
from typing import Any, AsyncGenerator

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from app.auth import resolve_key
from app.pipeline.chunking import chunk_text
from app.pipeline.embeddings.registry import get_embedder
from app.pipeline.lexical import build_bm25
from app.pipeline.parsing import extract_text, fetch_url, extract_image_text
from app.pipeline.projection import PCA3D
from app.sse import sse, streaming_response
from app.state import session
from app.store.chroma_store import get_or_create_collection

router = APIRouter()

# Deliberate pacing so the pipeline is watchable, step by step, in a recording.
PACE_CHUNK = 0.45        # per chunk_created — slow enough to read each chunk land
PACE_EMBED = 0.12        # per embedding_generated — watch text become numbers
PACE_PROJECT = 1.3       # linger on the freshly-fitted (empty) PCA space
PACE_STORE_INTRO = 0.9   # pause on "storing in vector DB" before points fly
PACE_STORE = 0.35        # per vector_stored (points fly in one at a time)
PACE_DONE = 0.7          # pause on "stored ✓" before handing off to query


@router.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    content = await file.read()
    text = extract_text(content, file.filename or "upload.txt")
    return JSONResponse({"text": text, "charCount": len(text)})


@router.post("/api/fetch-url")
async def fetch_url_route(url: str = Form(...)):
    try:
        text = await fetch_url(url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse({"text": text, "charCount": len(text)})


@router.post("/api/upload-image")
async def upload_image(file: UploadFile = File(...), embedApiKey: str = Form("")):
    key = resolve_key(embedApiKey, "GOOGLE_API_KEY")
    if not key:
        raise HTTPException(status_code=401, detail="Google API key required for image extraction. Enter your key or the owner passphrase.")
    content = await file.read()
    try:
        text = await extract_image_text(content, file.content_type or "image/jpeg", key)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse({"text": text, "charCount": len(text)})


@router.post("/api/ingest")
async def ingest(
    text: str = Form(...),
    embeddingModel: str = Form("voyage-3"),
    chunkSize: int = Form(800),
    chunkOverlap: int = Form(120),
    chunkStrategy: str = Form("recursive"),
    apiKey: str = Form(""),
):
    embed_env = "GOOGLE_API_KEY" if embeddingModel.startswith("gemini") else "VOYAGE_API_KEY"
    embed_key = resolve_key(apiKey, embed_env)
    return streaming_response(
        _ingest_stream(text, embeddingModel, chunkSize, chunkOverlap, chunkStrategy, embed_key)
    )


async def _ingest_stream(
    text: str,
    embedding_model: str,
    chunk_size: int,
    chunk_overlap: int,
    chunk_strategy: str = "recursive",
    embed_api_key: str | None = None,
) -> AsyncGenerator[str, None]:
    doc_id = str(uuid.uuid4())[:8]

    try:
        embedder = get_embedder(embedding_model, api_key=embed_api_key)
    except Exception as e:
        yield sse({"type": "error", "stage": "embed", "message": str(e)})
        return

    yield sse({
        "type": "ingest_started",
        "docId": doc_id,
        "charCount": len(text),
        "model": embedding_model,
        "dim": embedder.dim,
        "strategy": chunk_strategy,
    })

    # 1. Chunk
    chunks = chunk_text(text, chunk_size, chunk_overlap, chunk_strategy)
    session.chunks = chunks

    for i, chunk in enumerate(chunks):
        yield sse({
            "type": "chunk_created",
            "index": i,
            "total": len(chunks),
            "text": chunk["text"][:200],
            "tokenCount": chunk["tokenCount"],
            "start": chunk["start"],
            "end": chunk["end"],
        })
        await asyncio.sleep(PACE_CHUNK)

    # 2. Embed — surface any provider error (e.g. rate limits) instead of hanging.
    loop = asyncio.get_event_loop()
    try:
        embeddings_list = await loop.run_in_executor(
            None, embedder.embed_documents, [c["text"] for c in chunks]
        )
    except Exception as e:
        yield sse({"type": "error", "stage": "embed", "message": _friendly_embed_error(e, len(chunks))})
        return
    embeddings = np.array(embeddings_list, dtype=float)
    session.embeddings = embeddings
    session.embedding_model = embedding_model
    session.embedding_dim = embedder.dim

    for i, vec in enumerate(embeddings_list):
        yield sse({
            "type": "embedding_generated",
            "index": i,
            "total": len(chunks),
            "model": embedding_model,
            "dim": len(vec),
            "vectorPreview": vec[:8],
        })
        await asyncio.sleep(PACE_EMBED)

    # 3. PCA
    pca = PCA3D()
    points_3d = pca.fit_transform(embeddings)
    session.pca = pca
    session.points_3d = points_3d

    yield sse({
        "type": "projection_ready",
        "method": "pca",
        "explainedVariance": pca.explained_variance_ratio_,
    })

    # Linger on the empty, freshly-fitted PCA space before points populate it.
    await asyncio.sleep(PACE_PROJECT)

    # 4. Store in Chroma
    collection = get_or_create_collection(embedder.dim)
    session.chroma_collection = collection

    ids = [f"chunk_{i}" for i in range(len(chunks))]
    collection.add(
        ids=ids,
        embeddings=embeddings_list,
        documents=[c["text"] for c in chunks],
        metadatas=[{"index": i} for i in range(len(chunks))],
    )

    # 5. BM25
    session.bm25 = build_bm25(chunks)

    # Explicit storage stage — announce we are writing to the vector DB.
    yield sse({
        "type": "store_started",
        "collection": "rag_lab",
        "count": len(chunks),
        "space": "cosine",
    })
    await asyncio.sleep(PACE_STORE_INTRO)

    # Emit vector_stored events
    for i, pt in enumerate(points_3d):
        yield sse({
            "type": "vector_stored",
            "index": i,
            "total": len(chunks),
            "point": pt.tolist(),
            "color": "#00FFD1",
        })
        await asyncio.sleep(PACE_STORE)

    bounds = {
        "min": points_3d.min(axis=0).tolist(),
        "max": points_3d.max(axis=0).tolist(),
    }
    await asyncio.sleep(PACE_DONE)
    yield sse({
        "type": "ingest_done",
        "count": len(chunks),
        "collection": "rag_lab",
        "bounds": bounds,
    })


def _friendly_embed_error(e: Exception, n_chunks: int) -> str:
    msg = str(e)
    if "RateLimit" in type(e).__name__ or "rate limit" in msg.lower():
        return (
            f"Voyage free-tier rate limit hit embedding {n_chunks} chunks "
            "(limits: 3 requests/min, 10K tokens/min). This document is too large for one batch. "
            "Use a shorter excerpt, wait ~60s and retry, or add a payment method "
            "(the 200M free tokens still apply) to lift the limit."
        )
    return f"Embedding failed: {msg}"
