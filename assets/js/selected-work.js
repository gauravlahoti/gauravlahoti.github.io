// selected-work.js: the "Selected Work" case studies on the homepage.
// Exports:
//   initSelectedWork(root)       -> the full cards on /selected-work/ (use case,
//                                   solution overview, efficiency gained, built with)
//   initSelectedWorkTeaser(root) -> the home page strip: each card's pill and
//                                   headline, linking to /selected-work/
// Everything goes in via textContent.
// The efficiency box follows one template on every card: a headline number with
// a short outcome phrase, then four tiles (Cost, Speed, Scale, Productivity),
// each a metric and one line.

// Sibling modules are loaded with this module's own ?v= query, so a cache-bust
// on the entry script reaches them too. A plain static import would let the
// browser serve a stale copy after a deploy.
const V = new URL(import.meta.url).search;
let fx, viz;

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

// Small line icons for the four levers, drawn with SVG paths (no text).
const ICONS = {
    cost: "M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 2 2.6 4.5 3 4.5 1.4 4.5 3.2-2 3-4.5 3-4.5-1.3-4.5-3",
    speed: "M13 2 4 14h7l-1 8 9-12h-7z",
    scale: "M4 20h4v-6H4zM10 20h4V10h-4zM16 20h4V4h-4z",
    revenue: "M4 18 10 12l4 4 6-8M14 8h6v6",
    productivity: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 9.5-4.9M15 18l2.5 2.5L22 16",
};
function leverIcon(key) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "lever-icon");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", ICONS[key] || ICONS.cost);
    svg.append(path);
    return svg;
}

function block(label, ...children) {
    const wrap = el("div", "work-block");
    wrap.append(el("p", "work-label", label), ...children);
    return wrap;
}

// The use case keeps every word. The first sentence is set as a brighter lead,
// and each "(Source)" is set small and muted, so the figures stand out.
function useCaseParagraph(text) {
    const p = el("p", "work-text");
    const cut = text.search(/\. /);
    const lead = cut === -1 ? text : text.slice(0, cut + 1);
    p.append(el("span", "work-lead", lead));
    const rest = cut === -1 ? "" : text.slice(cut + 1);
    let last = 0;
    for (const m of rest.matchAll(/\(([A-Z][A-Za-z ]+)\)/g)) {
        p.append(rest.slice(last, m.index));
        p.append(el("span", "work-src", m[0]));
        last = m.index + m[0].length;
    }
    p.append(rest.slice(last));
    return p;
}

function renderStudy(s, index) {
    const card = el("article", "work-card");
    card.setAttribute("aria-labelledby", `work-${s.id}-title`);

    const head = el("header", "work-card-head");
    const top = el("div", "work-card-top");
    top.append(el("span", "work-num", String(index + 1).padStart(2, "0")), el("span", "work-kind", s.kind));
    head.append(top);
    const title = el("h3", "work-card-title", s.title);
    title.id = `work-${s.id}-title`;
    head.append(title);

    const problem = block("Use case", useCaseParagraph(s.problem));

    const flow = el("ol", "work-flow");
    s.architecture.flow.forEach((step, i) => {
        const li = el("li", "", step);
        li.style.setProperty("--i", String(i));
        flow.append(li);
    });
    const stack = el("ul", "work-stack");
    for (const t of s.architecture.stack) stack.append(el("li", "work-chip", t));
    const arch = block("Solution overview", flow);
    // A subgrid in CSS: its label and each step take a row shared by all cards.
    arch.classList.add("work-arch");
    const built = block("Built with", stack);
    built.classList.add("work-built");

    const vz = viz.buildOutcomeViz(s.outcome);
    const outcome = el("div", "work-outcome");
    outcome.append(el("p", "work-label", "Efficiency gained"), vz.valueEl);
    if (vz.node) outcome.append(vz.node);
    outcome.append(el("p", "work-outcome-label", s.outcome.label));
    // The efficiency levers as a 2x2 grid of KPI tiles. Every card uses the same
    // four levers in the same order, so Cost sits beside Cost across the cards.
    if (Array.isArray(s.outcome.levers) && s.outcome.levers.length) {
        const grid = el("ul", "work-levers");
        s.outcome.levers.forEach((lv, i) => {
            const tile = el("li", `lever lever-${lv.key}`);
            tile.style.setProperty("--i", String(i));
            const head = el("p", "lever-head");
            head.append(leverIcon(lv.key), el("span", "", lv.label));
            tile.append(head, el("p", "lever-metric", lv.metric), el("p", "lever-line", lv.line));
            grid.append(tile);
        });
        outcome.append(grid);
    }
    card._viz = vz;

    card.append(head, problem, arch, outcome, built);
    return card;
}

export async function initSelectedWork(root) {
    if (!root) return { destroy() {} };
    [fx, viz] = await Promise.all([import(`./fx.js${V}`), import(`./work-viz.js${V}`)]);
    let data;
    try {
        const res = await fetch("content/selected-work.json", { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
    } catch (err) {
        console.warn("[selected-work] failed to load", err);
        return { destroy() {} };
    }
    const studies = Array.isArray(data.studies) ? data.studies : [];
    const frag = document.createDocumentFragment();
    studies.forEach((s, i) => frag.append(renderStudy(s, i)));
    root.replaceChildren(frag);
    root.classList.add("is-ready");

    // Each card plays once, the first time it is well on screen: the pipeline
    // lights up step by step and the outcome number counts up with its graphic.
    // Reduced motion shows the finished state straight away.
    const cards = [...root.querySelectorAll(".work-card")];
    if (!fx.reduceMotion()) cards.forEach((c) => c._viz && c._viz.prime && c._viz.prime());
    const stopSeen = fx.whenSeen(cards, (card) => {
        card.classList.add("is-live");
        card._viz && card._viz.play();
    });
    const stopSpot = fx.attachSpotlight(root, ".work-card");
    return {
        destroy() {
            stopSeen();
            stopSpot();
            root.replaceChildren();
            root.classList.remove("is-ready");
        },
    };
}

// Home page teaser: one compact item per card (pill, headline number, short
// outcome phrase), each linking to the full case studies. Same JSON as the
// page, so the numbers can never drift apart.
export async function initSelectedWorkTeaser(root) {
    if (!root) return { destroy() {} };
    let data;
    try {
        const res = await fetch("content/selected-work.json", { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
    } catch (err) {
        console.warn("[selected-work] teaser failed to load", err);
        return { destroy() {} };
    }
    const frag = document.createDocumentFragment();
    (data.studies || []).forEach((s, i) => {
        const a = el("a", "work-teaser-item");
        a.href = "/selected-work/";
        a.dataset.pageLink = "";
        a.setAttribute("aria-label", `${s.kind}: ${s.outcome.value} ${s.outcome.label}. Read the case study`);
        const top = el("span", "work-card-top");
        top.append(el("span", "work-num", String(i + 1).padStart(2, "0")), el("span", "work-kind", s.kind));
        a.append(top, el("span", "work-teaser-value", s.outcome.value), el("span", "work-teaser-label", s.outcome.label));
        frag.append(a);
    });
    root.replaceChildren(frag);
    root.classList.add("is-ready");
    return { destroy() { root.replaceChildren(); root.classList.remove("is-ready"); } };
}
