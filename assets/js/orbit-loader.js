// orbit-loader.js — the page-transition loading glyph.
//
// A constant animation: three rings tilted on independent axes (models,
// agents, tools) orbiting a core, reading as a slowly rotating sphere. It
// never depends on where the visitor came from or where they are going, so
// adding a new lab never requires touching this file — the earlier
// route-aware design (a node graph of the site) was rejected for exactly
// this reason: every new page would have meant editing a node map, an
// adjacency list and layout coordinates. This has none of that.
//
// The inbound page resumes the outbound page's orbit (see the `spin` option
// and page-transition.js's payload.orbitAt) rather than starting a new one.
//
// Motion runs on the compositor. The orbiting glyphs and the core's pulse
// are HTML layers driven by Web Animations (transform + opacity only, each
// orbit precomputed as keyframes), not a requestAnimationFrame loop writing
// SVG attributes. The rAF version had two costs a trace made visible: every
// frame re-painted the page layer the orbit sat in, and — worse — the
// glyphs could only move when the main thread was free, so they visibly
// froze each time the incoming page's own scripts ran (it's booting
// underneath the loader, so it is never free for long). Compositor
// animations keep playing through that. Only the static art (ring outlines,
// the core halo) stays in SVG.
//
// Standalone chrome like page-transition.js: hardcodes its colour values
// (mirroring --accent / --axis-cloud / --axis-biz) rather than referencing
// CSS custom properties, since this module has no guarantee base.css has
// loaded before it runs.

const ACCENT = "#00FFD1";   // models   — mirrors --accent
const CLOUD  = "#6FB1FF";   // agents   — mirrors --axis-cloud
const BIZ    = "#C7A6FF";   // tools    — mirrors --axis-biz

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
};

// Counts and speeds are deliberately not simple multiples of one another so
// the composition never visibly repeats on a short loop.
const RINGS = [
    { id: "models", r: 42, count: 2, speed:  0.95, colour: ACCENT, shape: "diamond", tilt: -22 },
    { id: "agents", r: 68, count: 3, speed: -0.62, colour: CLOUD,  shape: "hex",     tilt:  16 },
    { id: "tools",  r: 94, count: 4, speed:  0.41, colour: BIZ,    shape: "square",  tilt: -38 },
];

const CX = 120, CY = 120;          // viewBox units; the stage is 240×240
const DEG = Math.PI / 180;
const ORBIT_STEPS = 72;            // keyframes per revolution (5°; sub-pixel chord error)
const PULSE_MS = 2 * Math.PI * 420; // core pulse period: the old sin(now / 420)
const PULSE_STEPS = 24;
const GLYPH_BOX = 14;              // px box each glyph is drawn centred in

function glyph(shape, colour) {
    const svg = svgEl("svg", { width: GLYPH_BOX, height: GLYPH_BOX, viewBox: `${-GLYPH_BOX / 2} ${-GLYPH_BOX / 2} ${GLYPH_BOX} ${GLYPH_BOX}`, overflow: "visible" });
    if (shape === "diamond") {
        svg.appendChild(svgEl("path", { d: "M 0,-5 L 5,0 L 0,5 L -5,0 Z", fill: colour }));
    } else if (shape === "hex") {
        svg.appendChild(svgEl("path", {
            d: "M 5.2,0 L 2.6,4.5 L -2.6,4.5 L -5.2,0 L -2.6,-4.5 L 2.6,-4.5 Z",
            fill: "none", stroke: colour, "stroke-width": 1.5,
        }));
        svg.appendChild(svgEl("circle", { r: 1.6, fill: colour }));
    } else {
        svg.appendChild(svgEl("rect", { x: -4.2, y: -4.2, width: 8.4, height: 8.4, rx: 1.6, fill: "none", stroke: colour, "stroke-width": 1.5 }));
        svg.appendChild(svgEl("circle", { r: 1.4, fill: colour }));
    }
    return svg;
}

// Where a body sits at orbit angle `deg`: same maths as the old per-frame
// place(), just evaluated once per keyframe.
function bodyFrame(ring, deg) {
    const a = deg * DEG;
    let x = Math.cos(a) * ring.r;
    let y = Math.sin(a) * ring.r * 0.42;
    const tr = ring.tilt * DEG;
    const xp = x * Math.cos(tr) - y * Math.sin(tr);
    const yp = x * Math.sin(tr) + y * Math.cos(tr);
    // depth fake: near half is bright/large, far half dims and shrinks —
    // this is what sells the "rotating sphere" read.
    const depth = (Math.sin(a) + 1) / 2;
    const scale = 0.72 + 0.42 * depth;
    const opacity = 0.42 + 0.58 * depth;
    return {
        transform: `translate(${xp.toFixed(2)}px, ${yp.toFixed(2)}px) scale(${scale.toFixed(3)})`,
        opacity: +opacity.toFixed(3),
    };
}

function injectStyles() {
    if (document.getElementById("pf-ol-css")) return;
    const s = document.createElement("style");
    s.id = "pf-ol-css";
    s.textContent = `
/* Own layer, so the label's scramble re-paints only this box, not the
   full-screen overlay behind it. */
.pf-ol-wrap { display: flex; flex-direction: column; align-items: center; gap: 18px; will-change: transform; }
.pf-ol-stage { position: relative; width: 100%; max-width: 280px; aspect-ratio: 1 / 1; }
.pf-ol-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.pf-ol-layer { position: absolute; left: 0; top: 0; width: 240px; height: 240px; transform-origin: 0 0; }
.pf-ol-conv { position: absolute; inset: 0; transform-origin: ${CX}px ${CY}px; }
.pf-ol-body, .pf-ol-core-ring, .pf-ol-core-dot, .pf-ol-core-dot-in {
    position: absolute; will-change: transform, opacity;
}
.pf-ol-body { left: ${CX - GLYPH_BOX / 2}px; top: ${CY - GLYPH_BOX / 2}px; width: ${GLYPH_BOX}px; height: ${GLYPH_BOX}px; }
.pf-ol-body > svg { display: block; }
/* r=9 circle, stroke 1.3 centred on the path: 19.3 outer, bordered. */
.pf-ol-core-ring {
    left: ${CX - 9.65}px; top: ${CY - 9.65}px; width: 19.3px; height: 19.3px;
    box-sizing: border-box; border: 1.3px solid rgba(0,255,209,0.75); border-radius: 50%;
}
.pf-ol-core-dot { left: ${CX - 3.2}px; top: ${CY - 3.2}px; width: 6.4px; height: 6.4px; }
.pf-ol-core-dot-in { inset: 0; border-radius: 50%; background: ${ACCENT}; }
.pf-ol-label {
    font-family: "JetBrains Mono","SF Mono",Menlo,Consolas,monospace;
    font-size: 0.9375rem; letter-spacing: 0.04em;
    color: #888888; display: flex; align-items: center; gap: 0.4em; white-space: nowrap;
}
.pf-ol-label-accent { color: #00FFD1; }
`;
    document.head.appendChild(s);
}

function el(className) {
    const n = document.createElement("div");
    n.className = className;
    return n;
}

/**
 * Mount a constant orbit loader into `container`.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {boolean} [opts.reduced] - prefers-reduced-motion: render static, no animation.
 * @param {number}  [opts.speed]   - global rate multiplier.
 * @param {string}  [opts.label]   - destination path shown under the orbit.
 * @param {(el:HTMLElement, finalText:string, durationMs:number)=>void} [opts.scramble]
 *        - glyph-scramble text effect, passed in from page-transition.js to
 *          avoid a circular import (that module imports this one).
 * @param {number}  [opts.spin]    - starting rotation, in seconds of spin. Lets
 *          the inbound page resume the outbound page's orbit where it would
 *          be by now, instead of every glyph snapping back to its start angle.
 * @returns {{ el:HTMLElement, start:()=>void, setRate:(r:number)=>void, land:()=>Promise<void>, destroy:()=>void }}
 */
export function mountOrbitLoader(container, opts = {}) {
    const { reduced: reducedOpt = false, speed = 1, label: labelText = "", scramble = null, spin: startSpin = 0 } = opts;

    injectStyles();

    const wrap = document.createElement("div");
    wrap.className = "pf-ol-wrap";
    wrap.setAttribute("aria-hidden", "true");
    // Without Web Animations there's nothing to drive the motion: show the
    // static composition, exactly as reduced motion does.
    const reduced = reducedOpt || typeof wrap.animate !== "function";

    const stage = el("pf-ol-stage");
    const svg = svgEl("svg", { viewBox: "0 0 240 240", class: "pf-ol-svg" });

    // Static art: orbit paths (tilted per ring) and the core halo.
    RINGS.forEach(ring => {
        svg.appendChild(svgEl("ellipse", {
            cx: CX, cy: CY, rx: ring.r, ry: ring.r * 0.42,
            fill: "none", stroke: ring.colour, "stroke-opacity": 0.13, "stroke-width": 1,
            transform: `rotate(${ring.tilt} ${CX} ${CY})`,
        }));
    });
    const coreHalo = svgEl("circle", { cx: CX, cy: CY, r: 13, fill: ACCENT, "fill-opacity": 0.10 });
    svg.appendChild(coreHalo);
    stage.appendChild(svg);

    // Animated layer, in the same 240×240 space, scaled to the stage below.
    // Core first, bodies after: the bodies paint over the core, as before.
    const layer = el("pf-ol-layer");
    const coreRing = el("pf-ol-core-ring");
    const coreDot = el("pf-ol-core-dot");       // outer: the landing pulse
    const coreDotIn = el("pf-ol-core-dot-in");  // inner: the idle pulse
    coreDot.appendChild(coreDotIn);
    const conv = el("pf-ol-conv");               // the landing's pull-in
    layer.append(coreRing, coreDot, conv);

    const bodies = [];
    RINGS.forEach(ring => {
        for (let i = 0; i < ring.count; i++) {
            const node = el("pf-ol-body");
            node.appendChild(glyph(ring.shape, ring.colour));
            conv.appendChild(node);
            bodies.push({ ring, phase: (i / ring.count) * 360, node });
        }
    });
    stage.appendChild(layer);
    wrap.appendChild(stage);

    const label = document.createElement("div");
    label.className = "pf-ol-label";
    label.innerHTML = `<span class="pf-ol-label-accent">&gt;&nbsp;</span><span class="pf-ol-label-text"></span>`;
    const labelTx = label.querySelector(".pf-ol-label-text");
    wrap.appendChild(label);
    if (scramble && !reduced) scramble(labelTx, labelText, 320);
    else labelTx.textContent = labelText;

    container.appendChild(wrap);

    // Fit the 240-unit layer to the stage, as the SVG viewBox does for itself.
    const fit = () => {
        const w = stage.getBoundingClientRect().width || 280;
        layer.style.transform = `scale(${(w / 240).toFixed(4)})`;
    };
    fit();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    ro?.observe(stage);

    // ── animation state ──
    let orbitAnims = [];
    let pulseAnims = [];
    let rate = 1, landing = false;

    function startOrbits() {
        orbitAnims = bodies.map(({ ring, phase, node }) => {
            const dir = Math.sign(ring.speed);
            const frames = [];
            for (let i = 0; i <= ORBIT_STEPS; i++) {
                frames.push({ ...bodyFrame(ring, phase + dir * 360 * (i / ORBIT_STEPS)), offset: i / ORBIT_STEPS });
            }
            // One revolution takes 360° / (|speed| · 60°/s), as the rAF loop had it.
            const periodMs = (360 / (Math.abs(ring.speed) * 60)) * 1000;
            const turns = (startSpin * Math.abs(ring.speed) * 60) / 360;
            const anim = node.animate(frames, {
                duration: periodMs, iterations: Infinity, easing: "linear",
                iterationStart: turns - Math.floor(turns),
            });
            anim.playbackRate = rate * speed;
            return anim;
        });
    }

    function startPulse() {
        const ringFrames = [], dotFrames = [];
        for (let i = 0; i <= PULSE_STEPS; i++) {
            const b = 1 + Math.sin((i / PULSE_STEPS) * 2 * Math.PI) * 0.10;
            ringFrames.push({ transform: `scale(${b.toFixed(4)})` });
            dotFrames.push({ transform: `scale(${(2 - b).toFixed(4)})` });
        }
        const o = { duration: PULSE_MS, iterations: Infinity, easing: "linear" };
        pulseAnims = [coreRing.animate(ringFrames, o), coreDotIn.animate(dotFrames, o)];
    }

    function renderStatic() {
        // The old reduced-motion frame: every body at spin 0.35.
        bodies.forEach(({ ring, phase, node }) => {
            const f = bodyFrame(ring, phase + 0.35 * ring.speed * 60);
            node.style.transform = f.transform;
            node.style.opacity = String(f.opacity);
        });
    }

    return {
        el: wrap,
        start() {
            if (reduced) { renderStatic(); return; }
            if (orbitAnims.length) return;
            startOrbits();
            startPulse();
        },
        setRate(r) {
            rate = r;
            orbitAnims.forEach(a => { a.playbackRate = rate * speed; });
        },
        /** Spin up briefly, pull the rings into the core, flare, resolve. */
        land() {
            return new Promise(resolve => {
                if (reduced) {
                    coreHalo.setAttribute("r", "20");
                    coreHalo.setAttribute("fill-opacity", "0");
                    resolve();
                    return;
                }
                if (landing) { resolve(); return; }
                landing = true;

                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    conv.style.opacity = "0";
                    coreHalo.setAttribute("r", "34");
                    coreHalo.setAttribute("fill-opacity", "0");
                    labelTx.style.color = ACCENT;
                    resolve();
                };

                // Animations can be starved while the tab is hidden — a
                // visitor who alt-tabs right after clicking would otherwise
                // strand the transition here, since `finished` might never
                // settle. A bounded fallback guarantees landing regardless;
                // the `done` guard means whichever path gets there first is
                // the one that finalizes state.
                const fallback = setTimeout(finish, 1200);

                // Spin up. Main-thread tween of the playback rate only; the
                // motion itself stays on the compositor.
                const st = { rate };
                window.gsap?.to(st, {
                    rate: 2.8, duration: 0.24, ease: "power2.in",
                    onUpdate: () => { rate = st.rate; orbitAnims.forEach(a => { a.playbackRate = rate * speed; }); },
                });

                // Pull the rings into the core: power3.in over 0.34s, 0.14s in.
                // On each body's independent `scale` property rather than on
                // their shared container: scale applies about the body's
                // origin, which sits on the core, so it draws the position in
                // and shrinks the glyph together, like the old converge. It
                // also composites alongside the orbit's own `transform`
                // animation, where animating the (empty) container measured
                // as not compositable.
                const pulls = bodies.map(({ node }) => node.animate(
                    [{ scale: "1" }, { scale: "0" }],
                    { duration: 340, delay: 140, easing: "cubic-bezier(0.895, 0.03, 0.685, 0.22)", fill: "forwards" },
                ));
                Promise.all(pulls.map(p => p.finished)).then(() => {
                    clearTimeout(fallback);
                    if (done) return;
                    done = true;
                    conv.style.opacity = "0";
                    window.gsap?.fromTo(coreHalo, { attr: { r: 10 }, "fill-opacity": 0.55 },
                        { attr: { r: 34 }, "fill-opacity": 0, duration: 0.42, ease: "power2.out" });
                    // r 3.2 → 6.5 and back, as the old yoyo tween.
                    coreDot.animate(
                        [{ transform: "scale(1)" }, { transform: "scale(2.03)" }, { transform: "scale(1)" }],
                        { duration: 320, easing: "ease-out" },
                    );
                    window.gsap?.to(labelTx, { color: ACCENT, duration: 0.2 });
                    setTimeout(resolve, 170);
                }).catch(() => finish()); // cancelled (destroy mid-landing)
            });
        },
        destroy() {
            orbitAnims.forEach(a => a.cancel());
            pulseAnims.forEach(a => a.cancel());
            orbitAnims = []; pulseAnims = [];
            ro?.disconnect();
            window.gsap?.killTweensOf(labelTx);
            window.gsap?.killTweensOf(coreHalo);
            wrap.remove();
        },
    };
}
