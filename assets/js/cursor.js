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
    let raf = 0;

    // Cache the most recent hit-test so we can skip elementFromPoint while
    // the lerp is still catching up but nothing else has moved.
    let lastTestX = NaN, lastTestY = NaN;
    let cachedMagnet = null;
    let needsHitTest = true;

    function onMove(e) {
        mouseX = e.clientX;
        mouseY = e.clientY;
        needsHitTest = true;
        ensureRunning();
    }

    // The element under the (stationary) cursor changes during scroll, so
    // a wheel tick must retarget the brackets even if the mouse didn't move.
    function onScroll() {
        needsHitTest = true;
        ensureRunning();
    }

    function findMagnet(x, y) {
        // Use the browser's hit-testing via elementFromPoint instead of
        // walking all `[data-cursor="magnet"]` rects. The previous approach
        // matched on bounding-rect proximity, which would snap onto magnet
        // elements inside *hidden* containers — e.g., the Insights nav
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
        return { el: magnet };
    }

    function tick() {
        raf = 0;

        // Re-hit-test only when the cursor's screen position changed or a
        // scroll moved the layout under it. Saves a per-frame
        // elementFromPoint call (which is significantly slower on Windows
        // than on macOS) when the user is just reading or settling.
        if (needsHitTest || mouseX !== lastTestX || mouseY !== lastTestY) {
            cachedMagnet = findMagnet(mouseX, mouseY);
            lastTestX = mouseX;
            lastTestY = mouseY;
            needsHitTest = false;
        }

        let targetX, targetY, targetW, targetH;
        if (cachedMagnet) {
            cursor.classList.add("is-magnet");
            // Re-read rect each frame so the brackets follow the magnet
            // element if it moves (e.g., a card animating in).
            const rect = cachedMagnet.el.getBoundingClientRect();
            const pad = 6;
            targetX = rect.left - pad;
            targetY = rect.top - pad;
            targetW = rect.width + pad * 2;
            targetH = rect.height + pad * 2;
        } else {
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

        // Stop the loop once the lerp has settled. The next mousemove or
        // scroll restarts it via ensureRunning(). Avoids burning a 60 Hz
        // rAF + style-write budget while the user is reading.
        const settled =
            Math.abs(targetX - curX) < 0.1 &&
            Math.abs(targetY - curY) < 0.1 &&
            Math.abs(targetW - curW) < 0.1 &&
            Math.abs(targetH - curH) < 0.1;
        if (settled) {
            // Snap to exact target so the final visual matches the math.
            curX = targetX; curY = targetY; curW = targetW; curH = targetH;
            cursor.style.transform = `translate(${curX}px, ${curY}px)`;
            cursor.style.width = `${curW}px`;
            cursor.style.height = `${curH}px`;
            return;
        }
        raf = requestAnimationFrame(tick);
    }

    function ensureRunning() {
        if (raf || document.hidden) return;
        raf = requestAnimationFrame(tick);
    }

    function stop() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
    }

    function onVisibility() {
        if (document.hidden) stop();
        else ensureRunning();
    }

    function onLeave() {
        cursor.classList.add("is-hidden");
    }
    function onEnter() {
        cursor.classList.remove("is-hidden");
        ensureRunning();
    }

    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    document.addEventListener("mouseenter", onEnter);
    document.addEventListener("visibilitychange", onVisibility);
    ensureRunning();

    return {
        destroy() {
            stop();
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("scroll", onScroll);
            document.removeEventListener("mouseleave", onLeave);
            document.removeEventListener("mouseenter", onEnter);
            document.removeEventListener("visibilitychange", onVisibility);
            cursor.remove();
        },
    };
}
