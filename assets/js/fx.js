// fx.js: small shared helpers for the homepage's richer cards (spec 100).
// No dependencies. Everything here is a non-essential enhancement: the content
// it decorates is already readable without it.

export const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// A soft light that follows the pointer across a card. It only sets two CSS
// variables (--mx, --my); the glow itself is drawn in CSS. Skipped on touch.
export function attachSpotlight(container, cardSelector) {
    if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return () => {};
    let raf = 0;
    let last = null;
    const onMove = (e) => {
        const card = e.target.closest(cardSelector);
        if (!card) return;
        last = { card, x: e.clientX, y: e.clientY };
        if (raf) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            const r = last.card.getBoundingClientRect();
            last.card.style.setProperty("--mx", `${last.x - r.left}px`);
            last.card.style.setProperty("--my", `${last.y - r.top}px`);
        });
    };
    container.addEventListener("pointermove", onMove, { passive: true });
    return () => container.removeEventListener("pointermove", onMove);
}

// Calls `onSeen(el)` once, the first time each element is well inside the
// viewport. With reduced motion, or no IntersectionObserver, it fires straight
// away so nothing is ever left waiting in a hidden starting state.
export function whenSeen(els, onSeen, threshold = 0.35) {
    if (reduceMotion() || !("IntersectionObserver" in window)) {
        els.forEach((el) => onSeen(el));
        return () => {};
    }
    const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.unobserve(entry.target);
            onSeen(entry.target);
        }
    }, { threshold });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
}

// Counts a number up on the animation clock. `render(progress)` gets 0..1 and
// writes the text. `ease` is "out" (default) or "linear" (used for the real-time
// stopwatch). Returns a cancel function. Reduced motion jumps to the end.
export function runCount(render, durationMs, ease = "out") {
    if (reduceMotion()) { render(1); return () => {}; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now) => {
        const t = Math.min(1, (now - t0) / durationMs);
        render(ease === "linear" ? t : 1 - Math.pow(1 - t, 3));
        if (t < 1) raf = requestAnimationFrame(tick);
    };
    render(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
}
