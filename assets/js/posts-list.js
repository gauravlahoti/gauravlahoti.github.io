// posts-list.js — Writing section (LinkedIn posts feed) + nav flyout.
// Exports: initPostsList(root, opts) → flat-link rows in #perspectives (all posts)
//          initPostsFlyout(root)     → top FLYOUT_LIMIT posts in nav dropdown
// Both surfaces sort by date descending so adding a newer post via
// /add-post automatically rises to the top of the flyout — no need to
// hand-order posts.json.
// All text rendered via textContent (treat OG-scraped strings as untrusted).

const FLYOUT_LIMIT = 3;

// Compact formatter for engagement counts: 1234 → "1.2K"
const _compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

let postsPromise = null;
let metricsPromise = null;

function getPosts() {
    if (!postsPromise) {
        postsPromise = fetch("content/posts.json", { cache: "no-cache" })
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(arr => Array.isArray(arr) ? sortNewestFirst(arr) : []);
    }
    return postsPromise;
}

function getMetrics(metricsApi) {
    if (!metricsApi) return Promise.resolve({});
    if (!metricsPromise) {
        metricsPromise = fetch(metricsApi, { cache: "no-cache" })
            .then(r => r.ok ? r.json() : { metrics: {} })
            .then(data => (data && typeof data.metrics === "object" ? data.metrics : {}))
            .catch(() => ({}));
    }
    return metricsPromise;
}

function deriveActivityId(url) {
    if (typeof url !== "string") return null;
    const clean = url.split("?")[0].split("#")[0];
    const m = clean.match(/-(share|ugcPost|activity)-(\d{15,21})(?:-[A-Za-z0-9_]+)?\/?$/i)
           || clean.match(/-(share|ugcPost|activity)-(\d{15,21})/i)
           || clean.match(/urn:li:(?:share|ugcPost|activity):(\d{15,21})/i);
    if (!m) return null;
    return m[2] || m[1] || null;
}

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

export async function initPostsList(root, opts = {}) {
    if (!root) return { destroy() {} };

    let posts, metricsMap;
    try {
        [posts, metricsMap] = await Promise.all([
            getPosts(),
            getMetrics(opts?.metricsApi),
        ]);
    } catch (err) {
        console.warn("[posts] failed to load posts.json", err);
        return { destroy() {} };
    }

    if (!Array.isArray(posts) || posts.length === 0) {
        return { destroy() {} };
    }

    if (metricsMap && typeof metricsMap === "object") {
        for (const post of posts) {
            const id = deriveActivityId(post.url);
            if (id && metricsMap[id]) post.metrics = metricsMap[id];
        }
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
    buildSearchAndFilter(root, allRows, posts.length);

    return {
        destroy() {
            const outer = root.parentElement && root.parentElement.querySelector(".post-search-outer");
            if (outer) outer.remove();
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
        ? `View all insights (+${remaining}) →`
        : "View all insights →";

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

    const title = document.createElement("span");
    title.className = "nav-flyout-link-title";
    title.textContent = post.firstLine;
    a.appendChild(title);

    li.appendChild(a);
    return li;
}

// ─── Search + Filter bar ────────────────────────────────────────────────────

function buildSearchAndFilter(root, allRows, totalCount) {
    // Build tag frequency map
    const freq = new Map();
    for (const row of allRows) {
        for (const t of (row.dataset.tags || "").split(" ").filter(Boolean)) {
            freq.set(t, (freq.get(t) || 0) + 1);
        }
    }
    const chips = [...freq.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([tag]) => tag);

    let activeTag = null;
    let activeQuery = "";
    let emptyState = null;

    // ── outer wrapper ──────────────────────────────────────────────────
    const outer = document.createElement("div");
    outer.className = "post-search-outer";

    // ── search row ────────────────────────────────────────────────────
    const searchWrap = document.createElement("div");
    searchWrap.className = "post-search-wrap";
    searchWrap.setAttribute("role", "search");

    const prefix = document.createElement("span");
    prefix.className = "post-search-prefix";
    prefix.setAttribute("aria-hidden", "true");
    prefix.textContent = "~/search";

    const sep = document.createElement("span");
    sep.className = "post-search-sep";
    sep.setAttribute("aria-hidden", "true");
    sep.textContent = "$";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "post-search-input";
    input.placeholder = "search posts...";
    input.setAttribute("aria-label", "Search posts by title or content");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");

    const kbdHint = document.createElement("kbd");
    kbdHint.className = "post-search-kbd";
    kbdHint.setAttribute("aria-label", "Press / to search");
    kbdHint.textContent = "/";

    const countEl = document.createElement("span");
    countEl.className = "post-search-count";
    countEl.setAttribute("aria-live", "polite");
    countEl.setAttribute("aria-atomic", "true");

    searchWrap.append(prefix, sep, input, kbdHint, countEl);

    // ── filter chips row ──────────────────────────────────────────────
    let filterBar = null;
    if (chips.length > 0) {
        filterBar = document.createElement("div");
        filterBar.className = "post-filter-bar";
        filterBar.setAttribute("role", "group");
        filterBar.setAttribute("aria-label", "Filter posts by topic");

        const makeChip = (label, tag) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "post-filter-chip";
            btn.textContent = label;
            btn.dataset.filterTag = tag;
            btn.setAttribute("aria-pressed", tag === "" ? "true" : "false");
            if (tag === "") btn.classList.add("is-active");
            btn.addEventListener("click", () => {
                const clicked = btn.dataset.filterTag;
                if (clicked === "") {
                    activeTag = null;
                } else {
                    activeTag = activeTag === clicked ? null : clicked;
                }
                applyFilter();
            });
            return btn;
        };

        filterBar.appendChild(makeChip("All", ""));
        for (const tag of chips) filterBar.appendChild(makeChip(`#${tag}`, tag));
    }

    // ── empty state ───────────────────────────────────────────────────
    const getOrCreateEmpty = () => {
        if (!emptyState) {
            emptyState = document.createElement("div");
            emptyState.className = "post-search-empty";
            emptyState.setAttribute("role", "status");
            emptyState.setAttribute("aria-live", "polite");
            const line1 = document.createElement("p");
            line1.className = "post-search-empty-title";
            line1.textContent = "No matches found.";
            const line2 = document.createElement("p");
            line2.className = "post-search-empty-sub";
            line2.textContent = "Try a different query or clear the filters above.";
            emptyState.append(line1, line2);
        }
        return emptyState;
    };

    // ── combined filter logic ─────────────────────────────────────────
    const applyFilter = () => {
        const q = activeQuery.trim().toLowerCase();

        // Update chip active states
        if (filterBar) {
            for (const btn of filterBar.querySelectorAll(".post-filter-chip")) {
                const isAll = btn.dataset.filterTag === "";
                const isTag = btn.dataset.filterTag === activeTag;
                const isActive = isAll ? !activeTag : isTag;
                btn.setAttribute("aria-pressed", String(isActive));
                btn.classList.toggle("is-active", isActive);
            }
        }

        let shown = 0;
        const toReveal = [];
        for (const row of allRows) {
            const title = (row.dataset.originalTitle || "").toLowerCase();
            const excerpt = (row.dataset.originalExcerpt || "").toLowerCase();
            const tags = row.dataset.tags || "";

            const textMatch = !q || title.includes(q) || excerpt.includes(q);
            const tagMatch = !activeTag || tags.split(" ").includes(activeTag);

            if (textMatch && tagMatch) {
                if (row.classList.contains("post-row--hidden")) {
                    row.classList.remove("post-row--hidden");
                    toReveal.push(row);
                }
                applyHighlight(row, q);
                shown++;
            } else {
                row.classList.add("post-row--hidden");
                clearHighlight(row);
            }
        }

        // Staggered entrance for newly visible rows
        toReveal.forEach((row, i) => {
            row.style.animationDelay = `${i * 25}ms`;
            row.classList.remove("post-row--entering");
            void row.offsetWidth; // force reflow to restart animation
            row.classList.add("post-row--entering");
            row.addEventListener("animationend", () => {
                row.classList.remove("post-row--entering");
                row.style.animationDelay = "";
            }, { once: true });
        });

        // Update count badge
        if (q || activeTag) {
            countEl.textContent = `${shown} / ${totalCount}`;
            countEl.classList.toggle("post-search-count--filtered", shown < totalCount);
        } else {
            countEl.textContent = "";
            countEl.classList.remove("post-search-count--filtered");
        }

        // Empty state
        const existingEmpty = root.querySelector(".post-search-empty");
        if (shown === 0) {
            if (!existingEmpty) root.appendChild(getOrCreateEmpty());
        } else {
            if (existingEmpty) existingEmpty.remove();
        }
    };

    // ── search input events ───────────────────────────────────────────
    input.addEventListener("input", () => {
        activeQuery = input.value;
        applyFilter();
    });

    input.addEventListener("keydown", e => {
        if (e.key === "Escape") {
            input.value = "";
            activeQuery = "";
            activeTag = null;
            applyFilter();
            input.blur();
        }
    });

    // Global `/` shortcut — focus search unless already in an input
    const onKeyDown = e => {
        if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;
        e.preventDefault();
        input.focus();
        input.select();
    };
    document.addEventListener("keydown", onKeyDown);

    // ── assemble & inject ─────────────────────────────────────────────
    outer.appendChild(searchWrap);
    if (filterBar) outer.appendChild(filterBar);
    root.before(outer);

    // cleanup hook
    const origDestroy = () => {
        document.removeEventListener("keydown", onKeyDown);
        outer.remove();
    };
    outer._destroy = origDestroy;
}

// ─── Text highlight helpers ──────────────────────────────────────────────────

function applyHighlight(row, query) {
    const titleEl = row.querySelector(".post-row-title");
    if (!titleEl) return;
    const original = row.dataset.originalTitle || "";
    if (!query) {
        titleEl.textContent = original;
        return;
    }
    const lower = original.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx === -1) {
        titleEl.textContent = original;
        return;
    }
    const mark = document.createElement("mark");
    mark.className = "post-search-mark";
    mark.textContent = original.slice(idx, idx + query.length);
    titleEl.replaceChildren(
        document.createTextNode(original.slice(0, idx)),
        mark,
        document.createTextNode(original.slice(idx + query.length))
    );
}

function clearHighlight(row) {
    const titleEl = row.querySelector(".post-row-title");
    if (!titleEl) return;
    const original = row.dataset.originalTitle || "";
    titleEl.textContent = original;
}

// ─── Metrics renderer ────────────────────────────────────────────────────────

function renderMetrics(metrics) {
    if (!metrics || typeof metrics !== "object") return null;
    const defs = [
        { key: "reactions", glyph: "♥", label: "reactions" },
        { key: "comments",  glyph: "💬", label: "comments"  },
        { key: "reposts",   glyph: "↻", label: "reposts"   },
    ];
    const group = document.createElement("span");
    group.className = "post-row-metrics";
    let shown = 0;
    for (const def of defs) {
        const v = metrics[def.key];
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
        const chip = document.createElement("span");
        chip.className = `post-row-metric post-row-metric--${def.key}`;
        chip.setAttribute("aria-label", `${v} ${def.label}`);
        const icon = document.createElement("span");
        icon.className = "post-row-metric-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = def.glyph;
        const count = document.createElement("span");
        count.className = "post-row-metric-count";
        count.textContent = _compact.format(v);
        chip.append(icon, count);
        group.appendChild(chip);
        shown++;
    }
    return shown ? group : null;
}

// ─── Post row renderer ───────────────────────────────────────────────────────

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
    // Store originals for search + highlight
    a.dataset.originalTitle = post.firstLine;
    a.dataset.originalExcerpt = post.excerpt || "";

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

    const leftCluster = document.createElement("span");
    leftCluster.className = "post-row-foot-left";

    if (post.date) {
        const time = document.createElement("time");
        time.className = "post-row-date";
        time.dateTime = post.date;
        time.textContent = formatDate(post.date);
        leftCluster.appendChild(time);
    }

    const metricsEl = renderMetrics(post.metrics);
    if (metricsEl) leftCluster.appendChild(metricsEl);

    foot.appendChild(leftCluster);

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

// ─── Utilities ───────────────────────────────────────────────────────────────

function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

function withEllipsis(s) {
    const t = (s || "").trimEnd();
    if (!t) return t;
    if (t.endsWith("…") || t.endsWith("...")) return t;
    return t + "…";
}
