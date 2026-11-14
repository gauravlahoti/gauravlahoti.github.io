// announcement.js — top-of-page announcement bar (spec: langchain-inspired polish).
//
// Reads content/announcement.json and shows one slim bar above the nav for
// `durationDays` (default 7) from `startsOn`, then renders nothing. The markup
// is injected here so it is not copied into every page that duplicates the nav.
// The fixed nav sits at `top: var(--banner-h)`; this script keeps that variable
// equal to the part of the bar still on screen, so the nav slides up as the bar
// scrolls away and never overlaps it.

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

async function boot() {
    let a;
    try {
        const res = await fetch("/content/announcement.json", { cache: "no-cache" });
        if (!res.ok) return;
        a = await res.json();
    } catch { return; }
    if (!isLive(a, Date.now()) || dismissed(a.id)) return;

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
