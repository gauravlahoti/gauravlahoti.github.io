/** Cosine similarity + distance table overlaid on the 3D canvas after retrieval. */

const el = document.getElementById("cos-table");

export function showCosTable(results) {
  if (!el || !results?.length) return;

  const rows = results.slice(0, 8).map((r) => {
    const sim  = r.score ?? 0;
    const dist = (1 - sim).toFixed(3);
    return `<tr>
      <td class="ct-chunk">C${r.chunkIndex}</td>
      <td class="ct-sim">${sim.toFixed(3)}</td>
      <td class="ct-dist">${dist}</td>
    </tr>`;
  }).join("");

  el.innerHTML =
    `<div class="cos-table-head">Query → nearest neighbours</div>` +
    `<table>
      <thead><tr>
        <th>Chunk</th>
        <th>Cos sim ↑</th>
        <th>Cos dist ↓</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  el.classList.add("show");
}

export function resetCosTable() {
  if (!el) return;
  el.classList.remove("show");
  el.innerHTML = "";
}
