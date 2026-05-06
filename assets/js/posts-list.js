// posts-list.js — Writing section (LinkedIn posts feed) + nav flyout.
// Exports: initPostsList(root)   → flat-link rows in #perspectives (all posts)
//          initPostsFlyout(root) → top FLYOUT_LIMIT posts in nav dropdown
// Both surfaces sort by date descending so adding a newer post via
// /add-post automatically rises to the top of the flyout — no need to
// hand-order posts.json.
// All text rendered via textContent (treat OG-scraped strings as untrusted).

const FLYOUT_LIMIT = 3;

let postsPromise = null;

// Memoized fetch — both surfaces share one HTTP roundtrip.
// `no-cache` makes the browser revalidate so re-running add-post.mjs shows
// up immediately on reload (Python's http.server doesn't set Cache-Control).
function getPosts() {
    if (!postsPromise) {
        postsPromise = fetch("assets/js/data/posts.json", { cache: "no-cache" })
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(arr => Array.isArray(arr) ? sortNewestFirst(arr) : []);
    }
    return postsPromise;
}

// ISO `YYYY-MM-DD` strings sort lexicographically the same as
// chronologically, so `localeCompare` with reversed args gives newest-first.
// Entries without a date sort to the bottom.
function sortNewestFirst(posts) {
    return [...posts].sort((a, b) => {
        const da = (a && a.date) || "";
        const db = (b && b.date) || "";
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return db.localeCompare(da);
    });
}

export async function initPostsList(root) {
    if (!root) return { destroy() {} };

    let posts;
    try {
        posts = await getPosts();
    } catch (err) {
        console.warn("[posts] failed to load posts.json", err);
        return { destroy() {} };
    }

    if (!Array.isArray(posts) || posts.length === 0) {
        return { destroy() {} };
    }

    const frag = document.createDocumentFragment();
    const allRows = [];
    for (const post of posts) {
        const node = renderPost(post);
        if (node) {
            const tags = Array.isArray(post.tags) ? post.tags : (post.tag ? [post.tag] : []);
            node.dataset.tags = tags.join(" ");
            frag.appendChild(node);
            allRows.push(node);
        }
    }
    root.replaceChildren(frag);
    buildFilterBar(root, allRows);

    return {
        destroy() {
            const bar = root.parentElement && root.parentElement.querySelector(".post-filter-bar");
            if (bar) bar.remove();
            root.replaceChildren();
        },
    };
}

export async function initPostsFlyout(root) {
    if (!root) return { destroy() {} };

    let posts;
    try {
        posts = await getPosts();
    } catch (err) {
        console.warn("[posts-flyout] failed to load posts.json", err);
        return { destroy() {} };
    }

    if (!Array.isArray(posts) || posts.length === 0) {
        return { destroy() {} };
    }

    const top = posts.slice(0, FLYOUT_LIMIT);
    const remaining = Math.max(0, posts.length - top.length);

    const list = document.createElement("ul");
    list.className = "nav-flyout-list";
    list.setAttribute("role", "none");
    for (const post of top) {
        const item = renderFlyoutItem(post);
        if (item) list.appendChild(item);
    }

    const foot = document.createElement("a");
    foot.className = "nav-flyout-foot";
    foot.href = "#perspectives";
    foot.setAttribute("role", "menuitem");
    foot.dataset.cursor = "magnet";
    foot.textContent = remaining > 0
        ? `View all perspectives (+${remaining}) →`
        : "View all perspectives →";

    root.replaceChildren(list, foot);
    root.removeAttribute("hidden");

    return {
        destroy() {
            root.replaceChildren();
            root.setAttribute("hidden", "");
        },
    };
}

function renderFlyoutItem(post) {
    if (!post || typeof post.url !== "string" || typeof post.firstLine !== "string") {
        return null;
    }
    const li = document.createElement("li");
    li.setAttribute("role", "none");
    const a = document.createElement("a");
    a.className = "nav-flyout-link";
    a.href = post.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("role", "menuitem");
    a.dataset.cursor = "magnet";
    a.title = post.firstLine;

    // Title goes in its own span so flex + ellipsis truncate it cleanly while
    // an arrow indicator sits on the right (added via CSS ::after).
    const title = document.createElement("span");
    title.className = "nav-flyout-link-title";
    title.textContent = post.firstLine;
    a.appendChild(title);

    li.appendChild(a);
    return li;
}

function buildFilterBar(root, rows) {
    const freq = new Map();
    for (const row of rows) {
        for (const t of (row.dataset.tags || "").split(" ").filter(Boolean)) {
            freq.set(t, (freq.get(t) || 0) + 1);
        }
    }

    const chips = [...freq.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([tag]) => tag);

    if (chips.length === 0) return;

    let activeTag = null;

    const bar = document.createElement("div");
    bar.className = "post-filter-bar";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Filter posts by topic");

    const applyFilter = (tag) => {
        activeTag = tag;
        for (const btn of bar.querySelectorAll(".post-filter-chip")) {
            const isActive = btn.dataset.filterTag === (tag || "");
            btn.setAttribute("aria-pressed", String(isActive));
            btn.classList.toggle("is-active", isActive);
        }
        for (const row of rows) {
            if (!tag) {
                row.style.display = "";
            } else {
                row.style.display = row.dataset.tags.split(" ").includes(tag) ? "" : "none";
            }
        }
    };

    const makeChip = (label, tag) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "post-filter-chip";
        btn.textContent = label;
        btn.dataset.filterTag = tag;
        btn.setAttribute("aria-pressed", tag === "" ? "true" : "false");
        if (tag === "") btn.classList.add("is-active");
        btn.addEventListener("click", () => applyFilter(activeTag === tag ? null : tag || null));
        return btn;
    };

    bar.appendChild(makeChip("All", ""));
    for (const tag of chips) bar.appendChild(makeChip(`#${tag}`, tag));

    root.before(bar);
}

function renderPost(post) {
    if (!post || typeof post.url !== "string" || typeof post.firstLine !== "string") {
        return null;
    }

    const a = document.createElement("a");
    a.className = "post-row";
    a.href = post.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.dataset.cursor = "magnet";
    const titleEl = document.createElement("span");
    titleEl.className = "post-row-title";
    titleEl.textContent = post.firstLine;
    a.appendChild(titleEl);

    const preview = document.createElement("span");
    preview.className = "post-row-preview";
    preview.textContent = post.excerpt ? withEllipsis(post.excerpt) : "";
    a.appendChild(preview);

    const foot = document.createElement("span");
    foot.className = "post-row-foot";

    if (post.date) {
        const time = document.createElement("time");
        time.className = "post-row-date";
        time.dateTime = post.date;
        time.textContent = formatDate(post.date);
        foot.appendChild(time);
    }

    const tags = Array.isArray(post.tags) ? post.tags : (post.tag ? [post.tag] : []);
    if (tags.length) {
        const tagsEl = document.createElement("span");
        tagsEl.className = "post-row-tags";
        for (const t of tags) {
            const span = document.createElement("span");
            span.className = "post-row-tag";
            span.textContent = `#${t}`;
            tagsEl.appendChild(span);
        }
        foot.appendChild(tagsEl);
    }

    a.appendChild(foot);

    const arrow = document.createElement("span");
    arrow.className = "post-row-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "↗";
    a.appendChild(arrow);

    return a;
}

function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

// LinkedIn's og:description hard-truncates at ~500 chars, so excerpts
// almost always end mid-sentence. Append a single ellipsis so the cut-off
// reads as intentional and signals "more on LinkedIn ↗" — no JSON
// migration needed.
function withEllipsis(s) {
    const t = (s || "").trimEnd();
    if (!t) return t;
    if (t.endsWith("…") || t.endsWith("...")) return t;
    return t + "…";
}
