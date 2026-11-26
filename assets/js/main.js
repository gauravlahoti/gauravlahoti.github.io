// main.js — bootstrap. Reads profile.json, binds DOM, sets up Lenis,
// orchestrates the hero reveal.

import { initNavDrawer } from "./nav-drawer.js";

const ROOT = document.documentElement;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const isTouch = matchMedia("(any-pointer: coarse)").matches;
const isNarrow = matchMedia("(max-width: 767px)").matches;
const saveData = !!(navigator.connection && navigator.connection.saveData);

// Used to gate Lenis: Windows wheel input + DXGI/ANGLE composite cost
// makes smoothing compound badly. UA-Client-Hints first (modern Edge/Chrome
// on Windows), then a userAgent fallback for older browsers.
function isWindows() {
    const uaData = navigator.userAgentData;
    if (uaData && typeof uaData.platform === "string") {
        return uaData.platform.toLowerCase().includes("windows");
    }
    return /Win(dows|32|64|NT)/i.test(navigator.userAgent);
}

// Chrome on macOS uses ANGLE/Skia (not Metal), so its per-frame composite
// cost for fixed/backdrop-filter elements is similar to Windows DXGI/ANGLE.
// Lenis's continuous RAF loop hurts Chrome scrolling regardless of OS.
// UA-Client-Hints brands check first; UA string fallback excludes Edge.
function isChrome() {
    const brands = navigator.userAgentData?.brands;
    if (brands) return brands.some((b) => b.brand === "Google Chrome");
    return /Chrome\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent);
}

// Append `?v=ASSET_VERSION` to dynamic imports so a cache-bust on the entry
// script also invalidates lazy-loaded modules. Bump together with the
// ?v=N query strings on <link>/<script> in index.html.
const ASSET_VERSION = "425";
const v = (path) => `${path}?v=${ASSET_VERSION}`;

function uuidv4() {
    if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// One id for the whole page load, shared by the pageview beacon and the chat
// widget. Generated here (not inside either lazy module) so both see the same
// value regardless of which loads first. Aggregate-only by policy: this is
// what lets daily_stats compute "did a visitor who loaded a page also chat"
// as a same-day count, never a row-level join — see .claude/docs/backend.md.
window.__portfolioSessionId = uuidv4();

// (Refresh-lands-at-top behavior is handled by the inline <script> in
// index.html <head> — runs before auto-restore + bfcache restore.)

// A repeat visitor sees the questions counter immediately (see initAgentStat).
showCachedAgentStat();

(async function bootstrap() {
    // Kick off the page-transition module in parallel with everything else
    // (never awaited on the critical path — most loads arrive with no
    // transition in flight, and playEntranceWipe() is a no-op then). If a
    // transition IS in flight it starts animating as soon as this resolves,
    // running concurrently with the profile fetch below; signalPageReady()
    // in the finally block is what lets it land.
    const transitionModP = import(v("./page-transition.js")).catch(() => null);
    transitionModP.then(mod => mod?.playEntranceWipe());

    try {
        let profile;
        try {
            profile = await fetch("content/profile.json", { cache: "no-cache" }).then(r => r.json());
        } catch (err) {
            console.warn("[portfolio] profile.json missing or invalid", err);
            return;
        }

        bindDOM(profile);
        setYear();
        initWebMcp(profile);
        initLenis();
        initAnchorScroll();

        initTrajectoryWhenVisible(profile);
        initLazySection("#work [data-work-teaser-root]", "./selected-work.js", "initSelectedWorkTeaser");
        initSkillsHexWhenVisible();
        initPostsListWhenVisible(profile);
        initPostsFlyoutEager();
        initNavDrawer();
        initCapabilities(profile);
        initCertRail(profile);
        initCertTilesTouch();
        initOffscreenAnimationPause();
        initScrollStateClass();
        wireScrollTo();
        initCursorAsync();
        initRevealWhenIdle();
        initHeroAsk(profile, initAgentWidgetOnBoot(profile, window.__portfolioSessionId));
        initMobileEnhancements(profile);
        initAnalyticsWhenIdle(profile, window.__portfolioSessionId);
        initAgentStat(profile);
        initPageLinks();
        initLoadHashScroll();
        auditConsole();
    } finally {
        // Fires whether the try body completed or returned early (e.g.
        // profile.json failed to load) — a transition waiting on this
        // signal must not hang just because the page had nothing to show.
        transitionModP.then(mod => mod?.signalPageReady());
    }
})();

// WebMCP (spec 45). Feature-detect first: on a browser with no model context
// this is one property read and we never touch the network or import
// anything, so it's free on every human visit. When the API IS present the
// visitor is an agent, so register right away rather than on idle —
// registration is schema-only, and the JSON behind each tool is fetched
// lazily inside its handler.
function initWebMcp(profile) {
    const hasApi = () => document.modelContext || navigator.modelContext;
    const start = () =>
        import(v("./webmcp.js"))
            .then((m) => m.registerWebMcp({ scope: "home", profile }))
            .catch((err) => console.debug("[webmcp] unavailable", err));

    if (hasApi()) return void start();

    // An extension or polyfill may install the API after this module runs.
    // Two cheap re-checks, then stop looking — no console noise either way.
    let tries = 0;
    const recheck = () => {
        if (hasApi()) return void start();
        if (++tries >= 2) return;
    };
    window.addEventListener("load", recheck, { once: true });
    setTimeout(recheck, 1500);
}

// Live Atlas counter: "Atlas has responded to N questions" under the hero buttons. The
// number comes from /api/agent-stats, which takes a network round trip (after the profile
// data that names the URL), so for a first-time visitor it appears when that arrives: no
// idle wait, no hold, no count-up, no fade. For a repeat visitor it is there at once: the
// last number we saw is kept in localStorage and shown the moment this script runs, then
// quietly replaced when the fresh one arrives. It is only a public running total, nothing
// about the visitor. The line's space is reserved from the start (display: block with
// opacity 0 in components.css, which also overrides the [hidden] attribute), so showing it
// moves nothing. We only ever show a real positive number (never flash "0"). The endpoint
// is CDN-cached for 1h, so the fresh number is current to within the hour.
const AGENT_STAT_KEY = "agent-stat-total";
const agentStatFmt = new Intl.NumberFormat("en-US");

function showAgentStat(n) {
    const el = document.querySelector("[data-agent-stat]");
    const numEl = el && el.querySelector("[data-agent-stat-num]");
    if (!el || !numEl) return false;
    numEl.textContent = agentStatFmt.format(n);
    if (!el.classList.contains("is-shown")) {
        // No transition for this first show: it should simply be there.
        el.style.transition = "none";
        el.hidden = false;
        el.classList.add("is-shown");
        requestAnimationFrame(() => el.style.removeProperty("transition"));
    }
    return true;
}

// Called as soon as this module runs, before anything is fetched.
function showCachedAgentStat() {
    try {
        const n = Number(localStorage.getItem(AGENT_STAT_KEY));
        if (Number.isFinite(n) && n > 0) showAgentStat(n);
    } catch { /* private mode or storage blocked: just wait for the network */ }
}

function initAgentStat(profile) {
    const api = profile && profile.links && profile.links.agentStatsApi;
    const el = document.querySelector("[data-agent-stat]");
    const numEl = el && el.querySelector("[data-agent-stat-num]");
    if (!api || !el || !numEl) return;

    let total = 0;
    let ready = false;

    fetch(api, { cache: "no-cache" })
        .then(r => (r.ok ? r.json() : null))
        .then(data => {
            const n = data && Number(data.total_conversations);
            if (!Number.isFinite(n) || n <= 0) return; // keep whatever is showing
            total = n;
            ready = true;
            showAgentStat(total);
            try { localStorage.setItem(AGENT_STAT_KEY, String(total)); } catch { /* ignore */ }
        })
        .catch(() => { /* keep whatever is showing, or stay hidden */ });

    // Optimistic tick: when a visitor sends a question to Atlas (agent-widget
    // dispatches this), bump the displayed count by one with a brief pop so it
    // feels live, even though /api/agent-stats is 1h-cached.
    document.addEventListener("portfolio:agent-question", () => {
        if (!ready) return;
        total += 1;
        numEl.textContent = agentStatFmt.format(total);
        try { localStorage.setItem(AGENT_STAT_KEY, String(total)); } catch { /* ignore */ }
        if (reduceMotion) return;
        numEl.classList.remove("bump");
        void numEl.offsetWidth; // reflow so the animation restarts each tick
        numEl.classList.add("bump");
    });
}

// Cross-page landings (e.g. clicking "Insights" on /live-agents/ → /#insights)
// arrive with a section hash. The browser's native jump lands short because
// trajectory/cert/posts lazy-render after parse and grow the page. Re-issue
// a drift-corrected scroll once we're booted so it rides all the way down.
function initLoadHashScroll() {
    const hash = location.hash;
    if (!hash || hash.length < 2) return;
    const target = document.querySelector(hash);
    if (!target) return;
    // For #insights, kick the posts list to load first so the section
    // reaches a stable height; scrollToTarget's polling handles the rest.
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToTarget(target)));
}

// Cookieless pageview beacon (Spec #33). Lazy-loaded on idle so it stays off
// the FCP path; the beacon itself is a single fire-and-forget POST.
function initAnalyticsWhenIdle(profile, sessionId) {
    if (!profile || !profile.links || !profile.links.pageviewApi) return;
    const fire = () => {
        import(v("./analytics.js"))
            .then(({ initAnalytics }) => initAnalytics(profile, sessionId))
            .catch((err) => console.warn("[analytics] failed to load", err));
    };
    if ("requestIdleCallback" in window) {
        requestIdleCallback(fire, { timeout: 3000 });
    } else {
        setTimeout(fire, 1500);
    }
}

function initAgentWidgetOnBoot(profile, sessionId) {
    if (!profile || !profile.links || !profile.links.agentApi) return;
    // Spec 78: inside the frame Atlas opens a page in, the home page is the
    // one behind it. A second Atlas here would be a second mic and a second call.
    if (window.self !== window.top) return;
    // Skip on bandwidth-saver + reduced-motion combo (per spec #20).
    if (saveData && reduceMotion) return;
    const root = document.getElementById("agent-root");
    if (!root) return;

    let loading = null;
    const start = () => {
        if (window.__agentWidget) return Promise.resolve(window.__agentWidget);
        if (loading) return loading;
        loading = import(v("./agent-widget.js"))
            .then(({ initAgentWidget }) => {
                window.__agentWidget = initAgentWidget(root, profile, sessionId);
                return window.__agentWidget;
            })
            .catch((err) => {
                console.warn("[agent-widget] failed to load", err);
                loading = null;
            });
        return loading;
    };

    // Spec 22: hero CTA + mobile bottom-bar use [data-agent-open]. A tap opens the
    // widget; if it somehow has not loaded yet it loads first, then opens.
    document.addEventListener("click", (e) => {
        const trigger = e.target.closest("[data-agent-open]");
        if (!trigger) return;
        // FAB has its own internal handler; don't double-open.
        if (trigger.classList.contains("agent-fab")) return;
        e.preventDefault();
        const source = trigger.getAttribute("data-agent-source") || "hero";
        Promise.resolve(start()).then((api) => api && api.open && api.open(source));
    });

    // Start loading as soon as the page has booted, not "when the browser is idle"
    // (which could be 2.5s in), so the chat opens the moment someone clicks. The
    // voice and avatar modules stay lazy: they load only when a mode is picked.
    start();

    // Spec 108: "Chat with my agent" on insight pages links to /?chat=1, so
    // the visitor lands with Atlas already open. Drop the param afterwards so
    // a reload or a shared link doesn't keep reopening it.
    const params = new URLSearchParams(location.search);
    if (params.has("chat")) {
        params.delete("chat");
        const qs = params.toString();
        history.replaceState(history.state, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
        Promise.resolve(start()).then((api) => api && api.open && api.open("insight-post"));
    }
    return start;
}

// Spec 98: a one-off pop-up that nudges a first-time visitor to try Atlas.
// Built entirely in hero-ask.js and positioned off the Atlas button, so it
// costs first paint nothing. No widget (iframe, save-data): no nudge.
function initHeroAsk(profile, getWidget) {
    if (!getWidget || !profile.heroAsk) return;
    import(v("./hero-ask.js"))
        .then((m) => m.initHeroAsk({ content: profile.heroAsk, getWidget }))
        .catch((err) => console.warn("[hero-ask] failed to load", err));
}

async function initCursorAsync() {
    // A trackpad or mouse gets the cursor, even on a touchscreen laptop
    // (see cursor.js); a touch-only phone or tablet doesn't.
    if (!matchMedia("(any-pointer: fine) and (any-hover: hover)").matches) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    try {
        const { initCursor } = await import(v("./cursor.js"));
        const inst = initCursor();
        window.__cursor = inst;
    } catch (err) {
        console.warn("[cursor] failed to load", err);
    }
}

function initRevealWhenIdle() {
    const run = async () => {
        try {
            const { initReveal } = await import(v("./reveal.js"));
            initReveal(document);
        } catch (err) {
            console.warn("[reveal] failed to load", err);
        }
    };
    if ("requestIdleCallback" in window) {
        requestIdleCallback(run, { timeout: 2500 });
    } else {
        setTimeout(run, 300);
    }
}

function auditConsole() {
    // Surface unexpected runtime errors without breaking the page.
    window.addEventListener("error", (e) => {
        // eslint-disable-next-line no-console
        console.warn("[portfolio] runtime error", e.message, e.filename, e.lineno);
    });
}

// Spec 109: "What I bring" is a bento rendered by capabilities.js, loaded as
// the section nears the viewport (it brings its own stylesheet).
function initCapabilities(profile) {
    const root = document.querySelector("[data-capabilities-root]");
    if (!root || !profile) return;
    const io = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        import(v("./capabilities.js"))
            .then(({ initCapabilities: init }) => init(root, { profile }))
            .catch((err) => console.warn("[capabilities] failed to init", err));
    }, { rootMargin: "800px 0px" });
    io.observe(root);
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/* ---------- cert rail (spec 10) ---------- */

const CATEGORY_ORDER = { ai: 0, cloud: 1, security: 2 };

function initCertRail(profile) {
    const root = document.querySelector("[data-cert-rail]");
    if (!root) return;

    const certs = (profile.certifications || []).slice().sort((a, b) =>
        (CATEGORY_ORDER[a.category] ?? 99) - (CATEGORY_ORDER[b.category] ?? 99)
    );
    if (certs.length === 0) return;

    const list = document.createElement("ul");
    list.className = "cert-rail-list";

    for (const c of certs) {
        list.appendChild(renderCertTile(c, false));
    }
    for (const c of certs) {
        list.appendChild(renderCertTile(c, true));
    }
    // Third copy ensures the list is wide enough for ultra-wide viewports
    for (const c of certs) {
        list.appendChild(renderCertTile(c, true));
    }
    root.appendChild(list);

    // Measure the exact pixel distance from list start to the first duplicate
    // so the keyframe loops back to precisely the same visual position.
    requestAnimationFrame(() => {
        const firstDupe = list.children[certs.length];
        if (firstDupe) {
            list.style.setProperty("--cert-ticker-dist", `-${firstDupe.offsetLeft}px`);
        }
    });
}

function renderCertTile(c, isDuplicate = false) {
    const li = document.createElement("li");
    li.className = "cert-tile" + (c.category === "ai" ? " is-ai" : "");
    li.setAttribute("data-slug", c.slug || "");

    const img = document.createElement("img");
    img.src = c.badge;
    img.alt = isDuplicate ? "" : c.name;
    img.loading = "lazy";
    img.decoding = "async";

    const pop = document.createElement("div");
    pop.className = "cert-tile-popover";
    pop.setAttribute("role", "tooltip");
    pop.innerHTML = `
        <div class="cert-tile-popover-name">${escapeHtml(c.name)}</div>
        <div class="cert-tile-popover-meta"><span class="issuer">${escapeHtml(c.issuer || "")}</span>${c.issuedAt ? ` · ${escapeHtml(c.issuedAt)}` : ""}</div>
    `;

    // Real <a> wrapper so right-click "Open in new tab", browser hover URL
    // preview, and screen-reader link semantics all work natively. If a
    // credlyUrl is missing for some reason, fall back to a plain wrapper.
    const wrapper = c.credlyUrl ? document.createElement("a") : document.createElement("div");
    wrapper.className = "cert-tile-link";
    if (c.credlyUrl) {
        wrapper.href = c.credlyUrl;
        wrapper.target = "_blank";
        wrapper.rel = "noopener noreferrer";
    }
    wrapper.appendChild(img);
    wrapper.appendChild(pop);
    li.appendChild(wrapper);

    if (isDuplicate) {
        li.setAttribute("aria-hidden", "true");
        // Keep the mirror tile out of the tab order — it duplicates the
        // first half of the rail for the seamless marquee loop.
        if (c.credlyUrl) wrapper.setAttribute("tabindex", "-1");
    } else if (c.credlyUrl) {
        wrapper.setAttribute("aria-label", `${c.name}: verify on Credly (opens in new tab)`);
    }

    return li;
}




function initTrajectoryWhenVisible(profile) {
    const root = document.querySelector("#career [data-trajectory-root]");
    if (!root) return;
    const io = new IntersectionObserver(async (entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            try {
                const { initTrajectory } = await import(v("./trajectory.js"));
                const inst = initTrajectory(root, profile);
                window.__trajectory = inst;
                // Spec 22: collapse companies behind <details> on mobile.
                if (isNarrow) setupTrajectoryMobileCollapse(root);
            } catch (err) {
                console.warn("[trajectory] failed to init", err);
            }
        }
    }, { rootMargin: "300px" });
    io.observe(root);
}

// Selected Work teaser: a plain content section, so it loads its module the first
// time it nears the viewport (same pattern as the career trail above). The CSS
// reserves its height so a late render shifts nothing.
function initLazySection(selector, modulePath, exportName) {
    const root = document.querySelector(selector);
    if (!root) return;
    const io = new IntersectionObserver(async (entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            try {
                const mod = await import(v(modulePath));
                await mod[exportName](root);
            } catch (err) {
                console.warn(`[${exportName}] failed to init`, err);
            }
        }
    }, { rootMargin: "600px" });
    io.observe(root);
}

function initSkillsHexWhenVisible() {
    // The in-hero panel only renders at ≥1440px (see layout.css). Below that —
    // including the 768–1439px range Windows display scaling lands in — the
    // honeycomb lives in the standalone .mobile-skills section, so mount there.
    const inHero = matchMedia("(min-width: 901px)").matches;
    const root = inHero
        ? document.querySelector('[data-skills-root]')
        : document.querySelector('[data-mobile-skills-root]');
    if (!root) return;
    import(v("./skills-hex.js"))
        .then(({ initSkillsHex }) => initSkillsHex(root, { instant: true }))
        // The grid only exists now; hand it to the offscreen pause observer.
        .then(() => observeOffscreenPause(root.querySelector(".skills-hex-grid")))
        .catch((err) => console.warn("[skills-hex] failed to init", err));
}

function initPostsListWhenVisible(profile) {
    const root = document.querySelector("#insights [data-posts-root]");
    if (!root) return;
    const metricsApi = profile?.links?.metricsApi;
    let initiated = false;
    let initPromise = null;

    const doInit = () => {
        if (initPromise) return initPromise;
        initiated = true;
        io.disconnect();
        initPromise = (async () => {
            try {
                const { initPostsList } = await import(v("./posts-list.js"));
                // Spec 108: the home page shows the five featured posts plus
                // a "View all" link; the full list lives on /insights/.
                const inst = await initPostsList(root, { metricsApi, featured: true, limit: 5 });
                window.__postsList = inst;
            } catch (err) {
                console.warn("[posts] failed to init", err);
            }
        })();
        return initPromise;
    };

    // Large rootMargin ensures posts load well before the viewport reaches
    // the section when the user scrolls normally.
    const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) doInit();
        }
    }, { rootMargin: "1200px" });
    io.observe(root);

    // When any link to #insights is clicked: block navigation, wait for
    // posts to fully render (so DOM height is stable), then scroll there.
    // This prevents the smooth-scroll landing in the wrong place mid-load.
    document.addEventListener("click", async e => {
        const a = e.target.closest("a[href='#insights']");
        if (!a) return;
        e.preventDefault();
        e.stopPropagation(); // prevent delegated Lenis handler from also firing
        // stopPropagation here (capture phase, on document) also means the
        // mobile drawer's own "close on any link" listener never sees this
        // click, so the drawer stayed open over the section it just scrolled
        // to. Close it explicitly (see nav-drawer.js). No-op if it's closed.
        document.dispatchEvent(new CustomEvent("nav-drawer:close"));
        // If this was the nav flyout trigger, collapse the flyout: blur to drop
        // :focus-within, and suppress :hover until the cursor leaves the group.
        const navGroup = a.closest("[data-flyout-group]");
        if (navGroup) {
            a.blur();
            navGroup.classList.add("flyout-suppressed");
            navGroup.addEventListener("mouseleave", () => {
                navGroup.classList.remove("flyout-suppressed");
            }, { once: true });
        }
        await doInit();
        // Two rAFs: first lets layout settle after posts insert, second lets
        // any following repaints flush before we measure the final target Y.
        await new Promise(r => requestAnimationFrame(r));
        await new Promise(r => requestAnimationFrame(r));
        const section = document.getElementById("insights");
        if (section) scrollToTarget(section);
    }, { capture: true });
}

async function initPostsFlyoutEager() {
    const root = document.querySelector("[data-posts-flyout]");
    if (!root) return;
    try {
        const { initPostsFlyout } = await import(v("./posts-list.js"));
        const inst = await initPostsFlyout(root);
        window.__postsFlyout = inst;

        const group = root.closest("[data-flyout-group]");
        const link = group && group.querySelector("a[aria-haspopup]");
        if (!group || !link) return;
        const sync = (open) => link.setAttribute("aria-expanded", open ? "true" : "false");

        // Mouse / keyboard: CSS :hover and :focus-within drive the reveal —
        // we just mirror state into aria-expanded for assistive tech.
        group.addEventListener("mouseenter", () => sync(true));
        group.addEventListener("mouseleave", () => sync(false));
        group.addEventListener("focusin",   () => sync(true));
        group.addEventListener("focusout",  () => sync(false));

        // Touch (iPad, touch laptops, mobile-with-large-viewport): the link
        // would otherwise navigate to #insights on the first tap, never
        // revealing the flyout. Standard "first tap opens, second tap
        // navigates" pattern, with tap-outside to dismiss.
        if (matchMedia("(any-pointer: coarse)").matches) {
            const setOpen = (open) => {
                group.classList.toggle("is-open", open);
                sync(open);
            };
            link.addEventListener("click", (e) => {
                if (!group.classList.contains("is-open")) {
                    e.preventDefault();
                    setOpen(true);
                }
                // Else: link click goes through and navigates to #insights.
            });
            document.addEventListener("click", (e) => {
                if (!group.classList.contains("is-open")) return;
                if (group.contains(e.target)) {
                    // Tap on a flyout item inside — let native navigation
                    // happen and then close the flyout.
                    if (e.target.closest("a[href]") && e.target !== link) {
                        setOpen(false);
                    }
                    return;
                }
                setOpen(false);
            });
            document.addEventListener("keydown", (e) => {
                if (e.key === "Escape" && group.classList.contains("is-open")) {
                    setOpen(false);
                    link.blur();
                }
            });
        }
    } catch (err) {
        console.warn("[posts-flyout] failed to init", err);
    }
}

function wireScrollTo() {
    document.addEventListener("portfolio:scroll-to", (e) => {
        const anchor = e.detail && e.detail.anchor;
        if (!anchor) return;
        const target = document.querySelector(anchor);
        if (!target) return;
        scrollToTarget(target, { duration: 1.2 });
    });
}

// Lazy-loaded modules (trajectory, cert rail, posts) render as the scroll
// passes them, growing the page and pushing the target down — a single
// scroll undershoots and lands short (e.g. clicking "Insights" lands at
// the Career section). A one-shot onComplete fix isn't enough on Chrome,
// where there's no Lenis and native scrollIntoView never corrects at all.
//
// Fix: poll after the scroll. Whenever the page has settled (stopped
// moving) but we're still off the re-measured target, re-scroll. Works on
// every browser since it doesn't depend on Lenis. Bounded to ~2s so it
// can't fight the user indefinitely; exits the instant we're on target.
function scrollToTarget(target, opts) {
    if (!target) return;
    const offset   = (opts && typeof opts.offset   === "number") ? opts.offset   : -80;
    const duration = (opts && typeof opts.duration === "number") ? opts.duration : 1.1;
    const lenis    = window.__lenis;
    const hasLenis = lenis && typeof lenis.scrollTo === "function";

    const expectedY = () => {
        const r = target.getBoundingClientRect();
        return Math.max(0, r.top + window.scrollY + offset); // offset is negative
    };

    const doScroll = (dur) => {
        if (hasLenis) {
            lenis.scrollTo(target, { offset, duration: dur });
        } else {
            window.scrollTo({ top: expectedY(), behavior: "smooth" });
        }
    };

    doScroll(duration);

    // Correct at most once. Posts (the biggest page-grower before Insights)
    // now render before this scroll starts, so drift is small; the only
    // remaining growth is the trajectory/cert-rail revealing as they pass.
    // A single re-scroll on settle fixes the undershoot without stacking
    // smooth animations that fight the still-moving layout.
    const deadline = performance.now() + 800;
    let prevY = window.scrollY;
    let stable = 0;
    let corrected = false;
    const check = () => {
        const y = window.scrollY;
        const moving = Math.abs(y - prevY) > 1;
        prevY = y;
        const drift = expectedY() - y;
        if (Math.abs(drift) <= 8) return; // on target — stop polling
        if (moving) {
            stable = 0;
        } else if (++stable >= 2 && !corrected) {
            // Settled short of the (re-measured) target — correct once.
            corrected = true;
            doScroll(0.3);
        }
        if (!corrected && performance.now() < deadline) setTimeout(check, 90);
    };
    setTimeout(check, 150);
}

/* ---------- data binding ---------- */

function bindDOM(profile) {
    document.querySelectorAll("[data-bind]").forEach(el => {
        const path = el.getAttribute("data-bind");
        const value = lookup(profile, path);
        if (typeof value === "string") el.textContent = value;
    });

    document.querySelectorAll("[data-bind-href]").forEach(el => {
        const raw = el.getAttribute("data-bind-href");
        const isMailto = raw.startsWith("mailto:");
        const path = isMailto ? raw.slice("mailto:".length) : raw;
        const value = lookup(profile, path);
        if (typeof value === "string") el.setAttribute("href", isMailto ? `mailto:${value}` : value);
    });

    document.querySelectorAll("[data-bind-title]").forEach(el => {
        const path = el.getAttribute("data-bind-title");
        const value = lookup(profile, path);
        if (typeof value === "string") el.setAttribute("title", value);
    });
}

// HTML uses paths like "profile.name" / "profile.links.email" for legibility.
// Strip the leading "profile." since it always refers to the same object.
function lookup(profile, path) {
    const p = path.startsWith("profile.") ? path.slice("profile.".length) : path;
    return resolve(profile, p);
}

function resolve(obj, path) {
    return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function setYear() {
    const el = document.getElementById("year");
    if (el) el.textContent = String(new Date().getFullYear());
}

/* ---------- Lenis ---------- */

function initLenis() {
    if (reduceMotion || isNarrow) return;
    if (typeof window.Lenis !== "function") return;
    // Skip Lenis on Windows. A real wheel mouse fires coarse 120-unit ticks,
    // and Lenis stretches each one into ~36 painted frames of smoothing —
    // every one of which has to repaint the fixed nav, the WebGL hero
    // canvas, and 20 cert tiles. Windows DXGI/ANGLE pays a much higher
    // per-frame composite cost than macOS Metal, so the smoothing buys
    // jank instead of polish. Native Windows wheel scroll is bound by the
    // input rate (~30 ticks/sec max) — far cheaper. macOS keeps Lenis
    // because trackpads already produce small frequent inputs that
    // benefit from the elastic curve.
    if (isWindows() || isChrome()) return;
    const lenis = new window.Lenis({
        duration: 0.6,
        easing: (t) => 1 - Math.pow(1 - t, 3),
        smoothWheel: true,
        wheelMultiplier: 1.1,
    });
    function raf(time) { lenis.raf(time); requestAnimationFrame(raf); }
    requestAnimationFrame(raf);
    window.__lenis = lenis;
}

/* ---------- anchor scroll (all browsers) ---------- */
// Runs unconditionally so Chrome/Windows/narrow users also get proper
// offset-corrected scrolling — the delegated listener was previously
// inside initLenis() which returns early for those environments,
// leaving them on raw native scroll with no nav-height offset.
function initAnchorScroll() {
    document.addEventListener("click", (e) => {
        const a = e.target.closest('a[href^="#"]');
        if (!a) return;
        const id = a.getAttribute("href");
        if (!id || id.length < 2 || id === "#") return;
        // #insights has its own capture handler that awaits posts loading.
        if (id === "#insights") return;
        const target = document.querySelector(id);
        if (!target) return;
        e.preventDefault();
        scrollToTarget(target);
    });
}

/* ---------- page-link transition ---------- */

function initPageLinks() {
    document.addEventListener("click", async (e) => {
        const a = e.target.closest("[data-page-link]");
        if (!a) return;
        const href = a.getAttribute("href");
        if (!href) return;
        e.preventDefault();
        try {
            const { runPageTransition } = await import(v("./page-transition.js"));
            runPageTransition(href);
        } catch (_) {
            window.location.href = href;
        }
    });
}

/* ---------- hero ----------
   The hero used to stage itself over about 3 seconds: chrome lines, a name scramble,
   a word-by-word tagline, the buttons at ~2.6s, the agents link at ~2.9s, the badge
   rail at ~3.15s. It is all plain HTML and CSS now and visible from the first paint,
   so there is nothing for script to reveal. (Git history has the old timeline.) */

/* ---------- scroll-state class ----------
   Toggles `body.is-scrolling` while the page is actively scrolling. The CSS
   uses this to drop the fixed-nav backdrop-filter during scroll (re-blurring
   a 1920×64 strip every frame is the single biggest scroll cost on Windows
   under DXGI/ANGLE) and snap it back ~150 ms after the user stops. The
   blur is imperceptible while scrolling fast and identical when stationary. */
function initScrollStateClass() {
    if (reduceMotion) return;
    const body = document.body;
    let raf = 0;
    let idleTimer = 0;
    const IDLE_MS = 250;
    const onScroll = () => {
        if (!body.classList.contains("is-scrolling")) {
            body.classList.add("is-scrolling");
        }
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            body.classList.remove("is-scrolling");
            idleTimer = 0;
        }, IDLE_MS);
        raf = 0;
    };
    window.addEventListener("scroll", () => {
        if (raf) return;
        raf = requestAnimationFrame(onScroll);
    }, { passive: true });
}

/* ---------- off-screen animation pause ----------
   The hero (cursor blink, three flying-agent dots, dot-pulse) and the cert
   rail (36 s ticker + per-tile shimmer) keep their GPU layers animating
   even when scrolled out of view. On Windows that compounds with the
   backdrop-filter on the fixed nav into measurable scroll jank.

   Toggling `data-paused="true"` when the section leaves the viewport pairs
   with CSS rules that set `animation-play-state: paused` on the looped
   keyframes. When the section scrolls back into view the animations
   resume from the same offset, so the visual identity is preserved. */
// Created by initOffscreenAnimationPause(); observeOffscreenPause() lets
// late-mounted sections join. `.skills-hex-grid` is one: skills-hex.js
// builds it after a dynamic import, long after the boot-time query below,
// which used to find nothing — so the hexes were never observed and never
// paused offscreen. Elements that arrive before the observer exists wait in
// `pendingOffscreen`.
let offscreenIO = null;
const pendingOffscreen = [];
function observeOffscreenPause(el) {
    if (!el) return;
    if (offscreenIO) offscreenIO.observe(el);
    else pendingOffscreen.push(el);
}

function initOffscreenAnimationPause() {
    const targets = [
        document.getElementById("top"),
        document.querySelector(".cert-rail"),
        document.querySelector(".skills-hex-grid"),
        ...pendingOffscreen,
    ].filter(Boolean);
    if (!("IntersectionObserver" in window)) return;

    const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                entry.target.removeAttribute("data-paused");
            } else {
                entry.target.setAttribute("data-paused", "true");
            }
        }
    }, { threshold: 0 });
    offscreenIO = io;

    targets.forEach((el) => io.observe(el));
}

/* ---------- cert-tile tap-to-open (mobile) ---------- */

function initCertTilesTouch() {
    if (!matchMedia("(any-pointer: coarse)").matches) return;
    const rail = document.querySelector("[data-cert-rail]");
    if (!rail) return;

    rail.addEventListener("click", (e) => {
        const tile = e.target.closest(".cert-tile");
        if (!tile || !rail.contains(tile)) return;
        const wasOpen = tile.classList.contains("is-open");
        rail.querySelectorAll(".cert-tile.is-open").forEach((t) => t.classList.remove("is-open"));
        if (!wasOpen) tile.classList.add("is-open");
    });

    document.addEventListener("click", (e) => {
        if (e.target.closest(".cert-tile")) return;
        rail.querySelectorAll(".cert-tile.is-open").forEach((t) => t.classList.remove("is-open"));
    });
}

/* ========== Spec 22 — Mobile enhancements ============================
   Wires the cert chip toggle, and the
   scroll-aware bottom-bar. Capabilities + Trajectory collapse helpers
   live below; they're called from initCapabilities and the trajectory
   lazy-load callback respectively.
   All side effects gate on isNarrow — desktop is untouched. */

function initMobileEnhancements(profile) {
    if (!isNarrow) return;

    // Spec 22.1: cert chip removed in favour of restoring the original
    // animated cert ticker on mobile. setupCertChip / .cert-rail-chip-mobile
    // are no longer wired.
    void profile;
    setupScrollAwareBottombar();
}

function setupScrollAwareBottombar() {
    if (reduceMotion) return; // bottom-bar stays fixed when motion is reduced.
    const bar = document.querySelector("[data-mobile-bottombar]");
    if (!bar) return;
    let lastY = window.scrollY;
    let raf = 0;
    const onScroll = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            const y = window.scrollY;
            // Don't hide near the very top — visitors haven't seen the CTA yet.
            if (y < 120) {
                bar.removeAttribute("data-hidden");
            } else if (y > lastY + 4) {
                bar.setAttribute("data-hidden", "true");
            } else if (y < lastY - 4) {
                bar.removeAttribute("data-hidden");
            }
            lastY = y;
        });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
}

function setupTrajectoryMobileCollapse(root) {
    const companies = root.querySelectorAll(".trail-company");
    if (!companies.length) return;
    companies.forEach((company, idx) => {
        if (company.hasAttribute("data-mobile-collapsible")) return;

        const header = company.querySelector(".company-header");
        const roleList = company.querySelector(".role-list");
        if (!header || !roleList) return;

        const details = document.createElement("details");
        // First company opens by default so the section isn't fully blank.
        if (idx === 0) details.open = true;

        const summary = document.createElement("summary");
        summary.appendChild(header);
        const arrow = document.createElement("span");
        arrow.className = "trail-company-summary-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "›";
        summary.appendChild(arrow);

        details.appendChild(summary);
        details.appendChild(roleList);
        company.appendChild(details);
        company.setAttribute("data-mobile-collapsible", "true");

        details.addEventListener("toggle", () => {
            window.dispatchEvent(new CustomEvent("portfolio:trajectory-remeasure"));
        });
    });
}
