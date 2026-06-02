/** "Embed" step view — shows each chunk's text turning into a vector of numbers. */

const list  = document.getElementById("embed-list");
const modelLabel = document.getElementById("embed-model-label");

export function setEmbedModel(model, dim) {
  modelLabel.textContent = dim ? `${model} · ${dim} dimensions` : model;
}

export function resetEmbed() {
  list.innerHTML = '<div class="doc-placeholder" style="padding:14px">Each chunk is sent to the embedding model and returned as a high-dimensional vector of numbers.</div>';
}

/**
 * Append a chunk's embedding row.
 * @param {number} index
 * @param {string} text     chunk text (preview)
 * @param {number[]} preview first few vector dims
 * @param {number} dim       full dimensionality
 */
export function addEmbedRow(index, text, preview, dim) {
  _clearPlaceholder();
  const row = document.createElement("div");
  row.className = "embed-row";
  row.dataset.chunk = index;
  row.innerHTML =
    `<div class="embed-text"><b>C${index}</b> ${_esc(_short(text))}</div>` +
    `<div class="embed-vec"><span class="embed-arrow">→</span> [${_fmt(preview)} <span class="dim">… ${dim}-D]</span></div>`;
  list.appendChild(row);
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/** Pin the query's embedding at the top. */
export function setQueryEmbedRow(text, preview, dim) {
  _clearPlaceholder();
  let row = list.querySelector(".embed-row.q");
  if (!row) {
    row = document.createElement("div");
    row.className = "embed-row q";
    list.insertBefore(row, list.firstChild);
  }
  row.innerHTML =
    `<div class="embed-text"><b>query</b> ${_esc(_short(text))}</div>` +
    `<div class="embed-vec"><span class="embed-arrow">→</span> [${_fmt(preview)} <span class="dim">… ${dim}-D]</span></div>`;
}

// ── helpers ──────────────────────────────────────────
function _clearPlaceholder() {
  const ph = list.querySelector(".doc-placeholder");
  if (ph) ph.remove();
}
function _short(t) { return (t || "").replace(/\s+/g, " ").trim().slice(0, 60); }
function _fmt(p) { return (p || []).slice(0, 5).map((v) => (v >= 0 ? " " : "") + v.toFixed(3)).join(", "); }
function _esc(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
