// agent-widget.js — bottom-right "Ask my agent" FAB + slide-in panel.
// Talks to a Cloud Run ADK agent over SSE (POST /api/agent-chat).
// Pre-warms the container on FAB-open to mask cold-start. Renders plain
// text only — no Markdown, no innerHTML for assistant content.

const STARTERS = [
    "What has Gaurav shipped in production?",
    "Walk me through the Fiber Broadband Fabric.",
    "What does he write about on LinkedIn lately?",
    "Is he open to engagements?",
];

const ALLOWED_HOSTS = ["linkedin.com", "github.com", "gauravlahoti.github.io", "topmate.io"];
const URL_RE = /https?:\/\/[^\s<>()\[\]]+/gi;

const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

let warmedThisSession = false;

export function initAgentWidget(root, profile) {
    const links = (profile && profile.links) || {};
    const apiUrl = links.agentApi;
    const warmUrl = links.agentWarm;
    if (!apiUrl) {
        console.warn("[agent-widget] profile.links.agentApi missing");
        return null;
    }

    // Generate a fresh sessionId per page load (not persisted to localStorage).
    const sessionId = uuidv4();
    const messages = []; // [{role: "user"|"assistant", content: "..."}]

    const dom = renderShell(root);
    const fab = dom.fab;
    const panel = dom.panel;
    const transcript = dom.transcript;
    const input = dom.input;
    const sendBtn = dom.sendBtn;
    const liveRegion = dom.liveRegion;
    const promptsEl = dom.prompts;
    let isOpen = false;
    let isPending = false; // true while a response is streaming

    renderStarters();

    fab.addEventListener("click", togglePanel);
    dom.closeBtn.addEventListener("click", closePanel);
    sendBtn.addEventListener("click", sendCurrent);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendCurrent();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            sendCurrent();
        }
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && isOpen) {
            e.preventDefault();
            closePanel();
        }
    });

    function togglePanel() {
        if (isOpen) closePanel(); else openPanel();
    }
    function openPanel() {
        isOpen = true;
        panel.classList.add("is-open");
        panel.setAttribute("aria-hidden", "false");
        fab.setAttribute("aria-expanded", "true");
        // Pre-warm Cloud Run on first open of the session.
        if (!warmedThisSession && warmUrl) {
            warmedThisSession = true;
            fetch(warmUrl, { method: "GET", mode: "cors", cache: "no-store" })
                .catch(() => { /* best-effort; failure is harmless */ });
        }
        requestAnimationFrame(() => input.focus());
    }
    function closePanel() {
        isOpen = false;
        panel.classList.remove("is-open");
        panel.setAttribute("aria-hidden", "true");
        fab.setAttribute("aria-expanded", "false");
        fab.focus();
    }

    function renderStarters() {
        promptsEl.replaceChildren();
        const heading = document.createElement("p");
        heading.className = "agent-prompts-head";
        heading.textContent = "Try asking…";
        promptsEl.appendChild(heading);
        STARTERS.forEach((p) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "agent-prompt-chip";
            btn.textContent = p;
            btn.addEventListener("click", () => {
                input.value = p;
                input.focus();
            });
            promptsEl.appendChild(btn);
        });
    }

    async function sendCurrent() {
        if (isPending) return;
        const text = (input.value || "").trim();
        if (!text) return;
        if (text.length > 1000) {
            appendSystem(
                "That message is a bit long for me — could you trim it under ~1000 characters?",
            );
            return;
        }
        // Hide the starter prompts after the first send.
        promptsEl.classList.add("is-hidden");
        input.value = "";
        sendBtn.disabled = true;
        isPending = true;

        appendUser(text);
        messages.push({ role: "user", content: text });

        const assistant = appendAssistantPlaceholder();
        const stages = startLoadingStages(assistant);

        try {
            await streamAgent({
                apiUrl,
                sessionId,
                messages,
                onDelta: (delta) => {
                    stages.cancel();
                    appendDelta(assistant, delta);
                },
                onDone: (full) => {
                    stages.cancel();
                    if (!full) {
                        // No content streamed — show a friendly message.
                        appendDelta(assistant, "(no response)");
                    }
                    if (full) {
                        // Linkify allowlisted URLs in the assembled text.
                        finalizeAssistant(assistant, full);
                        messages.push({ role: "assistant", content: full });
                        liveRegion.textContent = stripUrls(full).slice(0, 240);
                    }
                },
                onError: (msg) => {
                    stages.cancel();
                    appendDelta(assistant, msg);
                },
            });
        } finally {
            sendBtn.disabled = false;
            isPending = false;
        }
    }

    function appendUser(text) {
        const li = document.createElement("li");
        li.className = "agent-message agent-message-user";
        const p = document.createElement("p");
        p.textContent = text;
        li.appendChild(p);
        transcript.appendChild(li);
        scrollToEnd();
    }

    function appendSystem(text) {
        const li = document.createElement("li");
        li.className = "agent-message agent-message-system";
        const p = document.createElement("p");
        p.textContent = text;
        li.appendChild(p);
        transcript.appendChild(li);
        scrollToEnd();
    }

    function appendAssistantPlaceholder() {
        const li = document.createElement("li");
        li.className = "agent-message agent-message-assistant";
        const p = document.createElement("p");
        p.className = "agent-message-text";
        p.textContent = "";
        li.appendChild(p);
        transcript.appendChild(li);
        scrollToEnd();
        return li;
    }

    function appendDelta(li, delta) {
        const p = li.querySelector(".agent-message-text");
        if (!p) return;
        // Plain textContent — no markdown, no HTML.
        p.textContent = (p.textContent || "") + delta;
        scrollToEnd();
    }

    function finalizeAssistant(li, fullText) {
        const p = li.querySelector(".agent-message-text");
        if (!p) return;
        p.replaceChildren();
        renderTextWithLinks(p, fullText);
    }

    function scrollToEnd() {
        // Scroll the body, not the input. Use rAF so layout settles.
        requestAnimationFrame(() => {
            dom.body.scrollTop = dom.body.scrollHeight;
        });
    }

    return { open: openPanel, close: closePanel };
}

// --- helpers ----------------------------------------------------------------

function renderShell(root) {
    root.classList.add("agent-widget-host");
    root.innerHTML = ""; // root is our owned div

    const fab = document.createElement("button");
    fab.type = "button";
    fab.className = "agent-fab" + (REDUCE_MOTION ? "" : " agent-fab-pulse");
    fab.setAttribute("aria-label", "Ask my agent (experimental AI)");
    fab.setAttribute("aria-expanded", "false");
    fab.title = "Ask my agent (experimental AI)";
    fab.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>
            <circle cx="9" cy="11" r="0.9" fill="currentColor" stroke="none"/>
            <circle cx="13" cy="11" r="0.9" fill="currentColor" stroke="none"/>
            <circle cx="17" cy="11" r="0.9" fill="currentColor" stroke="none"/>
        </svg>
        <span>Ask my agent</span>
    `;

    const panel = document.createElement("section");
    panel.className = "agent-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "agent-panel-title");
    panel.setAttribute("aria-hidden", "true");

    const head = document.createElement("header");
    head.className = "agent-panel-head";
    head.innerHTML = `
        <p class="agent-panel-eyebrow">// agent::experimental</p>
        <h3 id="agent-panel-title" class="agent-panel-title">Ask my agent</h3>
        <button type="button" class="agent-panel-close" aria-label="Close agent">×</button>
    `;
    const closeBtn = head.querySelector(".agent-panel-close");

    const body = document.createElement("div");
    body.className = "agent-panel-body";

    const prompts = document.createElement("div");
    prompts.className = "agent-prompts";

    const transcript = document.createElement("ul");
    transcript.className = "agent-transcript";
    transcript.setAttribute("role", "list");

    body.appendChild(prompts);
    body.appendChild(transcript);

    const inputRow = document.createElement("form");
    inputRow.className = "agent-input-row";
    inputRow.addEventListener("submit", (e) => e.preventDefault());
    const input = document.createElement("textarea");
    input.className = "agent-input";
    input.rows = 1;
    input.maxLength = 1000;
    input.placeholder = "Ask about Gaurav's work…";
    input.setAttribute("aria-label", "Message");
    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.className = "agent-send";
    sendBtn.setAttribute("aria-label", "Send");
    sendBtn.innerHTML = `
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 8 L14 2 L10 14 L8 9 Z"/>
        </svg>
    `;
    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);

    const foot = document.createElement("footer");
    foot.className = "agent-panel-foot";
    foot.innerHTML = `Powered by Gemini · model may be wrong · <a href="https://www.linkedin.com/in/glahoti/" target="_blank" rel="noopener noreferrer">contact Gaurav on LinkedIn</a>`;

    const liveRegion = document.createElement("div");
    liveRegion.className = "agent-live";
    liveRegion.setAttribute("aria-live", "polite");
    liveRegion.setAttribute("aria-atomic", "true");

    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(inputRow);
    panel.appendChild(foot);
    panel.appendChild(liveRegion);

    root.appendChild(fab);
    root.appendChild(panel);

    return {
        fab, panel, body, head, closeBtn,
        prompts, transcript, input, sendBtn, liveRegion,
    };
}

function startLoadingStages(assistantLi) {
    const p = assistantLi.querySelector(".agent-message-text");
    if (!p) return { cancel() {} };
    let stage = 0;
    p.textContent = "Connecting to agent…";
    const t1 = setTimeout(() => {
        if (p.textContent.startsWith("Connecting")) {
            stage = 1;
            p.textContent = "Spinning up the model — first request takes a moment.";
        }
    }, 3000);
    const t2 = setTimeout(() => {
        if (stage <= 1 && (p.textContent.startsWith("Spinning") || p.textContent.startsWith("Connecting"))) {
            p.textContent =
                "Still warming up. If this hangs, reach me on LinkedIn (https://www.linkedin.com/in/glahoti/).";
        }
    }, 10000);
    return {
        cancel() {
            clearTimeout(t1);
            clearTimeout(t2);
            // Clear the loading copy so streaming output starts fresh.
            if (
                p.textContent.startsWith("Connecting") ||
                p.textContent.startsWith("Spinning") ||
                p.textContent.startsWith("Still warming")
            ) {
                p.textContent = "";
            }
        },
    };
}

async function streamAgent({ apiUrl, sessionId, messages, onDelta, onDone, onError }) {
    let response;
    try {
        response = await fetch(apiUrl, {
            method: "POST",
            mode: "cors",
            cache: "no-store",
            headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
            body: JSON.stringify({ sessionId, messages }),
        });
    } catch (err) {
        onError("I couldn't reach the agent. You appear to be offline, or the service is down. Try LinkedIn instead: https://www.linkedin.com/in/glahoti/");
        onDone("");
        return;
    }
    if (!response.ok) {
        let detail;
        try { detail = (await response.json()).error; } catch { detail = null; }
        if (response.status === 429) {
            onError(detail || "I've been chatting a lot — try again in a few minutes, or reach me on LinkedIn.");
        } else if (response.status >= 500) {
            onError("The agent hit a server error. Try again in a moment, or reach me on LinkedIn for anything urgent.");
        } else {
            onError(detail || `Request failed (${response.status}).`);
        }
        onDone("");
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let full = "";
    let done = false;

    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            // SSE frames are separated by blank lines.
            let idx;
            while ((idx = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                const line = frame.split("\n").find((l) => l.startsWith("data:"));
                if (!line) continue;
                const payload = line.slice(5).trim();
                if (!payload) continue;
                let evt;
                try { evt = JSON.parse(payload); } catch { continue; }
                if (evt.delta) {
                    full += evt.delta;
                    onDelta(evt.delta);
                }
                if (evt.done) {
                    done = true;
                    break;
                }
            }
            if (done) break;
        }
    } catch (err) {
        onError("The connection dropped. Try again, or reach me on LinkedIn.");
    }
    onDone(full);
}

function renderTextWithLinks(container, text) {
    let last = 0;
    URL_RE.lastIndex = 0;
    let match;
    // eslint-disable-next-line no-cond-assign
    while ((match = URL_RE.exec(text))) {
        const url = match[0];
        const start = match.index;
        if (start > last) {
            container.appendChild(document.createTextNode(text.slice(last, start)));
        }
        const host = (url.split("//")[1] || "").split("/")[0].toLowerCase();
        const allowed = ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h));
        if (allowed) {
            const a = document.createElement("a");
            a.href = url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = url;
            container.appendChild(a);
        } else {
            container.appendChild(document.createTextNode(url));
        }
        last = start + url.length;
    }
    if (last < text.length) {
        container.appendChild(document.createTextNode(text.slice(last)));
    }
}

function stripUrls(text) {
    return text.replace(URL_RE, "").trim();
}

function uuidv4() {
    if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    // Fallback (very old browsers)
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
