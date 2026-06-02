/** Live numeric PCA-coordinate readout overlaid on the 3D scene. */

const el = document.getElementById("vec-readout");
let head = null;
let queryRow = null;
let list = null;

function _ensure() {
  if (!head) {
    head = document.createElement("div");
    head.className = "vec-head";
    head.textContent = "PCA coords (x, y, z)";
    el.appendChild(head);
  }
  if (!list) {
    list = document.createElement("div");
    el.appendChild(list);
  }
}

export function clearReadout() {
  el.innerHTML = "";
  el.classList.remove("show");
  head = null;
  list = null;
  queryRow = null;
}

/** Append a corpus point's coordinates. */
export function addReadout(label, point, color = "#00ffd1") {
  _ensure();
  el.classList.add("show");
  const row = document.createElement("div");
  row.className = "vec-row";
  row.innerHTML = `<span style="color:${color}">${_pad(label, 6)}</span>(${_fmt(point)})`;
  list.appendChild(row);
  while (list.children.length > 12) list.removeChild(list.firstChild);
}

/** Pin the query coordinates at the top (replaces any previous). */
export function setQueryReadout(point) {
  _ensure();
  el.classList.add("show");
  if (queryRow) queryRow.remove();
  queryRow = document.createElement("div");
  queryRow.className = "vec-row q";
  queryRow.innerHTML = `<span>${_pad("query", 6)}</span>(${_fmt(point)})`;
  el.insertBefore(queryRow, head.nextSibling);
}

function _fmt(p) {
  return p.map((v) => (v >= 0 ? " " : "") + v.toFixed(2)).join(", ");
}
function _pad(s, n) {
  return (s + " ".repeat(n)).slice(0, n);
}
