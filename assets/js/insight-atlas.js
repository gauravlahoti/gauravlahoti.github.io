// insight-atlas.js: opens Atlas right on an insight page (spec 108).
//
// The "Chat with my agent" button keeps href="/?chat=1" as a no-JS fallback
// (the home page opens Atlas on arrival). With JS, the click loads the same
// chat widget the home page uses and opens it here, so the reader never
// leaves the post. Mirrors _openAtlasWidget() in agents-page.js.
//
// This module's ?v= is the home page's main.js version (set by
// gen-post-pages.mjs), and it passes that on to the widget, so a /publish
// cache-bust reaches the widget and its submodules here too.

import { tagSessionId } from "./owner.js";

const V = new URL(import.meta.url).search;

function uuidv4() {
    if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let widgetPromise = null;
function loadWidget() {
    if (!widgetPromise) {
        widgetPromise = Promise.all([
            fetch("content/profile.json", { cache: "no-cache" }).then((r) => r.json()),
            import(`./agent-widget.js${V}`),
        ])
            .then(([profile, { initAgentWidget }]) => {
                let root = document.getElementById("agent-root");
                if (!root) {
                    root = document.createElement("div");
                    root.id = "agent-root";
                    document.body.appendChild(root);
                }
                const widget = initAgentWidget(root, profile, tagSessionId(uuidv4()));
                window.__agentWidget = widget;
                return widget;
            })
            .catch((err) => {
                console.warn("[insight-atlas] widget failed to load", err);
                widgetPromise = null;
                return null;
            });
    }
    return widgetPromise;
}

document.addEventListener("click", async (e) => {
    const trigger = e.target.closest("[data-agent-open]");
    if (!trigger) return;
    e.preventDefault();
    const widget = await loadWidget();
    if (widget && widget.open) widget.open("insight-post");
    // Widget couldn't load: fall back to the home page, which opens Atlas.
    else location.href = trigger.getAttribute("href") || "/?chat=1";
});

// Start fetching on hover or focus, so the panel opens fast on click.
for (const el of document.querySelectorAll("[data-agent-open]")) {
    el.addEventListener("pointerenter", loadWidget, { once: true });
    el.addEventListener("focus", loadWidget, { once: true });
}
