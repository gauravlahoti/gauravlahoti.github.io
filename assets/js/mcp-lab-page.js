// mcp-lab-page.js — /mcp-lab/ bootstrap
//
// Mirrors agents-page.js: plays the Neural-Slash entrance wipe, wires page
// chrome (year, nav drawer, resume redirect, Insights flyout), fetches the
// lab content, then lazy-imports the visualization module.

import { playEntranceWipe, runPageTransition } from "./page-transition.js";

// Extract ?v= from this module's own URL so dynamic imports stay cache-busted.
const _selfV = new URL(import.meta.url).searchParams.get("v") || "";
const _vq = (path) => _selfV ? `${path}?v=${_selfV}` : path;

// Page chrome (year, nav drawer, resume redirect, Insights flyout). Lives here —
// not in an inline <script> — because the page CSP is `script-src 'self'` with
// no 'unsafe-inline', so inline scripts are blocked.
function initPageChrome() {
    const yearEl = document.getElementById("mcp-year");
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
        eln.addEventListener("click", e => {
            e.preventDefault();
            window.location.href = "/#";
        });
    });

    initInsightsFlyout();
}

// Reuse the exact initPostsFlyout from posts-list.js so the nav gets the
// identical dropdown as the main page.
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
                if (!group.classList.contains("is-open")) {
                    e.preventDefault();
                    group.classList.add("is-open");
                    sync(true);
                }
            });
            document.addEventListener("click", e => {
                if (group.classList.contains("is-open") && !group.contains(e.target)) {
                    group.classList.remove("is-open");
                    sync(false);
                }
            });
        }
    }).catch(err => console.warn("[mcp-lab] insights flyout failed", err));
}

async function init() {
    playEntranceWipe();
    initPageChrome();

    // Intercept same-origin page links → Neural-Slash transition.
    document.addEventListener("click", e => {
        const a = e.target.closest("[data-page-link]");
        if (!a) return;
        const href = a.getAttribute("href");
        if (!href) return;
        e.preventDefault();
        runPageTransition(href);
    });

    const root = document.querySelector("[data-mcp-root]");
    if (!root) return;

    let content;
    try {
        const base = document.querySelector("base")?.href || window.location.origin + "/";
        content = await fetch(new URL(_vq("content/mcp-lab.json"), base)).then(r => r.json());
    } catch (err) {
        console.warn("[mcp-lab] content load failed", err);
        root.innerHTML = `<p style="font-family:var(--font-mono);color:var(--ink-muted);font-size:0.875rem">// MCP Lab content unavailable</p>`;
        return;
    }

    try {
        const { initMcpLab } = await import(_vq("./mcp-lab.js"));
        const lab = initMcpLab(root, { content });
        window.__mcpLab = lab;
    } catch (err) {
        console.warn("[mcp-lab] visualization failed to load", err);
        root.innerHTML = `<p style="font-family:var(--font-mono);color:var(--ink-muted);font-size:0.875rem">// MCP Lab failed to start</p>`;
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
