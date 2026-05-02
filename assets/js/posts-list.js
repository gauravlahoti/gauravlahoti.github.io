// posts-list.js — Writing section (LinkedIn posts feed) + nav flyout.
// Exports: initPostsList(root)   → accordion in #writing
//          initPostsFlyout(root) → flat list in nav dropdown
// All text rendered via textContent (treat OG-scraped strings as untrusted).

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
            });
    }
    return postsPromise;
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
    for (const post of posts) {
        const node = renderPost(post);
        if (node) frag.appendChild(node);
    }
    root.replaceChildren(frag);

    return {
        destroy() { root.replaceChildren(); },
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

    const list = document.createElement("ul");
    list.className = "nav-flyout-list";
    list.setAttribute("role", "none");
    for (const post of posts) {
        const item = renderFlyoutItem(post);
        if (item) list.appendChild(item);
    }

    const foot = document.createElement("a");
    foot.className = "nav-flyout-foot";
    foot.href = "#writing";
    foot.setAttribute("role", "menuitem");
    foot.dataset.cursor = "magnet";
    foot.textContent = "View all perspectives →";

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

function renderPost(post) {
    if (!post || typeof post.url !== "string" || typeof post.firstLine !== "string") {
        return null;
    }

    const details = document.createElement("details");
    details.className = "post";

    const summary = document.createElement("summary");
    summary.className = "post-summary";

    const title = document.createElement("span");
    title.className = "post-title";
    title.textContent = post.firstLine;
    summary.appendChild(title);

    if (post.date) {
        const time = document.createElement("time");
        time.className = "post-date";
        time.dateTime = post.date;
        time.textContent = formatDate(post.date);
        summary.appendChild(time);
    }

    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "post-body";

    if (post.excerpt) {
        const p = document.createElement("p");
        p.className = "post-excerpt";
        p.textContent = post.excerpt;
        body.appendChild(p);
    }

    const link = document.createElement("a");
    link.className = "post-link";
    link.href = post.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.dataset.cursor = "magnet";
    link.textContent = "Read full post on LinkedIn ↗";
    body.appendChild(link);

    details.appendChild(body);
    return details;
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
