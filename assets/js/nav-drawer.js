// nav-drawer.js — the mobile nav drawer, shared by every page that has one.
//
// This used to be copied into each page: main.js, agents-page.js,
// ai-concepts-page.js, mcp-lab-page.js, engineering-loops-page.js,
// webmcp-lab-page.js and insight-nav.js. The copies drifted. Only main.js
// added `.is-open`, which is what layout.css keys the drawer's visibility on
// (`.nav-drawer.is-open`); the rest only flipped aria-hidden/aria-expanded
// and set body overflow:hidden. So on every page except home, tapping the
// menu did nothing visible and froze page scroll until tapped again. One
// module now, so there's nothing left to drift.

export function initNavDrawer() {
    const trigger = document.querySelector("[data-nav-trigger]");
    const drawer  = document.querySelector("[data-nav-drawer]");
    if (!trigger || !drawer) return;
    // Bind once, even if a page's bootstrap and a shim both call this.
    if (drawer.dataset.navDrawerBound) return;
    drawer.dataset.navDrawerBound = "1";

    const open = () => {
        drawer.classList.add("is-open");
        drawer.setAttribute("aria-hidden", "false");
        trigger.setAttribute("aria-expanded", "true");
        trigger.setAttribute("aria-label", "Close menu");
        // layout.css locks page scroll on this class.
        document.body.classList.add("is-nav-drawer-open");
        // Move keyboard focus into the panel for screen-reader / keyboard users.
        const close = drawer.querySelector(".nav-drawer-close");
        if (close) requestAnimationFrame(() => close.focus());
    };
    const close = () => {
        drawer.classList.remove("is-open");
        drawer.setAttribute("aria-hidden", "true");
        trigger.setAttribute("aria-expanded", "false");
        trigger.setAttribute("aria-label", "Open menu");
        document.body.classList.remove("is-nav-drawer-open");
        trigger.focus();
    };

    trigger.addEventListener("click", () => {
        if (drawer.classList.contains("is-open")) close();
        else open();
    });

    // Close on backdrop tap, close-button click, or any link click inside
    // the drawer (links navigate via existing handlers — Lenis for #anchors,
    // the page transition for data-page-link, browser default for outbound).
    drawer.addEventListener("click", (e) => {
        if (e.target.closest("[data-nav-close]") || e.target.closest("a")) {
            close();
        }
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && drawer.classList.contains("is-open")) {
            e.preventDefault();
            close();
        }
    });

    // Auto-close if the viewport widens to desktop while the drawer is open.
    const mql = matchMedia("(min-width: 721px)");
    const onChange = (e) => {
        if (e.matches && drawer.classList.contains("is-open")) close();
    };
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else mql.addListener(onChange); // older Safari

    // Back/forward cache: leaving while the drawer is open (e.g. a swipe-back
    // gesture; drawer links already close it first) and returning restores
    // the page with the drawer open and scroll still locked.
    window.addEventListener("pageshow", (e) => {
        if (e.persisted && drawer.classList.contains("is-open")) close();
    });
}
