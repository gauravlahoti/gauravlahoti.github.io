// announcement.js — top-of-page announcement bar (spec: langchain-inspired polish).
//
// Reads content/announcement.json and shows one slim bar above the nav for
// `durationDays` (default 7) from `startsOn`, then renders nothing. The markup
// is injected here so it is not copied into every page that duplicates the nav.
// The nav pill is absolutely positioned at `top: var(--banner-full)`, just under the
// bar, and scrolls away with it. --banner-h (the part of the bar still on screen) is
// no longer read by the nav; it is kept in step here in case something else wants it.

const DAY = 86400000;

function dismissed(id) {
    try { return localStorage.getItem("ann-dismissed") === id; } catch { return false; }
}
function remember(id) {
    try { localStorage.setItem("ann-dismissed", id); } catch { /* private mode */ }
}

function isLive(a, now) {
    if (!a || !a.text || !a.href || !a.startsOn) return false;
    const start = Date.parse(a.startsOn + "T00:00:00");
    if (Number.isNaN(start)) return false;
    const end = start + (Number(a.durationDays) || 7) * DAY;
    return now >= start && now < end;
}

// announce-hint.js adds "ann-pending" to <html> before first paint when it expects a
// bar, and base.css holds the bar's space while it is there. Every path out of boot()
// has to drop it: either the real bar replaces the held space (below, in the same
// task as the insert, so nothing shifts) or there is no bar after all.
function clearPending() {
    document.documentElement.classList.remove("ann-pending");
}

async function boot() {
    let a;
    try {
        const res = await fetch("/content/announcement.json", { cache: "no-cache" });
        if (!res.ok) { clearPending(); return; }
        a = await res.json();
    } catch { clearPending(); return; }
    if (!isLive(a, Date.now()) || dismissed(a.id)) { clearPending(); return; }

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/css/announcement.css?v=8";
    document.head.appendChild(link);
    await new Promise((r) => { link.onload = link.onerror = r; });

    const bar = document.createElement("div");
    bar.className = "announce";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Announcement");

    // The sentence and the CTA both link to the same place, so either click works.
    const external = /^https?:/.test(a.href);
    const text = document.createElement("a");
    text.className = "announce-text";
    text.href = a.href;
    if (external) { text.target = "_blank"; text.rel = "noopener noreferrer"; }
    text.textContent = a.text;

    const sep = document.createElement("span");
    sep.className = "announce-sep";
    sep.setAttribute("aria-hidden", "true");

    const cta = document.createElement("a");
    cta.className = "announce-cta";
    cta.href = a.href;
    if (external) { cta.target = "_blank"; cta.rel = "noopener noreferrer"; }
    // Label shows on laptops; on phones only the arrow stays, as a round tap target.
    const label = document.createElement("span");
    label.className = "announce-cta-label";
    label.textContent = (a.cta || "Learn more") + " ";
    const arrow = document.createElement("span");
    arrow.className = "announce-cta-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "↗";
    cta.setAttribute("aria-label", a.cta || "Learn more");
    cta.append(label, arrow);

    const close = document.createElement("button");
    close.className = "announce-close";
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss announcement");
    close.textContent = "×";

    bar.append(text, sep, cta, close);
    document.body.prepend(bar);
    clearPending(); // same task as the insert: the bar takes over the held space

    const root = document.documentElement;
    let raf = 0;
    const sync = () => {
        raf = 0;
        root.style.setProperty("--banner-full", bar.offsetHeight + "px");
        const visible = Math.max(0, bar.offsetHeight - window.scrollY);
        root.style.setProperty("--banner-h", visible + "px");
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(sync); };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    sync();

    close.addEventListener("click", () => {
        remember(a.id);
        bar.remove();
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onScroll);
        root.style.removeProperty("--banner-h");
        root.style.removeProperty("--banner-full");
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
    boot();
}
