import { ssePost } from "./sse.js";
import { showCosTable, resetCosTable } from "./cosTable.js";
import { log } from "./log.js";
import { setQuery, highlight, drawLines } from "./scene.js";
import { reach, markStepDone } from "./viewState.js";
import { setQueryReadout } from "./readout.js";
import { setMatched } from "./legend.js";
import { setStage } from "./stageBanner.js";
import { setQueryEmbedRow } from "./embedView.js";
import {
  resetRetrieval,
  setActive,
  appendThinking,
  showDense,
  showSparse,
  showFused,
  appendAnswer,
  setCitations,
  showAugment,
  resetAugment,
} from "./retrievalView.js";

const btnQuery    = document.getElementById("btn-query");
const queryText   = document.getElementById("query-text");
const llmModel    = document.getElementById("llm-model");
const sceneLabel  = document.getElementById("scene-label");
const sceneHint   = document.getElementById("scene-hint");
const toggleBtns  = document.querySelectorAll(".toggle-btn");
const llmApiKey   = document.getElementById("llm-api-key");
const llmEye      = document.getElementById("llm-eye");
const embedApiKey = document.getElementById("embed-api-key");

let mode = "agentic";
let currentQuery = "";
let answerStarted = false;
let retrievedShown = false;
let queryAbort = null;

/** Abort an in-flight query stream (used by Reset). */
export function abortQuery() {
  if (queryAbort) { queryAbort.abort(); queryAbort = null; }
}

export function initQueryController() {
  toggleBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      toggleBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      mode = btn.dataset.mode;
    });
  });

  if (llmEye) {
    llmEye.addEventListener("click", () => {
      const show = llmApiKey.type === "password";
      llmApiKey.type = show ? "text" : "password";
      llmEye.style.opacity = show ? "1" : "0.45";
    });
  }

  btnQuery.addEventListener("click", runQuery);
}

async function runQuery() {
  const query = queryText.value.trim();
  if (!query) { log("Enter a query first.", "danger"); return; }

  currentQuery = query;
  answerStarted = false;
  retrievedShown = false;
  btnQuery.disabled = true;
  btnQuery.classList.remove("ready-pulse");
  resetRetrieval();
  resetAugment();
  resetCosTable();
  reach("query");                 // watch the query land in the cloud
  setStage("STEP 4/7", "Embedding your question", "Your question goes through the same embedding model, so it lands in the same vector space as the chunks.");
  _hint("Embedding query…");

  queryAbort = new AbortController();
  const myAbort = queryAbort;
  try {
    await ssePost(
      "/api/query",
      {
        query,
        llm: llmModel.value,
        mode,
        topK: 5,
        llmApiKey: (llmApiKey?.value || "").trim(),
        embeddingApiKey: (embedApiKey?.value || "").trim(),
      },
      handleQueryEvent,
      myAbort.signal,
    );
  } catch (e) {
    if (e.name === "AbortError") { log("Query cancelled.", "muted"); return; }
    log(`Query error: ${e.message}`, "danger");
    setStage("ERROR", "Query failed", e.message, "idle");
  } finally {
    if (queryAbort === myAbort) queryAbort = null;
    if (!myAbort.signal.aborted) btnQuery.disabled = false;
  }
}

function handleQueryEvent(msg) {
  switch (msg.type) {
    case "query_started":
      log(`Query [${msg.mode}]: "${msg.query}"`, "accent");
      break;

    case "agent_thinking":
      appendThinking(msg.delta);
      break;

    case "tool_call":
      log(`🔧 ${msg.name}(query="${msg.args?.query}")  iter=${msg.iteration}`);
      break;

    case "query_embedded":
      setQuery(msg.point[0], msg.point[1], msg.point[2]);
      setQueryReadout(msg.point);
      setQueryEmbedRow(currentQuery, msg.vectorPreview, msg.dim);
      markStepDone("query");
      sceneLabel.textContent = "query embedded";
      setStage("STEP 5/7", "Retrieving — semantic + lexical", "The query runs through BOTH a semantic (cosine) search and a lexical (BM25) keyword search, side by side.");
      _hint("Query embedded — measuring cosine similarity to every chunk");
      log(`Query embedded — point=[${msg.point.map((v) => v.toFixed(2)).join(", ")}], ${msg.dim}-D`);
      break;

    case "dense_results": {
      _showRetrieve();
      showDense(msg.results);
      showCosTable(msg.results);
      setActive("dense", "sparse");
      const idx = msg.results.map((r) => r.chunkIndex);
      highlight(idx, "dense");
      drawLines(msg.results.slice(0, 5).map((r) => ({ index: r.chunkIndex, weight: r.score, value: r.score })));
      _hint("Semantic neighbours — labels show cosine similarity (higher = closer)");
      break;
    }

    case "sparse_results":
      _showRetrieve();
      showSparse(msg.results);
      setActive("dense", "sparse");
      markStepDone("retrieve");
      log(`BM25: ${msg.results.slice(0, 3).map((r) => `c${r.chunkIndex}(${r.bm25Score?.toFixed(2)})`).join(", ")}`);
      break;

    case "fused_results": {
      reach("fuse");
      showFused(msg.results);
      setActive("fused");
      markStepDone("fuse");
      const idx = msg.results.map((r) => r.chunkIndex);
      highlight(idx, "fused");
      setMatched(idx.length);
      const max = Math.max(...msg.results.map((r) => r.rrfScore || 0), 1e-6);
      drawLines(msg.results.map((r) => ({ index: r.chunkIndex, weight: (r.rrfScore || 0) / max, value: r.denseScore })));
      setStage("STEP 6/7", "Fusing the results (RRF)", "Reciprocal Rank Fusion blends the semantic and lexical rankings into one final top-k set.");
      _hint("");
      log(`Fused top-${msg.results.length}: chunks [${idx.join(", ")}]`);
      break;
    }

    case "tool_result":
      log(`Tool result: ${msg.count} chunks returned  iter=${msg.iteration}`);
      break;

    case "augmentation":
      setCitations(msg.citations);
      showAugment(msg.citations, msg.tokenEstimate, currentQuery);
      reach("augment");
      markStepDone("augment");
      setStage("STEP 7/8", "Augmenting the prompt", `The matched chunks (~${msg.tokenEstimate} tokens) are injected into the LLM prompt as numbered, citable context.`);
      log(`Context assembled — ~${msg.tokenEstimate} tokens, chunks [${msg.chunkIndices?.join(", ")}]`);
      break;

    case "llm_token":
      if (!answerStarted) {
        answerStarted = true;
        reach("answer");
        setActive("answer");
        setStage("STEP 8/8", "Generating the answer", "The LLM writes an answer grounded in the retrieved chunks — streaming token by token.");
      }
      appendAnswer(msg.delta);
      break;

    case "done":
      markStepDone("answer");
      setStage("DONE ✓", "Answer complete", `Grounded in the retrieved chunks · ${msg.usage?.input ?? "?"}in/${msg.usage?.output ?? "?"}out tokens · ${msg.latencyMs}ms.`, "done");
      _hint("");
      log(`Done — ${msg.usage?.input}in/${msg.usage?.output}out tok, ${msg.latencyMs}ms, ${msg.iterations} iter(s)`, "accent");
      break;

    case "error":
      log(`Error [${msg.stage}]: ${msg.message}`, "danger");
      setStage("ERROR", "Query error", msg.message, "idle");
      break;
  }
}

// switch to the Retrieve tab once, when the first results arrive
function _showRetrieve() {
  if (retrievedShown) return;
  retrievedShown = true;
  reach("retrieve");
}

function _hint(text) {
  if (!sceneHint) return;
  sceneHint.textContent = text;
  sceneHint.classList.toggle("show", !!text);
}
