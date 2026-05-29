// learn/worldmap.js — SVG world-map: a glowing route through stage nodes plus a
// character token that walks from node to node. Token follows the route via
// getPointAtLength; snaps instantly under reduced-motion.

const SVGNS = "http://www.w3.org/2000/svg";
const VIEW_W = 860;
const VIEW_H = 520;
const TOKEN_W = 46;
const TOKEN_H = 54;

function svgEl(tag, attrs = {}) {
    const node = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
}

// Build the map into `host`. Returns an API: { moveTo, markDone, destroy }.
export function drawMap(host, opts) {
    const { stages = [], currentIndex = 0, tokenMarkup = "", reduceMotion = false } = opts;
    host.replaceChildren();

    const pts = stages.map(s => s.node);
    if (!pts.length) return { moveTo() {}, markDone() {}, destroy() {} };

    const svg = svgEl("svg", {
        class: "learn-map-svg",
        viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
        role: "img",
        "aria-label": "Adventure map",
    });

    // Route path (straight segments → getPointAtLength matches the polyline).
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
    const route = svgEl("path", { class: "learn-map-route", d });
    const routeDone = svgEl("path", { class: "learn-map-route-done", d });
    svg.append(route, routeDone);

    // Cumulative length up to each node (polyline → straight distances).
    const lens = [0];
    for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        lens[i] = lens[i - 1] + Math.hypot(dx, dy);
    }
    const total = lens[lens.length - 1] || 1;

    // Nodes + labels.
    const nodeEls = [];
    pts.forEach((p, i) => {
        const g = svgEl("g", { class: "learn-map-node" });
        const ring = svgEl("circle", { class: "learn-map-node-ring", cx: p.x, cy: p.y, r: 16 });
        const dot = svgEl("circle", { class: "learn-map-node-dot", cx: p.x, cy: p.y, r: 6 });
        const num = svgEl("text", { class: "learn-map-node-num", x: p.x, y: p.y + 4, "text-anchor": "middle" });
        num.textContent = String(i + 1);
        const label = svgEl("text", {
            class: "learn-map-node-label",
            x: p.x,
            y: p.y + (p.y > VIEW_H - 80 ? -26 : 36),
            "text-anchor": "middle",
        });
        label.textContent = stages[i].node.label || `Stage ${i + 1}`;
        g.append(ring, dot, num, label);
        svg.appendChild(g);
        nodeEls.push(g);
    });

    // Character token (nested svg positioned via a parent <g> transform).
    const tokenG = svgEl("g", { class: "learn-token" });
    tokenG.innerHTML = `<svg class="learn-token-svg" x="${-TOKEN_W / 2}" y="${-TOKEN_H - 8}" width="${TOKEN_W}" height="${TOKEN_H}" viewBox="0 0 120 140" overflow="visible">${tokenMarkup}</svg>`;
    const pin = svgEl("circle", { class: "learn-token-pin", cx: 0, cy: 0, r: 5 });
    tokenG.appendChild(pin);
    svg.appendChild(tokenG);

    host.appendChild(svg);

    function lenToPoint(len) {
        return route.getPointAtLength(Math.max(0, Math.min(len, total)));
    }

    function placeAt(index) {
        const p = pts[index] || pts[0];
        tokenG.setAttribute("transform", `translate(${p.x} ${p.y})`);
        routeDone.style.strokeDasharray = `${total}`;
        routeDone.style.strokeDashoffset = `${total - lens[index]}`;
    }

    function refreshStates(index) {
        nodeEls.forEach((g, i) => {
            g.classList.toggle("is-done", i < index);
            g.classList.toggle("is-current", i === index);
        });
    }

    // Tween the token from one node to another along the route.
    function moveTo(index, animate = true) {
        refreshStates(index);
        const gsap = window.gsap;
        const fromLen = parseFloat(tokenG.dataset.len || lens[currentIndex] || 0);
        const toLen = lens[index];

        if (!animate || reduceMotion || !gsap) {
            placeAt(index);
            tokenG.dataset.len = String(toLen);
            return Promise.resolve();
        }

        return new Promise(resolve => {
            const obj = { len: fromLen };
            gsap.to(obj, {
                len: toLen,
                duration: 0.7,
                ease: "power2.inOut",
                onUpdate() {
                    const pt = lenToPoint(obj.len);
                    tokenG.setAttribute("transform", `translate(${pt.x} ${pt.y})`);
                    routeDone.style.strokeDasharray = `${total}`;
                    routeDone.style.strokeDashoffset = `${total - obj.len}`;
                },
                onComplete() { tokenG.dataset.len = String(toLen); resolve(); },
            });
        });
    }

    function markDone(index) { refreshStates(index + 1); }

    // Initial placement.
    placeAt(currentIndex);
    tokenG.dataset.len = String(lens[currentIndex] || 0);
    refreshStates(currentIndex);

    return { moveTo, markDone, destroy() { host.replaceChildren(); } };
}
