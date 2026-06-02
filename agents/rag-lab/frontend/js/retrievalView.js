/**
 * Retrieval comparison view (Query step):
 *   Semantic (dense, cosine) | Lexical (BM25)  →  Fused (RRF)  →  Answer
 * Chunks that surface in BOTH semantic and lexical lists are cross-highlighted,
 * which is exactly what fusion rewards.
 */

const thinkingBlock = document.getElementById("retr-thinking-block");
const thinkingCol   = document.getElementById("thinking-col");
const denseCol      = document.getElementById("dense-col");
const sparseCol     = document.getElementById("sparse-col");
const fusedCol      = document.getElementById("fused-col");
const answerCol     = document.getElementById("answer-col");
const sourcesEl     = document.getElementById("answer-sources");
const augmentList   = document.getElementById("augment-list");
const augmentMeta   = document.getElementById("augment-meta");

const heads = document.querySelectorAll(".retr-h");

let denseIdx = new Set();
let sparseIdx = new Set();
let answerBuf = "";
let citations = [];

export function resetRetrieval() {
  thinkingBlock.style.display = "none";
  thinkingCol.textContent = "";
  denseCol.innerHTML = '<div class="retr-wait">searching…</div>';
  sparseCol.innerHTML = '<div class="retr-wait">searching…</div>';
  fusedCol.innerHTML = '<div class="retr-wait">waiting…</div>';
  answerCol.innerHTML = '<span class="retr-wait">waiting…</span>';
  sourcesEl.innerHTML = "";
  answerBuf = "";
  citations = [];
  denseIdx = new Set();
  sparseIdx = new Set();
  heads.forEach((h) => h.classList.remove("active"));
}

export function resetAugment() {
  if (augmentList) augmentList.innerHTML = '<div class="retr-wait">run a query…</div>';
  if (augmentMeta) augmentMeta.textContent = "";
}

/** Render the Augment view: user question + numbered passages sent to the LLM. */
export function showAugment(cites, tokenEstimate, query) {
  if (!augmentList) return;

  // Header meta
  if (augmentMeta) {
    augmentMeta.textContent = `${cites?.length ?? 0} passages · ~${tokenEstimate ?? "?"} tokens injected into the LLM prompt`;
  }

  augmentList.innerHTML = "";

  // ── User question ──────────────────────────────────────────────────────
  if (query) {
    const qEl = document.createElement("div");
    qEl.className = "augment-question";
    qEl.innerHTML =
      `<div class="augment-question-label">Your question</div>` +
      `<div class="augment-question-text">${_esc(query)}</div>`;
    augmentList.appendChild(qEl);
  }

  if (!cites?.length) {
    augmentList.insertAdjacentHTML("beforeend", '<div class="retr-wait">no context assembled</div>');
    return;
  }

  // ── Retrieved passages ─────────────────────────────────────────────────
  cites.forEach((c) => {
    const fullText  = c.fullText || c.preview || "";
    const shortText = _short(fullText, 220);
    const hasMore   = fullText.length > 220;

    const el = document.createElement("div");
    el.className = "augment-passage";
    el.innerHTML =
      `<div class="augment-passage-head">` +
      `<span class="cite-chip">${c.n}</span>` +
      `<span class="augment-chunk-id">chunk ${c.chunkIndex}</span>` +
      (hasMore ? `<button class="aug-expand-btn">▾ expand</button>` : "") +
      `</div>` +
      `<div class="augment-passage-text aug-short">${_esc(shortText)}${hasMore ? " …" : ""}</div>` +
      (hasMore ? `<div class="augment-passage-text aug-full" style="display:none">${_esc(fullText)}</div>` : "");

    if (hasMore) {
      el.querySelector(".aug-expand-btn").addEventListener("click", (e) => {
        const btn   = e.currentTarget;
        const short = el.querySelector(".aug-short");
        const full  = el.querySelector(".aug-full");
        const open  = full.style.display !== "none";
        short.style.display = open ? "block" : "none";
        full.style.display  = open ? "none"  : "block";
        btn.textContent = open ? "▾ expand" : "▴ collapse";
      });
    }
    augmentList.appendChild(el);
  });
}

/** Store the numbered sources and render the "Sources" list under the answer. */
export function setCitations(cites) {
  citations = cites || [];
  if (!citations.length) { sourcesEl.innerHTML = ""; return; }
  sourcesEl.innerHTML =
    '<div class="sources-head">Sources</div>' +
    citations.map((c) =>
      `<div class="source-row"><span class="cite-chip">${c.n}</span>` +
      `<span class="source-chunk">chunk ${c.chunkIndex}</span>` +
      `<span class="source-prev">${_esc(c.preview || "")}</span></div>`
    ).join("");
}

export function setActive(...stages) {
  heads.forEach((h) => h.classList.toggle("active", stages.includes(h.dataset.c)));
}

export function appendThinking(delta) {
  thinkingBlock.style.display = "flex";
  thinkingCol.textContent += delta;
  thinkingCol.scrollTop = thinkingCol.scrollHeight;
}

export function showDense(results) {
  denseIdx = new Set(results.map((r) => r.chunkIndex));
  denseCol.innerHTML = "";
  results.slice(0, 5).forEach((r) => {
    denseCol.appendChild(card(r.chunkIndex, r.rank, r.text, `cos ${r.score?.toFixed(3) ?? "—"}`, false, r.text));
  });
  _crossMark();
}

export function showSparse(results) {
  sparseIdx = new Set(results.map((r) => r.chunkIndex));
  sparseCol.innerHTML = "";
  results.slice(0, 5).forEach((r) => {
    const body = _highlight(r.text, r.matchedTerms);
    sparseCol.appendChild(card(r.chunkIndex, r.rank, body, `bm25 ${r.bm25Score?.toFixed(2) ?? "—"}`, true, r.text));
  });
  _crossMark();
}

export function showFused(results) {
  fusedCol.innerHTML = "";
  results.forEach((r) => {
    const meta = [
      `rrf ${r.rrfScore?.toFixed(4) ?? "—"}`,
      r.denseRank != null ? `sem #${r.denseRank + 1}` : null,
      r.sparseRank != null ? `lex #${r.sparseRank + 1}` : null,
    ].filter(Boolean).join("  ·  ");
    fusedCol.appendChild(card(r.chunkIndex, r.rank, r.text, meta, false, r.text));
  });
}

export function appendAnswer(delta) {
  answerBuf += delta;
  // Re-render the full buffer each chunk — cheap at typical answer lengths.
  answerCol.innerHTML = _renderCitations(answerBuf);
  answerCol.scrollTop = answerCol.scrollHeight;
}

// Render markdown → HTML, then turn [n] markers into citation chips.
function _renderCitations(raw) {
  let html = _md(raw);
  // citation chips (applied after markdown so [1] inside code isn't affected)
  html = html.replace(/\[(\d+)\]/g, (_, n) =>
    `<sup class="cite-chip" data-n="${n}">${n}</sup>`,
  );
  return html;
}

/**
 * Minimal Markdown renderer — handles the subset Claude typically emits:
 * **bold**, *italic*, `code`, # headings, - / * bullet lists, numbered lists,
 * blank-line paragraphs, and --- horizontal rules.
 */
function _md(text) {
  // Escape HTML in non-code spans
  const lines = text.split("\n");
  const out = [];
  let inList = false;
  let listType = "";

  const flush = () => {
    if (inList) { out.push(`</${listType}>`); inList = false; listType = ""; }
  };

  const inline = (s) =>
    _esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, `<code class="ans-code">$1</code>`);

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    // Horizontal rule
    if (/^---+$/.test(l.trim())) { flush(); out.push("<hr class='ans-hr'>"); continue; }

    // Headings
    const hm = l.match(/^(#{1,3})\s+(.*)/);
    if (hm) { flush(); const t = hm[1].length + 2; out.push(`<h${t} class="ans-h">${inline(hm[2])}</h${t}>`); continue; }

    // Bullet list
    const bm = l.match(/^[-*]\s+(.*)/);
    if (bm) {
      if (!inList || listType !== "ul") { flush(); out.push("<ul class='ans-ul'>"); inList = true; listType = "ul"; }
      out.push(`<li>${inline(bm[1])}</li>`);
      continue;
    }

    // Numbered list
    const nm = l.match(/^\d+\.\s+(.*)/);
    if (nm) {
      if (!inList || listType !== "ol") { flush(); out.push("<ol class='ans-ol'>"); inList = true; listType = "ol"; }
      out.push(`<li>${inline(nm[1])}</li>`);
      continue;
    }

    // Blank line → paragraph break
    if (l.trim() === "") { flush(); out.push("<br>"); continue; }

    // Normal paragraph line
    flush();
    out.push(`<span class="ans-line">${inline(l)}</span><br>`);
  }
  flush();
  return out.join("");
}

// ── helpers ──────────────────────────────────────────
function card(idx, rank, bodyHtmlOrText, score, isHtml = false, fullText = "") {
  const el = document.createElement("div");
  el.className = "retr-card";
  el.dataset.chunk = idx;
  const preview = isHtml ? bodyHtmlOrText : _esc(_short(bodyHtmlOrText));
  const full = _esc(fullText || (isHtml ? "" : bodyHtmlOrText));
  el.innerHTML =
    `<div class="retr-card-head">` +
    `<span class="rank">#${(rank ?? 0) + 1}</span>` +
    `<span class="cidx">chunk ${idx}</span>` +
    `<span class="score">${score}</span>` +
    `<button class="card-expand-btn" title="Show full chunk">▾</button>` +
    `</div>` +
    `<div class="retr-card-body">${preview}</div>` +
    `<div class="retr-card-full" style="display:none">${full}</div>`;
  el.querySelector(".card-expand-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const fullEl = el.querySelector(".retr-card-full");
    const btn = el.querySelector(".card-expand-btn");
    const open = fullEl.style.display !== "none";
    fullEl.style.display = open ? "none" : "block";
    btn.textContent = open ? "▾" : "▴";
    el.classList.toggle("card-expanded", !open);
  });
  return el;
}

function _crossMark() {
  const both = [...denseIdx].filter((i) => sparseIdx.has(i));
  [denseCol, sparseCol].forEach((col) => {
    col.querySelectorAll(".retr-card").forEach((c) => {
      const idx = Number(c.dataset.chunk);
      if (both.includes(idx) && !c.querySelector(".both-tag")) {
        c.classList.add("both");
        const tag = document.createElement("span");
        tag.className = "both-tag";
        tag.textContent = "both";
        c.querySelector(".retr-card-head").appendChild(tag);
      }
    });
  });
}

function _short(t, len = 160) { return (t || "").replace(/\s+/g, " ").trim().slice(0, len); }
function _esc(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

/** Extract a window centred on the FIRST matched term so it's always visible. */
function _snippet(text, terms, win = 220) {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  if (!terms?.length) return flat.slice(0, win);
  const lower = flat.toLowerCase();
  let earliest = flat.length;
  for (const t of terms) {
    if (!t) continue;
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && i < earliest) earliest = i;
  }
  if (earliest === flat.length) return flat.slice(0, win);        // no match found
  const start = Math.max(0, earliest - 60);                       // show context before the match
  const end   = start + win;
  return (start > 0 ? "… " : "") + flat.slice(start, end) + (end < flat.length ? " …" : "");
}

function _highlight(text, terms) {
  // Use snippet so the matched keyword is actually visible even deep in the chunk.
  const snippet = _snippet(text, terms);
  const safe = _esc(snippet);
  if (!terms?.length) return safe;
  const esc = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean);
  if (!esc.length) return safe;
  return safe.replace(new RegExp(`(${esc.join("|")})`, "gi"), "<mark>$1</mark>");
}
