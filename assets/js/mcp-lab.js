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

// Quadratic wire between two points with a deterministic bow.
function wirePath(x1, y1, x2, y2, bow, cls) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const cx = mx, cy = my + bow;
    return s("path", { d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`, class: cls, fill: "none" });
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
    const swapBtn = el("button", { class: "mcp-action-btn", type: "button" }, act.swapLabel + " ⟳");
    const revealBtn = el("button", { class: "mcp-action-btn", type: "button" }, act.revealLabel + " ↗");
    const actions = el("div", { class: "mcp-action-row" }, swapBtn, revealBtn);
    extra.append(pains, counter, actions, caption);

    function showCaption(text) {
        if (!text) { caption.style.visibility = "hidden"; return; }
        caption.textContent = text;
        caption.style.visibility = "visible";
        if (g && !REDUCE_MOTION) g.fromTo(caption, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.3 });
    }

    // all three realizations are true from the start — keep them lit + readable
    Object.values(painMap).forEach(r => { r.classList.add("is-active"); r.style.opacity = 1; });

    // ── two INDEPENDENT toggles that compose. `multiplied` fans Gemini + GPT-4o in;
    //    `swapped` replaces Claude with DeepSeek (Claude dims, its wires break). Turn on
    //    both and you get the complete mess: four models, a full tangle + dead wires. ──
    let multiplied = false, swapped = false, lastAction = null;

    function render(firstLoad) {
        clearScene();
        [claudeNode, apps[1], apps[2], swapNode].forEach(nodeOff);

        if (firstLoad && g && !REDUCE_MOTION) g.fromTo(tools, { opacity: 0, scale: 0.5, transformOrigin: "center center" }, { opacity: 1, scale: 1, duration: 0.28, ease: "back.out(2)", stagger: 0.05 });
        else tools.forEach(t => t.style.opacity = 1);

        const d = firstLoad ? 0.35 : 0.1;

        // Claude — always present. Dimmed with dead wires when swapped, live otherwise.
        if (swapped) {
            nodeOn(claudeNode, { dim: true });
            breakBundle(wireFromModel(claudeNode, 0, false));
            nodeOn(swapNode, { delay: 0.15 });               // DeepSeek takes its place
            drawBundle(wireFromModel(swapNode, 3, false), d + 0.3);
        } else {
            nodeOn(claudeNode);
            drawBundle(wireFromModel(claudeNode, 0, false), d);
        }

        // Gemini + GPT-4o — only when multiplied
        if (multiplied) {
            nodeOn(apps[1], { delay: 0.12 });
            nodeOn(apps[2], { delay: 0.24 });
            drawBundle(wireFromModel(apps[1], 1, false), d + 0.15);
            drawBundle(wireFromModel(apps[2], 2, false), d + 0.3);
        }

        // counter = live models × services (swap is a 1-for-1 replacement, so the count
        // tracks `multiplied`; the broken Claude wires are extra carnage, not new live ones)
        const liveModels = multiplied ? 3 : 1;
        setCounter(liveModels, !firstLoad && multiplied);

        // caption reflects the most recent toggle that's currently ON
        let cap = null;
        if (lastAction === "swap") cap = swapped ? act.swapCaption : (multiplied ? act.revealCaption : null);
        else if (lastAction === "multiply") cap = multiplied ? act.revealCaption : (swapped ? act.swapCaption : null);
        showCaption(cap);

        swapBtn.classList.toggle("is-on", swapped);
        swapBtn.setAttribute("aria-pressed", String(swapped));
        revealBtn.classList.toggle("is-on", multiplied);
        revealBtn.setAttribute("aria-pressed", String(multiplied));
    }

    swapBtn.addEventListener("click", () => { swapped = !swapped; lastAction = "swap"; render(); });
    revealBtn.addEventListener("click", () => { multiplied = !multiplied; lastAction = "multiply"; render(); });

    // initial mount: animated → one model (Claude); reduced motion → the full trio tangle
    if (REDUCE_MOTION) multiplied = true;
    render(true);

    return { destroy() { timers.forEach(t => t.kill()); flows.forEach(f => f.kill()); } };
}

// ════════════════════════════════════════════════════════════════════════════════
// ACT 2 — The Standard (tangle collapses to N+M through the MCP layer)
// ════════════════════════════════════════════════════════════════════════════════

function mountStandard({ stage, extra, act }) {
    const g = gsap();
    const VB_W = 760, VB_H = 460;
    const svg = s("svg", { viewBox: `0 0 ${VB_W} ${VB_H}`, class: "mcp-svg", role: "img" });
    svg.append(s("title", {}, "MCP collapses M×N integrations into M+N"));
    stage.appendChild(svg);

    const tangleLayer = s("g", {}); const cleanLayer = s("g", {}); const nodeLayer = s("g", {});
    svg.append(tangleLayer, cleanLayer, nodeLayer);

    const appY = [110, 230, 350], toolY = [80, 180, 280, 380];
    const appX = 120, toolX = 640, mcpX = 380;
    const apps = ["Claude", "Gemini", "GPT-4o"].map((l, i) => nodeGroup(appX, appY[i], l, `mcp-node--${AXES[i % AXES.length]}`));
    // right column is now one MCP server per service — not a single broker
    const tools = ["github-mcp", "postgres-mcp", "slack-mcp", "drive-mcp"].map((l, i) => nodeGroup(toolX, toolY[i], l, "mcp-node--server"));

    // MCP hub bar
    const hub = s("g", { class: "mcp-hub", transform: `translate(${mcpX},230)` });
    hub.append(
        s("rect", { x: -34, y: -170, width: 68, height: 340, rx: 14, class: "mcp-hub-rect" }),
        s("text", { x: 0, y: -140, "text-anchor": "middle", class: "mcp-hub-label", "data-scramble": "MCP" }, "MCP"),
        s("text", { x: 0, y: 150, "text-anchor": "middle", class: "mcp-hub-port" }, "⇄"),
    );

    // messy tangle (12)
    const tangle = [];
    tools.forEach((t, j) => apps.forEach((a, i) => {
        const bow = ((i * 7 + j * 13) % 9 - 4) * 9;
        const p = wirePath(a._cx + a._w / 2, a._cy, t._cx - t._w / 2, t._cy, bow, "mcp-wire");
        tangleLayer.appendChild(p); tangle.push(p);
    }));

    // clean N+M (7)
    const clean = [];
    apps.forEach(a => { const p = wirePath(a._cx + a._w / 2, a._cy, mcpX - 34, 230, (230 - a._cy) * 0.05, "mcp-wire mcp-wire--clean"); cleanLayer.appendChild(p); clean.push({ el: p, pts: [{ x: a._cx + a._w / 2, y: a._cy }, { x: mcpX - 34, y: 230 }] }); });
    tools.forEach(t => { const p = wirePath(mcpX + 34, 230, t._cx - t._w / 2, t._cy, (t._cy - 230) * 0.05, "mcp-wire mcp-wire--clean"); cleanLayer.appendChild(p); clean.push({ el: p, pts: [{ x: mcpX + 34, y: 230 }, { x: t._cx - t._w / 2, y: t._cy }] }); });

    nodeLayer.append(...apps, ...tools, hub);

    const caption = el("p", { class: "mcp-caption", text: act.collapseCaption });
    const usb = el("div", { class: "mcp-usb" }, el("span", { class: "mcp-usb-icon", "aria-hidden": "true" }, "⌁"), el("span", { text: act.analogy }));
    const origin = el("p", { class: "mcp-origin", text: act.origin });
    extra.append(usb, caption, origin);

    let tl = null;
    if (g && !REDUCE_MOTION) {
        g.set(hub, { opacity: 0, scale: 0.6, transformOrigin: "center center" });
        g.set(usb, { opacity: 0, y: 8 });
        clean.forEach(c => { const L = (() => { try { return c.el.getTotalLength(); } catch { return 400; } })(); c.el.style.strokeDasharray = L; c.el.style.strokeDashoffset = L; });
        tl = g.timeline();
        // chaos → order: fade the tangle out as the hub snaps in
        tl.to(tangle, { opacity: 0, duration: 0.5, ease: "power2.inOut", stagger: 0.015 });
        tl.to(hub, { opacity: 1, scale: 1, duration: 0.45, ease: "back.out(1.7)" }, "-=0.25");
        tl.add(() => { const lab = hub.querySelector("[data-scramble]"); if (lab) glyphScramble(lab, "MCP", 0.4); }, "-=0.2");
        tl.to(clean.map(c => c.el), { strokeDashoffset: 0, duration: 0.5, ease: "power3.out", stagger: 0.06 }, "-=0.1");
        tl.to(usb, { opacity: 1, y: 0, duration: 0.4, ease: "power3.out" }, "-=0.2");
        // pulse traveling dots along the tidy lines, looping (callbacks re-fire each cycle)
        tl.add(() => {
            const loop = g.timeline({ repeat: -1, repeatDelay: 1.2 });
            clean.forEach((c, i) => loop.add(() => travelDot(svg, c.pts, { speed: 320 }), i * 0.12));
            loop.to({}, { duration: 1.1 }); // hold so the cycle has a length before repeatDelay
            tl._loop = loop;
        });
    } else {
        tangle.forEach(t => t.style.opacity = 0);
        usb.style.opacity = 1;
    }

    return { get tl() { return tl?._loop || tl; }, destroy() { tl?._loop?.kill(); tl?.kill(); } };
}

// ════════════════════════════════════════════════════════════════════════════════
// ACT 3 — The Handshake (JSON-RPC lifecycle, dynamic discovery)
// ════════════════════════════════════════════════════════════════════════════════

function mountHandshake({ stage, extra, act }) {
    const g = gsap();
    const wrap = el("div", { class: "mcp-hs" });

    // channel rail (small SVG) with client + server endpoints
    const railW = 760, railH = 70;
    const svg = s("svg", { viewBox: `0 0 ${railW} ${railH}`, class: "mcp-hs-rail", role: "img" });
    svg.append(s("title", {}, "JSON-RPC 2.0 messages travel between the client and the server"));
    const cy = 35, cX = 90, sX = 670;
    svg.append(
        s("line", { x1: cX, y1: cy, x2: sX, y2: cy, class: "mcp-rail-line" }),
        s("circle", { cx: cX, cy, r: 9, class: "mcp-rail-end mcp-rail-end--client" }),
        s("circle", { cx: sX, cy, r: 9, class: "mcp-rail-end mcp-rail-end--server" }),
        s("text", { x: cX, y: 64, "text-anchor": "middle", class: "mcp-rail-cap" }, act.clientLabel),
        s("text", { x: sX, y: 64, "text-anchor": "middle", class: "mcp-rail-cap" }, act.serverLabel),
    );

    const log = el("div", { class: "mcp-log", role: "log", "aria-label": "JSON-RPC message log" });
    wrap.append(svg, log);
    stage.appendChild(wrap);

    // primitives + transports rail in the copy column
    const prim = el("div", { class: "mcp-prim" });
    prim.append(el("p", { class: "mcp-prim-h", text: act.primitives.label }));
    const mkChips = (arr, kind) => {
        const row = el("div", { class: "mcp-chiprow" });
        arr.forEach(p => row.append(el("span", { class: `mcp-chip mcp-chip--${kind}`, title: p.note }, p.name)));
        return row;
    };
    prim.append(
        el("p", { class: "mcp-prim-sub", text: "server" }), mkChips(act.primitives.server, "server"),
        el("p", { class: "mcp-prim-sub", text: "client" }), mkChips(act.primitives.client, "client"),
    );
    const trans = el("div", { class: "mcp-trans" });
    trans.append(el("p", { class: "mcp-prim-h", text: "Transports" }));
    act.transports.forEach(t => trans.append(el("div", { class: "mcp-trans-row" },
        el("span", { class: "mcp-chip mcp-chip--trans", text: t.name }), el("span", { class: "mcp-trans-note", text: t.note }))));
    extra.append(prim, trans);

    function buildMsg(m) {
        const card = el("div", { class: `mcp-msg mcp-msg--${m.dir}${m.highlight ? " mcp-msg--key" : ""}` });
        const head = el("div", { class: "mcp-msg-head" },
            el("span", { class: "mcp-msg-arrow", "aria-hidden": "true", text: m.dir === "c2s" ? "→" : "←" }),
            el("span", { class: "mcp-msg-method", text: m.label }),
        );
        card.append(head, el("p", { class: "mcp-msg-note", text: m.note }));
        card.append(el("pre", { class: "mcp-msg-json" }, JSON.stringify(m.json, null, 2)));
        if (m.discovers) {
            const chips = el("div", { class: "mcp-discover" });
            m.discovers.forEach(d => chips.append(el("span", { class: "mcp-chip mcp-chip--tool mcp-chip--found", text: d })));
            card.append(chips);
        }
        return card;
    }

    let tl = null;
    if (g && !REDUCE_MOTION) {
        tl = g.timeline();
        act.messages.forEach((m, i) => {
            const pts = m.dir === "c2s" ? [{ x: cX, y: cy }, { x: sX, y: cy }] : [{ x: sX, y: cy }, { x: cX, y: cy }];
            tl.add(() => { travelDot(svg, pts, { speed: 620 }); }, i === 0 ? 0.2 : "+=0.15");
            tl.add(() => {
                const card = buildMsg(m);
                log.appendChild(card);
                g.fromTo(card, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.4, ease: "power3.out" });
                const method = card.querySelector(".mcp-msg-method");
                if (method) glyphScramble(method, m.label, 0.3);
                if (m.discovers) g.fromTo(card.querySelectorAll(".mcp-chip--found"), { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 0.28, ease: "back.out(2)", stagger: 0.08, delay: 0.1 });
                log.scrollTop = log.scrollHeight;
            }, "+=0.45");
        });
    } else {
        act.messages.forEach(m => log.appendChild(buildMsg(m)));
    }

    return { destroy() { tl?.kill(); } };
}

// ════════════════════════════════════════════════════════════════════════════════
// ACT 4 — The Adapter (rewrite or translate? naive vs agent-optimized)
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
// ACT 5 — The Landscape (vs function calling / RAG / A2A; adoption)
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
// Controller
// ════════════════════════════════════════════════════════════════════════════════

const MOUNTERS = { mess: mountMess, standard: mountStandard, handshake: mountHandshake, adapter: mountAdapter, landscape: mountLandscape, caveats: mountCaveats };

export function initMcpLab(rootEl, opts = {}) {
    const content = opts.content;
    if (!rootEl || !content) return { destroy() {} };
    const acts = content.acts;
    const ui = content.ui;

    rootEl.innerHTML = "";
    const lab = el("div", { class: "mcp-lab", tabindex: "-1" });

    // intro
    const intro = el("header", { class: "mcp-intro" },
        el("p", { class: "mcp-intro-tag", text: content.intro.tag }),
        el("h1", { class: "mcp-intro-title", text: content.intro.title }),
        el("p", { class: "mcp-intro-sub", text: content.intro.sub }),
    );

    // body: stage + copy
    const eyebrow = el("p", { class: "mcp-eyebrow" });
    const title = el("h2", { class: "mcp-title" });
    const bodyText = el("p", { class: "mcp-body-text", "aria-live": "polite" });
    const extra = el("div", { class: "mcp-scene-extra" });
    const copy = el("div", { class: "mcp-copy" }, eyebrow, title, bodyText, extra);

    const stage = el("div", { class: "mcp-stage" });
    const wipe = el("div", { class: "mcp-wipe", "aria-hidden": "true" });
    const stageWrap = el("div", { class: "mcp-stagewrap" }, stage, wipe);

    const bodyGrid = el("div", { class: "mcp-bodygrid" }, stageWrap, copy);

    // controls
    const prevBtn = el("button", { class: "mcp-nav-btn mcp-nav-prev", type: "button" }, "‹ " + ui.prev);
    const nextBtn = el("button", { class: "mcp-nav-btn mcp-nav-next", type: "button" }, ui.next + " ›");
    const dots = el("div", { class: "mcp-dots", role: "tablist", "aria-label": "Acts" });
    const dotEls = acts.map((a, i) => {
        const d = el("button", { class: `mcp-dot${a.deeper ? " is-deeper" : ""}`, type: "button", role: "tab", "aria-label": `Act ${i + 1}: ${a.title}`, "aria-selected": "false" });
        dots.appendChild(d);
        return d;
    });
    const faqBtn = el("button", { class: "mcp-faq-btn", type: "button" }, "? " + ui.faqLabel);
    const controls = el("div", { class: "mcp-controls" }, prevBtn, dots, nextBtn, faqBtn);

    lab.append(intro, bodyGrid, controls);
    rootEl.appendChild(lab);

    // ── FAQ drawer ──
    const drawer = buildDrawer(content, ui, (actId) => { closeDrawer(); const idx = acts.findIndex(a => a.id === actId); if (idx >= 0) goTo(idx); });
    rootEl.appendChild(drawer.root);
    function closeDrawer() { drawer.close(); }

    // ── state ──
    let current = -1;
    let active = null;
    let io = null;

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

    function goTo(i) {
        i = Math.max(0, Math.min(acts.length - 1, i));
        if (i === current) return;
        const act = acts[i];
        active?.destroy?.();
        active = null;
        stage.innerHTML = "";
        extra.innerHTML = "";
        playWipe();

        eyebrow.textContent = act.eyebrow;
        glyphScramble(title, act.title, 0.4) || (title.textContent = act.title);
        bodyText.textContent = act.body;

        dotEls.forEach((d, k) => d.setAttribute("aria-selected", k === i ? "true" : "false"));
        prevBtn.disabled = i === 0;
        nextBtn.textContent = i === acts.length - 1 ? (ui.restart + " ↺") : (ui.next + " ›");

        const mount = MOUNTERS[act.id];
        const doMount = () => { active = mount({ stage, extra, act, ctl: { ui } }); };
        if (window.gsap || REDUCE_MOTION) doMount(); else whenGsap(doMount);

        current = i;
        observeStage();
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
    faqBtn.addEventListener("click", () => drawer.open());

    const onKey = (e) => {
        if (drawer.isOpen()) return;
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
            io?.disconnect();
            document.removeEventListener("visibilitychange", onVis);
            lab.removeEventListener("keydown", onKey);
            drawer.destroy();
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
