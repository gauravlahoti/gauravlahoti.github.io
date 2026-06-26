// ai-concepts-page.js — /ai-concepts/ hub bootstrap
//
// Renders the concept gallery (MCP Lab, Agentic RAG, …) from
// content/ai-concepts.json. Mirrors agents-page.js for page chrome + the
// Neural-Slash page transition.

import { playEntranceWipe, runPageTransition } from "./page-transition.js";

const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const _selfV = new URL(import.meta.url).searchParams.get("v") || "";
const _vq = (path) => _selfV ? `${path}?v=${_selfV}` : path;

function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role") n.setAttribute(k, v);
        else n[k] = v;
    }
    for (const c of kids) { if (c == null) continue; n.append(c.nodeType ? c : document.createTextNode(c)); }
    return n;
}

function initPageChrome() {
    const yearEl = document.getElementById("concepts-year");
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    const trigger = document.querySelector("[data-nav-trigger]");
    const drawer  = document.querySelector("[data-nav-drawer]");
    const closes  = document.querySelectorAll("[data-nav-close]");
    if (trigger && drawer) {
        trigger.addEventListener("click", () => {
            const open = drawer.getAttribute("aria-hidden") === "false";
            drawer.setAttribute("aria-hidden", open ? "true" : "false");
            trigger.setAttribute("aria-expanded", open ? "false" : "true");
            document.body.style.overflow = open ? "" : "hidden";
        });
        closes.forEach(c => c.addEventListener("click", () => {
            drawer.setAttribute("aria-hidden", "true");
            trigger.setAttribute("aria-expanded", "false");
            document.body.style.overflow = "";
        }));
    }

    document.querySelectorAll("[data-resume-trigger-agents]").forEach(eln => {
        eln.addEventListener("click", e => { e.preventDefault(); window.location.href = "/#"; });
    });

    initInsightsFlyout();
}

function initInsightsFlyout() {
    const flyoutRoot = document.querySelector("[data-posts-flyout]");
    if (!flyoutRoot) return;
    import(_vq("./posts-list.js")).then(({ initPostsFlyout }) =>
        initPostsFlyout(flyoutRoot)
    ).then(inst => {
        if (!inst) return;
        const footLink = flyoutRoot.querySelector(".nav-flyout-foot");
        if (footLink) footLink.href = "/#insights";
        const group = flyoutRoot.closest("[data-flyout-group]");
        const link  = group && group.querySelector("a[aria-haspopup]");
        if (!group || !link) return;
        const sync = open => link.setAttribute("aria-expanded", open ? "true" : "false");
        group.addEventListener("mouseenter", () => sync(true));
        group.addEventListener("mouseleave", () => sync(false));
        group.addEventListener("focusin",   () => sync(true));
        group.addEventListener("focusout",  () => sync(false));
        if (matchMedia("(any-pointer: coarse)").matches) {
            link.addEventListener("click", e => {
                if (!group.classList.contains("is-open")) { e.preventDefault(); group.classList.add("is-open"); sync(true); }
            });
            document.addEventListener("click", e => {
                if (group.classList.contains("is-open") && !group.contains(e.target)) { group.classList.remove("is-open"); sync(false); }
            });
        }
    }).catch(err => console.warn("[ai-concepts] insights flyout failed", err));
}

function buildCard(c) {
    const tag = c.internal ? "a" : "a";
    const card = el("article", { class: "concept-card" });
    const head = el("div", { class: "concept-card-head" },
        el("span", { class: "concept-card-num", text: c.num }),
        el("span", { class: "concept-card-status", text: c.status || "LIVE" }),
    );
    const title = el("h2", { class: "concept-card-title", text: c.title });
    const tagline = el("p", { class: "concept-card-tagline", text: c.tagline });
    const desc = el("p", { class: "concept-card-desc", text: c.description });
    const tags = el("div", { class: "concept-tags" });
    (c.tags || []).forEach(t => tags.append(el("span", { class: "concept-tag", text: t })));

    const linkAttrs = { class: "concept-launch", href: c.href };
    if (c.internal) linkAttrs["data-page-link"] = "1";
    else { linkAttrs.target = "_self"; linkAttrs.rel = "noopener"; }
    const launch = el(tag, linkAttrs);
    launch.innerHTML = `${c.cta || "Open"} <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

    card.append(head, title, tagline, desc, tags, launch);

    // whole card is clickable (keyboard + pointer), launch link still works
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "link");
    card.setAttribute("aria-label", `${c.title} — ${c.tagline}`);
    const go = () => {
        if (c.internal) runPageTransition(c.href);
        else window.location.href = c.href;
    };
    card.addEventListener("click", e => { if (!e.target.closest("a")) go(); });
    card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    return card;
}

function runEntrance(grid) {
    grid.classList.add("is-visible");
    const g = window.gsap;
    if (!g || REDUCE_MOTION) return;
    g.fromTo(grid.querySelectorAll(".concept-card"),
        { opacity: 0, y: 28 },
        { opacity: 1, y: 0, duration: 0.5, ease: "power3.out", stagger: 0.1, delay: 0.1, clearProps: "opacity,transform" });
}

async function init() {
    playEntranceWipe();
    initPageChrome();

    document.addEventListener("click", e => {
        const a = e.target.closest("[data-page-link]");
        if (!a) return;
        const href = a.getAttribute("href");
        if (!href) return;
        e.preventDefault();
        runPageTransition(href);
    });

    const root = document.querySelector("[data-concepts-root]");
    if (!root) return;

    let data;
    try {
        const base = document.querySelector("base")?.href || window.location.origin + "/";
        data = await fetch(new URL(_vq("content/ai-concepts.json"), base)).then(r => r.json());
    } catch (err) {
        console.warn("[ai-concepts] content load failed", err);
        root.innerHTML = `<p style="font-family:var(--font-mono);color:var(--ink-muted);font-size:0.875rem">// concepts unavailable</p>`;
        return;
    }

    const header = document.querySelector("[data-concepts-header]");
    if (header && data.intro) {
        header.append(
            el("p", { class: "concepts-tag", text: data.intro.tag }),
            el("h1", { class: "concepts-title", text: data.intro.title }),
            el("p", { class: "concepts-sub", text: data.intro.sub }),
        );
    }

    const grid = el("div", { class: "concepts-grid" });
    (data.concepts || []).forEach(c => grid.append(buildCard(c)));
    root.append(grid);

    if (data.teaser) root.append(el("p", { class: "concepts-teaser", text: data.teaser }));

    if (window.gsap) runEntrance(grid);
    else { window.addEventListener("load", () => runEntrance(grid), { once: true }); setTimeout(() => runEntrance(grid), 800); }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
