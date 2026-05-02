// Refresh always lands on the hero (unless URL has a hash).
// Loaded as a non-deferred script in <head> so it runs before the
// browser's auto scroll-restoration and before any bfcache restore.
// Both setting `manual` and the pageshow listener are needed to cover
// every browser path (regular reload, back/forward, bfcache restore).
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
addEventListener("pageshow", function () {
    if (!location.hash || location.hash.length < 2) scrollTo(0, 0);
});
