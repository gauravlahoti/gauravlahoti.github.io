// capabilities.js: the "What I bring" bento (spec 109).
//
// Two pillar tiles (AI-native, cloud) carry the story with live signals read
// from the site's own data: the agents running now (agents.json, by name,
// never a count) and the certifications (profile.json). Four skill tiles each
// show one idea with a small SVG animation. The full 67-item toolkit from
// profile.capabilities sits in a native <details>, so Find-in-page, search
// engines and Atlas still reach every keyword.
//
// Contract: initCapabilities(root, { profile }). Text goes in via
// textContent; the only markup strings are the static SVG glyphs below.

const V = new URL(import.meta.url).search;

// Decorative glyphs, one per skill tile. Motion lives in bring.css and only
// runs when reduced motion is off and the tile is on screen.
const VIZ = {
    nodes: `<svg viewBox="0 0 120 44" aria-hidden="true" class="bring-viz bring-viz--nodes">
        <path class="bv-link" d="M18 22H60M60 22H102"/>
        <circle class="bv-node bv-n1" cx="18" cy="22" r="7"/>
        <circle class="bv-node bv-n2" cx="60" cy="22" r="7"/>
        <circle class="bv-node bv-n3" cx="102" cy="22" r="7"/>
    </svg>`,
    wire: `<svg viewBox="0 0 120 44" aria-hidden="true" class="bring-viz bring-viz--wire">
        <rect class="bv-port" x="4" y="12" width="20" height="20" rx="4"/>
        <rect class="bv-port" x="96" y="12" width="20" height="20" rx="4"/>
        <path class="bv-wire" d="M24 22H96"/>
        <path class="bv-signal" d="M24 22H96"/>
    </svg>`,
    evals: `<svg viewBox="0 0 120 44" aria-hidden="true" class="bring-viz bring-viz--evals">
        <rect class="bv-track" x="4" y="17" width="78" height="10" rx="5"/>
        <rect class="bv-fill" x="4" y="17" width="78" height="10" rx="5"/>
        <text class="bv-pass" x="90" y="26">pass</text>
    </svg>`,
    lock: `<svg viewBox="0 0 120 44" aria-hidden="true" class="bring-viz bring-viz--lock">
        <path class="bv-shackle" d="M51 21v-6a9 9 0 0 1 18 0v6"/>
        <rect class="bv-body" x="46" y="20" width="28" height="20" rx="4"/>
        <circle class="bv-key" cx="60" cy="30" r="2.5"/>
    </svg>`,
};

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

async function getJson(path) {
    try {
        const r = await fetch(path, { cache: "no-cache" });
        return r.ok ? await r.json() : null;
    } catch {
        return null;
    }
}

function loadStyles() {
    const href = new URL(`../css/bring.css${V}`, import.meta.url).href;
    if (document.querySelector(`link[href="${href}"]`)) return Promise.resolve();
    return new Promise((resolve) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        link.onload = link.onerror = () => resolve();
        document.head.appendChild(link);
    });
}

function link(cls, href, text) {
    const a = el("a", cls, text);
    a.href = href;
    a.dataset.cursor = "magnet"; // cursor.js brackets snap to it
    return a;
}

function agentsSignal(agents, labs) {
    const wrap = el("div", "bring-signal");
    const live = agents.filter((a) => String(a.status || "").toUpperCase() === "LIVE");
    if (live.length) {
        wrap.append(el("p", "bring-signal-label", "Live now"));
        const ul = el("ul", "bring-live");
        for (const a of live) {
            const li = el("li");
            const item = link("bring-chiplink", `/live-agents/?agent=${encodeURIComponent(a.id)}`, "");
            item.append(el("span", "bring-dot"), document.createTextNode(a.name));
            li.append(item);
            ul.append(li);
        }
        wrap.append(ul);
    }
    // A lab that is also a live agent (Agentic RAG, the harness) is already
    // listed above; show only the labs that add something new.
    const liveNames = new Set(live.map((a) => String(a.name).toLowerCase()));
    const extraLabs = labs.filter((l) => !liveNames.has(String(l.title).toLowerCase()));
    if (extraLabs.length) {
        wrap.append(el("p", "bring-signal-label", "Interactive labs"));
        const ul = el("ul", "bring-labs");
        for (const l of extraLabs) {
            const li = el("li");
            li.append(link("bring-chiplink", l.href, l.title));
            ul.append(li);
        }
        wrap.append(ul);
    }
    return wrap;
}

function certsSignal(certs, stack) {
    const wrap = el("div", "bring-signal bring-signal--certs");
    const stat = el("p", "bring-stat");
    stat.append(el("span", "bring-stat-num", String(certs.length)), el("span", "bring-stat-label", "certifications"));
    wrap.append(stat);
    const issuers = [...new Set(certs.map((c) => c.issuer).filter(Boolean))];
    // Cloud first: this is the cloud pillar.
    const order = ["Google Cloud", "AWS", "Microsoft", "Anthropic"];
    issuers.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    const ul = el("ul", "bring-issuers");
    for (const name of issuers) {
        const li = el("li");
        li.append(el("span", "bring-issuer-count", String(certs.filter((c) => c.issuer === name).length)), document.createTextNode(name));
        ul.append(li);
    }
    wrap.append(ul);
    if (Array.isArray(stack) && stack.length) {
        wrap.append(el("p", "bring-signal-label", "Runs on"), el("p", "bring-stack", stack.join(" · ")));
    }
    return wrap;
}

function pillarTile(p, signal) {
    const art = el("article", `bring-tile bring-pillar bring-pillar--${p.key}`);
    art.append(el("p", "bring-eyebrow", p.eyebrow), el("h3", "bring-title", p.title), signal);
    if (p.link) {
        const foot = el("footer", "bring-foot");
        foot.append(link("bring-link", p.link.href, `${p.link.label} →`));
        art.append(foot);
    }
    return art;
}

function skillTile(t) {
    const art = el("article", `bring-tile bring-skill bring-skill--${t.key}`);
    const viz = el("div", "bring-viz-wrap");
    viz.innerHTML = VIZ[t.viz] || ""; // static, trusted glyph markup
    art.append(viz, el("h3", "bring-skill-title", t.title), el("p", "bring-skill-line", t.line));
    if (Array.isArray(t.tools) && t.tools.length) art.append(el("p", "bring-tools", t.tools.join(" · ")));
    return art;
}

function toolkit(caps, label) {
    const groups = [
        ["AI-native architecture", caps.aiNative || []],
        ["Cloud foundations", caps.cloud || []],
        ["Business and delivery", caps.business || []],
    ];
    const total = groups.reduce((n, [, g]) => n + g.reduce((m, x) => m + (x.items || []).length, 0), 0);
    const d = el("details", "bring-toolkit");
    const sum = el("summary", "bring-toolkit-summary");
    sum.dataset.cursor = "magnet";
    sum.append(el("span", "bring-toolkit-label", label || "Full toolkit"), el("span", "bring-toolkit-count", `${total} tools and practices`));
    d.append(sum);
    const body = el("div", "bring-toolkit-body");
    for (const [title, list] of groups) {
        if (!list.length) continue;
        const col = el("section", "bring-toolkit-col");
        col.append(el("h3", "bring-toolkit-head", title));
        const dl = el("dl", "bring-toolkit-list");
        for (const g of list) {
            dl.append(el("dt", null, g.label), el("dd", null, (g.items || []).join(" · ")));
        }
        col.append(dl);
        body.append(col);
    }
    d.append(body);
    return d;
}

// Pointer spotlight on each tile's border. Purely decorative: every tile is
// fully legible and keyboard-reachable without it.
function wireSpotlight(grid) {
    if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    grid.addEventListener("pointermove", (e) => {
        const tile = e.target.closest(".bring-tile");
        if (!tile) return;
        const r = tile.getBoundingClientRect();
        tile.style.setProperty("--mx", `${e.clientX - r.left}px`);
        tile.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
}

// Skill glyphs animate only while their tile is on screen.
function wireInView(tiles) {
    const io = new IntersectionObserver((entries) => {
        for (const en of entries) en.target.classList.toggle("is-inview", en.isIntersecting);
    }, { threshold: 0.4 });
    tiles.forEach((t) => io.observe(t));
}

export async function initCapabilities(root, { profile } = {}) {
    if (!root || !profile?.bring) return;
    const b = profile.bring;
    const [agentsData, conceptsData] = await Promise.all([
        getJson("content/agents.json"),
        getJson("content/ai-concepts.json"),
        loadStyles(),
    ]);
    const agents = Array.isArray(agentsData) ? agentsData : agentsData?.agents || [];
    const conceptList = Array.isArray(conceptsData) ? conceptsData : conceptsData?.concepts || [];
    const labs = conceptList
        .filter((c) => c && c.href && (c.title || c.name))
        .map((c) => ({ href: c.href, title: c.title || c.name }));
    const certs = Array.isArray(profile.certifications) ? profile.certifications : [];

    const grid = el("div", "bring-grid");
    for (const p of b.pillars || []) {
        const signal = p.signal === "agents" ? agentsSignal(agents, labs) : certsSignal(certs, p.stack);
        grid.append(pillarTile(p, signal));
    }
    const skills = (b.tiles || []).map(skillTile);
    // One row on desktop, a 2x2 on tablets, a swipe row on phones. The row
    // scrolls, so it takes focus and a name for keyboard and screen readers.
    const row = el("div", "bring-skills");
    row.tabIndex = 0;
    row.setAttribute("role", "region");
    row.setAttribute("aria-label", "Core skills");
    row.append(...skills);
    grid.append(row);

    root.replaceChildren(grid, toolkit(profile.capabilities || {}, b.toolkitLabel));
    wireSpotlight(grid);
    wireInView(skills);
}
