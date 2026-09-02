// transition-guard.js — render-blocking head script.
//
// A classic (non-module) script placed in <head>, right after
// scroll-restore.js, on every page that participates in the page
// transition. It runs before the body is parsed and, if this navigation
// arrived via the Neural Slash / orbit-loader transition, holds the page
// black-and-hidden until page-transition.js's playEntranceWipe() takes
// over — closing the gap between navigation commit and the module script
// running (that gap is otherwise a flash of unpainted page, worse the
// faster the outbound sweep gets).
//
// It only READS the sessionStorage payload; playEntranceWipe() remains the
// sole consumer that clears it. It never blocks a page that arrived any
// other way (typed URL, external link, reload) — the class only gets added
// when a valid, fresh payload exists.
//
// Failsafe: the injected style carries a pure-CSS self-destruct so a
// visitor is never stranded on a black screen even if every script on the
// page fails to run afterward.
(function () {
    var KEY = "pf_neural_transition";
    var STALE_MS = 8000;

    var raw = sessionStorage.getItem(KEY);
    if (!raw) return;

    var payload;
    try { payload = JSON.parse(raw); } catch (_) { return; }
    if (!payload || payload.v !== 2) return;
    if (typeof payload.leftAt !== "number" || Date.now() - payload.leftAt > STALE_MS) return;

    document.documentElement.classList.add("pf-inbound");

    // Each self-destruct animation lives on the SAME selector as the static
    // declaration it needs to override, so the "to" keyframe (applied via
    // fill-mode forwards once the 6s delay elapses) wins the cascade against
    // the plain declaration on that element — without any JS ever running
    // again. This is what makes the failsafe survive a total JS crash: no
    // later script, no class toggle, no setTimeout is needed for it to fire.
    var style = document.createElement("style");
    style.id = "pf-guard-css";
    style.textContent =
        "html.pf-inbound{" +
        "  background:#000;" +
        "  animation:pf-guard-bg 0s linear 6s forwards" +
        "}" +
        "html.pf-inbound body{" +
        "  visibility:hidden;" +
        "  animation:pf-guard-body 0s linear 6s forwards" +
        "}" +
        "@keyframes pf-guard-bg{to{background:initial}}" +
        "@keyframes pf-guard-body{to{visibility:visible}}";
    document.head.appendChild(style);
})();
