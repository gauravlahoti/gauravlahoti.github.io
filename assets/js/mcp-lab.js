// mcp-lab.js — Demystifying MCP, a guided 6-act visual story.
//
// Contract: initMcpLab(rootEl, { content }) → { destroy() }
//
// Fully client-side and deterministic — no backend, no real MCP server. All
// JSON-RPC is scripted in content/mcp-lab.json. Reuses the site's motion DNA:
// SVG + GSAP, cyan accent-glow, glyph-scramble, traveling dots, scan-line wipe.

const SVGNS = "http://www.w3.org/2000/svg";
const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjklmnpqrstuvwxyz0123456789#@!%&";

// ─── tiny DOM/SVG helpers ──────────────────────────────────────────────────────

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

// A collapsible "in plain terms" analogy, rendered at the foot of every act's copy column.
// Starts collapsed as a toggle; clicking expands the layman explanation. The whole element is
// revealed (via .is-ready) only after the act's entrance + text-sync settles — see renderAct().
// Takes { glyph, lead, points[] } from each act in mcp-lab.json (falls back to a plain `text`).
function buildAnalogy(a) {
    if (!a || (!a.lead && !a.text && !(a.points && a.points.length))) return null;

    const panel = el("div", { class: "mcp-analogy-panel", "aria-hidden": "true" });
    if (a.lead) panel.append(el("p", { class: "mcp-analogy-lead", text: a.lead }));
    else if (a.text) panel.append(el("p", { class: "mcp-analogy-text", text: a.text }));
    if (a.points && a.points.length) {
        const ul = el("ul", { class: "mcp-analogy-list" });
        a.points.forEach(pt => ul.append(el("li", { class: "mcp-analogy-point", text: pt })));
        panel.append(ul);
    }

    const btn = el("button", { class: "mcp-analogy-toggle", type: "button", "aria-expanded": "false" },
        el("span", { class: "mcp-analogy-glyph", "aria-hidden": "true" }, a.glyph || "≈"),
        el("span", { class: "mcp-analogy-toggle-label" }, "Real-world analogy"),
        el("span", { class: "mcp-analogy-chevron", "aria-hidden": "true" }, "›"),
    );
    const wrap = el("aside", { class: "mcp-analogy" }, btn, panel);

    btn.addEventListener("click", () => {
        const open = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", open ? "false" : "true");
        panel.setAttribute("aria-hidden", open ? "true" : "false");
        wrap.classList.toggle("is-open", !open);
    });
    return wrap;
}

// Word-wrap a string into <= maxChars lines (no DOM measuring), for SVG <text>.
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

// Build a multi-line SVG <text> block from pre-wrapped lines.
function svgLines(x, y, lines, cls, lh, anchor = "middle") {
    const t = s("text", { x, y, "text-anchor": anchor, class: cls });
    lines.forEach((ln, i) => t.append(s("tspan", { x, dy: i === 0 ? 0 : lh }, ln)));
    return t;
}

// A winding "pipe" path that snakes down from (x1,y1) to (x2,y2) with `steps` S-bends.
// Control handles sit at each segment's mid-y so every bend has a vertical tangent (pipe look).
function serpentinePath(x1, y1, x2, y2, amp, steps) {
    const pts = [[x1, y1]];
    for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const bx = x1 + (x2 - x1) * t;
        pts.push([bx + (i % 2 === 0 ? amp : -amp), y1 + (y2 - y1) * t]);
    }
    pts.push([x2, y2]);
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1], p1 = pts[i], cy = (p0[1] + p1[1]) / 2;
        d += ` C ${p0[0]} ${cy} ${p1[0]} ${cy} ${p1[0]} ${p1[1]}`;
    }
    return d;
}

// Run cb once GSAP is available (script is `defer`); fall back to plain render.
function whenGsap(cb) {
    if (window.gsap) { cb(window.gsap); return; }
    let done = false;
    const go = () => { if (done) return; done = true; cb(window.gsap || null); };
    window.addEventListener("load", () => window.gsap ? go() : go(), { once: true });
    setTimeout(go, 900);
}

// Frame-by-frame random→locked text reveal (the Neural-Slash label technique).
function glyphScramble(node, finalText, duration = 0.42) {
    node.textContent = finalText;
    const g = gsap();
    if (!g || REDUCE_MOTION) return null;
    const chars = finalText.split("");
    const total = Math.max(8, Math.round(duration * 60));
    const lockAt = chars.map((_, i) => Math.floor((i / chars.length) * total * 0.72));
    const obj = { f: 0 };
    return g.to(obj, {
        f: total, duration, ease: "none",
        onUpdate() {
            const fr = obj.f;
            node.textContent = chars.map((ch, i) =>
                ch === " " ? " " : fr >= lockAt[i] ? ch : GLYPHS[(Math.floor(fr * 7) + i * 13) % GLYPHS.length]
            ).join("");
        },
        onComplete() { node.textContent = finalText; },
    });
}

// Path length of a polyline given [{x,y}…].
function polyLen(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return L;
}

// Glowing traveler dot riding a polyline. Returns a gsap timeline (or null).
function travelDot(svg, pts, { color = "#00FFD1", r = 5, speed = 260, onArrive } = {}) {
    const g = gsap();
    if (!g || REDUCE_MOTION || pts.length < 2) { onArrive?.(); return null; }
    const dot = s("circle", { r, fill: color, class: "mcp-anim-dot", cx: pts[0].x, cy: pts[0].y });
    dot.style.filter = `drop-shadow(0 0 5px ${color === "#00FFD1" ? "rgba(0,255,209,0.95)" : color})`;
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

// Stroke draw-on for any SVG <path>/<line>. Returns a tween (or null).
function drawOn(pathEl, { duration = 0.5, delay = 0, ease = "power2.out" } = {}) {
    const g = gsap();
    let len = 0;
    try { len = pathEl.getTotalLength(); } catch { len = 600; }
    pathEl.style.strokeDasharray = len;
    pathEl.style.strokeDashoffset = len;
    if (!g || REDUCE_MOTION) { pathEl.style.strokeDashoffset = 0; return null; }
    return g.to(pathEl, { strokeDashoffset: 0, duration, delay, ease });
}

// ─── scene helpers ──────────────────────────────────────────────────────────────

const AXES = ["ai", "cloud", "biz"];

// Phrase-journey intro: plays once per page load on first visit to Act 1.
let messIntroSeen = false;

// A labeled node as an SVG group (rounded rect + centered text).
function nodeGroup(cx, cy, label, cls) {
    const w = 128, h = 44;
    const g = s("g", { class: `mcp-node ${cls}`, transform: `translate(${cx},${cy})` });
    g.append(
        s("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 8, class: "mcp-node-rect" }),
        s("text", { x: 0, y: 5, "text-anchor": "middle", class: "mcp-node-label" }, label),
    );
    g._cx = cx; g._cy = cy; g._w = w; g._h = h;
    return g;
}

// Node with name + API sub-label (no logo), used in Act 2 side-by-side comparison.
function subNode(cx, cy, name, sub, cls) {
    const w = 138, h = 52;
    const g = s("g", { class: `mcp-node ${cls}`, transform: `translate(${cx},${cy})` });
    g.append(
        s("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 8, class: "mcp-node-rect" }),
        s("text", { x: 0, y: -4, "text-anchor": "middle", class: "mcp-node-label" }, name),
        s("text", { x: 0, y: 14, "text-anchor": "middle", class: "mcp-node-sub" }, sub),
    );
    g._cx = cx; g._cy = cy; g._w = w; g._h = h;
    return g;
}

// A rack/device node (Act 2): rounded body + top gloss bar + status LED + port
// nubs along the bottom edge (the pipe/wire origins). Returns the group plus
// `_portX[]` (absolute x of each port) and `_portY` (absolute y of the port tips).
function deviceNode(cx, cy, label, cls, portCount = 3) {
    const w = 150, h = 54;
    const g = s("g", { class: `mcp-node mcp-device ${cls}`, transform: `translate(${cx},${cy})` });
    g.append(
        s("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 9, class: "mcp-node-rect" }),
        s("rect", { x: -w / 2 + 9, y: -h / 2 + 6, width: w - 18, height: 5, rx: 2.5, class: "mcp-device-gloss" }),
        s("circle", { cx: w / 2 - 13, cy: h / 2 - 11, r: 3, class: "mcp-device-led" }),
        s("text", { x: 0, y: 5, "text-anchor": "middle", class: "mcp-node-label" }, label),
    );
    const portX = [];
    const span = portCount > 1 ? w * 0.5 : 0;
    for (let i = 0; i < portCount; i++) {
        const px = portCount > 1 ? -span / 2 + (span * i) / (portCount - 1) : 0;
        g.append(s("rect", { x: px - 5, y: h / 2 - 2, width: 10, height: 9, rx: 2, class: "mcp-port-nub" }));
        portX.push(cx + px);
    }
    g._cx = cx; g._cy = cy; g._w = w; g._h = h;
    g._portX = portX; g._portY = cy + h / 2 + 7;
    return g;
}

// An app-icon endpoint (Act 2 old world): brand-logo chip (light tile) + a top
// port nub where the pipe enters + the service name below. Returns the group plus
// `_topY` (the pipe entry point) and `_w`.
function endpointNode(cx, cy, name, logoHref) {
    const chip = 50;
    const g = s("g", { class: "mcp-node mcp-endpoint", transform: `translate(${cx},${cy})` });
    g.append(
        s("rect", { x: -6, y: -chip / 2 - 10, width: 12, height: 10, rx: 2, class: "mcp-port-nub" }),
        s("rect", { x: -chip / 2, y: -chip / 2, width: chip, height: chip, rx: 12, class: "mcp-endpoint-chip", filter: "url(#mcpSoftShadow)" }),
        s("image", { href: logoHref, x: -chip / 2 + 7, y: -chip / 2 + 7, width: chip - 14, height: chip - 14, class: "mcp-logo-img" }),
        s("text", { x: 0, y: chip / 2 + 21, "text-anchor": "middle", class: "mcp-endpoint-label" }, name),
    );
    g._cx = cx; g._cy = cy; g._w = chip;
    g._topY = cy - chip / 2 - 10;
    return g;
}

// A metallic pipe coupling band centred at (x,y), drawn axis-aligned.
function metalCollar(x, y) {
    const g = s("g", { class: "mcp-collar" });
    g.append(
        s("rect", { x: x - 12, y: y - 8, width: 24, height: 16, rx: 3, class: "mcp-collar-band" }),
        s("line", { x1: x - 12, y1: y - 3.5, x2: x + 12, y2: y - 3.5, class: "mcp-collar-rim" }),
        s("line", { x1: x - 12, y1: y + 3.5, x2: x + 12, y2: y + 3.5, class: "mcp-collar-rim" }),
    );
    return g;
}

// Quadratic wire between two points with a deterministic bow.
function wirePath(x1, y1, x2, y2, bow, cls) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const cx = mx, cy = my + bow;
    return s("path", { d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`, class: cls, fill: "none" });
}

// ─── Act 1 phrase-journey intro overlay ────────────────────────────────────────
// Builds an overlay that shows intro lines one at a time, then a CTA that
// triggers onProceed (which removes the overlay and starts the visualization).

function buildMessIntro(introData, onProceed) {
    const overlay = el("div", { class: "mcp-mess-intro", tabindex: "0" });

    if (REDUCE_MOTION) {
        const lines = el("div", { class: "mcp-mess-lines" });
        introData.lines.forEach(line => lines.append(el("p", { class: "mcp-mess-line", text: line })));
        const cta = el("button", { class: "mcp-mess-cta", type: "button" }, introData.cta + " →");
        cta.addEventListener("click", onProceed);
        overlay.append(lines, cta);
        return overlay;
    }

    const g = gsap();
    let lineIdx = 0;
    const lineEl = el("p", { class: "mcp-mess-line", text: introData.lines[0] });
    const hintEl = el("p", { class: "mcp-mess-hint", text: introData.hint });
    const cta = el("button", { class: "mcp-mess-cta", type: "button" }, introData.cta + " →");
    cta.style.display = "none";
    overlay.append(lineEl, hintEl, cta);

    if (g) g.fromTo(lineEl, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.45, ease: "power2.out" });

    function advance() {
        lineIdx++;
        if (lineIdx < introData.lines.length) {
            lineEl.textContent = introData.lines[lineIdx];
            if (g) g.fromTo(lineEl, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.38, ease: "power2.out" });
        } else {
            // All lines shown — slide up hint + line, pop in CTA
            overlay.removeEventListener("click", onBodyClick);
            overlay.removeEventListener("keydown", onKey);
            if (g) {
                g.to([lineEl, hintEl], { opacity: 0, y: -8, duration: 0.22, stagger: 0.06, onComplete: () => {
                    lineEl.style.display = "none";
                    hintEl.style.display = "none";
                    cta.style.display = "";
                    g.fromTo(cta, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.42, ease: "back.out(1.8)" });
                }});
            } else {
                lineEl.style.display = "none";
                hintEl.style.display = "none";
                cta.style.display = "";
            }
        }
    }

    function onBodyClick(e) { if (e.target !== cta) advance(); }
    function onKey(e) {
        if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
            e.stopPropagation();
            e.preventDefault();
            advance();
        }
    }

    overlay.addEventListener("click", onBodyClick);
    overlay.addEventListener("keydown", onKey);
    cta.addEventListener("click", onProceed);
    requestAnimationFrame(() => overlay.focus());
    return overlay;
}

// ════════════════════════════════════════════════════════════════════════════════
// ACT 1 — The Mess (N×M tangle, combinatorial explosion)
// ════════════════════════════════════════════════════════════════════════════════

function mountMess({ stage, extra, act, ctl }) {
    const g = gsap();
    const VB_W = 760, VB_H = 470;
    const svg = s("svg", { viewBox: `0 0 ${VB_W} ${VB_H}`, class: "mcp-svg", role: "img" });
    svg.append(s("title", {}, "Every AI app wires bespoke glue to every tool — the M×N problem"));
    stage.appendChild(svg);

    const wireLayer = s("g", {}); const flowLayer = s("g", {}); const glueLayer = s("g", {}); const nodeLayer = s("g", {}); const markLayer = s("g", {});
    svg.append(wireLayer, flowLayer, glueLayer, nodeLayer, markLayer);

    // official logo URLs keyed by model name
    const LOGOS = {
        "Claude":   "assets/img/logo-claude.svg",
        "Gemini":   "assets/img/logo-gemini.svg",
        "GPT-4o":   "assets/img/logo-openai.svg",
        "DeepSeek": "assets/img/logo-deepseek.svg",
    };

    // node with a name (model/tool) + a small schema/protocol sub-label
    // App nodes automatically embed the official model logo on the left
    function messNode(cx, cy, name, sub, cls) {
        const logo = LOGOS[name];
        const w = logo ? 152 : 138, h = 52;
        const grp = s("g", { class: `mcp-node ${cls}`, transform: `translate(${cx},${cy})` });
        grp.append(s("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 8, class: "mcp-node-rect" }));
        if (logo) {
            const logoSize = 20, logoX = -w / 2 + 10, textX = logoX + logoSize + 8;
            const imgEl = s("image", { href: logo, x: logoX, y: -logoSize / 2, width: logoSize, height: logoSize, class: "mcp-logo-img" });
            grp.append(
                imgEl,
                s("text", { x: textX, y: -4, "text-anchor": "start", class: "mcp-node-label" }, name),
                s("text", { x: textX, y: 14, "text-anchor": "start", class: "mcp-node-sub" }, sub),
            );
            grp._logoEl = imgEl;
        } else {
            grp.append(
                s("text", { x: 0, y: -4, "text-anchor": "middle", class: "mcp-node-label" }, name),
                s("text", { x: 0, y: 14, "text-anchor": "middle", class: "mcp-node-sub" }, sub),
            );
        }
        grp._cx = cx; grp._cy = cy; grp._w = w; grp._h = h;
        return grp;
    }
    // a ◆ "connector chip" pinned to a wire's midpoint — one per bespoke integration
    function addGlue(wireEl) {
        let mid = { x: 380, y: 215 };
        try { const L = wireEl.getTotalLength(); mid = wireEl.getPointAtLength(L / 2); } catch {}
        const m = s("rect", { x: mid.x - 3.5, y: mid.y - 3.5, width: 7, height: 7, class: "mcp-glue", transform: `rotate(45 ${mid.x} ${mid.y})` });
        glueLayer.appendChild(m);
        return m;
    }

    // Four model slots so the two beats can COMPOSE on top of each other: Claude (top),
    // DeepSeek (the swap-in, slot 2), then Gemini + GPT-4o (the "multiply" pair). When
    // both beats are on you get all four at once — the complete mess.
    const appY = [100, 290, 385], toolY = [78, 166, 254, 342];
    const swapY = 195;
    const appX = 136, toolX = 624;

    const apps = act.apps.map((a, i) => messNode(appX, appY[i], a.name, a.schema, `mcp-node--${AXES[i % AXES.length]}`));
    const tools = act.tools.map((t, i) => messNode(toolX, toolY[i], t.name, t.api, "mcp-node--tool"));
    const claudeNode = apps[0];
    // DeepSeek: the model you swap Claude for. Sits between Claude and Gemini.
    const swapNode = messNode(appX, swapY, act.swapTo, act.swapToSchema, "mcp-node--swap");

    tools.forEach(t => nodeLayer.appendChild(t));
    apps.forEach(a => nodeLayer.appendChild(a));
    nodeLayer.appendChild(swapNode);

    // Continuous "flowing data": the base wire stays solid (always visible) and a soft
    // warm dash overlay drifts along it forever — gentle, not neon. (cyan is reserved for
    // Act 2's clean MCP rails.)
    const PAT = 20; // dash(2) + gap(18) tile — spaced, gentle pulses (loops seamlessly)
    const flows = [];
    function startFlow(w, idx) {
        if (!g || REDUCE_MOTION) return;
        const overlay = w.el.cloneNode(false);
        overlay.setAttribute("class", w.danger ? "mcp-wire-flow mcp-wire-flow--danger" : "mcp-wire-flow");
        overlay.style.strokeDasharray = "2 18";
        flowLayer.appendChild(overlay);
        const dur = w.danger ? 1.5 : 2.1; // slow, calm drift; danger churns a touch faster
        const t = g.fromTo(overlay, { strokeDashoffset: 0 }, { strokeDashoffset: -PAT, duration: dur, ease: "none", repeat: -1 });
        t.progress((idx * 0.17) % 1); // deterministic desync so the stream isn't in lockstep
        w.flow = t; w.flowEl = overlay; flows.push(t);
    }

    // wires: one bundle of 4 per model (model → every service). Hidden on creation while
    // animating so they never flash solid before their draw-on.
    const wires = [];
    function wireFromModel(modelNode, appIdx, danger) {
        const made = [];
        tools.forEach((t, j) => {
            const bow = ((appIdx * 7 + j * 13) % 9 - 4) * 9;
            const p = wirePath(modelNode._cx + modelNode._w / 2, modelNode._cy, t._cx - t._w / 2, t._cy, bow,
                danger ? "mcp-wire mcp-wire--danger" : "mcp-wire");
            wireLayer.appendChild(p);
            const w = { el: p, appIdx, model: modelNode, danger, glue: addGlue(p) };
            if (g && !REDUCE_MOTION) {
                const L = (() => { try { return p.getTotalLength(); } catch { return 600; } })();
                p.style.strokeDasharray = L; p.style.strokeDashoffset = L;
                g.set(w.glue, { opacity: 0 });
            }
            wires.push(w); made.push(w);
        });
        return made;
    }

    // pending one-shot timers (deferred startFlow calls) — killed on teardown so a
    // replay can't spawn a stray flow for a wire that no longer exists
    const timers = [];

    // animate a freshly-created bundle in (draw-on → glue pop → hand to the flow loop)
    function drawBundle(bundle, baseDelay = 0) {
        if (g && !REDUCE_MOTION) {
            bundle.forEach((w, i) => {
                g.to(w.el, { strokeDashoffset: 0, duration: 0.45, delay: baseDelay + i * 0.05, ease: "power3.out" });
                g.to(w.glue, { opacity: 1, duration: 0.2, delay: baseDelay + 0.34 + i * 0.05 });
                timers.push(g.delayedCall(baseDelay + 0.45 + i * 0.05, () => startFlow(w, wires.indexOf(w))));
            });
        } else {
            bundle.forEach(w => { w.el.style.strokeDashoffset = 0; w.glue.style.opacity = 1; });
        }
    }

    // draw one wire from modelNode to a single toolNode, using the same bow formula
    function wireOneToTool(modelNode, appIdx, toolNode, toolIdx) {
        const bow = ((appIdx * 7 + toolIdx * 13) % 9 - 4) * 9;
        const p = wirePath(modelNode._cx + modelNode._w / 2, modelNode._cy, toolNode._cx - toolNode._w / 2, toolNode._cy, bow, "mcp-wire");
        wireLayer.appendChild(p);
        const w = { el: p, appIdx, model: modelNode, danger: false, glue: addGlue(p) };
        if (g && !REDUCE_MOTION) {
            const L = (() => { try { return p.getTotalLength(); } catch { return 600; } })();
            p.style.strokeDasharray = L; p.style.strokeDashoffset = L;
            g.set(w.glue, { opacity: 0 });
        }
        wires.push(w);
        return w;
    }

    // mark a model's freshly-built wires as broken (red dashes + ✕), no flow — swap beat
    function breakBundle(bundle) {
        bundle.forEach((w, i) => {
            w.el.style.strokeDasharray = ""; w.el.style.strokeDashoffset = "";
            w.el.classList.add("mcp-wire--break");
            let mid = { x: 380, y: 235 };
            try { const L = w.el.getTotalLength(); mid = w.el.getPointAtLength(L / 2); } catch {}
            const x = s("text", { x: mid.x, y: mid.y + 5, "text-anchor": "middle", class: "mcp-break-x" }, "✕");
            markLayer.appendChild(x); w.xMark = x;
            if (g && !REDUCE_MOTION) {
                g.fromTo(w.el, { opacity: 1 }, { opacity: 0.35, duration: 0.1, repeat: 5, yoyo: true, delay: i * 0.05 });
                g.fromTo(x, { opacity: 0 }, { opacity: 1, duration: 0.3, delay: 0.18 + i * 0.05 });
            }
        });
    }

    // wipe every wire / glue chip / ✕ / flow + pending timers (so a state can be rebuilt)
    function clearScene() {
        timers.forEach(t => t.kill()); timers.length = 0;
        flows.forEach(f => f.kill()); flows.length = 0;
        wires.length = 0;
        wireLayer.replaceChildren();
        flowLayer.replaceChildren();
        glueLayer.replaceChildren();
        markLayer.replaceChildren();
    }

    // show a model node (pop-in when animating); `dim` = the model you switched away from
    function nodeOn(node, { dim = false, delay = 0 } = {}) {
        node.classList.toggle("mcp-node--dim", dim);
        node.style.pointerEvents = "";
        const finalOp = dim ? 0.45 : 1;
        if (g && !REDUCE_MOTION) g.fromTo(node, { opacity: 0, scale: 0.6, transformOrigin: "center center" }, { opacity: finalOp, scale: 1, duration: 0.4, ease: "back.out(2)", delay });
        else { node.style.opacity = finalOp; node.style.transform = ""; }
    }
    function nodeOff(node) {
        node.classList.remove("mcp-node--dim");
        node.style.pointerEvents = "none";
        if (g && !REDUCE_MOTION) g.set(node, { opacity: 0 });
        else node.style.opacity = 0;
    }

    // ── copy column: the three realizations, counter, actions, caption ──
    const pains = el("div", { class: "mcp-pains" });
    const painMap = {};
    act.painPoints.forEach(p => {
        const row = el("div", { class: "mcp-pain", "data-k": p.k },
            el("span", { class: "mcp-pain-dot", "aria-hidden": "true" }),
            el("div", { class: "mcp-pain-body" },
                el("span", { class: "mcp-pain-title", text: p.title }),
                el("span", { class: "mcp-pain-note", text: p.note }),
            ),
        );
        painMap[p.k] = row;
        pains.appendChild(row);
    });

    const services = tools.length;
    let activeModels = 1;
    // formula counter: starts at "1 × 4 = 4", climbs to "3 × 4 = 12" on the reveal
    const counterFormula = el("span", { class: "mcp-counter-num", text: `${activeModels} × ${services} = ${activeModels * services}` });
    const counter = el("div", { class: "mcp-counter" },
        counterFormula,
        el("span", { class: "mcp-counter-label", text: " " + act.counterLabel }),
    );
    function setCounter(models, animate) {
        activeModels = models;
        const target = models * services;
        if (animate && g && !REDUCE_MOTION) {
            const o = { v: services };
            g.to(o, { v: target, duration: 0.7, ease: "power1.out", delay: 0.3, onUpdate() {
                counterFormula.textContent = `${models} × ${services} = ${Math.round(o.v)}`;
            } });
        } else {
            counterFormula.textContent = `${models} × ${services} = ${target}`;
        }
    }
    const caption = el("p", { class: "mcp-caption" });
    caption.style.visibility = "hidden";
    const revealBtn = el("button", { class: "mcp-action-btn", type: "button" }, act.revealLabel + " ↗");
    const actions = el("div", { class: "mcp-action-row" }, revealBtn);
    extra.append(pains, counter, actions, caption);

    function showCaption(text) {
        if (!text) { caption.style.visibility = "hidden"; return; }
        caption.textContent = text;
        caption.style.visibility = "visible";
        if (g && !REDUCE_MOTION) g.fromTo(caption, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.3 });
    }

    // Pain rows: CSS active styles set now; visibility revealed beat by beat
    const painRows = act.painPoints.map(p => painMap[p.k]);
    painRows.forEach(r => r.classList.add("is-active"));

    // ── two INDEPENDENT toggles that compose. `multiplied` fans Gemini + GPT-4o in;
    let multiplied = false, lastAction = null;

    function render(firstLoad) {
        clearScene();
        [claudeNode, apps[1], apps[2], swapNode].forEach(nodeOff);

        if (firstLoad && g && !REDUCE_MOTION) g.fromTo(tools, { opacity: 0, scale: 0.5, transformOrigin: "center center" }, { opacity: 1, scale: 1, duration: 0.28, ease: "back.out(2)", stagger: 0.05 });
        else tools.forEach(t => t.style.opacity = 1);

        const d = firstLoad ? 0.35 : 0.1;

        nodeOn(claudeNode);
        drawBundle(wireFromModel(claudeNode, 0, false), d);

        // Gemini + GPT-4o — only when multiplied
        if (multiplied) {
            nodeOn(apps[1], { delay: 0.12 });
            nodeOn(apps[2], { delay: 0.24 });
            drawBundle(wireFromModel(apps[1], 1, false), d + 0.15);
            drawBundle(wireFromModel(apps[2], 2, false), d + 0.3);
        }

        const liveModels = multiplied ? 3 : 1;
        setCounter(liveModels, !firstLoad && multiplied);

        showCaption(multiplied ? act.revealCaption : null);

        revealBtn.classList.toggle("is-on", multiplied);
        revealBtn.setAttribute("aria-pressed", String(multiplied));
        resetBtn.disabled = !multiplied;
    }

    const resetBtn = el("button", { class: "mcp-action-btn mcp-action-btn--reset", type: "button" }, ctl.ui.reset + " ↺");
    actions.appendChild(resetBtn);

    revealBtn.addEventListener("click", () => { multiplied = !multiplied; lastAction = "multiply"; render(); });
    resetBtn.addEventListener("click", () => { multiplied = false; lastAction = null; render(); });

    // ── Story-end action buttons (Add a tool / Add More Models) ──────────────────
    // Built once and shared by BOTH the live story's final beat AND the return-visit
    // path, so the two never diverge. Returns the action-row element.
    function buildStoryActions() {
        let activeModelCount = 1;            // DeepSeek only — Claude is swapped out (dim = broken)
        let activeServiceCount = tools.length;

        const addModelsBtn = el("button", { class: "mcp-action-btn", type: "button" }, "Add More Models ↗");
        const addToolBtn   = el("button", { class: "mcp-action-btn", type: "button" }, "Add a tool +");
        const storyActions = el("div", { class: "mcp-action-row" });
        storyActions.append(addToolBtn, addModelsBtn);

        addModelsBtn.addEventListener("click", () => {
            if (addModelsBtn.disabled) return;
            addModelsBtn.disabled = true;
            addModelsBtn.classList.add("is-on");
            const ga = gsap();
            // Gemini + GPT-4o enter with their own bespoke wires
            nodeOn(apps[1], { delay: 0.1 });
            nodeOn(apps[2], { delay: 0.22 });
            drawBundle(wireFromModel(apps[1], 1, false), 0.2);
            drawBundle(wireFromModel(apps[2], 2, false), 0.35);
            activeModelCount += 2; // DeepSeek + Gemini + GPT-4o = 3 active models
            const total = activeModelCount * activeServiceCount;
            if (ga) {
                ga.set(counter, { display: "block" });
                ga.from(counter, { opacity: 0, y: 10, duration: 0.45, ease: "power2.out", delay: 0.6 });
                const o = { v: activeServiceCount };
                ga.to(o, { v: total, duration: 0.8, ease: "power1.out", delay: 0.7, onUpdate() {
                    counterFormula.textContent = `${activeModelCount} × ${activeServiceCount} = ${Math.round(o.v)}`;
                }});
            } else {
                counter.style.display = "block";
                counterFormula.textContent = `${activeModelCount} × ${activeServiceCount} = ${total}`;
            }
        });

        addToolBtn.addEventListener("click", () => {
            if (addToolBtn.disabled) return;
            addToolBtn.disabled = true;
            addToolBtn.classList.add("is-on");
            const toolIdx = tools.length; // index of the new tool (5th slot)
            activeServiceCount++;

            // Add Calendar service node to the SVG
            const calTool = messNode(toolX, toolY[3] + 88, "Calendar", "CalDAV · REST", "mcp-node--tool");
            nodeLayer.appendChild(calTool);
            tools.push(calTool);
            const ga = gsap();
            if (ga) {
                ga.fromTo(calTool,
                    { opacity: 0, scale: 0.65, transformOrigin: "center center" },
                    { opacity: 1, scale: 1, duration: 0.38, ease: "back.out(2)" });
            } else { calTool.style.opacity = "1"; }

            // Claude → Calendar: dim wire (matches Claude's broken state)
            const wClaude = wireOneToTool(claudeNode, 0, calTool, toolIdx);
            if (ga) {
                ga.to(wClaude.el, { strokeDashoffset: 0, duration: 0.35, ease: "power3.out", delay: 0.15 });
                ga.to(wClaude.el, { opacity: 0.35, duration: 0.15, delay: 0.5 });
                ga.to(wClaude.glue, { opacity: 0.3, duration: 0.15, delay: 0.48 });
            } else { wClaude.el.style.strokeDashoffset = "0"; wClaude.el.style.opacity = "0.35"; wClaude.glue.style.opacity = "0.3"; }

            // DeepSeek → Calendar: active wire
            drawBundle([wireOneToTool(swapNode, 3, calTool, toolIdx)], 0.25);

            // Gemini + GPT-4o → Calendar if they've been added
            if (addModelsBtn.disabled) {
                drawBundle([wireOneToTool(apps[1], 1, calTool, toolIdx)], 0.35);
                drawBundle([wireOneToTool(apps[2], 2, calTool, toolIdx)], 0.45);
            }

            const total = activeModelCount * activeServiceCount;
            if (ga) {
                const prev = activeModelCount * (activeServiceCount - 1);
                if (addModelsBtn.disabled) {
                    const o = { v: prev };
                    ga.to(o, { v: total, duration: 0.6, ease: "power1.out", delay: 0.5, onUpdate() {
                        counterFormula.textContent = `${activeModelCount} × ${activeServiceCount} = ${Math.round(o.v)}`;
                    }});
                } else {
                    counterFormula.textContent = `${activeModelCount} × ${activeServiceCount} = ${total}`;
                    ga.set(counter, { display: "block" });
                    ga.from(counter, { opacity: 0, y: 10, duration: 0.45, ease: "power2.out", delay: 0.5 });
                }
            } else {
                counterFormula.textContent = `${activeModelCount} × ${activeServiceCount} = ${total}`;
                counter.style.display = "block";
            }
        });

        return storyActions;
    }

    // Final post-story visualization, rendered instantly on a return visit (or reduced
    // motion) so the screen matches exactly where the live story left off.
    function renderStoryComplete() {
        actions.style.display = "none";       // hide the legacy Multiply / Reset row
        clearScene();
        [apps[1], apps[2]].forEach(nodeOff);
        tools.forEach(t => { t.style.opacity = "1"; t.style.pointerEvents = ""; });

        // Claude present but dimmed (swapped out = broken connections, still visible)
        nodeOn(claudeNode);
        claudeNode.classList.add("mcp-node--dim");
        claudeNode.style.opacity = "0.45";
        wireFromModel(claudeNode, 0, false).forEach(w => {
            w.el.style.strokeDashoffset = "0";
            w.el.style.opacity = "0.35";
            w.glue.style.opacity = "0.3";
        });

        // DeepSeek live with active wires + flowing dots
        nodeOn(swapNode);
        drawBundle(wireFromModel(swapNode, 3, false), 0.1);

        // Copy: pains visible, counter hidden until a button is clicked, story actions
        painRows.forEach(r => { r.style.display = "flex"; r.style.opacity = "1"; });
        counter.style.display = "none";
        extra.appendChild(buildStoryActions());
    }

    // ── Progressive story beats: copy + visualization in lockstep ────────────────
    // storyComplete = true  → skip beats, show everything, normal render() behaviour.
    // storyComplete = false → reveal copy and viz beat by beat.
    let storyComplete = REDUCE_MOTION || messIntroSeen;

    // Seed initial state ──────────────────────────────────────────────────────────
    if (storyComplete) {
        // Returning visit or reduced motion: renderStoryComplete() paints the final state.
        painRows.forEach(r => { r.style.opacity = "1"; });
    } else {
        // First visit: hide copy elements; viz starts with just Claude (tools hidden).
        painRows.forEach(r => { r.style.display = "none"; });
        counter.style.display = "none";
        actions.style.display = "none";
        // Tools start hidden — beat 1 animates them in one by one.
        tools.forEach(t => { t.style.opacity = "0"; t.style.pointerEvents = "none"; });
    }

    // Minimal initial scene: just Claude node, no wires (used in story path)
    // Grab layout elements for the stage-hide/reveal sequence
    const stageColEl  = stage.closest(".mcp-stage-col");
    const stageWrapEl = stage.closest(".mcp-stagewrap");
    const bodygridEl  = stage.closest(".mcp-bodygrid");

    // Blank canvas — called after the phrase-journey intro completes.
    // Stage column is already hidden; just wipe any leftover SVG state.
    function initStoryScene() {
        clearScene();
        [claudeNode, apps[1], apps[2], swapNode].forEach(nodeOff);
        tools.forEach(t => { t.style.opacity = "0"; t.style.pointerEvents = "none"; });
    }

    // Beat system ─────────────────────────────────────────────────────────────────
    // Stage column hiding happens AFTER the intro overlay fades (not now), because
    // the overlay lives inside the stage element — it must be visible during the journey.
    // BUT we must hide all SVG nodes immediately so they don't flash through the overlay.
    if (!storyComplete) {
        initStoryScene(); // wipe SVG state so overlay fades to a blank dark canvas (no glitch)
        let beat = 0;
        // Only 3 labels — beat 3 (last pain point) transitions directly to action buttons
        const BEAT_LABELS = ["Continue", "Continue", "Continue"];
        const cBtn = el("button", { class: "mcp-continue-btn", type: "button" }, BEAT_LABELS[0] + " →");
        extra.appendChild(cBtn);

        function nextBeat() {
            beat++;
            const gx = gsap();
            if (beat < BEAT_LABELS.length) cBtn.textContent = BEAT_LABELS[beat] + " →";

            // ── VISUALIZATION ────────────────────────────────────────────────────
            if (beat === 1) {
                // Stage box is already on screen (empty) as the entry point —
                // now the service boxes populate it one by one, each a different API.
                tools.forEach((t, i) => {
                    t.style.pointerEvents = "";
                    if (gx) {
                        gx.fromTo(t,
                            { opacity: 0, scale: 0.65, transformOrigin: "center center" },
                            { opacity: 1, scale: 1, duration: 0.38, delay: i * 0.18, ease: "back.out(2)" });
                    } else { t.style.opacity = "1"; }
                });
            } else if (beat === 2) {
                // Claude enters and bespoke wires draw — one ◆ per integration
                nodeOn(claudeNode);
                drawBundle(wireFromModel(claudeNode, 0, false), 0.3);
            } else if (beat === 3) {
                // Swap: Claude's wires dim (still visible = "not working"),
                // DeepSeek enters and draws its OWN fresh connections to every tool
                flows.forEach(f => f.kill()); flows.length = 0;
                flowLayer.replaceChildren();
                wireLayer.querySelectorAll(".mcp-wire").forEach((wireEl, i) => {
                    if (gx) gx.to(wireEl, { opacity: 0.35, duration: 0.5, delay: i * 0.04 });
                    else wireEl.style.opacity = "0.35";
                });
                glueLayer.querySelectorAll(".mcp-glue").forEach(glueEl => {
                    if (gx) gx.to(glueEl, { opacity: 0.3, duration: 0.4 });
                    else glueEl.style.opacity = "0.3";
                });
                // Claude dims but stays visible — its connections are broken, not gone
                claudeNode.classList.add("mcp-node--dim");
                if (gx) gx.to(claudeNode, { opacity: 0.45, duration: 0.5 });
                else claudeNode.style.opacity = "0.45";
                // DeepSeek appears and connects fresh — incompatible schema, new wires
                nodeOn(swapNode, { delay: 0.4 });
                if (gx) {
                    const t = gx.delayedCall(0.65, () => { drawBundle(wireFromModel(swapNode, 3, false), 0.0); });
                    timers.push(t);
                } else {
                    wireFromModel(swapNode, 3, false).forEach(w => { w.el.style.strokeDashoffset = "0"; w.glue.style.opacity = "1"; });
                }
            }

            // ── COPY COLUMN ──────────────────────────────────────────────────────
            if (beat <= painRows.length) {
                const row = painRows[beat - 1];
                if (gx) { gx.set(row, { display: "flex" }); gx.from(row, { opacity: 0, y: 10, duration: 0.45, ease: "power2.out" }); }
                else { row.style.display = "flex"; }
            }

            // ── FINAL BEAT (beat 3 = last pain point) ────────────────────────────
            // Replace Continue with the shared story-action buttons (Add a tool / Add More Models).
            if (beat >= painRows.length) {
                storyComplete = true;
                const storyActions = buildStoryActions();
                if (gx) {
                    extra.appendChild(storyActions);
                    gx.fromTo(storyActions, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.4, ease: "back.out(1.5)", delay: 0.4 });
                    gx.to(cBtn, { opacity: 0, duration: 0.25, onComplete: () => cBtn.remove() });
                } else { extra.appendChild(storyActions); cBtn.remove(); }
            }
        }

        cBtn.addEventListener("click", nextBeat);
    }

    // ── Phrase-journey intro: gate until clicked through ─────────────────────────
    // The strong landing heading + summary stay visible at the top; the phrase journey
    // plays inside the stage and gates the visualization.
    let labEl = null;
    if (act.intro && !messIntroSeen) {
        labEl = stage.closest(".mcp-lab");
        extra.classList.add("is-pending");
        labEl?.classList.add("mcp-lab--intro");

        const overlay = buildMessIntro(act.intro, () => {
            messIntroSeen = true;
            const g2 = gsap();

            function afterOverlay() {
                if (storyComplete) {
                    // Return/reduced-motion path: jump straight to the final story state
                    labEl?.classList.remove("mcp-lab--intro");
                    extra.classList.remove("is-pending");
                    renderStoryComplete();
                } else {
                    // Story path: return to the normal layout with an EMPTY stage box as
                    // the entry point. Beats fill it in on Continue.
                    labEl?.classList.remove("mcp-lab--intro");
                    extra.classList.remove("is-pending");
                    initStoryScene();                 // empty SVG scene
                    stageWrapEl.style.opacity = "1";
                    stageWrapEl.classList.add("mcp-stagewrap--entering"); // gentle glow-in
                }
            }

            if (g2 && !REDUCE_MOTION) {
                g2.to(overlay, { opacity: 0, duration: 0.38, onComplete: () => { overlay.remove(); afterOverlay(); } });
            } else {
                overlay.remove(); afterOverlay();
            }
        });
        stage.appendChild(overlay);
    } else {
        if (storyComplete) renderStoryComplete(); else {
            // No intro overlay, but story not yet complete: show the empty stage box.
            initStoryScene();
            stageWrapEl.style.opacity = "1";
        }
    }

    return {
        destroy() {
            timers.forEach(t => t.kill());
            flows.forEach(f => f.kill());
            extra.classList.remove("is-pending");
            labEl?.classList.remove("mcp-lab--intro");
            // Restore stage visibility so other acts render correctly
            stageColEl.style.removeProperty("display");
            stageWrapEl.style.removeProperty("opacity");
            stageWrapEl.classList.remove("mcp-stagewrap--entering");
            bodygridEl.classList.remove("mcp-story--no-stage");
        },
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// ACT 2 — The Standard: "The Old World" tangle vs "The MCP World" (one standard).
// Left: AI Model wired to services with bespoke glue + friction (OAuth, rate limits…).
// Right: AI Model → MCP standard ring → servers that advertise capabilities. Captions
// are baked into each panel.
// ════════════════════════════════════════════════════════════════════════════════

function mountStandard({ stage, extra, act, ctl = {} }) {
    const g = gsap();
    const VB_W = 1000, VB_H = 560;
    const svg = s("svg", { viewBox: `0 0 ${VB_W} ${VB_H}`, class: "mcp-svg", role: "img" });
    svg.append(s("title", {}, "The Old World: bespoke glue per service. The MCP World: one standard, zero glue."));
    stage.appendChild(svg);

    // shared <defs>: metallic pipe sheen, soft depth shadow, amber flow chevron
    const defs = s("defs");
    const grad = s("linearGradient", { id: "mcpPipeGrad", x1: 0, y1: 0, x2: 1, y2: 0 });
    grad.append(
        s("stop", { offset: 0, class: "mcp-pipe-grad-edge" }),
        s("stop", { offset: 0.45, class: "mcp-pipe-grad-mid" }),
        s("stop", { offset: 1, class: "mcp-pipe-grad-edge" }),
    );
    const shadow = s("filter", { id: "mcpSoftShadow", x: "-40%", y: "-40%", width: "180%", height: "180%" },
        s("feDropShadow", { dx: 0, dy: 3, stdDeviation: 4, class: "mcp-soft-shadow" }));
    const marker = s("marker", { id: "mcpFlowArrow", viewBox: "0 0 10 10", refX: 7, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto" },
        s("path", { d: "M1.5 1.5 L8 5 L1.5 8.5", fill: "none", class: "mcp-flow-arrow" }));
    defs.append(grad, shadow, marker);
    svg.append(defs);

    const bgLayer = s("g", {}); const oldWireLayer = s("g", {}); const oldFlowLayer = s("g", {}); const newWireLayer = s("g", {});
    const nodeLayer = s("g", {}); const labelLayer = s("g", {});
    svg.append(bgLayer, oldWireLayer, oldFlowLayer, newWireLayer, nodeLayer, labelLayer);

    const DIV_X = 500, LX = 250, RX = 750;

    // rounded in-panel caption box with wrapped SVG text (centered, vertically centered)
    function captionBox(cx, yTop, w, h, text, variant) {
        const grp = s("g", { class: "mcp-caption-box" });
        grp.append(s("rect", { x: cx - w / 2, y: yTop, width: w, height: h, rx: 10, class: `mcp-caption-rect mcp-caption-rect--${variant}` }));
        const lines = wrapText(text, Math.floor((w - 36) / 7.4));
        const lh = 20;
        const startY = yTop + h / 2 - ((lines.length - 1) * lh) / 2 + 5;
        grp.appendChild(svgLines(cx, startY, lines, `mcp-caption-text mcp-caption-text--${variant}`, lh));
        return grp;
    }

    // ── centre partition ──
    bgLayer.append(s("rect", { x: DIV_X + 1, y: 0, width: VB_W - DIV_X - 1, height: VB_H, class: "mcp-std-bg" }));
    labelLayer.append(s("line", { x1: DIV_X, y1: 0, x2: DIV_X, y2: VB_H, class: "mcp-std-divider" }));
    labelLayer.append(
        s("text", { x: LX, y: 42, "text-anchor": "middle", class: "mcp-std-panel-title" }, act.oldWorldLabel || "The Old World"),
        s("text", { x: RX, y: 42, "text-anchor": "middle", class: "mcp-std-panel-title mcp-std-panel-title--mcp" }, act.mcpWorldLabel || "The MCP World"),
    );

    // ── LEFT: the old world (glossy, fragile plumbing per service) ──
    const oldModel = deviceNode(LX, 110, "AI Model", "mcp-node--ai", 3);
    const oldNames = act.oldServices || ["Calendar", "Notion", "Gmail"];
    const SVC_LOGOS = { Calendar: "assets/img/logo-google-calendar.svg", Notion: "assets/img/logo-notion.svg", Gmail: "assets/img/logo-gmail.svg" };
    const logoFor = (name, i) => (act.oldServiceLogos && act.oldServiceLogos[i]) || SVC_LOGOS[name] || SVC_LOGOS.Gmail;
    const oldSvcX = [110, 250, 390];                  // evenly spaced, centred under the model
    const oldSvc = oldNames.map((l, i) => endpointNode(oldSvcX[i], 352, l, logoFor(l, i)));
    const ports = oldModel._portX, portY = oldModel._portY;

    // three glossy "pipes" per service: dark edge + metallic gradient body + gloss
    // highlight, with an amber flow line riding inside. The tube layers cast a soft
    // shadow (depth); the flow stays crisp on top.
    const pipeBodies = [], pipeFlows = [];
    oldSvc.forEach((svc, i) => {
        const d = serpentinePath(ports[i], portY, svc._cx, svc._topY, 24, 2);
        const edge = s("path", { d, class: "mcp-pipe-edge", fill: "none" });
        const body = s("path", { d, class: "mcp-pipe-body", fill: "none" });
        body.style.stroke = "url(#mcpPipeGrad)";
        const gloss = s("path", { d, class: "mcp-pipe-gloss", fill: "none" });
        const flow = s("path", { d, class: "mcp-pipe-flow", fill: "none", "marker-end": "url(#mcpFlowArrow)" });
        const tube = s("g", { filter: "url(#mcpSoftShadow)" });
        tube.append(edge, body, gloss);
        oldWireLayer.appendChild(tube);
        oldFlowLayer.appendChild(flow);
        pipeBodies.push(body); pipeFlows.push(flow);
        // metallic coupling collars along each pipe
        [0.42, 0.78].forEach(f => {
            try { const pt = body.getPointAtLength(body.getTotalLength() * f);
                oldWireLayer.appendChild(metalCollar(pt.x, pt.y));
            } catch {}
        });
    });
    const tangle = pipeBodies; // used by the entrance animation
    // cracked / leaking joints on the pipes (fragile glue)
    const breakMarks = [];
    [[pipeBodies[0], 0.30], [pipeBodies[2], 0.30], [pipeBodies[1], 0.62]].forEach(([p, f]) => {
        try {
            const pt = p.getPointAtLength(p.getTotalLength() * f);
            const cr = s("path", { d: `M ${pt.x - 10} ${pt.y - 8} L ${pt.x - 2} ${pt.y - 1} L ${pt.x - 9} ${pt.y + 4} M ${pt.x + 2} ${pt.y - 6} L ${pt.x + 10} ${pt.y + 2} L ${pt.x + 3} ${pt.y + 8}`, class: "mcp-pipe-break", fill: "none" });
            const drip = s("path", { d: `M ${pt.x + 6} ${pt.y + 5} q 3 6 0 10 q -3 -4 0 -10 z`, class: "mcp-pipe-drip" });
            labelLayer.append(cr, drip); breakMarks.push(cr, drip);
        } catch {}
    });

    // "fragile system prompts" scroll icon (top-right of the old-world panel)
    const scroll = s("g", { class: "mcp-scroll-icon", transform: "translate(432,96)" });
    scroll.append(
        s("path", { d: "M3 8 Q3 1 10 1 L30 1 Q37 1 37 8 L37 40 Q37 47 30 47 L10 47 Q3 47 3 40 Z", class: "mcp-scroll-page" }),
        s("path", { d: "M3 8 Q3 1 10 1 L10 9 Q3 9 3 8 Z", class: "mcp-scroll-curl" }),
        s("line", { x1: 10, y1: 15, x2: 30, y2: 15, class: "mcp-scroll-line" }),
        s("line", { x1: 10, y1: 23, x2: 30, y2: 23, class: "mcp-scroll-line" }),
        s("line", { x1: 10, y1: 31, x2: 25, y2: 31, class: "mcp-scroll-line" }),
        s("line", { x1: 10, y1: 39, x2: 22, y2: 39, class: "mcp-scroll-accent" }),
    );
    labelLayer.appendChild(scroll);

    // friction annotations
    const fr = act.frictions || ["OAuth", "Rate limits", "Edge cases", "Fragile prompts"];
    const frPos = [[70, 250], [250, 312], [430, 250], [452, 120]];
    const frictionEls = fr.map((t, i) => {
        const n = s("text", { x: frPos[i][0], y: frPos[i][1], "text-anchor": "middle", class: "mcp-friction-label" }, t);
        labelLayer.appendChild(n); return n;
    });

    const CAP_Y = 452, CAP_W = 440, CAP_H = 86;
    const oldCap = captionBox(LX, CAP_Y, CAP_W, CAP_H, act.oldCaption || "", "old");
    labelLayer.appendChild(oldCap);

    // ── RIGHT: the MCP world ──
    const mcpModel = deviceNode(RX, 110, "AI Model", "mcp-node--ai", 1);
    const ringCY = 268, ringR = 64;
    const ring = s("g", { class: "mcp-ring", transform: `translate(${RX},${ringCY})` });
    ring.append(
        s("circle", { r: ringR, class: "mcp-ring-outer", fill: "none" }),
        s("circle", { r: ringR - 16, class: "mcp-ring-inner", fill: "none" }),
    );
    for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ring.append(s("line", { x1: Math.cos(a) * (ringR - 14), y1: Math.sin(a) * (ringR - 14), x2: Math.cos(a) * (ringR - 6), y2: Math.sin(a) * (ringR - 6), class: "mcp-ring-tick" }));
    }
    [-1, 1].forEach(d => ring.append(s("rect", { x: -7, y: d > 0 ? ringR - 4 : -ringR - 6, width: 14, height: 10, rx: 2, class: "mcp-ring-nub" })));
    ring.append(
        s("text", { x: 0, y: -3, "text-anchor": "middle", class: "mcp-ring-label", "data-scramble": "MCP" }, "MCP"),
        s("text", { x: 0, y: 15, "text-anchor": "middle", class: "mcp-ring-sub" }, "standard"),
    );

    const srvNames = act.mcpServers || ["Calendar Server", "Node Server", "Email Server"];
    const srvX = [615, 750, 885];
    const servers = srvNames.map((l, i) => {
        const n = nodeGroup(srvX[i], 392, l, "mcp-node--server");
        n.insertBefore(s("rect", { x: -6, y: -n._h / 2 - 10, width: 12, height: 10, rx: 2, class: "mcp-port-nub" }), n.firstChild);
        return n;
    });

    // clean cyan "tubes": a dark edge underlay + the glowing cyan body (answers the tangle)
    const cleanWires = [], cleanEdges = [], cleanPts = [];
    const cleanTube = (x1, y1, x2, y2, bow) => {
        const edge = wirePath(x1, y1, x2, y2, bow, "mcp-wire--clean-edge");
        const body = wirePath(x1, y1, x2, y2, bow, "mcp-wire mcp-wire--clean");
        newWireLayer.append(edge, body);
        cleanEdges.push(edge); cleanWires.push(body);
        cleanPts.push([{ x: x1, y: y1 }, { x: x2, y: y2 }]);
    };
    // model → ring
    cleanTube(RX, mcpModel._portY, RX, ringCY - ringR, 0);
    // ring → each server
    servers.forEach(srv => cleanTube(RX, ringCY + ringR, srv._cx, srv._cy - srv._h / 2 - 10, (srv._cx - RX) * 0.04));
    const mcpCap = captionBox(RX, CAP_Y, CAP_W, CAP_H, act.mcpCaption || "", "mcp");
    labelLayer.appendChild(mcpCap);

    nodeLayer.append(oldModel, ...oldSvc, mcpModel, ring, ...servers);

    // ── copy column: the HTTP-of-AI framing + labeled Origin + Adoption (USB-C analogy renders in the shared slot) ──
    const fact = (label, text, cls) => el("p", { class: `mcp-fact${cls ? " " + cls : ""}` }, el("span", { class: "mcp-fact-label" }, label), el("span", { class: "mcp-fact-text", text }));
    const httpFact = fact("The HTTP of AI", act.httpAnalogy || "Just as HTTP unified how browsers talk to servers without touching the databases underneath, MCP unifies how models talk to tools. Expose your systems once and any compliant model can use them, no custom integration.", "mcp-fact--http");
    const origin = fact("Origin", act.origin);
    const adoption = fact("Adoption", act.adoption);
    extra.append(httpFact, origin, adoption);

    const setDash = (p) => { const L = (() => { try { return p.getTotalLength(); } catch { return 400; } })(); p.style.strokeDasharray = L; p.style.strokeDashoffset = L; };

    let tl = null;
    if (g && !REDUCE_MOTION) {
        g.set([oldModel, ...oldSvc, mcpModel, ...servers], { opacity: 0 });
        g.set(ring, { opacity: 0, scale: 0.6, transformOrigin: "center center" });
        g.set([oldWireLayer, oldFlowLayer, scroll], { opacity: 0 });
        g.set([...frictionEls, ...breakMarks, oldCap, mcpCap], { opacity: 0 });
        g.set([httpFact, origin, adoption], { opacity: 0, y: 8 });
        [...cleanWires, ...cleanEdges].forEach(setDash);
        pipeFlows.forEach(f => { f.style.strokeDasharray = "6 12"; });

        tl = g.timeline();

        // Left: model + services, the winding pipes + collars fade in, breaks crack, scroll
        tl.to([oldModel, ...oldSvc], { opacity: 1, duration: 0.32, ease: "power2.out", stagger: 0.08 });
        tl.to([oldWireLayer, oldFlowLayer], { opacity: 1, duration: 0.55, ease: "power2.out" }, "-=0.05");
        tl.to(scroll, { opacity: 1, duration: 0.4 }, "-=0.35");
        tl.to(frictionEls, { opacity: 1, duration: 0.3, stagger: 0.08 }, "-=0.3");
        tl.to(breakMarks, { opacity: 1, duration: 0.12, ease: "back.out(2)", stagger: 0.1, repeat: 3, yoyo: true }, "-=0.2");
        tl.to(oldCap, { opacity: 1, duration: 0.4 }, "-=0.1");

        // Right: model, ring scale-in + scramble, servers, clean wires, caption
        tl.to(mcpModel, { opacity: 1, duration: 0.32, ease: "power2.out" }, "+=0.25");
        tl.to(ring, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.7)", transformOrigin: "center center" }, "-=0.1");
        tl.add(() => { const lab = ring.querySelector("[data-scramble]"); if (lab) glyphScramble(lab, "MCP", 0.4); }, "-=0.4");
        tl.to(servers, { opacity: 1, duration: 0.3, ease: "power2.out", stagger: 0.08 }, "-=0.15");
        tl.to([...cleanEdges, ...cleanWires], { strokeDashoffset: 0, duration: 0.45, ease: "power3.out", stagger: 0.06 }, "-=0.1");
        tl.to(mcpCap, { opacity: 1, duration: 0.4 }, "-=0.1");

        tl.to([httpFact, origin, adoption], { opacity: 1, y: 0, duration: 0.4, ease: "power3.out", stagger: 0.1 }, "-=0.2");
        tl.add(() => ctl.signalReady?.());

        // loops: orange flow drifting down the fragile pipes + clean dots on the MCP side
        tl.add(() => {
            const loop = g.timeline({ repeat: -1, repeatDelay: 1.0 });
            loop.to(pipeFlows, { strokeDashoffset: -18, duration: 0.7, ease: "none", repeat: -1 }, 0);
            cleanPts.forEach((pts, i) => loop.add(() => travelDot(svg, pts, { speed: 300 }), i * 0.16));
            loop.to({}, { duration: 1.2 });
            tl._loop = loop;
        });
    } else {
        [oldModel, ...oldSvc, mcpModel, ...servers].forEach(n => n.style.opacity = "1");
        ring.style.opacity = "1";
        oldWireLayer.style.opacity = "1"; oldFlowLayer.style.opacity = "1"; scroll.style.opacity = "1";
        [...frictionEls, ...breakMarks, oldCap, mcpCap, httpFact, origin, adoption].forEach(n => n.style.opacity = "1");
        [...cleanWires, ...cleanEdges].forEach(p => p.style.strokeDashoffset = "0");
        ctl.signalReady?.();
    }

    return { get tl() { return tl?._loop || tl; }, destroy() { tl?._loop?.kill(); tl?.kill(); } };
}

// ════════════════════════════════════════════════════════════════════════════════
// ACT 3 — APIs Were Never Built for AI (designed for human integrators)
// A developer grinds through the docs, caches the work as deterministic code, then that
// code invokes the API and runs flawlessly forever. The copy column narrates each step in
// sync. Bridges into dynamic discovery (Act 4).
// ════════════════════════════════════════════════════════════════════════════════

function mountHumanApi({ stage, extra, act, ctl = {} }) {
    const g = gsap();
    const VB_W = 760, VB_H = 480;
    const svg = s("svg", { viewBox: `0 0 ${VB_W} ${VB_H}`, class: "mcp-svg", role: "img" });
    svg.append(s("title", {}, "A developer iterates on API docs, caches the work as deterministic code, and that code invokes the API flawlessly forever"));
    stage.appendChild(svg);

    const ringLayer = s("g", {});
    const runLayer  = s("g", {});
    const codeLayer = s("g", {});
    const nodeLayer = s("g", {});
    svg.append(ringLayer, runLayer, codeLayer, nodeLayer);

    // ── nodes: the human integrator and the target API ──
    const dev = nodeGroup(108, 235, act.loop.actor, "mcp-node--biz mcp-node--human");
    const api = nodeGroup(650, 235, "API", "mcp-node--tool");
    nodeLayer.append(dev, api);

    // ── iteration ring (phase 1: the ~2-week struggle) ──
    const cx = 362, cy = 235, R = 118;
    const ring = s("circle", { cx, cy, r: R, class: "mcp-loop-ring", fill: "none" });
    ringLayer.appendChild(ring);

    const steps = act.loop.steps;
    const N = steps.length;
    const stepEls = steps.map((label, i) => {
        const ang = (-90 + i * (360 / N)) * Math.PI / 180;
        const x = cx + R * Math.cos(ang), y = cy + R * Math.sin(ang);
        const grp = s("g", { class: "mcp-loop-step" });
        const labelAbove = y < cy + 4;
        grp.append(
            s("circle", { cx: x, cy: y, r: 5, class: "mcp-loop-node" }),
            s("text", { x, y: labelAbove ? y - 13 : y + 22, "text-anchor": "middle", class: "mcp-loop-label" }, label),
        );
        grp._x = x; grp._y = y;
        ringLayer.appendChild(grp);
        return grp;
    });

    const token = s("circle", { cx, cy: cy - R, r: 6, class: "mcp-loop-token" });
    ringLayer.appendChild(token);
    const effort = s("text", { x: cx, y: cy + 6, "text-anchor": "middle", class: "mcp-loop-effort" }, act.loop.effortLabel);
    ringLayer.appendChild(effort);

    // ── deterministic-code artifact: just the icons (doc + </>) + the label ──
    const codeW = 214, codeH = 66;
    const codeBox = s("g", { class: "mcp-code-artifact", transform: `translate(${cx},${cy})` });
    const docG = s("g", { class: "mcp-doc-icon", transform: `translate(-34,-25) scale(0.72)` });
    docG.append(
        s("path", { d: "M0 0 H12 L18 6 V26 H0 Z", class: "mcp-doc-page" }),
        s("path", { d: "M12 0 V6 H18", class: "mcp-doc-fold" }),
        s("line", { x1: 4, y1: 11, x2: 14, y2: 11, class: "mcp-doc-line" }),
        s("line", { x1: 4, y1: 16, x2: 14, y2: 16, class: "mcp-doc-line" }),
        s("line", { x1: 4, y1: 21, x2: 10, y2: 21, class: "mcp-doc-line" }),
    );
    codeBox.append(
        s("rect", { x: -codeW / 2, y: -codeH / 2, width: codeW, height: codeH, rx: 8, class: "mcp-code-rect" }),
        docG,
        s("text", { x: 12, y: -7, "text-anchor": "middle", class: "mcp-code-glyph" }, "</>"),
        s("text", { x: 0, y: 22, "text-anchor": "middle", class: "mcp-code-tag", "data-scramble": act.artifact.label }, act.artifact.label),
    );
    codeLayer.appendChild(codeBox);

    // ── run phase: the code invokes the API, then a flawless stream ──
    const runWire = wirePath(cx + codeW / 2, cy, api._cx - api._w / 2, api._cy, 0, "mcp-wire mcp-wire--clean");
    runLayer.appendChild(runWire);
    const runPts = [{ x: cx + codeW / 2, y: cy }, { x: api._cx - api._w / 2, y: api._cy }];
    const counter = s("text", { x: api._cx, y: 334, "text-anchor": "middle", class: "mcp-run-counter" }, "0");
    const counterNote = s("text", { x: api._cx, y: 360, "text-anchor": "middle", class: "mcp-run-note" }, act.run.note);
    runLayer.append(counter, counterNote);
    const fmt = (n) => Math.round(n).toLocaleString("en-US");

    // ── copy column: step-by-step narration, then the takeaway + bridge ──
    const narration = el("ul", { class: "mcp-narration" });
    const narrEls = (act.narration || []).map(line => {
        const li = el("li", { class: "mcp-narr", text: line });
        narration.appendChild(li);
        return li;
    });
    const insight = el("p", { class: "mcp-caption", text: act.insight });
    const bridge  = el("p", { class: "mcp-bridge", text: act.bridge });
    extra.append(narration, insight, bridge);

    // helpers (hoisted) ────────────────────────────────────────────────────────────
    function flashError(stepEl) {
        if (!g) return;
        const x = s("text", { x: stepEl._x, y: stepEl._y + 5, "text-anchor": "middle", class: "mcp-break-x" }, "✕");
        ringLayer.appendChild(x);
        g.fromTo(x, { opacity: 0, scale: 0.5, transformOrigin: `${stepEl._x}px ${stepEl._y}px` },
            { opacity: 1, scale: 1, duration: 0.2, ease: "back.out(2)",
              onComplete() { g.to(x, { opacity: 0, duration: 0.4, delay: 0.35, onComplete: () => x.remove() }); } });
    }
    function popCheck(node) {
        if (!g) return;
        const x = node._cx - node._w / 2 - 14;
        const chk = s("text", { x, y: node._cy + 5, "text-anchor": "middle", class: "mcp-run-check" }, "✓");
        runLayer.appendChild(chk);
        g.fromTo(chk, { opacity: 0 }, { opacity: 1, duration: 0.15,
            onComplete() { g.to(chk, { opacity: 0, duration: 0.4, delay: 0.25, onComplete: () => chk.remove() }); } });
    }
    function apiPulse() {
        if (!g) return;
        const p = s("circle", { cx: api._cx, cy: api._cy, r: api._w / 2, class: "mcp-api-pulse", fill: "none" });
        nodeLayer.appendChild(p);
        g.fromTo(p, { opacity: 0.6, scale: 0.6, transformOrigin: `${api._cx}px ${api._cy}px` },
            { opacity: 0, scale: 1.5, duration: 0.6, ease: "power2.out", onComplete: () => p.remove() });
    }

    let tl = null;
    if (g && !REDUCE_MOTION) {
        g.set([dev, api], { opacity: 0 });
        g.set(stepEls, { opacity: 0 });
        g.set([token, effort], { opacity: 0 });
        g.set(codeBox, { opacity: 0, scale: 0.6, transformOrigin: "center center" });
        g.set([counter, counterNote], { opacity: 0 });
        g.set([...narrEls, insight, bridge], { opacity: 0, y: 6 });
        const ringLen = (() => { try { return ring.getTotalLength(); } catch { return 740; } })();
        ring.style.strokeDasharray = ringLen; ring.style.strokeDashoffset = ringLen;
        const wireLen = (() => { try { return runWire.getTotalLength(); } catch { return 300; } })();
        runWire.style.strokeDasharray = wireLen; runWire.style.strokeDashoffset = wireLen;

        const revealNarr = (i, pos) => { if (narrEls[i]) tl.to(narrEls[i], { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, pos); };

        tl = g.timeline();

        // Phase 1 — developer + ring + steps appear; narration line 1
        tl.to(dev, { opacity: 1, duration: 0.4, ease: "power2.out" });
        revealNarr(0, "-=0.1");
        tl.to(ring, { strokeDashoffset: 0, duration: 0.8, ease: "power2.out" }, "-=0.2");
        tl.to(stepEls, { opacity: 1, duration: 0.3, ease: "power2.out", stagger: 0.1 }, "-=0.4");
        tl.to([token, effort], { opacity: 1, duration: 0.3 }, "-=0.2");

        // The token grinds round the loop — slow, several laps so it reads clearly
        const laps = 3;
        const orbitDur = 7.2;
        const orbit = { a: -90 };
        let activeIdx = -1;
        tl.to(orbit, {
            a: -90 + 360 * laps + (360 / N) * (N - 1), // finish on the last step ("write the call")
            duration: orbitDur, ease: "power1.inOut",
            onUpdate() {
                const ar = orbit.a * Math.PI / 180;
                token.setAttribute("cx", cx + R * Math.cos(ar));
                token.setAttribute("cy", cy + R * Math.sin(ar));
                const norm = (((orbit.a + 90) % 360) + 360) % 360;
                const idx = Math.round(norm / (360 / N)) % N;
                if (idx !== activeIdx) {
                    if (activeIdx >= 0) stepEls[activeIdx].classList.remove("is-active");
                    stepEls[idx].classList.add("is-active");
                    activeIdx = idx;
                }
            },
        });
        // narration line 2 lands partway through the grind; confusion flashes a few times
        revealNarr(1, `-=${orbitDur - 1.4}`);
        tl.add(() => flashError(stepEls[2]), `-=${orbitDur - 2.6}`);
        tl.add(() => flashError(stepEls[2]), `-=${orbitDur - 4.6}`);
        tl.add(() => flashError(stepEls[2]), `-=2.2`);

        // hold a beat on the finished loop before it collapses
        tl.to({}, { duration: 0.5 });

        // Phase 2 — the loop collapses, deterministic code crystallizes (doc + </> + call)
        tl.to([ring, ...stepEls, token, effort], { opacity: 0, duration: 0.4, ease: "power2.in" });
        tl.to(dev, { opacity: 0.4, duration: 0.4 }, "<");
        tl.to(codeBox, { opacity: 1, scale: 1, duration: 0.55, ease: "back.out(1.7)" }, "-=0.15");
        tl.add(() => { const t = codeBox.querySelector("[data-scramble]"); if (t) glyphScramble(t, act.artifact.label, 0.4); });
        revealNarr(2, "-=0.1");

        // Phase 3 — the API appears, the wire draws, the code invokes it
        tl.to(api, { opacity: 1, duration: 0.4, ease: "back.out(1.5)" }, "+=0.3");
        tl.to(runWire, { strokeDashoffset: 0, duration: 0.5, ease: "power3.out" }, "-=0.2");
        revealNarr(3, "-=0.2");
        // one deliberate invoke: a request travels to the API and it responds
        tl.add(() => travelDot(svg, runPts, { speed: 300, r: 6, onArrive: () => { apiPulse(); popCheck(api); } }), "+=0.1");

        // Phase 4 — the counter climbs to a million (once), takeaway + bridge
        tl.to([counter, counterNote], { opacity: 1, duration: 0.3 }, "+=0.6");
        const c = { v: 0 };
        tl.to(c, { v: act.run.target, duration: 1.9, ease: "power1.out", onUpdate() { counter.textContent = fmt(c.v); } }, "-=0.1");
        tl.to(insight, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, "-=1.4");
        tl.to(bridge, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, "-=0.9");
        tl.add(() => ctl.signalReady?.());

        // Looping payoff — a steady stream of flawless requests, forever
        tl.add(() => {
            const loop = g.timeline({ repeat: -1, repeatDelay: 0.5 });
            for (let i = 0; i < 3; i++) {
                loop.add(() => travelDot(svg, runPts, { speed: 360, onArrive: () => popCheck(api) }), i * 0.34);
            }
            loop.to({}, { duration: 1.1 });
            tl._loop = loop;
        });
    } else {
        // static end state
        [dev, api].forEach(n => n.style.opacity = "1");
        [ring, token, effort, ...stepEls].forEach(e => e.style.opacity = "0");
        runWire.style.strokeDashoffset = "0";
        codeBox.style.opacity = "1";
        counter.textContent = fmt(act.run.target);
        [counter, counterNote].forEach(e => e.style.opacity = "1");
        [...narrEls, insight, bridge].forEach(e => e.style.opacity = "1");
        ctl.signalReady?.();
    }

    return { get tl() { return tl?._loop || tl; }, destroy() { tl?._loop?.kill(); tl?.kill(); } };
}

// ════════════════════════════════════════════════════════════════════════════════
// ACT 4 — Under the Hood (client-server model, primitives, the discover→call loop)
// ════════════════════════════════════════════════════════════════════════════════

function mountUnderHood({ stage, extra, act, ctl = {} }) {
    const g = gsap();
    const VB_W = 820, VB_H = 470;
    const svg = s("svg", { viewBox: `0 0 ${VB_W} ${VB_H}`, class: "mcp-svg", role: "img" });
    svg.append(s("title", {}, "MCP client and server: the server advertises capabilities, the client discovers and calls them"));
    stage.appendChild(svg);

    const linkLayer = s("g", {});
    const nodeLayer = s("g", {});
    const flyLayer  = s("g", {});
    svg.append(linkLayer, nodeLayer, flyLayer);

    const panelY = 70, panelH = 330;
    const clientX = 40, clientW = 250;
    const serverX = 530, serverW = 250;

    function panel(x, label, sub, cls) {
        const grp = s("g", { class: `mcp-uh-panel ${cls}`, transform: `translate(${x},${panelY})` });
        grp.append(
            s("rect", { x: 0, y: 0, width: (x === clientX ? clientW : serverW), height: panelH, rx: 12, class: "mcp-uh-rect" }),
            s("text", { x: (x === clientX ? clientW : serverW) / 2, y: 34, "text-anchor": "middle", class: "mcp-uh-title" }, label),
            s("text", { x: (x === clientX ? clientW : serverW) / 2, y: 55, "text-anchor": "middle", class: "mcp-uh-sub" }, sub),
            s("line", { x1: 16, y1: 70, x2: (x === clientX ? clientW : serverW) - 16, y2: 70, class: "mcp-uh-divider" }),
        );
        return grp;
    }
    const client = panel(clientX, act.clientLabel, act.clientSub, "mcp-uh-panel--client");
    const server = panel(serverX, act.serverLabel, act.serverSub, "mcp-uh-panel--server");
    nodeLayer.append(client, server);

    // client internal parts (Model / Instruction / Tools)
    const partEls = act.clientParts.map((p, i) => {
        const py = panelY + 96 + i * 64;
        const grp = s("g", { class: "mcp-uh-part" });
        grp.append(
            s("rect", { x: clientX + 24, y: py, width: clientW - 48, height: 48, rx: 8, class: "mcp-uh-part-rect" }),
            s("text", { x: clientX + clientW / 2, y: py + 29, "text-anchor": "middle", class: "mcp-uh-part-label" }, p),
        );
        nodeLayer.appendChild(grp);
        return grp;
    });
    const toolsPart = partEls[partEls.length - 1];

    // server primitive cards (tools / resources / prompts) with the who-controls tag
    const primEls = act.primitives.map((p, i) => {
        const py = panelY + 88 + i * 78;
        const grp = s("g", { class: "mcp-prim-card" });
        grp.append(
            s("rect", { x: serverX + 20, y: py, width: serverW - 40, height: 62, rx: 8, class: "mcp-prim-card-rect" }),
            s("text", { x: serverX + 38, y: py + 27, "text-anchor": "start", class: "mcp-prim-card-name" }, p.name),
            s("text", { x: serverX + 38, y: py + 47, "text-anchor": "start", class: "mcp-prim-card-ctrl" }, p.control),
        );
        nodeLayer.appendChild(grp);
        return grp;
    });
    const toolsCard = primEls[0];

    // channels: discover (server → client) above, call (client → server) below
    const discY = panelY + 150, callY = panelY + 224;
    const midX = (serverX + clientX + clientW) / 2;
    const discLine = wirePath(serverX, discY, clientX + clientW, discY, 0, "mcp-wire mcp-wire--clean");
    const callLine = wirePath(clientX + clientW, callY, serverX, callY, 0, "mcp-wire mcp-wire--clean");
    const discLabel = s("text", { x: midX, y: discY - 10, "text-anchor": "middle", class: "mcp-channel-label" }, "tools/list");
    const callLabel = s("text", { x: midX, y: callY + 22, "text-anchor": "middle", class: "mcp-channel-label" }, "tools/call");
    const connector = wirePath(clientX + clientW, panelY + panelH / 2, serverX, panelY + panelH / 2, 0, "mcp-wire mcp-wire--clean");
    linkLayer.append(connector, discLine, callLine, discLabel, callLabel);

    const discPts = [{ x: serverX, y: discY }, { x: clientX + clientW, y: discY }];
    const callPts = [{ x: clientX + clientW, y: callY }, { x: serverX, y: callY }];

    // copy column: narration + primitives legend (name + control + meaning) + insight
    const narration = el("ul", { class: "mcp-narration" });
    const narrEls = (act.narration || []).map(line => { const li = el("li", { class: "mcp-narr", text: line }); narration.appendChild(li); return li; });
    const legend = el("div", { class: "mcp-prim-legend" });
    (act.primitives || []).forEach(p => legend.append(
        el("div", { class: "mcp-prim-legend-row" },
            el("span", { class: "mcp-chip mcp-chip--server", text: p.name }),
            el("span", { class: "mcp-prim-legend-ctrl", text: p.control }),
            el("span", { class: "mcp-prim-legend-note", text: p.note }),
        )));
    const insight = el("p", { class: "mcp-caption", text: act.insight });
    extra.append(narration, legend, insight);

    // a capability label flying server → client during advertisement / discovery
    function flyCap(label) {
        if (!g) return;
        const chip = s("text", { x: serverX, y: discY - 2, "text-anchor": "middle", class: "mcp-fly-cap" }, label);
        flyLayer.appendChild(chip);
        g.fromTo(chip, { opacity: 0 }, { opacity: 1, duration: 0.15 });
        g.to(chip, { attr: { x: clientX + clientW }, duration: 0.75, ease: "power1.inOut",
            onComplete() { g.to(chip, { opacity: 0, duration: 0.2, onComplete: () => chip.remove() }); } });
    }

    let tl = null;
    if (g && !REDUCE_MOTION) {
        g.set([client, server], { opacity: 0 });
        g.set(partEls, { opacity: 0 });
        g.set(primEls, { opacity: 0 });
        g.set([discLine, callLine, discLabel, callLabel], { opacity: 0 });
        g.set([...narrEls, insight, legend], { opacity: 0, y: 6 });
        const connLen = (() => { try { return connector.getTotalLength(); } catch { return 240; } })();
        connector.style.strokeDasharray = connLen; connector.style.strokeDashoffset = connLen;

        const revealNarr = (i, pos) => { if (narrEls[i]) tl.to(narrEls[i], { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, pos); };

        tl = g.timeline();

        // Beat 1 — client + server panels appear, a connector links them
        tl.to(client, { opacity: 1, duration: 0.45, ease: "power2.out" });
        tl.to(server, { opacity: 1, duration: 0.45, ease: "power2.out" }, "-=0.3");
        tl.to(connector, { strokeDashoffset: 0, duration: 0.5, ease: "power3.out" }, "-=0.15");
        revealNarr(0, "-=0.2");

        // Beat 2 — the three server primitives pop in (with their control tags)
        tl.to(primEls, { opacity: 1, duration: 0.35, ease: "back.out(1.5)", stagger: 0.14 }, "+=0.2");
        revealNarr(1, "-=0.2");

        // Beat 3 — client internals + channels appear, connector fades out
        tl.to(connector, { opacity: 0, duration: 0.3 }, "+=0.2");
        tl.to(partEls, { opacity: 1, duration: 0.3, ease: "power2.out", stagger: 0.1 }, "-=0.1");
        tl.to([discLine, discLabel], { opacity: 1, duration: 0.3 });
        revealNarr(2, "-=0.1");
        tl.to([callLine, callLabel], { opacity: 1, duration: 0.3 }, "+=0.15");
        revealNarr(3, "-=0.1");
        // legend + insight appear only after all narration is done
        tl.to(legend, { opacity: 1, y: 0, duration: 0.4 }, "+=0.1");
        tl.to(insight, { opacity: 1, y: 0, duration: 0.4 }, "-=0.1");
        tl.add(() => ctl.signalReady?.());

        // Looping payoff — walk all 3 primitives: advertise → discover → call → result
        tl.add(() => {
            const loop = g.timeline({ repeat: -1, repeatDelay: 0.6 });
            const CYCLE = 4.0;
            act.primitives.forEach((prim, p) => {
                const card = primEls[p];
                const base = p * CYCLE;
                // activate this primitive + switch the channel labels to its methods
                loop.add(() => {
                    primEls.forEach((c, k) => c.classList.toggle("is-active", k === p));
                    discLabel.textContent = prim.list;
                    callLabel.textContent = prim.use;
                }, base);
                // its items advertise / fly server → client (discovery)
                (prim.items || []).forEach((it, i) => loop.add(() => flyCap(it), base + 0.2 + i * 0.22));
                // the client issues the call; the card runs it and a result comes back
                loop.add(() => toolsPart.classList.add("is-active"), base + 1.3);
                loop.add(() => travelDot(svg, callPts, { speed: 320, onArrive: () => card.classList.add("is-call") }), base + 1.6);
                loop.add(() => travelDot(svg, discPts, { speed: 320, onArrive: () => card.classList.remove("is-call") }), base + 2.5);
                loop.add(() => toolsPart.classList.remove("is-active"), base + 3.4);
            });
            loop.add(() => primEls.forEach(c => c.classList.remove("is-active")), act.primitives.length * CYCLE);
            loop.to({}, { duration: act.primitives.length * CYCLE + 0.4 });
            tl._loop = loop;
        });
    } else {
        [client, server].forEach(n => n.style.opacity = "1");
        [...partEls, ...primEls].forEach(n => n.style.opacity = "1");
        [discLine, callLine, discLabel, callLabel].forEach(n => n.style.opacity = "1");
        connector.style.opacity = "0";
        toolsCard.classList.add("is-active");
        [...narrEls, insight, legend].forEach(e => e.style.opacity = "1");
        ctl.signalReady?.();
    }

    return { get tl() { return tl; }, destroy() { tl?._loop?.kill(); tl?.kill(); } };
}

// ════════════════════════════════════════════════════════════════════════════════
// ACT 5 — The Handshake (JSON-RPC lifecycle, dynamic discovery)
// ════════════════════════════════════════════════════════════════════════════════

function mountHandshake({ stage, extra, act, ctl = {} }) {
    const g = gsap();
    const wrap = el("div", { class: "mcp-hs" });

    // channel rail (small SVG) with client + server endpoints
    const railW = 760, railH = 70;
    const svg = s("svg", { viewBox: `0 0 ${railW} ${railH}`, class: "mcp-hs-rail", role: "img" });
    svg.append(s("title", {}, "JSON-RPC 2.0 messages travel between the MCP client and server"));
    const cy = 35, cX = 90, sX = 670;
    svg.append(
        s("line", { x1: cX, y1: cy, x2: sX, y2: cy, class: "mcp-rail-line" }),
        s("circle", { cx: cX, cy, r: 9, class: "mcp-rail-end mcp-rail-end--client" }),
        s("circle", { cx: sX, cy, r: 9, class: "mcp-rail-end mcp-rail-end--server" }),
        s("text", { x: cX, y: 64, "text-anchor": "middle", class: "mcp-rail-cap" }, act.clientLabel),
        s("text", { x: sX, y: 64, "text-anchor": "middle", class: "mcp-rail-cap" }, act.serverLabel),
    );

    // one message card shown at a time so each step is readable
    const cardHost = el("div", { class: "mcp-hs-cardhost" });
    wrap.append(svg, cardHost);
    stage.appendChild(wrap);

    // copy column: what JSON-RPC is + a step list that lights up in sync + transports
    const intro = el("p", { class: "mcp-hs-intro", text: act.jsonrpcNote });
    const stepsWrap = el("div", { class: "mcp-hs-steps" });
    const stepEls = act.messages.map((m, i) => {
        const row = el("div", { class: `mcp-hs-step mcp-hs-step--${m.dir}`, role: "button", tabindex: "0", title: "Show this message" },
            el("span", { class: "mcp-hs-step-arrow", "aria-hidden": "true", text: m.dir === "c2s" ? "→" : "←" }),
            el("div", { class: "mcp-hs-step-body" },
                el("span", { class: "mcp-hs-step-label", text: m.label }),
                el("span", { class: "mcp-hs-step-note", text: m.note }),
            ),
        );
        row.addEventListener("click", () => showStep(i));
        row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showStep(i); } });
        stepsWrap.appendChild(row);
        return row;
    });
    const trans = el("div", { class: "mcp-trans" });
    trans.append(el("p", { class: "mcp-prim-h", text: "Transports" }));
    act.transports.forEach(t => trans.append(el("div", { class: "mcp-trans-row" },
        el("span", { class: "mcp-chip mcp-chip--trans", text: t.name }), el("span", { class: "mcp-trans-note", text: t.note }))));
    extra.append(intro, stepsWrap, trans);

    // tool names referenced by a message (highlighted in the rendered JSON)
    function toolNames(m) {
        const set = new Set();
        (m.discovers || []).forEach(d => set.add(d));
        const j = m.json || {};
        if (j.params && j.params.name) set.add(j.params.name);
        if (j.result && Array.isArray(j.result.tools)) j.result.tools.forEach(t => t.name && set.add(t.name));
        return [...set];
    }
    function jsonHtml(obj, names, hl = []) {
        let str = JSON.stringify(obj, null, 2).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        // key-field highlights (cyan background tint) applied first so tool names can override if overlapping
        hl.forEach(n => {
            const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            str = str.replace(new RegExp(`"${esc}"`, "g"), `"<span class="mcp-json-hl">${n}</span>"`);
        });
        // tool names (bright cyan text)
        names.forEach(n => {
            const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            str = str.replace(new RegExp(`"${esc}"`, "g"), `"<span class="mcp-json-tool">${n}</span>"`);
        });
        return str;
    }

    function buildMsg(m) {
        const card = el("div", { class: `mcp-msg mcp-msg--${m.dir}${m.highlight ? " mcp-msg--key" : ""}` });
        card.append(el("div", { class: "mcp-msg-head" },
            el("span", { class: "mcp-msg-arrow", "aria-hidden": "true", text: m.dir === "c2s" ? "→" : "←" }),
            el("span", { class: "mcp-msg-method", text: m.label }),
            el("span", { class: "mcp-msg-dir", text: m.dir === "c2s" ? "client → server" : "server → client" }),
        ));
        const pre = el("pre", { class: "mcp-msg-json" });
        pre.innerHTML = jsonHtml(m.json, toolNames(m), m.highlights || []);
        card.append(pre);
        if (m.discovers) {
            const chips = el("div", { class: "mcp-discover" });
            m.discovers.forEach(d => chips.append(el("span", { class: "mcp-chip mcp-chip--tool mcp-chip--found", text: d })));
            card.append(chips);
        }
        return card;
    }

    function activate(i) {
        stepEls.forEach((r, k) => { r.classList.toggle("is-active", k === i); r.classList.toggle("is-done", k < i); });
    }
    function showCard(m) {
        cardHost.replaceChildren();
        const card = buildMsg(m);
        cardHost.appendChild(card);
        if (g && !REDUCE_MOTION) {
            g.fromTo(card, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.4, ease: "power3.out" });
            const method = card.querySelector(".mcp-msg-method"); if (method) glyphScramble(method, m.label, 0.3);
            if (m.discovers) g.fromTo(card.querySelectorAll(".mcp-chip--found"), { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)", stagger: 0.1, delay: 0.2 });
        }
    }
    // clicking a step pauses the auto-walk and jumps the stage to that exact message
    function showStep(i) { tl?.pause(); activate(i); showCard(act.messages[i]); }

    let tl = null;
    if (g && !REDUCE_MOTION) {
        tl = g.timeline();
        act.messages.forEach((m, i) => {
            const pts = m.dir === "c2s" ? [{ x: cX, y: cy }, { x: sX, y: cy }] : [{ x: sX, y: cy }, { x: cX, y: cy }];
            tl.add(() => activate(i));
            tl.add(() => travelDot(svg, pts, { speed: 440 }), "+=0.2");
            tl.add(() => showCard(m), "+=1.0");
            tl.to({}, { duration: 1.5 });
        });
        tl.add(() => { stepEls.forEach(r => r.classList.remove("is-active")); stepEls.at(-1).classList.add("is-done"); });
        tl.add(() => ctl.signalReady?.());
    } else {
        stepEls.forEach(r => r.classList.add("is-done"));
        act.messages.forEach(m => cardHost.appendChild(buildMsg(m)));
        ctl.signalReady?.();
    }

    return { destroy() { tl?.kill(); } };
}

// ════════════════════════════════════════════════════════════════════════════════
// (removed) The Adapter — function kept as dead code, no longer in MOUNTERS
// ════════════════════════════════════════════════════════════════════════════════

function mountAdapter({ stage, extra, act }) {
    const g = gsap();
    const wrap = el("div", { class: "mcp-adapter" });

    const req = el("p", { class: "mcp-adapter-req", text: act.request });

    const boards = el("div", { class: "mcp-adapter-boards" });
    const mcpBox = el("div", { class: "mcp-box mcp-box--mcp" }, el("span", { class: "mcp-box-tag", text: "MCP server" }), el("span", { class: "mcp-box-sub", text: "thin layer" }));
    const beBox = el("div", { class: "mcp-box mcp-box--backend" }, el("span", { class: "mcp-box-tag", text: act.backendLabel }), el("span", { class: "mcp-box-flag", text: act.backendTag }));
    boards.append(mcpBox, el("span", { class: "mcp-box-link", "aria-hidden": "true" }, "⇄"), beBox);

    const callList = el("div", { class: "mcp-calls" });
    const meterWrap = el("div", { class: "mcp-meter-wrap" },
        el("span", { class: "mcp-meter-label", text: "context / tokens used" }),
        el("div", { class: "mcp-meter" }, el("div", { class: "mcp-meter-fill" })),
        el("span", { class: "mcp-meter-stat" }),
    );
    wrap.append(req, boards, callList, meterWrap);
    stage.appendChild(wrap);

    // toggle in copy column
    const toggle = el("div", { class: "mcp-toggle", role: "tablist", "aria-label": "Adapter design" });
    const punch = el("p", { class: "mcp-caption", text: act.punchline });
    extra.append(toggle, punch);

    const designs = [act.designs.naive, act.designs.optimized];
    const btns = designs.map((d, i) => {
        const b = el("button", { class: "mcp-toggle-btn", type: "button", role: "tab", "aria-selected": i === 0 ? "true" : "false" },
            el("span", { class: "mcp-toggle-label", text: d.label }),
            el("span", { class: "mcp-toggle-tag", text: d.tagline }));
        toggle.appendChild(b);
        return b;
    });

    let activeTl = null;
    function render(design, idx) {
        activeTl?.kill();
        btns.forEach((b, i) => b.setAttribute("aria-selected", i === idx ? "true" : "false"));
        callList.innerHTML = "";
        const rows = design.calls.map(c => {
            const row = el("div", { class: "mcp-callrow" },
                el("code", { class: "mcp-callrow-mcp", text: c.mcp }),
                el("span", { class: "mcp-callrow-arrow", "aria-hidden": "true", text: "→" }),
                el("code", { class: "mcp-callrow-be", text: c.backend }));
            callList.appendChild(row);
            return row;
        });
        const fill = meterWrap.querySelector(".mcp-meter-fill");
        const statEl = meterWrap.querySelector(".mcp-meter-stat");
        const high = design.tokenLevel === "high";
        fill.classList.toggle("is-high", high);
        statEl.textContent = `${design.stat} · ${design.statNote}`;

        if (g && !REDUCE_MOTION) {
            g.set(rows, { opacity: 0, x: -10 });
            g.set(fill, { width: "0%" });
            activeTl = g.timeline();
            rows.forEach((row, i) => {
                activeTl.to(row, { opacity: 1, x: 0, duration: 0.3, ease: "power3.out" }, i === 0 ? 0 : "+=0.18");
                activeTl.add(() => { g.fromTo(row, { backgroundColor: "rgba(0,255,209,0.14)" }, { backgroundColor: "rgba(0,0,0,0)", duration: 0.5 }); });
            });
            activeTl.to(fill, { width: high ? "92%" : "24%", duration: high ? 0.8 : 0.4, ease: "power2.out" }, 0.1);
        } else {
            fill.style.width = high ? "92%" : "24%";
        }
    }
    btns.forEach((b, i) => b.addEventListener("click", () => render(designs[i], i)));
    render(designs[0], 0);

    return { destroy() { activeTl?.kill(); } };
}

// ════════════════════════════════════════════════════════════════════════════════
// (removed) The Landscape — function kept as dead code, no longer in MOUNTERS
// ════════════════════════════════════════════════════════════════════════════════

function mountLandscape({ stage, extra, act }) {
    const g = gsap();
    const wrap = el("div", { class: "mcp-landscape" });
    const layers = el("div", { class: "mcp-layers" });
    const layerEls = act.compare.map(c => {
        const row = el("div", { class: `mcp-layer mcp-layer--${c.axis}${c.lead ? " is-lead" : ""}` },
            el("span", { class: "mcp-layer-name", text: c.name }),
            el("span", { class: "mcp-layer-role", text: c.role }));
        layers.appendChild(row);
        return row;
    });
    wrap.append(layers);
    stage.appendChild(wrap);

    const tlBox = el("div", { class: "mcp-timeline" });
    tlBox.append(el("p", { class: "mcp-prim-h", text: act.adoptionLabel }));
    const rail = el("div", { class: "mcp-timeline-rail" });
    const miles = act.adoption.map(m => {
        const ms = el("div", { class: "mcp-milestone" },
            el("span", { class: "mcp-milestone-dot", "aria-hidden": "true" }),
            el("span", { class: "mcp-milestone-when", text: m.when }),
            el("span", { class: "mcp-milestone-what", text: m.what }));
        rail.appendChild(ms);
        return ms;
    });
    tlBox.append(rail);
    extra.append(tlBox);

    let tl = null;
    if (g && !REDUCE_MOTION) {
        g.set(layerEls, { opacity: 0, y: 18 });
        g.set(miles, { opacity: 0, x: -8 });
        tl = g.timeline();
        tl.to(layerEls, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out", stagger: 0.08 });
        tl.to(miles, { opacity: 1, x: 0, duration: 0.4, ease: "power3.out", stagger: 0.1 }, "-=0.1");
    }
    return { destroy() { tl?.kill(); } };
}

// ════════════════════════════════════════════════════════════════════════════════
// ACT 6 — The Caveats (security surface + mitigations)
// ════════════════════════════════════════════════════════════════════════════════

function mountCaveats({ stage, extra, act }) {
    const g = gsap();
    const wrap = el("div", { class: "mcp-caveats" });

    const poison = el("div", { class: "mcp-poison" });
    poison.append(el("p", { class: "mcp-prim-h", text: act.poison.label }));
    const code = el("pre", { class: "mcp-poison-code" });
    const clean = el("span", { class: "mcp-poison-clean", text: act.poison.clean + "\n" });
    const evil = el("span", { class: "mcp-poison-evil", text: act.poison.hidden });
    code.append(clean, evil);
    poison.append(code);

    const risks = el("div", { class: "mcp-risks" });
    const riskEls = act.risks.map(r => {
        const card = el("div", { class: "mcp-risk" },
            el("span", { class: "mcp-risk-name", text: r.name }),
            el("p", { class: "mcp-risk-note", text: r.note }),
            el("span", { class: "mcp-risk-scan", "aria-hidden": "true" }));
        risks.appendChild(card);
        return card;
    });
    wrap.append(poison, risks);
    stage.appendChild(wrap);

    const mitig = el("div", { class: "mcp-mitig" });
    mitig.append(el("p", { class: "mcp-prim-h", text: "Mitigations" }));
    const chips = el("div", { class: "mcp-chiprow" });
    act.mitigations.forEach(m => chips.append(el("span", { class: "mcp-chip mcp-chip--safe", text: "✓ " + m })));
    mitig.append(chips);
    extra.append(mitig);

    let tl = null;
    if (g && !REDUCE_MOTION) {
        g.set(evil, { opacity: 0 });
        g.set(riskEls, { opacity: 0, y: 14 });
        g.set(chips.children, { opacity: 0, scale: 0.6, transformOrigin: "left center" });
        tl = g.timeline();
        // hidden malicious line glitch-flickers in
        tl.to(evil, { opacity: 1, duration: 0.1, delay: 0.4 });
        tl.fromTo(evil, { opacity: 1 }, { opacity: 0.25, duration: 0.08, repeat: 5, yoyo: true });
        tl.to(riskEls, { opacity: 1, y: 0, duration: 0.45, ease: "power3.out", stagger: 0.12 }, "+=0.1");
        tl.to(chips.children, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)", stagger: 0.08 }, "-=0.1");
    }
    return { destroy() { tl?.kill(); } };
}

// ════════════════════════════════════════════════════════════════════════════════
// ACT 6 — An Abstraction, Not a Replacement (isometric 3D layered stack)
// A floating AI chip sits above the orange MCP server board (with components), which sits
// on the grey existing-infrastructure base. Data rises up through the stack on entry,
// and a callout explains the model only ever touches the MCP schema.
// ════════════════════════════════════════════════════════════════════════════════

function mountVsApis({ stage, extra, act, ctl = {} }) {
    const g = gsap();
    const VB_W = 1040, VB_H = 760;
    const svg = s("svg", { viewBox: `0 0 ${VB_W} ${VB_H}`, class: "mcp-svg", role: "img" });
    svg.append(s("title", {}, "MCP is an isometric abstraction layer above your existing infrastructure"));
    stage.appendChild(svg);

    const flowLayer = s("g", {}); const stackLayer = s("g", {}); const labelLayer = s("g", {});
    svg.append(flowLayer, stackLayer, labelLayer);

    const CX = 520;
    const layers = act.layers || [];
    const byKind = Object.fromEntries(layers.map(L => [L.kind, L]));

    // an isometric slab (diamond top + left & right side faces) drawn from its top-face centre
    const poly = (pts, cls) => s("polygon", { points: pts.map(p => p[0] + "," + p[1]).join(" "), class: cls });
    function isoSlab(cx, cyT, w, h, t, base) {
        const T = [cx, cyT - h / 2], R = [cx + w / 2, cyT], B = [cx, cyT + h / 2], L = [cx - w / 2, cyT];
        const Bt = [B[0], B[1] + t], Rt = [R[0], R[1] + t], Lt = [L[0], L[1] + t];
        const grp = s("g", { class: "mcp-iso-slab" });
        grp.append(
            poly([L, B, Bt, Lt], `${base}-left`),
            poly([R, B, Bt, Rt], `${base}-right`),
            poly([T, R, B, L], `${base}-top`),
        );
        grp._corners = { T, R, B, L, cx, cyT };
        return grp;
    }
    const isoLine = (a, b, cls) => s("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: cls });

    // layer geometry (top-face centre y)
    const baseCY = 560, boardCY = 330, chipCY = 140;

    // BASE — existing infrastructure (grey, thick block)
    const baseG = isoSlab(CX, baseCY, 400, 210, 58, "mcp-iso-base");

    // BOARD — MCP server (orange) + circuit traces + components on its top face
    const boardG = isoSlab(CX, boardCY, 350, 184, 24, "mcp-iso-board");
    // a couple of faint circuit traces across the board top
    boardG.appendChild(isoLine([CX - 120, boardCY - 6], [CX + 110, boardCY + 10], "mcp-iso-trace"));
    boardG.appendChild(isoLine([CX - 60, boardCY + 40], [CX + 130, boardCY - 18], "mcp-iso-trace"));
    const compOffsets = [[-100, 0], [-26, -20], [62, -8], [-34, 34], [44, 40]];
    compOffsets.forEach(([dx, dy]) => boardG.appendChild(isoSlab(CX + dx, boardCY + dy, 54, 28, 10, "mcp-iso-comp")));
    // a capacitor (orange pill) to the right
    boardG.appendChild(s("ellipse", { cx: CX + 120, cy: boardCY + 12, rx: 26, ry: 13, class: "mcp-iso-cap" }));

    // CHIP — AI model/agent (light) with circuit traces, a dark die, and legs to the board
    const chipG = isoSlab(CX, chipCY, 168, 90, 26, "mcp-iso-chip");
    // circuit traces on the chip top, radiating from the die
    [[-1, -0.5], [1, -0.5], [-1, 0.5], [1, 0.5]].forEach(([sx, sy]) =>
        chipG.appendChild(isoLine([CX, chipCY], [CX + sx * 58, chipCY + sy * 30], "mcp-iso-trace mcp-iso-trace--chip")));
    chipG.appendChild(poly([[CX, chipCY - 13], [CX + 24, chipCY], [CX, chipCY + 13], [CX - 24, chipCY]], "mcp-iso-die"));

    // legs: short pins from the chip down onto the board (with landing pads)
    const legG = s("g", { class: "mcp-iso-legs" });
    const chipBottomY = chipCY + 45 + 26;   // bottom of chip body
    const boardTopY = boardCY - 92;          // top corner of board
    [-58, -20, 20, 58].forEach(dx => {
        legG.append(
            isoLine([CX + dx, chipBottomY - 8], [CX + dx, boardTopY + 6], "mcp-iso-leg"),
            s("rect", { x: CX + dx - 5, y: boardTopY + 2, width: 10, height: 6, rx: 1, class: "mcp-iso-pad" }),
        );
    });

    stackLayer.append(baseG, boardG, legG, chipG);

    // ── upward flow: arrows + rising dots from the infrastructure into the board ──
    const flowX = [455, 505, 555, 605];
    const arrowTopY = boardG._corners.B[1] - 6, arrowBotY = baseG._corners.T[1] + 26;
    const arrows = flowX.map(x => {
        const a = s("path", { d: `M ${x} ${arrowBotY} L ${x} ${arrowTopY} M ${x - 7} ${arrowTopY + 9} L ${x} ${arrowTopY} L ${x + 7} ${arrowTopY + 9}`, class: "mcp-flow-arrow", fill: "none" });
        flowLayer.appendChild(a); return a;
    });
    const upPaths = flowX.map(x => [{ x, y: arrowBotY }, { x, y: arrowTopY }]);

    // ── left leader labels (start-anchored so they never clip) ──
    const leaderFor = (corners, L, anchorY) => {
        labelLayer.append(s("line", { x1: 232, y1: anchorY, x2: corners.L[0], y2: corners.L[1], class: "mcp-layer-conn" }));
        labelLayer.append(s("text", { x: 24, y: anchorY - (L.sub ? 6 : -4), "text-anchor": "start", class: "mcp-layer-label" }, L.name));
        if (L.sub) labelLayer.append(s("text", { x: 24, y: anchorY + 13, "text-anchor": "start", class: "mcp-layer-label mcp-layer-label--sub" }, L.sub));
    };
    if (byKind.model) leaderFor(chipG._corners, byKind.model, chipCY);
    if (byKind.mcp) leaderFor(boardG._corners, byKind.mcp, boardCY);
    if (byKind.infra) leaderFor(baseG._corners, byKind.infra, baseCY);

    // ── right callout box ──
    const coX = 752, coW = 276;
    const coLines = wrapText(act.callout || "", Math.floor((coW - 44) / 8));
    const coLH = 26;
    const coH = coLines.length * coLH + 48;
    const coY = Math.round((VB_H - coH) / 2);
    const callout = s("g", { class: "mcp-callout-box" });
    callout.append(s("rect", { x: coX, y: coY, width: coW, height: coH, rx: 14, class: "mcp-callout-rect" }));
    callout.appendChild(svgLines(coX + 22, coY + 36, coLines, "mcp-callout-text", coLH, "start"));
    labelLayer.appendChild(callout);

    // copy column: the takeaway
    const insight = el("p", { class: "mcp-caption", text: act.insight });
    extra.append(insight);

    const leaders = labelLayer.querySelectorAll(".mcp-layer-conn, .mcp-layer-label");

    let tl = null;
    if (g && !REDUCE_MOTION) {
        g.set([baseG, boardG, legG, chipG], { opacity: 0, y: 40 });
        g.set(arrows, { opacity: 0 });
        g.set(callout, { opacity: 0, x: 14 });
        g.set(insight, { opacity: 0, y: 6 });
        leaders.forEach(n => g.set(n, { opacity: 0 }));

        tl = g.timeline();
        // assemble bottom → up: base, board, chip (+legs)
        tl.to(baseG, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" });
        tl.to(boardG, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, "-=0.25");
        tl.to([legG, chipG], { opacity: 1, y: 0, duration: 0.55, ease: "back.out(1.4)" }, "-=0.25");
        tl.to(leaders, { opacity: 1, duration: 0.35, stagger: 0.05 }, "-=0.3");
        tl.to(arrows, { opacity: 0.8, duration: 0.3, stagger: 0.04 }, "-=0.2");
        tl.to(callout, { opacity: 1, x: 0, duration: 0.5, ease: "power3.out" }, "-=0.1");
        tl.to(insight, { opacity: 1, y: 0, duration: 0.4 }, "-=0.2");
        tl.add(() => ctl.signalReady?.());

        // live: data continuously rising from the infrastructure into the MCP board
        tl.add(() => {
            const loop = g.timeline({ repeat: -1, repeatDelay: 0.4 });
            upPaths.forEach((pts, i) => loop.add(() => travelDot(svg, pts, { speed: 130, color: "#FF9E6D" }), i * 0.32));
            loop.to({}, { duration: 2.4 });
            tl._loop = loop;
        });
    } else {
        [baseG, boardG, legG, chipG].forEach(n => n.style.opacity = "1");
        arrows.forEach(n => n.style.opacity = "0.8");
        callout.style.opacity = "1";
        insight.style.opacity = "1";
        ctl.signalReady?.();
    }

    return { get tl() { return tl; }, destroy() { tl?._loop?.kill(); tl?.kill(); } };
}

// ════════════════════════════════════════════════════════════════════════════════
// Controller
// ════════════════════════════════════════════════════════════════════════════════

const MOUNTERS = { mess: mountMess, standard: mountStandard, humanapi: mountHumanApi, underhood: mountUnderHood, handshake: mountHandshake, vsapis: mountVsApis };

export function initMcpLab(rootEl, opts = {}) {
    const content = opts.content;
    if (!rootEl || !content) return { destroy() {} };
    const acts = content.acts;
    const ui = content.ui;

    rootEl.innerHTML = "";
    const lab = el("div", { class: "mcp-lab", tabindex: "-1" });

    // Per-act heading + summary live in a full-width bar at the very top (replaces the hero)
    const eyebrow = el("p", { class: "mcp-eyebrow" });
    const title = el("h2", { class: "mcp-title" });
    const bodyText = el("p", { class: "mcp-body-text", "aria-live": "polite" });
    const actHeader = el("header", { class: "mcp-actheader" }, eyebrow, title, bodyText);

    // body grid: the visualization (center stage) + the animation's supporting copy
    const extra = el("div", { class: "mcp-scene-extra" });
    // Stable analogy slot: lives outside `extra`, so per-act mounters (esp. Act 1's progressive
    // story, which rebuilds `extra`) never disturb it. Populated centrally in renderAct().
    const analogySlot = el("div", { class: "mcp-analogy-slot" });
    const copy = el("div", { class: "mcp-copy" }, extra, analogySlot);

    const stage = el("div", { class: "mcp-stage" });
    const wipe = el("div", { class: "mcp-wipe", "aria-hidden": "true" });
    const replayBtn = el("button", { class: "mcp-stage-btn mcp-replay-btn", type: "button", "aria-label": "Replay animation", title: "Replay" }, "↻");
    const expandBtn = el("button", { class: "mcp-stage-btn mcp-expand-btn", type: "button", "aria-label": "Expand visualization", title: "Expand" }, "⤢");
    const stageTools = el("div", { class: "mcp-stage-tools" }, replayBtn, expandBtn);
    const stageWrap = el("div", { class: "mcp-stagewrap" }, stage, wipe, stageTools);

    // ── expand / collapse the visual box into a fullscreen overlay ──────────────
    let backdrop = null;
    function setExpanded(on) {
        if (on === !!backdrop) return;
        if (on) {
            backdrop = el("div", { class: "mcp-stage-backdrop" });
            backdrop.addEventListener("click", () => setExpanded(false));
            rootEl.appendChild(backdrop);
            stageWrap.classList.add("mcp-stagewrap--expanded");
            expandBtn.textContent = "✕";
            expandBtn.setAttribute("aria-label", "Collapse visualization");
            expandBtn.title = "Collapse";
        } else {
            stageWrap.classList.remove("mcp-stagewrap--expanded");
            backdrop?.remove();
            backdrop = null;
            expandBtn.textContent = "⤢";
            expandBtn.setAttribute("aria-label", "Expand visualization");
            expandBtn.title = "Expand";
        }
    }
    expandBtn.addEventListener("click", (e) => { e.stopPropagation(); setExpanded(!backdrop); });
    replayBtn.addEventListener("click", (e) => { e.stopPropagation(); replay(); });

    // nav pill: spans full grid width so it is centred under both columns
    const prevBtn = el("button", { class: "mcp-nav-btn mcp-nav-prev", type: "button" }, "‹ " + ui.prev);
    const nextBtn = el("button", { class: "mcp-nav-btn mcp-nav-next", type: "button" }, ui.next + " ›");
    const dots = el("div", { class: "mcp-dots", role: "tablist", "aria-label": "Acts" });
    const dotEls = acts.map((a, i) => {
        const d = el("button", { class: `mcp-dot${a.deeper ? " is-deeper" : ""}`, type: "button", role: "tab", "aria-label": `Act ${i + 1}: ${a.title}`, "aria-selected": "false" });
        dots.appendChild(d);
        return d;
    });
    const navPill = el("div", { class: "mcp-nav-pill" }, prevBtn, dots, nextBtn);
    const controls = el("div", { class: "mcp-controls" }, navPill);

    const stageCol = el("div", { class: "mcp-stage-col" }, stageWrap);
    const bodyGrid = el("div", { class: "mcp-bodygrid" }, stageCol, copy, controls);

    lab.append(actHeader, bodyGrid);
    rootEl.appendChild(lab);

    // ── state ──
    let current = -1;
    let active = null;
    let io = null;
    let analogyReveal = null; // pending delayedCall/timeout that fades in the analogy toggle

    function playWipe() {
        const g = gsap();
        if (!g || REDUCE_MOTION) return;
        const blade = el("div", { class: "mcp-blade", "aria-hidden": "true" });
        wipe.appendChild(blade);
        g.fromTo(blade, { xPercent: -120 }, {
            xPercent: 220, duration: 0.46, ease: "power3.inOut",
            onComplete() { blade.remove(); },
        });
    }

    // (re)build the visualization + copy for a given act index
    function renderAct(i) {
        const act = acts[i];
        active?.destroy?.();
        active = null;
        stage.innerHTML = "";
        extra.innerHTML = "";

        eyebrow.textContent = act.eyebrow;
        glyphScramble(title, act.title, 0.4) || (title.textContent = act.title);
        bodyText.textContent = act.body;

        // Analogy toggle: build it now (collapsed), but only reveal it once the act's entrance
        // crossfade + heading text-sync has settled, so it never competes with the animation.
        if (analogyReveal) { analogyReveal.kill ? analogyReveal.kill() : clearTimeout(analogyReveal); analogyReveal = null; }
        analogySlot.innerHTML = "";
        const analogyCard = buildAnalogy(act.analogy);
        let signalReady = null;
        if (analogyCard) {
            analogySlot.appendChild(analogyCard);
            let fired = false;
            signalReady = () => {
                if (fired) return; fired = true;
                if (analogyReveal) { analogyReveal.kill ? analogyReveal.kill() : clearTimeout(analogyReveal); analogyReveal = null; }
                analogyCard.classList.add("is-ready");
            };
            const g2 = gsap();
            if (!g2 || REDUCE_MOTION) signalReady();
            else analogyReveal = g2.delayedCall(8, signalReady); // safety net; mounter fires earlier via ctl.signalReady
        }

        const mount = MOUNTERS[act.id];
        const doMount = () => { active = mount({ stage, extra, act, ctl: { ui, signalReady } }); };
        if (window.gsap || REDUCE_MOTION) doMount(); else whenGsap(doMount);

        observeStage();
    }

    // Apple-like crossfade between acts: the stage box stays a fixed size/position, only
    // its contents (heading + visualization + copy) fade out → swap → fade in.
    const fadeEls = () => [actHeader, stageWrap, copy];
    function goTo(i) {
        i = Math.max(0, Math.min(acts.length - 1, i));
        if (i === current) return;
        setExpanded(false); // never carry the fullscreen overlay across acts

        dotEls.forEach((d, k) => d.setAttribute("aria-selected", k === i ? "true" : "false"));
        prevBtn.disabled = i === 0;
        nextBtn.textContent = i === acts.length - 1 ? (ui.restart + " ↺") : (ui.next + " ›");

        const g = gsap();
        if (g && !REDUCE_MOTION && current >= 0) {
            g.to(fadeEls(), {
                opacity: 0, duration: 0.18, ease: "power1.in",
                onComplete() {
                    renderAct(i);
                    g.fromTo(fadeEls(), { opacity: 0 }, { opacity: 1, duration: 0.34, ease: "power2.out" });
                },
            });
        } else {
            renderAct(i);
        }
        current = i;
    }

    // Replay the current act's animation from the top (keeps expand state).
    function replay() {
        if (current < 0) return;
        renderAct(current);
    }

    function observeStage() {
        io?.disconnect();
        io = new IntersectionObserver(entries => {
            entries.forEach(e => {
                const tl = active && active.tl;
                if (!tl) return;
                if (e.isIntersecting) tl.play?.(); else tl.pause?.();
            });
        }, { threshold: 0.1 });
        io.observe(stage);
    }

    // ── wiring ──
    prevBtn.addEventListener("click", () => goTo(current - 1));
    nextBtn.addEventListener("click", () => { if (current === acts.length - 1) goTo(0); else goTo(current + 1); });
    dotEls.forEach((d, i) => d.addEventListener("click", () => goTo(i)));

    const onKey = (e) => {
        if (e.key === "Escape" && backdrop) { e.preventDefault(); setExpanded(false); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); goTo(current + 1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); goTo(current - 1); }
    };
    lab.addEventListener("keydown", onKey);

    const onVis = () => { const tl = active && active.tl; if (!tl) return; document.hidden ? tl.pause?.() : tl.play?.(); };
    document.addEventListener("visibilitychange", onVis);

    // boot
    goTo(0);

    return {
        destroy() {
            active?.destroy?.();
            if (analogyReveal) { analogyReveal.kill ? analogyReveal.kill() : clearTimeout(analogyReveal); analogyReveal = null; }
            io?.disconnect();
            document.removeEventListener("visibilitychange", onVis);
            lab.removeEventListener("keydown", onKey);
            rootEl.innerHTML = "";
        },
    };
}

// ─── FAQ drawer ─────────────────────────────────────────────────────────────────

function buildDrawer(content, ui, onJump) {
    const root = el("div", { class: "mcp-drawer", "aria-hidden": "true" });
    const backdrop = el("div", { class: "mcp-drawer-backdrop", "data-close": "1" });
    const panel = el("div", { class: "mcp-drawer-panel", role: "dialog", "aria-modal": "true", "aria-label": ui.faqLabel });
    const head = el("div", { class: "mcp-drawer-head" },
        el("h2", { class: "mcp-drawer-title", text: ui.faqLabel }),
        el("button", { class: "mcp-drawer-close", type: "button", "aria-label": "Close" }, "✕"));
    const list = el("div", { class: "mcp-faq-list" });
    content.faq.forEach(f => {
        const item = el("details", { class: "mcp-faq-item" });
        const sum = el("summary", { class: "mcp-faq-q", text: f.q });
        item.append(sum);
        if (f.a) item.append(el("p", { class: "mcp-faq-a", text: f.a }));
        if (f.actId) {
            const jump = el("button", { class: "mcp-faq-jump", type: "button" }, "Show me ↗");
            jump.addEventListener("click", () => onJump(f.actId));
            item.append(jump);
        }
        list.appendChild(item);
    });
    panel.append(head, list);
    root.append(backdrop, panel);

    let open = false;
    let lastFocus = null;
    function setOpen(v) {
        open = v;
        root.setAttribute("aria-hidden", v ? "false" : "true");
        root.classList.toggle("is-open", v);
        const g = gsap();
        if (v) {
            lastFocus = document.activeElement;
            if (g && !REDUCE_MOTION) { g.fromTo(panel, { xPercent: 100 }, { xPercent: 0, duration: 0.32, ease: "power3.out" }); g.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.2 }); }
            head.querySelector(".mcp-drawer-close").focus();
        } else if (lastFocus?.focus) {
            lastFocus.focus();
        }
    }
    head.querySelector(".mcp-drawer-close").addEventListener("click", () => setOpen(false));
    backdrop.addEventListener("click", () => setOpen(false));
    const onKey = (e) => { if (open && e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);

    return {
        root,
        open: () => setOpen(true),
        close: () => setOpen(false),
        isOpen: () => open,
        destroy: () => document.removeEventListener("keydown", onKey),
    };
}
