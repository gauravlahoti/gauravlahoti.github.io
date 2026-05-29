// page-transition.js — "Neural Slash" transition.
//
// Outbound  (index → agents):
//   1. 5 mint scan lines streak right-to-left across the page
//   2. Glowing mint blade sweeps right→left
//   3. Dark overlay fills behind the blade
//   4. Terminal label scrambles centre-screen
//   5. Navigate
//
// Inbound (agents page load):
//   Overlay retracts left, blade retreats, content revealed.

const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SESSION_KEY   = "pf_neural_transition";
const GLYPHS        = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjklmnpqrstuvwxyz0123456789#@!%&";
const SCAN_TOPS     = [9, 27, 47, 67, 86];  // % vertical positions

// ─── Styles (injected once, no external CSS dependency) ─────────────────────

function injectStyles() {
    if (document.getElementById("pf-pt-css")) return;
    const s = document.createElement("style");
    s.id = "pf-pt-css";
    s.textContent = `
.pf-overlay {
    position: fixed; inset: 0; z-index: 9998;
    background: #000000;
    transform: translateX(101%);
    will-change: transform; pointer-events: none;
}
.pf-overlay-inner {
    position: absolute; inset: 0;
    /* Diagonal mint bleed on the left edge */
    background: linear-gradient(to right, rgba(0,255,209,0.18) 0px, rgba(0,255,209,0.04) 6px, transparent 28px);
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
    will-change: transform; pointer-events: none;
}
.pf-scan {
    position: fixed; left: 0; right: 0; height: 1px;
    z-index: 9997;
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
.pf-label {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    font-family: "JetBrains Mono","SF Mono",Menlo,Consolas,monospace;
    font-size: 0.9375rem; letter-spacing: 0.04em;
    color: #888888; opacity: 0; white-space: nowrap;
    display: flex; align-items: center; gap: 0.4em;
    pointer-events: none;
}
.pf-label-cursor {
    display: inline-block; width: 9px; height: 1.1em;
    background: #00FFD1; opacity: 0;
    animation: pf-blink 0.6s step-end infinite;
    vertical-align: text-bottom;
}
@keyframes pf-blink { 50% { opacity: 1 } }
.pf-label-accent { color: #00FFD1; }
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

    const label = document.createElement("div");
    label.className = "pf-label";
    label.innerHTML = `<span class="pf-label-accent">&gt;&nbsp;</span><span class="pf-label-text"></span><span class="pf-label-cursor"></span>`;
    overlay.appendChild(label);
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
    const overlay = document.getElementById("pf-overlay");
    const blade   = document.getElementById("pf-blade");
    const scans   = SCAN_TOPS.map((_, i) => document.getElementById("pf-scan-" + i));
    const label   = overlay?.querySelector(".pf-label");
    const labelTx = overlay?.querySelector(".pf-label-text");
    const cursor  = overlay?.querySelector(".pf-label-cursor");
    return { overlay, blade, scans, label, labelTx, cursor };
}

function teardown() {
    ["pf-overlay", "pf-blade", ...SCAN_TOPS.map((_, i) => "pf-scan-" + i)]
        .forEach(id => document.getElementById(id)?.remove());
}

// ─── Glyph scramble ─────────────────────────────────────────────────────────

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

// ─── Outbound ────────────────────────────────────────────────────────────────

export function runPageTransition(toUrl) {
    const gsap = window.gsap;
    if (!gsap) { window.location.href = toUrl; return; }

    sessionStorage.setItem(SESSION_KEY, "1");
    build();
    const { overlay, blade, scans, label, labelTx, cursor } = query();

    if (REDUCE_MOTION) {
        gsap.set(overlay, { x: "0%", opacity: 1 });
        gsap.to(overlay, { opacity: 1, duration: 0, onComplete: () => { window.location.href = toUrl; } });
        return;
    }

    // Reset
    gsap.set(overlay, { x: "101%" });
    gsap.set(blade,   { x: "101vw" });
    gsap.set(scans,   { x: "-101vw", opacity: 0 });
    gsap.set(label,   { opacity: 0 });
    if (cursor) gsap.set(cursor, { opacity: 0 });

    const tl = gsap.timeline({ onComplete: () => { window.location.href = toUrl; } });

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
    const sweepStart = 0.10;
    const sweepDur   = 0.48;

    tl.to(blade,   { x: "-6px",  duration: sweepDur, ease: "power3.inOut" }, sweepStart);
    tl.to(overlay, { x: "0%",   duration: sweepDur + 0.02, ease: "power3.inOut" }, sweepStart + 0.012);

    // ── Phase 3: terminal label appears ──
    tl.to(label, { opacity: 1, duration: 0.14, ease: "power2.out" }, sweepStart + sweepDur * 0.62);
    tl.add(() => {
        if (cursor) gsap.to(cursor, { opacity: 1, duration: 0 });
        scramble(labelTx, "agents.sys init", 280);
    }, sweepStart + sweepDur * 0.62);

    // ── Hold briefly then navigate (handled by onComplete above) ──
    tl.to({}, { duration: 0.10 });
}

// ─── BFCache cleanup ─────────────────────────────────────────────────────────
// When the browser restores a page from its back/forward cache the overlay
// left by runPageTransition() is still in the DOM, fully covering the screen.
// Tear it down immediately so the user sees the actual page content.
window.addEventListener("pageshow", e => { if (e.persisted) teardown(); });

// ─── Inbound ─────────────────────────────────────────────────────────────────

export function playEntranceWipe() {
    if (!sessionStorage.getItem(SESSION_KEY)) return;
    sessionStorage.removeItem(SESSION_KEY);

    injectStyles();
    build();

    const gsap = window.gsap;
    if (!gsap) { teardown(); return; }

    const { overlay, blade, scans, label } = query();

    // Start positions: fully covering the viewport
    gsap.set(overlay, { x: "0%", opacity: 1 });
    gsap.set(blade,   { x: "-4px" });
    gsap.set(scans,   { opacity: 0 });
    if (label) gsap.set(label, { opacity: 0 });

    if (REDUCE_MOTION) {
        gsap.to(overlay, { opacity: 0, duration: 0.15, onComplete: teardown });
        return;
    }

    const tl = gsap.timeline({ delay: 0.06, onComplete: teardown });

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
