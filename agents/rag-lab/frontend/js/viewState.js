/**
 * Wizard navigation: 7 ordered steps the user can walk through with Prev/Next
 * (or by clicking an unlocked tab). Stages unlock as the pipeline produces them.
 * "Follow" mode auto-advances to the newest stage — but the moment the user
 * navigates back to review a step, follow turns off so it won't yank them forward.
 */
import { resize as resizeScene, clearQueryLinks, clearQueryPoint } from "./scene.js";
import { resetCosTable } from "./cosTable.js";
import { setGateStep, flushGate, resetGate, hasPending } from "./eventGate.js";

const VIEWS = ["chunks", "embed", "store", "query", "retrieve", "fuse", "augment", "answer"];
const SPLIT_FROM = VIEWS.indexOf("retrieve"); // split activates at this step

const tabs        = document.querySelectorAll(".view-tab");
const scenePanel  = document.getElementById("panel-scene");
const paneChunks  = document.getElementById("view-chunks");
const paneEmbed   = document.getElementById("view-embed");
const paneVectors = document.getElementById("view-vectors");
const paneRetrieve = document.getElementById("view-retrieve");
const paneFuse    = document.getElementById("view-fuse");
const paneAugment = document.getElementById("view-augment");
const paneAnswer  = document.getElementById("view-answer");
const btnQuery    = document.getElementById("btn-query");
const btnPrev     = document.getElementById("step-prev");
const btnNext     = document.getElementById("step-next");

const PANE = {
  chunks: paneChunks, embed: paneEmbed, store: paneVectors, query: paneVectors,
  retrieve: paneRetrieve, fuse: paneFuse, augment: paneAugment, answer: paneAnswer,
};

let current = 0;       // index of the currently shown step
let maxReached = 0;    // furthest unlocked step
let following = false; // never auto-advance; user clicks Next to proceed

// How long to show the computing overlay before revealing each step's content.
const COMPUTE_CONFIG = {
  embed:    { ms: 900,  icon: "⬡", label: "Embedding chunks",         sub: "running through the embedding model…" },
  store:    { ms: 700,  icon: "⬡", label: "Writing to vector store",  sub: "storing vectors in Chroma…" },
  retrieve: { ms: 1400, icon: "⌖", label: "Searching",                sub: "cosine similarity + BM25 keyword scan…" },
  fuse:     { ms: 1000, icon: "⇌", label: "Fusing rankings",          sub: "Reciprocal Rank Fusion (k=60)…" },
  augment:  { ms: 800,  icon: "⊕", label: "Augmenting prompt",        sub: "assembling numbered context passages…" },
  answer:   { ms: 600,  icon: "✦", label: "Generating answer",        sub: "streaming from the LLM…" },
};

export function initViewTabs() {
  tabs.forEach((tab) => tab.addEventListener("click", () => _clickTab(tab.dataset.view)));
  if (btnPrev) btnPrev.addEventListener("click", goPrev);
  if (btnNext) btnNext.addEventListener("click", goNext);
  _render();
}

/** Pipeline reached a stage — unlock it and (if following) advance to it. */
export function reach(view) {
  const i = VIEWS.indexOf(view);
  if (i < 0) return;
  if (i > maxReached) maxReached = i;
  if (following) current = maxReached;
  _render();
}

export function goNext() {
  if (current < maxReached) {
    current++;
    _render();
    _advanceStep(VIEWS[current]);
  }
}
export function goPrev() {
  if (current > 0) {
    _revertScene(current, current - 1);
    current--;
    _render();
  }
}

const RETRIEVE_IDX = VIEWS.indexOf("retrieve");
const QUERY_IDX    = VIEWS.indexOf("query");
const SCENE_HINT   = document.getElementById("scene-hint");

function _revertScene(fromIdx, toIdx) {
  // Crossing back below retrieve: lines + highlights disappear, cosine table hides.
  if (fromIdx >= RETRIEVE_IDX && toIdx < RETRIEVE_IDX) {
    clearQueryLinks();
    resetCosTable();
    if (SCENE_HINT) { SCENE_HINT.textContent = ""; SCENE_HINT.classList.remove("show"); }
  }
  // Crossing back below query: query sphere disappears too.
  if (fromIdx >= QUERY_IDX && toIdx < QUERY_IDX) {
    clearQueryPoint();
  }
}

function _clickTab(view) {
  const i = VIEWS.indexOf(view);
  if (i < 0 || i > maxReached) return;   // locked
  current = i;
  _render();
  _advanceStep(VIEWS[current]);
}

/**
 * Show computing overlay (if step has buffered content + a configured delay),
 * then flush the gate. Falls through immediately if nothing is pending.
 */
function _advanceStep(stepName) {
  const cfg = COMPUTE_CONFIG[stepName];
  if (cfg && hasPending(stepName)) {
    _showComputing(PANE[stepName], cfg, () => flushGate(stepName));
  } else {
    flushGate(stepName);
  }
}

/** Inject a frosted-glass computing overlay into pane, remove it after cfg.ms, then call onDone. */
function _showComputing(pane, cfg, onDone) {
  if (!pane) { onDone(); return; }

  const el = document.createElement("div");
  el.className = "step-computing";
  el.innerHTML = `
    <div class="computing-icon">${cfg.icon}</div>
    <div class="computing-label">${cfg.label}</div>
    <div class="computing-sub">${cfg.sub}</div>
    <div class="computing-bar"></div>
  `;
  pane.appendChild(el);

  // Trigger CSS opacity transition on next frame.
  requestAnimationFrame(() => el.classList.add("show"));

  setTimeout(() => {
    el.classList.remove("show");
    const remove = () => { el.remove(); onDone(); };
    el.addEventListener("transitionend", remove, { once: true });
    // Fallback in case transitionend doesn't fire (e.g. reduced-motion).
    setTimeout(remove, 250);
  }, cfg.ms);
}

/** Mark a step's tab as completed (filled badge). */
export function markStepDone(view) {
  const tab = document.querySelector(`.view-tab[data-view="${view}"]`);
  if (tab) tab.classList.add("done");
}

/** Reset the whole wizard back to step 1. */
export function resetWizard() {
  current = 0; maxReached = 0; following = false;
  resetGate();
  tabs.forEach((t) => t.classList.remove("done"));
  scenePanel.classList.remove("scene-split", "show-query-tab");
  paneVectors.style.display = "";   // let CSS/JS take over cleanly
  _render();
}

export function setQueryEnabled(on) {
  btnQuery.disabled = !on;
  btnQuery.classList.toggle("ready-pulse", on);
}

function _render() {
  const view   = VIEWS[current];
  setGateStep(view);  // keep eventGate in sync with where the user is
  // Split mode (3D canvas pinned beside the active content) is a desktop
  // luxury. On phones it crams two panes onto a tiny screen and shows an
  // empty canvas on the early steps — so mobile stays single-pane: one view
  // at a time, navigated with Prev/Next.
  const isMobile = matchMedia("(max-width: 768px)").matches;
  const isSplit = maxReached >= SPLIT_FROM && !isMobile;

  // ── Split mode: 3D canvas pinned left, content pane on the right ──
  scenePanel.classList.toggle("scene-split", isSplit);
  scenePanel.classList.toggle("show-query-tab", isSplit && view === "query");

  tabs.forEach((t) => {
    const i = VIEWS.indexOf(t.dataset.view);
    t.classList.toggle("active", i === current);
    t.classList.toggle("locked", i > maxReached);
  });

  const paneSet = new Set(Object.values(PANE));
  for (const pane of paneSet) {
    if (isSplit && pane === paneVectors) {
      // CSS keeps paneVectors visible via `display: flex !important`; skip JS.
      continue;
    }
    pane.style.display = PANE[view] === pane ? "flex" : "none";
  }

  // Query bar: shown inside the 3D canvas when on the Query tab.
  paneVectors.classList.toggle("show-query",
    !isSplit ? (view === "query") : (view === "query"));

  if (btnPrev) btnPrev.disabled = current <= 0;
  if (btnNext) {
    btnNext.disabled = current >= maxReached;
    btnNext.classList.toggle("ready-pulse", !following && current < maxReached);
  }
  // Always resize canvas (it's always visible in split mode).
  requestAnimationFrame(resizeScene);
}
