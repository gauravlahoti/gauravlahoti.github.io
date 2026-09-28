// insight-nav.js — nav drawer for the standalone insights/*/index.html pages.
// Extracted from an inline <script> block so these pages can run under the
// same strict CSP (script-src 'self') as the rest of the site.
//
// Kept as a classic script so the 13 insight pages don't each need a
// <script type="module"> edit; it just loads the shared drawer module (a
// dynamic import works from a classic script). Its own copy of the toggle
// never added `.is-open`, which layout.css keys the drawer's visibility on,
// so the menu never opened on these pages. See nav-drawer.js.

import("/assets/js/nav-drawer.js")
    .then(function (m) { m.initNavDrawer(); })
    .catch(function (err) { console.warn("[nav-drawer] failed to load", err); });
