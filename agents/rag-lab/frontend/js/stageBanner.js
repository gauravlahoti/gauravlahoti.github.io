/** Prominent step-by-step narration banner for the demo. */
import { narrate, hideNarrator } from "./narrator.js";

const banner = document.getElementById("stage-banner");
const chip  = document.getElementById("stage-chip");
const title = document.getElementById("stage-title");
const desc  = document.getElementById("stage-desc");

/**
 * @param {string} chipText  e.g. "STEP 1/4", "DONE", "READY"
 * @param {string} titleText
 * @param {string} descText
 * @param {"active"|"done"|"idle"} [tone]
 */
export function setStage(chipText, titleText, descText, tone = "active") {
  banner.style.display = "flex";
  chip.textContent = chipText;
  chip.className = "stage-chip" + (tone === "done" ? " done" : tone === "idle" ? " idle" : "");
  title.textContent = titleText;
  desc.textContent = descText;
  narrate(chipText, titleText, descText, tone);
}

/** Hide the banner entirely (e.g. at rest, before a run). */
export function hideStage() {
  banner.style.display = "none";
  hideNarrator();
}
