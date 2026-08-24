// webmcp-lab.js — Agent-Ready Web lab engine
//
// Two panes. The registry pane reads document.modelContext.getTools() live,
// so it shows exactly what the browser actually sees — not a hardcoded copy
// of the tool list. The console pane runs each tool's own execute() code
// directly (imported from webmcp.js), so it works in every browser even
// without WebMCP support; where the API IS present, a second button routes
// the same call through document.modelContext.executeTool() so the
// difference between "the page ran this" and "the browser ran this" is
// visible rather than hidden.
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

/* ---------- registry pane ---------- */

function badgeRow(def, labels) {
    const row = el("div", { class: "webmcp-badges" });
    const a = def.annotations || {};
    if (a.readOnlyHint) row.append(el("span", { class: "webmcp-badge webmcp-badge-ro", text: labels.readOnly }));
    else row.append(el("span", { class: "webmcp-badge webmcp-badge-write", text: labels.write }));
    return row;
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
                el("code", { class: "webmcp-flag", text: u.flagLabel }),
                el("p", { class: "webmcp-unsupported-hint", text: u.flagHint })
            )
        );
        return;
    }

    const list = el("ul", { class: "webmcp-registry-list" });
    const byName = new Map((tools || []).map((t) => [t.name, t]));
    defs.forEach((def) => {
        const live = byName.get(def.name);
        const params = Object.keys(def.inputSchema?.properties || {});
        const item = el("li", { class: "webmcp-registry-item" },
            el("div", { class: "webmcp-registry-head" },
                el("code", { class: "webmcp-tool-name", text: def.name }),
                badgeRow(def, content.registry.badges)
            ),
            el("p", { class: "webmcp-tool-desc", text: (live || def).description }),
            params.length ? el("p", { class: "webmcp-tool-params", text: "params: " + params.join(", ") }) : null
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

        let runBrowserBtn = null;
        if (mc && typeof mc.executeTool === "function") {
            runBrowserBtn = el("button", { type: "button", class: "btn btn-ghost btn-sm", text: content.console.runBrowser, title: content.console.runBrowserHint });
            btnRow.append(runBrowserBtn);
        }
        form.append(btnRow);
        formHost.append(form);

        const run = async (viaBrowser) => {
            const input = collectInput(form, def.inputSchema || {});
            outHost.replaceChildren(el("p", { class: "webmcp-run-pending", text: "Running…" }));
            let result;
            try {
                if (viaBrowser) {
                    const tools = await Promise.resolve(mc.getTools());
                    const live = (tools || []).find((t) => t.name === def.name);
                    if (!live) throw new Error("Tool not found in the live registry.");
                    try {
                        result = await mc.executeTool(live, input, {});
                    } catch (_) {
                        result = await mc.executeTool(live, JSON.stringify(input), {});
                    }
                } else {
                    result = await def.execute(input, {});
                }
            } catch (err) {
                result = { content: [{ type: "text", text: `Error: ${(err && err.message) || err}` }], isError: true };
            }
            renderOutput(result);
        };

        function renderOutput(result) {
            const text = result?.content?.[0]?.text ?? JSON.stringify(result);
            const len = text.length;
            const over = len > 1500;
            outHost.replaceChildren(
                el("div", { class: "webmcp-run-meta" },
                    el("span", { class: "webmcp-run-count" + (over ? " is-over" : ""), text: `${len} / 1500 chars` }),
                    result?.isError ? el("span", { class: "webmcp-run-error-flag", text: "isError: true" }) : null
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

    const foot = el("p", { class: "webmcp-lab-foot", text: content.footNote });

    root.append(header, grid, foot);

    const mc = getModelContext();
    const defs = defineTools({ profile, scope: "lab-agent-ready" }).filter((d) => d.scopes.includes("lab-agent-ready"));

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
        renderRegistry(registryPane, content, mc, defs, tools);
    }

    refreshRegistry();
    renderConsole(consolePane, content, mc, defs);

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
