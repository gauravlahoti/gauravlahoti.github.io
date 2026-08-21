// webmcp-lab-page.js — /ai-labs/agent-ready/ bootstrap
//
// Mirrors engineering-loops-page.js: plays the Neural-Slash entrance wipe,
// wires page chrome (year, nav drawer, resume redirect, Insights flyout),
// fetches the lab content plus profile.json, registers this page's own
// WebMCP tools (scope "lab-agent-ready"), then lazy-imports the lab engine.

import { playEntranceWipe, runPageTransition } from "./page-transition.js";

// Extract ?v= from this module's own URL so dynamic imports stay cache-busted.
const _selfV = new URL(import.meta.url).searchParams.get("v") || "";
const _vq = (path) => (_selfV ? `${path}?v=${_selfV}` : path);

function initPageChrome() {
    const yearEl = document.getElementById("webmcp-lab-year");
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
    }).catch(err => console.warn("[webmcp-lab] insights flyout failed", err));
}

// Registers this page's own WebMCP tools (the 8 read-only tools plus
// list_ai_labs). Independent of the lab UI below: even if the visualization
// fails to load, an agent visiting this page still gets a working registry.
function initWebMcp(profile) {
    const hasApi = () => document.modelContext || navigator.modelContext;
    const start = () =>
        import(_vq("./webmcp.js"))
            .then((m) => m.registerWebMcp({ scope: "lab-agent-ready", profile }))
            .catch((err) => console.debug("[webmcp] unavailable", err));
    if (hasApi()) return void start();
    let tries = 0;
    const recheck = () => {
        if (hasApi()) return void start();
        if (++tries >= 2) return;
    };
    window.addEventListener("load", recheck, { once: true });
    setTimeout(recheck, 1500);
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

    const root = document.querySelector("[data-webmcp-lab-root]");
    if (!root) return;

    const base = document.querySelector("base")?.href || window.location.origin + "/";
    let content, profile;
    try {
        [content, profile] = await Promise.all([
            fetch(new URL(_vq("content/webmcp-lab.json"), base)).then(r => r.json()),
            fetch(new URL(_vq("content/profile.json"), base)).then(r => r.json()),
        ]);
    } catch (err) {
        console.warn("[webmcp-lab] content load failed", err);
        root.innerHTML = `<p style="font-family:var(--font-mono);color:var(--ink-muted);font-size:0.875rem">// Agent-Ready Web content unavailable</p>`;
        return;
    }

    initWebMcp(profile);

    try {
        const { initWebMcpLab } = await import(_vq("./webmcp-lab.js"));
        const lab = initWebMcpLab(root, { content, profile });
        window.__webmcpLab = lab;
    } catch (err) {
        console.warn("[webmcp-lab] lab UI failed to load", err);
        root.innerHTML = `<p style="font-family:var(--font-mono);color:var(--ink-muted);font-size:0.875rem">// Agent-Ready Web failed to start</p>`;
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
