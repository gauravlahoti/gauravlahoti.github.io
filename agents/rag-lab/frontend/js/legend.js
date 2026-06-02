/** Embedding-space legend caption + live point/match counts. */

const caption = document.getElementById("legend-caption");
const ptsEl   = document.getElementById("lg-points");
const matEl   = document.getElementById("lg-matched");

export function setCaption(model, dim) {
  caption.textContent = dim ? `${model} · ${dim}-D · PCA → 3D` : "PCA → 3D";
}

export function setPoints(n) { ptsEl.textContent = String(n); }
export function setMatched(n) { matEl.textContent = String(n); }

export function resetCounts() {
  ptsEl.textContent = "0";
  matEl.textContent = "0";
}
