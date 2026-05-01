// stories.js — scroll-driven case studies. Renders 2 stories from
// stories.json into a sticky two-column layout with GSAP-scrub beat morph.
//
// Contract: initStories(root, data, opts) → { destroy() }
// opts.featured = ['id1', 'id2']  → pick which stories to feature

const FEATURED_DEFAULT = ["fiber-broadband-fabric", "ssd-lead-to-cash"];

export function initStories(root, data, opts = {}) {
    if (!root || !data || !Array.isArray(data.stories)) return { destroy() {} };

    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isNarrow = matchMedia("(max-width: 767px)").matches;
    const featured = opts.featured || FEATURED_DEFAULT;
    const stories = featured
        .map(id => data.stories.find(s => s.id === id))
        .filter(Boolean);

    root.replaceChildren();

    const articles = stories.map(story => renderStory(story));
    articles.forEach(a => root.appendChild(a.el));

    const triggers = [];
    const gsap = window.gsap;
    const ScrollTrigger = window.ScrollTrigger;

    if (gsap && ScrollTrigger && !reduceMotion && !isNarrow) {
        gsap.registerPlugin(ScrollTrigger);
        articles.forEach(a => triggers.push(...wireScrub(a, gsap, ScrollTrigger)));
        // Refresh after fonts settle (avoid pin offset drift)
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => ScrollTrigger.refresh());
        }
    } else {
        // Reduced motion / mobile: show all beats inline
        articles.forEach(a => a.el.classList.add("is-static"));
    }

    return {
        destroy() {
            triggers.forEach(t => { try { t.kill(); } catch (_) {} });
            root.replaceChildren();
        },
    };
}

/* ---------- per-story render ---------- */

function renderStory(story) {
    const el = document.createElement("article");
    el.className = "story";
    el.id = `story-${story.id}`;
    el.setAttribute("aria-label", story.title);

    const left = document.createElement("div");
    left.className = "story-left";
    left.innerHTML = `
        <p class="story-eyebrow">${escapeHtml(story.client || "")}${story.period ? ` · ${escapeHtml(story.period)}` : ""}</p>
        <h3 class="story-title">${escapeHtml(story.title)}</h3>
        <p class="story-problem">${escapeHtml(story.problem || "")}</p>
        <p class="story-role mono"><span class="kw">role</span> ${escapeHtml(story.role || "")}</p>
        <ul class="story-stack" aria-label="Stack">
            ${(story.stack || []).map(s => `<li class="stack-chip">${escapeHtml(s)}</li>`).join("")}
        </ul>
    `;

    const right = document.createElement("div");
    right.className = "story-right";

    const beats = (story.beats || []).map((beat, i) => {
        const beatEl = document.createElement("div");
        beatEl.className = "story-beat";
        beatEl.dataset.beat = String(i);
        beatEl.innerHTML = `
            <p class="beat-step">// beat ${i + 1} of ${story.beats.length}</p>
            <h4 class="beat-title">${escapeHtml(beat.title)}</h4>
            <p class="beat-body">${escapeHtml(beat.body || "")}</p>
            ${renderVisual(beat.visual)}
        `;
        right.appendChild(beatEl);
        return beatEl;
    });

    el.appendChild(left);
    el.appendChild(right);

    return { el, left, right, beats };
}

function renderVisual(v) {
    if (!v) return "";
    if (v.type === "code") {
        return `<pre class="beat-visual beat-code"><code>${escapeHtml(v.body || "")}</code></pre>`;
    }
    if (v.type === "image") {
        const src = v.src ? escapeHtml(v.src) : "";
        const alt = v.alt ? escapeHtml(v.alt) : "";
        return `<figure class="beat-visual beat-image"><img src="${src}" alt="${alt}" loading="lazy" decoding="async"></figure>`;
    }
    if (v.type === "svg" && v.body) {
        return `<div class="beat-visual beat-svg">${v.body}</div>`;
    }
    if (v.type === "iframe" && v.src) {
        return `<div class="beat-visual beat-iframe"><iframe src="${escapeHtml(v.src)}" loading="lazy"></iframe></div>`;
    }
    return "";
}

/* ---------- ScrollTrigger pin + scrub ---------- */

function wireScrub(article, gsap, ScrollTrigger) {
    const { el, left, beats } = article;
    if (beats.length === 0) return [];

    const total = beats.length;
    // Each beat gets ~80vh of scroll. Total scroll for the story = total * 80vh.
    const scrollLen = total * 80;

    // Initial state: only first beat visible.
    beats.forEach((b, i) => {
        gsap.set(b, { opacity: i === 0 ? 1 : 0, y: i === 0 ? 0 : 20 });
    });

    const triggers = [];

    // Pin the article for the duration.
    const pinTrigger = ScrollTrigger.create({
        trigger: el,
        start: "top top+=64",
        end: () => `+=${scrollLen}vh`,
        pin: left,
        pinSpacing: true,
        anticipatePin: 1,
    });
    triggers.push(pinTrigger);

    // Scrub through beats in the right column.
    const tl = gsap.timeline({
        scrollTrigger: {
            trigger: el,
            start: "top top+=64",
            end: () => `+=${scrollLen}vh`,
            scrub: 0.5,
        },
    });
    if (tl.scrollTrigger) triggers.push(tl.scrollTrigger);

    // Build a step for each transition.
    for (let i = 1; i < total; i++) {
        const prev = beats[i - 1];
        const curr = beats[i];
        tl.to(prev, { opacity: 0, y: -20, duration: 0.5 }, ">-0.1");
        tl.fromTo(curr, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.5 }, "<");
    }

    return triggers;
}

/* ---------- helper ---------- */

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
