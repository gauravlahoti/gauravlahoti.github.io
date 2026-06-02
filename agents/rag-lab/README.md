# Agentic RAG

3D vector-space visual demo of the full Retrieval-Augmented Generation pipeline.
Built for screen-recording and teaching. **Localhost only — not deployed.**

## Quick start

```bash
cp .env.example .env   # fill in ANTHROPIC_API_KEY + VOYAGE_API_KEY
make install
make dev               # → http://localhost:8000
```

## What it shows

1. **Parse** — paste text or upload a PDF
2. **Chunk** — recursive character splitter (800 char / 120 overlap)
3. **Embed** — Voyage AI `voyage-3` (or Gemini, key-gated)
4. **Store (3D)** — PCA projection, points fly into the vector space
5. **Query** — embed your question, same PCA basis
6. **Retrieve** — dense nearest-neighbours + BM25 lexical search
7. **Fuse** — Reciprocal Rank Fusion (RRF, k=60)
8. **Augment** — assemble context with chunk boundaries
9. **Generate** — Claude Sonnet 4.5 streams the grounded answer

Toggle **Agentic** mode to let Claude decide when/how to re-query using tool use.

## API keys required

| Key | Purpose | Required? |
|-----|---------|-----------|
| `ANTHROPIC_API_KEY` | Claude Sonnet 4.5 generation | ✅ |
| `VOYAGE_API_KEY` | Voyage AI embeddings (default) | ✅ |
| `GOOGLE_API_KEY` | Gemini embeddings + Gemini LLM | Optional |
