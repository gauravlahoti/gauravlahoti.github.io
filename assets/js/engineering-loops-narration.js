// engineering-loops-narration.js — step-by-step voice narration + captions
//
// Contract: createNarration({ content, ui }) → {
//   mount(controlsEl) → panelEl,
//   playLayer(id, flat, { onStepStart, onDone }),
//   stopLayer(),
//   showAllCaptions(id, flat),
//   unlock(),
//   destroy()
// }
//
// "flat" = refs.steps[id] passed in by the caller — this module never touches buildAll().
// Audio paths: assets/audio/engineering-loops/<layerId>-<NN>.mp3 (1-based, zero-padded).

function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null) continue;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else n.setAttribute(k, v);
    }
    for (const c of kids) { if (c != null) n.append(c.nodeType ? c : document.createTextNode(c)); }
    return n;
}

// Module-relative base for audio files: assets/js/../audio/engineering-loops/
const _audioBase = new URL("../audio/engineering-loops/", import.meta.url).href;
function audioSrc(id, i) {
    return `${_audioBase}${id}-${String(i + 1).padStart(2, "0")}.mp3`;
}

export function createNarration({ content, ui }) {
    // Build narration map: { layerId: [{text},...] }
    const narrMap = {};
    for (const layer of (content.layers || [])) {
        if (layer.narration?.length) narrMap[layer.id] = layer.narration;
    }

    let voiceOn = true;
    let unlocked = false;

    const audioEl = document.createElement("audio");
    audioEl.preload = "none";

    // Running-subtitle line: one caption shows at a time and fades in as narration
    // advances — not the whole script pre-listed and dimmed, which reads like a teleprompter.
    const narrCur = h("p", { class: "loops-narr-cur", "aria-live": "polite" });
    const narrPanel = h("div", { class: "loops-narr" }, narrCur);
    let voiceBtn = null;

    // In-flight playback state
    let curId = null;
    let curFlat = null;
    let curStep = -1;
    let onStepStartCb = null;
    let onDoneCb = null;
    let hideWhenDone = false; // set per-layer; collapses the panel once this layer's narration finishes
    let paused = false;

    // Pausable timers: each tracks its own remaining time so the Pause button can freeze
    // the caption-advance/safety countdown and resume it exactly where it left off (a raw
    // setTimeout would keep counting down while paused and advance the step anyway).
    let timers = [];
    function armTimer(fn, ms) {
        const t = { fn, endAt: Date.now() + ms, remaining: ms, id: null };
        t.id = setTimeout(() => { t.id = null; timers = timers.filter(x => x !== t); fn(); }, ms);
        timers.push(t);
        return t;
    }
    function clearTimers() {
        timers.forEach(t => { if (t.id) clearTimeout(t.id); });
        timers = [];
    }
    function pauseTimers() {
        timers.forEach(t => { if (t.id) { clearTimeout(t.id); t.remaining = Math.max(0, t.endAt - Date.now()); t.id = null; } });
    }
    function resumeTimers() {
        timers.forEach(t => { if (t.id == null) { t.endAt = Date.now() + t.remaining; t.id = setTimeout(() => { t.id = null; timers = timers.filter(x => x !== t); t.fn(); }, t.remaining); } });
    }

    function fallbackDwell() {
        const len = curFlat ? curFlat.length : 7;
        return Math.min(1.3, Math.max(0.85, 7 / len));
    }

    // Swap in caption i as a running subtitle: update the text, retrigger the fade-in.
    function setActive(i) {
        const lines = narrMap[curId] || [];
        const line = lines[i];
        if (line == null) return; // visual step with no matching narration line — keep current text
        narrCur.textContent = line.text || line;
        narrCur.classList.remove("is-in");
        void narrCur.offsetWidth; // force reflow so the enter animation restarts for each line
        narrCur.classList.add("is-in");
    }

    function advanceStep() {
        clearTimers();
        if (curStep < 0 || !curFlat) return;
        const next = curStep + 1;
        if (next >= curFlat.length) {
            audioEl.pause();
            audioEl.currentTime = 0;
            // Reset before callback so a stopLayer() call inside onDone doesn't double-fire
            const cb = onDoneCb;
            const hide = hideWhenDone;
            curId = null; curFlat = null; curStep = -1; onStepStartCb = null; onDoneCb = null; hideWhenDone = false;
            if (cb) cb();
            if (hide) narrPanel.classList.add("is-hidden"); // lab complete: clear the running subtitle
            return;
        }
        playStep(next);
    }

    function playStep(i) {
        curStep = i;
        const lines = narrMap[curId] || [];

        if (onStepStartCb) onStepStartCb(i);
        setActive(i);

        if (i >= lines.length) {
            armTimer(advanceStep, fallbackDwell() * 1000);
            return;
        }

        if (voiceOn && unlocked) {
            audioEl.onended = null;
            audioEl.onerror = null;
            audioEl.src = audioSrc(curId, i);
            audioEl.currentTime = 0;

            armTimer(advanceStep, 12000);

            audioEl.onended = () => { audioEl.onended = null; audioEl.onerror = null; advanceStep(); };
            audioEl.onerror = () => {
                console.warn(`[narration] audio error: ${audioSrc(curId, i)}`);
                audioEl.onended = null; audioEl.onerror = null;
                advanceStep();
            };
            audioEl.play().catch(err => {
                console.warn(`[narration] play() rejected: ${err.message}`);
                audioEl.onended = null; audioEl.onerror = null;
                clearTimers();
                armTimer(advanceStep, fallbackDwell() * 1000);
            });
        } else {
            armTimer(advanceStep, fallbackDwell() * 1000);
        }
    }

    function syncVoiceBtn() {
        if (!voiceBtn) return;
        voiceBtn.textContent = voiceOn ? "🔊" : "🔇";
        voiceBtn.classList.toggle("is-on", voiceOn);
        voiceBtn.setAttribute("aria-label", voiceOn ? (ui.voiceOff || "Mute narration") : (ui.voiceOn || "Narrate"));
        voiceBtn.title = voiceOn ? (ui.voiceOff || "Mute narration") : (ui.voiceOn || "Narrate");
    }

    const api = {
        mount(controlsEl) {
            controlsEl.before(narrPanel);

            voiceBtn = h("button", { class: "loops-btn loops-voice-btn is-on", type: "button", "aria-label": ui.voiceOff || "Mute narration", title: ui.voiceOff || "Mute narration" }, "🔊");
            controlsEl.append(voiceBtn);

            voiceBtn.addEventListener("click", () => {
                voiceOn = !voiceOn;
                syncVoiceBtn();
                if (!voiceOn) {
                    audioEl.pause();
                    clearTimers();
                    // Keep caption position, advance after dwell so captions keep progressing
                    if (curStep >= 0 && !paused) armTimer(advanceStep, fallbackDwell() * 1000);
                } else if (unlocked && curStep >= 0 && curId && !paused) {
                    // Re-enable: restart audio for the current step
                    clearTimers();
                    const i = curStep;
                    audioEl.src = audioSrc(curId, i);
                    audioEl.currentTime = 0;
                    armTimer(advanceStep, 12000);
                    audioEl.onended = () => { audioEl.onended = null; audioEl.onerror = null; advanceStep(); };
                    audioEl.onerror = () => { audioEl.onended = null; audioEl.onerror = null; advanceStep(); };
                    audioEl.play().catch(() => {
                        audioEl.onended = null; audioEl.onerror = null;
                        clearTimers();
                        armTimer(advanceStep, fallbackDwell() * 1000);
                    });
                }
            });

            // Hide button if Audio API is absent (belt-and-suspenders)
            if (typeof Audio === "undefined") voiceBtn.style.display = "none";

            return narrPanel;
        },

        playLayer(id, flat, { onStepStart, onDone, hideOnDone } = {}) {
            this.stopLayer();
            if (!flat?.length) { if (onDone) onDone(); return; }
            const lines = narrMap[id] || [];
            if (!lines.length) { if (onDone) onDone(); return; }

            if (lines.length !== flat.length) {
                console.warn(`[narration] step count mismatch for "${id}": ${lines.length} narration lines vs ${flat.length} visual steps`);
            }

            curId = id;
            curFlat = flat;
            onStepStartCb = onStepStart;
            onDoneCb = onDone;
            hideWhenDone = !!hideOnDone;
            narrPanel.classList.remove("is-hidden"); // re-entry (restart / fresh start / nav) brings the panel back
            // Restore running-subtitle DOM (showAllCaptions may have swapped in a static list) and clear it
            if (narrPanel.firstChild !== narrCur) { narrPanel.replaceChildren(narrCur); }
            narrCur.textContent = "";
            narrCur.classList.remove("is-in");
            playStep(0);
        },

        stopLayer() {
            clearTimers();
            audioEl.pause();
            audioEl.onended = null;
            audioEl.onerror = null;
            try { audioEl.currentTime = 0; } catch {}
            curId = null; curFlat = null; curStep = -1; onStepStartCb = null; onDoneCb = null; hideWhenDone = false;
            paused = false;
        },

        // Global Pause: freeze the current step's audio + caption-advance countdown in place.
        pause() {
            if (paused) return;
            paused = true;
            audioEl.pause();
            pauseTimers();
        },
        resume() {
            if (!paused) return;
            paused = false;
            resumeTimers();
            // resume the current step's audio where it left off (only if it's an audio step)
            if (voiceOn && unlocked && curStep >= 0 && curId && (narrMap[curId] || [])[curStep]) {
                audioEl.play().catch(() => {});
            }
        },

        // Reduced-motion fallback: no audio, no stepping — show every line at once as a
        // static list so all the content stays readable.
        showAllCaptions(id) {
            narrPanel.classList.remove("is-hidden");
            const lines = narrMap[id] || [];
            const ol = h("ol", { class: "loops-narr-list" });
            lines.forEach(l => ol.append(h("li", { class: "loops-narr-line is-active" }, l.text || l)));
            narrPanel.replaceChildren(ol);
        },

        // Collapse the caption panel out of view — used once the guided tour plays
        // all the way through. Any subsequent playLayer()/showAllCaptions() un-hides it.
        hidePanel() {
            narrPanel.classList.add("is-hidden");
        },

        unlock() {
            unlocked = true;
        },

        destroy() {
            this.stopLayer();
            try { audioEl.src = ""; } catch {}
            narrPanel.remove();
            if (voiceBtn) voiceBtn.remove();
        },
    };

    return api;
}
