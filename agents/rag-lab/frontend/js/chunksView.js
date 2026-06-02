/**
 * Side-by-side chunking visualisation:
 *   left  — the full document with each chunk drawn as a coloured span;
 *           overlap regions (covered by 2 chunks) are striped.
 *   right — one card per chunk, colour-matched, showing range + token count + text.
 */

const docEl    = document.getElementById("chunk-doc");
const cardsEl  = document.getElementById("chunk-cards");
const countEl  = document.getElementById("chunk-count");

/** Deterministic per-chunk hue. */
export function chunkColor(i) {
  const hue = (i * 67) % 360;
  return `hsl(${hue} 85% 62%)`;
}
function chunkBg(i, alpha = 0.16) {
  const hue = (i * 67) % 360;
  return `hsla(${hue} 85% 62% / ${alpha})`;
}

export function resetChunks() {
  docEl.innerHTML = '<span class="doc-placeholder">Paste a document and click Ingest to see it split into overlapping chunks.</span>';
  cardsEl.innerHTML = "";
  countEl.textContent = "";
}

/**
 * Render the document highlighted by chunk boundaries + the chunk cards.
 * @param {string} fullText
 * @param {Array<{index,start,end,tokenCount}>} chunks
 */
export function renderChunks(fullText, chunks) {
  countEl.textContent = `(${chunks.length})`;
  _renderDoc(fullText, chunks);
  _renderCards(fullText, chunks);
}

function _renderDoc(fullText, chunks) {
  // Collect all boundary offsets, build non-overlapping segments,
  // then style each by how many chunks cover it.
  const bounds = new Set([0, fullText.length]);
  for (const c of chunks) {
    if (c.start >= 0) bounds.add(Math.min(c.start, fullText.length));
    if (c.end >= 0) bounds.add(Math.min(c.end, fullText.length));
  }
  const sorted = [...bounds].filter((p) => p >= 0 && p <= fullText.length).sort((a, b) => a - b);

  // offset → chunk index, so we can drop a small badge where each chunk begins
  const startMap = new Map();
  for (const c of chunks) if (!startMap.has(c.start)) startMap.set(c.start, c.index);

  const frag = document.createDocumentFragment();
  for (let i = 0; i < sorted.length - 1; i++) {
    const s = sorted[i];
    const e = sorted[i + 1];
    if (e <= s) continue;
    const covering = chunks.filter((c) => c.start <= s && c.end >= e);

    // badge at the start of a chunk
    if (startMap.has(s)) {
      const idx = startMap.get(s);
      const badge = document.createElement("span");
      badge.className = "seg-badge";
      badge.textContent = `C${idx}`;
      badge.style.color = chunkColor(idx);
      badge.style.borderColor = chunkColor(idx);
      frag.appendChild(badge);
    }

    const span = document.createElement("span");
    span.textContent = fullText.slice(s, e);

    if (covering.length === 0) {
      span.className = "seg-gap";
    } else if (covering.length === 1) {
      const idx = covering[0].index;
      span.className = "seg";
      span.style.background = chunkBg(idx, 0.13);
      span.dataset.chunk = idx;
      span.title = `Chunk ${idx}`;
    } else {
      // overlap region — the two chunks share this text
      const a = covering[0].index;
      const b = covering[covering.length - 1].index;
      span.className = "seg seg-overlap";
      span.style.background =
        `repeating-linear-gradient(45deg, ${chunkBg(a, 0.22)} 0 7px, ${chunkBg(b, 0.22)} 7px 14px)`;
      span.title = `Overlap — chunks ${a} ↔ ${b}`;
    }
    frag.appendChild(span);
  }
  docEl.innerHTML = "";
  docEl.appendChild(frag);
}

function _renderCards(fullText, chunks) {
  const frag = document.createDocumentFragment();
  for (const c of chunks) {
    const card = document.createElement("div");
    card.className = "chunk-card-full";
    card.style.borderLeft = `3px solid ${chunkColor(c.index)}`;
    card.dataset.chunk = c.index;

    const head = document.createElement("div");
    head.className = "chunk-index";
    head.innerHTML =
      `<span class="dot" style="background:${chunkColor(c.index)}"></span>` +
      `Chunk ${c.index} &nbsp;·&nbsp; ${c.start}–${c.end} &nbsp;·&nbsp; ~${c.tokenCount} tok`;

    const body = document.createElement("div");
    body.className = "chunk-body";
    const slice = c.start >= 0 && c.end > c.start ? fullText.slice(c.start, c.end) : (c.text || "");
    body.textContent = slice;

    card.appendChild(head);
    card.appendChild(body);
    frag.appendChild(card);
  }
  cardsEl.innerHTML = "";
  cardsEl.appendChild(frag);
}

/** Briefly flash the most recently added chunk card + its doc span. */
export function pulseChunk(index) {
  const card = cardsEl.querySelector(`.chunk-card-full[data-chunk="${index}"]`);
  if (card) {
    card.classList.add("just-added");
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setTimeout(() => card.classList.remove("just-added"), 600);
  }
}
