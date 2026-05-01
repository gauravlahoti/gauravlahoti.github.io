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
    cursor.innerHTML = `
        <span class="cursor-corner cursor-corner-tl"></span>
        <span class="cursor-corner cursor-corner-tr"></span>
        <span class="cursor-corner cursor-corner-bl"></span>
        <span class="cursor-corner cursor-corner-br"></span>
    `;
    document.body.appendChild(cursor);

    const IDLE_SIZE = 28;
    let mouseX = window.innerWidth / 2;
    let mouseY = window.innerHeight / 2;
    let curX = mouseX - IDLE_SIZE / 2, curY = mouseY - IDLE_SIZE / 2;
    let curW = IDLE_SIZE, curH = IDLE_SIZE;
    let raf;

    function onMove(e) {
        mouseX = e.clientX;
        mouseY = e.clientY;
    }

    function findMagnet(x, y) {
        // Snap to the magnet element whose bounding box is closest to the cursor
        // (using distance to the nearest edge of each rect, capped at 120px).
        const magnets = document.querySelectorAll('[data-cursor="magnet"]');
        let best = null;
        let bestDist = 120 * 120;
        magnets.forEach(el => {
            const r = el.getBoundingClientRect();
            const nx = Math.max(r.left, Math.min(x, r.right));
            const ny = Math.max(r.top, Math.min(y, r.bottom));
            const dx = x - nx, dy = y - ny;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestDist) {
                bestDist = d2;
                best = { el, rect: r };
            }
        });
        return best;
    }

    function tick() {
        const magnet = findMagnet(mouseX, mouseY);
        let targetX, targetY, targetW, targetH;
        if (magnet) {
            // Snap brackets to the magnet element's bounding box.
            cursor.classList.add("is-magnet");
            const pad = 6;
            targetX = magnet.rect.left - pad;
            targetY = magnet.rect.top - pad;
            targetW = magnet.rect.width + pad * 2;
            targetH = magnet.rect.height + pad * 2;
        } else {
            // Idle: small reticle centered on the cursor.
            cursor.classList.remove("is-magnet");
            targetX = mouseX - IDLE_SIZE / 2;
            targetY = mouseY - IDLE_SIZE / 2;
            targetW = IDLE_SIZE;
            targetH = IDLE_SIZE;
        }
        const lerp = 0.22;
        curX += (targetX - curX) * lerp;
        curY += (targetY - curY) * lerp;
        curW += (targetW - curW) * lerp;
        curH += (targetH - curH) * lerp;
        cursor.style.transform = `translate(${curX}px, ${curY}px)`;
        cursor.style.width = `${curW}px`;
        cursor.style.height = `${curH}px`;
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
