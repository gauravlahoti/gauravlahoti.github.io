// work-viz.js: the efficiency headline on each Selected Work card.
// buildOutcomeViz(outcome) -> { node, valueEl, play(), prime() }. The headline
// number counts up to the value in outcome.viz.count; there is no graphic.
// Pure DOM, textContent only.

// fx.js is loaded with this module's own ?v= query (see selected-work.js).
const fxReady = import(`./fx.js${new URL(import.meta.url).search}`);

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

// Count: no graphic, just the headline counting up to its value.
function count(v) {
    const c = v.count || { to: 1 };
    return {
        node: null,
        format: (p) => `${c.prefix || ""}${Math.round(c.to * p)}${c.suffix || ""}`,
        ms: 1400,
        ease: "out",
    };
}

const KINDS = { count };

export function buildOutcomeViz(outcome) {
    const make = KINDS[outcome.viz && outcome.viz.kind];
    const valueEl = el("p", "work-outcome-value");
    // The visible number animates, so it is hidden from screen readers; they get
    // the final value once, in a visually hidden twin.
    const live = el("span", "", outcome.value);
    live.setAttribute("aria-hidden", "true");
    valueEl.append(live, el("span", "work-sr", outcome.value));
    if (!make) return { node: null, valueEl, play() {} };

    const built = make(outcome.viz);
    if (built.node) built.node.setAttribute("aria-hidden", "true");
    return {
        node: built.node,
        valueEl,
        play() {
            fxReady.then(({ runCount }) => runCount((p) => { live.textContent = built.format(p); }, built.ms, built.ease));
        },
        // Start from zero so the count has somewhere to go from.
        prime() { live.textContent = built.format(0); },
    };
}
