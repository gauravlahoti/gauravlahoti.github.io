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

    profile.modelsLine = (profile.models || []).join(" · ");
    bindDOM(profile);
    setTitle(profile);
    setUptime(profile.careerStart);
    setInterval(() => setUptime(profile.careerStart), 60_000);
    setYear();
    initLenis();
    scheduleHeroReveal();
    initHeroGraphWhenVisible();
    initTerminalWhenVisible();
    wireFlare();
})();

function wireFlare() {
    const hero = document.getElementById("hero");
    if (!hero) return;
    document.addEventListener("portfolio:flare", () => {
        hero.classList.remove("is-flaring");
        // restart the CSS animation
        // eslint-disable-next-line no-unused-expressions
        void hero.offsetWidth;
        hero.classList.add("is-flaring");
        setTimeout(() => hero.classList.remove("is-flaring"), 800);
    });
}

/* ---------- data binding ---------- */

function bindDOM(profile) {
    document.querySelectorAll("[data-bind]").forEach(el => {
        const path = el.getAttribute("data-bind");
        const value = resolve(profile, path);
        if (typeof value === "string") el.textContent = value;
    });

    document.querySelectorAll("[data-bind-href]").forEach(el => {
        const raw = el.getAttribute("data-bind-href");
        const isMailto = raw.startsWith("mailto:");
        const path = isMailto ? raw.slice("mailto:".length) : raw;
        const value = resolve(profile, path);
        if (typeof value === "string") el.setAttribute("href", isMailto ? `mailto:${value}` : value);
    });
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

    // 0.0s — status line fade
    tl.fromTo(".hero-status", { opacity: 0, y: 8 }, { opacity: 0.85, y: 0, duration: 0.5 }, 0.0);

    // 0.7s — name scramble
    if (nameEl) {
        tl.add(scrambleName(nameEl), 0.7);
    }

    // 1.1s — role line fade
    tl.fromTo(".hero-role", { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.5 }, 1.1);

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

function initTerminalWhenVisible() {
    const root = document.querySelector("#terminal .terminal");
    if (!root) return;
    const io = new IntersectionObserver(async (entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.disconnect();
            try {
                const [{ initTerminal }, registry] = await Promise.all([
                    import("./terminal.js"),
                    fetch("assets/js/data/commands.json").then(r => r.json()),
                ]);
                const inst = initTerminal(root, registry);
                window.__terminal = inst;
            } catch (err) {
                console.warn("[terminal] failed to init", err);
            }
        }
    }, { rootMargin: "200px" });
    io.observe(root);
}

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
