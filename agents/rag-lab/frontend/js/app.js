import { initScene, setPointClickHandler } from "./scene.js";
import { initIngestController } from "./ingestController.js";
import { initQueryController } from "./queryController.js";
import { initViewTabs } from "./viewState.js";
import { initPointDetail, showDetail } from "./pointDetail.js";
import { initSimulation } from "./simulationController.js";
import { log } from "./log.js";

// ── 3D / content column drag-to-resize ───────────────
function initSceneColResize() {
  const handle   = document.getElementById("scene-col-handle");
  const panel    = document.getElementById("panel-scene");
  if (!handle || !panel) return;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev) => {
      const rect   = panel.getBoundingClientRect();
      const leftPx = Math.max(180, Math.min(ev.clientX - rect.left, rect.width - 180));
      panel.style.gridTemplateColumns = `${leftPx}px 5px 1fr`;
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ── Log panel drag-to-resize ──────────────────────────
function initLogResize() {
  const handle  = document.getElementById("log-resize-handle");
  const appEl   = document.getElementById("app");
  if (!handle || !appEl) return;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    handle.classList.add("dragging");
    const startY = e.clientY;
    const startH = document.getElementById("panel-log").getBoundingClientRect().height;

    const onMove = (ev) => {
      const delta = startY - ev.clientY;           // drag up → bigger log
      const newH  = Math.max(72, Math.min(480, startH + delta));
      appEl.style.gridTemplateRows = `1fr ${newH}px`;
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

async function boot() {
  // Populate model selectors from /api/config
  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    const embSel = document.getElementById("embedding-model");
    const llmSel = document.getElementById("llm-model");

    cfg.embeddingModels.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      if (m.default) opt.selected = true;
      embSel.appendChild(opt);
    });

    cfg.llms.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      if (m.default) opt.selected = true;
      llmSel.appendChild(opt);
    });
  } catch (e) {
    log(`Could not load config: ${e.message}`, "danger");
  }

  // Boot Three.js scene
  const canvas = document.getElementById("rag-canvas");
  initScene(canvas);

  // Wire up controllers
  initViewTabs();
  initPointDetail();
  setPointClickHandler(showDetail);   // click a 3D point → show its vector details
  initIngestController();
  initQueryController();
  initSimulation();
  initSceneColResize();
  initLogResize();

  log("Agentic RAG ready — paste a document and click Ingest, or run the guided simulation.", "accent");
}

boot();
