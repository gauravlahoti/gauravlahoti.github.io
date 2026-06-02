/** Click-a-point detail card: shows a chunk's PCA coords, embedding vector, and text. */
import { setAutoRotate } from "./scene.js";

const panel    = document.getElementById("vec-detail");
const closeBtn = document.getElementById("vec-detail-close");
const titleEl  = document.getElementById("vd-title");
const coordsEl = document.getElementById("vd-coords");
const vecEl    = document.getElementById("vd-vec");
const textEl   = document.getElementById("vd-text");

const registry = new Map();   // index → { text, preview, dim, point }

export function initPointDetail() {
  if (closeBtn) closeBtn.addEventListener("click", () => showDetail(null));
}

/** Merge partial data for a chunk (text, preview/dim, point arrive at different stages). */
export function setChunkData(index, data) {
  registry.set(index, { ...(registry.get(index) || {}), ...data });
}

export function resetDetail() {
  registry.clear();
  _hide();
}

/** Show (or hide, if index is null/unknown) the detail card for a chunk. */
export function showDetail(index) {
  if (index == null || !registry.has(index)) { _hide(); return; }
  const d = registry.get(index);
  titleEl.textContent = `Chunk ${index}`;
  coordsEl.innerHTML =
    `<span class="vd-k">PCA point</span> (${(d.point || []).map((v) => v.toFixed(2)).join(", ")})`;
  const preview = (d.preview || []).map((v) => (v >= 0 ? " " : "") + v.toFixed(4)).join(", ");
  vecEl.innerHTML =
    `<span class="vd-k">embedding</span> [${preview}<span class="vd-dim"> … ${d.dim || "?"}-D]</span>`;
  textEl.textContent = d.text || "";
  panel.classList.add("show");
}

function _hide() {
  panel.classList.remove("show");
  setAutoRotate(true);
}
