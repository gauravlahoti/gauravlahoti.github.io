// webmcp-lab.js — Agent-Ready Web lab engine
//
// Two panes. The registry pane reads document.modelContext.getTools() live,
// so it shows exactly what the browser actually sees — not a hardcoded copy
// of the tool list. The console pane runs each tool's own execute() code
// directly (imported from webmcp.js), so it works in every browser even
// without WebMCP support; where a browser execution surface IS present, a
// second button routes the same call through the browser's own executeTool()
// so the difference between "the page ran this" and "the browser ran this" is
// visible rather than hidden. See getExecSurface() for why "the browser's own"
// is not a single fixed API.
//
// Contract: initWebMcpLab(root, { content, profile }) → { destroy() }

import { defineTools } from "./webmcp.js";

function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role") n.setAttribute(k, v);
        else n[k] = v;
    }
    for (const c of kids) {
        if (c == null) continue;
        n.append(c.nodeType ? c : document.createTextNode(c));
    }
    return n;
}

function getModelContext() {
    return document.modelContext || navigator.modelContext || null;
}

/* ---------- browser execution surface ---------- */
//
// Measured against Chrome with chrome://flags/#enable-webmcp-testing, because
// the docs and the shipped build disagree. What is actually true there:
//
//   document.modelContext         getTools()  executeTool(registeredTool, json)
//   navigator.modelContextTesting listTools() executeTool(name, json)
//
// Three things bite:
//   1. The two surfaces disagree on the first argument. document.modelContext
//      demands a RegisteredTool ("The provided value is not of type
//      'RegisteredTool'" for a name); the testing shim wants the name.
//   2. The second argument must be a JSON *string*. An object rejects with
//      "UnknownError: Failed to parse input arguments".
//   3. executeTool resolves to a JSON *string*, not a result object. Reading
//      .content off it silently yields undefined, which is what made the old
//      console render an escaped blob instead of the tool's output.
// The optional third argument is accepted and ignored on this build.

const EXEC_TIMEOUT_MS = 5000;

function getExecSurface() {
    const testing = navigator.modelContextTesting;
    if (testing && typeof testing.executeTool === "function") {
        return {
            kind: "testing",
            label: "navigator.modelContextTesting",
            mc: testing,
            byName: true,
            // This shim names it listTools, not getTools.
            list: typeof testing.listTools === "function" ? "listTools"
                : typeof testing.getTools === "function" ? "getTools" : null,
        };
    }
    const mc = getModelContext();
    if (mc && typeof mc.executeTool === "function") {
        return {
            kind: "imperative",
            label: document.modelContext ? "document.modelContext" : "navigator.modelContext",
            mc,
            byName: false,
            list: typeof mc.getTools === "function" ? "getTools" : null,
        };
    }
    return null;
}

// executeTool hands back a JSON string. Parse it so the console can read
// .content like every other result, and fall back to showing raw text if it
// is ever something else.
function normalizeResult(raw) {
    if (raw == null) return null;
    if (typeof raw === "string") {
        try {
            return JSON.parse(raw);
        } catch (_) {
            return { content: [{ type: "text", text: raw }] };
        }
    }
    return raw;
}

// Each rung is [description, argsBuilder]. Documented shape first.
const EXEC_SHAPES = [
    ["(target, json, { signal })", (t, json, raw, signal) => [t, json, { signal }]],
    ["(target, json)",             (t, json) => [t, json]],
    ["(target, object)",           (t, json, raw) => [t, raw]],
];

function withTimeout(promise, ms, onTimeout) {
    let timer;
    return Promise.race([
        Promise.resolve(promise).finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
            timer = setTimeout(() => {
                if (onTimeout) onTimeout();
                reject(Object.assign(new Error(`No response after ${ms / 1000}s.`), { name: "TimeoutError" }));
            }, ms);
        }),
    ]);
}

// Remembers the first shape that worked, so later runs go straight to it.
let execShapeIdx = null;

async function executeViaBrowser(surface, target, input) {
    const json = JSON.stringify(input);
    const order = execShapeIdx == null
        ? EXEC_SHAPES.map((_, i) => i)
        : [execShapeIdx, ...EXEC_SHAPES.map((_, i) => i).filter((i) => i !== execShapeIdx)];

    const tried = [];
    for (const idx of order) {
        const [shapeLabel, build] = EXEC_SHAPES[idx];
        const controller = new AbortController();
        try {
            const args = build(target, json, input, controller.signal);
            const raw = await withTimeout(
                surface.mc.executeTool(...args),
                EXEC_TIMEOUT_MS,
                () => controller.abort()
            );
            // Resolved. That settles the shape, even if the tool itself
            // reported isError, since a tool-level failure is a real answer.
            execShapeIdx = idx;
            return { result: normalizeResult(raw), shapeLabel };
        } catch (err) {
            console.error(`[webmcp-lab] ${surface.label}.executeTool${shapeLabel} failed`, err);
            tried.push(`${shapeLabel} → ${err && err.name ? err.name : "Error"}: ${(err && err.message) || err}`);
            // A timeout says the surface never answered, not that this shape was
            // wrong. Trying the remaining shapes just costs another wait each.
            if (err && err.name === "TimeoutError") break;
        }
    }
    throw Object.assign(
        new Error(`No call shape worked on ${surface.label}.\n${tried.join("\n")}`),
        { name: "ExecuteToolError" }
    );
}

/* ---------- what-is-webmcp diagram ---------- */
//
// Hand-authored SVG rather than a mermaid dependency: this site has no build
// step and only two CDN scripts, and the other labs draw their own diagrams the
// same way. Vertical flow, matching how the source graph reads: cloud model at
// the top, browser in the middle, the site's own backend at the bottom. All
// colour comes from CSS classes so the design tokens stay the single source.

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs = {}, ...kids) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === "text") n.textContent = v;
        else n.setAttribute(k, v);
    }
    kids.forEach((c) => c && n.append(c));
    return n;
}

// A titled box. `variant` picks the CSS class, nothing else.
function dBox(x, y, w, h, label, variant, sub) {
    const g = svg("g", { class: `wd-box wd-box--${variant}` });
    g.append(svg("rect", { x, y, width: w, height: h, rx: 6 }));
    const cx = x + w / 2;
    if (sub) {
        g.append(svg("text", { class: "wd-box-label", x: cx, y: y + h / 2 - 4, "text-anchor": "middle", text: label }));
        g.append(svg("text", { class: "wd-box-sub", x: cx, y: y + h / 2 + 16, "text-anchor": "middle", text: sub }));
    } else {
        g.append(svg("text", { class: "wd-box-label", x: cx, y: y + h / 2 + 5, "text-anchor": "middle", text: label }));
    }
    return g;
}

// Straight vertical connector, arrowhead drawn as its own polygon rather than
// a marker. A marker paints at the line's end vertex immediately, so a line
// that animates its draw would show the head before the shaft arrives. Owning
// the head lets it fade in only once the line has landed.
const HEAD = 9;

function dArrow(x, y1, y2) {
    const down = y2 > y1;
    const tip = y2;
    const base = down ? y2 - HEAD : y2 + HEAD;
    const g = svg("g", { class: "wd-arrow" });
    const len = Math.abs(base - y1);
    const line = svg("line", { x1: x, y1, x2: x, y2: base });
    line.style.setProperty("--len", len);
    g.append(line);
    g.append(svg("polygon", {
        class: "wd-head",
        points: `${x - 5},${base} ${x + 5},${base} ${x},${tip}`,
    }));
    return g;
}

const STEP_MS = 340;

// Reveals the picture one beat at a time: the frames, then the boxes, then
// each numbered edge in order, so the story reads as a sequence instead of
// landing all at once. Replays on every open.
function playDiagram(root) {
    const steps = [...root.querySelectorAll("[data-wd-step]")]
        .sort((a, b) => Number(a.dataset.wdStep) - Number(b.dataset.wdStep));
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

    steps.forEach((s) => s.classList.remove("is-on"));
    if (reduce) {
        // No motion: show the finished picture immediately.
        steps.forEach((s) => s.classList.add("is-on"));
        return null;
    }
    // Force a reflow so removing and re-adding the class actually restarts the
    // transition rather than being coalesced into a no-op.
    void root.getBoundingClientRect();

    const timers = steps.map((s, i) => setTimeout(() => s.classList.add("is-on"), STEP_MS * i));
    return () => timers.forEach(clearTimeout);
}

function buildDiagramSvg(d) {
    const n = d.nodes;
    const root = svg("svg", {
        class: "wd-svg",
        viewBox: "0 0 720 880",
        role: "img",
        "aria-label": `${d.title}. ${d.edges.map((e) => `${e.n}. ${e.full}`).join(" ")}`,
    });

    // Each step group is one beat of the animation, numbered in play order.
    const step = (i, ...kids) => {
        const g = svg("g", { "data-wd-step": i });
        kids.forEach((k) => k && g.append(k));
        root.append(g);
        return g;
    };

    // Frames first so the boxes inside sit on top of them.
    const browser = svg("g", { class: "wd-frame wd-frame--browser" });
    browser.append(svg("rect", { x: 40, y: 150, width: 640, height: 500, rx: 10 }));
    // Title left-aligned so the incoming arrow does not run through it.
    browser.append(svg("text", { class: "wd-frame-label", x: 62, y: 180, text: n.browser }));

    const page = svg("g", { class: "wd-frame wd-frame--page" });
    page.append(svg("rect", { x: 100, y: 420, width: 520, height: 190, rx: 8 }));
    page.append(svg("text", { class: "wd-frame-label", x: 122, y: 450, text: n.page }));

    step(0, browser, page);

    step(1,
        dBox(230, 16, 260, 64, n.platform, "cloud"),
        dBox(190, 196, 340, 70, n.agent, "agent"),
        dBox(230, 470, 260, 70, n.tools, "tools"),
        dBox(230, 790, 260, 70, n.service.replace(/\s*\(.*\)$/, ""), "service", "example.com")
    );

    const lab = (x, y, e) =>
        svg("text", { class: "wd-edge", x, y, text: `${e.n}. ${e.short}` });
    const [e1, e2, e3, e4] = d.edges;

    // Edges animate in numbered order, so the beats match the legend below.
    // 4 leaves the tools on the left and 1 returns on the right, so the two
    // legs between the page and the service never overlap.
    step(2, dArrow(420, 790, 616), lab(436, 700, e1));
    step(3, dArrow(360, 80, 190), lab(378, 122, e2));
    step(4, dArrow(360, 266, 464), lab(378, 350, e3));
    step(5, dArrow(300, 540, 784), lab(62, 700, e4));

    return root;
}

// Collapsed by default. The tools come first on this page; the explainer is
// here for whoever wants it, and opening it is what starts the animation.
function renderDiagram(section, content) {
    const d = content.diagram;
    if (!d) return;

    const panelId = "wd-panel";
    const chevron = el("span", { class: "wd-chevron", "aria-hidden": "true" });
    const btn = el("button", {
        type: "button",
        class: "wd-disclosure",
        "aria-expanded": "false",
        "aria-controls": panelId,
    },
        el("span", { class: "wd-disclosure-text" },
            el("span", { class: "webmcp-pane-title", text: d.title }),
            el("p", { class: "webmcp-pane-sub", text: d.lead })
        ),
        chevron
    );

    const root = buildDiagramSvg(d);

    const legend = el("ol", { class: "wd-legend" });
    d.edges.forEach((e) => legend.append(el("li", { class: "wd-legend-item" },
        el("span", { class: "wd-legend-n", text: e.n }),
        el("span", { class: "wd-legend-text", text: e.full })
    )));

    const inner = el("div", { class: "wd-panel-inner" },
        el("div", { class: "wd-scroll" }, root),
        legend
    );
    const panel = el("div", { class: "wd-panel", id: panelId }, inner);
    panel.hidden = true;

    // The panel itself just appears and fades; the motion that matters is the
    // step reveal inside it. Animating the container's height was tried and
    // dropped: it fought the SVG's intrinsic sizing and left the panel at 0.
    let cancel = null;
    let closeTimer = 0;

    btn.addEventListener("click", () => {
        const open = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", open ? "false" : "true");
        if (cancel) cancel();
        clearTimeout(closeTimer);

        if (open) {
            section.classList.remove("is-open");
            cancel = null;
            closeTimer = setTimeout(() => { panel.hidden = true; }, 320);
            return;
        }

        panel.hidden = false;
        // Flush layout so the fade has a start value to transition from. A
        // forced reflow rather than requestAnimationFrame on purpose: rAF does
        // not fire in a background tab, which would leave the panel visible but
        // never flagged open.
        void panel.offsetHeight;
        section.classList.add("is-open");
        cancel = playDiagram(root);
    });

    section.append(btn, panel);
}

/* ---------- setup steps ---------- */

function renderSetup(section, content) {
    const s = content.setup;
    if (!s) return;
    section.append(
        el("h2", { class: "webmcp-pane-title", text: s.title }),
        el("p", { class: "webmcp-pane-sub", text: s.lead })
    );

    const steps = el("ol", { class: "webmcp-setup-steps" });
    s.steps.forEach((step) => {
        const li = el("li", { class: "webmcp-setup-step" });
        // Split on the flag so it can render as code without innerHTML.
        const i = s.flagLabel ? step.indexOf(s.flagLabel) : -1;
        if (i === -1) {
            li.append(document.createTextNode(step));
        } else {
            li.append(
                document.createTextNode(step.slice(0, i)),
                el("code", { class: "webmcp-flag-inline", text: s.flagLabel }),
                document.createTextNode(step.slice(i + s.flagLabel.length))
            );
        }
        steps.append(li);
    });
    section.append(steps);

    section.append(el("h3", { class: "webmcp-setup-links-title", text: s.linksTitle }));
    const links = el("ul", { class: "webmcp-setup-links" });
    s.links.forEach((l) => {
        links.append(el("li", {},
            el("a", {
                class: "webmcp-setup-link",
                href: l.href,
                target: "_blank",
                rel: "noopener noreferrer",
            },
                el("span", { class: "webmcp-setup-link-label", text: l.label }),
                l.note ? el("span", { class: "webmcp-setup-link-note", text: l.note }) : null
            )
        ));
    });
    section.append(links);
}

/* ---------- registry pane ---------- */

const PAGE_SCOPE = "lab-agent-ready";

function badgeRow(def, labels) {
    const row = el("div", { class: "webmcp-badges" });
    const a = def.annotations || {};
    if (a.readOnlyHint) row.append(el("span", { class: "webmcp-badge webmcp-badge-ro", text: labels.readOnly }));
    else row.append(el("span", { class: "webmcp-badge webmcp-badge-write", text: labels.write }));
    return row;
}

// Tools are scoped per page. Two of the five register on the home page, so they
// are listed here for completeness and labelled with where they actually live,
// rather than quietly omitted.
function scopeNote(def, registry) {
    if ((def.scopes || []).includes(PAGE_SCOPE)) return null;
    const labels = registry.scopeLabels || {};
    const where = (def.scopes || []).map((s) => labels[s]).filter(Boolean);
    if (!where.length) return null;
    return el("p", {
        class: "webmcp-tool-scope",
        text: registry.scopeNote + where.join(" and "),
    });
}

function renderRegistry(pane, content, mc, defs, tools) {
    pane.replaceChildren();
    pane.append(
        el("h2", { class: "webmcp-pane-title", text: content.registry.title }),
        el("p", { class: "webmcp-pane-sub", text: content.registry.sub })
    );

    if (!mc) {
        const u = content.registry.unsupported;
        pane.append(
            el("div", { class: "webmcp-unsupported" },
                el("p", { class: "webmcp-unsupported-title", text: u.title }),
                el("p", { class: "webmcp-unsupported-body", text: u.body }),
                el("p", { class: "webmcp-unsupported-hint", text: u.hint })
            )
        );
        return;
    }

    const list = el("ul", { class: "webmcp-registry-list" });
    const byName = new Map((tools || []).map((t) => [t.name, t]));
    defs.forEach((def) => {
        const live = byName.get(def.name);
        const params = Object.keys(def.inputSchema?.properties || {});
        const note = scopeNote(def, content.registry);
        const item = el("li", { class: "webmcp-registry-item" + (note ? " is-offpage" : "") },
            el("div", { class: "webmcp-registry-head" },
                el("code", { class: "webmcp-tool-name", text: def.name }),
                badgeRow(def, content.registry.badges)
            ),
            el("p", { class: "webmcp-tool-desc", text: (live || def).description }),
            params.length ? el("p", { class: "webmcp-tool-params", text: "params: " + params.join(", ") }) : null,
            note
        );
        list.append(item);
    });
    pane.append(list);
}

/* ---------- console pane ---------- */

function fieldFor(name, schema) {
    const wrap = el("label", { class: "webmcp-field" }, el("span", { class: "webmcp-field-label", text: name }));
    let input;
    if (schema.enum) {
        input = el("select", { class: "webmcp-field-input", "data-param": name });
        input.append(el("option", { value: "", text: "(unset)" }));
        schema.enum.forEach((v) => input.append(el("option", { value: v, text: String(v) })));
    } else if (schema.type === "boolean") {
        input = el("input", { type: "checkbox", class: "webmcp-field-checkbox", "data-param": name });
    } else if (schema.type === "integer" || schema.type === "number") {
        input = el("input", { type: "number", class: "webmcp-field-input", "data-param": name });
        if (schema.minimum != null) input.min = schema.minimum;
        if (schema.maximum != null) input.max = schema.maximum;
        if (schema.default != null) input.placeholder = String(schema.default);
    } else {
        input = el("input", { type: "text", class: "webmcp-field-input", "data-param": name });
        if (schema.default != null) input.placeholder = String(schema.default);
    }
    wrap.append(input);
    if (schema.description) wrap.append(el("span", { class: "webmcp-field-hint", text: schema.description }));
    return wrap;
}

function collectInput(form, schema) {
    const out = {};
    Object.entries(schema.properties || {}).forEach(([name, s]) => {
        const field = form.querySelector(`[data-param="${CSS.escape(name)}"]`);
        if (!field) return;
        if (s.type === "boolean") {
            out[name] = field.checked;
        } else if (s.type === "integer" || s.type === "number") {
            if (field.value !== "") out[name] = Number(field.value);
        } else if (field.value !== "") {
            out[name] = field.value;
        }
    });
    return out;
}

function renderConsole(pane, content, mc, defs) {
    pane.replaceChildren();
    pane.append(
        el("h2", { class: "webmcp-pane-title", text: content.console.title }),
        el("p", { class: "webmcp-pane-sub", text: content.console.sub })
    );

    const select = el("select", { class: "webmcp-tool-select" });
    select.append(el("option", { value: "", text: "— pick a tool —" }));
    defs.forEach((d) => select.append(el("option", { value: d.name, text: d.name })));

    const formHost = el("div", { class: "webmcp-run-form" });
    const outHost = el("div", { class: "webmcp-run-output" }, el("p", { class: "webmcp-run-empty", text: content.console.empty }));

    function renderForm(name) {
        formHost.replaceChildren();
        const def = defs.find((d) => d.name === name);
        if (!def) return;

        const form = el("form", { class: "webmcp-form" });
        Object.entries(def.inputSchema?.properties || {}).forEach(([pname, schema]) => {
            form.append(fieldFor(pname, schema));
        });

        const btnRow = el("div", { class: "webmcp-run-btns" });
        const runLocalBtn = el("button", { type: "button", class: "btn btn-primary btn-sm", text: content.console.runLocal });
        btnRow.append(runLocalBtn);

        // Gate on a surface that can actually service the call, not on the mere
        // presence of executeTool — the flag build exposes it on modelContext
        // too, but only modelContextTesting answers there.
        const surface = getExecSurface();
        let runBrowserBtn = null;
        if (surface) {
            runBrowserBtn = el("button", {
                type: "button",
                class: "btn btn-ghost btn-sm",
                text: content.console.runBrowser,
                title: (content.console.runBrowserHint || "") + ` (via ${surface.label})`,
            });
            btnRow.append(runBrowserBtn);
        }
        form.append(btnRow);
        formHost.append(form);

        const run = async (viaBrowser) => {
            const input = collectInput(form, def.inputSchema || {});
            outHost.replaceChildren(el("p", { class: "webmcp-run-pending", text: "Running…" }));
            let result;
            let via = null;
            try {
                if (viaBrowser) {
                    // Resolve the live tool so a name mismatch reports itself
                    // instead of silently executing nothing.
                    let tools = [];
                    if (surface.list) {
                        tools = (await withTimeout(Promise.resolve(surface.mc[surface.list]()), EXEC_TIMEOUT_MS)) || [];
                    } else if (mc && typeof mc.getTools === "function") {
                        tools = (await withTimeout(Promise.resolve(mc.getTools()), EXEC_TIMEOUT_MS)) || [];
                    }
                    const live = tools.find((t) => t.name === def.name);
                    if (!live && tools.length) {
                        throw new Error(
                            `"${def.name}" is not in the live registry.\nRegistered: ${tools.map((t) => t.name).join(", ")}`
                        );
                    }
                    // The flag build wants the name; the imperative API wants the tool.
                    const target = surface.byName ? def.name : (live || def.name);
                    const call = await executeViaBrowser(surface, target, input);
                    result = call.result;
                    // Short label: the point is which surface dispatched it. The
                    // exact call shape goes to the console for debugging.
                    via = `${surface.label}.executeTool()`;
                    console.debug(`[webmcp-lab] ran ${def.name} via ${surface.label}.executeTool${call.shapeLabel}`);
                    // Documented: null comes back when the tool triggered a navigation.
                    if (result == null) {
                        result = { content: [{ type: "text", text: "The browser returned null, which it does when a tool triggers a navigation. Nothing to display." }] };
                    }
                } else {
                    result = await def.execute(input, {});
                    via = "this page";
                }
            } catch (err) {
                const name = (err && err.name) || "Error";
                result = { content: [{ type: "text", text: `${name}: ${(err && err.message) || err}` }], isError: true };
            }
            renderOutput(result, via);
        };

        function renderOutput(result, via) {
            const text = result?.content?.[0]?.text ?? JSON.stringify(result);
            const len = text.length;
            const over = len > 1500;
            outHost.replaceChildren(
                el("div", { class: "webmcp-run-meta" },
                    el("span", { class: "webmcp-run-count" + (over ? " is-over" : ""), text: `${len} / 1500 chars` }),
                    result?.isError ? el("span", { class: "webmcp-run-error-flag", text: "isError: true" }) : null,
                    via ? el("span", { class: "webmcp-run-via", text: `ran via ${via}` }) : null
                ),
                el("pre", { class: "webmcp-run-pre", text })
            );
        }

        runLocalBtn.addEventListener("click", () => run(false));
        if (runBrowserBtn) runBrowserBtn.addEventListener("click", () => run(true));
    }

    select.addEventListener("change", () => {
        outHost.replaceChildren(el("p", { class: "webmcp-run-empty", text: content.console.empty }));
        renderForm(select.value);
    });

    pane.append(select, formHost, el("h3", { class: "webmcp-run-output-label", text: content.console.outputLabel }), outHost);
}

/* ---------- entry ---------- */

export function initWebMcpLab(root, { content, profile }) {
    root.innerHTML = "";

    const header = el("header", { class: "webmcp-lab-header" },
        el("p", { class: "webmcp-lab-tag", text: content.intro.tag }),
        el("h1", { class: "webmcp-lab-title", text: content.intro.title }),
        el("p", { class: "webmcp-lab-sub", text: content.intro.sub })
    );

    const grid = el("div", { class: "webmcp-lab-grid" });
    const registryPane = el("section", { class: "webmcp-pane", "aria-label": "Live tool registry" });
    const consolePane = el("section", { class: "webmcp-pane", "aria-label": "Run a tool" });
    grid.append(registryPane, consolePane);

    const setupPane = el("section", { class: "webmcp-pane webmcp-pane--wide", "aria-label": "See it yourself" });

    // The working tools lead. The explainer sits last, collapsed, for whoever
    // wants to know what WebMCP is after seeing it do something.
    const diagramPane = el("section", {
        class: "webmcp-pane webmcp-pane--wide webmcp-pane--collapsible",
        "aria-label": "What WebMCP is",
    });

    const foot = el("p", { class: "webmcp-lab-foot", text: content.footNote });

    root.append(header, grid, setupPane, diagramPane, foot);

    const mc = getModelContext();
    // Registry shows every tool in the set; the console only offers the ones
    // this page actually registered, so nothing in it can navigate away or
    // fail for want of a widget that lives on another page.
    const allDefs = defineTools({ profile, scope: PAGE_SCOPE });
    const defs = allDefs.filter((d) => d.scopes.includes(PAGE_SCOPE));

    let toolchangeHandler = null;

    async function refreshRegistry() {
        let tools = [];
        if (mc && typeof mc.getTools === "function") {
            try {
                tools = await Promise.resolve(mc.getTools());
            } catch (_) {
                tools = [];
            }
        }
        renderRegistry(registryPane, content, mc, allDefs, tools);
    }

    refreshRegistry();
    renderConsole(consolePane, content, mc, defs);
    renderSetup(setupPane, content);
    renderDiagram(diagramPane, content);

    if (mc && typeof mc.addEventListener === "function") {
        toolchangeHandler = () => refreshRegistry();
        mc.addEventListener("toolchange", toolchangeHandler);
    }

    return {
        destroy() {
            if (mc && toolchangeHandler && typeof mc.removeEventListener === "function") {
                mc.removeEventListener("toolchange", toolchangeHandler);
            }
            root.replaceChildren();
        },
    };
}
