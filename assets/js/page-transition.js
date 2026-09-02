// page-transition.js — "Neural Slash" transition + the orbit loader.
//
// Outbound  (index → agents, or any data-page-link):
//   1. 5 mint scan lines streak right-to-left across the page
//   2. Glowing mint blade sweeps right→left, dark overlay fills behind it
//   3. The orbit loader (orbit-loader.js) fades in, spinning
//   4. Navigate — the orbit's own visible state carries no route info, so
//      the incoming page can simply mount a fresh one and look continuous
//
// Inbound (new page load):
//   The orbit keeps spinning until the incoming page signals it is ready
//   (or a hard cap elapses), then it lands — spins up, converges into the
//   core, flares — and the overlay retracts, blade retreats, content
//   revealed.
//
// Load-aware timing: navigation commits fast (~350ms into the outbound
// sweep) rather than waiting out a fixed beat. The incoming page holds the
// orbit until it has actually painted (see signalPageReady()), with a
// floor so a fast page can't strobe and a hard cap so a broken page can't
// hang forever.

const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SESSION_KEY   = "pf_neural_transition";
const STALE_MS       = 8000;   // matches transition-guard.js's own check
const GLYPHS        = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjklmnpqrstuvwxyz0123456789#@!%&";
const SCAN_TOPS     = [9, 27, 47, 67, 86];  // % vertical positions

// Loading orbit-loader.js as soon as this module is evaluated — whether via
// an eager <script type="module"> import or a lazy dynamic import() from
// main.js — so it has already resolved by the time the outbound sweep
// needs to mount it (~240ms in) or the inbound page needs it immediately.
const _selfV = new URL(import.meta.url).searchParams.get("v") || "";
const _vq = (path) => _selfV ? `${path}?v=${_selfV}` : path;
const loaderModPromise = import(_vq("./orbit-loader.js"));

// ─── Readiness signal ─────────────────────────────────────────────────────
// Each bootstrap calls signalPageReady() once its content is actually
// painted (not just DOMContentLoaded — every lab awaits a content fetch and
// a viz module import before writing anything to its root). This module
// races that signal against `window.load` and a hard cap, so a forgotten
// call degrades to "wait for load, or 2.5s, whichever first" rather than
// hanging the transition.

let _readyResolve = null;
const _readyPromise = new Promise(resolve => { _readyResolve = resolve; });

export function signalPageReady() {
    if (_readyResolve) { _readyResolve(); _readyResolve = null; }
}

function waitForLoad() {
    if (document.readyState === "complete") return Promise.resolve();
    return new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
}

function hardCap(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// rAF is fully suspended while the tab is hidden (measured: a backgrounded
// tab renders zero frames), so a bare double-rAF can never resolve if the
// visitor's tab loses focus at exactly this moment — e.g. they alt-tab away
// right after clicking. Race it against a short timer so a hidden tab still
// lands the transition instead of hanging on the paint-confirmation step
// forever, one setTimeout doesn't need visibility to fire.
function doubleRaf() {
    return Promise.race([
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        hardCap(400),
    ]);
}

// ─── sessionStorage payload ───────────────────────────────────────────────
// Kept under the original key so a mixed-version window (a visitor with an
// old cached copy of this file navigating into a freshly deployed page, or
// vice versa) degrades to a plain wipe instead of erroring. The value is
// now JSON: { v, toPath, leftAt, reduced }. leftAt is Date.now(), not
// performance.now() — the two documents have different time origins.

function writePayload(payload) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload)); }
    catch (_) { /* storage unavailable (private mode, quota) — degrade silently */ }
}

function readPayload() {
    let raw;
    try { raw = sessionStorage.getItem(SESSION_KEY); }
    catch (_) { return null; }
    if (!raw) return null;

    let payload;
    try { payload = JSON.parse(raw); }
    catch (_) { return null; }   // legacy "1" or corrupt value → plain wipe

    if (!payload || payload.v !== 2) return null;
    if (typeof payload.leftAt !== "number" || Date.now() - payload.leftAt > STALE_MS) return null;
    return payload;
}

function clearPayload() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) { /* ignore */ }
}

// ─── Styles (injected once, no external CSS dependency) ─────────────────────

function injectStyles() {
    if (document.getElementById("pf-pt-css")) return;
    const s = document.createElement("style");
    s.id = "pf-pt-css";
    s.textContent = `
/* Explicit visibility:visible on every element this module appends to
   <body> — transition-guard.js sets body { visibility: hidden } while a
   transition is inbound (to hold the page black until playEntranceWipe()
   takes over), and visibility inherits by default. Without an explicit
   override here, the overlay/blade/scans/orbit loader would inherit
   "hidden" from body too and never render, leaving the visitor looking at
   a black <html> background with nothing on it. */
.pf-overlay {
    position: fixed; inset: 0; z-index: 9998;
    background: #000000;
    transform: translateX(101%);
    visibility: visible;
    will-change: transform; pointer-events: none;
}
.pf-overlay-inner {
    position: absolute; inset: 0;
    /* Diagonal mint bleed on the left edge */
    background: linear-gradient(to right, rgba(0,255,209,0.18) 0px, rgba(0,255,209,0.04) 6px, transparent 28px);
}
.pf-orbit-slot {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 340px; text-align: center;
    pointer-events: none;
}
.pf-blade {
    position: fixed; top: -4%; left: -4px;
    width: 4px; height: 108%;
    z-index: 9999;
    background: #00FFD1;
    box-shadow:
        0 0 0   2px rgba(0,255,209,0.90),
        0 0 16px 5px rgba(0,255,209,0.80),
        0 0 40px 14px rgba(0,255,209,0.40),
        0 0 80px 28px rgba(0,255,209,0.15);
    transform: translateX(101vw) rotate(1.8deg);
    transform-origin: top center;
    visibility: visible;
    will-change: transform; pointer-events: none;
}
.pf-scan {
    position: fixed; left: 0; right: 0; height: 1px;
    z-index: 9997;
    visibility: visible;
    background: linear-gradient(90deg,
        transparent 0%,
        rgba(0,255,209,0.0)  5%,
        rgba(0,255,209,0.85) 35%,
        rgba(0,255,209,0.85) 65%,
        rgba(0,255,209,0.0)  95%,
        transparent 100%);
    opacity: 0; transform: translateX(-101vw);
    will-change: transform, opacity; pointer-events: none;
}
`;
    document.head.appendChild(s);
}

// ─── DOM construction ────────────────────────────────────────────────────────

function build() {
    injectStyles();
    if (document.getElementById("pf-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "pf-overlay";
    overlay.className = "pf-overlay";
    overlay.setAttribute("aria-hidden", "true");

    const inner = document.createElement("div");
    inner.className = "pf-overlay-inner";
    overlay.appendChild(inner);

    const slot = document.createElement("div");
    slot.id = "pf-orbit-slot";
    slot.className = "pf-orbit-slot";
    overlay.appendChild(slot);
    document.body.appendChild(overlay);

    const blade = document.createElement("div");
    blade.id = "pf-blade";
    blade.className = "pf-blade";
    blade.setAttribute("aria-hidden", "true");
    document.body.appendChild(blade);

    SCAN_TOPS.forEach((top, i) => {
        const scan = document.createElement("div");
        scan.className = "pf-scan";
        scan.style.top = top + "%";
        scan.id = "pf-scan-" + i;
        document.body.appendChild(scan);
    });
}

function query() {
    const overlay   = document.getElementById("pf-overlay");
    const blade     = document.getElementById("pf-blade");
    const scans     = SCAN_TOPS.map((_, i) => document.getElementById("pf-scan-" + i));
    const orbitSlot = document.getElementById("pf-orbit-slot");
    return { overlay, blade, scans, orbitSlot };
}

// Tracks the live orbit-loader instance so bfcache restores and repeated
// calls can cancel its rAF loop rather than leaking it.
let currentLoader = null;

function teardown() {
    if (currentLoader) { currentLoader.destroy(); currentLoader = null; }
    ["pf-overlay", "pf-blade", ...SCAN_TOPS.map((_, i) => "pf-scan-" + i)]
        .forEach(id => document.getElementById(id)?.remove());
    // Hand back to transition-guard.js's markers immediately on a normal
    // completion, rather than waiting on its own 6s CSS self-destruct.
    document.documentElement.classList.remove("pf-inbound");
    document.getElementById("pf-guard-css")?.remove();
}

// ─── Glyph scramble ─────────────────────────────────────────────────────────
// Passed into orbit-loader.js rather than imported the other way, since
// page-transition.js imports orbit-loader.js and a back-import would cycle.

function scramble(el, finalText, durationMs) {
    if (!el || REDUCE_MOTION) { if (el) el.textContent = finalText; return; }
    const chars = finalText.split("");
    let f = 0;
    const total = Math.round(durationMs / 1000 * 60);
    const tick = () => {
        const locked = Math.floor(Math.min(f / (total * 0.72), 1) * chars.length);
        el.textContent = chars.map((c, i) =>
            i < locked ? c : (c === " " ? " " : GLYPHS[Math.floor(Math.random() * GLYPHS.length)])
        ).join("");
        f++;
        if (f <= total) requestAnimationFrame(tick);
        else el.textContent = finalText;
    };
    requestAnimationFrame(tick);
}

function toPathOf(url) {
    try { return new URL(url, window.location.href).pathname; }
    catch (_) { return String(url); }
}

// ─── Outbound ────────────────────────────────────────────────────────────────

export function runPageTransition(toUrl) {
    const gsap = window.gsap;
    if (!gsap) { window.location.href = toUrl; return; }

    const toPath = toPathOf(toUrl);
    const payload = { v: 2, toPath, leftAt: Date.now(), reduced: REDUCE_MOTION };
    writePayload(payload);

    build();
    const { overlay, blade, scans, orbitSlot } = query();

    let navigated = false;
    function commitNavigation() {
        if (navigated) return;
        navigated = true;
        payload.leftAt = Date.now();
        writePayload(payload);
        try { window.location.href = toUrl; }
        catch (_) { window.location.assign(toUrl); }
    }
    // Backstop: if the GSAP ticker is starved (e.g. the tab is backgrounded
    // right after the click — rAF/ticker-driven work pauses in a hidden
    // tab), navigate anyway rather than leaving the visitor stuck on the
    // overlay. setTimeout still fires in a background tab.
    const backstop = setTimeout(commitNavigation, 900);

    if (REDUCE_MOTION) {
        gsap.set(overlay, { x: "0%", opacity: 1 });
        loaderModPromise.then(mod => {
            if (navigated) return;
            const loader = mod.mountOrbitLoader(orbitSlot, { reduced: true, label: toPath });
            loader.start();
            currentLoader = loader;
        }).catch(() => {});
        setTimeout(commitNavigation, 150);
        return;
    }

    // Reset
    gsap.set(overlay, { x: "101%" });
    gsap.set(blade,   { x: "101vw" });
    gsap.set(scans,   { x: "-101vw", opacity: 0 });

    const SWEEP_START   = 0.04;
    const BLADE_DUR     = 0.28;
    const OVERLAY_START = 0.05;
    const OVERLAY_DUR   = 0.30;
    const LOADER_IN_AT  = OVERLAY_START + OVERLAY_DUR * 0.62;
    const COVER_AT      = 0.35;

    const tl = gsap.timeline();

    // ── Phase 1: scan lines streak left→right, fading in/out ──
    scans.forEach((scan, i) => {
        if (!scan) return;
        const sub = gsap.timeline({ delay: i * 0.048 });
        sub.fromTo(scan, { x: "-101vw", opacity: 0 },
            { x: "-60vw", opacity: 0.9, duration: 0.06, ease: "none" });
        sub.to(scan, { x: "60vw",  opacity: 0.9, duration: 0.16, ease: "none" });
        sub.to(scan, { x: "101vw", opacity: 0,   duration: 0.06, ease: "none" });
    });

    // ── Phase 2: blade cuts across, overlay fills behind it ──
    tl.to(blade,   { x: "-6px", duration: BLADE_DUR,   ease: "power3.inOut" }, SWEEP_START);
    tl.to(overlay, { x: "0%",   duration: OVERLAY_DUR, ease: "power3.inOut" }, OVERLAY_START);

    // ── Phase 3: orbit loader fades in ──
    tl.add(() => {
        loaderModPromise.then(mod => {
            if (navigated) return; // the page may already be gone
            const loader = mod.mountOrbitLoader(orbitSlot, { label: toPath, scramble });
            loader.start();
            currentLoader = loader;
            gsap.fromTo(loader.el, { opacity: 0 }, { opacity: 1, duration: 0.14 });
        }).catch(() => {});
    }, LOADER_IN_AT);

    // ── Navigate as soon as the cover reads as complete, not on a fixed
    //    beat — the loader keeps the transition feeling alive after this ──
    tl.call(() => { clearTimeout(backstop); commitNavigation(); }, null, COVER_AT);
}

// ─── BFCache cleanup ─────────────────────────────────────────────────────────
// When the browser restores a page from its back/forward cache the overlay
// left by runPageTransition() is still in the DOM, fully covering the
// screen, and any orbit-loader rAF loop is still registered. Tear both down
// immediately so the user sees the actual page content and no stray rAF
// keeps ticking on a frozen page.
window.addEventListener("pageshow", e => { if (e.persisted) teardown(); });
window.addEventListener("pagehide", e => { if (e.persisted && currentLoader) { currentLoader.destroy(); currentLoader = null; } });

// ─── Inbound ─────────────────────────────────────────────────────────────────

export async function playEntranceWipe() {
    const payload = readPayload();
    clearPayload();
    if (!payload) return;   // no transition in flight, or a stale/legacy one

    injectStyles();
    build();
    const { overlay, blade, scans, orbitSlot } = query();

    const gsap = window.gsap;
    if (!gsap) { teardown(); return; }

    let loaderMod;
    try { loaderMod = await loaderModPromise; }
    catch (_) { teardown(); return; }

    if (payload.reduced || REDUCE_MOTION) {
        gsap.set(overlay, { x: "0%", opacity: 1 });
        const loader = loaderMod.mountOrbitLoader(orbitSlot, { reduced: true, label: payload.toPath });
        loader.start();
        currentLoader = loader;

        const ready = Promise.race([_readyPromise, waitForLoad(), hardCap(2500)]);
        const minHold = hardCap(300);
        await Promise.all([ready, minHold]);

        await loader.land();
        loader.destroy();
        currentLoader = null;
        // teardown() is idempotent (removing already-removed nodes/classes
        // is a no-op), so a plain setTimeout backstop alongside GSAP's own
        // onComplete is enough here — no "done" guard needed. Same
        // rationale as elsewhere: GSAP's ticker is rAF-driven and can be
        // suspended indefinitely by a hidden tab.
        setTimeout(teardown, 600);
        gsap.to(overlay, { opacity: 0, duration: 0.15, onComplete: teardown });
        return;
    }

    // Start positions: fully covering the viewport
    gsap.set(overlay, { x: "0%", opacity: 1 });
    gsap.set(blade,   { x: "-4px" });
    gsap.set(scans,   { opacity: 0 });

    const loader = loaderMod.mountOrbitLoader(orbitSlot, { label: payload.toPath, scramble });
    loader.start();
    currentLoader = loader;
    gsap.fromTo(loader.el, { opacity: 0 }, { opacity: 1, duration: 0.14 });

    const ready = Promise.race([_readyPromise, waitForLoad(), hardCap(2500)]).then(doubleRaf);
    const minHold = hardCap(350);
    await Promise.all([ready, minHold]);

    await loader.land();
    loader.destroy();
    currentLoader = null;

    // Backstop alongside the timeline's own onComplete — see the identical
    // comment on the reduced-motion branch above. teardown() is idempotent.
    setTimeout(teardown, 900);
    const tl = gsap.timeline({ delay: 0.02, onComplete: teardown });

    // Blade retreats to the right
    tl.to(blade,   { x: "101vw", duration: 0.42, ease: "power3.inOut" }, 0);
    // Overlay sweeps off to the right (same direction as blade)
    tl.to(overlay, { x: "101%",  duration: 0.44, ease: "power3.inOut" }, 0.01);

    // Scan lines flash in reverse direction (right→left) as overlay retreats
    scans.forEach((scan, i) => {
        if (!scan) return;
        const sub = gsap.timeline({ delay: i * 0.04 });
        sub.fromTo(scan, { x: "101vw", opacity: 0 },
            { x: "60vw",   opacity: 0.55, duration: 0.05, ease: "none" });
        sub.to(scan, { x: "-50vw", opacity: 0.55, duration: 0.12, ease: "none" });
        sub.to(scan, { x: "-101vw", opacity: 0,   duration: 0.05, ease: "none" });
    });
}
