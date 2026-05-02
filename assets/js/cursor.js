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
        // Use the browser's hit-testing via elementFromPoint instead of
        // walking all `[data-cursor="magnet"]` rects. The previous approach
        // matched on bounding-rect proximity, which would snap onto magnet
        // elements inside *hidden* containers — e.g., the Perspectives nav
        // flyout (`visibility: hidden; pointer-events: none`) and the
        // mobile drawer (`transform: translateX(100%)`) both leave their
        // children with valid layout rects, producing phantom brackets in
        // the hero area when the cursor merely passed near where the
        // (invisible) flyout would render.
        // elementFromPoint respects visibility, opacity, pointer-events,
        // and transforms — exactly the same rules the browser uses for
        // click hit-testing — so the cursor only snaps to magnets that
        // are actually reachable.
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        const magnet = el.closest('[data-cursor="magnet"]');
        if (!magnet) return null;
        return { el: magnet, rect: magnet.getBoundingClientRect() };
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
