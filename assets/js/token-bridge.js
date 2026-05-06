// token-bridge.js — kinetic-typography scroll moment between hero and career.
// Source tagline disassembles into glowing accent glyphs that scatter
// downward like A2A data packets, then reassembles as "TRAJECTORY" right
// above the career rail.
//
// Contract: initTokenBridge(section) → { destroy }

const TARGET_WORD = "TRAJECTORY";

export function initTokenBridge(section) {
    if (!section) return { destroy() {} };

    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isMobile = matchMedia("(max-width: 767px)").matches;
    const gsap = window.gsap;
    const ScrollTrigger = window.ScrollTrigger;

    const sourceEl = section.querySelector("[data-token-source]");
    const targetEl = section.querySelector("[data-token-target]");
    const fallbackEl = section.querySelector(".token-bridge-fallback");

    const showFallback = () => {
        if (sourceEl) sourceEl.setAttribute("hidden", "");
        if (targetEl) targetEl.setAttribute("hidden", "");
        if (fallbackEl) fallbackEl.removeAttribute("hidden");
        section.setAttribute("data-mode", "fallback");
    };

    if (!sourceEl || !targetEl) return { destroy() {} };

    // Hard-fallback path: no GSAP / ScrollTrigger, or reduced-motion. Every
    // viewport that has motion enabled gets either the desktop scrub or the
    // mobile fade-in — narrow phones still get the assembling word.
    if (!gsap || !ScrollTrigger || reduceMotion) {
        showFallback();
        return { destroy() {} };
    }

    const sourceText = (sourceEl.textContent || "").trim();
    if (!sourceText) {
        showFallback();
        return { destroy() {} };
    }

    // ---- split source into glyph spans (preserve whitespace) -----------
    sourceEl.textContent = "";
    const glyphs = [];
    [...sourceText].forEach((ch) => {
        if (ch === " ") {
            sourceEl.appendChild(document.createTextNode(" "));
            return;
        }
        const span = document.createElement("span");
        span.className = "token-bridge-glyph";
        span.textContent = ch;
        sourceEl.appendChild(span);
        glyphs.push(span);
    });

    // ---- split target word into per-letter spans -----------------------
    const targetText = (targetEl.textContent || TARGET_WORD).trim() || TARGET_WORD;
    targetEl.textContent = "";
    const letters = [];
    [...targetText].forEach((ch) => {
        const span = document.createElement("span");
        span.className = "token-bridge-target-letter";
        span.textContent = ch;
        targetEl.appendChild(span);
        letters.push(span);
    });

    // Mobile path: skip scrub, run a single onEnter tween. Source text is
    // hidden by CSS on this breakpoint; only the target assembles.
    if (isMobile) {
        gsap.set(letters, { opacity: 0, y: 18, filter: "blur(6px)" });
        const io = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                io.disconnect();
                gsap.to(letters, {
                    opacity: 1,
                    y: 0,
                    filter: "blur(0px)",
                    duration: 0.7,
                    stagger: 0.05,
                    ease: "power3.out",
                });
            }
        }, { rootMargin: "0px 0px -10% 0px" });
        io.observe(section);
        return {
            destroy() {
                try { io.disconnect(); } catch (_) {}
                sourceEl.textContent = sourceText;
                targetEl.textContent = targetText;
            },
        };
    }

    // ---- desktop / tablet path: scroll-scrubbed timeline ---------------
    gsap.registerPlugin(ScrollTrigger);

    // Pre-compute deterministic scatter offsets so each glyph follows a
    // stable curved path (no per-frame randomness, no jank).
    const scatter = glyphs.map((_, i) => {
        const seed = (i * 9301 + 49297) % 233280;
        const r = seed / 233280; // 0..1
        return {
            x: (r - 0.5) * 80,                 // ±40 px lateral drift
            y: 60 + r * 140,                   // 60..200 px downward travel
            rot: (r - 0.5) * 24,               // small rotation for flight feel
            delay: r * 0.25,                   // 0..0.25 s per-glyph delay
        };
    });

    gsap.set(glyphs, { opacity: 1, x: 0, y: 0, rotate: 0 });
    gsap.set(letters, { opacity: 0, y: 18, filter: "blur(6px)" });

    const tl = gsap.timeline({ paused: true });

    // 0.00–0.55: source glyphs flip to accent and fly downward.
    glyphs.forEach((g, i) => {
        const s = scatter[i];
        tl.to(g, {
            opacity: 0,
            x: s.x,
            y: s.y,
            rotate: s.rot,
            ease: "power2.in",
            duration: 0.45,
            onStart() { g.classList.add("is-token"); },
        }, s.delay * 0.4);
    });

    // 0.45–1.00: target word assembles letter by letter.
    tl.to(letters, {
        opacity: 1,
        y: 0,
        filter: "blur(0px)",
        duration: 0.55,
        stagger: 0.04,
        ease: "power3.out",
    }, 0.5);

    const trigger = ScrollTrigger.create({
        trigger: section,
        start: "top 80%",
        end: "bottom 30%",
        scrub: 0.5,
        onUpdate(self) {
            tl.progress(self.progress);
        },
    });

    // Layout-settling refresh, mirroring trajectory.js — fonts + lazy
    // sections shift the bridge's start/end measurements.
    const refresh = () => { try { ScrollTrigger.refresh(); } catch (_) {} };
    requestAnimationFrame(() => requestAnimationFrame(refresh));
    if (document.readyState !== "complete") {
        window.addEventListener("load", refresh, { once: true });
    }

    let resizeObserver;
    if (typeof ResizeObserver === "function") {
        let raf = 0;
        resizeObserver = new ResizeObserver(() => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(refresh);
        });
        resizeObserver.observe(section);
    }

    return {
        destroy() {
            try { trigger.kill(); } catch (_) {}
            try { tl.kill(); } catch (_) {}
            try { resizeObserver && resizeObserver.disconnect(); } catch (_) {}
            sourceEl.textContent = sourceText;
            targetEl.textContent = targetText;
        },
    };
}
