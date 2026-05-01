// graph.js — knowledge graph (3D force-directed with 2D SVG fallback).
// Contract:
//   initGraph(container, data, { mode?: '2d'|'3d' }) → { destroy() }
//
// `mode` lets the caller force a renderer; default chooses by capability.

const FORCE3D_URL = "https://cdn.jsdelivr.net/npm/3d-force-graph@1.74.5/+esm";

const NODE_SIZE_3D = { company: 8, project: 6, domain: 4, skill: 2.5 };
const NODE_SIZE_2D = { company: 12, project: 9, domain: 6, skill: 4 };

export async function initGraph(container, data, opts = {}) {
    if (!container || !data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        return { destroy() {} };
    }
    const mode = opts.mode || (opts.fallback ? "2d" : "3d");
    if (mode === "2d") return init2D(container, data);
    try {
        return await init3D(container, data);
    } catch (err) {
        console.warn("[graph] 3D failed, falling back to 2D", err);
        container.replaceChildren();
        return init2D(container, data);
    }
}

/* ---------- shared helpers ---------- */

function readNodeColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
        company: cs.getPropertyValue("--node-company").trim() || "#FFC857",
        project: cs.getPropertyValue("--node-project").trim() || "#00FFD1",
        domain:  cs.getPropertyValue("--node-domain").trim()  || "#B388FF",
        skill:   cs.getPropertyValue("--node-skill").trim()   || "#6BC1FF",
    };
}

function writePanel(node) {
    const titleEl = document.querySelector("[data-graph-title]");
    const descEl  = document.querySelector("[data-graph-desc]");
    const metaEl  = document.querySelector("[data-graph-meta]");
    if (!node) {
        if (titleEl) titleEl.textContent = "Hover a node";
        if (descEl)  descEl.textContent  = "Each node knows its type and its neighbors.";
        if (metaEl)  metaEl.textContent  = "node detail";
        return;
    }
    if (titleEl) titleEl.textContent = node.label;
    if (descEl)  descEl.textContent  = node.description || `(${node.type})`;
    const meta = [node.type];
    if (node.year) meta.push(String(node.year));
    if (node.type === "project" && node.anchor) meta.push("click to read");
    if (metaEl) metaEl.textContent = meta.join(" · ");
}

function dispatchScrollTo(anchor) {
    document.dispatchEvent(new CustomEvent("portfolio:scroll-to", { detail: { anchor } }));
}

function buildAdjacency(data) {
    const adj = new Map();
    for (const n of data.nodes) adj.set(n.id, new Set());
    for (const e of data.edges) {
        const s = typeof e.source === "object" ? e.source.id : e.source;
        const t = typeof e.target === "object" ? e.target.id : e.target;
        if (adj.has(s) && adj.has(t)) {
            adj.get(s).add(t);
            adj.get(t).add(s);
        }
    }
    return adj;
}

/* ---------- 3D renderer (3d-force-graph) ---------- */

async function init3D(container, data) {
    const mod = await import(FORCE3D_URL);
    const ForceGraph3D = mod.default || mod.ForceGraph3D || mod;
    const colors = readNodeColors();
    const adj = buildAdjacency(data);
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const graphData = {
        nodes: data.nodes.map(n => ({ ...n })),
        links: data.edges.map(e => ({ source: e.source, target: e.target })),
    };

    const w = container.clientWidth || 600;
    const h = container.clientHeight || 480;

    let highlighted = null;
    const Graph = ForceGraph3D()(container)
        .backgroundColor("rgba(0,0,0,0)")
        .width(w).height(h)
        .nodeRelSize(2.5)
        .nodeVal(n => NODE_SIZE_3D[n.type] || 1)
        .nodeLabel(n => `${n.label}`)
        .nodeColor(n => {
            if (highlighted && n.id !== highlighted && !adj.get(highlighted)?.has(n.id)) {
                return "rgba(120,120,120,0.25)";
            }
            return colors[n.type] || colors.skill;
        })
        .nodeOpacity(0.95)
        .linkColor(link => {
            if (!highlighted) return "rgba(255,255,255,0.1)";
            const s = link.source.id || link.source;
            const t = link.target.id || link.target;
            const involved = s === highlighted || t === highlighted;
            return involved ? "rgba(0,255,209,0.65)" : "rgba(255,255,255,0.04)";
        })
        .linkWidth(link => {
            if (!highlighted) return 0.25;
            const s = link.source.id || link.source;
            const t = link.target.id || link.target;
            return (s === highlighted || t === highlighted) ? 1.2 : 0.2;
        })
        .linkDirectionalParticles(0)
        .graphData(graphData)
        .onNodeHover(node => {
            highlighted = node ? node.id : null;
            Graph.refresh();
            writePanel(node);
            container.style.cursor = node ? "pointer" : "default";
        })
        .onNodeClick(node => {
            writePanel(node);
            if (node.type === "project" && node.anchor) {
                dispatchScrollTo(node.anchor);
            }
        });

    // Reduced-motion: kill the auto cooldown wobble; allow user drag-rotation.
    if (reduceMotion) {
        Graph.cooldownTicks(0);
    }

    // Soft auto-rotation (only when not reduced motion).
    let rotateRaf = 0;
    if (!reduceMotion) {
        const controls = Graph.controls && Graph.controls();
        if (controls) {
            controls.autoRotate = true;
            controls.autoRotateSpeed = 0.6;
        }
    }

    const ro = new ResizeObserver(() => {
        Graph.width(container.clientWidth).height(container.clientHeight);
    });
    ro.observe(container);

    return {
        destroy() {
            try { ro.disconnect(); } catch (_) {}
            try { cancelAnimationFrame(rotateRaf); } catch (_) {}
            try { Graph.pauseAnimation && Graph.pauseAnimation(); } catch (_) {}
            try { Graph._destructor && Graph._destructor(); } catch (_) {}
            container.replaceChildren();
        },
    };
}

/* ---------- 2D renderer (hand-rolled SVG force layout) ---------- */

function init2D(container, data) {
    const NS = "http://www.w3.org/2000/svg";
    const W = container.clientWidth || 600;
    const H = container.clientHeight || 480;

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "graph-svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    // ring-seed positions
    const nodes = data.nodes.map((n, i) => {
        const angle = (i / data.nodes.length) * Math.PI * 2;
        const r = Math.min(W, H) * 0.35;
        return {
            ...n,
            x: W / 2 + Math.cos(angle) * r,
            y: H / 2 + Math.sin(angle) * r,
            vx: 0, vy: 0,
        };
    });
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    const edges = data.edges
        .map(e => ({ ...e, s: idx.get(e.source), t: idx.get(e.target) }))
        .filter(e => e.s !== undefined && e.t !== undefined);

    const edgeG = document.createElementNS(NS, "g");
    const nodeG = document.createElementNS(NS, "g");
    const labelG = document.createElementNS(NS, "g");

    const edgeEls = edges.map(() => {
        const line = document.createElementNS(NS, "line");
        line.setAttribute("class", "edge");
        edgeG.appendChild(line);
        return line;
    });

    const nodeEls = nodes.map(n => {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("class", "node");
        c.setAttribute("data-id", n.id);
        c.setAttribute("data-type", n.type);
        c.setAttribute("r", String(NODE_SIZE_2D[n.type] || 4));
        nodeG.appendChild(c);
        return c;
    });

    const labelEls = nodes.map(n => {
        const t = document.createElementNS(NS, "text");
        t.setAttribute("class", "label");
        t.textContent = n.label;
        labelG.appendChild(t);
        return t;
    });

    svg.appendChild(edgeG);
    svg.appendChild(nodeG);
    svg.appendChild(labelG);
    container.appendChild(svg);

    // simulation: repulsion + spring + center gravity
    const REPULSE = 1200;
    const SPRING = 0.012;
    const CENTER = 0.002;
    const DAMP = 0.85;
    const TICKS = 260;

    for (let k = 0; k < TICKS; k++) tick();
    render();

    function tick() {
        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            for (let j = i + 1; j < nodes.length; j++) {
                const b = nodes[j];
                const dx = a.x - b.x, dy = a.y - b.y;
                let d2 = dx * dx + dy * dy;
                if (d2 < 1) d2 = 1;
                const d = Math.sqrt(d2);
                const f = REPULSE / d2;
                const ux = dx / d, uy = dy / d;
                a.vx += ux * f; a.vy += uy * f;
                b.vx -= ux * f; b.vy -= uy * f;
            }
        }
        for (const e of edges) {
            const a = nodes[e.s], b = nodes[e.t];
            const dx = b.x - a.x, dy = b.y - a.y;
            a.vx += dx * SPRING; a.vy += dy * SPRING;
            b.vx -= dx * SPRING; b.vy -= dy * SPRING;
        }
        for (const n of nodes) {
            n.vx += (W / 2 - n.x) * CENTER;
            n.vy += (H / 2 - n.y) * CENTER;
            n.vx *= DAMP; n.vy *= DAMP;
            n.x += n.vx; n.y += n.vy;
        }
    }

    function render() {
        edges.forEach((e, i) => {
            const a = nodes[e.s], b = nodes[e.t];
            const el = edgeEls[i];
            el.setAttribute("x1", a.x); el.setAttribute("y1", a.y);
            el.setAttribute("x2", b.x); el.setAttribute("y2", b.y);
        });
        nodes.forEach((n, i) => {
            nodeEls[i].setAttribute("cx", n.x);
            nodeEls[i].setAttribute("cy", n.y);
            labelEls[i].setAttribute("x", n.x);
            labelEls[i].setAttribute("y", n.y - ((NODE_SIZE_2D[n.type] || 4) + 6));
        });
    }

    // hover highlighting
    const adj = buildAdjacency(data);
    function highlight(node) {
        const id = node ? node.id : null;
        nodeEls.forEach((el, i) => {
            const nid = nodes[i].id;
            const isActive = id == null ? null : (nid === id || adj.get(id).has(nid));
            el.classList.toggle("is-dim", isActive === false);
            labelEls[i].classList.toggle("is-dim", isActive === false);
            labelEls[i].classList.toggle("is-active", id != null && nid === id);
        });
        edgeEls.forEach((el, i) => {
            const e = edges[i];
            const involved = id != null && (nodes[e.s].id === id || nodes[e.t].id === id);
            el.classList.toggle("is-active", !!involved);
        });
    }

    const handlers = nodes.map((n, i) => ({
        enter() { writePanel(n); highlight(n); },
        leave() { highlight(null); writePanel(null); },
        click() {
            writePanel(n);
            if (n.type === "project" && n.anchor) dispatchScrollTo(n.anchor);
        },
    }));
    nodeEls.forEach((el, i) => {
        el.addEventListener("mouseenter", handlers[i].enter);
        el.addEventListener("mouseleave", handlers[i].leave);
        el.addEventListener("click", handlers[i].click);
        el.addEventListener("touchstart", handlers[i].enter, { passive: true });
    });

    return {
        destroy() {
            nodeEls.forEach((el, i) => {
                el.removeEventListener("mouseenter", handlers[i].enter);
                el.removeEventListener("mouseleave", handlers[i].leave);
                el.removeEventListener("click", handlers[i].click);
                el.removeEventListener("touchstart", handlers[i].enter);
            });
            container.replaceChildren();
        },
    };
}
