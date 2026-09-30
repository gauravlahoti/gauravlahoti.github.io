// site-stage.js — pages Atlas can put on screen mid-conversation (spec 78).
//
// The avatar asks for a target by key ("mcp-lab"); this module owns what each
// key means, so a string from the model never becomes a URL. A home-page
// section scrolls into view. A page opens in a same-origin frame over the
// home page and under the Atlas panel, so the document never unloads and the
// live call, its WebSocket and the face keep running.
//
// Imported lazily by agent-widget.js the first time Atlas shows something.

// Keys match SHOW_TARGETS in agents/atlas/app/live_brain.py (a unit test
// there reads this map, so the two can't drift).
export const SITE_TARGETS = {
    "top":               { section: "top",      title: "Home" },
    "career":            { section: "career",   title: "Career" },
    "about":             { section: "about",    title: "About" },
    "insights":          { section: "insights", title: "Insights" },
    "labs":              { path: "/ai-labs/",                   title: "AI Labs" },
    "mcp-lab":           { path: "/ai-labs/mcp-lab/",           title: "Model Context Protocol lab" },
    "engineering-loops": { path: "/ai-labs/engineering-loops/", title: "Engineering Loops lab" },
    "agent-ready":       { path: "/ai-labs/agent-ready/",       title: "Agent-Ready Web lab" },
    "live-agents":       { path: "/live-agents/",               title: "Live Agents" },
};

// Spec 80: things inside pages. The server checks agent ids against
// agents.json before sending one; here an id only has to be a plain slug, so
// it can never reach outside /live-agents/.
const LOOPS_LAYERS = { prompt: "Prompt", context: "Context", harness: "Harness", loop: "Loop" };
const AGENT_KEY = /^agent:([a-z0-9-]+)(:diagram)?$/;

// A known key's entry, or null. Own keys only, so "__proto__" and friends
// never resolve.
export function resolveTarget(key) {
    if (typeof key !== "string") return null;
    if (Object.hasOwn(SITE_TARGETS, key)) return SITE_TARGETS[key];
    const agent = AGENT_KEY.exec(key);
    if (agent) {
        const diagram = Boolean(agent[2]);
        return {
            path: `/live-agents/?agent=${agent[1]}${diagram ? "&view=diagram" : ""}`,
            title: diagram ? "Architecture diagram" : "Live Agents",
        };
    }
    if (key.startsWith("loops:") && Object.hasOwn(LOOPS_LAYERS, key.slice(6))) {
        const layer = key.slice(6);
        return { path: `/ai-labs/engineering-loops/#${layer}`, title: `Engineering Loops lab: ${LOOPS_LAYERS[layer]}` };
    }
    return null;
}

const REDUCE_MOTION = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Paths that mean "the home page": a link home inside the frame closes the
// stage instead of loading a second copy of the site (and its Atlas) in it.
const HOME_PATHS = new Set(["/", "/index.html"]);

let stage = null; // { root, frame, title, onClose }

// Show a target. Returns its title, or null for an unknown key.
// `onChange(open)` is told when the stage opens or closes.
export function showTarget(key, { onChange } = {}) {
    const t = resolveTarget(key);
    if (!t) return null;
    if (t.section) {
        closeStage();
        document.dispatchEvent(new CustomEvent("portfolio:scroll-to", { detail: { anchor: "#" + t.section } }));
        return t.title;
    }
    openStage(t, onChange);
    return t.title;
}

export function isStageOpen() {
    return !!stage;
}

export function closeStage() {
    if (!stage) return;
    const { root, onClose } = stage;
    stage = null;
    document.body.removeAttribute("data-site-stage-open");
    if (REDUCE_MOTION) root.remove();
    else {
        root.classList.remove("is-open");
        setTimeout(() => root.remove(), 340); // after the --dur-base fade
    }
    if (onClose) onClose();
}

// Point the open frame somewhere else. A change of hash alone is a same-page
// jump the lab wouldn't react to (it reads its hash on load), so reload then.
function goTo(frame, path) {
    let here = null;
    try { here = frame.contentWindow.location; } catch (_) { /* not loaded yet */ }
    const next = new URL(path, location.origin);
    if (here && here.pathname === next.pathname && here.search === next.search && here.hash !== next.hash) {
        here.hash = next.hash;
        here.reload();
        return;
    }
    frame.src = path;
}

function openStage(t, onChange) {
    if (stage) {
        stage.title.textContent = t.title;
        stage.root.setAttribute("aria-label", t.title);
        stage.frame.title = t.title;
        goTo(stage.frame, t.path);
        return;
    }
    const root = document.createElement("div");
    root.className = "site-stage";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", t.title);

    const bar = document.createElement("div");
    bar.className = "site-stage-bar";
    const title = document.createElement("span");
    title.className = "site-stage-title";
    title.textContent = t.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "site-stage-close";
    close.textContent = "Back to home";
    close.addEventListener("click", closeStage);
    // Close first: on a wide screen the Atlas panel covers the bar's right end.
    bar.append(close, title);

    const frame = document.createElement("iframe");
    frame.className = "site-stage-frame";
    frame.title = t.title;
    frame.src = t.path;
    frame.addEventListener("load", () => {
        // Same origin, so the frame's location is readable. Leaving for the
        // home page means "take me back".
        let path = "";
        try { path = frame.contentWindow.location.pathname; } catch (_) { return; }
        if (HOME_PATHS.has(path)) closeStage();
    });

    root.append(bar, frame);
    document.body.appendChild(root);
    document.body.setAttribute("data-site-stage-open", "true");
    stage = { root, frame, title, onClose: onChange ? () => onChange(false) : null };
    if (REDUCE_MOTION) root.classList.add("is-open");
    else requestAnimationFrame(() => root.classList.add("is-open"));
    if (onChange) onChange(true);
}
