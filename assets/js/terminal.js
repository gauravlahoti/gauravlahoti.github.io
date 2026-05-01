// terminal.js — interactive command interface.
// Contract:
//   initTerminal(root: HTMLElement, registry: { commands: Cmd[] })
//     → { focus(), destroy() }
//
// Each registry entry: { name, description, action, target?, hidden? }
// Supported actions: scroll · download · clear · help · easteregg
// Easter-egg dispatches `portfolio:flare` on document; hero listens.

const HISTORY_MAX = 50;

export function initTerminal(root, registry) {
    const commands = (registry && Array.isArray(registry.commands)) ? registry.commands : [];
    if (!root) return { focus() {}, destroy() {} };

    const input = root.querySelector(".terminal-input");
    const history = root.querySelector(".terminal-history");
    if (!input || !history) return { focus() {}, destroy() {} };

    const visible = commands.filter(c => !c.hidden);
    const byName = new Map(commands.map(c => [c.name, c]));

    /* ----- action dispatch table ---------------------------------- */

    const actions = {
        scroll(cmd) {
            const target = cmd.target && document.querySelector(cmd.target);
            if (!target) return out(`target ${cmd.target || ""} not found`, "err");
            const lenis = window.__lenis;
            if (lenis && typeof lenis.scrollTo === "function") {
                lenis.scrollTo(target, { offset: -64, duration: 1.1 });
            } else {
                target.scrollIntoView({ behavior: "smooth", block: "start" });
            }
            out(`navigating to ${cmd.target}`);
        },
        download(cmd) {
            if (!cmd.target) return out("no file target", "err");
            const a = document.createElement("a");
            a.href = cmd.target;
            a.download = cmd.target.split("/").pop();
            document.body.appendChild(a);
            a.click();
            a.remove();
            out(`downloading ${a.download}`);
        },
        clear() {
            history.replaceChildren();
        },
        help() {
            const lines = visible.map(c =>
                `<span class="terminal-help-name">${escapeHtml(c.name)}</span>${escapeHtml(c.description || "")}`
            );
            outHTML(lines.join("\n"));
        },
        easteregg() {
            document.dispatchEvent(new CustomEvent("portfolio:flare"));
            out("// hire signal acknowledged. flaring agent mesh.");
        },
    };

    /* ----- output helpers ----------------------------------------- */

    function echoCmd(text) {
        const el = document.createElement("div");
        el.className = "terminal-line terminal-line-cmd";
        el.textContent = text;
        history.appendChild(el);
        scrollToBottom();
    }

    function out(text, kind = "out") {
        const el = document.createElement("div");
        el.className = `terminal-line terminal-line-${kind}`;
        el.textContent = text;
        history.appendChild(el);
        scrollToBottom();
    }

    function outHTML(html) {
        const lines = html.split("\n");
        const frag = document.createDocumentFragment();
        for (const line of lines) {
            const el = document.createElement("div");
            el.className = "terminal-line terminal-line-out";
            el.innerHTML = line;
            frag.appendChild(el);
        }
        history.appendChild(frag);
        scrollToBottom();
    }

    function scrollToBottom() {
        root.scrollTop = root.scrollHeight;
    }

    /* ----- run a command ------------------------------------------ */

    function run(raw) {
        const trimmed = raw.trim();
        if (!trimmed) return;
        echoCmd(trimmed);
        const cmd = byName.get(trimmed) || byName.get(trimmed.toLowerCase());
        if (!cmd) {
            out(`command not found: ${trimmed}. type 'help'`, "err");
            return;
        }
        const handler = actions[cmd.action];
        if (!handler) {
            out(`action '${cmd.action}' not supported`, "err");
            return;
        }
        try { handler(cmd); }
        catch (err) { out(`error: ${err && err.message ? err.message : err}`, "err"); }
    }

    /* ----- history + tab cycle ------------------------------------ */

    const hist = [];
    let histIdx = -1;
    let tabPrefix = null;
    let tabMatches = [];
    let tabIdx = 0;

    function pushHistory(line) {
        if (!line) return;
        if (hist[hist.length - 1] !== line) hist.push(line);
        if (hist.length > HISTORY_MAX) hist.splice(0, hist.length - HISTORY_MAX);
        histIdx = hist.length;
    }

    function resetTab() { tabPrefix = null; tabMatches = []; tabIdx = 0; }

    /* ----- key handlers ------------------------------------------- */

    function onKeydown(e) {
        if (e.key === "Enter") {
            const value = input.value;
            run(value);
            pushHistory(value.trim());
            input.value = "";
            resetTab();
            e.preventDefault();
            return;
        }
        if (e.key === "Tab") {
            e.preventDefault();
            const current = input.value;
            if (tabPrefix === null || !current.startsWith(tabPrefix)) {
                tabPrefix = current;
                tabMatches = visible.filter(c => c.name.startsWith(tabPrefix));
                tabIdx = 0;
            } else {
                tabIdx = (tabIdx + 1) % Math.max(tabMatches.length, 1);
            }
            if (tabMatches.length > 0) {
                input.value = tabMatches[tabIdx].name;
                input.setSelectionRange(input.value.length, input.value.length);
            }
            return;
        }
        if (e.key === "ArrowUp") {
            if (hist.length === 0) return;
            histIdx = Math.max(0, histIdx - 1);
            input.value = hist[histIdx] || "";
            input.setSelectionRange(input.value.length, input.value.length);
            resetTab();
            e.preventDefault();
            return;
        }
        if (e.key === "ArrowDown") {
            if (hist.length === 0) return;
            histIdx = Math.min(hist.length, histIdx + 1);
            input.value = hist[histIdx] || "";
            input.setSelectionRange(input.value.length, input.value.length);
            resetTab();
            e.preventDefault();
            return;
        }
        if (e.key === "Escape") {
            input.blur();
            e.preventDefault();
            return;
        }
        // any other key → dirty the tab cycle
        resetTab();
    }

    /* ----- focus behavior ----------------------------------------- */

    function onRootClick(e) {
        // tap or click anywhere in the terminal box → focus the input
        if (e.target === input) return;
        input.focus({ preventScroll: true });
    }

    input.addEventListener("keydown", onKeydown);
    root.addEventListener("click", onRootClick);

    /* ----- public API --------------------------------------------- */

    return {
        focus() { input.focus({ preventScroll: true }); },
        destroy() {
            input.removeEventListener("keydown", onKeydown);
            root.removeEventListener("click", onRootClick);
        },
    };
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
