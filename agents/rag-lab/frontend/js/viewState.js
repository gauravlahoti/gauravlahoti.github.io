/**
 * Wizard navigation: 7 ordered steps the user can walk through with Prev/Next
 * (or by clicking an unlocked tab). Stages unlock as the pipeline produces them.
 * "Follow" mode auto-advances to the newest stage — but the moment the user
 * navigates back to review a step, follow turns off so it won't yank them forward.
 */
import { resize as resizeScene } from "./scene.js";

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
let following = true;  // auto-advance to newest stage?

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
  if (current < maxReached) { current++; following = current === maxReached; _render(); }
}
export function goPrev() {
  if (current > 0) { current--; following = false; _render(); }
}

function _clickTab(view) {
  const i = VIEWS.indexOf(view);
  if (i < 0 || i > maxReached) return;   // locked
  current = i;
  following = current === maxReached;
  _render();
}

/** Mark a step's tab as completed (filled badge). */
export function markStepDone(view) {
  const tab = document.querySelector(`.view-tab[data-view="${view}"]`);
  if (tab) tab.classList.add("done");
}

/** Reset the whole wizard back to step 1. */
export function resetWizard() {
  current = 0; maxReached = 0; following = true;
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
  const isSplit = maxReached >= SPLIT_FROM;

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
