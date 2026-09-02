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
// Being rotationally symmetric also means there is nothing to carry across
// a hard navigation: the incoming page mounts a fresh orbit and no visitor
// can tell it did not continue the outgoing one.
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

const CX = 120, CY = 120;
const DEG = Math.PI / 180;

function glyph(shape, colour) {
    const g = svgEl("g", {});
    if (shape === "diamond") {
        g.appendChild(svgEl("path", { d: "M 0,-5 L 5,0 L 0,5 L -5,0 Z", fill: colour }));
    } else if (shape === "hex") {
        g.appendChild(svgEl("path", {
            d: "M 5.2,0 L 2.6,4.5 L -2.6,4.5 L -5.2,0 L -2.6,-4.5 L 2.6,-4.5 Z",
            fill: "none", stroke: colour, "stroke-width": 1.5,
        }));
        g.appendChild(svgEl("circle", { r: 1.6, fill: colour }));
    } else {
        g.appendChild(svgEl("rect", { x: -4.2, y: -4.2, width: 8.4, height: 8.4, rx: 1.6, fill: "none", stroke: colour, "stroke-width": 1.5 }));
        g.appendChild(svgEl("circle", { r: 1.4, fill: colour }));
    }
    return g;
}

function injectStyles() {
    if (document.getElementById("pf-ol-css")) return;
    const s = document.createElement("style");
    s.id = "pf-ol-css";
    s.textContent = `
.pf-ol-wrap { display: flex; flex-direction: column; align-items: center; gap: 18px; }
.pf-ol-svg { max-width: 280px; width: 100%; overflow: visible; }
.pf-ol-label {
    font-family: "JetBrains Mono","SF Mono",Menlo,Consolas,monospace;
    font-size: 0.9375rem; letter-spacing: 0.04em;
    color: #888888; display: flex; align-items: center; gap: 0.4em; white-space: nowrap;
}
.pf-ol-label-accent { color: #00FFD1; }
`;
    document.head.appendChild(s);
}

/**
 * Mount a constant orbit loader into `container`.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {boolean} [opts.reduced] - prefers-reduced-motion: render static, no rAF.
 * @param {number}  [opts.speed]   - global rate multiplier.
 * @param {string}  [opts.label]   - destination path shown under the orbit.
 * @param {(el:HTMLElement, finalText:string, durationMs:number)=>void} [opts.scramble]
 *        - glyph-scramble text effect, passed in from page-transition.js to
 *          avoid a circular import (that module imports this one).
 * @returns {{ el:HTMLElement, start:()=>void, setRate:(r:number)=>void, land:()=>Promise<void>, destroy:()=>void }}
 */
export function mountOrbitLoader(container, opts = {}) {
    const { reduced = false, speed = 1, label: labelText = "", scramble = null } = opts;

    injectStyles();

    const wrap = document.createElement("div");
    wrap.className = "pf-ol-wrap";
    wrap.setAttribute("aria-hidden", "true");

    const svg = svgEl("svg", { viewBox: "0 0 240 240", class: "pf-ol-svg" });

    // orbit paths, tilted per ring
    RINGS.forEach(ring => {
        const ry = ring.r * 0.42;
        const o = svgEl("ellipse", {
            cx: CX, cy: CY, rx: ring.r, ry,
            fill: "none", stroke: ring.colour, "stroke-opacity": 0.13, "stroke-width": 1,
            transform: `rotate(${ring.tilt} ${CX} ${CY})`,
        });
        svg.appendChild(o);
    });

    // core
    const coreHalo = svgEl("circle", { cx: CX, cy: CY, r: 13, fill: ACCENT, "fill-opacity": 0.10 });
    const coreRing = svgEl("circle", { cx: CX, cy: CY, r: 9, fill: "none", stroke: ACCENT, "stroke-width": 1.3, "stroke-opacity": 0.75 });
    const coreDot  = svgEl("circle", { cx: CX, cy: CY, r: 3.2, fill: ACCENT });
    svg.appendChild(coreHalo); svg.appendChild(coreRing); svg.appendChild(coreDot);

    // orbiting glyphs
    const bodies = [];
    RINGS.forEach(ring => {
        for (let i = 0; i < ring.count; i++) {
            const g = glyph(ring.shape, ring.colour);
            svg.appendChild(g);
            bodies.push({ ring, phase: (i / ring.count) * 360, node: g });
        }
    });

    wrap.appendChild(svg);

    const label = document.createElement("div");
    label.className = "pf-ol-label";
    label.innerHTML = `<span class="pf-ol-label-accent">&gt;&nbsp;</span><span class="pf-ol-label-text"></span>`;
    const labelTx = label.querySelector(".pf-ol-label-text");
    wrap.appendChild(label);
    if (scramble && !reduced) scramble(labelTx, labelText, 320);
    else labelTx.textContent = labelText;

    container.appendChild(wrap);

    // ── animation state ──
    let spin = 0, raf = 0, last = 0, rate = 1, landing = false, converge = 0;

    function place(body) {
        const { ring } = body;
        const a = (body.phase + spin * ring.speed * 60) * DEG;
        const shrink = 1 - converge;
        const rx = ring.r * shrink;
        const ry = ring.r * 0.42 * shrink;

        let x = Math.cos(a) * rx;
        let y = Math.sin(a) * ry;

        const tr = ring.tilt * DEG;
        const rxp = x * Math.cos(tr) - y * Math.sin(tr);
        const ryp = x * Math.sin(tr) + y * Math.cos(tr);
        x = rxp; y = ryp;

        // depth fake: near half is bright/large, far half dims and shrinks —
        // this is what sells the "rotating sphere" read.
        const depth = Math.sin(a);
        const scale = 0.72 + 0.42 * ((depth + 1) / 2);
        const op    = 0.42 + 0.58 * ((depth + 1) / 2);

        body.node.setAttribute("transform", `translate(${(CX + x).toFixed(2)} ${(CY + y).toFixed(2)}) scale(${scale.toFixed(3)})`);
        body.node.setAttribute("opacity", op.toFixed(3));
    }

    function paint(now) {
        bodies.forEach(place);
        const b = 1 + Math.sin(now / 420) * 0.10;
        coreRing.setAttribute("r", (9 * b).toFixed(2));
        coreDot.setAttribute("r", (3.2 * (2 - b)).toFixed(2));
    }

    function tick(now) {
        if (!last) last = now;
        // Clamp the frame delta. rAF is fully suspended while a tab is
        // hidden, so on resume `now - last` can be several seconds and the
        // orbit would visibly jump. Verified: a hidden tab renders 0 frames.
        const dt = Math.min(now - last, 50);
        last = now;
        spin += (dt / 1000) * rate * speed;
        paint(now);
        raf = requestAnimationFrame(tick);
    }

    function renderStatic() {
        spin = 0.35;
        paint(performance.now());
    }

    return {
        el: wrap,
        start() {
            if (reduced) { renderStatic(); return; }
            last = 0;
            raf = requestAnimationFrame(tick);
        },
        setRate(r) { rate = r; },
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
                    converge = 1;
                    bodies.forEach(b => b.node.setAttribute("opacity", "0"));
                    coreHalo.setAttribute("r", "34");
                    coreHalo.setAttribute("fill-opacity", "0");
                    coreDot.setAttribute("r", "3.2");
                    labelTx.style.color = ACCENT;
                    resolve();
                };

                // GSAP's ticker is rAF-driven, which is fully suspended
                // while the tab is hidden — a visitor who alt-tabs right
                // after clicking would otherwise strand the transition
                // here forever, since onComplete would never fire. A
                // bounded fallback guarantees landing regardless; the
                // `done` guard means whichever path (tween or timeout)
                // gets there first is the one that finalizes state.
                const fallback = setTimeout(finish, 1200);

                const st = { rate: 1, c: 0 };
                window.gsap?.to(st, {
                    rate: 2.8, duration: 0.24, ease: "power2.in",
                    onUpdate: () => { rate = st.rate; },
                });
                const converger = window.gsap?.to(st, {
                    c: 1, duration: 0.34, delay: 0.14, ease: "power3.in",
                    onUpdate: () => { converge = st.c; },
                    onComplete: () => {
                        clearTimeout(fallback);
                        if (done) return;
                        bodies.forEach(b => b.node.setAttribute("opacity", "0"));
                        window.gsap?.fromTo(coreHalo, { attr: { r: 10 }, "fill-opacity": 0.55 },
                            { attr: { r: 34 }, "fill-opacity": 0, duration: 0.42, ease: "power2.out" });
                        window.gsap?.fromTo(coreDot, { attr: { r: 3.2 } },
                            { attr: { r: 6.5 }, duration: 0.16, yoyo: true, repeat: 1, ease: "power2.out" });
                        window.gsap?.to(labelTx, { color: ACCENT, duration: 0.2 });
                        done = true;
                        setTimeout(resolve, 170);
                    },
                });
                if (!converger) {
                    // No GSAP: land instantly rather than never resolving.
                    clearTimeout(fallback);
                    finish();
                }
            });
        },
        destroy() {
            if (raf) cancelAnimationFrame(raf);
            raf = 0;
            window.gsap?.killTweensOf(labelTx);
            wrap.remove();
        },
    };
}
