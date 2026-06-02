# Spec: Agentic RAG Lab — 3D Vector-Space Visual Demo

## Overview
A **standalone, localhost-only visual demo** at `agents/rag-lab/` that teaches the full
Retrieval-Augmented Generation pipeline by *showing* every stage live: a document is chunked,
chunks are embedded, embeddings land as points in a **3D vector space**, a query is embedded,
nearest neighbours light up, **hybrid (semantic + lexical) search** fuses results, the context is
assembled, and an LLM streams the grounded answer. Built to be **screen-recorded for LinkedIn**.

This is **greenfield** and intentionally different from the existing agents:
- **Not** wired into the website, **not** deployed to Cloud Run, **not** a Google ADK agent.
- Uses the raw **Anthropic Python SDK** (and optionally `google-genai`) directly — `atlas`/`pulse`
  are ADK; this is not.
- Reuses the portfolio's **visual DNA** so the recording is brand-consistent: Three.js (from
  `assets/js/hero-graph.js`), the dark "AI terminal" CSS tokens (from `assets/css/base.css`), and
  the SSE streaming idiom (from `agents/atlas/app/api.py`).

A FastAPI backend streams **Server-Sent Events** that drive a 3-panel UI (left controls, center
3D vector space, right inspector, bottom system log). Every RAG stage is its own SSE event mapped
to its own visual treatment.

## Locked decisions
| Decision | Choice |
|---|---|
| Vector DB | **Chroma** (`chromadb`), embedded, in-process — no Docker |
| Agentic behaviour | **Both**, via a UI toggle: `Agentic` (Claude tool-use loop, can re-query) and `Linear` (one-shot pipeline) |
| Embedding model | **Voyage AI `voyage-3`** (default); Google `gemini-embedding-001` selectable (key-gated) |
| Generation LLM | **Claude Sonnet 4.5** (`claude-sonnet-4-5`); Gemini selectable (key-gated). `claude-sonnet-4-6` is a one-line swap |
| 3D projection | **PCA** (NumPy SVD, 3 components), deterministic |
| Lexical search | **`rank-bm25` `BM25Okapi`** |
| Fusion | **Reciprocal Rank Fusion (RRF)**, `k=60` |
| Frontend serving | FastAPI `StaticFiles` (same-origin → no CORS), no build step, Three.js via CDN |

## Depends on
- Three.js **v0.160.0** via jsdelivr CDN (same URL as `assets/js/hero-graph.js`) — no build step.
- Design tokens copied from `assets/css/base.css` `:root` (mint `#00FFD1`, JetBrains Mono, spacing/radius/easing).
- SSE wire format mirrored from `agents/atlas/app/api.py`.
- Python ≥3.11, **uv**-managed (mirrors atlas conventions: `ruff`, `ty`).
- API keys at runtime: `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY` (required); `GOOGLE_API_KEY` (optional).

## Routes
All under the new FastAPI app (`app/main.py`); frontend served same-origin via `StaticFiles(html=True)`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/upload` | Multipart PDF → extracted text (via `pypdf`); returns plain text |
| POST | `/api/ingest` | **SSE** — chunk → embed → PCA → store; streams the ingest pipeline events |
| POST | `/api/query` | **SSE** — embed query → retrieve (dense + lexical) → fuse → augment → generate; agentic or linear |
| POST | `/api/session/reset` | Clear in-process state (chunks, embeddings, PCA, BM25, Chroma collection) |
| GET | `/api/config` | Available embedding models + LLMs + defaults (frontend populates selectors) |
| GET | `/healthz` | Liveness |

## Database changes
None against the portfolio's D1/Worker. Chroma is **embedded** (`chromadb.PersistentClient(path=".chroma/")`,
fallback `EphemeralClient`). Collection **`rag_lab`**, `metadata={"hnsw:space": "cosine"}`,
**`embedding_function=None`** (we pass our own Voyage vectors). `.chroma/` is gitignored.

## Design

### Component spec (named & concrete)

**Chunking strategy** (`app/pipeline/chunking.py`)
- Recursive character splitter (hand-rolled, no dependency). Separators tried in order
  `["\n\n", "\n", ". ", " ", ""]`, recursing into the next separator when a piece still exceeds the limit.
- Defaults **`chunk_size = 800` chars**, **`chunk_overlap = 120` chars** (adjustable via request fields).
- Each chunk → `{ index, text, start, end (source char offsets), tokenCount }`.
- Token estimate `ceil(len(text)/4)` (dependency-free; shown as "~N tokens"). Optional `tiktoken` upgrade later.

**Embedding model** (`app/pipeline/embeddings/`)
- Default **Voyage AI `voyage-3`** (1024-dim) via `voyageai` SDK; documents embedded with
  `input_type="document"`, the query with `input_type="query"` (asymmetric retrieval).
- Optional **Google `gemini-embedding-001`** (3072-dim) / `text-embedding-004` (768-dim) via `google-genai`.
- `Embedder` protocol (`embed_documents`, `embed_query`, `name`, `dim`); `registry.get_embedder(model_id)`.
- Dimensionality is irrelevant to the renderer (PCA → 3D). Switching model resets the session.

**Vector database** (`app/store/chroma_store.py`)
- Embedded Chroma, collection `rag_lab`, cosine space, `embedding_function=None`.
- `collection.add(ids, embeddings, documents, metadatas)`; dense retrieval via
  `collection.query(query_embeddings=[qvec], n_results=topK)`, distance → similarity `1 - distance`.
- `VectorStore` protocol in `store/base.py` so a future Qdrant backend could drop in.

**Lexical search** (`app/pipeline/lexical.py`)
- `rank-bm25` `BM25Okapi` over the same chunks; lowercase whitespace/punctuation tokenizer.
- `get_scores(query_tokens)` ranks all chunks; reports **matched query terms** per chunk for inspector highlighting.

**Fusion** (`app/pipeline/fusion.py`)
- **RRF**, `k=60`: `score(chunk) = Σ 1/(k + rank_in_list)` over the dense list + the BM25 list.
- Output carries `{ chunkIndex, rrfScore, denseRank, sparseRank }` provenance. Final set = top-`topK`
  (default **`topK = 5`**). Dense, sparse, and fused lists are surfaced **separately** so all three
  visualize distinctly.

**3D projection** (`app/pipeline/projection.py`)
- `PCA3D`: mean-center corpus, `np.linalg.svd`, keep top-3 right singular vectors + mean + explained
  variance ratio. **Sign-pinned** (force each PC's largest-magnitude loading positive) and
  **bbox-normalized** so the cloud is identical across recording takes. `transform()` projects corpus
  *and* query into the same basis. Optional UMAP (`umap-learn`) behind a flag.

**Generation LLM** (`app/llm/`)
- Default **Claude Sonnet 4.5 (`claude-sonnet-4-5`)**, Anthropic SDK, streaming, `max_tokens=2048`.
  - **Agentic mode:** registered with a `hybrid_search` tool; loop while `stop_reason == "tool_use"`,
    accumulating `input_json_delta` for tool args; the tool body runs `retrieval.hybrid_search`
    (which emits the retrieval SSE events) and feeds results back; final turn streams the answer.
  - **Linear mode:** retrieval runs once up front, context is injected, the model just generates.
- Optional **Gemini** via `google-genai` streaming + function calling, mirroring the same tool shape.

### Pipeline stages (the 9-step visual spine)
`1 Parse → 2 Chunk → 3 Embed → 4 Store(3D) → 5 Query → 6 Retrieve → 7 Fuse(hybrid) → 8 Augment → 9 Generate`
— each maps to SSE events below and lights up a stepper component.

### SSE event schema
Wire format from `agents/atlas/app/api.py`: `text/event-stream`, lines `data: {json}\n\n`, headers
`Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`. Every payload has a `type`
discriminator; the frontend `sse.js` branches on `msg.type`. Retrieval/LLM functions are **async
generators** that `yield` dicts; a route is `async for ev in gen(...): yield sse(ev)`.

**`POST /api/ingest`** — body `{ text, embeddingModel, chunkSize, chunkOverlap }`

| `type` | Payload | Visual |
|---|---|---|
| `ingest_started` | docId, charCount, model, dim | Stage 1 active; log line |
| `chunk_created` | index, total, text, tokenCount, start, end | Stage 2; inspector chunk card (log throttled) |
| `embedding_generated` | index, total, model, dim, vectorPreview(8 dims) | Stage 3; faint point spawns at origin |
| `projection_ready` | method:"pca", explainedVariance[3] | PCA basis fitted |
| `vector_stored` | index, total, point[x,y,z], color | Stage 4; point flies origin→position, additive glow |
| `ingest_done` | count, collection, bounds | Stage 4 green; camera frames the cloud |
| `error` | stage, message | `--danger` log; stage flashes red |

**`POST /api/query`** — body `{ query, llm, mode:"agentic"|"linear", topK }`

| `type` | Payload | Visual |
|---|---|---|
| `query_started` | query, llm, mode | Stage 5 active |
| `agent_thinking` | iteration, delta | Inspector "Agent reasoning" stream *(agentic only)* |
| `tool_call` | iteration, name:"hybrid_search", args | Log "🔧 hybrid_search(...)"; Stage 6 *(agentic only)* |
| `query_embedded` | vectorPreview, point[x,y,z] | Query point appears (accent-white marker) |
| `dense_results` | iteration, results:[{chunkIndex,text,score,point}] | Neighbours glow; pulse-shader lines query→neighbour |
| `sparse_results` | iteration, results:[{chunkIndex,text,bm25Score,matchedTerms}] | "Lexical (BM25)" table; matched tokens highlighted |
| `fused_results` | iteration, results:[{chunkIndex,rrfScore,denseRank,sparseRank,text}] | Stage 7; fused winners brightest + thickest lines |
| `tool_result` | iteration, count, topChunkIndices | Log; results returned to model *(agentic only)* |
| `augmentation` | contextPreview, chunkIndices, tokenEstimate | Stage 8; "Assembled context" w/ chunk boundaries |
| `llm_token` | delta | Stage 9; answer streams char-by-char |
| `done` | usage{input,output}, iterations, latencyMs | All stages green |
| `error` | stage, message | As above |

**Agentic loop:** `agent_thinking` → `tool_call` → (`query_embedded`,`dense_results`,`sparse_results`,`fused_results`)
→ `tool_result` → optional next iteration → `augmentation` → `llm_token`… → `done`.
**Linear:** skip thinking/tool_call/tool_result; run pipeline once → `augmentation` → generate.

### Directory tree
```
agents/rag-lab/
├── README.md
├── Makefile                      # install / dev / clean
├── pyproject.toml                # uv-managed; ruff, ty (mirrors atlas)
├── .env.example                  # ANTHROPIC_API_KEY, VOYAGE_API_KEY, GOOGLE_API_KEY (optional)
├── .gitignore                    # .env, .chroma/, __pycache__
├── app/
│   ├── main.py                   # FastAPI; StaticFiles(frontend, html=True); routes; global SessionState
│   ├── sse.py                    # sse(payload)->"data: {json}\n\n"; StreamingResponse headers (atlas idiom)
│   ├── state.py                  # in-process SessionState: chunks, embeddings(np), pca, bm25, chroma, model meta
│   ├── routes/{ingest,query,session}.py
│   ├── pipeline/
│   │   ├── parsing.py            # txt/md passthrough; pdf via pypdf
│   │   ├── chunking.py           # recursive char splitter (800/120)
│   │   ├── projection.py         # PCA3D fit/transform, sign-pinned + bbox-normalized
│   │   ├── lexical.py            # BM25Okapi + matched-term reporting
│   │   ├── fusion.py             # rrf(dense, sparse, k=60)
│   │   ├── retrieval.py          # hybrid_search async-gen yielding query_embedded/dense/sparse/fused
│   │   └── embeddings/{base,voyage,google,registry}.py
│   ├── store/{base,chroma_store}.py
│   └── llm/{base,anthropic_gen,google_gen,tools}.py
└── frontend/                     # no build step; three@0.160.0 from jsdelivr
    ├── index.html                # 3-panel grid shell + bottom log/answer
    ├── styles.css                # :root tokens copied from base.css
    └── js/{app,sse,scene,pipeline,log,inspector,ingestController,queryController}.js
```

### Reuse-first notes
- `app/sse.py` — copy the helper + headers from `agents/atlas/app/api.py`.
- `frontend/js/scene.js` — port from `assets/js/hero-graph.js`: `THREE.WebGLRenderer({alpha,antialias})`,
  `PerspectiveCamera`, `THREE.Points` (additive blending, mint) for chunk vectors, distinct accent-white
  query point, `THREE.LineSegments` with the **uHead pulse shader** for query→neighbour lines, auto-rotate
  + mouse parallax + `IntersectionObserver` pause. Exposes `addPoint`, `highlight`, `setQuery`,
  `drawLines`, `frame(bounds)`.
- `frontend/styles.css` — copy `:root` token values from `assets/css/base.css` (self-contained, brand-identical).
- `frontend/js/sse.js` — `fetch` POST + `response.body.getReader()` + `TextDecoder`, split on `\n\n`
  (EventSource can't POST).
- `app/state.py` — single global in-process `SessionState` (single-user demo).

### Phased build order (deferred — not implemented in this spec)
- **Phase 0 — vertical slice (no visuals):** `pyproject.toml`, `main.py`, `sse.py`, `/healthz`;
  `/api/ingest` chunk→Voyage→PCA→Chroma; `/api/query` dense-only → Claude non-agentic. Prove SSE via `curl -N`.
- **Phase 1 — 3D scene:** port `hero-graph.js` → `scene.js`; render points + query marker + neighbour lines.
- **Phase 2 — hybrid + fusion:** BM25 + RRF; emit dense/sparse/fused; inspector tables.
- **Phase 3 — agentic loop:** Anthropic tool-use loop; `agent_thinking`/`tool_call`/`tool_result`; Agentic/Linear toggle.
- **Phase 4 — pluggability + polish:** Google embedder + Gemini generator (key-gated); PDF upload;
  stepper/log styling; camera auto-framing; optional UMAP; pacing/throttle for recording.

### Libraries & gotchas
- Deps: `fastapi`, `uvicorn`, `anthropic`, `voyageai`, `chromadb`, `rank-bm25`, `numpy`, `pypdf`,
  `python-dotenv`; optional `google-genai`, `umap-learn`. Dev: `ruff`, `ty`.
- Same-origin serving avoids CORS; SSE needs `X-Accel-Buffering: no` and no response compression.
- PCA SVD signs are arbitrary → sign-pin so takes match.
- Anthropic tool-use streaming: accumulate `input_json_delta`; loop on `stop_reason == "tool_use"`.
- Chroma vector size is fixed at first add; switching embedding model recreates the collection via session reset.
- Fail loudly at startup if a selected model's API key is missing.

## Definition of done
> **Implementation is deferred** — this spec is the design contract. It is "done as a spec" when the
> sections above are agreed. The build will be considered complete when:
1. `make install && make dev` boots the FastAPI app on `:8000` and serves the 3-panel UI at `/`.
2. Pasting text + Ingest (Voyage `voyage-3`) streams `chunk_created`→`vector_stored` events; points fly
   into the 3D cloud; stages 1–4 go green; vectors exist in the `rag_lab` Chroma collection.
3. A query in **Agentic** mode streams reasoning, fires `hybrid_search`, shows the query marker +
   neighbour lines, populates **distinct** dense / lexical / fused tables, assembles context, and
   streams a grounded Claude Sonnet 4.5 answer; `done` turns all stages green.
4. **Linear** mode runs the one-shot path (no `tool_call` events) and still renders + answers.
5. `curl -N -X POST localhost:8000/api/query …` shows raw SSE ordering matching the schema above.
6. *(If Google key added)* switching to Gemini embeddings + Gemini LLM, resetting the session, and
   re-running works end-to-end (pluggable interfaces + PCA refit).
