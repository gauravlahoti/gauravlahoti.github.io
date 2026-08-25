// insight-nav.js — nav-drawer open/close toggle for the standalone
// insights/*/index.html pages. Extracted from an inline <script> block
// so these pages can run under the same strict CSP (script-src 'self')
// as the rest of the site.

(function () {
    var trigger = document.querySelector("[data-nav-trigger]");
    var drawer = document.querySelector("[data-nav-drawer]");
    var closes = document.querySelectorAll("[data-nav-close]");
    if (!trigger || !drawer) return;
    function open() {
        trigger.setAttribute("aria-expanded", "true");
        drawer.setAttribute("aria-hidden", "false");
    }
    function close() {
        trigger.setAttribute("aria-expanded", "false");
        drawer.setAttribute("aria-hidden", "true");
    }
    trigger.addEventListener("click", function () {
        trigger.getAttribute("aria-expanded") === "true" ? close() : open();
    });
    closes.forEach(function (el) { el.addEventListener("click", close); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
})();
