// analytics.js — cookieless pageview beacon (Spec #33).
//
// Fires one fire-and-forget POST to the Worker's /api/pageview on each load.
// No cookies, no localStorage, no PII — the Worker derives geo from
// Cloudflare's request.cf and a daily-rotating hash from the (server-side) IP.
// Lazy-loaded by main.js on idle so it never touches the FCP path.
//
// The body is sent as a text/plain Blob: that content type is CORS-safelisted,
// so navigator.sendBeacon avoids a preflight (which beacons can't perform). The
// Worker parses the body as JSON regardless of content type.

export function initAnalytics(profile) {
    const url = profile?.links?.pageviewApi;
    if (!url) return;

    // Honour Do Not Track as a courtesy — the pipeline is already cookieless.
    if (navigator.doNotTrack === "1" || window.doNotTrack === "1") return;

    try {
        const payload = JSON.stringify({
            path: location.pathname || "/",
            referrer: document.referrer || "",
        });
        if (navigator.sendBeacon) {
            navigator.sendBeacon(url, new Blob([payload], { type: "text/plain" }));
        } else {
            // Older browsers: keepalive fetch so it survives a fast unload.
            fetch(url, {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: payload,
                keepalive: true,
                mode: "cors",
            }).catch(() => {});
        }
    } catch (_) {
        // Analytics must never break the page.
    }
}
