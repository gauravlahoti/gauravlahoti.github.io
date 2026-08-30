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
    suggestions:     false, // off: post-reply follow-up chips, not the opening starter chips (.agent-prompts, unaffected)
    cta:             true,
    typingCursor:    true,
    scrollNudge:     false,
    explainerDialog: true,
    thinking:        true,
    voiceInput:      true,
    speakReplies:    true,
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
    // Spec 49: same again for spoken replies.
    const speakApiUrl = apiUrl ? apiUrl.replace(/\/api\/agent-chat$/, "/api/agent-speak") : apiUrl;
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
    const speakerBtn = dom.speakerBtn;
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
    // Spec 49. Deliberately not folded into isPending: playback outlives the
    // stream (audio is still going after onDone), so "a turn is streaming"
    // and "Atlas is talking" are genuinely different states.
    let speaker = null;       // lazy-loaded agent-speech.js handle
    let speakerOn = false;    // visitor's toggle, mirrored to localStorage
    let speakerLoading = false;
    let isSpeaking = false;
    let voiceNoteTimer = null;
    // The assistant message of the turn in flight. The speaker's state
    // callback fires asynchronously and needs to know which message to hang
    // the "Reading aloud" strip on.
    let currentAssistantLi = null;
    // Spec 55: paces the current turn's reply text to the speaker's audio
    // schedule instead of showing it instantly. Only set while speaking is
    // active for the turn in flight; null means "stream text instantly" (the
    // pre-spec-55 behavior), which is also what a speaker-off visitor gets.
    let revealQueue = null;

    // Mobile TTS fix: the AudioContext must be created and resume()d
    // synchronously inside a real user gesture, or Safari/iOS refuse to play
    // through it. ensureSpeaker() below primes this before its own
    // `await import("./agent-speech.js")` — that import is a genuine async
    // gap desktop browsers tolerate between a gesture and unlock() but mobile
    // ones largely don't, which is why TTS worked on desktop and was
    // completely (silently) dead on mobile.
    //
    // The resume() check runs on EVERY call, not just when a context is
    // first created: mobile browsers (iOS Safari especially) suspend an
    // existing, otherwise-fine AudioContext far more readily than desktop —
    // backgrounding the tab, locking the screen, even just a lull in
    // activity — so a context that worked for the first reply can go quiet
    // again before the next one. Each new turn is itself a fresh user
    // gesture (sendCurrent's ensureSpeaker() call), which is exactly what a
    // repeat resume() needs to succeed.
    let primedAudioContext = null;
    function primeAudioContext() {
        if (!primedAudioContext || primedAudioContext.state === "closed") {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) return null;
            primedAudioContext = new Ctor();
        }
        if (primedAudioContext.state === "suspended") {
            primedAudioContext.resume().catch(() => { /* best effort — agent-speech.js's own unlock() retries and surfaces a note on failure */ });
        }
        return primedAudioContext;
    }

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
    if (FEATURES.speakReplies) {
        speakerBtn.addEventListener("click", toggleSpeaker);
    } else {
        speakerBtn.classList.add("is-hidden");
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
        updateSendReadiness();
    }

    // Mirrors the mic button's idle/active look: muted while there's
    // nothing to send, full accent once there's text — or always while
    // mode is "stop", since that's a live cancel control.
    function updateSendReadiness() {
        const hasText = !!(input.value || "").trim();
        sendBtn.classList.toggle("is-empty", sendBtn.dataset.mode !== "stop" && !hasText);
    }

    function stopStreaming() {
        // Stop is a single control for the whole turn: if the text has
        // finished but Atlas is still talking, this must still silence it.
        if (speaker) speaker.cancel();
        clearSpeakingIndicator();
        if (!isPending || !abortController) return;
        wasStopped = true;
        abortController.abort();
        liveRegion.textContent = "Stopped.";
    }

    // ---- spoken replies (spec 49) ---------------------------------------

    const SPEAKER_PREF_KEY = "atlas.speakReplies";

    // Voice is the default. A visitor who never touches the toggle gets spoken
    // replies, because the feature is the point of the widget and burying it
    // behind an unlabelled icon meant almost nobody found it.
    //
    // "On by default" still does not mean "audio with no warning": the first
    // time a reply would ever be spoken, sendMessage() shows the consent card
    // and keeps that turn silent. Consent is asked once, then remembered, so
    // this costs a returning visitor nothing.
    const SPEAK_DEFAULT_ON = true;

    // Note this is only ever *applied* inside a click — see toggleSpeaker() and
    // openPanel(). Browsers require a user gesture before audio may play, so
    // the stored preference selects the mode while the gesture unlocks it.
    function readSpeakerPref() {
        try {
            const v = localStorage.getItem(SPEAKER_PREF_KEY);
            // Absent means "never chosen", which is where the default applies.
            // Only an explicit "0" counts as off.
            return v === null ? SPEAK_DEFAULT_ON : v === "1";
        } catch (_) {
            return SPEAK_DEFAULT_ON;
        }
    }
    function writeSpeakerPref(on) {
        try { localStorage.setItem(SPEAKER_PREF_KEY, on ? "1" : "0"); } catch (_) { /* private mode */ }
    }

    // The assistant <li> currently being read aloud, so the indicator can be
    // attached to the right message and cleared from it later.
    let speakingLi = null;

    // Mirrors the .agent-thinking block's shape: a small labelled strip inside
    // the message itself. The header icon alone was too easy to miss — nothing
    // in the transcript showed Atlas was talking.
    function showSpeakingIndicator(li) {
        if (!li || li.querySelector(".agent-speaking")) return;
        const el = document.createElement("div");
        el.className = "agent-speaking";
        el.innerHTML =
            '<span class="agent-speaking-orb" aria-hidden="true">'
            + '<span class="agent-speaking-orb-core"></span>'
            + '<span class="agent-speaking-orb-ring"></span>'
            + "</span>"
            + '<span class="agent-speaking-label">Reading aloud</span>'
            + '<button type="button" class="agent-speaking-stop">Stop</button>';
        el.querySelector(".agent-speaking-stop").addEventListener("click", () => {
            if (speaker) speaker.cancel();
        });
        li.appendChild(el);
        speakingLi = li;
    }

    function clearSpeakingIndicator() {
        if (!speakingLi) return;
        const el = speakingLi.querySelector(".agent-speaking");
        if (el) el.remove();
        speakingLi = null;
    }

    // off | on | speaking. "speaking" is a transient sub-state of on.
    function setSpeakerMode(mode) {
        isSpeaking = mode === "speaking";
        speakerBtn.dataset.mode = mode;
        speakerBtn.setAttribute("aria-pressed", mode === "off" ? "false" : "true");
        speakerBtn.setAttribute(
            "aria-label",
            mode === "off" ? "Speak replies" : mode === "speaking" ? "Speaking, click to stop" : "Stop speaking replies",
        );
    }

    // Shared one-line status under the composer. The mic owns it while
    // recording; the speaker borrows it, so a visitor always has somewhere to
    // look when voice does something.
    function showVoiceNote(message, autoHideMs = 5000) {
        voiceStatus.classList.remove("is-hidden");
        voiceStatus.textContent = message;
        clearTimeout(voiceNoteTimer);
        if (autoHideMs) {
            voiceNoteTimer = setTimeout(() => {
                if (micBtn.dataset.mode === "idle" && !isSpeaking) {
                    voiceStatus.classList.add("is-hidden");
                }
            }, autoHideMs);
        }
    }

    // Builds the playback engine if it isn't there. Called from the toggle and
    // again from sendCurrent(), because closePanel() disposes the engine while
    // the toggle preference survives — reopening the panel with "speak
    // replies" still on must not feed a disposed instance.
    //
    // Concurrent callers share one in-flight load rather than the second one
    // bailing out. openPanel() starts this without awaiting, so sendCurrent()
    // can land mid-import; returning early there left `speaker` null and
    // silently dropped every delta of that turn — a cyan "on" icon and no
    // sound, with nothing anywhere to say why.
    let speakerLoadPromise = null;
    function ensureSpeaker() {
        // Must run before the `await import(...)` below, on every call —
        // all three call sites (enableSpeaker, openPanel, sendCurrent) invoke
        // this synchronously from a real click/Enter-keydown handler, so this
        // one line covers all of them without each needing to remember to
        // prime first. See primeAudioContext()'s comment for why.
        const primedCtx = primeAudioContext();
        if (speaker) return Promise.resolve(true);
        if (speakerLoadPromise) return speakerLoadPromise;
        speakerLoading = true;
        speakerLoadPromise = (async () => {
            try {
                const mod = await import(_vq("./agent-speech.js"));
                speaker = mod.initSpeaker({
                    apiUrl: speakApiUrl,
                    sessionId,
                    audioContext: primedCtx,
                    onStateChange: (state) => {
                        // Unconditional, ahead of the speakerOn guard below:
                        // this is the authoritative "the turn's audio — and so
                        // its paced text — is fully done" signal, and it must
                        // fire even when speakerOn just flipped false (the
                        // speaker-off toggle cancels() before this callback
                        // runs). Without it, whenDrained() could hang forever
                        // and stray reveal timers would keep firing after
                        // finalizeAssistant() has already replaced the DOM.
                        if (state === "idle" && revealQueue) revealQueue.stop();
                        if (!speakerOn) return;
                        setSpeakerMode(state === "speaking" ? "speaking" : "on");
                        if (state !== "speaking") {
                            clearSpeakingIndicator();
                            if (voiceStatus.textContent === "Speaking…") {
                                voiceStatus.classList.add("is-hidden");
                            }
                        }
                    },
                    // Fires only when audio genuinely starts, so the status
                    // line distinguishes "synthesizing" from "actually
                    // audible" — the two are indistinguishable otherwise.
                    // The per-message "Reading aloud" strip lives here too
                    // (not on the earlier "speaking"/enqueued state above):
                    // spec 55 holds text back until this same moment, so
                    // showing the strip any earlier left it sitting over a
                    // still-empty, caret-only message.
                    onPlaying: () => {
                        showVoiceNote("Speaking…", 0);
                        showSpeakingIndicator(currentAssistantLi);
                    },
                    onError: (message) => {
                        // The reply is already on screen, so a synthesis
                        // failure is a note, not an error state.
                        showVoiceNote(message);
                    },
                    // Spec 55: the exact schedule each audio chunk plays on —
                    // handed to whichever reveal queue is active for the
                    // current turn so its text can be paced to match.
                    onChunkScheduled: (info) => {
                        if (revealQueue) revealQueue.scheduleChunk(info);
                    },
                });
                return true;
            } catch (_) {
                showVoiceNote("Voice playback failed to load.");
                return false;
            } finally {
                speakerLoading = false;
                speakerLoadPromise = null;
            }
        })();
        return speakerLoadPromise;
    }

    async function toggleSpeaker() {
        if (speakerOn) {
            speakerOn = false;
            writeSpeakerPref(false);
            if (speaker) speaker.cancel();
            clearSpeakingIndicator();
            setSpeakerMode("off");
            showVoiceNote("Spoken replies off.", 2500);
            return;
        }
        // First time ever: say plainly what is about to happen and let the
        // visitor agree to it. Sound starting off one unlabelled icon click
        // isn't consent. Asked once, then remembered.
        if (!hasConsented()) {
            renderConsentCard();
            return;
        }
        await enableSpeaker();
    }

    // The half of toggleSpeaker that actually turns sound on. Split out so the
    // consent card's "Turn on" button can call it directly — that click is
    // itself a user gesture, which is exactly what unlock() needs.
    async function enableSpeaker() {
        const ok = await ensureSpeaker();
        if (!ok) return;
        // Must run inside the click. Creating and resuming the AudioContext
        // here banks the gesture for the whole page session; the first clip
        // lands 1-2s later, long after the activation window closes.
        speaker.unlock();
        speakerOn = true;
        writeSpeakerPref(true);
        setSpeakerMode("on");
        showVoiceNote("Reading answers aloud. Click the speaker to stop.", 4000);
        liveRegion.textContent = "Spoken replies on.";
        // Warm the TTS path so the first reply doesn't pay the cold ADC token
        // fetch — measured at 5.57s cold against 2.39s warm for one chunk.
        if (warmUrl) {
            fetch(warmUrl, { method: "GET", mode: "cors", cache: "no-store" })
                .catch(() => { /* best-effort */ });
        }
    }

    // ---- first-run consent (spec 50) ------------------------------------

    const SPEAKER_CONSENT_KEY = "atlas.speakReplies.consented";

    function hasConsented() {
        try { return localStorage.getItem(SPEAKER_CONSENT_KEY) === "1"; } catch (_) { return false; }
    }

    // Inline above the composer rather than a <dialog>. showModal() centres
    // against the viewport, which is why the explainer dialog has to be
    // portalled onto document.body; a one-line consent prompt isn't worth
    // that, and it reads better attached to the control it explains.
    function renderConsentCard() {
        if (dom.panel.querySelector(".agent-consent")) return;
        const card = document.createElement("div");
        card.className = "agent-consent";
        card.setAttribute("role", "group");
        card.setAttribute("aria-label", "Spoken replies");
        const copy = document.createElement("p");
        copy.className = "agent-consent-copy";
        copy.textContent = "Atlas reads its answers out loud in a synthesized voice. Turn it off any time with the speaker icon.";
        const actions = document.createElement("div");
        actions.className = "agent-consent-actions";
        const yes = document.createElement("button");
        yes.type = "button";
        yes.className = "agent-consent-yes";
        yes.textContent = "Sounds good";
        const no = document.createElement("button");
        no.type = "button";
        no.className = "agent-consent-no";
        no.textContent = "Not now";
        actions.append(no, yes);
        card.append(copy, actions);
        dom.panel.insertBefore(card, dom.inputRow);

        // Declining has to be recorded, not just dismissed. Voice defaults on,
        // so leaving the pref unwritten would re-arm it and re-prompt on the
        // next turn — the visitor said no, and that has to stick.
        no.addEventListener("click", () => {
            card.remove();
            try { localStorage.setItem(SPEAKER_CONSENT_KEY, "1"); } catch (_) { /* private mode */ }
            speakerOn = false;
            writeSpeakerPref(false);
            setSpeakerMode("off");
        });
        yes.addEventListener("click", async () => {
            try { localStorage.setItem(SPEAKER_CONSENT_KEY, "1"); } catch (_) { /* private mode */ }
            card.remove();
            await enableSpeaker();
            // Speak the answer already on screen. Without this, agreeing does
            // nothing audible until the visitor thinks of something else to
            // ask, which reads as a broken button.
            const last = [...messages].reverse().find(m => m.role === "assistant");
            if (last?.content && speakerOn && speaker) speaker.speak(last.content);
        });
        yes.focus();
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
        } else if (!isSpeaking) {
            // The speaker borrows this same line. Returning the mic to idle
            // must not wipe a live "Speaking…" out from under it.
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
        updateSendReadiness();
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
        // Spec 49: restore a remembered "speak replies" preference here
        // rather than at widget init. Opening the panel is nearly always a
        // real click (the FAB), which is the gesture browsers want before
        // audio may play. On the paths where it isn't — a WebMCP go_to, an
        // action chip — play() is refused and the speaker just stays silent,
        // which agent-speech.js handles by resolving rather than throwing.
        // Two cases, and both need the unlock: a returning visitor whose
        // preference is stored, and one who simply closed and reopened the
        // panel mid-session. closePanel() disposes the engine but leaves
        // speakerOn true, so guarding this on `!speakerOn` skipped the unlock
        // entirely on reopen — synthesis ran, ctx was never created, and
        // every clip was silently dropped.
        if (FEATURES.speakReplies && (speakerOn || readSpeakerPref())) {
            speakerOn = true;
            setSpeakerMode("on");
            // Opening the panel is itself a click, so bank it for audio the
            // same way enableSpeaker() does.
            ensureSpeaker().then((ok) => { if (ok && speaker) speaker.unlock(); });
        }
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
        // Same reasoning as the mic: dismissing the panel must not leave
        // Atlas talking to an empty room. The toggle preference survives in
        // localStorage; the engine instance does not.
        if (speaker) {
            speaker.dispose();
            speaker = null;
        }
        // dispose() (unlike cancel()) never emits a state change, so it is
        // the one teardown path that needs an explicit stop() — otherwise a
        // reveal queue mid-turn would sit waiting on a schedule that will
        // never arrive.
        if (revealQueue) {
            revealQueue.stop();
            revealQueue = null;
        }
        clearSpeakingIndicator();
        if (speakerOn) setSpeakerMode("on");
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

        // Voice is on by default, so the first reply a visitor ever gets would
        // otherwise start talking unannounced. Ask here instead: this turn
        // stays silent, the card sits above the composer while the answer
        // streams in, and agreeing speaks that same answer back rather than
        // making them ask again. Asked once ever, then remembered.
        if (FEATURES.speakReplies && speakerOn && !hasConsented()) {
            speakerOn = false;          // silence THIS turn only
            setSpeakerMode("off");      // the pref is deliberately not written:
            renderConsentCard();        // nothing was chosen yet
        }

        // Spec 49: a new turn silences the previous one and rebuilds the
        // engine if the panel was closed since it last spoke. Awaited here,
        // before the stream opens, so onDelta never races the lazy import.
        if (FEATURES.speakReplies && speakerOn) {
            if (speaker) speaker.cancel();
            await ensureSpeaker();
        }

        appendUser(text);
        messages.push({ role: "user", content: text });

        const assistant = appendAssistantPlaceholder();
        currentAssistantLi = assistant;
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

        // Drops the loading dots/canned copy and folds the Thoughts panel —
        // normally fired on the first raw delta, but when a reveal queue is
        // pacing text to audio (spec 55) it's held for the first word that
        // actually reaches the screen instead, so the loading state doesn't
        // vanish into blank silence while the first audio chunk is still
        // buffering.
        function markFirstDelta() {
            if (!firstDelta) return;
            firstDelta = false;
            sessionWarmed = true;
            stages.cancel();
            settleThinking();
        }

        // Spec 55: only paces text when this turn will actually be spoken —
        // mirrors the exact `speaker` truthiness check onDelta already uses,
        // now that ensureSpeaker() above has settled either way.
        revealQueue = (FEATURES.speakReplies && speakerOn && speaker)
            ? createRevealQueue(assistant, markFirstDelta)
            : null;
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
                    // Spec 55: when a reveal queue is active, the raw delta
                    // must NOT also be painted directly — its text arrives on
                    // screen only via the queue's onChunkScheduled-paced
                    // reveal (which fires markFirstDelta itself, on the first
                    // word actually shown), so voice and text stay in step.
                    // No queue means speaking is off (or unavailable) this
                    // turn, so this is exactly the original instant-append
                    // behavior, first delta included.
                    if (!revealQueue) {
                        markFirstDelta();
                        appendDelta(assistant, delta, FEATURES.typingCursor);
                    }
                    // Chunking happens inside the speaker; this just hands it
                    // the raw stream. Sanitization is server-side, so what is
                    // spoken and what is shown stay in sync.
                    if (FEATURES.speakReplies && speakerOn && speaker) speaker.feed(delta);
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
                async onDone(full) {
                    stages.cancel();
                    settleThinking();
                    // The tail after the last sentence boundary only becomes
                    // speakable once the stream is closed. Skipped on stop:
                    // stopStreaming() has already cancelled playback, and
                    // flushing here would start it up again.
                    if (FEATURES.speakReplies && speakerOn && speaker && !wasStopped) {
                        speaker.flush();
                    }
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
                    // Spec 55: hold the DOM finalization — everything below
                    // this line — until the reveal queue reports every
                    // scheduled chunk has been shown (or superseded by a
                    // stop()). Text-off turns have no queue and fall straight
                    // through, unchanged.
                    if (revealQueue) await revealQueue.whenDrained();
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
                        // A broken connection isn't worth pacing text for —
                        // stop() lets onDone's already-pending await resolve
                        // immediately so the retry button doesn't sit above
                        // reply text still trickling in.
                        if (revealQueue) revealQueue.stop();
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

    // Spec 55: paces one turn's reply text to agent-speech.js's own audio
    // schedule instead of the instant per-delta append `appendDelta` does.
    //
    // Each chunk gets its own independent timer, armed the moment
    // onChunkScheduled fires — mirroring exactly how agent-speech.js's own
    // schedule() arms every audio buffer's source.start() up front, against
    // an accumulating clock cursor, with no chunk's start ever waiting on a
    // previous chunk's callback. An earlier version chained each chunk's
    // timer off the previous chunk's reveal *finishing*, using a delay that
    // had gone stale by the time it was armed — the two waits compounded
    // every chunk, and text visibly stalled while audio (on its own,
    // unrelated clock) kept playing. finishActive() is the safety net for
    // any residual drift: if a new chunk's timer fires before the previous
    // one's word-by-word reveal finished, the remainder is dumped instantly
    // rather than left to fall further behind.
    //
    // finalizeAssistant() always eventually replaces this queue's DOM output
    // with the authoritative full-text render, in every completion path
    // (normal, stopped, or mid-stream error) — so stop() only has to silence
    // this queue's own timers before that happens, never force-append
    // anything itself.
    function createRevealQueue(li, onFirstReveal) {
        const p = li.querySelector(".agent-message-text");
        const timers = new Set(); // setTimeout ids waiting on a chunk's start
        let rafId = null;
        let active = null;        // { words, idx } of the reveal in progress
        let stopped = false;
        let revealed = false;
        let resolveDrained = null;
        const drained = new Promise((resolve) => { resolveDrained = resolve; });

        function settle() {
            if (resolveDrained) { resolveDrained(); resolveDrained = null; }
        }

        function appendWord(word) {
            if (!p || !word) return;
            if (!revealed) {
                revealed = true;
                if (typeof onFirstReveal === "function") onFirstReveal();
            }
            p.appendChild(document.createTextNode(word));
            scrollToEnd();
        }

        // Instantly shows whatever the current reveal hasn't gotten to yet.
        // Called before starting a new chunk's reveal (so two never overlap)
        // and from stop() — never leaves this queue's idea of "shown" behind
        // what should already be visible.
        function finishActive() {
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            if (!active) return;
            const { words } = active;
            while (active.idx < words.length) {
                appendWord(words[active.idx]);
                active.idx += 1;
            }
            active = null;
        }

        function runReveal(words, durationMs) {
            finishActive();
            const start = performance.now();
            const total = words.length;
            const mine = { words, idx: 0 };
            active = mine;
            function step(now) {
                if (stopped || active !== mine) return; // stopped or superseded
                const elapsed = now - start;
                const targetIdx = total <= 1 || durationMs <= 0
                    ? total
                    : Math.min(total, Math.ceil((elapsed / durationMs) * total));
                while (mine.idx < targetIdx) {
                    appendWord(words[mine.idx]);
                    mine.idx += 1;
                }
                if (mine.idx < total) {
                    rafId = requestAnimationFrame(step);
                } else {
                    rafId = null;
                    active = null;
                }
            }
            rafId = requestAnimationFrame(step);
        }

        return {
            // Arms this chunk's own timer immediately — ctxNow/ctxStartAt
            // are a fresh read from the instant onChunkScheduled fired, so
            // there is no deferral gap for them to go stale in.
            scheduleChunk({ text, ctxNow, ctxStartAt, durationSec }) {
                if (stopped) return;
                const delayMs = Math.max(0, (ctxStartAt - ctxNow) * 1000);
                const words = text.split(/(\s+)/).filter((w) => w !== "");
                const id = setTimeout(() => {
                    timers.delete(id);
                    if (stopped) return;
                    runReveal(words, Math.max(0, durationSec * 1000));
                }, delayMs);
                timers.add(id);
            },
            // Resolves once every scheduled chunk (including the tail from
            // speaker.flush()) has either been revealed or superseded by
            // stop() — the signal onDone() waits on before finalizing.
            whenDrained() {
                return drained;
            },
            // Silences this queue: clears pending timers/animation, so a
            // straggling callback can never append a stray word after
            // finalizeAssistant() has already replaced the message's DOM.
            stop() {
                if (stopped) { settle(); return; }
                stopped = true;
                timers.forEach((id) => clearTimeout(id));
                timers.clear();
                if (rafId) cancelAnimationFrame(rafId);
                rafId = null;
                active = null;
                settle();
            },
        };
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
        const links = [];
        ids.forEach(id => {
            const c = citations[id];
            if (!c?.url) return;
            const a = document.createElement("a");
            a.className = "agent-source-link";
            a.href = escapeUrl(c.url);
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = `[${id}] ${c.label || c.url}`;
            links.push(a);
        });
        if (!links.length) return;

        // Collapsed by default — the panel is small, and a citation list
        // shouldn't outweigh the answer it's supporting. Mirrors the
        // Thinking panel's toggle/body/chevron shape exactly (same
        // aria-expanded + hidden mechanics) rather than a new pattern.
        const wrap = document.createElement("div");
        wrap.className = "agent-sources";
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "agent-sources-toggle";
        toggle.setAttribute("aria-expanded", "false");
        toggle.innerHTML =
            `<span class="agent-sources-label">Sources (${links.length})</span>` +
            '<span class="agent-sources-chevron" aria-hidden="true">▾</span>';
        const body = document.createElement("div");
        body.className = "agent-sources-body";
        body.hidden = true;
        body.append(...links);
        toggle.addEventListener("click", () => {
            const open = toggle.getAttribute("aria-expanded") === "true";
            toggle.setAttribute("aria-expanded", String(!open));
            body.hidden = open;
        });
        wrap.append(toggle, body);
        assistantLi.appendChild(wrap);
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

export function buildAgentDiagram(opts) {
    // opts.wide forces the roomy desktop layout regardless of viewport — the
    // fullscreen view uses it so a phone still gets the readable version.
    const wide = !!(opts && opts.wide);
    const NS = "http://www.w3.org/2000/svg";
    const el = (tag, attrs) => {
        const e = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
        return e;
    };

    // On mobile (<540px) use a 250-unit viewBox (vs 480 desktop) so the diagram
    // renders at ~1.32x natural scale rather than ~0.65x, making it prominent.
    const mobile = !wide && window.innerWidth < 540;
    // Wider than they need to be for the boxes alone: the full "Speech-to-Text
    // (STT)" / "Text-to-Speech (TTS)" sub-labels are ~96 units at the sub font
    // size, so the model boxes grew and the viewBox grew with them.
    const VW = mobile ? 300 : 540;
    const VH = mobile ? 320 : 250;

    const svg = el("svg", { viewBox: `0 0 ${VW} ${VH}`, width: "100%", height: String(VH),
                             class: "ad-svg", "aria-hidden": "true" });

    // A loop that starts and ends with You: ask (1) → speech to text (2) →
    // the agent gathers grounding (3) and takes actions (4) → reasons (5) →
    // text to speech (6) → the spoken reply lands back with you (7).
    // Nothing is written on the connectors — text sitting on a line was the
    // main thing making this hard to read. Every stage word lives in a node's
    // own sub-label or in the numbered legend under the figure, so the lines
    // stay clean. All seven edges are numbered steps, so all seven carry the
    // accent; nothing here is a silent side-path any more.
    // The two speech boxes are taller than the rest (two-line model names), so
    // the spine legs meeting them are shorter: STT spans y 60..102 and TTS
    // y 248..290, against 66..96 / 254..284 before.
    // Right column (Flash/Corpus/MCP) sits at x=180 rather than 176 — a wider
    // gap off the Agent box gives the two diagonal edges below more room to
    // fan out before they converge, which was the main source of clutter.
    const edges = mobile ? [
        { d: "M 96 36 L 96 60" },
        { d: "M 96 102 L 96 126" },
        { d: "M 108 160 L 180 195" },
        { d: "M 114 160 L 180 243" },
        { d: "M 152 143 L 180 143" },
        { d: "M 96 160 L 96 248" },
        { d: "M 96 290 L 96 306 L 18 306 L 18 21 L 40 21" },
    ] : [
        { d: "M 101 120 L 135 120" },
        { d: "M 243 120 L 277 120" },
        { d: "M 307 142 L 273 170" },
        { d: "M 343 142 L 397 170" },
        { d: "M 325 98 L 325 54" },
        { d: "M 373 120 L 407 120" },
        { d: "M 461 142 L 461 228 L 63 228 L 63 142" },
    ];
    edges.forEach(({ d }) => {
        svg.appendChild(el("path", { class: "ad-edge ad-edge--key", d }));
    });

    // Numbered markers keyed to the legend below the figure. They light one
    // after another (delay = n-1 on an 8s cycle) so the animation traces the
    // route in order rather than pulsing everything at once.
    const step = (n, cx, cy) => {
        const g = el("g", { class: "ad-step" });
        g.appendChild(el("circle", { cx: String(cx), cy: String(cy), r: "8" }));
        const t = el("text", { x: String(cx), y: String(cy + 3), "text-anchor": "middle" });
        t.textContent = String(n);
        g.appendChild(t);
        if (!REDUCE_MOTION) g.style.animationDelay = `${n - 1}s`;
        return g;
    };
    // 3 and 4 sit partway along the corpus/MCP diagonals rather than at their
    // midpoints, which would collide with each other on the mobile layout.
    // Corpus and MCP deliberately SHARE step 4: the model calls tools as one
    // step, and they're alternatives rather than a sequence (MCP only fires
    // when something needs doing, like emailing the resume). Sharing the
    // number also means both badges light together, which is the intent.
    const steps = mobile
        ? [[4, 148, 179], [4, 150, 206], [1, 96, 51], [2, 96, 111], [3, 166, 143], [5, 96, 215], [6, 18, 160]]
        // 6 sits on the final leg arriving back at You — the descent at x=461
        // runs behind the MCP Server node, which draws over it.
        : [[4, 290, 156], [4, 370, 156], [1, 118, 120], [2, 260, 120], [3, 325, 76], [5, 390, 120], [6, 63, 190]];
    steps.forEach(([n, cx, cy]) => svg.appendChild(step(n, cx, cy)));

    // A waveform converting into text lines (or the reverse), shown beside the
    // speech nodes so they say what they do, not just which model does it.
    // `step` ties it to that stage's badge: same 7s cycle, same delay, so the
    // conversion plays while its number is lit and rests still otherwise.
    const BAR_W = 3, BAR_GAP = 4, BAR_HEIGHTS = [7, 13, 18, 11, 6];
    const LINE_WS = [30, 22, 26], LINE_GAP = 7;
    const xformStrip = (cx, cy, dir, step) => {
        const toText = dir === "to-text";
        const g = el("g", { class: `ad-xform ad-xform--${dir}` });
        if (!REDUCE_MOTION) g.style.animationDelay = `${step - 1}s`;

        const waveW = BAR_HEIGHTS.length * BAR_W + (BAR_HEIGHTS.length - 1) * BAR_GAP;
        const textW = Math.max(...LINE_WS);
        const GAP = 12;
        const total = waveW + GAP + textW;
        // Waveform on the left when converting to text; mirrored otherwise.
        const waveX = cx - total / 2 + (toText ? 0 : textW + GAP);
        const textX = cx - total / 2 + (toText ? waveW + GAP : 0);

        const wave = el("g", { class: "ad-xform-wave" });
        BAR_HEIGHTS.forEach((h, i) => {
            const r = el("rect", {
                x: String(waveX + i * (BAR_W + BAR_GAP)), y: String(cy - h / 2),
                width: String(BAR_W), height: String(h), rx: "1.5",
            });
            // Stagger the bars so the group reads as audio, not one solid block.
            if (!REDUCE_MOTION) r.style.animationDelay = `${step - 1 + i * 0.08}s`;
            wave.appendChild(r);
        });

        const text = el("g", { class: "ad-xform-text" });
        LINE_WS.forEach((w, i) => {
            const y = cy - LINE_GAP + i * LINE_GAP;
            const r = el("rect", {
                x: String(textX), y: String(y - 1), width: String(w), height: "2", rx: "1",
            });
            if (!REDUCE_MOTION) r.style.animationDelay = `${step - 1 + i * 0.1}s`;
            text.appendChild(r);
        });

        // A chevron in the gap between the halves. Without it the strip is just
        // bars next to lines — the arrow is what makes it read as "becomes",
        // and it points the same way the pipeline runs in both directions.
        const arrowX = cx - total / 2 + (toText ? waveW : textW) + GAP / 2;
        const arrow = el("path", {
            class: "ad-xform-arrow",
            d: `M ${arrowX - 2} ${cy - 3.5} L ${arrowX + 2} ${cy} L ${arrowX - 2} ${cy + 3.5}`,
        });
        if (!REDUCE_MOTION) arrow.style.animationDelay = `${step - 1}s`;

        // Drawn in flow order: the source half first, then what it becomes.
        g.append(...(toText ? [wave, arrow, text] : [text, arrow, wave]));
        return g;
    };

    // Small stick figure marking the human end of the loop, drawn to the left
    // of the node's name so "You" reads as a person, not another service.
    const personGlyph = (cx, cy) => {
        const g = el("g", { class: "ad-person" });
        g.appendChild(el("circle", { cx: String(cx), cy: String(cy - 3.5), r: "2.6" }));
        g.appendChild(el("path", { d: `M ${cx - 4.5} ${cy + 5} v -1.2 a 4.5 4.5 0 0 1 9 0 v 1.2` }));
        return g;
    };

    // The official Gemini mark, same same-origin asset the engineering-loops
    // lab uses via brandLogo(). img-src 'self' in the CSP already covers it.
    const geminiLogo = (cx, cy, size) => {
        const im = el("image", {
            x: String(cx - size / 2), y: String(cy - size / 2),
            width: String(size), height: String(size),
            preserveAspectRatio: "xMidYMid meet",
            class: "ad-brand",
        });
        im.setAttribute("href", "/assets/img/logo-gemini.svg");
        return im;
    };

    // `lead` draws a glyph immediately before the node's name, inside the box:
    // "person" for You, "gemini" for the model nodes. The pair is centred as a
    // unit, so the offset is derived from the name's own width rather than a
    // fixed nudge (a fixed one only ever looks right for one label length).
    // `name` is a string, or [line1, line2] for the model nodes whose full name
    // is too wide for the box on one line. "Gemini 3.5 Transcribe" is ~141
    // units against a 108 box; split, the widest line is 75 and the sub-label
    // (~96) stays the widest thing in the box, so no box has to grow wider.
    const LEAD_SIZE = 11, LEAD_GAP = 4, NAME_ADVANCE = 6; // 10px mono ≈ 6px/char
    const node = (cls, rx, ry, rw, rh, name, sub, tip, cx, details, lead) => {
        const g = el("g", { class: cls ? `ad-node ${cls}` : "ad-node" });
        const t = el("title", {}); t.textContent = tip; g.appendChild(t);
        g.appendChild(el("rect", { x: String(rx), y: String(ry), width: String(rw), height: String(rh), rx: "6" }));

        const lines = Array.isArray(name) ? name : [name];
        const two = lines.length > 1;
        // Two lines need a tighter rhythm to keep all three rows inside the box.
        const nameY = ry + Math.floor(rh * (two ? 0.30 : 0.42));
        const subY  = ry + Math.floor(rh * (two ? 0.80 : 0.75));
        const lineH = Math.floor(rh * 0.25);

        let nameCx = cx;
        if (lead) {
            // Centre the glyph+name pair on the FIRST line only; the second
            // line centres on the box, so the mark stays tight to the name it
            // belongs to instead of floating beside a two-line block.
            const nameW = lines[0].length * NAME_ADVANCE;
            const total = LEAD_SIZE + LEAD_GAP + nameW;
            const left = cx - total / 2;
            nameCx = left + LEAD_SIZE + LEAD_GAP + nameW / 2;
            const gx = left + LEAD_SIZE / 2;
            if (lead === "person") g.appendChild(personGlyph(gx, nameY - 3));
            else g.appendChild(geminiLogo(gx, nameY - 3.5, LEAD_SIZE));
        }
        lines.forEach((line, i) => {
            const nm = el("text", {
                class: "ad-node-name",
                x: String(i === 0 ? nameCx : cx),
                y: String(nameY + i * lineH),
                "text-anchor": "middle",
            });
            nm.textContent = line;
            g.appendChild(nm);
        });

        const sb = el("text", { class: "ad-node-sub", x: String(cx), y: String(subY), "text-anchor": "middle" });
        sb.textContent = sub; g.appendChild(sb);
        if (details?.length) g.setAttribute("data-ad-tip", details.join("\n"));
        return g;
    };

    const TIPS = {
        you:    ["you type, or hold the mic", "the reply streams back as text", "and plays back as speech"],
        llm:    ["Gemini 3.7 Flash", "reasoning + generation", "plans tool calls · synthesizes reply", "falls back to 3.6 Flash on overload"],
        agent:  ["get_profile · get_work_history", "get_projects · get_recent_posts", "get_certifications", "ADK orchestrator on Cloud Run"],
        corpus: ["profile.json · bio, roles, certs", "graph.json · projects", "posts.json · LinkedIn", "fetched live, short-TTL cache"],
        stt:    ["Gemini 3.5 Transcribe", "speech-to-text · mic input", "runs before the agent reasons, outside the ADK loop"],
        tts:    ["Gemini 3.1 Flash TTS", "text-to-speech · spoken replies", "runs after the reply streams, chunked via Web Audio API"],
        mcp:    ["send-email (Resend API)", "compose + fire transactional email", "agent-triggered · not a webhook"],
    };

    // ad-node--key marks the AI-model stages (Gemini, STT, TTS) with an accent
    // node name; ad-node--you marks the human entry/exit point. Data Corpus and
    // MCP Server stay plain so the model stages read as the primary path.
    // See components.css.
    if (mobile) {
        // Vertical spine at cx=96 (You → STT → Agent → TTS), satellites stacked
        // to the right of the Agent, and the step-7 return path running back up
        // the clear left corridor at x=18.
        svg.appendChild(node("ad-node--you",  40,   6, 112, 30, "You",        "ask · listen",         "You: type a question or hold the mic", 96, TIPS.you, "person"));
        svg.appendChild(node("ad-node--key",  40,  60, 112, 42, ["Gemini 3.5", "Transcribe"], "Speech-to-Text (STT)", "Gemini 3.5 Transcribe converts mic input to text", 96, TIPS.stt, "gemini"));
        svg.appendChild(node("ad-node--hub",  40, 126, 112, 34, "Agent",      "ADK",                  "ADK agent on Cloud Run, orchestrates all tool calls", 96, TIPS.agent));
        svg.appendChild(node("ad-node--key", 180, 126, 116, 34, "Gemini 3.7 Flash", "reasoning",      "Google Gemini, reasoning and language generation", 238, TIPS.llm, "gemini"));
        svg.appendChild(node(null,           180, 180, 116, 30, "Corpus",     "grounding",            "Live JSON fetch, grounding source for every reply", 238, TIPS.corpus));
        svg.appendChild(node(null,           180, 228, 116, 30, "MCP",        "actions",              "MCP-compatible Resend server, fires email on agent request", 238, TIPS.mcp));
        svg.appendChild(node("ad-node--key",  40, 248, 112, 42, ["Gemini 3.1", "Flash TTS"], "Text-to-Speech (TTS)", "Gemini 3.1 Flash TTS converts the reply to speech", 96, TIPS.tts, "gemini"));
        // Beside the boxes here, not above: step badge 1 and the spine edge
        // already occupy the space over the STT node at this width.
        svg.appendChild(xformStrip(226,  81, "to-text",  2));
        svg.appendChild(xformStrip(226, 269, "to-voice", 5));
    } else {
        // Horizontal pipeline row at y=98 (You → STT → Agent → TTS), Gemini
        // above the Agent, Corpus/MCP below it, and the step-7 return path
        // looping along y=228 back to You. 34px between boxes leaves the step
        // badges room to sit clear of both, so the connectors stay readable.
        svg.appendChild(node("ad-node--you",  25,  98,  76, 44, "You",              "ask · listen",         "You: type a question or hold the mic", 63, TIPS.you, "person"));
        svg.appendChild(node("ad-node--key", 135,  92, 108, 56, ["Gemini 3.5", "Transcribe"], "Speech-to-Text (STT)", "Gemini 3.5 Transcribe converts mic input to text", 189, TIPS.stt, "gemini"));
        svg.appendChild(node("ad-node--hub", 277,  98,  96, 44, "Agent",            "ADK loop",             "ADK agent on Cloud Run, orchestrates all tool calls", 325, TIPS.agent));
        svg.appendChild(node("ad-node--key", 407,  92, 108, 56, ["Gemini 3.1", "Flash TTS"], "Text-to-Speech (TTS)", "Gemini 3.1 Flash TTS converts the reply to speech", 461, TIPS.tts, "gemini"));
        svg.appendChild(node("ad-node--key", 263,  14, 124, 40, "Gemini 3.7 Flash", "reasoning",            "Google Gemini, reasoning and language generation", 325, TIPS.llm, "gemini"));
        svg.appendChild(node(null,           217, 170, 112, 38, "Data Corpus",      "grounding",            "Live JSON fetch, grounding source for every reply", 273, TIPS.corpus));
        svg.appendChild(node(null,           345, 170, 104, 38, "MCP Server",       "actions",              "MCP-compatible Resend server, fires email on agent request", 397, TIPS.mcp));
        // Above each speech box — the space over them is clear at this width
        // (the Gemini 3.7 box starts at x=263, well right of the STT strip).
        svg.appendChild(xformStrip(189, 73, "to-text",  2));
        svg.appendChild(xformStrip(461, 73, "to-voice", 5));
    }

    return svg;
}

// The five pipeline steps, written once and used by both the legend under
// the diagram and the fullscreen view. Numbers match the badges in the SVG.
// Step 4 covers both tool nodes in the diagram, which share that badge:
// the model decides in step 3, then calls whichever tools it needs.
const AGENT_STEPS = [
    ["You ask", "typed, or held down the mic"],
    ["Speech-to-Text (STT)", "Gemini 3.5 Transcribe turns the recording into text"],
    ["Reasoning", "Gemini 3.7 Flash works out what it needs and what to call"],
    ["Tools", "it reads the live corpus for facts, and calls the MCP server when something needs doing, like emailing the resume"],
    ["Text-to-Speech (TTS)", "Gemini 3.1 Flash TTS turns the finished reply into speech"],
    ["Back to you", "text streams in, audio plays alongside it"],
];

function buildAgentLegend() {
    const ol = document.createElement("ol");
    ol.className = "ad-legend";
    AGENT_STEPS.forEach(([name, detail], i) => {
        const li = document.createElement("li");
        const n = document.createElement("span");
        n.className = "ad-legend-n";
        n.textContent = String(i + 1);
        const txt = document.createElement("span");
        const strong = document.createElement("strong");
        strong.textContent = name;
        txt.append(strong, ` · ${detail}`);
        li.append(n, txt);
        ol.appendChild(li);
    });
    return ol;
}

// Wraps the SVG with an expand control. The diagram is dense at the modal's
// 520px width, so fullscreen is the escape hatch rather than the only way to
// read it — and the fullscreen copy is always built with the roomy desktop
// layout, so a phone gets the readable version too.
function buildAgentFigure(parentDialog) {
    const fig = document.createElement("div");
    fig.className = "ad-figure";
    const svg = buildAgentDiagram();
    fig.appendChild(svg);
    _setupDiagramTooltips(svg, parentDialog);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ad-expand";
    btn.setAttribute("aria-label", "View the diagram full screen");
    btn.innerHTML = `
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"/>
        </svg>
        <span>Expand</span>`;
    btn.addEventListener("click", () => openAgentDiagramZoom());
    fig.appendChild(btn);
    return fig;
}

let _zoomDialog = null;
function openAgentDiagramZoom() {
    if (!_zoomDialog) {
        _zoomDialog = document.createElement("dialog");
        _zoomDialog.className = "ad-zoom-dialog";

        const close = document.createElement("button");
        close.type = "button";
        close.className = "agent-explainer-close ad-zoom-close";
        close.setAttribute("aria-label", "Close");
        close.textContent = "×";
        close.addEventListener("click", () => _zoomDialog.close());

        const svg = buildAgentDiagram({ wide: true });
        _zoomDialog.append(close, svg, buildAgentLegend());
        // Backdrop click closes, matching the explainer dialog's behaviour.
        _zoomDialog.addEventListener("click", (e) => {
            if (e.target === _zoomDialog) _zoomDialog.close();
        });
        document.body.appendChild(_zoomDialog);
        _setupDiagramTooltips(svg, _zoomDialog);
    }
    _zoomDialog.showModal();
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
        // Figure stays pinned; legend + prose scroll under it so the diagram
        // keeps the space rather than being pushed off by the copy.
        bodyEl.appendChild(buildAgentFigure(dialog));
        const scroll = document.createElement("div");
        scroll.className = "agent-explainer-scroll";
        scroll.appendChild(buildAgentLegend());
        agentExplainer.body.forEach(para => {
            const p = document.createElement("p");
            p.appendChild(parseEmphasis(para));
            scroll.appendChild(p);
        });
        bodyEl.appendChild(scroll);
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
            <button type="button" class="agent-speaker" data-mode="off" aria-pressed="false" aria-label="Speak replies" title="Speak replies">
                <svg class="agent-speaker-glyph agent-speaker-glyph-off" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M8 2.5 4.5 5.5H2v5h2.5L8 13.5Z"/>
                    <path d="M11 6l3 4M14 6l-3 4"/>
                </svg>
                <svg class="agent-speaker-glyph agent-speaker-glyph-on" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M8 2.5 4.5 5.5H2v5h2.5L8 13.5Z"/>
                    <path d="M10.5 6a3 3 0 0 1 0 4"/>
                    <path d="M12.5 4a5.5 5.5 0 0 1 0 8"/>
                </svg>
            </button>
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
    const speakerBtn = head.querySelector(".agent-speaker");
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
    // "Ask about Gaurav's work…" previously clipped on narrow mobile
    // widths before .agent-input's min-width: 0 fix (below) let the
    // textarea actually shrink to fit alongside the mic/send buttons —
    // re-verified fitting fine now that fix is in place.
    input.placeholder = "Ask about Gaurav's work…";
    input.setAttribute("aria-label", "Message");
    // Spec 26: native-feeling soft-keyboard hints on touch devices.
    input.setAttribute("enterkeyhint", "send");
    input.setAttribute("inputmode", "text");
    input.setAttribute("autocapitalize", "sentences");
    input.setAttribute("autocorrect", "on");
    input.setAttribute("spellcheck", "true");
    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.className = "agent-send is-empty";
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
        prompts, transcript, input, inputRow, sendBtn, micBtn, speakerBtn, voiceStatus, liveRegion, foot,
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
