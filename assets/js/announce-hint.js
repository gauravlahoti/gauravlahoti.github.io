// announce-hint.js: tell the page, before first paint, that an announcement bar
// is about to appear, so the page can hold its space and nothing jumps.
//
// announcement.js builds the real bar after it fetches content/announcement.json,
// which is after first paint. Without a hint the bar pushes the whole page down
// by its own height (a layout shift). This classic script runs in <head>, before
// the body is parsed. If a bar is live it adds class "ann-pending" to <html>;
// base.css reserves exactly the bar's height while that class is present, and
// announcement.js removes the class in the same task that it inserts the bar.
//
// ANN below is a copy of the three fields announcement.js uses to decide whether
// the bar is live. The /announce skill rewrites it whenever it rewrites
// content/announcement.json, and tests/announce-hint.test.mjs fails if the two
// drift apart. A stale copy only brings the small shift back, it never breaks
// the page. Expiry is computed from the date here, so the hint switches itself
// off after durationDays with no publish.
(function () {
    var ANN = {"id":"system-one-models-2026-11-23","startsOn":"2026-11-23","durationDays":7};

    if (!ANN) return;
    var start = Date.parse(ANN.startsOn + "T00:00:00");
    if (isNaN(start)) return;
    var now = Date.now();
    var end = start + (Number(ANN.durationDays) || 7) * 86400000;
    if (now < start || now >= end) return;
    try {
        if (localStorage.getItem("ann-dismissed") === ANN.id) return;
    } catch (e) { /* private mode: treat as not dismissed, same as announcement.js */ }
    document.documentElement.classList.add("ann-pending");
})();
