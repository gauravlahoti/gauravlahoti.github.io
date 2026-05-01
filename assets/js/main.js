// main.js — bootstrap. Reads profile.json, binds DOM, sets up Lenis,
// orchestrates the hero reveal, lazy-loads hero-graph when #hero is in view.

const ROOT = document.documentElement;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const isTouch = matchMedia("(any-pointer: coarse)").matches;
const isNarrow = matchMedia("(max-width: 767px)").matches;
const saveData = !!(navigator.connection && navigator.connection.saveData);

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
    setUptime(profile.careerStart);
    setInterval(() => setUptime(profile.careerStart), 60_000);
    setYear();
    initLenis();
    scheduleHeroReveal();
    initHeroGraphWhenVisible();
    initTrajectoryWhenVisible(profile);
    initStoriesWhenVisible();
    initBento(profile);
    wireScrollTo();
    initCursorAsync();
    auditConsole();
})();

async function initCursorAsync() {
    if (matchMedia("(any-pointer: coarse)").matches) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    try {
        const { initCursor } = await import("./cursor.js");
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

function initBento(profile) {
    const root = document.querySelector("[data-bento-root]");
    if (!root || !profile) return;

    populateStats(profile.stats || {});
    populateSkills(profile.skills || {});
    populateCerts(profile.certifications || []);

    const cards = root.querySelectorAll(".bento-card");
    if (!cards.length) return;

    const gsap = window.gsap;

    const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            if (gsap && !reduceMotion) {
                gsap.from(cards, { opacity: 0, y: 24, stagger: 0.08, duration: 0.55, ease: "power3.out" });
            }
            animateStats(profile.stats || {});
        }
    }, { rootMargin: "0px 0px -10% 0px" });
    io.observe(root);
}

const STAT_DEFS = [
    { key: "yearsExperience",         label: "Years experience",      suffix: "+" },
    { key: "microservicesArchitected", label: "Microservices",        suffix: "+" },
    { key: "techDebtReducedPct",      label: "Tech debt cut",         suffix: "%" },
    { key: "mttrImprovementX",        label: "MTTR improvement",      suffix: "x" },
    { key: "winRatePct",              label: "Pursuit win rate",      suffix: "%" },
    { key: "certifications",          label: "Certifications",        suffix: "" },
];

function populateStats(stats) {
    const list = document.querySelector("[data-stats]");
    if (!list) return;
    list.replaceChildren();
    for (const def of STAT_DEFS) {
        const value = stats[def.key];
        if (value == null) continue;
        const li = document.createElement("li");
        li.className = "stat";
        li.dataset.target = String(value);
        li.dataset.suffix = def.suffix;
        li.innerHTML = `
            <span class="stat-value" data-stat-value>0${def.suffix}</span>
            <span class="stat-label">${def.label}</span>
        `;
        list.appendChild(li);
    }
}

function animateStats(stats) {
    const items = document.querySelectorAll("[data-stats] .stat");
    const gsap = window.gsap;
    items.forEach((li) => {
        const target = Number(li.dataset.target || 0);
        const suffix = li.dataset.suffix || "";
        const valueEl = li.querySelector("[data-stat-value]");
        if (!valueEl) return;
        if (!gsap || reduceMotion) {
            valueEl.textContent = `${target}${suffix}`;
            return;
        }
        const obj = { v: 0 };
        gsap.to(obj, {
            v: target,
            duration: 1.4,
            ease: "power2.out",
            onUpdate() { valueEl.textContent = `${Math.round(obj.v)}${suffix}`; },
        });
    });
}

const SKILL_GROUP_LABELS = {
    agentic: "Agentic frameworks",
    llms: "LLMs & model garden",
    protocols: "AI protocols",
    rag: "RAG & vector data",
    cloud: "Cloud native",
    integration: "Integration & API",
    security: "Security",
    languages: "Languages & tools",
};

function populateSkills(skills) {
    const root = document.querySelector("[data-skills]");
    if (!root) return;
    root.replaceChildren();
    for (const key of Object.keys(SKILL_GROUP_LABELS)) {
        const items = skills[key];
        if (!Array.isArray(items) || items.length === 0) continue;
        const wrap = document.createElement("div");
        wrap.className = "skill-group";
        wrap.innerHTML = `<p class="skill-group-label">${SKILL_GROUP_LABELS[key]}</p>`;
        const ul = document.createElement("ul");
        ul.className = "skill-chips";
        for (const name of items) {
            const li = document.createElement("li");
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "skill-chip";
            btn.textContent = name;
            btn.addEventListener("click", () => {
                document.dispatchEvent(new CustomEvent("portfolio:highlight-skill", { detail: { label: name } }));
                document.dispatchEvent(new CustomEvent("portfolio:scroll-to", { detail: { anchor: "#graph" } }));
            });
            li.appendChild(btn);
            ul.appendChild(li);
        }
        wrap.appendChild(ul);
        root.appendChild(wrap);
    }
}

function populateCerts(certs) {
    const list = document.querySelector("[data-certs]");
    if (!list) return;
    list.replaceChildren();
    for (const c of certs) {
        const li = document.createElement("li");
        li.className = "cert-item";
        li.textContent = c.name + (c.issuer ? ` · ${c.issuer}` : "");
        list.appendChild(li);
    }
}

function initStoriesWhenVisible() {
    const root = document.querySelector("[data-stories-root]");
    if (!root) return;
    const io = new IntersectionObserver(async (entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            try {
                const [{ initStories }, data] = await Promise.all([
                    import("./stories.js"),
                    fetch("assets/js/data/stories.json").then(r => r.json()),
                ]);
                const inst = initStories(root, data);
                window.__stories = inst;
            } catch (err) {
                console.warn("[stories] failed to init", err);
            }
        }
    }, { rootMargin: "300px" });
    io.observe(root);
}

function initTrajectoryWhenVisible(profile) {
    const root = document.querySelector("#graph [data-trajectory-root]");
    if (!root) return;
    const io = new IntersectionObserver(async (entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            try {
                const { initTrajectory } = await import("./trajectory.js");
                const inst = initTrajectory(root, profile);
                window.__trajectory = inst;
            } catch (err) {
                console.warn("[trajectory] failed to init", err);
            }
        }
    }, { rootMargin: "300px" });
    io.observe(root);
}

function wireScrollTo() {
    document.addEventListener("portfolio:scroll-to", (e) => {
        const anchor = e.detail && e.detail.anchor;
        if (!anchor) return;
        const target = document.querySelector(anchor);
        if (!target) return;
        const lenis = window.__lenis;
        if (lenis && typeof lenis.scrollTo === "function") {
            lenis.scrollTo(target, { offset: -64, duration: 1.2 });
        } else {
            target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
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

/* ---------- uptime ticker ---------- */

function setUptime(careerStart) {
    if (!careerStart) return;
    const target = document.querySelector('[data-bind="uptime"]');
    if (!target) return;
    const [y, m] = careerStart.split("-").map(Number);
    const start = new Date(y, m - 1, 1);
    const now = new Date();
    let years = now.getFullYear() - start.getFullYear();
    let months = now.getMonth() - start.getMonth();
    if (months < 0) { years -= 1; months += 12; }
    target.textContent = months > 0 ? `${years}y ${months}m` : `${years}y`;
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

    document.querySelectorAll('a[href^="#"]').forEach(a => {
        a.addEventListener("click", (e) => {
            const id = a.getAttribute("href");
            if (id.length < 2) return;
            const target = document.querySelector(id);
            if (!target) return;
            e.preventDefault();
            lenis.scrollTo(target, { offset: -64, duration: 1.1 });
        });
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

    if (reduceMotion || isNarrow || saveData) {
        // fall back: no canvas, the .hero-fallback gradient stays visible
        canvas.remove();
        return;
    }

    const io = new IntersectionObserver(async (entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            try {
                const mod = await import("./hero-graph.js");
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
