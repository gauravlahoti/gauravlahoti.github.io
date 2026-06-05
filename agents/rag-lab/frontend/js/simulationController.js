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

let tourObserver = null;

export function initSimulation() {
  const btn = document.getElementById("btn-simulate");
  if (btn) btn.addEventListener("click", runSimulation);
}

/** Enter guided-tour mode: lock the ingest controls, flag the Next button. */
function enterTourMode() {
  const body = document.querySelector("#panel-controls .panel-body");
  if (body) body.classList.add("sim-active");
  const btnIngest = document.getElementById("btn-ingest");
  if (btnIngest) btnIngest.disabled = true;

  const nav = document.querySelector(".stage-nav");
  const btnNext = document.getElementById("step-next");
  if (!nav || !btnNext) return;

  let coach = document.getElementById("tour-coach");
  if (!coach) {
    coach = document.createElement("div");
    coach.id = "tour-coach";
    coach.className = "tour-coach";
    nav.appendChild(coach);
    // Dismiss (✕) — user understood; kill the hint + Next pulse, keep sim loaded.
    coach.addEventListener("click", (e) => {
      if (!e.target.closest(".tour-coach-close")) return;
      coach.remove();
      if (tourObserver) { tourObserver.disconnect(); tourObserver = null; }
    });
  }
  const CLOSE = `<button class="tour-coach-close" title="Dismiss" aria-label="Dismiss">✕</button>`;
  const setCoach = () => {
    if (btnNext.disabled) {
      coach.className = "tour-coach done";
      coach.innerHTML = `✓ That's the full pipeline — hit <b>Reset Session</b> to run it live.${CLOSE}`;
    } else {
      coach.className = "tour-coach";
      coach.innerHTML = `<span class="tour-coach-arrow">↑</span> Click <b>Next ▶</b> to walk each stage${CLOSE}`;
    }
  };
  setCoach();

  if (tourObserver) tourObserver.disconnect();
  tourObserver = new MutationObserver(setCoach);
  tourObserver.observe(btnNext, { attributes: true, attributeFilter: ["disabled"] });
}

/** Exit guided-tour mode (called by Reset Session). */
export function exitTourMode() {
  const body = document.querySelector("#panel-controls .panel-body");
  if (body) body.classList.remove("sim-active");
  const btnIngest = document.getElementById("btn-ingest");
  if (btnIngest) btnIngest.disabled = false;
  const coach = document.getElementById("tour-coach");
  if (coach) coach.remove();
  if (tourObserver) { tourObserver.disconnect(); tourObserver = null; }
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
  setStage("STEP 1/8", "Chunking the document",
    "What it is: a long document is cut into small, overlapping passages so each fits the model and holds one coherent idea. Recursive splitter — tries paragraph → line → sentence → word boundaries.");

  // Replay ingest, then query. reach()/markStepDone() unlock all 8 tabs; visual
  // content for each step is buffered by the gate and revealed as the user clicks Next.
  INGEST_EVENTS.forEach((ev) => handleIngestEvent(ev, DEMO_DOC));
  beginQueryReplay(DEMO_QUERY);
  QUERY_EVENTS.forEach((ev) => handleQueryEvent(ev));
  setQueryEnabled(false); // Run Query stays disabled — this is a replayed run.

  enterTourMode();
  log("Simulation loaded — use ◀ Prev / Next ▶ (or click a tab) to step through all 8 stages.", "muted");

  // On phones the controls panel fills the screen, so the user lands far above
  // the stage view. Scroll the scene into view so they immediately see step 1
  // and the Next control.
  if (matchMedia("(max-width: 768px)").matches) {
    requestAnimationFrame(() => {
      document.getElementById("panel-scene")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}
