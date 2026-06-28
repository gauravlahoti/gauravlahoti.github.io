// main.js — bootstrap. Reads profile.json, binds DOM, sets up Lenis,
// orchestrates the hero reveal, lazy-loads hero-graph when #top is in view.

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
const ASSET_VERSION = "215";
const v = (path) => `${path}?v=${ASSET_VERSION}`;

// (Refresh-lands-at-top behavior is handled by the inline <script> in
// index.html <head> — runs before auto-restore + bfcache restore.)

(async function bootstrap() {
    let profile;
    try {
        profile = await fetch("content/profile.json", { cache: "no-cache" }).then(r => r.json());
    } catch (err) {
        console.warn("[portfolio] profile.json missing or invalid", err);
        return;
    }

    bindDOM(profile);
    setTitle(profile);
    setYear();
    initLenis();
    initAnchorScroll();
    scheduleHeroReveal();
    initHeroGraphWhenVisible();

    initTrajectoryWhenVisible(profile);
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
    initResumeGateLazy(profile);
    initAgentWidgetWhenIdle(profile);
    initMobileEnhancements(profile);
    initAnalyticsWhenIdle(profile);
    initAgentStat(profile);
    initPageLinks();
    initLoadHashScroll();
    auditConsole();
})();

// Live Atlas counter — fetches total questions answered from /api/agent-stats
// and reveals "Atlas has answered N questions" under the hero tagline, counting
// the number up. The element starts [hidden]; we only show it once we have a
// real positive number (never flash "0"). Fired on idle to stay off the FCP
// path. The endpoint is CDN-cached 1h, so this reflects a fresh count per visit.
function initAgentStat(profile) {
    const api = profile && profile.links && profile.links.agentStatsApi;
    const el = document.querySelector("[data-agent-stat]");
    const numEl = el && el.querySelector("[data-agent-stat-num]");
    if (!api || !el || !numEl) return;

    // The hero CTA buttons reveal via GSAP at ~2.6–2.8s (scheduleHeroReveal).
    // Hold the stat until just after so it doesn't pop in before the buttons.
    // Under reduced-motion the buttons show instantly, so reveal immediately.
    const REVEAL_AT = reduceMotion ? 0 : 3100;

    let total = 0;
    let ready = false;

    const reveal = (n) => {
        el.hidden = false;
        // Two rAFs so the [hidden]→visible flip paints before we add
        // .is-shown, letting the opacity/transform transition play.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            el.classList.add("is-shown");
            countUp(numEl, n);
        }));
    };

    const run = () => {
        fetch(api, { cache: "no-cache" })
            .then(r => (r.ok ? r.json() : null))
            .then(data => {
                const n = data && Number(data.total_conversations);
                if (!Number.isFinite(n) || n <= 0) return; // stay hidden
                total = n;
                ready = true;
                const wait = Math.max(0, REVEAL_AT - performance.now());
                wait ? setTimeout(() => reveal(total), wait) : reveal(total);
            })
            .catch(() => { /* leave hidden on failure */ });
    };

    // Optimistic tick: when a visitor sends a question to Atlas (agent-widget
    // dispatches this), bump the displayed count by one with a brief pop so it
    // feels live — even though /api/agent-stats is 1h-cached.
    document.addEventListener("portfolio:agent-question", () => {
        if (!ready) return;
        total += 1;
        const fmt = new Intl.NumberFormat("en-US");
        numEl.textContent = fmt.format(total);
        if (reduceMotion) return;
        numEl.classList.remove("bump");
        void numEl.offsetWidth; // reflow so the animation restarts each tick
        numEl.classList.add("bump");
    });

    if ("requestIdleCallback" in window) {
        requestIdleCallback(run, { timeout: 3000 });
    } else {
        setTimeout(run, 1200);
    }
}

function countUp(node, target) {
    const fmt = new Intl.NumberFormat("en-US");
    if (reduceMotion) { node.textContent = fmt.format(target); return; }
    const duration = 1100;
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic
    const tick = (now) => {
        const p = Math.min(1, (now - start) / duration);
        node.textContent = fmt.format(Math.round(ease(p) * target));
        if (p < 1) requestAnimationFrame(tick);
        else node.textContent = fmt.format(target);
    };
    requestAnimationFrame(tick);
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
function initAnalyticsWhenIdle(profile) {
    if (!profile || !profile.links || !profile.links.pageviewApi) return;
    const fire = () => {
        import(v("./analytics.js"))
            .then(({ initAnalytics }) => initAnalytics(profile))
            .catch((err) => console.warn("[analytics] failed to load", err));
    };
    if ("requestIdleCallback" in window) {
        requestIdleCallback(fire, { timeout: 3000 });
    } else {
        setTimeout(fire, 1500);
    }
}

function initAgentWidgetWhenIdle(profile) {
    if (!profile || !profile.links || !profile.links.agentApi) return;
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
                window.__agentWidget = initAgentWidget(root, profile);
                return window.__agentWidget;
            })
            .catch((err) => {
                console.warn("[agent-widget] failed to load", err);
                loading = null;
            });
        return loading;
    };

    // Spec 22: hero CTA + mobile bottom-bar use [data-agent-open]. Any tap
    // eagerly loads the widget (if not already idle-loaded) and opens it.
    document.addEventListener("click", (e) => {
        const trigger = e.target.closest("[data-agent-open]");
        if (!trigger) return;
        // FAB has its own internal handler; don't double-open.
        if (trigger.classList.contains("agent-fab")) return;
        e.preventDefault();
        Promise.resolve(start()).then((api) => api && api.open && api.open());
    });

    if ("requestIdleCallback" in window) {
        requestIdleCallback(start, { timeout: 2500 });
    } else {
        setTimeout(start, 1500);
    }
}

function initResumeGateLazy(profile) {
    let inst = null;
    let loading = null;
    document.addEventListener("click", (e) => {
        const trigger = e.target.closest("[data-resume-trigger]");
        if (!trigger) return;
        e.preventDefault();
        if (inst) { inst.open(); return; }
        if (loading) return;
        loading = import(v("./resume-gate.js"))
            .then(({ initResumeGate }) => {
                inst = initResumeGate(profile);
                inst.open();
            })
            .catch((err) => {
                console.warn("[resume-gate] failed to load", err);
                loading = null;
            });
    });
}

async function initCursorAsync() {
    if (matchMedia("(any-pointer: coarse)").matches) return;
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

function initCapabilities(profile) {
    const root = document.querySelector("[data-capabilities-root]");
    if (!root || !profile) return;

    const caps = profile.capabilities || {};
    // All chips are presentational — no click-to-scroll. Skill chips name
    // technologies, not navigation targets. The "+N more" reveal trigger
    // remains a real <button> because it actually does something.
    renderAxis("ai-native", caps.aiNative || []);
    renderAxis("cloud",     caps.cloud    || []);
    renderAxis("business",  caps.business || []);

    // Spec 22: collapse each axis behind a 3-chip preview on mobile.
    if (isNarrow) setupCapabilitiesMobileCollapse(root);

    // Row alignment across the 3 axis columns is now CSS-only — see the
    // `display: contents` block in components.css.

    const cards = root.querySelectorAll(".cap-card");
    if (!cards.length) return;

    const gsap = window.gsap;

    const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            if (gsap && !reduceMotion) {
                // clearProps wipes inline opacity+transform once the tween
                // finishes so nothing leaks into post-animation layout.
                gsap.from(cards, {
                    opacity: 0,
                    y: 16,
                    stagger: 0.05,
                    duration: 0.5,
                    ease: "power3.out",
                    clearProps: "opacity,transform",
                });
            }
            triggerScanLines(cards);
        }
    }, { rootMargin: "0px 0px -10% 0px" });
    io.observe(root);
}

const CHIP_VISIBLE_LIMIT = 5;

function renderAxis(axisKey, groups) {
    const body = document.querySelector(`[data-axis-body="${axisKey}"]`);
    if (!body) return;
    body.replaceChildren();

    groups.forEach((group, idx) => {
        const card = document.createElement("article");
        card.className = "cap-card";
        card.dataset.axis = axisKey;
        if (group.key) card.dataset.key = group.key;

        const index = String(idx + 1).padStart(2, "0");
        card.innerHTML = `
            <span class="cap-bracket cap-bracket-tl" aria-hidden="true"></span>
            <span class="cap-bracket cap-bracket-br" aria-hidden="true"></span>
            <span class="cap-scan" aria-hidden="true"></span>
            <span class="cap-index" aria-hidden="true">${index}</span>
            <header class="cap-card-head">
                <h4 class="cap-label">${escapeHtml(group.label || group.key || "")}</h4>
            </header>
            ${group.context ? `<p class="cap-context">${escapeHtml(group.context)}</p>` : ""}
            <ul class="cap-chips" role="list"></ul>
        `;

        const chipList = card.querySelector(".cap-chips");
        const items = group.items || [];
        const overflow = items.length > CHIP_VISIBLE_LIMIT;

        items.forEach((name, i) => {
            const li = document.createElement("li");
            if (overflow && i >= CHIP_VISIBLE_LIMIT) li.className = "cap-chip-extra";
            li.appendChild(buildChip(name));
            chipList.appendChild(li);
        });

        if (overflow) {
            chipList.dataset.collapsed = "true";
            const moreLi = document.createElement("li");
            moreLi.className = "cap-chip-more-wrap";
            const moreBtn = document.createElement("button");
            moreBtn.type = "button";
            moreBtn.className = "cap-chip cap-chip-more";
            moreBtn.dataset.capMore = "";
            moreBtn.setAttribute("aria-expanded", "false");
            moreBtn.textContent = `+${items.length - CHIP_VISIBLE_LIMIT} more`;

            const fewerLi = document.createElement("li");
            fewerLi.className = "cap-chip-extra cap-chip-fewer-wrap";
            const fewerBtn = document.createElement("button");
            fewerBtn.type = "button";
            fewerBtn.className = "cap-chip cap-chip-more";
            fewerBtn.textContent = "Show fewer";

            const setCollapsed = (collapsed) => {
                chipList.dataset.collapsed = String(collapsed);
                moreBtn.setAttribute("aria-expanded", String(!collapsed));
            };
            moreBtn.addEventListener("click", () => setCollapsed(false));
            fewerBtn.addEventListener("click", () => setCollapsed(true));

            moreLi.appendChild(moreBtn);
            fewerLi.appendChild(fewerBtn);
            chipList.appendChild(moreLi);
            chipList.appendChild(fewerLi);
        }

        body.appendChild(card);
    });
}

function buildChip(name) {
    const iconEl = chipIconSvgEl(name);
    const labelEl = document.createElement("span");
    labelEl.className = "cap-chip-label";
    labelEl.textContent = name;

    const el = document.createElement("span");
    el.className = "cap-chip";
    el.appendChild(iconEl);
    el.appendChild(labelEl);
    return el;
}

const CHIP_ICON_PATHS = {
    sparkle:  '<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.3 4.3l2.1 2.1M9.6 9.6l2.1 2.1M4.3 11.7l2.1-2.1M9.6 6.4l2.1-2.1"/>',
    cursor:   '<path d="M3 3 L13 8 L8.5 9 L7 13 Z"/>',
    bracket:  '<path d="M6 4 L2 8 L6 12 M10 4 L14 8 L10 12"/>',
    triangle: '<path d="M2.5 13 L8 3 L13.5 13 Z"/>',
    cloud:    '<path d="M4 11h8a3 3 0 0 0 0-6 4 4 0 0 0-8 0 3 3 0 0 0 0 6Z"/>',
    chain:    '<path d="M6 6H5a3 3 0 0 0 0 6h1M10 6h1a3 3 0 0 1 0 6h-1M5 9h6"/>',
    dots:     '<circle cx="3.5" cy="5" r="1"/><circle cx="8" cy="5" r="1"/><circle cx="12.5" cy="5" r="1"/><circle cx="3.5" cy="11" r="1"/><circle cx="8" cy="11" r="1"/><circle cx="12.5" cy="11" r="1"/>',
    cube:     '<path d="M8 2 L13 5 L8 8 L3 5 Z M3 5 V11 L8 14 V8 M13 5 V11 L8 14"/>',
    flow:     '<path d="M3 4 H13 M3 8 H13 M3 12 H13"/>',
    lock:     '<path d="M5 8 V6 a3 3 0 0 1 6 0 V8"/><rect x="3.5" y="8" width="9" height="6" rx="1"/>',
    db:       '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4 V12 a5 2 0 0 0 10 0 V4 M3 8 a5 2 0 0 0 10 0"/>',
    chart:    '<path d="M3 13 V8 M7 13 V5 M11 13 V3 M2.5 13 H12"/>',
    shield:   '<path d="M8 2 L13 4 V8 a5 6 0 0 1 -5 6 a5 6 0 0 1 -5 -6 V4 Z"/>',
    ring:     '<circle cx="8" cy="8" r="5"/>',
    diamond:  '<path d="M8 2 L14 8 L8 14 L2 8 Z"/>'
};

function chipIconKey(name) {
    const n = (name || "").toLowerCase();
    if (n.includes("claude") || n.includes("gemini") || n.includes("gpt")) return "sparkle";
    if (n.includes("cursor") || n.includes("windsurf")) return "cursor";
    if (n.includes("vs code") || n.includes("vscode") || n.includes("copilot")) return "bracket";
    if (n.includes("openapi") || n.includes("oas") ||
        n.includes("python") || n.includes("pydantic") || n.includes("fastapi") || n.includes("sql") ||
        n.includes("tool calling") || n.includes("function calling") || n.includes("structured output")) return "bracket";
    if (n.includes("vertex") || n.includes("agent platform") || n.includes("gcp") || n.includes("adk")) return "triangle";
    if (n.includes("aws") || n.includes("bedrock") || n.includes("lambda") ||
        n.includes("eventbridge") || n.includes("sagemaker") ||
        n.includes("cloud run") || n.includes("gemini enterprise") || n === "s3") return "cloud";
    if (n.includes("langchain") || n.includes("langgraph") || n.includes("mcp") ||
        n.includes("a2a") || n.includes("agent-to-agent") || n.includes("model context") ||
        n.includes("crewai") || n.includes("autogen")) return "chain";
    if (n.includes("rag") || n.includes("vector") || n.includes("pinecone") ||
        n.includes("embedding") || n.includes("titan") || n.includes("gecko") ||
        n.includes("hybrid search") || n.includes("reranking")) return "dots";
    if (n.includes("kubernetes") || n.includes("terraform")) return "cube";
    if (n.includes("pub/sub") || n.includes("event-driven") || n.includes("microservice") ||
        n.includes("apigee") || n.includes("boomi") || n.includes("oracle") || n.includes("odi") ||
        n.includes("integration")) return "flow";
    if (n.includes("guardrails")) return "shield";
    if (n.includes("oauth") || n.includes("iam") || n.includes("zero trust") ||
        n.includes("dlp") || n.includes("security")) return "lock";
    if (n.includes("firestore") || n.includes("bigquery") || n.includes("alloydb") ||
        n.includes("pgvector")) return "db";
    if (n.includes("langsmith") || n.includes("langfuse") || n.includes("phoenix") ||
        n.includes("arize") || n.includes("promptfoo") || n.includes("opentelemetry") ||
        n.includes("agent engine") || n.includes("eval") || n.includes("observability")) return "chart";
    if (n.includes("agent sdk") || n.includes("agent skills") ||
        n.includes("progressive disclosure") || n.includes("cloud deployment")) return "ring";
    return "diamond";
}

function chipIconSvgEl(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "cap-chip-icon");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = CHIP_ICON_PATHS[chipIconKey(name)] || CHIP_ICON_PATHS.diamond;
    return svg;
}

function triggerScanLines(cards) {
    if (reduceMotion) return;
    cards.forEach((card, i) => {
        setTimeout(() => card.classList.add("is-scanned"), 200 + i * 80);
    });
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
        wrapper.setAttribute("aria-label", `${c.name} — verify on Credly (opens in new tab)`);
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
        .then(({ initSkillsHex }) => initSkillsHex(root, { baseDelay: inHero ? 1200 : 800 }))
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
                const inst = await initPostsList(root, { metricsApi });
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

    const deadline = performance.now() + 2000;
    let prevY = window.scrollY;
    let stable = 0;
    const check = () => {
        const y = window.scrollY;
        const moving = Math.abs(y - prevY) > 1;
        prevY = y;
        const drift = expectedY() - y;
        if (Math.abs(drift) <= 4) return; // on target — stop polling
        if (moving) {
            stable = 0;
        } else if (++stable >= 2) {
            // Settled short of the (re-measured) target — correct.
            doScroll(0.3);
            stable = 0;
        }
        if (performance.now() < deadline) setTimeout(check, 90);
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

function setTitle(profile) {
    const title = `${profile.name} | ${profile.title}`;
    if (document.title !== title) document.title = title;
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

/* ---------- hero reveal (GSAP) ---------- */

function scheduleHeroReveal() {
    const stack = document.querySelector(".hero-stack");
    const chrome = document.querySelectorAll(".hero-chrome .chrome");
    if (!stack) return;

    const nameEl = stack.querySelector(".hero-name");
    const taglineEl = stack.querySelector(".hero-tagline");

    splitChars(nameEl);
    splitWords(taglineEl);

    const bottomBar = document.querySelector("[data-mobile-bottombar]");
    const agentsLink = document.querySelector(".hero-agents-link");

    if (reduceMotion) {
        chrome.forEach(c => (c.style.opacity = "1"));
        if (nameEl) nameEl.querySelectorAll(".char").forEach(c => (c.style.opacity = "1"));
        if (taglineEl) taglineEl.querySelectorAll(".word").forEach(w => (w.style.opacity = "1"));
        document.querySelectorAll(".hero-cta-group")
            .forEach(el => (el.style.opacity = "1"));
        if (bottomBar) bottomBar.removeAttribute("data-hidden");
        if (agentsLink) agentsLink.classList.add("is-shown");
        const certRail = document.querySelector("[data-cert-rail]");
        if (certRail) certRail.style.opacity = "1";
        return;
    }

    if (typeof window.gsap !== "function" && typeof window.gsap !== "object") {
        // GSAP didn't load — show everything statically
        chrome.forEach(c => (c.style.opacity = "1"));
        if (nameEl) nameEl.querySelectorAll(".char").forEach(c => (c.style.opacity = "1"));
        if (taglineEl) taglineEl.querySelectorAll(".word").forEach(w => (w.style.opacity = "1"));
        document.querySelectorAll(".hero-cta-group")
            .forEach(el => (el.style.opacity = "1"));
        if (bottomBar) bottomBar.removeAttribute("data-hidden");
        if (agentsLink) agentsLink.classList.add("is-shown");
        const certRail = document.querySelector("[data-cert-rail]");
        if (certRail) certRail.style.opacity = "1";
        return;
    }

    const gsap = window.gsap;
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

    // 0.4s — chrome lines slide in from edges
    chrome.forEach((c, i) => {
        const fromX = c.classList.contains("chrome-tl") || c.classList.contains("chrome-bl") ? -16 : 16;
        const fromY = c.classList.contains("chrome-tl") || c.classList.contains("chrome-tr") ? -8 : 8;
        tl.fromTo(c, { x: fromX, y: fromY, opacity: 0 }, { x: 0, y: 0, opacity: 1, duration: 0.5 }, 0.4 + i * 0.08);
    });

    // 0.7s — name scramble
    if (nameEl) {
        tl.add(scrambleName(nameEl), 0.7);
    }

    // 1.1s — identity line fade (Cloud & AI-Native Architect.)
    tl.fromTo(".hero-identity", { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.5 }, 1.1);

    // 1.3s — tagline streams word-by-word
    if (taglineEl) {
        tl.fromTo(taglineEl.querySelectorAll(".word"),
            { opacity: 0, y: 6, filter: "blur(6px)" },
            { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.45, stagger: 0.035, ease: "power2.out" },
            1.3
        );
    }

    // 2.6s — CTA group eases up after hero text + skills hex both complete
    // (skills hex finishes ~2.4s desktop, hero text ~2.2s). Glow pulse only
    // on the primary (agent) button to keep visual hierarchy clear.
    tl.fromTo(".hero-cta-group",
        { opacity: 0, y: 14 },
        { opacity: 1, y: 0, duration: 0.55, ease: "power3.out" },
        2.6
    );
    tl.to(".hero-cta-group .btn-primary", {
        boxShadow: "0 0 24px 4px var(--accent-glow)",
        duration: 0.4,
        yoyo: true,
        repeat: 1,
    }, 2.8);

    // Mobile bottom-bar slides up from below at the same beat (CSS handles
    // the translateY transition via [data-hidden] → no transform on bar).
    if (bottomBar) {
        tl.call(() => bottomBar.removeAttribute("data-hidden"), [], 2.6);
    }

    // 2.9s — "See agents in production" link fades up after the CTA buttons.
    // Mirrors the hero-livestat pattern: remove [hidden] then double-rAF so
    // the browser paints opacity:0 before the CSS transition fires.
    if (agentsLink) {
        tl.call(() => {
            agentsLink.hidden = false;
            requestAnimationFrame(() => requestAnimationFrame(() => {
                agentsLink.classList.add("is-shown");
            }));
        }, [], 2.9);
    }

    // 3.15s — cert rail fades in as the final piece of the hero reveal,
    // after the chatbot CTA and its glow effect have finished.
    tl.fromTo("[data-cert-rail]",
        { opacity: 0 },
        { opacity: 1, duration: 0.6, ease: "power2.out" },
        3.15
    );
}

function splitChars(el) {
    if (!el) return;
    const text = el.textContent;
    el.textContent = "";
    [...text].forEach(ch => {
        const span = document.createElement("span");
        span.className = "char";
        span.style.opacity = "0";
        span.textContent = ch === " " ? " " : ch;
        el.appendChild(span);
    });
}

function splitWords(el) {
    if (!el) return;
    const words = el.textContent.trim().split(/\s+/);
    el.textContent = "";
    words.forEach(w => {
        const span = document.createElement("span");
        span.className = "word";
        span.style.opacity = "0";
        span.textContent = w;
        el.appendChild(span);
    });
}

function scrambleName(nameEl) {
    const gsap = window.gsap;
    const chars = [...nameEl.querySelectorAll(".char")];
    const finals = chars.map(c => c.textContent);
    const glyphs = "ABCDEFGHIJKLMNOPQRSTUVWXYZ#@*+_-/";
    const tl = gsap.timeline();
    chars.forEach((char, i) => {
        const start = i * 0.018;
        // randomize text for ~250-400ms then lock
        tl.to(char, {
            opacity: 1,
            duration: 0.05,
            onStart() {
                let ticks = 0;
                const max = 8 + Math.floor(Math.random() * 6);
                const id = setInterval(() => {
                    if (ticks >= max) {
                        char.textContent = finals[i];
                        clearInterval(id);
                        return;
                    }
                    char.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
                    ticks += 1;
                }, 28);
            }
        }, start);
    });
    return tl;
}

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
function initOffscreenAnimationPause() {
    const targets = [
        document.getElementById("top"),
        document.querySelector(".cert-rail"),
    ].filter(Boolean);
    if (!targets.length || !("IntersectionObserver" in window)) return;

    const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                entry.target.removeAttribute("data-paused");
            } else {
                entry.target.setAttribute("data-paused", "true");
            }
        }
    }, { threshold: 0 });

    targets.forEach((el) => io.observe(el));
}

/* ---------- hero graph lazy load ---------- */

function initHeroGraphWhenVisible() {
    const canvas = document.getElementById("hero-gl");
    if (!canvas) return;

    // Spec 22: mobile (<768px) skips Three.js entirely and renders the
    // upgraded static .hero-fallback SVG mesh. Reduced-motion and save-data
    // remain the desktop kill switches.
    if (reduceMotion || saveData || isNarrow) {
        canvas.remove();
        return;
    }

    const io = new IntersectionObserver(async (entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            try {
                const mod = await import(v("./hero-graph.js"));
                const accent = getComputedStyle(ROOT).getPropertyValue("--accent").trim() || "#00FFD1";
                const inst = await mod.initHeroGraph(canvas, { accent, isTouch });
                if (inst && inst.canvas) inst.canvas.classList.add("is-ready");
                else canvas.classList.add("is-ready");
                window.__heroGraph = inst;
            } catch (err) {
                console.warn("[hero-graph] failed to load", err);
                canvas.remove();
            }
        }
    }, { rootMargin: "200px" });

    io.observe(canvas);
}

/* ---------- mobile nav drawer ---------- */

function initNavDrawer() {
    const trigger = document.querySelector("[data-nav-trigger]");
    const drawer  = document.querySelector("[data-nav-drawer]");
    if (!trigger || !drawer) return;

    const open = () => {
        drawer.classList.add("is-open");
        drawer.setAttribute("aria-hidden", "false");
        trigger.setAttribute("aria-expanded", "true");
        document.body.classList.add("is-nav-drawer-open");
        // Move keyboard focus into the panel for screen-reader / keyboard users.
        const close = drawer.querySelector(".nav-drawer-close");
        if (close) requestAnimationFrame(() => close.focus());
    };
    const close = () => {
        drawer.classList.remove("is-open");
        drawer.setAttribute("aria-hidden", "true");
        trigger.setAttribute("aria-expanded", "false");
        document.body.classList.remove("is-nav-drawer-open");
        trigger.focus();
    };

    trigger.addEventListener("click", () => {
        if (drawer.classList.contains("is-open")) close();
        else open();
    });

    // Close on backdrop tap, close-button click, or any link click inside
    // the drawer (links navigate via existing handlers — Lenis for #anchors,
    // resume-gate for [data-resume-trigger], browser default for outbound).
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
   Wires the cert chip toggle, sticky section-progress strip, and the
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
    setupSectionProgress();
    setupScrollAwareBottombar();
}

function setupSectionProgress() {
    const strip = document.querySelector("[data-section-progress]");
    if (!strip) return;
    const sections = Array.from(document.querySelectorAll("main > section[id]"));
    if (!sections.length) return;

    strip.replaceChildren();
    const dots = sections.map((sec) => {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "mobile-section-progress-dot";
        const label = sec.getAttribute("aria-label") || sec.id;
        dot.setAttribute("aria-label", `Jump to ${label}`);
        dot.addEventListener("click", () => {
            window.dispatchEvent(new CustomEvent("portfolio:scroll-to", { detail: { id: sec.id } }));
            sec.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
        });
        strip.appendChild(dot);
        return dot;
    });
    strip.setAttribute("aria-hidden", "false");

    const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const idx = sections.indexOf(entry.target);
            if (idx < 0) return;
            dots.forEach((d, i) => {
                if (i === idx) d.setAttribute("aria-current", "true");
                else d.removeAttribute("aria-current");
            });
        });
    }, { rootMargin: "-40% 0px -55% 0px", threshold: 0 });
    sections.forEach((sec) => io.observe(sec));
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

function setupCapabilitiesMobileCollapse(root) {
    const axes = root.querySelectorAll(".cap-axis");
    axes.forEach((axis) => {
        const cards = axis.querySelectorAll(".cap-card");
        if (!cards.length) return;

        // Build a 3-label preview from the first three capability labels.
        const previewLabels = Array.from(cards).slice(0, 3).map((card) => {
            const label = card.querySelector(".cap-label");
            return label ? label.textContent.trim() : "";
        }).filter(Boolean);

        const preview = document.createElement("ul");
        preview.className = "cap-axis-mobile-preview";
        preview.setAttribute("aria-hidden", "true");
        previewLabels.forEach((text) => {
            const li = document.createElement("li");
            li.textContent = text;
            preview.appendChild(li);
        });

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "cap-axis-mobile-toggle";
        const labelEl = document.createElement("span");
        labelEl.textContent = `Show ${cards.length} capabilities`;
        const arrow = document.createElement("span");
        arrow.className = "cap-axis-mobile-toggle-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "›";
        toggle.appendChild(labelEl);
        toggle.appendChild(arrow);
        toggle.setAttribute("aria-expanded", "false");

        const cardsEl = axis.querySelector(".cap-axis-cards");
        if (cardsEl) {
            cardsEl.parentNode.insertBefore(preview, cardsEl);
            cardsEl.parentNode.insertBefore(toggle, cardsEl);
        } else {
            axis.appendChild(preview);
            axis.appendChild(toggle);
        }

        axis.setAttribute("data-mobile-collapsed", "true");

        toggle.addEventListener("click", () => {
            const collapsed = axis.getAttribute("data-mobile-collapsed") === "true";
            axis.setAttribute("data-mobile-collapsed", collapsed ? "false" : "true");
            toggle.setAttribute("aria-expanded", String(collapsed));
            labelEl.textContent = collapsed
                ? "Hide capabilities"
                : `Show ${cards.length} capabilities`;
        });
    });
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
