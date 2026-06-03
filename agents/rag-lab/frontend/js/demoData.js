/**
 * Canned dataset for Simulation mode — a complete, coherent Agentic RAG run
 * with NO backend and NO model calls. Lets any visitor walk the full 8-stage
 * pipeline with Prev/Next to understand exactly what happens at each step.
 *
 * The document is self-referential (it explains RAG), so the query, retrieval
 * ranking, and grounded answer all stay internally consistent.
 */

// ── Source document ─────────────────────────────────────────────────────────
const PARAS = [
  "Agentic RAG is a retrieval-augmented generation pipeline in which an LLM agent decides when and how to search a knowledge base before it answers. Unlike a single-shot RAG call, the agent can issue multiple retrieval queries, refine them, and reason over the results before committing to a response.",
  "The first stage is chunking. A long document is split into smaller, overlapping passages so each piece fits inside the embedding model's context window and captures one coherent idea. The overlap preserves meaning that would otherwise be severed at a hard boundary.",
  "Each chunk is then embedded. The embedding model converts text into a high-dimensional vector — voyage-3 produces 1024 dimensions — where semantically similar passages land close together. In other words, meaning becomes geometry.",
  "Retrieval runs two searches in parallel. A dense semantic search ranks chunks by cosine similarity in vector space, while a sparse lexical search (BM25) ranks them by keyword overlap. The two methods capture different, complementary notions of relevance.",
  "Reciprocal Rank Fusion (RRF) blends the two ranked lists into one. Each chunk's score is the sum of 1 / (k + rank) taken across both lists, with k set to 60. Because it depends only on rank position, RRF rewards chunks that rank highly in either search without needing the raw scores to be calibrated against each other.",
  "Finally, the top fused chunks are injected into the LLM prompt as numbered, citable context. The model writes an answer grounded only in those passages, so every claim it makes can be traced straight back to a specific source chunk.",
];

const SEP = "\n\n";
export const DEMO_DOC = PARAS.join(SEP);
export const DEMO_QUERY = "What is Reciprocal Rank Fusion and what value of k does it use?";

// Build chunk metadata with real character offsets into DEMO_DOC.
const CHUNKS = (() => {
  const out = [];
  let cursor = 0;
  PARAS.forEach((p, i) => {
    const start = cursor;
    const end = cursor + p.length;
    out.push({
      index: i,
      start,
      end,
      text: p,
      tokenCount: Math.round(p.split(/\s+/).length * 1.3),
    });
    cursor = end + SEP.length;
  });
  return out;
})();

const DIM = 1024;

// Deterministic 5-dim vector previews (illustrative only).
const PREVIEWS = [
  [0.021, -0.118, 0.064, 0.009, -0.052],
  [-0.044, 0.087, -0.013, 0.121, 0.038],
  [0.103, 0.012, -0.097, -0.041, 0.076],
  [-0.069, -0.025, 0.112, 0.057, -0.018],
  [0.058, 0.094, 0.031, -0.110, 0.047],
  [0.014, -0.073, -0.060, 0.082, 0.029],
];

// Hand-placed 3D PCA coordinates (in [-1, 1]) — spread for a clean scene.
const POINTS = [
  [-0.72, 0.41, 0.55],   // C0  intro
  [-0.38, -0.62, 0.33],  // C1  chunking
  [0.15, 0.68, -0.30],   // C2  embedding
  [0.62, -0.25, 0.40],   // C3  retrieval
  [0.80, 0.10, -0.55],   // C4  RRF
  [0.30, -0.70, -0.20],  // C5  augment
];
const QUERY_POINT = [0.74, 0.05, -0.45]; // sits near C4 (the RRF chunk)
const QUERY_PREVIEW = [0.061, 0.090, 0.028, -0.104, 0.044];

// ── Ingest event stream ─────────────────────────────────────────────────────
export const INGEST_EVENTS = [
  { type: "ingest_started", model: "voyage-3", dim: DIM, charCount: DEMO_DOC.length },
  ...CHUNKS.map((c) => ({
    type: "chunk_created",
    index: c.index, start: c.start, end: c.end,
    tokenCount: c.tokenCount, text: c.text, total: CHUNKS.length,
  })),
  ...CHUNKS.map((c) => ({
    type: "embedding_generated",
    index: c.index, vectorPreview: PREVIEWS[c.index], dim: DIM, total: CHUNKS.length,
  })),
  { type: "projection_ready", explainedVariance: [0.42, 0.28, 0.16] },
  { type: "store_started", count: CHUNKS.length, collection: "rag_lab", space: "cosine" },
  ...CHUNKS.map((c) => ({
    type: "vector_stored",
    index: c.index, point: POINTS[c.index], total: CHUNKS.length,
  })),
  { type: "ingest_done", count: CHUNKS.length },
];

// ── Query event stream ──────────────────────────────────────────────────────
const T = (i) => CHUNKS[i].text;

const DENSE = [
  { chunkIndex: 4, rank: 0, score: 0.91, text: T(4) },
  { chunkIndex: 3, rank: 1, score: 0.79, text: T(3) },
  { chunkIndex: 2, rank: 2, score: 0.58, text: T(2) },
  { chunkIndex: 5, rank: 3, score: 0.51, text: T(5) },
  { chunkIndex: 0, rank: 4, score: 0.44, text: T(0) },
];

const SPARSE = [
  { chunkIndex: 4, rank: 0, bm25Score: 8.4, text: T(4), matchedTerms: ["Reciprocal", "Rank", "Fusion", "k", "60"] },
  { chunkIndex: 3, rank: 1, bm25Score: 4.2, text: T(3), matchedTerms: ["ranks", "rank", "search"] },
  { chunkIndex: 5, rank: 2, bm25Score: 2.1, text: T(5), matchedTerms: ["chunks"] },
  { chunkIndex: 1, rank: 3, bm25Score: 1.6, text: T(1), matchedTerms: ["chunk"] },
  { chunkIndex: 0, rank: 4, bm25Score: 1.1, text: T(0), matchedTerms: ["RAG"] },
];

// RRF score = 1/(60+denseRank) + 1/(60+sparseRank)
const FUSED = [
  { chunkIndex: 4, rank: 0, rrfScore: 0.03333, denseScore: 0.91, denseRank: 0, sparseRank: 0, text: T(4) },
  { chunkIndex: 3, rank: 1, rrfScore: 0.03279, denseScore: 0.79, denseRank: 1, sparseRank: 1, text: T(3) },
  { chunkIndex: 5, rank: 2, rrfScore: 0.03200, denseScore: 0.51, denseRank: 3, sparseRank: 2, text: T(5) },
  { chunkIndex: 0, rank: 3, rrfScore: 0.03125, denseScore: 0.44, denseRank: 4, sparseRank: 4, text: T(0) },
  { chunkIndex: 2, rank: 4, rrfScore: 0.01613, denseScore: 0.58, denseRank: 2, sparseRank: null, text: T(2) },
];

const CITATIONS = [
  { n: 1, chunkIndex: 4, preview: T(4).slice(0, 90), fullText: T(4) },
  { n: 2, chunkIndex: 3, preview: T(3).slice(0, 90), fullText: T(3) },
];

const ANSWER_DELTAS = [
  "**Reciprocal Rank Fusion (RRF)** blends two ranked lists — the dense ",
  "semantic search and the sparse lexical (BM25) search — into a single ranking [1]. ",
  "Each chunk's score is the sum of **1 / (k + rank)** across both lists, and this ",
  "pipeline sets **k = 60** [1]. Because it depends only on rank position, RRF ",
  "rewards chunks that rank highly in *either* search without needing the two raw ",
  "scores to be calibrated against each other [2].",
];

export const QUERY_EVENTS = [
  { type: "query_started", mode: "agentic", query: DEMO_QUERY },
  { type: "agent_thinking", delta: "The user is asking about Reciprocal Rank Fusion and its k parameter. " },
  { type: "agent_thinking", delta: "I'll search the ingested document for the fusion stage.\n" },
  { type: "tool_call", name: "search_documents", args: { query: "Reciprocal Rank Fusion k value" }, iteration: 1 },
  { type: "query_embedded", point: QUERY_POINT, vectorPreview: QUERY_PREVIEW, dim: DIM },
  { type: "dense_results", results: DENSE },
  { type: "sparse_results", results: SPARSE },
  { type: "tool_result", count: 5, iteration: 1 },
  { type: "fused_results", results: FUSED },
  { type: "augmentation", citations: CITATIONS, tokenEstimate: 214, chunkIndices: [4, 3, 5] },
  ...ANSWER_DELTAS.map((d) => ({ type: "llm_token", delta: d })),
  { type: "done", usage: { input: 612, output: 96 }, latencyMs: 1840, iterations: 1 },
];
