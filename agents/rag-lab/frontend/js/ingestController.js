import { ssePostForm } from "./sse.js";
import { log } from "./log.js";
import { addPoint, resetScene, frameAll, buildAxes, resize as resizeScene } from "./scene.js";
import { renderChunks, resetChunks, pulseChunk } from "./chunksView.js";
import { reach, setQueryEnabled, markStepDone, resetWizard } from "./viewState.js";
import { addReadout, clearReadout } from "./readout.js";
import { setCaption, setPoints, resetCounts } from "./legend.js";
import { setStage, hideStage } from "./stageBanner.js";
import { addEmbedRow, resetEmbed, setEmbedModel } from "./embedView.js";
import { resetRetrieval } from "./retrievalView.js";
import { abortQuery } from "./queryController.js";
import { resetCosTable } from "./cosTable.js";
import { setChunkData, resetDetail } from "./pointDetail.js";
import { gateEvent } from "./eventGate.js";

let ingestAbort = null;

const btnIngest  = document.getElementById("btn-ingest");
const btnReset   = document.getElementById("btn-reset");
const docText    = document.getElementById("doc-text");
const pdfUpload  = document.getElementById("pdf-upload");
const embModel   = document.getElementById("embedding-model");
const chunkSize  = document.getElementById("chunk-size");
const chunkOver  = document.getElementById("chunk-overlap");
const chunkStrat = document.getElementById("chunk-strategy");
const sceneLabel = document.getElementById("scene-label");
const embedApiKey = document.getElementById("embed-api-key");
const embedEye    = document.getElementById("embed-eye");

const STRATEGY_DESC = {
  recursive: "Recursive splitter — tries paragraph → line → sentence → word boundaries to keep chunks coherent.",
  sentence: "Sentence-based — groups whole sentences up to the size budget, carrying a tail for overlap.",
  paragraph: "Paragraph-based — packs blank-line-separated paragraphs up to the size budget.",
  fixed: "Fixed-size window — hard character windows with a sliding overlap, ignoring boundaries.",
};

let collectedChunks = [];

export function initIngestController() {
  pdfUpload.addEventListener("change", async () => {
    const file = pdfUpload.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    log(`Uploading ${file.name}…`);
    const resp = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await resp.json();
    docText.value = data.text;
    log(`Extracted ${data.charCount} chars from PDF`, "accent");
  });

  if (embedEye) {
    embedEye.addEventListener("click", () => {
      const show = embedApiKey.type === "password";
      embedApiKey.type = show ? "text" : "password";
      embedEye.style.opacity = show ? "1" : "0.45";
    });
  }

  btnIngest.addEventListener("click", runIngest);
  btnReset.addEventListener("click", resetSession);
}

async function runIngest() {
  const text = docText.value.trim();
  if (!text) { log("No document text — paste or upload first.", "danger"); return; }

  btnIngest.disabled = true;
  setQueryEnabled(false);
  resetScene();
  resetChunks();
  resetEmbed();
  resetRetrieval();
  clearReadout();
  resetCounts();
  resetDetail();
  resetWizard();
  collectedChunks = [];
  const strat = chunkStrat.value;
  setStage("STEP 1/7", "Chunking the document", STRATEGY_DESC[strat] || STRATEGY_DESC.recursive);
  sceneLabel.textContent = "chunking…";

  const fd = new FormData();
  fd.append("text", text);
  fd.append("embeddingModel", embModel.value);
  fd.append("chunkSize", chunkSize.value || "800");
  fd.append("chunkOverlap", chunkOver.value || "120");
  fd.append("chunkStrategy", strat);
  fd.append("apiKey", (embedApiKey?.value || "").trim());

  ingestAbort = new AbortController();
  const myAbort = ingestAbort;
  try {
    await ssePostForm("/api/ingest", fd, (msg) => handleIngestEvent(msg, text), myAbort.signal);
  } catch (e) {
    if (e.name === "AbortError") { log("Ingest cancelled.", "muted"); return; }
    log(`Ingest error: ${e.message}`, "danger");
    setStage("ERROR", "Ingest failed", e.message, "idle");
  } finally {
    if (ingestAbort === myAbort) ingestAbort = null;
    if (!myAbort.signal.aborted) btnIngest.disabled = false;
  }
}

function handleIngestEvent(msg, fullText) {
  switch (msg.type) {
    case "ingest_started":
      setCaption(msg.model, msg.dim);
      setEmbedModel(msg.model, msg.dim);
      log(`Ingest started — ${msg.charCount} chars, model=${msg.model}`);
      break;

    case "chunk_created":
      collectedChunks.push({
        index: msg.index, start: msg.start, end: msg.end,
        tokenCount: msg.tokenCount, text: msg.text,
      });
      renderChunks(fullText, collectedChunks);
      pulseChunk(msg.index);
      sceneLabel.textContent = `chunk ${msg.index + 1}/${msg.total}`;
      if (msg.index === msg.total - 1) {
        markStepDone("chunks");
        reach("embed");
        // Banner update deferred — show only when user clicks Next into the embed step.
        gateEvent("embed", () => setStage("STEP 2/7", "Embedding the chunks", "Each chunk is sent to the embedding model and returned as a vector of numbers — meaning becomes geometry."));
      }
      break;

    case "embedding_generated": {
      const txt = collectedChunks[msg.index]?.text || "";
      // Store chunk metadata immediately (needed for point-click detail panel).
      setChunkData(msg.index, { text: txt, preview: msg.vectorPreview, dim: msg.dim });
      // Visual embed row — shown only when user advances to the Embed step.
      const embedIdx = msg.index, embedTotal = msg.total, embedVec = msg.vectorPreview, embedDim = msg.dim;
      gateEvent("embed", () => {
        addEmbedRow(embedIdx, txt, embedVec, embedDim);
        sceneLabel.textContent = `embedding ${embedIdx + 1}/${embedTotal}`;
        if (embedIdx === embedTotal - 1) markStepDone("embed");
      });
      break;
    }

    case "projection_ready":
      log(`PCA ready — variance ${msg.explainedVariance.map((v) => (v * 100).toFixed(1) + "%").join(", ")}`, "accent");
      reach("store");  // Next button pulses; banner + scene content wait for user.
      gateEvent("store", () => {
        setStage("STEP 3/7", "Projecting to 3D (PCA)", `1024-D vectors reduced to 3 axes — PC1/PC2/PC3 capture ${msg.explainedVariance.map((v) => (v * 100).toFixed(0) + "%").join("/")} of the variance.`);
        sceneLabel.textContent = "projecting…";
        buildAxes(msg.explainedVariance);
        resizeScene();
      });
      break;

    case "store_started":
      log(`Storing ${msg.count} vectors in Chroma "${msg.collection}" (${msg.space})…`, "accent");
      gateEvent("store", () => {
        setStage("STEP 3/7", "Storing in the vector DB", `Writing ${msg.count} vectors into the Chroma "${msg.collection}" collection (${msg.space} space)…`);
        sceneLabel.textContent = "storing in vector DB…";
      });
      break;

    case "vector_stored": {
      // 3D position stored immediately (needed for detail panel); visuals gated.
      setChunkData(msg.index, { point: msg.point });
      const stIdx = msg.index, stTotal = msg.total, stPt = msg.point;
      gateEvent("store", () => {
        addPoint(stPt[0], stPt[1], stPt[2], stIdx);
        addReadout(`C${stIdx}`, stPt);
        setPoints(stIdx + 1);
        frameAll();
        sceneLabel.textContent = `stored ${stIdx + 1}/${stTotal}`;
        if (stIdx === stTotal - 1) {
          markStepDone("store");
          sceneLabel.textContent = `${stTotal} vectors`;
          setStage("STORED ✓", "Vectors stored in Chroma", `${stTotal} vectors are now searchable in the Agentic RAG vector store.`, "done");
          log(`Stored ${stTotal} vectors in Chroma (agentic-rag collection)`, "accent");
        }
      });
      break;
    }

    case "ingest_done":
      // Enable query immediately so the button is ready; banner waits for user to advance.
      reach("query");
      setQueryEnabled(true);
      log(`Ready — ${msg.count} chunks stored. Ask a question to query the vector space.`, "accent");
      gateEvent("query", () => setStage("STEP 4/7", "Ask a question", "Type your question below and hit Run Query — it'll be embedded and matched against the stored vectors."));
      break;

    case "error":
      log(`Error [${msg.stage}]: ${msg.message}`, "danger");
      setStage("ERROR", "Pipeline error", msg.message, "idle");
      break;
  }
}

async function resetSession() {
  // Stop any in-flight ingest/query stream (closes the connection → server stops work).
  if (ingestAbort) { ingestAbort.abort(); ingestAbort = null; }
  abortQuery();

  // Clear all UI state back to the blank starting point.
  resetScene();
  resetChunks();
  resetEmbed();
  resetRetrieval();
  resetCosTable();
  clearReadout();
  resetCounts();
  resetDetail();
  resetWizard();
  collectedChunks = [];
  btnIngest.disabled = false;
  setQueryEnabled(false);
  hideStage();
  const qt = document.getElementById("query-text");
  if (qt) qt.value = "";
  pdfUpload.value = "";
  sceneLabel.textContent = "waiting for ingest";

  // Clear the backend's in-process session. We do NOT auto-start anything after.
  await fetch("/api/session/reset", { method: "POST" });
  log("Session reset — start a new run when ready.", "accent");
}
