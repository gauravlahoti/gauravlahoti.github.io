/**
 * Floating "guide" narrator — a terminal-style assistant bubble pinned to the
 * scene panel that explains each pipeline step in plain language as it happens.
 *
 * It mirrors whatever setStage() pushes to the banner (chip / title / desc), but
 * presents it as a persona that types the explanation out, so the per-step
 * teaching copy actually catches the eye instead of reading as passive chrome.
 *
 * Lives inside #panel-scene (which is `overflow:hidden`), so it can never spill
 * past the panel and re-introduce the mobile right-edge clipping we fixed.
 */

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const TYPE_MS = 14; // per-character typing speed

let el, stepChip, titleEl, textEl, dot, collapseBtn;
let typeTimer = null;
let collapsed = false;

function ensureMounted() {
  if (el) return true;
  el = document.getElementById("stage-narrator");
  if (!el) return false;
  stepChip = document.getElementById("narrator-step");
  titleEl  = document.getElementById("narrator-title");
  textEl   = document.getElementById("narrator-text");
  dot      = document.getElementById("narrator-dot");
  collapseBtn = document.getElementById("narrator-collapse");

  // Avatar (desktop corner badge) always expands; the collapse button toggles —
  // on mobile the dock has no corner avatar, so the button is the only handle.
  document.getElementById("narrator-avatar")?.addEventListener("click", () => setCollapsed(false));
  collapseBtn?.addEventListener("click", () => setCollapsed(!collapsed));
  return true;
}

function setCollapsed(on) {
  collapsed = on;
  if (!el) return;
  el.classList.toggle("collapsed", on);
  document.body.classList.toggle("rag-guide-collapsed", on); // mobile reclaims dock space
  if (collapseBtn) {
    collapseBtn.textContent = on ? "+" : "—";
    collapseBtn.title = on ? "Expand guide" : "Collapse guide";
  }
  if (!on && dot) dot.classList.remove("show"); // expanding clears the "new" ping
}

/** Stop any in-flight typewriter run. */
function stopTyping() {
  if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
}

function type(text) {
  stopTyping();
  if (REDUCED) { textEl.textContent = text; return; }
  textEl.textContent = "";
  textEl.classList.add("typing");
  let i = 0;
  const tick = () => {
    textEl.textContent = text.slice(0, i);
    if (i++ < text.length) {
      typeTimer = setTimeout(tick, TYPE_MS);
    } else {
      textEl.classList.remove("typing");
      typeTimer = null;
    }
  };
  tick();
}

/**
 * Update the narrator for a new stage.
 * @param {string} chipText  e.g. "STEP 3/8", "DONE", "STORED ✓", "ERROR"
 * @param {string} titleText
 * @param {string} descText
 * @param {"active"|"done"|"idle"} [tone]
 */
export function narrate(chipText, titleText, descText, tone = "active") {
  if (!ensureMounted()) return;
  el.hidden = false;
  // Flag the run so mobile can reserve room for the fixed bottom agent dock.
  document.body.classList.add("rag-narrating");

  el.classList.remove("tone-done", "tone-idle");
  if (tone === "done") el.classList.add("tone-done");
  else if (tone === "idle") el.classList.add("tone-idle");

  stepChip.textContent = chipText;
  titleEl.textContent  = titleText;

  // Re-trigger the entrance pulse so the eye snaps to the fresh step.
  el.classList.remove("pulse");
  void el.offsetWidth; // reflow so the animation restarts
  el.classList.add("pulse");

  if (collapsed) {
    // Don't type behind a collapsed bubble — just flag that there's new guidance.
    textEl.textContent = descText;
    if (dot) dot.classList.add("show");
  } else {
    type(descText);
  }
}

/** Hide the narrator entirely (mirrors hideStage). */
export function hideNarrator() {
  if (!ensureMounted()) return;
  stopTyping();
  el.hidden = true;
  document.body.classList.remove("rag-narrating");
}
