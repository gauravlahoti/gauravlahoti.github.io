/**
 * Simulation mode — replays a complete, canned Agentic RAG run through the SAME
 * event handlers the live pipeline uses, with no backend and no model calls.
 * The user then walks all 8 stages with the existing Prev/Next wizard.
 */
import { handleIngestEvent } from "./ingestController.js";
import { handleQueryEvent, beginQueryReplay } from "./queryController.js";
import { resetScene } from "./scene.js";
import { resetChunks } from "./chunksView.js";
import { resetEmbed } from "./embedView.js";
import { resetRetrieval, resetAugment } from "./retrievalView.js";
import { clearReadout } from "./readout.js";
import { resetCounts } from "./legend.js";
import { resetDetail } from "./pointDetail.js";
import { resetWizard, setQueryEnabled } from "./viewState.js";
import { resetCosTable } from "./cosTable.js";
import { log, clearLog } from "./log.js";
import { setStage } from "./stageBanner.js";
import { DEMO_DOC, DEMO_QUERY, INGEST_EVENTS, QUERY_EVENTS } from "./demoData.js";

export function initSimulation() {
  const btn = document.getElementById("btn-simulate");
  if (btn) btn.addEventListener("click", runSimulation);
}

function runSimulation() {
  // Autofill the inputs so the demo data matches what the UI shows.
  const docText = document.getElementById("doc-text");
  const queryText = document.getElementById("query-text");
  if (docText) docText.value = DEMO_DOC;
  if (queryText) queryText.value = DEMO_QUERY;

  // Full reset — identical to a fresh ingest, back to step 1.
  resetScene();
  resetChunks();
  resetEmbed();
  resetRetrieval();
  resetAugment();
  resetCosTable();
  clearReadout();
  resetCounts();
  resetDetail();
  resetWizard();
  clearLog();

  log("▶ Simulation — replaying a full pipeline run with canned data (no API key, no model calls).", "accent");

  // Step-1 banner (chunking). Later steps set their own banners as the user advances.
  setStage("STEP 1/7", "Chunking the document",
    "Recursive splitter — the document is cut into overlapping passages so each fits the embedding model and keeps one coherent idea.");

  // Replay ingest, then query. reach()/markStepDone() unlock all 8 tabs; visual
  // content for each step is buffered by the gate and revealed as the user clicks Next.
  INGEST_EVENTS.forEach((ev) => handleIngestEvent(ev, DEMO_DOC));
  beginQueryReplay(DEMO_QUERY);
  QUERY_EVENTS.forEach((ev) => handleQueryEvent(ev));
  setQueryEnabled(false); // Run Query stays disabled — this is a replayed run.

  log("Simulation loaded — use ◀ Prev / Next ▶ (or click a tab) to step through all 8 stages.", "muted");
}
