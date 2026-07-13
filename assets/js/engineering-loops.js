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
// loop = a clean blue — distinct from prompt's amber, context's teal, and harness's
// purple (the old loop green sat too close to context's teal at a glance)
const COLORS = { prompt: "#F2B138", context: "#00FFD1", harness: "#a78bfa", loop: "#4F9CFF" };
const MODEL_COLOR = "#E5E5E5"; // the Model anchor reads as neutral ink, distinct from any layer
const GLOW = {
    prompt: "rgba(242,177,56,0.9)",
    context: "rgba(0,255,209,0.95)",
    harness: "rgba(167,139,250,0.9)",
    loop: "rgba(79,156,255,0.9)",
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

// A self-contained "↻" glyph for the three "loop" labels (prompt/agent/orchestration).
// Renders "↻" as its OWN <text> sibling — not a <tspan> nested in the bigger label —
// because <tspan> doesn't reliably support transforms across engines (Firefox in
// particular); a standalone <text> is universally transformable, same as every other
// glyph in this file (clockGlyph/personGlyph/targetGlyph are never inline embellishments).
// Also draws two small staggered "ping" rings around it, colored to that label's own
// layer accent — reinforces both "this repeats" and "draws the eye" without borrowing
// the loop layer's own blue, which is reserved for that layer specifically.
//
// Both effects are self-contained, infinite GSAP tweens started ONCE here and never
// touched again — deliberately NOT nested inside any layer's own anims.<id> timeline.
// Every anims.<id> timeline is already repeat:-1 itself, and an infinite child tween
// living inside an infinite parent gets reset every time the PARENT wraps back to its
// own start (GSAP re-syncs child tween position to the parent's playhead on repeat) —
// that would make the glyph visibly snap/jump once per layer cycle. Living outside
// that lifecycle entirely (independent of startLayerAnim/stopLayerAnim/playAdditive)
// avoids that, at the cost of the tweens ticking even while hidden behind a parent
// step group's opacity:0 — cheap, and no different from how travelDot already runs
// happily under REDUCE_MOTION/no-gsap guards.
//
// Always start-anchored internally (regardless of how the caller's own trailing label
// text is anchored) so callers can reason about a single fixed advance — see
// LOOP_GLYPH_ADVANCE below — instead of the anchor-dependent math that caused the
// glyph and label to overlap when both were centre-anchored near each other. The ring
// is centred on the glyph's approximate visual midpoint (x + fontSize*0.32), not on
// the raw start-anchor x itself, so it hugs the character instead of sitting shifted
// to its left.
//
// Tweens are stashed on the returned node (`g._tweens`) so destroy() can kill them —
// the one piece of new animation lifecycle this feature introduces that isn't already
// covered by stopLayerAnim/activeAnims.
const LOOP_GLYPH_ADVANCE = 20; // x-distance from a loopGlyph's start x to where the caller's trailing label text should begin

// Single source of truth for every discipline title + tagline pair (prompt/context/harness/
// loop) — each DEMARCATION box positions its title and tagline relative to its own top-left
// corner using these, instead of each layer repeating its own "+12"/"+28"/"+50" literals.
// That repetition is exactly what let prompt's numbers drift out of sync with the other
// three in the past; pulling from one constant makes that class of bug impossible.
const SECTION_LABEL_PAD_X = 12;  // left inset of the title (and tagline, same x) from the box's own left border
const SECTION_LABEL_Y = 28;      // title baseline, down from the box's own top border
const SECTION_TAGLINE_Y = 50;    // tagline baseline, down from the box's own top border (22px under the title)
function loopGlyph(x, y, { fontSize = 15, cls = "", ringColor } = {}) {
    const g = s("g", { class: "loops-loop-glyph-wrap" });
    const ringCx = x + fontSize * 0.32, ringCy = y - fontSize * 0.32;
    const ring1 = s("circle", { cx: ringCx, cy: ringCy, r: fontSize * 0.5, class: "loops-loop-ring" });
    const ring2 = ring1.cloneNode(true);
    ring2.style.animationDelay = "1.1s"; // stagger the two ping rings into a double-pulse
    if (ringColor) { ring1.style.stroke = ringColor; ring2.style.stroke = ringColor; }
    const glyph = s("text", { x, y, "text-anchor": "start", class: `loops-loop-glyph ${cls}`, "font-size": fontSize }, "↻");
    g.append(ring1, ring2, glyph);
    // Motion is CSS-driven (see .loops-loop-glyph / .loops-loop-ring keyframes), NOT GSAP.
    // GSAP writes an inline transform matrix that overrides the element's CSS
    // transform-box/-origin, and its percentage transformOrigin measures getBBox() at
    // init — which returns empty while the layer is still opacity:0, so the pivot fell
    // back to the SVG origin (0,0) and the glyph orbited the whole canvas. A CSS animation
    // with `transform-box: fill-box; transform-origin: center` resolves the pivot at paint
    // time against the element's own box, so it always spins in place. It also lets the
    // Pause button freeze it via `animation-play-state` (see .loops-lab.is-paused). Empty
    // _tweens keeps destroy()'s `n._tweens?.forEach(t => t.kill())` a harmless no-op.
    g._tweens = [];
    return g;
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
        // Explicit so the height-capped inline stage (see .loops-svg max-height) always
        // scales the drawing to fit and centres it, rather than clipping/overflowing.
        preserveAspectRatio: "xMidYMid meet",
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
        resetZoom(); // fresh 1x every time the overlay opens or closes
    }
    maxBtn.addEventListener("click", () => toggleMax());

    // zoom + pan — layered on TOP of the Expand overlay's existing fit-to-viewport
    // scaling (max-width/max-height in CSS), so this zooms INTO that fitted view rather
    // than replacing it. Only active while .is-max — the small inline diagram doesn't
    // need it. transform (not viewBox) so it's independent of the per-layer viewBox
    // animation `setViewBox()` already runs.
    const ZOOM_MIN = 1, ZOOM_MAX = 4;
    let zoom = { scale: 1, tx: 0, ty: 0 };
    function applyZoom() {
        svg.style.transform = `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`;
        stageWrap.classList.toggle("is-zoomed", zoom.scale > 1.001);
    }
    function clampPan() {
        // bound tx/ty so the content can't be dragged/pinched fully out of view —
        // derive the pre-transform box size from the live (already-scaled) rect
        const rect = svg.getBoundingClientRect();
        const baseW = rect.width / zoom.scale, baseH = rect.height / zoom.scale;
        const maxX = (baseW * (zoom.scale - 1)) / 2, maxY = (baseH * (zoom.scale - 1)) / 2;
        zoom.tx = Math.max(-maxX, Math.min(maxX, zoom.tx));
        zoom.ty = Math.max(-maxY, Math.min(maxY, zoom.ty));
    }
    function resetZoom() {
        zoom = { scale: 1, tx: 0, ty: 0 };
        applyZoom();
    }
    // cx/cy: viewport coords of the point that should stay visually fixed while zooming
    // (cursor position for wheel, box center for the +/- buttons)
    function zoomBy(factor, cx, cy) {
        const rect = stageWrap.getBoundingClientRect();
        const prevScale = zoom.scale;
        const nextScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prevScale * factor));
        if (nextScale === prevScale) return;
        const originX = cx - (rect.left + rect.width / 2), originY = cy - (rect.top + rect.height / 2);
        const ratio = nextScale / prevScale;
        zoom.tx = originX - (originX - zoom.tx) * ratio;
        zoom.ty = originY - (originY - zoom.ty) * ratio;
        zoom.scale = nextScale;
        clampPan();
        applyZoom();
    }
    stageWrap.addEventListener("wheel", e => {
        if (!stageWrap.classList.contains("is-max")) return;
        e.preventDefault();
        zoomBy(Math.exp(-e.deltaY * 0.0018), e.clientX, e.clientY);
    }, { passive: false });

    // single-pointer drag pans (once zoomed in); two-pointer pinch zooms — one Map of
    // active pointers backs both gestures, matching the shared vanilla pointer-events
    // pattern (no library) rather than separate mouse/touch code paths
    const activePointers = new Map();
    let dragState = null, pinchState = null;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    stageWrap.addEventListener("pointerdown", e => {
        if (!stageWrap.classList.contains("is-max") || e.target.closest("button")) return;
        stageWrap.setPointerCapture(e.pointerId);
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (activePointers.size === 2) {
            const [a, b] = [...activePointers.values()];
            pinchState = { startDist: dist(a, b), startScale: zoom.scale, startTx: zoom.tx, startTy: zoom.ty };
            dragState = null;
        } else if (activePointers.size === 1 && zoom.scale > 1.001) {
            dragState = { startX: e.clientX, startY: e.clientY, startTx: zoom.tx, startTy: zoom.ty };
            stageWrap.classList.add("is-dragging");
        }
    });
    stageWrap.addEventListener("pointermove", e => {
        if (!activePointers.has(e.pointerId)) return;
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinchState && activePointers.size === 2) {
            const [a, b] = [...activePointers.values()];
            zoom.scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinchState.startScale * (dist(a, b) / pinchState.startDist)));
            zoom.tx = pinchState.startTx; zoom.ty = pinchState.startTy;
            clampPan(); applyZoom();
        } else if (dragState && activePointers.size === 1) {
            zoom.tx = dragState.startTx + (e.clientX - dragState.startX);
            zoom.ty = dragState.startTy + (e.clientY - dragState.startY);
            clampPan(); applyZoom();
        }
    });
    function releasePointer(e) {
        activePointers.delete(e.pointerId);
        if (activePointers.size < 2) pinchState = null;
        if (activePointers.size === 0) { dragState = null; stageWrap.classList.remove("is-dragging"); }
    }
    stageWrap.addEventListener("pointerup", releasePointer);
    stageWrap.addEventListener("pointercancel", releasePointer);

    // +/-/reset buttons — wheel/pinch alone is easy to miss, especially for
    // keyboard/non-pointer users
    const zoomInBtn = el("button", { class: "loops-zoom-btn loops-zoom-in", type: "button", "aria-label": "Zoom in" }, "+");
    const zoomOutBtn = el("button", { class: "loops-zoom-btn loops-zoom-out", type: "button", "aria-label": "Zoom out" }, "−");
    const zoomResetBtn = el("button", { class: "loops-zoom-btn loops-zoom-reset", type: "button", "aria-label": "Reset zoom" }, "⟲");
    stageWrap.append(el("div", { class: "loops-zoom-controls" }, zoomOutBtn, zoomResetBtn, zoomInBtn));
    const centerOf = () => { const r = stageWrap.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    zoomInBtn.addEventListener("click", () => zoomBy(1.4, ...centerOf()));
    zoomOutBtn.addEventListener("click", () => zoomBy(1 / 1.4, ...centerOf()));
    zoomResetBtn.addEventListener("click", resetZoom);

    // controls --------------------------------------------------------------------
    const prevBtn = el("button", { class: "loops-btn loops-prev", type: "button" }, "‹ " + (ui.prev || "Prev"));
    const nextBtn = el("button", { class: "loops-btn loops-next", type: "button" });
    const pauseBtn = el("button", { class: "loops-btn loops-pause", type: "button" }, `⏸ ${ui.pause || "Pause"}`);
    const tourBtn = el("button", { class: "loops-btn loops-tour", type: "button" });
    const dots = el("div", { class: "loops-dots", role: "tablist", "aria-label": "Layers" });
    const dotEls = layers.map((l, i) => {
        const d = el("button", { class: "loops-dot-btn", type: "button", role: "tab", "aria-label": `${l.n} · ${l.title}` });
        d.addEventListener("click", () => { ensureResumed(); stopTour(); focusLayer(i); });
        dots.append(d);
        return d;
    });
    const controls = el("div", { class: "loops-controls" }, prevBtn, dots, nextBtn, pauseBtn, tourBtn);

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
    let tourOnLayerDone = null; // set by scheduleTour(); fired once by playAdditive's onDone when narration drives the tour
    let paused = false; // global freeze: GSAP timeline + CSS glyph animations + narration audio/captions
    let started = false; // flips true on deep-link entry or the Begin click below — gates keyboard nav so ArrowRight/Left can't jump the gate
    let narration = null;
    if (content.layers.some(l => l.narration?.length)) {
        const _v = new URL(import.meta.url).searchParams.get("v") || "";
        const _p = `./engineering-loops-narration.js${_v ? `?v=${_v}` : ""}`;
        import(_p).then(({ createNarration }) => {
            narration = createNarration({ content, ui });
            narration.mount(controls);
        }).catch(err => console.warn("[engineering-loops] narration load failed", err));
    }

    // ── dynamic canvas: the viewBox tracks how much is actually on screen, so the
    // scene starts small (just the prompt ring) and visibly grows as each layer adds
    // its territory — instead of rendering the full 1440×1080 canvas from step one
    // with the early rings floating in a mostly-empty frame. Each box is [x,y,w,h],
    // padded a little past that layer's own DEMARCATION rect. Since .loops-svg is
    // `height: auto` off a fixed width, animating the viewBox also animates the
    // rendered height — the container itself grows/shrinks, not just an inner zoom.
    const STAGE_VB = {
        prompt: [36, 196, 666, 340],    // prompt DEMARCATION rect: x76 y236 w586 h260, +40 pad
        context: [18, 50, 1088, 526],   // context DEMARCATION rect: x58 y90 w968 h446, +40 pad
        harness: [8, 0, 1404, 864],     // harness DEMARCATION rect: x28 y14 w1362 h838, +~14 pad
        loop: [-30, -98, 1478, 1072],   // loop DEMARCATION rect: x-16 y-84 w1450 h1044, +14 pad — canvas grew up/right/down to fit the new outer frame around harness
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
        // loop is the last layer — there's no "layer you've passed" case for it, so this
        // only ever fires once its own animation has genuinely played through one full
        // cycle while focused (never force-revealed early, unlike the other three). That's
        // exactly the gate the coda chart below wants: don't show it until the loop stage
        // itself is done, not just scrolled past.
        if (id === "loop") chartSection?._reveal?.();
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
        narration?.stopLayer();
    }

    // Additive reveal: every layer up to `i` stays visible AND KEEPS ANIMATING; layers
    // past `i` hide entirely; the just-activated layer's step groups fade in (step by
    // step) and starts looping. Every prior stage's loop keeps running no matter which
    // later stage is focused — harness and loop used to go still the moment you moved
    // past them (only prompt/context were exempted as "the throughline"), which read as
    // "the animation doesn't work" since two of the four layers would visibly freeze as
    // soon as you advanced. Now the whole picture stays alive as it grows outward.
    function playAdditive(i) {
        const g = gsap();
        LAYER_ORDER.forEach((id, k) => {
            const grp = refs.groups[id];
            if (!grp) return;
            if (k < i) {
                grp.style.opacity = "1";
                grp.style.pointerEvents = "";
                (refs.steps[id] || []).forEach(st => (st.style.opacity = ""));
                // idempotent: a no-op if it's already mid-loop, so it's never interrupted
                startLayerAnim(id);
                // safety net: a layer you've already moved past must never be left with
                // its outer boundary permanently missing just because you clicked away
                // before its first animation cycle finished — EXCEPT harness, which should
                // only close its box around the mechanism once you've actually watched it
                // run at least once (task list / memory / write-rehydrate / orchestration
                // loop). harness's timeline keeps running in the background regardless (see
                // startLayerAnim above), so its own onRepeat callback still fires and reveals
                // it a few seconds later — it just isn't forced instantly like the others.
                if (id !== "harness") revealDemarcation(id, false);
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
            narration?.showAllCaptions(curId, flat);
            startAnim();
            return;
        }
        g.set(flat, { opacity: 0 });
        const dur = 0.6;
        const stagger = Math.min(1.3, Math.max(0.85, 7 / flat.length));
        // Quick staggered reveal, then start the layer's mechanism loop right after it lands.
        // This runs the same with or without narration: when narration is present it plays
        // audio + running-subtitle captions OVER this reveal, so the diagram animates LIVE
        // while the voice describes it. (Previously the mechanism only started after the
        // voice finished, so the two felt out of sync.) Starting the loop after the reveal —
        // not during — guarantees its travel-dot endpoints exist before any dots move.
        revealTl = g.to(flat, {
            opacity: 1, duration: dur, stagger, ease: "power2.out",
            onComplete() { flat.forEach(st => (st.style.opacity = "")); },
        });
        // capped — with more reveal steps (harness/loop grew to 8 as their stories were
        // added) this uncapped would stretch past 6-7s before the loop animation ever
        // started; the LAST layer has no "moved past it" fallback to catch a start that
        // never fired, so keep this bounded regardless of how many steps a layer has
        const revealDur = Math.min(stagger * (flat.length - 1) + dur + 0.25, 3.2);
        pendingStart = g.delayedCall(revealDur, startAnim);
        // Narration (when present) rides on top: audio + running-subtitle captions only, no
        // per-line visual gating. When the voice finishes, cue that the user can advance and
        // let the tour advance if it's driving.
        if (narration) {
            narration.playLayer(curId, flat, {
                onDone() { showReady(); const cb = tourOnLayerDone; tourOnLayerDone = null; cb?.(); },
                // The final layer finishing = the whole lab is done, so clear the caption panel.
                // Any restart / fresh start / navigation re-runs playLayer, which brings it back.
                hideOnDone: i === LAYER_ORDER.length - 1,
            });
        }
    }

    // "You're caught up — advance when ready": pulse Next once a layer's narration finishes.
    // Skipped during Tour (it auto-advances). Cleared by focusLayer on the next navigation.
    function showReady() {
        if (tourPlaying) return;
        nextBtn.classList.add("is-ready");
    }

    let hasFocusedOnce = false;
    function focusLayer(i) {
        focus = (i + layers.length) % layers.length;
        const layer = layers[focus];
        nextBtn.classList.remove("is-ready"); // clear any prior "ready to advance" cue
        dotEls.forEach((d, k) => {
            d.classList.toggle("is-active", k === focus);
            d.setAttribute("aria-selected", k === focus ? "true" : "false");
        });
        nextBtn.textContent = focus === layers.length - 1 ? `↺ ${ui.restart || "Restart"}` : `${ui.next || "Next"} ›`;
        clearAnim();
        resetZoom(); // a stale pan/zoom offset from the previous layer's geometry would look wrong once the viewBox below changes
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
        put(gp, "prompt",
            arc,
            loopGlyph(150, yTop - 16, { cls: "loops-cap", ringColor: GLOW.prompt }),
            s("text", { x: 150 + LOOP_GLYPH_ADVANCE, y: yTop - 16, "text-anchor": "start", class: "loops-cap" }, s("tspan", { class: "loops-cap-strong" }, "prompt "), s("tspan", { class: "loops-kw" }, "loop")));
        // DEMARCATION — prompt engineering encloses the human loop AND the Model (the
        // discipline reaches as far as the Model it's steering), with real breathing
        // room between the box border and its content on every side. Top edge raised
        // from 260→236 (bottom held at 496, height grown to match) so the title+tagline
        // block gets more clearance above the Model box (mT=320) and the "prompt loop"
        // label row below it, instead of nearly touching them.
        const pBoxY = 236;
        putDemarcation(gp, "prompt",
            s("rect", { x: 76, y: pBoxY, width: mR + 28 - 76, height: 496 - pBoxY, rx: 18, class: "loops-bound", stroke: cp, fill: hexToRgba(cp, 0.055) }),
            // label offset from the box's own top-left corner: +12/+28, same as every
            // other discipline label (context/harness/loop) — keeps the four nested
            // titles visually aligned/symmetric instead of each sitting at its own
            // ad-hoc indent
            s("text", { x: 76 + SECTION_LABEL_PAD_X, y: pBoxY + SECTION_LABEL_Y, "text-anchor": "start", class: "loops-bound-label", fill: cp }, dg.promptDiscipline || "prompt engineering"),
            // 4-step cadence, same style/position/format as the loop layer's own tagline
            s("text", { x: 76 + SECTION_LABEL_PAD_X, y: pBoxY + SECTION_TAGLINE_Y, "text-anchor": "start", class: "loops-layer-tagline", fill: cp }, dg.promptCycleLabel || "ask → observe → judge → refine"));
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
        const ww = 340, wh = 120, wx = M.cx - ww / 2, wy = 100, wb = wy + wh;   // small, centred above the Model — a bit taller so each tile can carry its own label. wy moved 84→100 alongside cBoxY below, in lockstep, so the window keeps the same ~10px gap from the box's own top border while that border itself gains room from harness above it
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
        const loopLabelGlyph = loopGlyph(704, 300, { cls: "loops-cap loops-cap-strong loops-agentloop", ringColor: GLOW.context });
        loopLabelGlyph.style.opacity = REDUCE_MOTION ? "1" : "0";
        const loopLabel = s("text", { x: 704 + LOOP_GLYPH_ADVANCE, y: 300, "text-anchor": "start", class: "loops-cap loops-cap-strong loops-agentloop" }, "agent ", s("tspan", { class: "loops-kw" }, "loop"));
        loopLabel.style.opacity = REDUCE_MOTION ? "1" : "0";
        gc.append(loopLabelGlyph, loopLabel);
        // "summarize" sits to the LEFT of the window instead — the right side is
        // where the tools→window arrow, the compaction loop's write/rehydrate legs, and
        // "tools + resources" all converge, so text there just adds to the clutter. The
        // left side (above the prompt box, which only starts at y236) is open space.
        const lcy = wy + wh / 2;
        // window flashes "Context Rot" (not "FULL!") when it fills — the alarm itself now
        // names the actual failure mode directly, so the separate "context rot → goal
        // drifts" caption underneath was redundant and has been removed.
        const full = s("text", { x: wx + ww - 18, y: wy + 30, "text-anchor": "end", class: "loops-ctx-full" }, dg.contextFullLabel || "Context Rot");
        // pushed down from lcy-18 to lcy+6 — with the discipline tagline now sitting at
        // the box's own y+50 (see cBoxY below), the old position sat only ~10px under it
        // and horizontally overlapped its tail end ("...inject → compact"); this clears both.
        const summ = svgLines(wx - 16, lcy + 6, splitAtArrow(dg.contextSummarize || "summarize → lost in the middle"), "loops-ctx-step loops-ctx-summ", 15, "end");
        full.style.opacity = "0";
        summ.style.opacity = REDUCE_MOTION ? "1" : "0";
        gc.append(full, summ);
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
        // top edge pulled down again, 74→90 (bottom held at 536, height trimmed to
        // match) — the previous ~10px gap from harness's tagline above still read as
        // too tight in practice. wy (the context window's own top, above) moved down
        // by the same 16px so its ~10px gap from THIS border is preserved rather than
        // traded away; the harness-side gap is now ~26px.
        const cBoxY = 90;
        putDemarcation(gc, "context",
            s("rect", { x: 58, y: cBoxY, width: 968, height: 536 - cBoxY, rx: 22, class: "loops-bound", stroke: cc, fill: hexToRgba(cc, 0.055) }),
            // same +12/+28 offset from the box's own corner as every other discipline label
            s("text", { x: 58 + SECTION_LABEL_PAD_X, y: cBoxY + SECTION_LABEL_Y, "text-anchor": "start", class: "loops-bound-label", fill: cc }, dg.contextDiscipline || "context engineering"),
            // 4-step cadence, same style/position/format as the loop layer's own tagline
            s("text", { x: 58 + SECTION_LABEL_PAD_X, y: cBoxY + SECTION_TAGLINE_Y, "text-anchor": "start", class: "loops-layer-tagline", fill: cc }, dg.contextCycleLabel || "select → structure → inject → compact"));
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
                    g.fromTo(loopLabelGlyph, { opacity: 0, scale: 0.6, transformOrigin: "left center" }, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(2.2)" });
                }
                revealDemarcation("context", true);
            });
            // dwell so "summarize → detail lost" and the window's own "Context Rot" flash
            // both actually get read before reset — no separate drift phase anymore
            tl.to({}, { duration: 1.8 });
            // reset & loop — Model reads the window (window → Model), then the agent loop runs again
            tl.add(() => travelDot(svg, [{ x: M.cx, y: wb + 2 }, { x: M.cx, y: mT }], { color: cc, glow: GLOW.context, speed: 200, layer: "context" }), ">-0.2");
            tl.to([summ, ...docs, ...docLabels], { opacity: 0, duration: 0.5 }); // loopLabel stays — see above
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
                g.set(summ, { opacity: 0 }); // loopLabel stays — see above
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

        // the durable-state artifacts reveal ONE AT A TIME, in the order a reader should
        // actually follow them — not all three bundled into a single step (which was the
        // bug: everything popped in at once with no sense of sequence). Each put() call
        // below is its own stagger beat: 1) the task list exists  2) the Model drives it
        // 3) memory on disk  4) fresh context — then the compaction loop's three edges
        // (write / rehydrate / close) each get their own beat further down, so the whole
        // layer reads as a story instead of a snapshot.
        put(gh, "harness", ...taskNodes);
        put(gh, "harness",
            orthoConnector(taskConnPath, ""),
            svgLines(M.cx - 18, rowLabelY - 60, ["read next / mark done"], "loops-harness-note", 14, "end"));
        put(gh, "harness",
            memoryGlyph(memX, memY, ch, ""),
            s("text", { x: memX, y: memBase + 30, "text-anchor": "middle", class: "loops-harness-cap" }, dg.memoryLabel || "memory on disk"),
            // small muted caption directly under the node — what the write buys you
            svgLines(memX, memBase + 46, ["persists across runs"], "loops-harness-caption", 12, "middle"));
        put(gh, "harness",
            s("rect", { x: freshX - 55, y: freshTop, width: 110, height: 26, rx: 6, fill: "none", stroke: ch, class: "loops-taskbar" }),
            s("text", { x: freshX, y: freshBase + 30, "text-anchor": "middle", class: "loops-harness-cap" }, dg.freshContext2 || "fresh context"));

        // compaction loop — a CLOSED three-station cycle, routed as three NON-CROSSING
        // vertical lanes on the right side (innermost to outermost):
        //   Lane A — the agent loop's own tool-result return (elbowUpThenLeft above,
        //            landing at wy+wh/2 / running at x880) — untouched, just kept clear of.
        //   Lane B — the WRITE edge: window → memory. Its jog off the window (y120) sits
        //            BELOW Lane C's, and its vertical descent runs at x=memX.
        //   Lane C — the "becomes the next window" RETURN edge: fresh context → window.
        //            Its jog off the window (y104) sits ABOVE Lane B's, and its vertical
        //            run climbs at x=freshX — one column further out than Lane B's, so
        //            the two verticals never share an x, and Lane C's horizontal (y104)
        //            passes OVER Lane B's vertical (which only starts at y120) instead of
        //            cutting through it. That ordering — C's jog above B's — is what
        //            actually prevents the crossing; swap it back and they tangle again.
        // Both jogs (104/120) still sit well above Lane A's vertical run (x880, y166–352).
        // Lane B/C jogs (120/104 below) sit just inside the window's own top edge (wy=100)
        // — they're +16 from their original 104/88, matching wy's own 84→100 move earlier
        // (context box gained breathing room from harness above it). Without this they'd
        // land 12-16px ABOVE the window's new top edge instead of on its right edge.
        const compactToMem = [
            { x: winRX, y: 120 },    // leave the context window's right edge (Lane B)
            { x: memX, y: 120 },     // jog right — BELOW Lane C's jog, so C's horizontal clears this vertical
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
            { x: freshX, y: 104 },       // up — ABOVE Lane B's jog (120), so this horizontal never crosses Lane B's vertical
            { x: winRX, y: 104 },        // jog left, landing back on the window's right edge — closes the loop
        ];
        // write — its own beat: the edge, its guard, and its verb land together (they're
        // one idea: WHEN it writes and the fact that it writes), but separately from
        // rehydrate/close below so the compaction loop reads left-to-right in order.
        put(gh, "harness",
            orthoConnector(compactToMem, ""),
            // guard, pinned tight to the write edge's tail (winRX,120 — the exact point
            // the line leaves the window) — 16px directly below that point, hugging the
            // short horizontal jog itself rather than floating up near Lane C (y104). One
            // line (fits well inside the 395px run to memX) so it reads as a single note
            // sitting ON that jog, not a separate block drifting away from it.
            svgLines(winRX + 10, 136, ["full / rotting? → compact"], "loops-harness-guard", 13, "start"),
            // "write" — the verb, ON the edge (its long vertical leg down into memory's lid)
            svgLines(memX + 14, 254, ["write"], "loops-harness-note", 14, "start"));
        // rehydrate — memory feeds the fresh context
        put(gh, "harness",
            orthoConnector(memToFresh, ""),
            svgLines((memX + 19 + freshX - 55) / 2, memY - 12, ["rehydrate"], "loops-harness-note", 14, "middle"));
        // close — the return leg, last of the three edges, since it's the one that makes
        // the other two read as a LOOP instead of a one-way trip
        put(gh, "harness",
            orthoConnector(freshToWindow, "loops-return-dash"),  // solid, like every other connector — the "silent" leg made visible as the loop's own close
            // muted caption ON Lane C's own vertical run (not the horizontal jog it shares
            // visual space with near the window), so it unambiguously belongs to that arrow
            svgLines(freshX - 14, 170, ["becomes the next", "window"], "loops-harness-caption", 15, "end"));

        // tag the Model with the outer agent loop — purple base, shared green "loop" accent.
        // Deliberately the LAST content step (right before the bounding box), so it only
        // appears once every other harness primitive — task list, memory, compaction loop —
        // has already staggered in, instead of showing up before the picture exists.
        // Sits to the RIGHT of M.cx (not centred on it) so the task-list connector above
        // can run exactly down M.cx, and clear of "not what you wanted" / "tweak & send
        // again" (x238–560 at y452/480). Pushed below the teal box's own bottom (536), so
        // it sits in the harness's own purple territory instead of crowding the yellow
        // PROMPT ENGINEERING border.
        put(gh, "harness",
            loopGlyph(M.cx + 12, rowLabelY - 60, { cls: "loops-harness-cap", ringColor: GLOW.harness }),
            // tighter advance than LOOP_GLYPH_ADVANCE (14 vs 20) — the default gap read as
            // too wide once seen rendered next to "orchestration loop"
            s("text", { x: M.cx + 12 + 14, y: rowLabelY - 60, "text-anchor": "start", class: "loops-harness-cap" }, s("tspan", { class: "loops-cap-strong" }, "orchestration "), s("tspan", { class: "loops-kw" }, "loop")));

        // DEMARCATION — harness engineering is the outermost discipline: it wraps context
        // engineering (and everything nested inside it) entirely, with generous padding.
        // Height trimmed from 894 to 838 — the old bottom edge left ~84px of dead space
        // below the last task row (deploy, bottom at y824); now ~28px, in line with the
        // paddings used elsewhere in this diagram.
        putDemarcation(gh, "harness",
            s("rect", { x: 28, y: 14, width: 1362, height: 838, rx: 26, class: "loops-bound", stroke: ch, fill: hexToRgba(ch, 0.045) }),
            // same +12/+28 offset from the box's own corner as every other discipline
            // label — was 10/20 here, close but not identical, which is exactly what
            // made the four titles read as unaligned against each other
            s("text", { x: 28 + SECTION_LABEL_PAD_X, y: 14 + SECTION_LABEL_Y, "text-anchor": "start", class: "loops-bound-label", fill: ch }, dg.harnessDiscipline || "harness engineering"),
            // 4-step cadence, same style/position/format as the loop layer's own tagline
            s("text", { x: 28 + SECTION_LABEL_PAD_X, y: 14 + SECTION_TAGLINE_Y, "text-anchor": "start", class: "loops-layer-tagline", fill: ch }, dg.harnessCycleLabel || "orchestrate → execute → evaluate → recover"));

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

        // ── LOOP: the outermost discipline — wraps harness (and everything nested
        // inside it) entirely. Where harness/context/prompt loops all TERMINATE (a
        // task list empties, a context window resets, a human stops retrying), this
        // one doesn't: an autonomous trigger starts a run, harness executes it, and
        // finishing feeds back around to the next trigger — open-ended by design.
        const gl = layerG("loop"), cll = COLORS.loop;
        // encloses harness (28,14)–(1390,852) with an even ~44px margin on the sides,
        // extra room at the top for the discipline label + its subtitle, and a bottom
        // band for the self-improvement chips. Canvas grows to fit this (see
        // STAGE_VB.loop) rather than shrinking the harness box. Height trimmed again,
        // 1100 → 1044, following harness's own bottom edge moving up by the same 56px
        // (the chip row above shifted up to match, so the gap below it is unchanged).
        const lf = { x: -16, y: -84, w: 1450, h: 1044 };
        // operating cadence, as the outer loop's own subtitle — directly under its name.
        // NOT "reason → act → check → repeat" (that's the ReAct/agent-loop pattern,
        // already drawn one level in as harness's own "↻ agent loop") — this outer
        // cycle is distinct: a trigger fires a run, harness executes it, the result
        // gets verified and persisted (memory on disk / task list), then the next
        // trigger fires. Single line, matching the other three disciplines' own taglines
        // (harness's "orchestrate → execute → evaluate → recover" is comparably long and
        // already fits on one line at this same size) — the old two-line wrap predates
        // that consistency pass and just left this one tagline looking mismatched.
        const cycleLabel = dg.cycleLabel || "trigger → run → verify → persist → repeat";
        const cycleText = s("text", { x: lf.x + SECTION_LABEL_PAD_X, y: lf.y + SECTION_TAGLINE_Y, "text-anchor": "start", class: "loops-layer-tagline", fill: cll }, cycleLabel);
        putDemarcation(gl, "loop",
            s("rect", { x: lf.x, y: lf.y, width: lf.w, height: lf.h, rx: 28, class: "loops-bound", stroke: cll, fill: hexToRgba(cll, 0.035) }),
            s("text", { x: lf.x + SECTION_LABEL_PAD_X, y: lf.y + SECTION_LABEL_Y, "text-anchor": "start", class: "loops-bound-label", fill: cll }, dg.loopDiscipline || "loop engineering"),
            cycleText);
        // the top band (supervisor/trigger/problem row below) used to start at a fixed
        // x=300 — fine while the tagline above wrapped to 2 short lines, but now that it's
        // single-line (see above) a long cycleLabel can run right under the supervisor's
        // icon. Measure the tagline's REAL rendered width (not a guessed pixel count — see
        // the hint-arrow measurement below for why guessing here has already gone wrong
        // twice) and push the whole row right only as far as actually needed to clear it.
        const cycleTextEndX = (lf.x + SECTION_LABEL_PAD_X) + cycleText.getComputedTextLength();
        // clamped at 100 — the problem callout (below) sits at the right end of this same
        // row and must stay inside the loop box's right edge (lf.x+lf.w=1434); its rect
        // currently ends at x1320, so 100 is the most it can shift without crowding that
        // border, regardless of how long the tagline turns out to be.
        const rowShift = Math.min(100, Math.max(0, (cycleTextEndX + 40) - 300));
        // the organizing axis for this whole band is HUMAN-INITIATED → SELF-INITIATED
        // (not "guided vs autonomous" — the inner agent/orchestration loops are already
        // autonomous within a run). Left to right: the human moves OUTSIDE the loop to
        // supervise, the problem this layer solves, then the trigger that replaces the
        // human as initiator.

        // ROW_Y anchors all four top-band pieces (discipline title, supervisor, trigger,
        // problem callout) on the SAME horizontal line — matches the title's own baseline
        // (lf.y+28) exactly, so the row reads as one aligned line instead of each piece
        // sitting at its own ad-hoc height. Icons are vertically CENTRED on it; each
        // block's own first text line SITS on it (same convention the title itself uses).
        const ROW_Y = lf.y + 28;

        // supervisor — a small, simple glyph (not the full stick figure PROMPT ENGINEERING
        // uses for the human IN the loop) sitting outside harness in the top band, tethered
        // by a thin DASHED line with no arrowhead — reads as watching, not driving. This is
        // the deliberate visual contrast: human IN the loop (prompt, deep inside, drives
        // every turn) vs human ON the loop (out here, sets policy and gets alerted).
        const roleParts = (dg.loopSupervisorRole || "sets policy, reviews, gets alerted").split(", ");
        const supLines = [
            dg.loopSupervisorLabel || "human on the loop:",
            roleParts.slice(0, -1).join(", ") + ",",  // "sets policy, reviews,"
            roleParts[roleParts.length - 1],          // "gets alerted"
        ];
        const supCx = 300 + rowShift, supTextX = 325 + rowShift;
        const supText = svgLines(supTextX, ROW_Y, supLines, "loops-cap", 14, "start");
        put(gl, "loop",
            personGlyph(supCx, ROW_Y, cll, ""),
            s("line", { x1: supCx, y1: ROW_Y + 29, x2: supCx, y2: 14, class: "loops-supervise-line" }),
            supText);
        // entry point — the autonomous trigger that starts a run WITHOUT a human. Sits
        // close to and right of the supervisor (the two are read together: who used to
        // initiate vs what initiates now), not stranded alone at the far top-right corner
        // with a long isolated drop to harness — that read as an arrow to nowhere. The
        // clock→harness edge is a short, direct arrival on harness's own top edge (a real
        // arrival, not a line that merely points near the box).
        const clockCx = 580 + rowShift, clockCy = ROW_Y, clockR = 15;
        const [trigLine1, trigLine2] = (dg.schedulerLabel || "a trigger starts the run: no human turn").split(": ");
        // supervisor → trigger hint arrow's start x: measured off the supervisor's actual
        // rendered first line (not a hand-guessed pixel width) — two guesses in a row landed
        // short and drove the arrow straight through "loop:". getComputedTextLength() is
        // exact regardless of font metrics or copy length; supText is already attached to
        // the live SVG by this point (rootEl.replaceChildren(lab) runs before buildAll()).
        // hintEndX is pulled back 8px off the clock's true edge — arriving flush against the
        // circle read as the arrowhead merging into it with no breathing room.
        const hintEndX = clockCx - clockR - 8;
        const supLine1Len = supText.querySelector("tspan")?.getComputedTextLength() || 0;
        const hintStartX = Math.min(supTextX + supLine1Len + 12, hintEndX - 10); // +12 clearance past the text; never shorter than a 10px stub
        put(gl, "loop",
            clockGlyph(clockCx, clockCy, cll, ""),
            svgLines(clockCx + 25, clockCy, [trigLine1 + ":", trigLine2], "loops-cap", 16, "start"),
            connector(clockCx, clockCy + clockR, clockCx, 14, ""),  // clock's bottom → harness's top edge: the "fires the run" edge — short and direct
            // supervisor → trigger: a "reading order" hint (one-time setup, then the
            // recurring trigger) — solid, matching every other connector in this diagram.
            connector(hintStartX, ROW_Y, hintEndX, ROW_Y, "loops-order-hint"));
        // the problem this layer removes — same visual grammar as every inner layer's own
        // failure annotation (red ✗, prompt's "not what you wanted" / context's "goal
        // drifts"), framed in the loop accent so it reads as THIS layer's gap, not a stray
        // note floating in the shared margin. First line sits on ROW_Y, same as the other
        // three pieces, so the whole band reads as one aligned row. Placed right after the
        // trigger's label so problem and fix still read left-to-right adjacent.
        const [probLine1, probLine2] = (dg.loopProblem || "harness alone: idle until a human prompts, · cold-starts every run").split(" · ");
        const probBoxX = 880 + rowShift;
        const probText = s("text", { x: probBoxX + 10, y: ROW_Y, "text-anchor": "start", class: "loops-cap loops-cap-strong" });
        probText.append(s("tspan", { class: "loops-retry-x" }, "✗  "), probLine1);
        put(gl, "loop",
            s("rect", { x: probBoxX, y: ROW_Y - 14, width: 440, height: 40, rx: 8, fill: "none", stroke: cll, class: "loops-loop-problem-frame" }),
            probText,
            s("text", { x: probBoxX + 10, y: ROW_Y + 18, "text-anchor": "start", class: "loops-cap" }, probLine2));
        // self-improvement band — bottom of the outer margin, recoloured to the loop
        // accent (was green, which read as a stray context/teal element; now the same
        // blue as the frame and the loop-back arrow below). Each pill carries a one-word
        // role tying it back to "self-triggered, self-verifying, self-improving" in the
        // subtitle above — these are WHY the loop never terminates, not a flat feature list.
        // Whole row shifted up 56px (930→874 etc.) to follow harness's own bottom edge,
        // which moved up by the same amount when its dead bottom space was trimmed.
        put(gl, "loop", s("text", { x: 470, y: 874, "text-anchor": "start", class: "loops-cap loops-cap-strong" }, (dg.growsLabel || "it grows itself") + ":"));
        const chips = (layers.find(l => l.id === "loop")?.chips) || [];
        let cxp = 470;
        chips.forEach(chip => {
            const { label, role } = chip, w = Math.max(120, label.length * 7.6 + 24), gg = s("g", {});
            gg.append(s("rect", { x: cxp, y: 890, width: w, height: 28, rx: 14, fill: "none", stroke: cll, class: "loops-chip-rect" }));
            gg.append(s("text", { x: cxp + w / 2, y: 909, "text-anchor": "middle", class: "loops-chip-svg-label" }, label));
            if (role) gg.append(s("text", { x: cxp + w / 2, y: 932, "text-anchor": "middle", class: "loops-loop-subrole" }, role));
            put(gl, "loop", gg); cxp += w + 14;
        });
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
        // hidden (not just faded — display:none, so it takes no layout space and the
        // IntersectionObserver above can't fire early) until the loop layer's own
        // animation completes; _reveal() is called from revealDemarcation("loop", ...).
        // display:none also means a curious scroller who reaches the bottom before
        // finishing the diagram sees the closing line right after Prev/Next controls,
        // not a mysterious empty gap where the chart will eventually appear.
        sec.style.display = "none";
        let revealed = false;
        sec._reveal = () => {
            if (revealed) return; revealed = true;
            sec.style.display = "";
            const g = gsap();
            if (g && !REDUCE_MOTION) g.fromTo(sec, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.6, ease: "power2.out" });
        };
        return sec;
    }

    // ── tour ──────────────────────────────────────────────────────────────────────
    // Each layer gets enough time to actually watch its animation play through at
    // least once (not just the reveal) before auto-advancing — context is the richest
    // (gather → FULL → summarize → drift → reset) so it gets the longest dwell.
    const TOUR_DELAY = { prompt: 14000, context: 26000, harness: 16000, loop: 14000 };
    // Hold before advancing once a layer's narration has finished — a short beat to let
    // the last line and the layer's loop breathe. Only used when narration drives the
    // walkthrough (onDone fires); layers with no narration fall back to TOUR_DELAY.
    const TOUR_HOLD = 3000;
    function tourAdvance() {
        if (!tourPlaying) return;
        // Reaching the last layer ends the tour. The caption panel is cleared by the
        // last layer's narration onDone (hideOnDone), not here — so manual completion
        // hides it too, not just a guided-tour play-through.
        if (focus >= layers.length - 1) { stopTour(); return; }
        focusLayer(focus + 1);
        scheduleTour();
    }
    // Prefer narration-completion to drive the tour: onDone (wired in playAdditive's
    // narration branch) fires once the focused layer's lines finish, then we hold briefly
    // and advance. TOUR_DELAY is the fallback for any layer with no narration (or when
    // narration isn't loaded), so the tour never stalls.
    function scheduleTour() {
        tourOnLayerDone = null;
        if (narration && layers[focus]?.narration?.length) {
            tourOnLayerDone = () => { if (tourPlaying) tourTimer = setTimeout(tourAdvance, TOUR_HOLD); };
            return;
        }
        tourTimer = setTimeout(tourAdvance, TOUR_DELAY[layers[focus].id] || 16000);
    }
    function startTour() {
        tourPlaying = true;
        tourBtn.classList.add("is-playing");
        tourBtn.textContent = `⏹ ${ui.stopTour || "Stop"}`;
        // Restart from step 0 so narration's onDone reliably drives the first advance —
        // otherwise a layer whose narration already finished (onDone fired) would never
        // fire it again and the tour would stall. Wrap from the last layer back to 0;
        // otherwise replay the current layer (only when narration will drive it — with no
        // narration, keep the old "don't refocus, let TOUR_DELAY advance" behavior).
        if (focus === layers.length - 1) focusLayer(0);
        else if (narration && layers[focus]?.narration?.length) focusLayer(focus);
        scheduleTour();
    }
    function stopTour() {
        tourPlaying = false;
        tourBtn.classList.remove("is-playing");
        tourBtn.textContent = `▶ ${ui.tour || "Tour"}`;
        if (tourTimer) { clearTimeout(tourTimer); tourTimer = null; }
    }
    tourBtn.addEventListener("click", () => (tourPlaying ? stopTour() : startTour()));

    // ── global pause: freeze everything (GSAP anims + CSS glyph spin + narration
    // audio/captions) in place, resume exactly where it left off ─────────────────────
    function syncPauseBtn() {
        pauseBtn.textContent = paused ? `▶ ${ui.resume || "Resume"}` : `⏸ ${ui.pause || "Pause"}`;
        pauseBtn.classList.toggle("is-paused", paused);
    }
    function setPaused(on) {
        if (paused === on) return;
        paused = on;
        const g = gsap();
        if (g) { if (on) g.globalTimeline.pause(); else g.globalTimeline.resume(); }
        lab.classList.toggle("is-paused", on); // drives CSS animation-play-state on the ↻ glyphs
        if (on) narration?.pause(); else narration?.resume();
        syncPauseBtn();
    }
    // Navigation while paused would otherwise land on a frozen scene; lift the freeze so
    // the newly focused layer plays. Its own reveal/narration restarts cleanly via focusLayer.
    function ensureResumed() {
        if (!paused) return;
        paused = false;
        gsap()?.globalTimeline.resume();
        lab.classList.remove("is-paused");
        syncPauseBtn(); // narration is reset by the upcoming clearAnim()/stopLayer(), so don't resume it here
    }
    pauseBtn.addEventListener("click", () => setPaused(!paused));

    // ── manual controls ────────────────────────────────────────────────────────────
    prevBtn.addEventListener("click", () => { ensureResumed(); stopTour(); focusLayer(focus - 1); });
    nextBtn.addEventListener("click", () => { ensureResumed(); stopTour(); focusLayer(focus + 1); });
    function onKey(e) {
        if (!lab.isConnected) return;
        if (!started && (e.key === "ArrowRight" || e.key === "ArrowLeft")) return;
        if (e.key === "ArrowRight") { ensureResumed(); stopTour(); focusLayer(focus + 1); }
        else if (e.key === "ArrowLeft") { ensureResumed(); stopTour(); focusLayer(focus - 1); }
        else if (e.key === "Escape") {
            if (stageWrap.classList.contains("is-max")) toggleMax(false);
            else if (paused) setPaused(false);
            else if (tourPlaying) stopTour();
        }
    }
    document.addEventListener("keydown", onKey);

    // First real gesture unlocks narration autoplay on deep-link entry (no Begin click
    // to unlock it there). One-shot: removes itself once fired.
    let gestureReceived = false;
    function onFirstGesture() {
        if (gestureReceived) return;
        gestureReceived = true;
        lab.removeEventListener("pointerdown", onFirstGesture);
        narration?.unlock();
    }

    // ── entrance: mount the first (or deep-linked) scene once GSAP is ready ───────
    stopTour();
    // deep-link: /engineering-loops/#context opens that scene on load
    const hid = (location.hash || "").replace(/^#/, "");
    const si = layers.findIndex(l => l.id === hid);
    if (si >= 0) {
        // arriving via a specific-layer link is already an explicit choice — skip the
        // Begin gate below and jump straight in, same as before
        started = true;
        // No Begin click on a deep-link entry, so narration autoplay stays locked until
        // the first real gesture (Safari only permits play() inside the gesture's own
        // call stack). Until then the first layer is caption-only. Mirrors MCP Lab's
        // onFirstGesture.
        lab.addEventListener("pointerdown", onFirstGesture);
        whenGsap(() => focusLayer(si));
    } else {
        // default landing: hold on a plain black stage (sized to the prompt scene's
        // aspect ratio) behind a Begin button instead of animating the instant the page
        // loads — starting is the visitor's call, not something that happens to them.
        // No preview of the diagram is drawn underneath; the overlay is fully opaque so
        // there's nothing bleeding through behind the button.
        svg.setAttribute("viewBox", STAGE_VB.prompt.join(" "));
        controls.style.visibility = "hidden";
        const beginBtn = el("button", { class: "loops-begin-btn", type: "button" }, `▶ ${ui.begin || "Begin"}`);
        const beginOverlay = el("div", { class: "loops-begin-overlay" }, beginBtn);
        stageWrap.append(beginOverlay);
        beginBtn.addEventListener("click", () => {
            // unlock() must run synchronously inside the real gesture (not inside
            // whenGsap's deferred callback) or Safari rejects the first play().
            narration?.unlock();
            started = true;
            beginOverlay.remove();
            controls.style.visibility = "";
            whenGsap(() => focusLayer(0));
        }, { once: true });
    }

    return {
        destroy() {
            stopTour();
            clearAnim();
            LAYER_ORDER.forEach(stopLayerAnim);
            // loopGlyph()'s rotation/ping tweens live outside activeAnims (deliberately —
            // see its own comment), so they're the one bit of decorative motion this file
            // doesn't already tear down above; kill them explicitly here.
            svg.querySelectorAll(".loops-loop-glyph-wrap").forEach(n => n._tweens?.forEach(t => t.kill()));
            svg.querySelectorAll(".loops-dot").forEach(d => d.remove());
            document.body.style.overflow = "";
            observers.forEach(io => { try { io.disconnect(); } catch {} });
            document.removeEventListener("keydown", onKey);
            lab.removeEventListener("pointerdown", onFirstGesture);
            gsap()?.globalTimeline.resume(); // never leave GSAP globally paused if destroyed mid-pause
            narration?.destroy();
            rootEl.replaceChildren();
        },
    };
}
