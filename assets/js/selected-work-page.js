// selected-work-page.js: /selected-work/ bootstrap.
//
// Page chrome (nav drawer, Insights flyout, the Neural-Slash page transition)
// mirrors ai-concepts-page.js. The case-study cards themselves come from the
// shared renderer, selected-work.js, which the home page teaser also uses.

import { playEntranceWipe, runPageTransition, signalPageReady } from "./page-transition.js";
import { initNavDrawer } from "./nav-drawer.js";

// Sibling modules load with this module's own ?v= query, so a cache-bust on
// the page's script tag reaches them too.
const V = new URL(import.meta.url).search;

function initInsightsFlyout() {
    const flyoutRoot = document.querySelector("[data-posts-flyout]");
    if (!flyoutRoot) return;
    import(`./posts-list.js${V}`).then(({ initPostsFlyout }) =>
        initPostsFlyout(flyoutRoot)
    ).then((inst) => {
        if (!inst) return;
        const group = flyoutRoot.closest("[data-flyout-group]");
        const link = group && group.querySelector("a[aria-haspopup]");
        if (!group || !link) return;
        const sync = (open) => link.setAttribute("aria-expanded", open ? "true" : "false");
        group.addEventListener("mouseenter", () => sync(true));
        group.addEventListener("mouseleave", () => sync(false));
        group.addEventListener("focusin", () => sync(true));
        group.addEventListener("focusout", () => sync(false));
        if (matchMedia("(any-pointer: coarse)").matches) {
            link.addEventListener("click", (e) => {
                if (!group.classList.contains("is-open")) { e.preventDefault(); group.classList.add("is-open"); sync(true); }
            });
            document.addEventListener("click", (e) => {
                if (group.classList.contains("is-open") && !group.contains(e.target)) { group.classList.remove("is-open"); sync(false); }
            });
        }
    }).catch((err) => console.warn("[selected-work] insights flyout failed", err));
}

async function init() {
    playEntranceWipe();
    const yearEl = document.getElementById("work-year");
    if (yearEl) yearEl.textContent = new Date().getFullYear();
    initNavDrawer();
    initInsightsFlyout();

    document.addEventListener("click", (e) => {
        const a = e.target.closest("[data-page-link]");
        if (!a) return;
        const href = a.getAttribute("href");
        if (!href) return;
        e.preventDefault();
        runPageTransition(href);
    });

    try {
        const root = document.querySelector("[data-work-root]");
        if (root) {
            const { initSelectedWork } = await import(`./selected-work.js${V}`);
            await initSelectedWork(root);
        }
    } catch (err) {
        console.warn("[selected-work] failed to render", err);
    } finally {
        // An in-flight transition waits on this, so it fires on every exit path.
        signalPageReady();
    }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
