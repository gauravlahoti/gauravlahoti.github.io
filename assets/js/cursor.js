// cursor.js — magnetic custom cursor (desktop only).
// Native cursor stays visible (a11y); this layer is purely decorative.
//
// Tag elements with `data-cursor="magnet"` to make the cursor attract
// to their center on hover.

export function initCursor(opts = {}) {
    const fine = matchMedia("(any-pointer: fine) and (hover: hover)").matches;
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reduceMotion) return { destroy() {} };

    const cursor = document.createElement("div");
    cursor.className = "cursor";
    cursor.setAttribute("aria-hidden", "true");
    cursor.innerHTML = `<span class="cursor-dot"></span><span class="cursor-ring"></span>`;
    document.body.appendChild(cursor);

    let mouseX = window.innerWidth / 2;
    let mouseY = window.innerHeight / 2;
    let curX = mouseX, curY = mouseY;
    let magnetTarget = null;
    let raf;

    function onMove(e) {
        mouseX = e.clientX;
        mouseY = e.clientY;
    }

    function findMagnet(x, y) {
        // Pick the nearest magnet element within radius if mouse is near.
        const magnets = document.querySelectorAll('[data-cursor="magnet"]');
        let best = null;
        let bestDist = 120 * 120; // 120px radius
        magnets.forEach(el => {
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const dx = x - cx, dy = y - cy;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestDist) {
                bestDist = d2;
                best = { el, cx, cy, w: r.width, h: r.height };
            }
        });
        return best;
    }

    function tick() {
        magnetTarget = findMagnet(mouseX, mouseY);
        let tx = mouseX, ty = mouseY;
        if (magnetTarget) {
            // Pull toward center of the magnet by 40%.
            tx = mouseX + (magnetTarget.cx - mouseX) * 0.4;
            ty = mouseY + (magnetTarget.cy - mouseY) * 0.4;
            cursor.classList.add("is-magnet");
        } else {
            cursor.classList.remove("is-magnet");
        }
        // Lerp the cursor toward target for smooth motion.
        curX += (tx - curX) * 0.22;
        curY += (ty - curY) * 0.22;
        cursor.style.transform = `translate(${curX}px, ${curY}px)`;
        raf = requestAnimationFrame(tick);
    }

    function onLeave() {
        cursor.classList.add("is-hidden");
    }
    function onEnter() {
        cursor.classList.remove("is-hidden");
    }

    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    document.addEventListener("mouseenter", onEnter);
    raf = requestAnimationFrame(tick);

    return {
        destroy() {
            cancelAnimationFrame(raf);
            window.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseleave", onLeave);
            document.removeEventListener("mouseenter", onEnter);
            cursor.remove();
        },
    };
}
