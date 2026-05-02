// main.js — bootstrap. Reads profile.json, binds DOM, sets up Lenis,
// orchestrates the hero reveal, lazy-loads hero-graph when #hero is in view.

const ROOT = document.documentElement;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const isTouch = matchMedia("(any-pointer: coarse)").matches;
const isNarrow = matchMedia("(max-width: 767px)").matches;
const saveData = !!(navigator.connection && navigator.connection.saveData);

// Append `?v=ASSET_VERSION` to dynamic imports so a cache-bust on the entry
// script also invalidates lazy-loaded modules. Bump together with the
// ?v=N query strings on <link>/<script> in index.html.
const ASSET_VERSION = "35";
const v = (path) => `${path}?v=${ASSET_VERSION}`;

// (Refresh-lands-at-top behavior is handled by the inline <script> in
// index.html <head> — runs before auto-restore + bfcache restore.)

(async function bootstrap() {
    let profile;
    try {
        profile = await fetch("assets/js/data/profile.json").then(r => r.json());
    } catch (err) {
        console.warn("[portfolio] profile.json missing or invalid", err);
        return;
    }

    bindDOM(profile);
    setTitle(profile);
    setYear();
    initLenis();
    scheduleHeroReveal();
    initHeroGraphWhenVisible();
    initTrajectoryWhenVisible(profile);
    initPostsListWhenVisible();
    initPostsFlyoutEager();
    initNavDrawer();
    initCapabilities(profile);
    initCertRail(profile);
    initCertTilesTouch();
    wireScrollTo();
    initCursorAsync();
    initResumeGateLazy(profile);
    auditConsole();
})();

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
    renderAxis("technical", caps.technical || [], { interactive: true });
    renderAxis("business",  caps.business  || [], { interactive: false });

    const cards = root.querySelectorAll(".cap-card");
    if (!cards.length) return;

    const gsap = window.gsap;

    const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            if (gsap && !reduceMotion) {
                gsap.from(cards, { opacity: 0, y: 20, stagger: 0.05, duration: 0.5, ease: "power3.out" });
            }
            triggerScanLines(cards);
        }
    }, { rootMargin: "0px 0px -10% 0px" });
    io.observe(root);
}

function renderAxis(axisKey, groups, { interactive }) {
    const body = document.querySelector(`[data-axis-body="${axisKey}"]`);
    if (!body) return;
    body.replaceChildren();

    groups.forEach((group, idx) => {
        const card = document.createElement("article");
        card.className = "cap-card";
        card.dataset.axis = axisKey;

        const index = String(idx + 1).padStart(2, "0");
        card.innerHTML = `
            <span class="cap-bracket cap-bracket-tl" aria-hidden="true"></span>
            <span class="cap-bracket cap-bracket-br" aria-hidden="true"></span>
            <span class="cap-scan" aria-hidden="true"></span>
            <header class="cap-card-head">
                <span class="cap-index">${index}.</span>
                <h4 class="cap-label">${escapeHtml(group.label || group.key || "")}</h4>
            </header>
            ${group.context ? `<p class="cap-context">${escapeHtml(group.context)}</p>` : ""}
            <ul class="cap-chips" role="list"></ul>
        `;

        const chipList = card.querySelector(".cap-chips");
        for (const name of (group.items || [])) {
            const li = document.createElement("li");
            if (interactive) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "cap-chip";
                btn.dataset.cursor = "magnet";
                btn.textContent = name;
                btn.addEventListener("click", () => {
                    document.dispatchEvent(new CustomEvent("portfolio:highlight-skill", { detail: { label: name } }));
                    document.dispatchEvent(new CustomEvent("portfolio:scroll-to", { detail: { anchor: "#graph" } }));
                });
                li.appendChild(btn);
            } else {
                const span = document.createElement("span");
                span.className = "cap-chip is-static";
                span.textContent = name;
                li.appendChild(span);
            }
            chipList.appendChild(li);
        }

        body.appendChild(card);
    });
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
    root.appendChild(list);

    root.querySelectorAll(".cert-tile").forEach((t) => {
        t.style.setProperty("--shimmer-delay", `${(Math.random() * -7).toFixed(2)}s`);
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
    li.appendChild(img);

    const pop = document.createElement("div");
    pop.className = "cert-tile-popover";
    pop.setAttribute("role", "tooltip");
    pop.innerHTML = `
        <div class="cert-tile-popover-name">${escapeHtml(c.name)}</div>
        <div class="cert-tile-popover-meta"><span class="issuer">${escapeHtml(c.issuer || "")}</span>${c.issuedAt ? ` · ${escapeHtml(c.issuedAt)}` : ""}</div>
    `;
    li.appendChild(pop);

    if (isDuplicate) {
        li.setAttribute("aria-hidden", "true");
        li.setAttribute("tabindex", "-1");
    } else {
        li.setAttribute("tabindex", "0");
        li.setAttribute("role", "button");
        li.setAttribute("aria-label", `${c.name} — ${c.issuer || ""}`);
        li.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (c.credlyUrl) window.open(c.credlyUrl, "_blank", "noopener,noreferrer");
            } else if (e.key === "Escape") {
                li.blur();
            }
        });
    }
    li.addEventListener("click", () => {
        if (c.credlyUrl) window.open(c.credlyUrl, "_blank", "noopener,noreferrer");
    });

    return li;
}


function initTrajectoryWhenVisible(profile) {
    const root = document.querySelector("#graph [data-trajectory-root]");
    if (!root) return;
    const io = new IntersectionObserver(async (entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            try {
                const { initTrajectory } = await import(v("./trajectory.js"));
                const inst = initTrajectory(root, profile);
                window.__trajectory = inst;
            } catch (err) {
                console.warn("[trajectory] failed to init", err);
            }
        }
    }, { rootMargin: "300px" });
    io.observe(root);
}

function initPostsListWhenVisible() {
    const root = document.querySelector("#writing [data-posts-root]");
    if (!root) return;
    const io = new IntersectionObserver(async (entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            try {
                const { initPostsList } = await import(v("./posts-list.js"));
                const inst = await initPostsList(root);
                window.__postsList = inst;
            } catch (err) {
                console.warn("[posts] failed to init", err);
            }
        }
    }, { rootMargin: "300px" });
    io.observe(root);
}

async function initPostsFlyoutEager() {
    const root = document.querySelector("[data-posts-flyout]");
    if (!root) return;
    // Skip on coarse pointers — CSS hides the flyout there too, no point fetching.
    if (matchMedia("(any-pointer: coarse)").matches) return;
    try {
        const { initPostsFlyout } = await import(v("./posts-list.js"));
        const inst = await initPostsFlyout(root);
        window.__postsFlyout = inst;

        const group = root.closest("[data-flyout-group]");
        const link = group && group.querySelector("a[aria-haspopup]");
        if (!group || !link) return;
        const sync = (open) => link.setAttribute("aria-expanded", open ? "true" : "false");
        group.addEventListener("mouseenter", () => sync(true));
        group.addEventListener("mouseleave", () => sync(false));
        group.addEventListener("focusin",   () => sync(true));
        group.addEventListener("focusout",  () => sync(false));
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

// Lenis snapshots the target's document Y at scrollTo() time and animates
// to that fixed position. If lazy-loaded modules render between the
// current viewport and the target during the animation, the page grows
// and the target moves down — Lenis lands at the original (now stale)
// position. Fix: after onComplete, re-check the target's position and
// scroll the small remaining delta if it drifted.
function scrollToTarget(target, opts) {
    if (!target) return;
    const offset   = (opts && typeof opts.offset   === "number") ? opts.offset   : -80;
    const duration = (opts && typeof opts.duration === "number") ? opts.duration : 1.1;

    const lenis = window.__lenis;
    if (!lenis || typeof lenis.scrollTo !== "function") {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
    }

    const expectedY = () => {
        const r = target.getBoundingClientRect();
        return r.top + window.scrollY + offset; // offset is negative
    };

    lenis.scrollTo(target, {
        offset,
        duration,
        onComplete: () => {
            // Wait one frame so any layout settling finishes, then verify.
            requestAnimationFrame(() => {
                const drift = expectedY() - window.scrollY;
                if (Math.abs(drift) > 8) {
                    lenis.scrollTo(target, { offset, duration: 0.4 });
                }
            });
        },
    });
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
    const title = `${profile.name} — ${profile.title}`;
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
    const lenis = new window.Lenis({
        duration: 1.05,
        easing: (t) => 1 - Math.pow(1 - t, 3),
        smoothWheel: true,
        wheelMultiplier: 1,
    });
    function raf(time) { lenis.raf(time); requestAnimationFrame(raf); }
    requestAnimationFrame(raf);
    window.__lenis = lenis;

    // Delegated listener: catches anchor clicks on links rendered after
    // bootstrap (e.g. the nav flyout's "View all perspectives →" footer)
    // as well as anything present at boot. Routes through scrollToTarget
    // so we get drift correction when lazy-loaded sections shift the
    // target mid-scroll.
    document.addEventListener("click", (e) => {
        const a = e.target.closest('a[href^="#"]');
        if (!a) return;
        const id = a.getAttribute("href");
        if (!id || id.length < 2) return;
        const target = document.querySelector(id);
        if (!target) return;
        e.preventDefault();
        scrollToTarget(target);
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

    if (reduceMotion || sessionStorage.getItem("heroRevealed") === "1") {
        chrome.forEach(c => (c.style.opacity = "1"));
        if (nameEl) nameEl.querySelectorAll(".char").forEach(c => (c.style.opacity = "1"));
        if (taglineEl) taglineEl.querySelectorAll(".word").forEach(w => (w.style.opacity = "1"));
        return;
    }

    if (typeof window.gsap !== "function" && typeof window.gsap !== "object") {
        // GSAP didn't load — show everything statically
        chrome.forEach(c => (c.style.opacity = "1"));
        if (nameEl) nameEl.querySelectorAll(".char").forEach(c => (c.style.opacity = "1"));
        if (taglineEl) taglineEl.querySelectorAll(".word").forEach(w => (w.style.opacity = "1"));
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

    // 2.2s — CTAs ease up + glow pulse
    tl.fromTo(".hero-ctas .btn",
        { opacity: 0, y: 12 },
        { opacity: 1, y: 0, duration: 0.5, stagger: 0.08 },
        2.2
    );
    tl.to(".hero-ctas .btn-primary", {
        boxShadow: "0 0 24px 4px var(--accent-glow)",
        duration: 0.4,
        yoyo: true,
        repeat: 1,
    }, 2.4);

    tl.eventCallback("onComplete", () => sessionStorage.setItem("heroRevealed", "1"));
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

/* ---------- hero graph lazy load ---------- */

function initHeroGraphWhenVisible() {
    const canvas = document.getElementById("hero-gl");
    if (!canvas) return;

    // Width is no longer a kill switch — only reduced-motion and save-data
    // drop the canvas. Narrow viewports get a slimmer mobile profile via
    // the isMobile flag below; if the device truly can't keep up, the
    // hero-graph FPS watchdog falls back gracefully.
    if (reduceMotion || saveData) {
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
                const inst = await mod.initHeroGraph(canvas, { accent, isTouch, isMobile: isNarrow });
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
