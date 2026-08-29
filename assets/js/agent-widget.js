// agent-widget.js — bottom-right "Ask my agent" FAB + slide-in panel.
// Talks to a Cloud Run ADK agent over SSE (POST /api/agent-chat).
// Spec #24 adds: typing caret, inline [N] citation superscripts, follow-up
// chips, Topmate/LinkedIn CTA button, scroll nudge, transparency modal,
// and mid-stream network-error retry. All gated by FEATURES flags below.

// Spec 48: this module's own `?v=` (set by whichever boot path imported it —
// main.js or agents-page.js) is reused for its own dynamic import of
// agent-voice.js, so that lazy-loaded module shares agent-widget.js's
// cache-bust rather than being pinned to whatever the browser cached first.
// Same pattern as agents-page.js's _selfV/_vq.
const _selfV = new URL(import.meta.url).searchParams.get("v") || "";
const _vq = (path) => _selfV ? `${path}?v=${_selfV}` : path;

const FEATURES = Object.freeze({
    citations:       true,
    suggestions:     true,
    cta:             true,
    typingCursor:    true,
    scrollNudge:     false,
    explainerDialog: true,
    thinking:        true,
    voiceInput:      true,
});

const ALLOWED_HOSTS = ["linkedin.com", "github.com", "gauravlahoti.dev", "gauravlahoti.github.io", "topmate.io",
                       "credly.com", "cp.certmetrics.com", "learn.microsoft.com"];
const URL_RE = /https?:\/\/[^\s<>()\[\]]+/gi;

const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

let warmedThisSession = false;

// Read the self-asserted identity from a prior Google sign-in, if one was ever
// persisted under this key. Nothing on the site writes this key anymore (the
// resume gate that used to was retired 2026-06-10), so this now always returns
// null for any visitor going forward — kept only so historical values already
// in a returning visitor's localStorage don't error out before their TTL lapses.
// Returned value is {sub, email} if present and within the 30-day TTL, else null.
function readIdentity() {
    try {
        const raw = localStorage.getItem("resumeGateIdentity_v1");
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj?.sub || !obj?.email || !obj?.at) return null;
        if (Date.now() - obj.at > 30 * 24 * 60 * 60 * 1000) return null; // 30d TTL
        return { sub: obj.sub, email: obj.email };
    } catch (_) { return null; }
}

export function initAgentWidget(root, profile, sessionId) {
    const links = (profile && profile.links) || {};
    const apiUrl = links.agentApi;
    const warmUrl = links.agentWarm;
    // Spec 48: same host, sibling route — not a second config key.
    const transcribeApiUrl = apiUrl ? apiUrl.replace(/\/api\/agent-chat$/, "/api/agent-transcribe") : apiUrl;
    if (!apiUrl) {
        console.warn("[agent-widget] profile.links.agentApi missing");
        return null;
    }

    // Generated once in main.js at page load and shared with the pageview
    // beacon, so page_views.session_id and agent_interactions.session_id can
    // agree on the same visitor journey. Not persisted to localStorage — a
    // fresh id every page load, same as before.
    const messages = []; // [{role: "user"|"assistant", content: "..."}]
    const identity = readIdentity(); // null if visitor hasn't signed in for resume gate
    const starters = Array.isArray(profile && profile.agentPrompts) ? profile.agentPrompts : [];
    const actions  = Array.isArray(profile && profile.agentActions) ? profile.agentActions : [];
    const agentCopy = (profile && profile.agentCopy) || {};
    const agentExplainer = (profile && profile.agentExplainer) || {};
    const agentIntro = (profile && profile.agentIntro) || null;

    const dom = renderShell(root, agentExplainer);
    const fab = dom.fab;
    const panel = dom.panel;
    const transcript = dom.transcript;
    const input = dom.input;
    const sendBtn = dom.sendBtn;
    const micBtn = dom.micBtn;
    const voiceStatus = dom.voiceStatus;
    const liveRegion = dom.liveRegion;
    const promptsEl = dom.prompts;
    let isOpen = false;
    let isMinimized = false;
    let isPending = false; // true while a response is streaming
    let abortController = null; // live only while a turn is streaming
    let wasStopped = false; // set by stopStreaming(), read in onDone
    let sessionWarmed = false; // true after the first streamed token this session — gates the cold-start loading copy
    let panelEverOpened = false; // for scroll nudge — flipped on first open
    let introRendered = false; // guards one-shot intro stream on first open
    let nudgeIo = null; // IntersectionObserver for scroll nudge
    let voiceEngine = null; // lazy-loaded agent-voice.js handle, set on first mic tap
    let micLoading = false; // guards a double-click during the lazy import

    // Tooltip: show after 5s, auto-hide after 10s; cancelled on first open.
    let _tooltipShowTimer = null;
    let _tooltipHideTimer = null;
    function _cancelTooltip() {
        clearTimeout(_tooltipShowTimer);
        clearTimeout(_tooltipHideTimer);
        if (dom.tooltip) dom.tooltip.classList.remove("agent-fab-tooltip--visible");
    }
    if (dom.tooltip && !REDUCE_MOTION && matchMedia("(min-width: 768px)").matches) {
        _tooltipShowTimer = setTimeout(() => {
            dom.tooltip.classList.add("agent-fab-tooltip--visible");
            _tooltipHideTimer = setTimeout(() => {
                dom.tooltip.classList.remove("agent-fab-tooltip--visible");
            }, 10000);
        }, 5000);
    }

    if (agentIntro?.text) {
        promptsEl.classList.add("is-hidden"); // hide immediately; intro streams on first open
    } else {
        renderStarters();
    }
    setupExplainerModal(dom, agentExplainer);
    setupScrollNudge();

    // Spec 48: hide the mic outright (not disabled) when the browser lacks
    // the APIs it needs — a trivial sync check, so it doesn't need the lazy
    // agent-voice.js import just to decide whether to render.
    if (FEATURES.voiceInput && !(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function" && typeof window.MediaRecorder === "function")) {
        micBtn.classList.add("is-hidden");
    }

    fab.addEventListener("click", togglePanel);
    dom.closeBtn.addEventListener("click", closePanel);
    dom.expandBtn.addEventListener("click", toggleExpand);
    dom.minimizeBtn.addEventListener("click", toggleMinimize);
    // Click on the minimized header bar to restore
    dom.head.addEventListener("click", (e) => {
        if (isMinimized && !e.target.closest("button")) restore();
    });

    // Spec 22: drag-to-dismiss on the bottom-sheet drag handle (mobile only).
    setupDragToDismiss(panel, dom.dragZone, closePanel);

    // Spec 26: keep the panel sized to the actually-visible viewport so the
    // soft keyboard doesn't cover the input row. dvh handles URL-bar
    // collapse on iOS Safari, but the keyboard is invisible to dvh — the
    // visualViewport API is the only signal that fires when it opens.
    trackVisualViewport(panel);

    // Prevent wheel events from leaking to the page when there is content to scroll.
    panel.addEventListener("wheel", (e) => {
        const b = dom.body;
        const atTop    = b.scrollTop <= 0;
        const atBottom = b.scrollTop + b.clientHeight >= b.scrollHeight - 1;
        if (!(atTop && e.deltaY < 0) && !(atBottom && e.deltaY > 0)) {
            e.stopPropagation();
        }
    }, { passive: true });

    sendBtn.addEventListener("click", () => {
        if (sendBtn.dataset.mode === "stop") stopStreaming();
        else sendCurrent();
    });
    if (FEATURES.voiceInput) {
        micBtn.addEventListener("click", () => {
            if (isPending) return; // send button is a stop control mid-stream; don't touch the composer
            if (micBtn.dataset.mode === "recording") {
                voiceEngine && voiceEngine.stop();
            } else if (micBtn.dataset.mode === "idle") {
                startVoiceInput();
            }
        });
    }
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
    input.addEventListener("input", autoGrowInput);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && isOpen) {
            e.preventDefault();
            if (isPending) stopStreaming();
            else closePanel();
        }
    });

    // Sets the send button's icon/behaviour. "stop" while a turn is
    // streaming, "send" otherwise — the button never disables so a visitor
    // can always cancel.
    function setSendMode(mode) {
        sendBtn.dataset.mode = mode;
        sendBtn.setAttribute("aria-label", mode === "stop" ? "Stop generating" : "Send");
    }

    function stopStreaming() {
        if (!isPending || !abortController) return;
        wasStopped = true;
        abortController.abort();
        liveRegion.textContent = "Stopped.";
    }

    // Spec 48: mirrors setSendMode's shape for the mic button's three
    // states. "recording" and "busy" both get an aria-label announcing
    // themselves through liveRegion so a screen-reader user knows the mic
    // is live without having to poll it.
    let recordStartedAt = 0;
    let recordTickTimer = null;
    function setMicMode(mode) {
        micBtn.dataset.mode = mode === "recording" ? "recording" : mode === "busy" ? "busy" : "idle";
        micBtn.setAttribute("aria-label", mode === "recording" ? "Stop recording" : mode === "busy" ? "Transcribing" : "Ask by voice");
        clearInterval(recordTickTimer);
        recordTickTimer = null;
        if (mode === "recording") {
            recordStartedAt = Date.now();
            voiceStatus.classList.remove("is-hidden");
            voiceStatus.textContent = "Listening… 0:00";
            recordTickTimer = setInterval(() => {
                const secs = Math.floor((Date.now() - recordStartedAt) / 1000);
                voiceStatus.textContent = `Listening… 0:${String(secs).padStart(2, "0")}`;
            }, 1000);
        } else if (mode === "busy") {
            voiceStatus.classList.remove("is-hidden");
            voiceStatus.textContent = "Transcribing…";
        } else {
            voiceStatus.classList.add("is-hidden");
        }
    }

    // Lazy-imports agent-voice.js on first use so MediaRecorder code never
    // ships in the initial page payload (matches how main.js defers this
    // whole module until idle).
    async function startVoiceInput() {
        if (micLoading) return;
        if (!voiceEngine) {
            micLoading = true;
            try {
                const mod = await import(_vq("./agent-voice.js"));
                if (!mod.isVoiceSupported()) {
                    // Shouldn't happen — the button is hidden when unsupported —
                    // but guards a race between render and the capability check.
                    micBtn.classList.add("is-hidden");
                    return;
                }
                voiceEngine = mod.initVoiceInput({
                    apiUrl: transcribeApiUrl,
                    sessionId,
                    onStateChange: setMicMode,
                    onTranscript: (text) => prefillComposer(text),
                    onError: (message) => {
                        voiceStatus.classList.remove("is-hidden");
                        voiceStatus.textContent = message;
                        liveRegion.textContent = message;
                        setTimeout(() => {
                            if (micBtn.dataset.mode === "idle") voiceStatus.classList.add("is-hidden");
                        }, 4000);
                    },
                });
            } catch (_) {
                voiceStatus.classList.remove("is-hidden");
                voiceStatus.textContent = "Voice input failed to load.";
                return;
            } finally {
                micLoading = false;
            }
        }
        voiceEngine.start();
    }

    // Grows the composer to fit wrapped content, up to the CSS max-height
    // (120px) on .agent-input — past that, the existing max-height + the
    // textarea's default overflow:auto take over and it scrolls internally
    // instead of growing further, so this can never push the panel's other
    // controls around. Resetting to "auto" first (rather than only ever
    // growing) is what lets it shrink back down when text is deleted or the
    // composer is cleared after send.
    function autoGrowInput() {
        input.style.height = "auto";
        input.style.height = input.scrollHeight + "px";
    }

    // Sets the composer text and focuses it without sending. Shared by the
    // action chips and (spec 45) WebMCP's draft_note_to_gaurav tool — a real
    // human keystroke is always required to actually send. A direct .value
    // assignment never fires an "input" event, so this must call
    // autoGrowInput() itself rather than relying on the input listener below.
    function prefillComposer(text) {
        if (isPending) return false;
        const s = String(text || "");
        input.value = s + (s.endsWith(" ") ? "" : " ");
        autoGrowInput();
        input.focus();
        const len = input.value.length;
        try { input.setSelectionRange(len, len); } catch (_) { /* ignore */ }
        return true;
    }

    function togglePanel() {
        if (isOpen) {
            if (isMinimized) restore(); else closePanel();
        } else {
            openPanel();
        }
    }
    function toggleMinimize() {
        if (isMinimized) restore(); else minimize();
    }
    function minimize() {
        isMinimized = true;
        panel.classList.add("is-minimized");
        dom.minimizeBtn.setAttribute("aria-label", "Restore panel");
        dom.minimizeBtn.title = "Restore";
    }
    function restore() {
        isMinimized = false;
        panel.classList.remove("is-minimized");
        dom.minimizeBtn.setAttribute("aria-label", "Minimize panel");
        dom.minimizeBtn.title = "Minimize";
        requestAnimationFrame(() => { input.focus(); syncScrollHint(); });
    }
    function toggleExpand() {
        // If minimized, restore the panel to normal view first
        if (isMinimized) { restore(); return; }
        const expanded = panel.classList.toggle("is-expanded");
        dom.expandBtn.setAttribute("aria-pressed", String(expanded));
        dom.expandBtn.setAttribute("aria-label", expanded ? "Shrink panel" : "Expand panel");
        dom.expandBtn.title = expanded ? "Shrink" : "Expand";
    }
    function openPanel() {
        isOpen = true;
        panelEverOpened = true;
        _cancelTooltip();
        panel.classList.add("is-open");
        panel.setAttribute("aria-hidden", "false");
        fab.setAttribute("aria-expanded", "true");
        document.body.setAttribute("data-agent-panel-open", "true");
        if (agentIntro?.text && !introRendered) {
            introRendered = true;
            // Delay until the panel slide animation completes (--dur-base = 320ms) so
            // streaming starts on a fully-visible panel. REDUCE_MOTION skips animation,
            // so no delay needed there.
            setTimeout(() => requestAnimationFrame(renderIntroMessage), REDUCE_MOTION ? 0 : 340);
        }
        if (!warmedThisSession && warmUrl) {
            warmedThisSession = true;
            fetch(warmUrl, { method: "GET", mode: "cors", cache: "no-store" })
                .catch(() => { /* best-effort; failure is harmless */ });
        }
        requestAnimationFrame(() => { input.focus(); syncScrollHint(); });
    }
    function closePanel() {
        isOpen = false;
        panel.classList.remove("is-open");
        panel.setAttribute("aria-hidden", "true");
        fab.setAttribute("aria-expanded", "false");
        document.body.removeAttribute("data-agent-panel-open");
        fab.focus();
        // Dismissing the panel must not leave the mic listening in the
        // background. dispose() permanently silences that engine instance's
        // state callbacks, so drop the reference too — the next mic tap
        // lazy-imports a fresh one via startVoiceInput()'s `!voiceEngine` guard.
        if (voiceEngine) {
            voiceEngine.dispose();
            voiceEngine = null;
        }
        setMicMode("idle");
    }

    function renderStarters() {
        promptsEl.replaceChildren();
        if (!starters.length && !actions.length) {
            promptsEl.classList.add("is-hidden");
            return;
        }

        const heading = document.createElement("p");
        heading.className = "agent-prompts-head";
        heading.textContent = "Try asking…";
        promptsEl.appendChild(heading);

        // Action chips first within the chip list — same visual weight as
        // question chips, just a leading mail icon. Click prefills the input
        // and focuses it; the agent will ask for an email if the prefill
        // doesn't include one.
        actions.forEach((a) => {
            if (!a || typeof a !== "object") return;
            const label   = String(a.label   || "").trim();
            const prefill = String(a.prefill || a.label || "").trim();
            if (!label || !prefill) return;
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "agent-action-chip";
            btn.textContent = label;
            btn.addEventListener("click", () => prefillComposer(prefill));
            promptsEl.appendChild(btn);
        });

        starters.forEach((p) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "agent-prompt-chip";
            btn.textContent = p;
            btn.addEventListener("click", () => {
                if (isPending) return;
                input.value = p;
                sendCurrent();
            });
            promptsEl.appendChild(btn);
        });
    }

    function renderIntroMessage() {
        const li = document.createElement("li");
        li.className = "agent-message agent-message-assistant agent-message-intro";
        const p = document.createElement("p");
        p.className = "agent-message-text";
        li.appendChild(p);
        transcript.appendChild(li);
        scrollToEnd();

        streamIntroText(p, agentIntro.text, () => {
            // Combined chip row — action chips first, then question starters.
            // Uses "agent-suggestions" so sendCurrent() auto-clears them on first send.
            const row = document.createElement("div");
            row.className = "agent-suggestions";

            actions.forEach((a) => {
                if (!a?.label || !a?.prefill) return;
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "agent-action-chip";
                btn.textContent = a.label;
                btn.addEventListener("click", () => prefillComposer(a.prefill));
                row.appendChild(btn);
            });

            starters.forEach((s) => {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "agent-suggestion-chip";
                btn.textContent = s;
                btn.addEventListener("click", () => {
                    if (isPending) return;
                    input.value = s;
                    sendCurrent();
                });
                row.appendChild(btn);
            });

            if (row.children.length) li.appendChild(row);
            scrollToEnd();
        });
    }

    function setupScrollNudge() {
        if (!FEATURES.scrollNudge) return;
        if (!matchMedia("(min-width: 768px)").matches) return;
        const career = document.querySelector("#career, [data-section='career'], section[id*='career']");
        const NUDGE_KEY = "agent_nudge_v1";
        if (!career || sessionStorage.getItem(NUDGE_KEY) === "shown") return;

        nudgeIo = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (e.isIntersecting && !panelEverOpened) {
                    sessionStorage.setItem(NUDGE_KEY, "shown");
                    nudgeIo.disconnect();
                    nudgeIo = null;
                    showNudge(agentCopy?.nudge?.label || "Want a TL;DR of his career arc?",
                              agentCopy?.nudge?.prompt || "Give me a TL;DR of his career arc");
                }
            }
        }, { threshold: 0.4 });
        nudgeIo.observe(career);
    }

    function showNudge(label, prompt) {
        const existing = root.querySelector(".agent-nudge");
        if (existing) return;

        const nudge = document.createElement("div");
        nudge.className = "agent-nudge";
        nudge.setAttribute("role", "status");
        const txt = document.createElement("span");
        txt.className = "agent-nudge-text";
        txt.textContent = label;
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "agent-nudge-dismiss";
        dismiss.setAttribute("aria-label", "Dismiss");
        dismiss.textContent = "×";
        nudge.appendChild(txt);
        nudge.appendChild(dismiss);
        root.appendChild(nudge);

        const autoTimer = setTimeout(() => nudge.remove(), 8000);

        dismiss.addEventListener("click", () => {
            clearTimeout(autoTimer);
            nudge.remove();
        });
        txt.addEventListener("click", () => {
            clearTimeout(autoTimer);
            nudge.remove();
            openPanel();
            // Small delay so the panel animation starts before we send
            setTimeout(() => {
                input.value = prompt;
                sendCurrent();
            }, 80);
        });
    }

    // ---- send / stream ---------------------------------------------------

    async function sendCurrent() {
        if (isPending) return;
        const text = (input.value || "").trim();
        if (!text) return;
        if (text.length > 1000) {
            appendSystem("That message is a bit long for me — could you trim it under ~1000 characters?");
            return;
        }
        const emailError = validateEmailInMessage(text);
        if (emailError) {
            appendSystem(emailError);
            input.value = text;
            return;
        }
        // Remove suggestion chips from the previous assistant message
        transcript.querySelectorAll(".agent-suggestions").forEach(el => el.remove());

        promptsEl.classList.add("is-hidden");
        input.value = "";
        autoGrowInput();
        isPending = true;
        wasStopped = false;
        abortController = new AbortController();
        setSendMode("stop");
        if (FEATURES.voiceInput) micBtn.disabled = true;

        appendUser(text);
        messages.push({ role: "user", content: text });

        const assistant = appendAssistantPlaceholder();
        // Only the first turn of a session can hit a cold start — the loading
        // copy escalates to the "first answer takes a moment" line only then.
        const stages = startLoadingStages(assistant, !sessionWarmed);
        const thinkingContainer = assistant.querySelector(".agent-thinking");
        const thinkingBody = assistant.querySelector(".agent-thinking-body");
        const thinkingToggle = assistant.querySelector(".agent-thinking-toggle");
        const thinkingLabel = assistant.querySelector(".agent-thinking-label");
        const thinkingHint = assistant.querySelector(".agent-thinking-hint");
        let firstDelta = true;
        let firstThought = true;
        let thinkingRaw = "";

        // Reasoning is over: "Thinking" becomes "Thoughts" and the panel folds
        // away (never clears) so the answer has the floor. Called from both the
        // first answer delta and onDone — the latter covers a turn that thought
        // but then errored or came back empty, which would otherwise leave the
        // label stuck on "Thinking" forever.
        function settleThinking() {
            if (!thinkingContainer || thinkingContainer.dataset.state === "done") return;
            thinkingContainer.dataset.state = "done";
            if (thinkingLabel) thinkingLabel.textContent = "Thoughts";
            if (thinkingToggle && !thinkingContainer.dataset.userToggled
                && thinkingToggle.getAttribute("aria-expanded") === "true") {
                thinkingToggle.setAttribute("aria-expanded", "false");
                thinkingBody.hidden = true;
            }
        }
        let errorShown = false;
        let midStreamError = false;
        let pendingCitations = {};
        let pendingCta = null;
        let lastUserText = text;

        // Per-turn state holders written by SSE callbacks
        const turnState = { citations: {}, suggestions: [], cta: null };

        try {
            await streamAgent({
                apiUrl,
                sessionId,
                messages,
                identity,
                signal: abortController.signal,
                onThinking(chunk) {
                    if (!thinkingBody) return;
                    if (firstThought) {
                        firstThought = false;
                        stages.cancel(); // real progress is showing — drop the canned copy
                        thinkingContainer.hidden = false;
                    }
                    // Re-render from the full accumulated string rather than
                    // appending — that's what keeps `**header**` markers correct
                    // when one is split across two SSE chunks.
                    thinkingRaw += chunk;
                    renderThinkingText(thinkingBody, thinkingRaw);
                    const header = latestThoughtHeader(thinkingRaw);
                    if (header && thinkingHint) thinkingHint.textContent = header;
                    scrollToEnd();
                },
                onDelta(delta) {
                    if (firstDelta) {
                        firstDelta = false;
                        sessionWarmed = true; // container has served a token this session
                        stages.cancel(); // clear loading indicator on first char
                        settleThinking();
                    }
                    appendDelta(assistant, delta, FEATURES.typingCursor);
                },
                onCitations(citations) {
                    // Store for post-done render — do NOT re-render yet (caret active)
                    turnState.citations = Object.fromEntries(citations.map(c => [c.id, c]));
                },
                onSuggestions(suggestions) {
                    turnState.suggestions = suggestions;
                },
                onCta(cta) {
                    turnState.cta = cta;
                },
                onDone(full) {
                    stages.cancel();
                    settleThinking();
                    if (wasStopped) {
                        removeCaret(assistant);
                        if (full) {
                            finalizeAssistant(assistant, full, turnState.citations);
                            messages.push({ role: "assistant", content: full });
                        }
                        appendStoppedNote(assistant);
                        input.focus();
                        return;
                    }
                    if (!full && !errorShown) {
                        appendDelta(assistant, "Hmm, I didn't quite get that through on my end — could you try asking again?", false);
                    }
                    if (full) {
                        // Remove typing caret first, then do one-shot render with citations
                        finalizeAssistant(assistant, full, turnState.citations);
                        messages.push({ role: "assistant", content: full });
                        liveRegion.textContent = stripUrls(full).slice(0, 240);

                        // Tick the hero "Atlas has responded to N questions"
                        // counter — only on a successful answer (not on send,
                        // not on empty/errored turns), so the count reflects
                        // real responses, matching the backend's logged total.
                        document.dispatchEvent(new CustomEvent("portfolio:agent-question"));

                        // Render follow-up chips
                        if (FEATURES.suggestions && turnState.suggestions.length) {
                            renderSuggestions(assistant, turnState.suggestions);
                        }
                        // Render CTA button
                        if (FEATURES.cta && turnState.cta) {
                            renderCta(assistant, turnState.cta, agentCopy);
                        }
                    }
                },
                onError(msg, isMidStream) {
                    stages.cancel();
                    errorShown = true;
                    midStreamError = !!isMidStream;
                    // Remove cursor if streaming was interrupted
                    removeCaret(assistant);
                    if (isMidStream) {
                        // Keep partial text; append retry button
                        appendRetryButton(assistant, lastUserText);
                    } else {
                        appendDelta(assistant, msg, false);
                    }
                },
            });
        } finally {
            setSendMode("send");
            isPending = false;
            abortController = null;
            if (FEATURES.voiceInput) micBtn.disabled = false;
        }
    }

    function appendStoppedNote(assistantLi) {
        if (assistantLi.querySelector(".agent-stopped-note")) return;
        const note = document.createElement("p");
        note.className = "agent-stopped-note";
        note.textContent = "Stopped.";
        assistantLi.appendChild(note);
        scrollToEnd();
    }

    function appendRetryButton(assistantLi, userText) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "agent-retry-inline";
        btn.textContent = "Connection slipped — try again?";
        btn.addEventListener("click", () => {
            btn.remove();
            // Re-send the last user message; append a fresh assistant bubble
            input.value = userText;
            sendCurrent();
        });
        assistantLi.appendChild(btn);
        scrollToEnd();
    }

    // ---- DOM helpers -------------------------------------------------------

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
        const dots = document.createElement("div");
        dots.className = "agent-loading-dots";
        dots.hidden = true;
        dots.setAttribute("aria-hidden", "true");
        dots.append(
            document.createElement("span"),
            document.createElement("span"),
            document.createElement("span"),
        );
        li.appendChild(dots);
        const thinking = document.createElement("div");
        thinking.className = "agent-thinking";
        thinking.hidden = true;
        thinking.dataset.state = "thinking";
        const thinkingToggle = document.createElement("button");
        thinkingToggle.type = "button";
        thinkingToggle.className = "agent-thinking-toggle";
        thinkingToggle.setAttribute("aria-expanded", "false");
        thinkingToggle.innerHTML =
            '<img class="agent-thinking-icon" src="/assets/img/logo-gemini.svg" alt="" aria-hidden="true" width="14" height="14">' +
            '<span class="agent-thinking-label">Thinking</span>' +
            '<span class="agent-thinking-chevron" aria-hidden="true">▾</span>' +
            '<span class="agent-thinking-hint">Expand to view model thoughts</span>';
        const thinkingBody = document.createElement("div");
        thinkingBody.className = "agent-thinking-body";
        thinkingBody.hidden = true;
        thinkingToggle.addEventListener("click", () => {
            thinking.dataset.userToggled = "true";
            const open = thinkingToggle.getAttribute("aria-expanded") === "true";
            thinkingToggle.setAttribute("aria-expanded", String(!open));
            thinkingBody.hidden = open;
        });
        thinking.append(thinkingToggle, thinkingBody);
        li.appendChild(thinking);
        const p = document.createElement("p");
        p.className = "agent-message-text";
        p.textContent = "";
        li.appendChild(p);
        transcript.appendChild(li);
        scrollToEnd();
        return li;
    }

    function appendDelta(li, delta, withCursor) {
        const p = li.querySelector(".agent-message-text");
        if (!p) return;
        // Remove stale caret before appending (it will be re-appended at the end)
        const existingCaret = p.querySelector(".agent-cursor");
        if (existingCaret) existingCaret.remove();
        p.appendChild(document.createTextNode(delta));
        if (withCursor && FEATURES.typingCursor) {
            const caret = document.createElement("span");
            caret.className = "agent-cursor";
            caret.setAttribute("aria-hidden", "true");
            p.appendChild(caret);
        }
        scrollToEnd();
    }

    function removeCaret(li) {
        const caret = li.querySelector(".agent-cursor");
        if (caret) caret.remove();
    }

    function finalizeAssistant(li, fullText, citations) {
        const p = li.querySelector(".agent-message-text");
        if (!p) return;
        removeCaret(li);
        p.replaceChildren();
        renderTextWithLinks(p, fullText, citations);
        if (FEATURES.citations) {
            if (Object.keys(citations).length > 0) {
                renderCitationList(li, citations);
            } else if (/\[\d\]/.test(fullText)) {
                // [N] marker present but server sent no citations (URL dropped or internal source)
                renderFallbackSource(li);
            }
        }
    }

    function renderFallbackSource(assistantLi) {
        const wrap = document.createElement("div");
        wrap.className = "agent-sources";
        const span = document.createElement("span");
        span.className = "agent-source-internal";
        span.textContent = "Internal — profile data";
        wrap.appendChild(span);
        assistantLi.appendChild(wrap);
    }

    function renderCitationList(assistantLi, citations) {
        const ids = Object.keys(citations).map(Number).sort((a, b) => a - b);
        if (!ids.length) return;
        const wrap = document.createElement("div");
        wrap.className = "agent-sources";
        ids.forEach(id => {
            const c = citations[id];
            if (!c?.url) return;
            const a = document.createElement("a");
            a.className = "agent-source-link";
            a.href = escapeUrl(c.url);
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = `[${id}] ${c.label || c.url}`;
            wrap.appendChild(a);
        });
        if (wrap.children.length) assistantLi.appendChild(wrap);
    }

    function renderSuggestions(assistantLi, suggestions) {
        const row = document.createElement("div");
        row.className = "agent-suggestions";
        suggestions.forEach(s => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "agent-suggestion-chip";
            btn.textContent = s;
            btn.addEventListener("click", () => {
                if (isPending) return;
                input.value = s;
                sendCurrent();
            });
            row.appendChild(btn);
        });
        assistantLi.appendChild(row);
        scrollToEnd();
    }

    function renderCta(assistantLi, cta, agentCopy) {
        const entry = agentCopy?.cta?.[cta];
        if (!entry?.url) return;
        const btn = document.createElement("a");
        btn.className = "agent-cta-action";
        btn.href = entry.url;
        btn.target = "_blank";
        btn.rel = "noopener noreferrer";
        btn.textContent = entry.label || "Open →";
        assistantLi.appendChild(btn);
        scrollToEnd();
    }

    function syncScrollHint() {
        const b = dom.body;
        const overflows = b.scrollHeight > b.clientHeight + 8;
        const atBottom  = b.scrollTop + b.clientHeight >= b.scrollHeight - 8;
        b.classList.toggle("has-overflow", overflows && !atBottom);
    }

    function scrollToEnd() {
        requestAnimationFrame(() => {
            dom.body.scrollTop = dom.body.scrollHeight;
            syncScrollHint();
        });
    }

    dom.body.addEventListener("scroll", syncScrollHint, { passive: true });

    return { open: openPanel, close: closePanel, prefill: prefillComposer, stop: stopStreaming };
}

// --- Explainer modal --------------------------------------------------------

// Tiny `**term**` parser used by the explainer body — wraps highlighted
// terms in <strong class="agent-highlight"> without using innerHTML.
function parseEmphasis(text) {
    const frag = document.createDocumentFragment();
    const re = /\*\*([^*]+)\*\*/g;
    let lastIdx = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > lastIdx) {
            frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
        }
        const strong = document.createElement("strong");
        strong.className = "agent-highlight";
        strong.textContent = m[1];
        frag.appendChild(strong);
        lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }
    return frag;
}

function _setupDiagramTooltips(svg, dialog) {
    const tip = document.createElement("div");
    tip.className = "ad-node-tooltip";
    tip.setAttribute("role", "tooltip");
    const ul = document.createElement("ul");
    tip.appendChild(ul);
    document.body.appendChild(tip);

    const TIP_W = 196;

    function showTip(node) {
        const items = node.getAttribute("data-ad-tip").split("\n");
        ul.replaceChildren(...items.map(s => {
            const li = document.createElement("li");
            li.textContent = s;
            return li;
        }));
        const rect = node.getBoundingClientRect();
        let x = rect.left + rect.width / 2 - TIP_W / 2;
        const y = rect.top;
        x = Math.max(8, Math.min(x, window.innerWidth - TIP_W - 8));
        tip.style.left = `${x}px`;
        tip.style.top  = `${y}px`;
        tip.classList.add("is-visible");
    }

    function hideTip() {
        tip.classList.remove("is-visible");
    }

    svg.querySelectorAll(".ad-node[data-ad-tip]").forEach(node => {
        node.addEventListener("mouseenter", () => showTip(node));
        node.addEventListener("mouseleave", hideTip);

        // Touch: click is more reliable than pointerdown on iOS Safari SVG
        node.addEventListener("click", e => {
            if (!matchMedia("(any-pointer: coarse)").matches) return;
            if (tip.classList.contains("is-visible") && tip._node === node) {
                hideTip();
            } else {
                tip._node = node;
                showTip(node);
            }
        });
    });

    // Dismiss tooltip when tapping outside any node (touch only)
    svg.addEventListener("click", e => {
        if (!matchMedia("(any-pointer: coarse)").matches) return;
        if (!e.target.closest(".ad-node[data-ad-tip]")) hideTip();
    });

    dialog.addEventListener("close", () => {
        hideTip();
        tip.remove();
    });
}

function buildAgentDiagram() {
    const NS = "http://www.w3.org/2000/svg";
    const el = (tag, attrs) => {
        const e = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
        return e;
    };

    // On mobile (<540px) use a 250-unit viewBox (vs 480 desktop) so the diagram
    // renders at ~1.32x natural scale rather than ~0.65x, making it prominent.
    const mobile = window.innerWidth < 540;
    const VW = mobile ? 250 : 480;
    const VH = mobile ? 220 : 192;

    const svg = el("svg", { viewBox: `0 0 ${VW} ${VH}`, width: "100%", height: String(VH),
                             class: "ad-svg", "aria-hidden": "true" });

    // [d, labelText, label-cx, label-cy, pulse-delay, bg-rect-width]
    const edges = mobile ? [
        // Nodes centered at x=125; Agent bottom=114, spoke tops=155 → 41px gap
        ["M 125 72 L 125 43",  "reasoning", 112,  58, 0,   56],
        ["M 100 114 L 78 155", "grounding",  76, 132, 0.8, 58],
        ["M 150 114 L 163 155","actions",   165, 132, 1.6, 44],
    ] : [
        // Agent bottom=112, spoke tops=140 → 28px gap, labels at y=126
        ["M 240 68 L 240 46",   "reasoning", 225, 60,  0,   56],
        ["M 192 112 L 156 140", "grounding", 172, 126, 0.8, 58],
        ["M 288 112 L 344 140", "actions",   316, 126, 1.6, 44],
    ];
    edges.forEach(([d, labelText, lx, ly, delay, bgW]) => {
        svg.appendChild(el("path", { class: "ad-edge", d }));
        const pulse = el("path", { class: "ad-pulse", d });
        if (!REDUCE_MOTION) pulse.style.animationDelay = `${delay}s`;
        svg.appendChild(pulse);
        svg.appendChild(el("rect", {
            class: "ad-label-bg",
            x: String(lx - bgW / 2), y: String(ly - 9),
            width: String(bgW), height: "13", rx: "3",
        }));
        const lbl = el("text", { class: "ad-edge-label", x: String(lx), y: String(ly) });
        lbl.textContent = labelText;
        svg.appendChild(lbl);
    });

    const node = (cls, rx, ry, rw, rh, name, sub, tip, cx, details) => {
        const g = el("g", { class: cls ? `ad-node ${cls}` : "ad-node" });
        const t = el("title", {}); t.textContent = tip; g.appendChild(t);
        g.appendChild(el("rect", { x: String(rx), y: String(ry), width: String(rw), height: String(rh), rx: "6" }));
        const nm = el("text", { class: "ad-node-name", x: String(cx), y: String(ry + Math.floor(rh * 0.42)), "text-anchor": "middle" });
        nm.textContent = name; g.appendChild(nm);
        const sb = el("text", { class: "ad-node-sub", x: String(cx), y: String(ry + Math.floor(rh * 0.75)), "text-anchor": "middle" });
        sb.textContent = sub; g.appendChild(sb);
        if (details?.length) g.setAttribute("data-ad-tip", details.join("\n"));
        return g;
    };

    const TIPS = {
        llm:    ["Gemini 3.5 Flash", "reasoning + generation", "plans tool calls · synthesizes reply"],
        agent:  ["get_profile · get_work_history", "get_projects · get_recent_posts", "get_certifications", "ADK orchestrator on Cloud Run"],
        corpus: ["profile.json — bio, roles, certs", "graph.json — projects", "posts.json — LinkedIn", "rebuilt on every deploy"],
        mcp:    ["send-email (Resend API)", "compose + fire transactional email", "agent-triggered · not a webhook"],
    };

    if (mobile) {
        // 250-unit viewBox: nodes centered at x=125; spoke nodes fill the width
        svg.appendChild(node(null,            60,   5, 130, 38, "Gemini 3.5 Flash",  "reasoning · generation",    "Google Gemini — reasoning and language generation", 125, TIPS.llm));
        svg.appendChild(node("ad-node--hub",  60,  72, 130, 42, "Agent",       "ADK orchestrator",           "ADK agent on Cloud Run — orchestrates all tool calls", 125, TIPS.agent));
        svg.appendChild(node(null,             0, 155, 120, 38, "Data Corpus", "profile · projects", "Frozen JSON snapshot — grounding source for every reply", 60, TIPS.corpus));
        svg.appendChild(node(null,           130, 155, 120, 38, "MCP Server",  "Resend · email actions",     "MCP-compatible Resend server — fires email on agent request", 190, TIPS.mcp));
    } else {
        svg.appendChild(node(null,           178,   6, 124, 40, "Gemini 3.5 Flash",   "reasoning · generation",    "Google Gemini — reasoning and language generation", 240, TIPS.llm));
        svg.appendChild(node("ad-node--hub", 178,  68, 124, 44, "Agent",        "ADK orchestrator",          "ADK agent on Cloud Run — orchestrates all tool calls", 240, TIPS.agent));
        svg.appendChild(node(null,             8, 140, 148, 40, "Data Corpus",  "profile · projects · posts","Frozen JSON snapshot — grounding source for every reply", 82, TIPS.corpus));
        svg.appendChild(node(null,           344, 140, 116, 40, "MCP Server",   "Resend · email actions",    "MCP-compatible Resend server — fires email on agent request", 402, TIPS.mcp));
    }

    return svg;
}

function setupExplainerModal(dom, agentExplainer) {
    if (!FEATURES.explainerDialog) return;
    const trigger = dom.footerTrigger;
    const dialog = dom.explainerDialog;
    if (!trigger || !dialog) return;

    // Populate dialog content from profile.agentExplainer
    const titleEl = dialog.querySelector(".agent-explainer-title");
    const bodyEl  = dialog.querySelector(".agent-explainer-body");
    const footEl  = dialog.querySelector(".agent-explainer-foot");

    if (titleEl && agentExplainer.title) titleEl.textContent = agentExplainer.title;
    if (bodyEl && Array.isArray(agentExplainer.body)) {
        bodyEl.replaceChildren();
        bodyEl.appendChild(buildAgentDiagram());
        const diagSvg = bodyEl.querySelector(".ad-svg");
        if (diagSvg) _setupDiagramTooltips(diagSvg, dialog);
        agentExplainer.body.forEach(para => {
            const p = document.createElement("p");
            p.appendChild(parseEmphasis(para));
            bodyEl.appendChild(p);
        });
    }
    // No repo link in current copy — hide the footer element if empty
    if (footEl && !agentExplainer.repoUrl) footEl.style.display = "none";

    trigger.addEventListener("click", () => dialog.showModal());

    const closeBtn = dialog.querySelector(".agent-explainer-close");
    if (closeBtn) closeBtn.addEventListener("click", () => dialog.close());

    dialog.addEventListener("click", (e) => {
        // Click on the backdrop (outside the dialog content) — close
        if (e.target === dialog) dialog.close();
    });
}

// --- shell renderer ---------------------------------------------------------

function renderShell(root, agentExplainer) {
    root.classList.add("agent-widget-host");
    root.innerHTML = "";

    const fab = document.createElement("button");
    fab.type = "button";
    fab.role = "button";
    fab.className = "agent-fab" + (REDUCE_MOTION ? "" : " agent-fab-pulse");
    fab.setAttribute("aria-label", "Ask Atlas");
    fab.setAttribute("aria-expanded", "false");
    fab.setAttribute("data-cursor", "magnet");
    fab.title = "Ask Atlas";
    fab.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 9 9 12 4 15"/>
            <line x1="12" y1="15" x2="20" y2="15"/>
        </svg>
        <span>Ask Atlas</span>
    `;

    const tooltip = document.createElement("div");
    tooltip.className = "agent-fab-tooltip";
    tooltip.id = "agent-fab-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = "Curious about my architecture experience? Ask Atlas.";
    fab.setAttribute("aria-describedby", "agent-fab-tooltip");

    const panel = document.createElement("section");
    panel.className = "agent-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "agent-panel-title");
    panel.setAttribute("aria-hidden", "true");

    const dragZone = document.createElement("div");
    dragZone.className = "agent-panel-drag-zone";
    dragZone.setAttribute("aria-hidden", "true");
    const dragHandle = document.createElement("span");
    dragHandle.className = "agent-panel-drag-handle";
    dragZone.appendChild(dragHandle);

    const head = document.createElement("header");
    head.className = "agent-panel-head";
    head.innerHTML = `
        <h3 id="agent-panel-title" class="agent-panel-title">
            <svg class="hero-cta-icon agent-panel-bot-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="7" width="18" height="13" rx="3"/>
                <circle class="bot-eye-l" cx="8.5" cy="13" r="1.5" fill="currentColor" stroke="none"/>
                <circle class="bot-eye-r" cx="15.5" cy="13" r="1.5" fill="currentColor" stroke="none"/>
                <line x1="12" y1="3" x2="12" y2="7"/>
                <circle class="bot-antenna" cx="12" cy="2.5" r="1.2" fill="currentColor" stroke="none"/>
            </svg>
            Ask Atlas
        </h3>
        <div class="agent-panel-head-actions">
            <button type="button" class="agent-panel-expand" aria-label="Expand panel" aria-pressed="false" title="Expand">
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 7 V3 H7 M13 9 V13 H9 M3 3 L7 7 M13 13 L9 9"/>
                </svg>
            </button>
            <button type="button" class="agent-panel-minimize" aria-label="Minimize panel" title="Minimize">
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                    <path d="M3 8 H13"/>
                </svg>
            </button>
            <button type="button" class="agent-panel-close" aria-label="Close agent">×</button>
        </div>
    `;
    const closeBtn = head.querySelector(".agent-panel-close");
    const expandBtn = head.querySelector(".agent-panel-expand");
    const minimizeBtn = head.querySelector(".agent-panel-minimize");

    const body = document.createElement("div");
    body.className = "agent-panel-body";
    body.tabIndex = 0;

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
    // Shorter than "Ask about Gaurav's work…" (which the panel header
    // "Ask Atlas" already makes redundant) — the longer copy wrapped and
    // clipped inside the shrunk textarea on narrow mobile widths once the
    // mic/send flex-wrap fix (below) let the box actually shrink to fit.
    input.placeholder = "Ask about his work…";
    input.setAttribute("aria-label", "Message");
    // Spec 26: native-feeling soft-keyboard hints on touch devices.
    input.setAttribute("enterkeyhint", "send");
    input.setAttribute("inputmode", "text");
    input.setAttribute("autocapitalize", "sentences");
    input.setAttribute("autocorrect", "on");
    input.setAttribute("spellcheck", "true");
    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.className = "agent-send";
    sendBtn.dataset.mode = "send";
    sendBtn.setAttribute("aria-label", "Send");
    sendBtn.innerHTML = `
        <svg class="agent-send-glyph agent-send-glyph-send" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 8 L14 2 L10 14 L8 9 Z"/>
        </svg>
        <svg class="agent-send-glyph agent-send-glyph-stop" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <rect x="5" y="5" width="6" height="6" rx="1.5" fill="currentColor"/>
        </svg>
    `;

    // Spec 48: mic button. Rendered only if FEATURES.voiceInput is on; hidden
    // entirely (not just disabled) at runtime if the browser lacks
    // getUserMedia/MediaRecorder — see wireVoiceInput().
    const micBtn = document.createElement("button");
    micBtn.type = "button";
    micBtn.className = "agent-mic";
    micBtn.dataset.mode = "idle";
    micBtn.setAttribute("aria-label", "Ask by voice");
    micBtn.innerHTML = `
        <svg class="agent-mic-glyph agent-mic-glyph-idle" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <rect x="6" y="1.5" width="4" height="7" rx="2"/>
            <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0"/>
            <path d="M8 12v2.5M5.5 14.5h5"/>
        </svg>
        <svg class="agent-mic-glyph agent-mic-glyph-stop" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <rect x="5" y="5" width="6" height="6" rx="1.5" fill="currentColor"/>
        </svg>
    `;

    const voiceStatus = document.createElement("div");
    voiceStatus.className = "agent-voice-status is-hidden";

    inputRow.appendChild(input);
    if (FEATURES.voiceInput) inputRow.appendChild(micBtn);
    inputRow.appendChild(sendBtn);
    if (FEATURES.voiceInput) inputRow.appendChild(voiceStatus);

    const foot = document.createElement("footer");
    foot.className = "agent-panel-foot";

    // Transparency modal trigger (Spec #24)
    if (FEATURES.explainerDialog) {
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "agent-explainer-trigger";
        trigger.textContent = "Powered by ADK + Gemini + MCP";
        foot.appendChild(trigger);
    } else {
        foot.textContent = "Powered by ADK + Gemini + MCP";
    }

    const liveRegion = document.createElement("div");
    liveRegion.className = "agent-live";
    liveRegion.setAttribute("aria-live", "polite");
    liveRegion.setAttribute("aria-atomic", "true");

    panel.appendChild(dragZone);
    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(inputRow);
    panel.appendChild(foot);
    panel.appendChild(liveRegion);

    // Explainer dialog element (portal-appended to root, outside the panel)
    const explainerDialog = document.createElement("dialog");
    explainerDialog.className = "agent-explainer-dialog";
    explainerDialog.setAttribute("aria-modal", "true");
    explainerDialog.innerHTML = `
        <div class="agent-explainer-head">
            <h4 class="agent-explainer-title">How this agent works</h4>
            <button type="button" class="agent-explainer-close" aria-label="Close">×</button>
        </div>
        <div class="agent-explainer-body"></div>
        <footer class="agent-explainer-foot"></footer>
    `;

    root.appendChild(fab);
    root.appendChild(tooltip);
    root.appendChild(panel);
    // Append dialog to body, not the widget host — the host is position:fixed
    // in the bottom-right corner, which breaks native showModal() centering.
    document.body.appendChild(explainerDialog);

    return {
        fab, tooltip, panel, body, head, dragZone, closeBtn, expandBtn, minimizeBtn,
        prompts, transcript, input, sendBtn, micBtn, voiceStatus, liveRegion, foot,
        footerTrigger: foot.querySelector(".agent-explainer-trigger"),
        explainerDialog,
    };
}

// --- visualViewport tracker (Spec 26) --------------------------------------
// Writes the visible viewport height onto the panel as a CSS custom
// property `--agent-vv-height` (px). The mobile `.agent-panel` max-height
// rules read it via min(calc(var(--agent-vv-height, 80dvh) - 24px), 720px),
// so the panel shrinks in real time when the soft keyboard opens. No-op
// when visualViewport is unavailable (older browsers fall back to dvh).
function trackVisualViewport(panel) {
    const vv = window.visualViewport;
    if (!vv) return;
    let raf = 0;
    const sync = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            panel.style.setProperty("--agent-vv-height", `${vv.height}px`);
        });
    };
    vv.addEventListener("resize", sync, { passive: true });
    vv.addEventListener("scroll", sync, { passive: true });
    sync();
}

// --- drag-to-dismiss --------------------------------------------------------

function setupDragToDismiss(panel, dragZone, closePanel) {
    if (!dragZone) return;
    let startY = null;
    let dragging = false;

    function onPointerDown(e) {
        if (getComputedStyle(dragZone).display === "none") return;
        startY = e.clientY;
        dragging = true;
        dragZone.setPointerCapture?.(e.pointerId);
        panel.style.transition = "none";
    }
    function onPointerMove(e) {
        if (!dragging || startY === null) return;
        const dy = e.clientY - startY;
        if (dy <= 0) { panel.style.transform = "translateY(0)"; return; }
        panel.style.transform = `translateY(${dy}px)`;
    }
    function onPointerUp(e) {
        if (!dragging || startY === null) return;
        const dy = e.clientY - startY;
        dragging = false;
        startY = null;
        panel.style.transition = "";
        panel.style.transform = "";
        try { dragZone.releasePointerCapture?.(e.pointerId); } catch { /* noop */ }
        if (dy > 80) closePanel();
    }
    function onPointerCancel() {
        dragging = false;
        startY = null;
        panel.style.transition = "";
        panel.style.transform = "";
    }

    dragZone.addEventListener("pointerdown", onPointerDown);
    dragZone.addEventListener("pointermove", onPointerMove);
    dragZone.addEventListener("pointerup", onPointerUp);
    dragZone.addEventListener("pointercancel", onPointerCancel);
}

// --- intro streaming --------------------------------------------------------

function streamIntroText(p, text, onDone) {
    if (REDUCE_MOTION) {
        p.textContent = text;
        onDone();
        return;
    }
    const caret = document.createElement("span");
    caret.className = "agent-cursor";
    caret.setAttribute("aria-hidden", "true");
    p.appendChild(caret);

    let i = 0;
    const CHUNK = 3;
    const DELAY = 18;

    function tick() {
        if (i >= text.length) {
            caret.remove();
            onDone();
            return;
        }
        const end = Math.min(i + CHUNK, text.length);
        p.insertBefore(document.createTextNode(text.slice(i, end)), caret);
        i = end;
        setTimeout(tick, DELAY);
    }
    tick();
}

// --- email validation -------------------------------------------------------

const _OWNER_EMAIL     = "gaurav.lahoti25@gmail.com";
const _EMAIL_TOKEN_RE  = /[^\s,;]+@[^\s,;]+/g;
const _EMAIL_FULL_RE   = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

function validateEmailInMessage(text) {
    if (!text.includes("@")) return null;
    const tokens = text.match(_EMAIL_TOKEN_RE);
    if (!tokens) {
        return "That doesn't look like a valid email address. Please use the format you@domain.com.";
    }
    for (const raw of tokens) {
        const token = raw.replace(/[.,;!?]+$/, "");
        if (token.toLowerCase() === _OWNER_EMAIL) {
            return "That is Gaurav's own email address. Please enter your email so he can reply to you.";
        }
        if (!_EMAIL_FULL_RE.test(token)) {
            return `"${token}" does not look like a valid email address. Please use the format you@domain.com.`;
        }
    }
    return null;
}

// --- loading stages ---------------------------------------------------------

function startLoadingStages(assistantLi, isFirstTurn) {
    const p = assistantLi.querySelector(".agent-message-text");
    const dots = assistantLi.querySelector(".agent-loading-dots");
    if (!p) return { cancel() {} };
    if (dots) dots.hidden = false;
    let stage = 0;
    p.textContent = "Let me think…";
    const t1 = setTimeout(() => {
        if (p.textContent.startsWith("Let me think")) {
            stage = 1;
            p.textContent = "Pulling the details together…";
        }
    }, 3000);
    const t2 = setTimeout(() => {
        if (stage <= 1 && (p.textContent.startsWith("Pulling") || p.textContent.startsWith("Let me think"))) {
            // Only the first turn can be a cold start, so only then explain the
            // wait that way. Later turns hit a warm container — a slow one is
            // just a complex answer, so stay neutral (no "first answer" claim).
            p.textContent = isFirstTurn
                ? "Still on it — the first answer of the session takes a few extra seconds. Hang tight."
                : "Still on it — this one's taking a moment. Hang tight.";
        }
    }, 10000);
    return {
        cancel() {
            clearTimeout(t1);
            clearTimeout(t2);
            if (dots) dots.hidden = true;
            if (
                p.textContent.startsWith("Let me think") ||
                p.textContent.startsWith("Pulling") ||
                p.textContent.startsWith("Still on it")
            ) {
                p.textContent = "";
            }
        },
    };
}

// --- SSE streaming ----------------------------------------------------------

async function streamAgent({ apiUrl, sessionId, messages, identity, signal, onThinking, onDelta, onCitations, onSuggestions, onCta, onDone, onError }) {
    let response;
    try {
        const reqBody = identity ? { sessionId, messages, identity } : { sessionId, messages };
        response = await fetch(apiUrl, {
            method: "POST",
            mode: "cors",
            cache: "no-store",
            signal,
            headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
            body: JSON.stringify(reqBody),
        });
    } catch (err) {
        if (signal?.aborted) { onDone(""); return; }
        onError("I can't reach the server right now — might be a connection hiccup. Gaurav's on LinkedIn if it's urgent.", false);
        onDone("");
        return;
    }
    if (!response.ok) {
        let detail;
        try { detail = (await response.json()).error; } catch { detail = null; }
        if (response.status === 429) {
            onError(detail || "Lots of people are chatting right now. Give it a minute, or find Gaurav on LinkedIn.", false);
        } else if (response.status >= 500) {
            onError("Hmm, something went wrong on my end. Mind trying that again?", false);
        } else {
            onError(detail || `Request failed (${response.status}).`, false);
        }
        onDone("");
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let full = "";
    let done = false;
    let hadDeltas = false;

    try {
        while (true) {
            let chunk;
            try {
                chunk = await reader.read();
            } catch (readErr) {
                if (signal?.aborted) { onDone(hadDeltas ? full : ""); return; }
                // Network dropped mid-stream
                onError("", true /* isMidStream */);
                onDone(hadDeltas ? full : "");
                return;
            }
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
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

                if (typeof evt.delta === "string") {
                    full += evt.delta;
                    hadDeltas = true;
                    onDelta(evt.delta);
                } else if (typeof evt.thinking === "string" && FEATURES.thinking) {
                    onThinking(evt.thinking);
                } else if (evt.citations && FEATURES.citations) {
                    onCitations(evt.citations);
                } else if (evt.suggestions && FEATURES.suggestions) {
                    onSuggestions(evt.suggestions);
                } else if (evt.cta && FEATURES.cta) {
                    onCta(evt.cta);
                } else if (evt.done === true) {
                    done = true;
                    break;
                }
            }
            if (done) break;
        }
    } catch (err) {
        if (signal?.aborted) { onDone(hadDeltas ? full : ""); return; }
        onError("", hadDeltas /* isMidStream */);
        onDone(hadDeltas ? full : "");
        return;
    }
    onDone(full);
}

// --- text rendering ---------------------------------------------------------

// Gemini's thought summaries label each reasoning phase as `**Some Header**`.
// Render those as real emphasis instead of showing raw asterisks. Built from
// DOM nodes (never innerHTML) so model output can't inject markup.
function renderThinkingText(el, raw) {
    el.replaceChildren();
    const re = /\*\*(.+?)\*\*/g;
    let pos = 0, m;
    while ((m = re.exec(raw)) !== null) {
        if (m.index > pos) el.appendChild(document.createTextNode(raw.slice(pos, m.index)));
        const strong = document.createElement("strong");
        strong.textContent = m[1];
        el.appendChild(strong);
        pos = m.index + m[0].length;
    }
    if (pos < raw.length) el.appendChild(document.createTextNode(raw.slice(pos)));
}

// The most recent `**Header**` phase in the thought stream so far — used as a
// live one-line status while the full transcript stays collapsed.
function latestThoughtHeader(raw) {
    const re = /\*\*(.+?)\*\*/g;
    let last = null, m;
    while ((m = re.exec(raw)) !== null) last = m[1];
    return last;
}

function renderTextWithLinks(container, text, citations) {
    // Replace [N] citation markers first
    const citationMap = citations || {};
    const hasCitations = Object.keys(citationMap).length > 0;

    // Split text on [N] markers and URLs together
    // Strategy: scan character by character to handle both URL and [N] markup
    let pos = 0;
    const segments = [];

    // Build a combined regex for URLs and [N] markers
    const combined = /https?:\/\/[^\s<>()\[\]]+|\[(\d)\]/gi;
    combined.lastIndex = 0;
    let match;
    while ((match = combined.exec(text)) !== null) {
        if (match.index > pos) {
            segments.push({ type: "text", value: text.slice(pos, match.index) });
        }
        if (match[1] !== undefined) {
            // [N] citation marker
            segments.push({ type: "cite", n: Number(match[1]), raw: match[0] });
        } else {
            // URL
            segments.push({ type: "url", value: match[0] });
        }
        pos = match.index + match[0].length;
    }
    if (pos < text.length) {
        segments.push({ type: "text", value: text.slice(pos) });
    }

    for (const seg of segments) {
        if (seg.type === "text") {
            container.appendChild(document.createTextNode(seg.value));
        } else if (seg.type === "url") {
            const url = seg.value;
            const host = (url.split("//")[1] || "").split("/")[0].toLowerCase();
            const allowed = ALLOWED_HOSTS.some(h => host === h || host.endsWith("." + h));
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
        } else if (seg.type === "cite") {
            const c = citationMap[seg.n];
            if (c && FEATURES.citations) {
                const sup = document.createElement("sup");
                sup.className = "agent-cite";
                const a = document.createElement("a");
                a.href = escapeUrl(c.url);
                a.target = "_blank";
                a.rel = "noopener noreferrer";
                a.title = c.label || "";
                a.setAttribute("data-cite-id", String(seg.n));
                a.textContent = `[${seg.n}]`;
                sup.appendChild(a);
                container.appendChild(sup);
            } else {
                // No citation data yet (shouldn't happen post-done) — render plain
                container.appendChild(document.createTextNode(seg.raw));
            }
        }
    }
}

function escapeUrl(url) {
    // Basic XSS guard — reject javascript: and data: schemes
    const s = String(url || "").trim();
    if (/^javascript:/i.test(s) || /^data:/i.test(s)) return "#";
    return s;
}

function stripUrls(text) {
    return text.replace(URL_RE, "").trim();
}
