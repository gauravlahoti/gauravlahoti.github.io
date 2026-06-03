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
import { gateEvent } from "./eventGate.js";

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

/**
 * Prime the controller to replay a canned query stream (Simulation mode).
 * Resets the per-run flags so handleQueryEvent behaves as if a fresh query began.
 */
export function beginQueryReplay(query) {
  currentQuery = query;
  answerStarted = false;
  retrievedShown = false;
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

export function handleQueryEvent(msg) {
  switch (msg.type) {
    case "query_started":
      log(`Query [${msg.mode}]: "${msg.query}"`, "accent");
      break;

    case "agent_thinking": {
      const thinkDelta = msg.delta;
      gateEvent("answer", () => appendThinking(thinkDelta));
      break;
    }

    case "tool_call":
      log(`🔧 ${msg.name}(query="${msg.args?.query}")  iter=${msg.iteration}`);
      break;

    case "query_embedded": {
      // Scene + embed-row render gated to the Query step so a replayed (Simulation)
      // stream doesn't drop the query sphere in before the user walks there.
      const qp = msg.point, qvec = msg.vectorPreview, qdim = msg.dim, q = currentQuery;
      gateEvent("query", () => {
        setQuery(qp[0], qp[1], qp[2]);
        setQueryReadout(qp);
        setQueryEmbedRow(q, qvec, qdim);
        markStepDone("query");
        sceneLabel.textContent = "query embedded";
        _hint("Query embedded — measuring cosine similarity to every chunk");
      });
      log(`Query embedded — point=[${qp.map((v) => v.toFixed(2)).join(", ")}], ${qdim}-D`);
      // Banner update deferred — show only when user clicks Next into retrieve.
      gateEvent("retrieve", () => setStage("STEP 5/7", "Retrieving — semantic + lexical", "The query runs through BOTH a semantic (cosine) search and a lexical (BM25) keyword search, side by side."));
      break;
    }

    case "dense_results": {
      // Unlock retrieve tab immediately so Next pulses; render content when user arrives.
      if (!retrievedShown) { retrievedShown = true; reach("retrieve"); }
      const denseResults = msg.results;
      gateEvent("retrieve", () => {
        showDense(denseResults);
        showCosTable(denseResults);
        setActive("dense", "sparse");
        const idx = denseResults.map((r) => r.chunkIndex);
        highlight(idx, "dense");
        drawLines(denseResults.slice(0, 5).map((r) => ({ index: r.chunkIndex, weight: r.score, value: r.score })));
        _hint("Semantic neighbours — labels show cosine similarity (higher = closer)");
      });
      break;
    }

    case "sparse_results": {
      if (!retrievedShown) { retrievedShown = true; reach("retrieve"); }
      const sparseResults = msg.results;
      gateEvent("retrieve", () => {
        showSparse(sparseResults);
        setActive("dense", "sparse");
        markStepDone("retrieve");
        log(`BM25: ${sparseResults.slice(0, 3).map((r) => `c${r.chunkIndex}(${r.bm25Score?.toFixed(2)})`).join(", ")}`);
      });
      break;
    }

    case "fused_results": {
      reach("fuse");
      if (msg.offTopic) {
        log(`Query off-topic — best cosine similarity ${msg.topScore} is below threshold. No chunks retrieved.`, "danger");
      } else {
        log(`Fused top-${msg.results.length}: chunks [${msg.results.map((r) => r.chunkIndex).join(", ")}]`);
      }
      const fusedResults = msg.results;
      gateEvent("fuse", () => {
        setStage("STEP 6/7", "Fusing the results (RRF)", "Reciprocal Rank Fusion blends the semantic and lexical rankings into one final top-k set.");
        showFused(fusedResults);
        setActive("fused");
        markStepDone("fuse");
        const idx = fusedResults.map((r) => r.chunkIndex);
        highlight(idx, "fused");
        setMatched(idx.length);
        const max = Math.max(...fusedResults.map((r) => r.rrfScore || 0), 1e-6);
        drawLines(fusedResults.map((r) => ({ index: r.chunkIndex, weight: (r.rrfScore || 0) / max, value: r.denseScore })));
        _hint("");
      });
      break;
    }

    case "tool_result":
      log(`Tool result: ${msg.count} chunks returned  iter=${msg.iteration}`);
      break;

    case "augmentation": {
      reach("augment");  // Next pulses immediately; banner + content wait for user.
      log(`Context assembled — ~${msg.tokenEstimate} tokens, chunks [${msg.chunkIndices?.join(", ")}]`);
      const augCitations = msg.citations, augTokens = msg.tokenEstimate, augQuery = currentQuery;
      gateEvent("augment", () => {
        setStage("STEP 7/8", "Augmenting the prompt", `The matched chunks (~${augTokens} tokens) are injected into the LLM prompt as numbered, citable context.`);
        setCitations(augCitations);
        showAugment(augCitations, augTokens, augQuery);
        markStepDone("augment");
      });
      break;
    }

    case "llm_token":
      if (!answerStarted) {
        answerStarted = true;
        reach("answer");  // Next pulses immediately; banner + content wait for user.
        gateEvent("answer", () => {
          setStage("STEP 8/8", "Generating the answer", "The LLM writes an answer grounded in the retrieved chunks — streaming token by token.");
          setActive("answer");
          // Scroll the answer pane to top so the header is visible first
          const ansPane = document.getElementById("view-answer");
          if (ansPane) ansPane.scrollTop = 0;
          const ansCol = document.getElementById("answer-col");
          if (ansCol) ansCol.scrollTop = 0;
        });
      }
      // Buffer tokens — when user clicks Next, all buffered tokens flush at once.
      gateEvent("answer", () => appendAnswer(msg.delta));
      break;

    case "done": {
      const doneUsage = msg.usage, doneMs = msg.latencyMs, doneIter = msg.iterations;
      gateEvent("answer", () => {
        markStepDone("answer");
        setStage("DONE ✓", "Answer complete", `Grounded in the retrieved chunks · ${doneUsage?.input ?? "?"}in/${doneUsage?.output ?? "?"}out tokens · ${doneMs}ms.`, "done");
        _hint("");
        log(`Done — ${doneUsage?.input}in/${doneUsage?.output}out tok, ${doneMs}ms, ${doneIter} iter(s)`, "accent");
      });
      break;
    }

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
