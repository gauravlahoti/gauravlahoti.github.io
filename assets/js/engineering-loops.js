// engineering-loops.js — "Engineering Loops", an interactive nested-flow explainer.
//
// Contract: initEngineeringLoops(rootEl, { content }) → { destroy() }
//
// The layers are ADDITIVE: one shared canvas, and each layer stacks onto the last
// (advancing keeps every layer before it). The Model is the shared anchor.
//   01 prompt  — a stick-figure human ⇄ the Model (Claude + Gemini): prompt out,
//                output back, "tweak & send again" — a loop you run by hand.
//   02 context — the Model calls tools to "gather context"; each call drops a file
//                into a context window that slowly fills → FULL → loses the goal.
//   03 harness — task list, memory, fresh-context around the Model. *
//   04 loop    — an outer loop wraps it all: scheduler, cycle, self-growth. *
//   (* harness + loop are functional placeholders, refined in a later pass.)
// buildAll() draws every layer once into its own <g class="m-<id>"> (each split into
// step groups); focusLayer()→playAdditive(i) shows layers 0..i (staying static), hides
// the rest, and staggers in the just-activated layer's steps before starting its loop —
// only the focused stage animates, so attention stays there. Exception: PROMPT and
// CONTEXT are the throughline of the whole explainer, so once either is reached it
// keeps running no matter which later stage is focused.
// Reuses the site's motion DNA and degrades to a static render when GSAP is missing
// or prefers-reduced-motion is set.

const SVGNS = "http://www.w3.org/2000/svg";
const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Per-layer accent (hex literals mirror the CSS custom props; GSAP can't read CSS
// vars mid-tween, so keep literals here — same pattern as mcp-lab.js).
const COLORS = { prompt: "#F2B138", context: "#00FFD1", harness: "#a78bfa", loop: "#4ADE80" };
const MODEL_COLOR = "#E5E5E5"; // the Model anchor reads as neutral ink, distinct from any layer
const GLOW = {
    prompt: "rgba(242,177,56,0.9)",
    context: "rgba(0,255,209,0.95)",
    harness: "rgba(167,139,250,0.9)",
    loop: "rgba(74,222,128,0.9)",
};
const LAYER_ORDER = ["prompt", "context", "harness", "loop"];
const CLAUDE_LOGO = "/assets/img/logo-claude.svg";
const GEMINI_LOGO = "/assets/img/logo-gemini.svg";
const OPENAI_LOGO = "/assets/img/logo-openai.svg";

// ─── tiny DOM/SVG helpers (ported from mcp-lab.js) ──────────────────────────────

function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role" || k === "tabindex") n.setAttribute(k, v);
        else n[k] = v;
    }
    for (const c of kids) { if (c == null) continue; n.append(c.nodeType ? c : document.createTextNode(c)); }
    return n;
}

function s(tag, attrs = {}, ...kids) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) { if (v != null) n.setAttribute(k, v); }
    for (const c of kids) { if (c != null) n.append(c.nodeType ? c : document.createTextNode(c)); }
    return n;
}

const gsap = () => window.gsap;

function whenGsap(cb) {
    if (window.gsap) { cb(window.gsap); return; }
    let done = false;
    const go = () => { if (done) return; done = true; cb(window.gsap || null); };
    window.addEventListener("load", () => go(), { once: true });
    setTimeout(go, 900);
}

// Glowing traveler dot riding a polyline of {x,y}. Returns a gsap timeline (or null).
// `layer` tags the dot (loops-dot-<layer>) so a specific layer's animation can be torn
// down (stray dot removed) without touching dots belonging to other, still-running layers.
function travelDot(svg, pts, { color = "#00FFD1", glow, r = 4.5, speed = 240, onArrive, layer } = {}) {
    const g = gsap();
    if (!g || REDUCE_MOTION || pts.length < 2) { onArrive?.(); return null; }
    const dot = s("circle", { r, fill: color, class: `loops-dot ${layer ? `loops-dot-${layer}` : ""}`, cx: pts[0].x, cy: pts[0].y });
    dot.style.filter = `drop-shadow(0 0 5px ${glow || color})`;
    svg.appendChild(dot);
    const tl = g.timeline({ onComplete() { dot.remove(); } });
    tl.fromTo(dot, { opacity: 0 }, { opacity: 1, duration: 0.08 });
    for (let i = 1; i < pts.length; i++) {
        tl.to(dot, {
            attr: { cx: pts[i].x, cy: pts[i].y },
            duration: Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / speed,
            ease: "none",
        });
    }
    if (onArrive) tl.add(() => onArrive());
    tl.to(dot, { opacity: 0, duration: 0.12, ease: "power2.in" });
    return tl;
}

// Stroke draw-on for any SVG path/rect/line. Returns a tween (or null).
function drawOn(pathEl, { duration = 0.6, delay = 0, ease = "power2.out" } = {}) {
    const g = gsap();
    let len = 0;
    try { len = pathEl.getTotalLength(); } catch { len = 800; }
    pathEl.style.strokeDasharray = len;
    pathEl.style.strokeDashoffset = len;
    if (!g || REDUCE_MOTION) { pathEl.style.strokeDashoffset = 0; return null; }
    return g.to(pathEl, { strokeDashoffset: 0, duration, delay, ease });
}

// Splits "a → b" into ["a →", "b"] for two-line labels in tight spaces.
function splitAtArrow(text) {
    const i = String(text || "").indexOf("→");
    if (i === -1) return [text];
    return [text.slice(0, i + 1).trim(), text.slice(i + 1).trim()];
}

function wrapText(text, maxChars) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = []; let line = "";
    for (const w of words) {
        if (!line) line = w;
        else if ((line + " " + w).length <= maxChars) line += " " + w;
        else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    return lines;
}

function svgLines(x, y, lines, cls, lh, anchor = "middle") {
    const t = s("text", { x, y, "text-anchor": anchor, class: cls });
    lines.forEach((ln, i) => t.append(s("tspan", { x, dy: i === 0 ? 0 : lh }, ln)));
    return t;
}

// ─── SVG glyph builders (line-art) ──────────────────────────────────────────────

function personGlyph(cx, cy, color, cls) {
    return s("g", { class: `loops-glyph ${cls || ""}`, stroke: color },
        s("circle", { cx, cy: cy - 12, r: 8, fill: "none" }),
        s("path", { d: `M ${cx - 15} ${cy + 14} a 15 15 0 0 1 30 0`, fill: "none" }),
    );
}

function clockGlyph(cx, cy, color, cls) {
    return s("g", { class: `loops-glyph ${cls || ""}`, stroke: color },
        s("circle", { cx, cy, r: 15, fill: "none" }),
        s("path", { d: `M ${cx} ${cy} L ${cx} ${cy - 9} M ${cx} ${cy} L ${cx + 7} ${cy + 4}`, fill: "none" }),
    );
}

function memoryGlyph(cx, cy, color, cls) {
    const w = 38, h = 30, ry = 6;
    return s("g", { class: `loops-glyph ${cls || ""}`, stroke: color },
        s("path", { d: `M ${cx - w / 2} ${cy - h / 2} v ${h} a ${w / 2} ${ry} 0 0 0 ${w} 0 v ${-h}`, fill: "none" }),
        s("ellipse", { cx, cy: cy - h / 2, rx: w / 2, ry, fill: "none" }),
        s("path", { d: `M ${cx - w / 2} ${cy} a ${w / 2} ${ry} 0 0 0 ${w} 0`, fill: "none" }),
    );
}

// A full stick figure (head, body, arms, legs) — the "you" actor, drawn big and clear.
function stickFigure(cx, cy, color, cls) {
    return s("g", { class: `loops-glyph loops-figure ${cls || ""}`, stroke: color },
        s("circle", { cx, cy: cy - 40, r: 13, fill: "none" }),
        s("line", { x1: cx, y1: cy - 27, x2: cx, y2: cy + 8 }),
        s("line", { x1: cx - 22, y1: cy - 13, x2: cx + 22, y2: cy - 13 }),
        s("line", { x1: cx, y1: cy + 8, x2: cx - 17, y2: cy + 38 }),
        s("line", { x1: cx, y1: cy + 8, x2: cx + 17, y2: cy + 38 }),
    );
}

// A document/file glyph (notched top-right corner + text lines). `sc` scales it.
function docGlyph(cx, cy, color, cls, sc = 1) {
    const w = 22 * sc, h = 28 * sc, fold = 7 * sc, x = cx - w / 2, y = cy - h / 2;
    const g = s("g", { class: `loops-doc ${cls || ""}`, stroke: color, fill: "none" });
    g.append(s("path", { d: `M ${x} ${y} h ${w - fold} l ${fold} ${fold} v ${h - fold} h ${-w} Z` }));
    g.append(s("path", { d: `M ${x + w - fold} ${y} v ${fold} h ${fold}` }));
    for (let i = 0; i < 3; i++) g.append(s("line", { x1: x + 4 * sc, y1: y + (12 + i * 5) * sc, x2: x + w - 4 * sc, y2: y + (12 + i * 5) * sc, "stroke-width": 1.1 }));
    return g;
}

// Hex → rgba string, for a dim colour wash inside a discipline boundary.
function hexToRgba(hex, a) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// A bullseye/target glyph — "the goal".
function targetGlyph(cx, cy, color, cls) {
    return s("g", { class: `loops-glyph ${cls || ""}`, stroke: color, fill: "none" },
        s("circle", { cx, cy, r: 16 }),
        s("circle", { cx, cy, r: 9 }),
        s("circle", { cx, cy, r: 3, fill: color, stroke: color }),
    );
}

// An official brand mark loaded from a same-origin SVG (Claude, Gemini).
function brandLogo(href, x, y, size, cls) {
    const im = s("image", { x, y, width: size, height: size, class: `loops-brand ${cls || ""}`, preserveAspectRatio: "xMidYMid meet" });
    im.setAttribute("href", href);
    return im;
}

// The official MCP (Model Context Protocol) mark — three interlocking link strokes,
// from modelcontextprotocol.io's brand SVG. Inline (not an <image>) so it can be
// recoloured via currentColor/CSS to read as a subtle badge on the dark canvas.
function mcpMark(cx, cy, size, cls) {
    const scale = size / 195;
    const g = s("g", {
        class: `loops-mcp ${cls || ""}`,
        transform: `translate(${(cx - size / 2).toFixed(1)}, ${(cy - size / 2).toFixed(1)}) scale(${scale.toFixed(4)})`,
    });
    [
        "M25 97.8528L92.8823 29.9706C102.255 20.598 117.451 20.598 126.823 29.9706V29.9706C136.196 39.3431 136.196 54.5391 126.823 63.9117L75.5581 115.177",
        "M76.2653 114.47L126.823 63.9117C136.196 54.5391 151.392 54.5391 160.765 63.9117L161.118 64.2652C170.491 73.6378 170.491 88.8338 161.118 98.2063L99.7248 159.6C96.6006 162.724 96.6006 167.789 99.7248 170.913L112.331 183.52",
        "M109.853 46.9411L59.6482 97.1457C50.2757 106.518 50.2757 121.714 59.6482 131.087V131.087C69.0208 140.459 84.2168 140.459 93.5894 131.087L143.794 80.8822",
    ].forEach(d => g.append(s("path", { d, fill: "none", stroke: "currentColor", "stroke-width": 12, "stroke-linecap": "round" })));
    return g;
}

// Straight connector with an arrowhead at (x2,y2).
function connector(x1, y1, x2, y2, cls) {
    const g = s("g", { class: `loops-conn ${cls || ""}` });
    g.append(s("line", { x1, y1, x2, y2, class: "loops-conn-line" }));
    const ang = Math.atan2(y2 - y1, x2 - x1), ah = 8;
    g.append(s("path", {
        d: `M ${x2} ${y2} L ${(x2 - ah * Math.cos(ang - 0.42)).toFixed(1)} ${(y2 - ah * Math.sin(ang - 0.42)).toFixed(1)} `
         + `M ${x2} ${y2} L ${(x2 - ah * Math.cos(ang + 0.42)).toFixed(1)} ${(y2 - ah * Math.sin(ang + 0.42)).toFixed(1)}`,
        class: "loops-conn-line",
    }));
    return g;
}

// Curved arrow from (x1,y1)→(x2,y2). `bow` = signed perpendicular bulge. Arrowhead
// at the end. Two of these with reversed endpoints make a clean two-way "loop".
function curvedArrow(x1, y1, x2, y2, bow, cls) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;                 // unit normal
    const cxp = mx + nx * bow, cyp = my + ny * bow;      // control point
    const g = s("g", { class: `loops-conn ${cls || ""}` });
    g.append(s("path", { d: `M ${x1} ${y1} Q ${cxp.toFixed(1)} ${cyp.toFixed(1)} ${x2} ${y2}`, fill: "none", class: "loops-conn-line" }));
    const ang = Math.atan2(y2 - cyp, x2 - cxp), ah = 8;  // tangent ≈ control→end
    g.append(s("path", {
        d: `M ${x2} ${y2} L ${(x2 - ah * Math.cos(ang - 0.42)).toFixed(1)} ${(y2 - ah * Math.sin(ang - 0.42)).toFixed(1)} `
         + `M ${x2} ${y2} L ${(x2 - ah * Math.cos(ang + 0.42)).toFixed(1)} ${(y2 - ah * Math.sin(ang + 0.42)).toFixed(1)}`,
        class: "loops-conn-line",
    }));
    return g;
}

// Orthogonal "flowchart" elbow: a straight run up from (x1,y1), a tight quarter-turn
// rounded corner of radius r, then a straight run left into (x2,y2). Classic diagram
// routing — used where a smooth diagonal curve would look imprecise.
function elbowUpThenLeft(x1, y1, x2, y2, r, cls) {
    const cornerY = y2 + r, cornerX = x1 - r;
    const g = s("g", { class: `loops-conn ${cls || ""}` });
    g.append(s("path", {
        d: `M ${x1} ${y1} L ${x1} ${cornerY} Q ${x1} ${y2} ${cornerX} ${y2} L ${x2} ${y2}`,
        fill: "none", class: "loops-conn-line",
    }));
    const ang = Math.atan2(0, x2 - cornerX), ah = 8;
    g.append(s("path", {
        d: `M ${x2} ${y2} L ${(x2 - ah * Math.cos(ang - 0.42)).toFixed(1)} ${(y2 - ah * Math.sin(ang - 0.42)).toFixed(1)} `
         + `M ${x2} ${y2} L ${(x2 - ah * Math.cos(ang + 0.42)).toFixed(1)} ${(y2 - ah * Math.sin(ang + 0.42)).toFixed(1)}`,
        class: "loops-conn-line",
    }));
    return g;
}

// A polyline through axis-aligned points (each segment horizontal or vertical —
// never diagonal), with one arrowhead at the final point. Used for harness-layer
// connectors that need a clean right-angle route instead of a single straight line.
function orthoConnector(pts, cls) {
    const g = s("g", { class: `loops-conn ${cls || ""}` });
    const d = pts.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
    g.append(s("path", { d, fill: "none", class: "loops-conn-line" }));
    const [p1, p2] = pts.slice(-2);
    const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x), ah = 8;
    g.append(s("path", {
        d: `M ${p2.x} ${p2.y} L ${(p2.x - ah * Math.cos(ang - 0.42)).toFixed(1)} ${(p2.y - ah * Math.sin(ang - 0.42)).toFixed(1)} `
         + `M ${p2.x} ${p2.y} L ${(p2.x - ah * Math.cos(ang + 0.42)).toFixed(1)} ${(p2.y - ah * Math.sin(ang + 0.42)).toFixed(1)}`,
        class: "loops-conn-line",
    }));
    return g;
}

// Labeled rounded-rect node. Returns the group; stash edge points on it.
function boxNode(cx, cy, w, h, label, color, cls, { labelCls = "loops-node-label", rx = 10 } = {}) {
    const g = s("g", { class: `loops-node ${cls || ""}` });
    g.append(s("rect", { x: cx - w / 2, y: cy - h / 2, width: w, height: h, rx, fill: "none", stroke: color, class: "loops-node-rect" }));
    g.append(s("text", { x: cx, y: cy + 5, "text-anchor": "middle", class: labelCls }, label));
    g._l = cx - w / 2; g._r = cx + w / 2; g._t = cy - h / 2; g._b = cy + h / 2; g._cx = cx; g._cy = cy;
    return g;
}

// ─── the lab ────────────────────────────────────────────────────────────────────

export function initEngineeringLoops(rootEl, { content } = {}) {
    if (!rootEl || !content) return { destroy() {} };
    const layers = content.layers || [];
    const ui = content.ui || {};
    const dg = content.diagram || {};

    // shell -----------------------------------------------------------------------
    const lab = el("div", { class: "loops-lab" });
    const header = el("header", { class: "loops-header" },
        content.intro?.tag && el("p", { class: "loops-tag", text: content.intro.tag }),
        el("h1", { class: "loops-h1" }, content.intro?.title || "Engineering Loops"),
        content.intro?.sub && el("p", { class: "loops-sub", text: content.intro.sub }),
    );

    const stageWrap = el("div", { class: "loops-stagewrap" });
    const svg = s("svg", {
        class: "loops-svg", viewBox: "0 0 1440 1080",
        role: "img", "aria-label": "A step-by-step scene for each way to steer an AI: a human prompting an LLM, a context window filling up, a harness of tools, and an autonomous loop",
    });
    stageWrap.append(svg);

    // max-mode: expand the diagram into a full-viewport overlay
    const maxBtn = el("button", { class: "loops-max", type: "button", "aria-label": ui.expand || "Expand diagram" },
        el("span", { class: "loops-max-glyph", "aria-hidden": "true" }, "⤢"));
    stageWrap.append(maxBtn);
    function toggleMax(force) {
        const on = force == null ? !stageWrap.classList.contains("is-max") : force;
        stageWrap.classList.toggle("is-max", on);
        document.body.style.overflow = on ? "hidden" : "";
        maxBtn.querySelector(".loops-max-glyph").textContent = on ? "✕" : "⤢";
        maxBtn.setAttribute("aria-label", on ? (ui.close || "Close") : (ui.expand || "Expand diagram"));
    }
    maxBtn.addEventListener("click", () => toggleMax());

    // controls --------------------------------------------------------------------
    const prevBtn = el("button", { class: "loops-btn loops-prev", type: "button" }, "‹ " + (ui.prev || "Prev"));
    const nextBtn = el("button", { class: "loops-btn loops-next", type: "button" });
    const tourBtn = el("button", { class: "loops-btn loops-tour", type: "button" });
    const dots = el("div", { class: "loops-dots", role: "tablist", "aria-label": "Layers" });
    const dotEls = layers.map((l, i) => {
        const d = el("button", { class: "loops-dot-btn", type: "button", role: "tab", "aria-label": `${l.n} · ${l.title}` });
        d.addEventListener("click", () => { stopTour(); focusLayer(i); });
        dots.append(d);
        return d;
    });
    const controls = el("div", { class: "loops-controls" }, prevBtn, dots, nextBtn, tourBtn);

    const observers = [];
    const chartSection = content.chart ? buildChart(content.chart) : null;
    const closing = content.closing && el("p", { class: "loops-closing", text: content.closing });

    lab.append(header, stageWrap, controls);
    if (chartSection) lab.append(chartSection);
    if (closing) lab.append(closing);
    rootEl.replaceChildren(lab);

    // ── the scene: all layers built once onto one shared canvas ──────────────────
    const scene = s("g", { class: "loops-scene" });
    svg.append(scene);
    const refs = buildAll();

    // state -----------------------------------------------------------------------
    let focus = 0;
    let revealTl = null;      // the staggered "step by step" intro for the focused ring
    let pendingStart = null;  // delayedCall that starts the focused ring's loop after its reveal finishes
    const activeAnims = {};   // id -> running gsap timeline; every VISIBLE layer keeps looping additively
    let tourTimer = null;
    let tourPlaying = false;

    // ── dynamic canvas: the viewBox tracks how much is actually on screen, so the
    // scene starts small (just the prompt ring) and visibly grows as each layer adds
    // its territory — instead of rendering the full 1440×1080 canvas from step one
    // with the early rings floating in a mostly-empty frame. Each box is [x,y,w,h],
    // padded a little past that layer's own DEMARCATION rect. Since .loops-svg is
    // `height: auto` off a fixed width, animating the viewBox also animates the
    // rendered height — the container itself grows/shrinks, not just an inner zoom.
    const STAGE_VB = {
        prompt: [36, 220, 666, 316],    // prompt DEMARCATION rect: x76 y260 w586 h236, +40 pad
        context: [18, 26, 1088, 550],   // context DEMARCATION rect: x58 y66 w968 h470, +40 pad
        harness: [8, 0, 1404, 920],     // harness DEMARCATION rect: x28 y14 w1362 h894, +~14 pad
        loop: [0, 0, 1440, 1080],       // full canvas — the loop frame fills nearly all of it
    };
    let vbTween = null; // in-flight viewBox tween, if any — killed before starting a new one
    function setViewBox(id, animate) {
        const target = STAGE_VB[id] || STAGE_VB.loop;
        const g = gsap();
        if (vbTween) { try { vbTween.kill(); } catch {} vbTween = null; }
        if (!g || REDUCE_MOTION || !animate) {
            svg.setAttribute("viewBox", target.join(" "));
            return;
        }
        // read the LIVE attribute (not a remembered "last target") so a tween started
        // mid-flight through a previous transition picks up from wherever it actually
        // is on screen right now, instead of snapping from a stale value
        const current = (svg.getAttribute("viewBox") || "").trim().split(/\s+/).map(Number);
        const from = current.length === 4 && current.every(n => !Number.isNaN(n)) ? current : target;
        const proxy = { x: from[0], y: from[1], w: from[2], h: from[3] };
        vbTween = g.to(proxy, {
            x: target[0], y: target[1], w: target[2], h: target[3],
            duration: 0.9, ease: "power2.inOut",
            onUpdate: () => svg.setAttribute("viewBox", `${proxy.x} ${proxy.y} ${proxy.w} ${proxy.h}`),
        });
    }

    // Stop one layer's loop (if running) and clean up any dot it left mid-flight —
    // other layers' timelines and dots are untouched, so they keep animating.
    function stopLayerAnim(id) {
        const tl = activeAnims[id];
        if (tl) { try { tl.kill(); } catch {} delete activeAnims[id]; }
        svg.querySelectorAll(`.loops-dot-${id}`).forEach(d => d.remove());
    }

    // Each layer's own outer boundary/title (its DEMARCATION) is held back from the
    // normal step reveal — it only fades in once that layer's own animation has played
    // through one full cycle, so the "container" only closes around the mechanism
    // after you've watched it actually work, instead of announcing the discipline's
    // name before anything inside it has happened. A one-time flag per layer: once
    // shown, it stays shown (revisiting a layer never hides it again or makes you wait
    // a second time).
    const demarcationShown = {};
    function revealDemarcation(id, animate) {
        if (demarcationShown[id]) return;
        demarcationShown[id] = true;
        const node = refs.demarcation[id];
        if (!node) return;
        const g = gsap();
        if (!g || REDUCE_MOTION || !animate) { node.style.opacity = "1"; return; }
        g.to(node, { opacity: 1, duration: 0.6, ease: "power2.out" });
    }

    // Start one layer's loop if it isn't already running.
    function startLayerAnim(id) {
        if (activeAnims[id]) return;
        const animate = refs.anims[id];
        if (!animate || REDUCE_MOTION || !gsap()) { revealDemarcation(id, false); return; }
        const tl = animate();
        activeAnims[id] = tl;
        // fires once the timeline completes its first full pass and loops back to
        // start — exactly "one full animation of this layer is complete"
        if (!demarcationShown[id] && tl && typeof tl.eventCallback === "function") {
            tl.eventCallback("onRepeat", () => {
                revealDemarcation(id, true);
                tl.eventCallback("onRepeat", null); // one-shot
            });
        }
    }

    // ── focus ────────────────────────────────────────────────────────────────────
    // Tears down the CURRENT reveal-in-progress. playAdditive() below handles stopping
    // every other layer's loop, so only the newly-focused stage is ever animating.
    function clearAnim() {
        if (revealTl) { try { revealTl.kill(); } catch {} revealTl = null; }
        if (pendingStart) { try { pendingStart.kill(); } catch {} pendingStart = null; }
    }

    // Additive reveal: every layer up to `i` stays visible but goes still; layers past
    // `i` hide entirely; only the just-activated layer's step groups fade in (step by
    // step) and starts looping. Prior layers keep their static art on screen — the
    // picture still grows outward — but only the focused stage animates, so attention
    // stays there. The exception is PROMPT and CONTEXT: they're the throughline of the
    // explainer, so their loops keep running for as long as they're on screen, regardless
    // of focus.
    function playAdditive(i) {
        const g = gsap();
        LAYER_ORDER.forEach((id, k) => {
            const grp = refs.groups[id];
            if (!grp) return;
            if (k < i) {
                grp.style.opacity = "1";
                grp.style.pointerEvents = "";
                (refs.steps[id] || []).forEach(st => (st.style.opacity = ""));
                // prompt and context are the throughline of this whole explainer — once
                // either has been reached, keep it running no matter which later stage is
                // focused. (idempotent: a no-op if it's already mid-loop, so it's never
                // interrupted.)
                if (id === "context" || id === "prompt") startLayerAnim(id);
                else stopLayerAnim(id); // other prior stages stay visible, but go still
                // safety net: a layer you've already moved past must never be left with
                // its outer boundary permanently missing just because you clicked away
                // before its first animation cycle finished
                revealDemarcation(id, false);
            } else if (k > i) {
                grp.style.opacity = "0";
                // opacity:0 elements are still hit-tested by default. Since the SVG's
                // viewBox now shrinks for early stages (dynamic canvas), these still-
                // invisible later-stage groups sit at absolute coordinates far outside
                // the shrunk box; with `overflow: visible` they'd otherwise still catch
                // clicks well past the diagram — including the Prev/Next controls below.
                grp.style.pointerEvents = "none";
                stopLayerAnim(id);
            }
        });
        const curId = LAYER_ORDER[i];
        const grp = refs.groups[curId];
        if (grp) { grp.style.opacity = "1"; grp.style.pointerEvents = ""; }
        stopLayerAnim(curId); // restart the focused layer's loop fresh each time it's (re)focused
        const flat = (refs.steps[curId] || []).filter(Boolean);
        const startAnim = () => startLayerAnim(curId);
        if (!g || REDUCE_MOTION || !flat.length) {
            flat.forEach(st => (st.style.opacity = ""));
            startAnim();
            return;
        }
        g.set(flat, { opacity: 0 });
        const dur = 0.6;
        const stagger = Math.min(1.3, Math.max(0.85, 7 / flat.length));
        revealTl = g.to(flat, {
            opacity: 1, duration: dur, stagger, ease: "power2.out",
            onComplete() { flat.forEach(st => (st.style.opacity = "")); },
        });
        const revealDur = stagger * (flat.length - 1) + dur + 0.25;
        pendingStart = g.delayedCall(revealDur, startAnim);
    }

    let hasFocusedOnce = false;
    function focusLayer(i) {
        focus = (i + layers.length) % layers.length;
        const layer = layers[focus];
        dotEls.forEach((d, k) => {
            d.classList.toggle("is-active", k === focus);
            d.setAttribute("aria-selected", k === focus ? "true" : "false");
        });
        nextBtn.textContent = focus === layers.length - 1 ? `↺ ${ui.restart || "Restart"}` : `${ui.next || "Next"} ›`;
        clearAnim();
        scene.setAttribute("class", `loops-scene loops-scene-${layer.id}`);
        // snap on the very first render (page load / deep-link) — nothing to animate
        // from yet; every navigation after that animates the canvas growing/shrinking
        setViewBox(layer.id, hasFocusedOnce);
        hasFocusedOnce = true;
        playAdditive(focus);
    }

    // ── additive composition: layers stack onto one shared canvas ────────────────
    // Each layer's parts live in a <g class="m-<id>"> group, split into step groups
    // that reveal one at a time. Advancing a layer keeps every layer before it and
    // reveals only the new group's steps; the Model is the shared anchor the whole
    // picture is built around. Coordinates share one 1120×680 space.

    // The Model box: centred "Model" flanked-below by the official Claude + GPT + Gemini
    // marks — three logos, evenly spaced and centred on the box (same 34px logo-to-logo
    // spacing the two-logo layout used).
    function llmBox(x, y, w, h, col) {
        const cx = x + w / 2, cy = y + h / 2;
        const g = s("g", { class: "loops-llm" });
        g.append(s("rect", { x, y, width: w, height: h, rx: 12, fill: "none", stroke: col, class: "loops-llm-rect" }));
        g.append(s("text", { x: cx, y: cy - 8, "text-anchor": "middle", class: "loops-llm-title" }, dg.modelNode || "Model"));
        const size = 26;
        g.append(brandLogo(CLAUDE_LOGO, cx - 47, cy + 6, size));
        g.append(brandLogo(OPENAI_LOGO, cx - 13, cy + 6, size));
        g.append(brandLogo(GEMINI_LOGO, cx + 21, cy + 6, size));
        g._l = x; g._r = x + w; g._t = y; g._b = y + h; g._cx = cx; g._cy = cy;
        return g;
    }

    function buildAll() {
        const groups = {}, steps = {}, anims = {}, demarcation = {};
        const layerG = id => { const g = s("g", { class: `loops-layer m-${id}` }); g.style.opacity = "0"; g.style.pointerEvents = "none"; scene.append(g); groups[id] = g; steps[id] = []; return g; };
        const put = (g, id, ...nodes) => {
            const st = s("g", { class: "loops-step" });
            nodes.filter(Boolean).forEach(n => st.append(n));
            g.append(st); steps[id].push(st); return st;
        };
        // a layer's own outer boundary/title — excluded from the normal step stagger;
        // starts invisible and is only faded in once that layer's animation has played
        // through one full cycle (see revealDemarcation in the outer scope)
        const putDemarcation = (g, id, ...nodes) => {
            const wrap = s("g", {});
            nodes.filter(Boolean).forEach(n => wrap.append(n));
            wrap.style.opacity = "0";
            g.append(wrap);
            demarcation[id] = wrap;
            return wrap;
        };

        const M = { cx: 545, cy: 372, w: 178, h: 104 };
        const mL = M.cx - M.w / 2, mR = M.cx + M.w / 2, mT = M.cy - M.h / 2, mB = M.cy + M.h / 2;
        const yTop = 346, yBot = 398;   // prompt / output lines

        // ── PROMPT: a human drives the Model by hand ─────────────────────────────
        const gp = layerG("prompt"), cp = COLORS.prompt;
        const hx = 128, hy = 372;
        put(gp, "prompt", stickFigure(hx, hy, cp, ""), s("text", { x: hx, y: hy + 64, "text-anchor": "middle", class: "loops-cap loops-cap-strong" }, dg.youLabel || "human"));
        const model = llmBox(mL, mT, M.w, M.h, cp);
        put(gp, "prompt", model);
        put(gp, "prompt", connector(238, yTop, mL - 8, yTop, ""), s("text", { x: (238 + mL) / 2, y: yTop - 16, "text-anchor": "middle", class: "loops-cap loops-cap-strong" }, dg.promptSend || "prompt"));
        put(gp, "prompt", connector(mL - 8, yBot, 238, yBot, ""), s("text", { x: (238 + mL) / 2, y: yBot + 24, "text-anchor": "middle", class: "loops-cap" }, dg.promptReturn || "output"));
        const r1 = s("text", { x: 238, y: 452, "text-anchor": "start", class: "loops-cap loops-cap-strong" });
        r1.append(s("tspan", { class: "loops-retry-x" }, "✗  "), dg.retryBad || "not what you wanted");
        put(gp, "prompt", r1);
        const r2 = s("text", { x: 238, y: 480, "text-anchor": "start", class: "loops-cap loops-cap-strong" });
        r2.append(s("tspan", { class: "loops-retry-loop" }, "↻  "), dg.retryAction || "tweak & send again");
        put(gp, "prompt", r2);
        // the manual loop appears LAST — only after "tweak & send again", you loop back by hand
        const arc = s("g", { class: "loops-hand-loop", stroke: cp, fill: "none" });
        arc.append(s("path", { d: `M 238 ${yBot - 4} C 186 ${yBot - 6}, 186 ${yTop + 6}, 236 ${yTop + 4}` }));
        arc.append(s("path", { d: `M 236 ${yTop + 4} l 9 -2 M 236 ${yTop + 4} l -3 -8` }));
        put(gp, "prompt", arc, s("text", { x: 210, y: yTop - 16, "text-anchor": "middle", class: "loops-cap" }, "↻ prompt ", s("tspan", { class: "loops-kw" }, "loop")));
        // DEMARCATION — prompt engineering encloses the human loop AND the Model (the
        // discipline reaches as far as the Model it's steering), with real breathing
        // room between the box border and its content on every side.
        putDemarcation(gp, "prompt",
            s("rect", { x: 76, y: 260, width: mR + 28 - 76, height: 236, rx: 18, class: "loops-bound", stroke: cp, fill: hexToRgba(cp, 0.055) }),
            s("text", { x: 88, y: 289, "text-anchor": "start", class: "loops-bound-label", fill: cp }, dg.promptDiscipline || "prompt engineering"));
        anims.prompt = () => {
            const tl = gsap().timeline({ repeat: -1, repeatDelay: 1.3 });
            tl.add(() => travelDot(svg, [{ x: 244, y: yTop }, { x: mL - 12, y: yTop }], { color: cp, glow: GLOW.prompt, speed: 150, layer: "prompt" }), 0);
            tl.add(() => model.classList.add("is-lit"), 1.8);
            tl.add(() => travelDot(svg, [{ x: mL - 12, y: yBot }, { x: 244, y: yBot }], { color: cp, glow: GLOW.prompt, speed: 150, layer: "prompt" }), 2.35);
            tl.add(() => model.classList.remove("is-lit"), 3.6);
            // loop back by hand: a dot rides the arc from output up to a fresh prompt
            tl.add(() => travelDot(svg, [{ x: 236, y: yBot - 4 }, { x: 188, y: (yTop + yBot) / 2 }, { x: 236, y: yTop + 4 }], { color: cp, glow: GLOW.prompt, speed: 110, layer: "prompt" }), 3.9);
            tl.to({}, { duration: 2.6 });
            return tl;
        };

        // ── CONTEXT: tools gather → small window above the Model → summarize → drift
        const gc = layerG("context"), cc = COLORS.context, resultAmber = "#F59E0B";
        const ww = 340, wh = 120, wx = M.cx - ww / 2, wy = 84, wb = wy + wh;   // small, centred above the Model — a bit taller so each tile can carry its own label
        // 1) the tools the model calls appear FIRST — this is how context gets gathered
        // (kept well clear of the Model so the "gather context" label has breathing room)
        const tx = 880, ty = M.cy;
        const tiles = s("g", {});
        [-30, 0, 30].forEach(ox => tiles.append(s("rect", { x: tx + ox - 13, y: ty - 13, width: 26, height: 26, rx: 5, fill: "none", stroke: COLORS.harness })));  // durable resources — harness-owned, so purple even while positioned here
        put(gc, "context", s("text", { x: tx, y: ty + 56, "text-anchor": "middle", class: "loops-cap" }, dg.toolLabel || "tools + resources"), tiles);
        // 2) Model → tools (the "gather context" call) — appears next, BEFORE the window
        // itself, so the reveal reads in cause-then-effect order: tools exist, the Model
        // reaches for them, and only THEN does the window that receives their results
        // show up. (Previously the window box appeared before this arrow did.)
        put(gc, "context",
            connector(mR + 10, ty - 4, tx - 48, ty - 4, ""),                               // Model → tools (call): straight
            mcpMark((mR + tx - 38) / 2, ty - 20, 26, "loops-mcp-badge"),                    // MCP badge, centred on the arrow, sitting just above it
            s("text", { x: (mR + tx - 38) / 2, y: ty + 30, "text-anchor": "middle", class: "loops-cap" }, dg.contextLoop || "gather context"));  // directly below the arrow's midpoint, clear of "tools + resources"
        // 3) the context window, sitting right above the Model
        const clip = s("clipPath", { id: "loops-ctx-clip" });
        clip.append(s("rect", { x: wx + 2, y: wy + 2, width: ww - 4, height: wh - 4, rx: 6 }));
        gc.append(clip);
        const fill = s("rect", { x: wx + 2, y: wb - 2, width: ww - 4, height: 0, class: "loops-ctx-fill", "clip-path": "url(#loops-ctx-clip)" });
        const win = s("rect", { x: wx, y: wy, width: ww, height: wh, rx: 8, fill: "none", stroke: cc, class: "loops-ctx-win" });
        put(gc, "context", fill, win, s("text", { x: wx + 20, y: wy + 26, "text-anchor": "start", class: "loops-cap" }, dg.contextWindowLabel || "context window"));
        // 4) the INNER AGENTIC LOOP — the engine of context engineering, distinct from the
        //    human loop: Model → calls a tool → result appended to the window → Model reads
        //    it → calls again. This is what grows the window turn over turn.
        put(gc, "context", elbowUpThenLeft(tx, ty - 20, wx + ww, wy + wh / 2, 22, ""));  // tools → window (append result): straight up (centred on the tiles), then into the middle of the window's right edge
        put(gc, "context", connector(M.cx, wb + 4, M.cx, mT - 4, ""));                      // window → Model (read, then loop)
        // "context loop" names the whole pattern (gather → fill → summarize → drift → reset),
        // so it only appears once the tool-gather and summarize steps have already played —
        // revealed by the animation timeline below, not the static step reveal.
        const loopLabel = s("text", { x: 760, y: 300, "text-anchor": "middle", class: "loops-cap loops-cap-strong loops-agentloop" }, "↻ agent ", s("tspan", { class: "loops-kw" }, "loop"));
        loopLabel.style.opacity = REDUCE_MOTION ? "1" : "0";
        gc.append(loopLabel);
        // "summarize"/"drift" sit to the LEFT of the window instead — the right side is
        // where the tools→window arrow, the compaction loop's write/rehydrate legs, and
        // "tools + resources" all converge, so text there just adds to the clutter. The
        // left side (above the prompt box, which only starts at y260) is open space.
        const lcy = wy + wh / 2;
        const full = s("text", { x: wx + ww - 18, y: wy + 30, "text-anchor": "end", class: "loops-ctx-full" }, dg.contextFullLabel || "FULL!");
        const summ = svgLines(wx - 16, lcy - 18, splitAtArrow(dg.contextSummarize || "summarize → detail lost"), "loops-ctx-step loops-ctx-summ", 15, "end");
        const drift = svgLines(wx - 16, lcy + 20, splitAtArrow(dg.contextDrift || "context rot → goal drifts"), "loops-ctx-step loops-ctx-drift", 15, "end");
        full.style.opacity = "0";
        summ.style.opacity = REDUCE_MOTION ? "1" : "0";
        drift.style.opacity = REDUCE_MOTION ? "1" : "0";
        gc.append(full, summ, drift);
        // documents fill in as tool calls return — driven by the animation. Each tile is
        // labelled with what actually lives in a context window: the system prompt (set
        // once), conversation history, retrieved docs, then tool results (the freshest —
        // and first — things pushed out when the window fills, hence the amber pair —
        // amber for "these accumulate and drive context rot," not red/failure).
        const DOC_KINDS = [["system", "prompt"], ["history"], ["docs"], ["docs"], ["tool", "result"], ["tool", "result"]];
        const nD = 6, docY = wy + 58, docXs = [], docs = [], docLabels = [];
        for (let i = 0; i < nD; i++) {
            const dx = wx + 40 + i * ((ww - 80) / (nD - 1)), ov = i >= nD - 2;
            const d = docGlyph(dx, docY, ov ? resultAmber : cc, ov ? "is-result" : "", 0.8);
            d.style.opacity = REDUCE_MOTION ? "1" : "0";
            const lbl = svgLines(dx, docY + 30, DOC_KINDS[i], "loops-doc-label", 12, "middle");
            lbl.style.opacity = REDUCE_MOTION ? "1" : "0";
            gc.append(d, lbl); docs.push(d); docLabels.push(lbl); docXs.push(dx);
        }
        // 5) DEMARCATION — additive layers nest: context engineering fully encloses
        //    prompt engineering (a bigger territory wrapping the last, same pattern
        //    the harness/loop frames use), not a separate adjacent box.
        // top edge pulled down from 48→66 (bottom held at 536, height trimmed to match)
        // so there's real breathing room between this border and the harness border
        // above it, instead of the two titles almost touching
        putDemarcation(gc, "context",
            s("rect", { x: 58, y: 66, width: 968, height: 470, rx: 22, class: "loops-bound", stroke: cc, fill: hexToRgba(cc, 0.055) }),
            s("text", { x: 88, y: 88, "text-anchor": "start", class: "loops-bound-label", fill: cc }, dg.contextDiscipline || "context engineering"));
        let loopLabelShown = false; // "↻ agent loop" — once it's named, it stays named
        anims.context = () => {
            const g = gsap(), tl = g.timeline({ repeat: -1 });
            const step = 1.5, gather = nD * step;
            // Phase A — gather: the model calls a tool, and the result flows up into the window,
            // one tile at a time, slowly enough to actually watch each one land
            tl.fromTo(fill, { attr: { y: wb - 2, height: 0, fill: "rgba(199,166,255,0.14)" } }, { attr: { y: wy + 3, height: wh - 6 }, duration: gather, ease: "none" }, 0);
            docs.forEach((d, i) => {
                const at = i * step;
                // Model → tool (call), then tool → window (result appended): the agent loop
                tl.add(() => travelDot(svg, [{ x: mR, y: ty }, { x: tx - 30, y: ty }], { color: cc, glow: GLOW.context, speed: 220, layer: "context" }), at);
                const leg2 = [{ x: tx, y: ty - 30 }, { x: docXs[i], y: docY }];
                tl.add(() => travelDot(svg, leg2, { color: cc, glow: GLOW.context, speed: 200, layer: "context" }), at + 0.6);
                // the doc's fade-in lives ON the main timeline itself, timed to land right
                // as the dot arrives — NOT inside travelDot's onArrive as an independent
                // tween. onArrive spawns a tween outside this timeline, which is what made
                // "docs already visible" and "docs just pop in with no flying dot" possible
                // on later repeats (a stale/still-resolving async tween racing the next
                // cycle). Living on `tl` ties it to the exact same repeat mechanics as
                // everything else, so every single cycle looks identical.
                const travel = Math.hypot(leg2[1].x - leg2[0].x, leg2[1].y - leg2[0].y) / 200;
                tl.to(d, { opacity: 1, duration: 0.3 }, at + 0.6 + travel);
                tl.to(docLabels[i], { opacity: 1, duration: 0.3 }, at + 0.6 + travel);
            });
            // Phase B — FULL (pause so it lands and can be read)
            tl.to(full, { opacity: 1, duration: 0.3 }, gather + 0.2);
            tl.to(fill, { attr: { fill: "rgba(255,92,92,0.16)" }, duration: 0.4 }, gather + 0.2);
            tl.to({}, { duration: 2.4 });
            // Phase C — summarize: this step is the point, so make it loud. The window flashes
            // amber, the label pops, the detail (cyan docs) drops out, only a lossy summary stays.
            tl.to(full, { opacity: 0, duration: 0.3 });
            tl.to(win, { stroke: "#F2B138", duration: 0.25, yoyo: true, repeat: 3 }, "<");
            tl.fromTo(summ, { opacity: 0, scale: 0.6, transformOrigin: "left center" }, { opacity: 1, scale: 1, duration: 0.55, ease: "back.out(2.2)" }, "<");
            tl.to([...docs.slice(0, 4), ...docLabels.slice(0, 4)], { opacity: 0.08, duration: 0.7 }, "<");
            tl.fromTo(docs.slice(4), { scale: 1, transformOrigin: "center center" }, { scale: 1.18, duration: 0.4, yoyo: true, repeat: 1 }, "<");
            tl.to(fill, { attr: { y: wb - 32, height: 30, fill: "rgba(255,92,92,0.12)" }, duration: 0.7 }, "<");
            tl.to({}, { duration: 2.6 });
            // now that gathering and summarizing have both played out, name the pattern:
            // this whole cycle is "the context loop" — appears here, not at the start.
            // Only animates in ONCE, ever — once "agent loop" has been named, it stays
            // on screen permanently instead of fading out and popping back in every
            // repeat. The outer CONTEXT ENGINEERING boundary clicks into place at the
            // same moment it's first named — once the mechanism has earned its name,
            // it's earned its container too.
            tl.add(() => {
                if (!loopLabelShown) {
                    loopLabelShown = true;
                    g.fromTo(loopLabel, { opacity: 0, scale: 0.6, transformOrigin: "left center" }, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(2.2)" });
                }
                revealDemarcation("context", true);
            });
            tl.to({}, { duration: 0.6 });
            // Phase D — drift: with the detail gone, it loses the goal
            tl.fromTo(drift, { opacity: 0, scale: 0.6, transformOrigin: "left center" }, { opacity: 1, scale: 1, duration: 0.55, ease: "back.out(2.2)" });
            tl.to({}, { duration: 2.6 });
            // reset & loop — Model reads the window (window → Model), then the agent loop runs again
            tl.add(() => travelDot(svg, [{ x: M.cx, y: wb + 2 }, { x: M.cx, y: mT }], { color: cc, glow: GLOW.context, speed: 200, layer: "context" }), ">-0.2");
            tl.to([summ, drift, ...docs, ...docLabels], { opacity: 0, duration: 0.5 }); // loopLabel stays — see above
            tl.set(docs, { opacity: 0 });
            tl.set(docLabels, { opacity: 0 });
            tl.set(win, { stroke: cc });
            tl.set(fill, { attr: { y: wb - 2, height: 0, fill: "rgba(199,166,255,0.14)" } });
            tl.to({}, { duration: 1.2 });
            // hard safety-net reset on every repeat: each doc/label fade-in is a travelDot
            // onArrive callback, which spawns its OWN independent tween outside this
            // timeline — if one hasn't finished by the time this timeline wraps, the doc
            // it belongs to (and any leftover dot) could bleed into round 2, showing the
            // window as already full instead of starting clean. Force everything back and
            // sweep any stray context-layer dots the instant GSAP fires the repeat.
            tl.eventCallback("onRepeat", () => {
                g.set([...docs, ...docLabels], { opacity: 0 });
                g.set(win, { stroke: cc });
                g.set(fill, { attr: { y: wb - 2, height: 0, fill: "rgba(199,166,255,0.14)" } });
                g.set(full, { opacity: 0 });
                g.set([summ, drift], { opacity: 0 }); // loopLabel stays — see above
                svg.querySelectorAll(".loops-dot-context").forEach(d => d.remove());
            });
            return tl;
        };

        // ── HARNESS: the outermost discipline — wraps context engineering entirely.
        // Durable state (tools, task list, memory) survives past any one context
        // window, so the harness band holds what's left when the window resets.
        const gh = layerG("harness"), ch = COLORS.harness;

        // task list — its own lane, left side. Pushed down from the teal box's bottom
        // (536) with real clearance, since the right-side label stack now lives in the
        // gap between them (536–694) and must never cross into the teal box itself.
        const rowLabelY = 650, rowTop = 670;
        // box column centred EXACTLY on M.cx, so the task list sits directly under the
        // Model, not offset to one side of it
        const listX = M.cx;
        const listTop = rowTop;
        // named work items, not bare numbers, so a reader can tell what "one task at a
        // time" actually means here — real task names, not "1., 2., 3."
        const tasks = (layers.find(l => l.id === "harness")?.tasks) || ["frontend", "backend", "database", "qa", "deploy"];
        // label centred on M.cx too, so the connector below needs no bend at all — it
        // drops straight down and lands right on the label's own top-centre
        const taskNodes = [s("text", { x: listX, y: rowLabelY, "text-anchor": "middle", class: "loops-harness-cap" }, dg.taskListLabel || "task list on disk")];
        const taskGroups = [];
        tasks.forEach((t, k) => {
            const rowY = listTop + k * 32, gg = s("g", { class: "loops-task" });
            gg.append(s("rect", { x: listX - 58, y: rowY, width: 116, height: 26, rx: 6, fill: "none", stroke: ch, class: "loops-task-rect" }));
            gg.append(s("text", { x: listX - 46, y: rowY + 18, "text-anchor": "start", class: "loops-node-mono loops-task-label" }, t));
            gg.append(s("text", { x: listX + 46, y: rowY + 18, "text-anchor": "end", class: "loops-task-check" }, "✓"));
            taskNodes.push(gg);
            taskGroups.push(gg);
        });
        // wired to the Model: ONE dead-straight drop down M.cx — the Model's own exact
        // centre — no bend at all, landing right on the label's top edge, centred on it.
        // "read next / mark done" sits to the left, clear of the line the whole way down.
        // Never dips into the human/output area (x76–350, y372–496).
        const taskConnPath = [
            { x: M.cx, y: mB },              // leave the Model, dead straight down its own centre
            { x: M.cx, y: rowLabelY - 14 },  // straight down, landing on the label's top edge — no bend
        ];

        // memory on disk + fresh context — moved UP beside the context window (same
        // neighbourhood as its height) instead of down in the bottom row. Both arrows
        // now run short and direct instead of detouring past "tools + resources" and
        // the gather lane, which is what was causing "write"/"rehydrate" to cross the
        // existing tools→window arrow (a straight vertical at x=880). Still fully
        // inside the purple harness border, just to the right of the teal box (which
        // ends at x=1026), well clear of the harness border (x=1390).
        const winRX = wx + ww;              // 715 — the context window's right edge
        const memX = 1110, freshX = 1290, memY = 420;
        const memTop = memY - 15, memBase = memY + 15;   // memoryGlyph is 30 tall, cy-centred
        const freshTop = memY - 13, freshBase = memY + 13; // fresh-context rect is 26 tall, cy-centred

        // the three durable-state artifacts — task list, memory, fresh context — read as
        // ONE beat: they're the whole point of "harness engineering" (state that survives
        // past any one context window), so they appear together in a single reveal step
        // instead of trickling in one at a time across several separate steps.
        put(gh, "harness",
            ...taskNodes,
            orthoConnector(taskConnPath, ""),
            svgLines(M.cx - 18, rowLabelY - 60, ["read next / mark done"], "loops-harness-note", 14, "end"),
            memoryGlyph(memX, memY, ch, ""),
            s("text", { x: memX, y: memBase + 30, "text-anchor": "middle", class: "loops-harness-cap" }, dg.memoryLabel || "memory on disk"),
            s("rect", { x: freshX - 55, y: freshTop, width: 110, height: 26, rx: 6, fill: "none", stroke: ch, class: "loops-taskbar" }),
            s("text", { x: freshX, y: freshBase + 30, "text-anchor": "middle", class: "loops-harness-cap" }, dg.freshContext2 || "into a fresh context"));

        // compaction loop — THREE separate orthogonal legs, each ending with its own
        // arrowhead, so memory and fresh-context read as real stations ON the path
        // (a line actually entering/exiting each shape) rather than boxes sitting beside
        // a line that merely passes their column. Flow: window's right edge → down into
        // memory's LID (write) → straight across, icon-height, into fresh context's SIDE
        // → out fresh context's LID → back into the window's right edge (rehydrate), a
        // little higher up. Both window-side jogs (95/112) sit ABOVE the existing tools→
        // window arrow's vertical run (x880, y166–352), so neither one crosses it —
        // that's what made the old route look tangled. Memory/fresh sit well below the
        // teal box's own "summarize/drift" labels (which end around y179), so the whole
        // write/rehydrate label column in between has a clean, uncontested lane.
        const compactToMem = [
            { x: winRX, y: 95 },     // leave the context window's right edge
            { x: memX, y: 95 },      // jog right, clear of the tools→window arrow above it
            { x: memX, y: memTop },  // down, landing INTO memory's lid — a real arrival
        ];
        // ONE straight horizontal arrow, icon-height, memory's right edge → fresh context's
        // left edge — a real station-to-station connection, no detour above or below.
        const memToFresh = [
            { x: memX + 19, y: memY },        // exit memory's right edge
            { x: freshX - 55, y: memY },      // land flush on fresh context's left edge
        ];
        const freshToWindow = [
            { x: freshX, y: freshTop },  // exit fresh context's lid
            { x: freshX, y: 112 },       // up, clear of the tools→window arrow, just below compactToMem's jog
            { x: winRX, y: 112 },        // jog left, landing back on the window's right edge
        ];
        put(gh, "harness", orthoConnector(compactToMem, ""), orthoConnector(memToFresh, ""), orthoConnector(freshToWindow, ""));

        // one clean column between the two verticals (x1110/x1290), running top to
        // bottom: write → failure/answer stack → rehydrate. Generous vertical gaps
        // throughout so nothing here ever touches the teal box's own labels above it
        // (end ~179) or the memory/fresh icons below it (start at memTop=405).
        const midX = (memX + freshX) / 2; // 1200
        put(gh, "harness", svgLines(midX, 210, ["write"], "loops-harness-note", 14, "middle"));
        put(gh, "harness", svgLines(midX, 250, ["full / rotting? →", "compact"], "loops-harness-note", 14, "middle"));
        // "context rot → goal drifts" does NOT belong here — it's a property of the live
        // context window, not data at rest on disk. That copy lives once, near the
        // context window itself (the `drift` element above); no duplicate in this column.
        put(gh, "harness", svgLines(midX, 296, ["↳ offload to disk,", "run survives"], "loops-harness-note", 14, "middle"));
        put(gh, "harness", svgLines(midX, 342, ["rehydrate"], "loops-harness-note", 14, "middle"));

        // tag the Model with the outer agent loop — purple base, shared green "loop" accent.
        // Deliberately the LAST content step (right before the bounding box), so it only
        // appears once every other harness primitive — task list, memory, compaction loop —
        // has already staggered in, instead of showing up before the picture exists.
        // Sits to the RIGHT of M.cx (not centred on it) so the task-list connector above
        // can run exactly down M.cx, and clear of "not what you wanted" / "tweak & send
        // again" (x238–560 at y452/480). Pushed below the teal box's own bottom (536), so
        // it sits in the harness's own purple territory instead of crowding the yellow
        // PROMPT ENGINEERING border.
        put(gh, "harness", s("text", { x: M.cx + 12, y: rowLabelY - 60, "text-anchor": "start", class: "loops-harness-cap" }, "↻ orchestration ", s("tspan", { class: "loops-kw" }, "loop")));

        // DEMARCATION — harness engineering is the outermost discipline: it wraps context
        // engineering (and everything nested inside it) entirely, with generous padding.
        putDemarcation(gh, "harness",
            s("rect", { x: 28, y: 14, width: 1362, height: 894, rx: 26, class: "loops-bound", stroke: ch, fill: hexToRgba(ch, 0.045) }),
            // label sits tight against the harness box's OWN top edge (not centred in the
            // 18–48 gap) so the remaining space reads as clear breathing room before the
            // teal box's border, instead of the two titles crowding each other
            s("text", { x: 38, y: 34, "text-anchor": "start", class: "loops-bound-label", fill: ch }, dg.harnessDiscipline || "harness engineering"));

        anims.harness = () => {
            const tl = gsap().timeline({ repeat: -1 });
            let doneCount = 0; // fresh each time the layer's animation (re)starts
            tl.add(() => travelDot(svg, taskConnPath, { color: ch, glow: GLOW.harness, speed: 200, layer: "harness" }), 0);
            // when the dot reaches the list, tick one more task off — cycling through all
            // of them, then clearing back to none, so "read next / mark done" visibly does
            // something each pass instead of just being a label
            tl.add(() => {
                doneCount = (doneCount + 1) % (taskGroups.length + 1);
                taskGroups.forEach((g, i) => g.classList.toggle("is-done", i < doneCount));
            }, 1.0);
            // compaction loop dot — three separate legs (the connecting points on memory/
            // fresh don't line up into one straight path, so one travelDot per leg, timed
            // back-to-back at a faster speed so the whole window→memory→fresh→window trip
            // reads as one continuous journey rather than three disconnected hops).
            tl.add(() => travelDot(svg, compactToMem, { color: ch, glow: GLOW.harness, speed: 500, layer: "harness" }), 0);
            tl.add(() => travelDot(svg, memToFresh, { color: ch, glow: GLOW.harness, speed: 500, layer: "harness" }), 1.6);
            tl.add(() => travelDot(svg, freshToWindow, { color: ch, glow: GLOW.harness, speed: 500, layer: "harness" }), 2.0);
            tl.to({}, { duration: 4.2 });
            return tl;
        };

        // ── LOOP: an outer loop wraps it all — scheduler, cycle, self-growth ──────
        const gl = layerG("loop"), cll = COLORS.loop;
        putDemarcation(gl, "loop", s("rect", { x: 10, y: 10, width: 1420, height: 1060, rx: 22, fill: "none", stroke: cll, class: "loops-loop-frame" }));
        put(gl, "loop", s("text", { x: M.cx, y: 50, "text-anchor": "middle", class: "loops-cap loops-cap-strong" }, dg.cycleLabel || "reason → act → check → repeat"));
        const fb = s("path", { d: `M ${mR} ${mB - 8} C ${mR + 110} ${mB + 96}, 300 648, 128 ${hy + 74} L 128 ${hy + 54}`, fill: "none", stroke: cll, class: "loops-feedback" });
        put(gl, "loop", fb, s("path", { d: `M 128 ${hy + 54} l -6 10 M 128 ${hy + 54} l 6 10`, fill: "none", stroke: cll, "stroke-width": 2, "stroke-linecap": "round" }));
        // scheduler + self-growth chips live below the harness band, in the newly grown canvas
        put(gl, "loop", clockGlyph(70, 980, cll, ""), s("text", { x: 70, y: 1016, "text-anchor": "middle", class: "loops-cap" }, dg.schedulerLabel || "a trigger wakes it up"));
        put(gl, "loop", s("text", { x: 470, y: 930, "text-anchor": "start", class: "loops-cap loops-cap-strong" }, (dg.growsLabel || "it grows itself") + ":"));
        const chips = (layers.find(l => l.id === "loop")?.chips) || [];
        let cxp = 470;
        chips.forEach(label => {
            const w = Math.max(120, label.length * 7.6 + 24), gg = s("g", {});
            gg.append(s("rect", { x: cxp, y: 946, width: w, height: 28, rx: 14, fill: "none", stroke: cll, class: "loops-chip-rect" }));
            gg.append(s("text", { x: cxp + w / 2, y: 965, "text-anchor": "middle", class: "loops-chip-svg-label" }, label));
            put(gl, "loop", gg); cxp += w + 14;
        });
        anims.loop = () => {
            const g = gsap(), tl = g.timeline({ repeat: -1 });
            let len = 1400; try { len = fb.getTotalLength(); } catch {}
            fb.style.strokeDasharray = "10 8";
            tl.fromTo(fb, { strokeDashoffset: len }, { strokeDashoffset: 0, duration: 4.2, ease: "none" }, 0);
            tl.to({}, { duration: 2.0 });
            return tl;
        };

        return { groups, steps, anims, demarcation };
    }

    // ── coda chart (unchanged): "why the outer loop wins" ────────────────────────
    function buildChart(cd) {
        const sec = el("section", { class: "loops-chart" });
        if (cd.eyebrow) sec.append(el("p", { class: "loops-chart-eyebrow", text: cd.eyebrow }));
        sec.append(el("h2", { class: "loops-chart-title", text: cd.title || "" }));
        if (cd.sub) sec.append(el("p", { class: "loops-chart-sub", text: cd.sub }));

        const legend = el("div", { class: "loops-chart-legend" });
        (cd.series || []).forEach(sr => {
            legend.append(el("span", { class: `loops-legend-item loops-legend--${sr.kind}` },
                el("span", { class: "loops-legend-swatch", "aria-hidden": "true" }), sr.label));
        });
        sec.append(legend);

        const VBW = 900, VBH = 430, x0 = 96, x1 = 864, yTop = 44, yBot = 356;
        const csvg = s("svg", { class: "loops-chart-svg", viewBox: `0 0 ${VBW} ${VBH}`, role: "img", "aria-label": cd.title || "quality versus attempt number" });
        const yv = v => yBot - (v / 100) * (yBot - yTop);
        [100, 50, 0].forEach((val, i) => {
            const yy = yv(val);
            csvg.append(s("line", { x1: x0, y1: yy, x2: x1, y2: yy, class: "loops-chart-grid" }));
            csvg.append(s("text", { x: x0 - 14, y: yy + 5, "text-anchor": "end", class: "loops-chart-ytick" }, (cd.yLabels && cd.yLabels[i]) || `${val}%`));
        });
        csvg.append(s("line", { x1: x0, y1: yTop, x2: x0, y2: yBot, class: "loops-chart-axis" }));
        csvg.append(s("text", { x: (x0 + x1) / 2, y: VBH - 12, "text-anchor": "middle", class: "loops-chart-xlabel" }, cd.xLabel || "attempt number →"));

        const paths = [], dots = [];
        (cd.series || []).forEach(sr => {
            const pts = sr.points || [], n = pts.length;
            const xx = i => x0 + (n <= 1 ? 0 : i * (x1 - x0) / (n - 1));
            const d = pts.map((v, i) => `${i ? "L" : "M"} ${xx(i).toFixed(1)} ${yv(v).toFixed(1)}`).join(" ");
            const path = s("path", { d, fill: "none", class: `loops-chart-line loops-line--${sr.kind}` });
            csvg.append(path); paths.push(path);
            pts.forEach((v, i) => { const c = s("circle", { cx: xx(i), cy: yv(v), r: 5, class: `loops-chart-pt loops-pt--${sr.kind}` }); csvg.append(c); dots.push(c); });
        });

        sec.append(el("div", { class: "loops-chart-plot" }, csvg));
        if (cd.takeaway) sec.append(el("p", { class: "loops-chart-take", text: cd.takeaway }));

        const animate = !REDUCE_MOTION;
        if (animate) {
            paths.forEach(p => { let L; try { L = p.getTotalLength(); } catch { L = 900; } p.style.strokeDasharray = L; p.style.strokeDashoffset = L; });
            dots.forEach(c => { c.style.opacity = "0"; });
        }
        let started = false;
        const play = () => {
            if (started) return; started = true;
            paths.forEach((p, i) => drawOn(p, { duration: 1.1, delay: i * 0.18 }));
            const g = gsap();
            if (animate && g) g.to(dots, { opacity: 1, duration: 0.3, stagger: 0.04, delay: 0.5, ease: "power1.out", clearProps: "opacity" });
            else dots.forEach(c => { c.style.opacity = "1"; });
        };
        if ("IntersectionObserver" in window) {
            const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { play(); io.disconnect(); } }), { threshold: 0.3 });
            io.observe(sec); observers.push(io);
        } else { play(); }
        return sec;
    }

    // ── tour ──────────────────────────────────────────────────────────────────────
    // Each layer gets enough time to actually watch its animation play through at
    // least once (not just the reveal) before auto-advancing — context is the richest
    // (gather → FULL → summarize → drift → reset) so it gets the longest dwell.
    const TOUR_DELAY = { prompt: 14000, context: 26000, harness: 16000, loop: 14000 };
    function tourStep() {
        if (focus >= layers.length - 1) { stopTour(); return; }
        focusLayer(focus + 1);
        tourTimer = setTimeout(tourStep, TOUR_DELAY[layers[focus].id] || 16000);
    }
    function startTour() {
        tourPlaying = true;
        tourBtn.classList.add("is-playing");
        tourBtn.textContent = `⏸ ${ui.pause || "Pause"}`;
        if (focus === layers.length - 1) focusLayer(0);
        tourTimer = setTimeout(tourStep, TOUR_DELAY[layers[focus].id] || 16000);
    }
    function stopTour() {
        tourPlaying = false;
        tourBtn.classList.remove("is-playing");
        tourBtn.textContent = `▶ ${ui.tour || "Tour"}`;
        if (tourTimer) { clearTimeout(tourTimer); tourTimer = null; }
    }
    tourBtn.addEventListener("click", () => (tourPlaying ? stopTour() : startTour()));

    // ── manual controls ────────────────────────────────────────────────────────────
    prevBtn.addEventListener("click", () => { stopTour(); focusLayer(focus - 1); });
    nextBtn.addEventListener("click", () => { stopTour(); focusLayer(focus + 1); });
    function onKey(e) {
        if (!lab.isConnected) return;
        if (e.key === "ArrowRight") { stopTour(); focusLayer(focus + 1); }
        else if (e.key === "ArrowLeft") { stopTour(); focusLayer(focus - 1); }
        else if (e.key === "Escape") {
            if (stageWrap.classList.contains("is-max")) toggleMax(false);
            else if (tourPlaying) stopTour();
        }
    }
    document.addEventListener("keydown", onKey);

    // ── entrance: mount the first (or deep-linked) scene once GSAP is ready ───────
    stopTour();
    whenGsap(() => {
        // deep-link: /engineering-loops/#context opens that scene on load
        const hid = (location.hash || "").replace(/^#/, "");
        const si = layers.findIndex(l => l.id === hid);
        focusLayer(si >= 0 ? si : 0);
    });

    return {
        destroy() {
            stopTour();
            clearAnim();
            LAYER_ORDER.forEach(stopLayerAnim);
            svg.querySelectorAll(".loops-dot").forEach(d => d.remove());
            document.body.style.overflow = "";
            observers.forEach(io => { try { io.disconnect(); } catch {} });
            document.removeEventListener("keydown", onKey);
            rootEl.replaceChildren();
        },
    };
}
