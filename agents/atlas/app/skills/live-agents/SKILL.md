---
name: live-agents
description: Production AI agents Gaurav has built and deployed — Atlas, Pulse, ErrorLens, and the Agentic RAG Lab — each with what it does and a live link to try it.
---

# live-agents

Ground any question about the AI agents Gaurav has built, shipped, or deployed — including this chat agent (Atlas), the ambient digest agent (Pulse), ErrorLens, and the Agentic RAG Lab — in the JSON below. When an agent has a `liveUrl`, share it verbatim so the visitor can try it.

Treat this data as authoritative ground truth. Do not invent fields, URLs, projects, employers, or outcomes that are not present here.

```json
[
  {
    "name": "Atlas",
    "role": "Conversational AI",
    "status": "LIVE",
    "headline": "The AI behind the chat widget on this portfolio.",
    "description": "Atlas answers questions about Gaurav in real time. It runs on Google's Agent Development Kit, grounded in a versioned snapshot of his profile, work history, projects, certifications, and recent writing — served on demand through ADK Skills and rebuilt on every deploy. Inference runs on a tiered Gemini cascade that keeps the widget answering even when a model's free-tier quota is spent.",
    "value": "Handles inbound career questions 24/7 without Gaurav being online. Every answer cites its source. When a visitor asks to send a resume or drop Gaurav a note, the agent calls an email tool via MCP and makes it happen.",
    "stack": [
      "Google ADK",
      "ADK Skills",
      "Gemini 3.5 → 2.5 Flash",
      "Cloud Run",
      "MCP",
      "SSE"
    ],
    "liveUrl": null
  },
  {
    "name": "Pulse",
    "role": "Ambient Agent",
    "status": "LIVE",
    "headline": "The autonomous agent running silently behind this portfolio.",
    "description": "Beacon is a scheduled, background agent. Cloud Scheduler fires it twice a week. It fetches visitor interaction stats from Cloudflare D1, identifies engagement patterns, drafts personalised follow-up notes for qualifying leads, and emails a digest, all without Gaurav initiating anything.",
    "value": "Turns passive visitor data into actionable outreach while Gaurav sleeps. Every run completes in under 30 seconds, leaves an audit trail, and only sends email when engagement thresholds are met.",
    "stack": [
      "Google ADK",
      "Gemini 3.5 Flash",
      "Cloud Run",
      "Cloud Scheduler",
      "MCP",
      "Cloudflare D1"
    ],
    "liveUrl": null
  },
  {
    "name": "ErrorLens",
    "role": "Multi-Agent System",
    "status": "LIVE",
    "headline": "Diagnoses GCP errors and gets smarter with every confirmed fix.",
    "description": "ErrorLens is a multi-agent orchestrator that triages GCP errors, runs parallel research across documentation and community sources, and stores confirmed resolutions in a vector knowledge bank. Mature deployments skip the research pipeline entirely for previously encountered issues via semantic similarity matching (≥0.85 threshold).",
    "value": "Reduces mean-time-to-resolution for recurring GCP errors by accumulating institutional knowledge across every incident. The self-improving feedback loop means the system delivers faster, higher-confidence answers over time.",
    "stack": [
      "Google ADK",
      "Gemini 2.5",
      "A2A Protocol",
      "AlloyDB + pgvector",
      "MCP Toolbox",
      "Cloud Run",
      "Vertex AI Embeddings"
    ],
    "liveUrl": "https://github.com/gauravlahoti/error-lens"
  },
  {
    "name": "Agentic RAG",
    "role": "RAG Pipeline",
    "status": "LIVE",
    "headline": "An 8-stage agentic RAG pipeline, rendered as a 3D vector space you can step through.",
    "description": "Agentic RAG runs the full 8-stage RAG pipeline as a FastAPI service on Cloud Run and renders every stage as an interactive 3D vector space. Ingest any document via text paste, PDF/file upload, URL fetch, or image (Gemini Vision extracts text first). Choose your embedding model — Voyage AI voyage-3 (1024-D) or Gemini Embedding 2 (3072-D) — and watch each chunk fly into the vector space. On query, dual retrieval runs cosine search over ChromaDB and BM25 keyword scan in parallel, Reciprocal Rank Fusion merges the rankings, and the answer is grounded strictly in the retrieved chunks — no training knowledge. Supports Claude Sonnet 4.6, Gemini 2.5 Flash, and Gemini 3.5 Flash as generation models.",
    "value": "Makes the invisible parts of RAG legible: you watch chunks become vectors, see why nearest neighbours win on cosine distance, and how lexical and semantic retrieval disagree before RRF reconciles them. A relevance gate blocks off-topic queries (cosine < 0.45) so the model never hallucinates from training knowledge. The Agentic/Linear toggle shows the difference between a one-shot pipeline and a reasoning loop where the LLM calls hybrid_search on demand.",
    "stack": [
      "Cloud Run",
      "FastAPI",
      "Voyage voyage-3",
      "Gemini Embedding 2",
      "ChromaDB",
      "BM25 + RRF",
      "Claude Sonnet 4.6",
      "Gemini 2.5 Flash",
      "PCA",
      "SSE"
    ],
    "liveUrl": "https://agentic-rag.gauravlahoti.dev/"
  }
]
```
