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
    badges:          true, // spec 56: cert badge art on certification answers
    avatarMode:      true, // spec 67: opt-in Gemini Live Avatar stage in the panel
    avatarConversation: true, // spec 71: hands-free "Start conversation" in Avatar mode
});

const ALLOWED_HOSTS = ["linkedin.com", "github.com", "gauravlahoti.dev", "gauravlahoti.github.io", "topmate.io",
                       "credly.com", "cp.certmetrics.com", "learn.microsoft.com"];
const URL_RE = /https?:\/\/[^\s<>()\[\]]+/gi;

// Spec 56: issuer grouping order for the certification badge strip. Anything
// not listed sorts after these, in the order it first appears in the reply.
const ISSUER_ORDER = ["Anthropic", "AWS", "Google Cloud", "Microsoft"];

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

export function initAgentWidget(root, profile, pageSessionId) {
    const links = (profile && profile.links) || {};
    const apiUrl = links.agentApi;
    const warmUrl = links.agentWarm;
    // Spec 48: same host, sibling route — not a second config key.
    const transcribeApiUrl = apiUrl ? apiUrl.replace(/\/api\/agent-chat$/, "/api/agent-transcribe") : apiUrl;
    // Spec 49: same again for spoken replies.
    const speakApiUrl = apiUrl ? apiUrl.replace(/\/api\/agent-chat$/, "/api/agent-speak") : apiUrl;
    const probeBase = apiUrl ? apiUrl.replace(/\/api\/agent-chat$/, "/api/stream-probe") : apiUrl;
    // Avatar answers come from a live session that is ~1.5s faster once it
    // has been open a moment, so one is opened as the visitor starts typing.
    const liveWarmUrl = apiUrl ? apiUrl.replace(/\/api\/agent-chat$/, "/api/agent-live/warm") : apiUrl;
    if (!apiUrl) {
        console.warn("[agent-widget] profile.links.agentApi missing");
        return null;
    }

    // Generated once in main.js at page load and shared with the pageview
    // beacon, so page_views.session_id and agent_interactions.session_id can
    // agree on the same visitor journey. Not persisted to localStorage — a
    // fresh id every page load, same as before.
    // "Clear conversation" starts a new server-side session (Atlas keeps its
    // history per sessionId), so this is the page's id until then.
    let sessionId = pageSessionId;
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
    const clearBtn = dom.clearBtn;
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
    // Spec 67: the avatar is thinking or talking (a live turn or the greeting).
    let avatarBusy = false;
    let voiceNoteTimer = null;
    // The assistant message of the turn in flight. The speaker's state
    // callback fires asynchronously and needs to know which message to hang
    // the "Reading aloud" strip on.
    let currentAssistantLi = null;

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
    // The placeholder names the mic only when there is one to tap.
    if (FEATURES.voiceInput && !micBtn.classList.contains("is-hidden")) {
        input.placeholder = "Type or tap the mic to ask…";
    }
    refreshActionSlot();

    fab.addEventListener("click", togglePanel);
    dom.closeBtn.addEventListener("click", closePanel);
    dom.expandBtn.addEventListener("click", toggleExpand);
    dom.minimizeBtn.addEventListener("click", toggleMinimize);
    // Click on the minimized header bar to restore
    dom.head.addEventListener("click", (e) => {
        if (isMinimized && !e.target.closest("button")) restore();
        else if (panel.classList.contains("is-floating") && !e.target.closest("button")) setFloating(false);
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
    // Spec 67: the header's Text / Voice / Avatar switch replaces the bare
    // speaker icon. speakerBtn stays in the DOM, hidden, as the state holder
    // the spoken-reply code (specs 49-62) already reads and writes; the
    // switch drives that same code and mirrors its state.
    speakerBtn.classList.add("is-hidden");
    const modeSwitch = dom.modeSwitch;
    if (!FEATURES.speakReplies) modeSwitch.querySelector('[data-mode="voice"]').hidden = true;
    if (!FEATURES.avatarMode) modeSwitch.querySelector('[data-mode="avatar"]').hidden = true;

    // Avatar mode: opt-in, remembered, and lazy. agent-avatar.js (and its
    // clip) only load once a visitor picks it. The stage becomes the
    // header's last row, so the chat below is untouched.
    const AVATAR_PREF_KEY = "atlasAvatarMode_v1";
    const AVATAR_TRIED_KEY = "atlasAvatarTried_v1";
    let avatar = null;
    let avatarLoading = null;
    let avatarOn = false;
    // Set once the server says this visitor (or the day's budget) is out of
    // avatar answers. Later Avatar-mode questions go straight to the offer to
    // switch modes, without another request.
    // Spec 72: remembered for the rest of the UTC day, so a reload or a
    // reopened panel goes straight to Voice instead of dead-ending again.
    const AVATAR_REST_KEY = "atlasAvatarRest_v1";
    const todayUtc = () => new Date().toISOString().slice(0, 10);
    let avatarResting = (() => {
        try { return localStorage.getItem(AVATAR_REST_KEY) === todayUtc(); } catch (_) { return false; }
    })();
    let avatarRestReason = avatarResting ? "That's all the avatar time for today." : "";
    let leavingAvatar = null; // spec 73: finishes a face still dissolving
    let convo = null;         // spec 71: the active hands-free conversation
    let convoControls = null; // { root, start, mute, end, hint }
    function readAvatarPref() {
        try { return localStorage.getItem(AVATAR_PREF_KEY) === "1"; } catch (_) { return false; }
    }
    function writeAvatarPref(on) {
        try {
            localStorage.setItem(AVATAR_PREF_KEY, on ? "1" : "0");
            if (on) localStorage.setItem(AVATAR_TRIED_KEY, "1");
        } catch (_) { /* ignore */ }
    }
    function avatarTried() {
        try { return localStorage.getItem(AVATAR_TRIED_KEY) === "1"; } catch (_) { return false; }
    }
    // The recorded greeting plays once per visitor, the first time Avatar is
    // picked. After that, switching back to Avatar goes straight to the idle
    // face, like rejoining a call rather than restarting it.
    const AVATAR_GREETED_KEY = "atlasAvatarGreeted_v1";
    function takeAvatarGreeting() {
        try {
            if (localStorage.getItem(AVATAR_GREETED_KEY) === "1") return false;
            localStorage.setItem(AVATAR_GREETED_KEY, "1");
        } catch (_) { /* private mode: greet this once, per page */ }
        if (greetedThisPage) return false;
        greetedThisPage = true;
        return true;
    }
    let greetedThisPage = false;
    function pauseAvatar() { if (avatar) avatar.pause(); }

    // ---- hands-free conversation (spec 71) ---------------------------------
    // "Start conversation" under the face: the mic stays open, the avatar
    // takes turns on its own, talking over it interrupts it, and every turn
    // lands in the same chat as typed ones. Push-to-send stays the default;
    // this is an explicit choice, because it opens the microphone.
    const liveConvoUrl = apiUrl ? apiUrl.replace(/^http/, "ws").replace(/\/api\/agent-chat$/, "/api/agent-live") : apiUrl;

    function mountConvoControls(slot, canSpeak) {
        if (!FEATURES.avatarConversation || !liveConvoUrl) return;
        const make = (cls, label) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = `agent-convo-btn ${cls}`;
            b.textContent = label;
            return b;
        };
        const root = document.createElement("div");
        root.className = "agent-convo";
        const start = make("agent-convo-start", "Start conversation");
        // Spec 72: a spoken call has two controls, Mute and End. Talking
        // over Atlas interrupts it, so there is no Stop, and no composer:
        // End brings the composer back for anything easier typed.
        const mute = make("agent-convo-mute", "Mute");
        mute.setAttribute("aria-pressed", "false");
        const end = make("agent-convo-end", "End");
        // Spec 86: with no composer, Stop lives here, and only while the
        // recorded greeting plays. A call has End, and talking over Atlas.
        const stop = make("agent-convo-stop", "Stop");
        stop.setAttribute("aria-label", "Stop the greeting");
        const hint = document.createElement("p");
        hint.className = "agent-convo-hint";
        hint.setAttribute("role", "status");
        mute.hidden = end.hidden = stop.hidden = hint.hidden = true;
        root.append(start, stop, mute, end, hint);
        slot.appendChild(root);
        start.addEventListener("click", startConversation);
        stop.addEventListener("click", pauseAvatar);
        mute.addEventListener("click", toggleConvoMute);
        end.addEventListener("click", () => { endConversation(); hangUpFace(); });
        convoControls = { root, start, stop, mute, end, hint };
        const supported = canSpeak && typeof WebSocket === "function" && typeof window.AudioWorkletNode === "function"
            && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
        if (!supported) root.hidden = true;
        // Spec 86: Avatar is hands-free. Where a spoken call works, the
        // composer goes; a browser that can't hold one keeps it, so Avatar
        // is never a dead end.
        panel.classList.toggle("is-handsfree", supported);
    }

    // Spec 86: outside a call, the face only speaks the recorded greeting.
    function syncGreetingStop(state) {
        const c = convoControls;
        if (c) c.stop.hidden = !(state === "speaking" && !convo);
    }

    function showConvoHint(text) {
        const c = convoControls;
        if (!c) return;
        c.hint.textContent = text || "";
        c.hint.hidden = !text;
    }

    function resetConvoControls() {
        const c = convoControls;
        if (!c) return;
        c.start.hidden = false;
        c.start.disabled = false;
        c.start.textContent = "Start conversation";
        c.mute.hidden = c.end.hidden = true;
        c.mute.setAttribute("aria-pressed", "false");
        c.mute.textContent = "Mute";
    }

    async function startConversation() {
        if (avatarResting) { renderRestCard(); return; }
        if (convo || !avatar || isPending) return;
        const c = convoControls;
        c.start.disabled = true;
        c.start.textContent = "Connecting…";
        showConvoHint("");
        if (speaker) speaker.cancel();
        let mod;
        try {
            mod = await import(_vq("./agent-live.js"));
        } catch (_) {
            resetConvoControls();
            showConvoHint("Couldn't load the conversation. Try again in a moment.");
            return;
        }
        if (!mod.liveSupported()) {
            resetConvoControls();
            showConvoHint("This browser can't hold a spoken conversation. Type, or use the mic button instead.");
            return;
        }
        // Spec 86: if the face closes under a live call (a pause, the
        // watchdog), end the call with it. Left running, it kept hearing and
        // answering in text with no voice, and spent the day's avatar time.
        const face = avatar.startLive({
            onClose: () => {
                if (convo !== s) return; // already ending from here
                endConversation({ reason: "The call dropped. Start a new one whenever you like." });
                hangUpFace();
            },
        });
        const s = { face, live: null, userLi: null, assistantLi: null, wordsEl: null, turn: null, spoke: false, heard: "" };
        convo = s;
        panel.classList.add("is-conversing");
        refreshSendMode();
        try {
            s.live = await mod.startLiveConversation({
                url: liveConvoUrl,
                sessionId,
                onVideo: (bytes) => face.pushBytes(bytes),
                onEvent: onConvoEvent,
                onEnd: async (end) => {
                    // Spec 79: after a goodbye, let the last words play out
                    // before hanging up; the server has already stopped.
                    if (end && end.goodbye) await playedOut(face);
                    if (convo !== s) return; // ended from here meanwhile
                    endConversation(end);
                    if (!(end && end.capped)) hangUpFace();
                },
            });
        } catch (err) {
            if (convo === s) convo = null;
            face.abort();
            panel.classList.remove("is-conversing");
            resetConvoControls();
            showConvoHint(err && err.message);
            refreshSendMode();
            return;
        }
        if (convo !== s) { s.live.end(); return; } // ended while connecting
        c.start.hidden = true;
        c.mute.hidden = c.end.hidden = false;
        syncMinimizeLabel();
        // The ring hears the visitor. No arrival here: the face already built
        // itself when Avatar mode opened, and playing it again read as a glitch.
        avatar.setMicLevel(() => (s.live ? s.live.level() : 0));
        liveRegion.textContent = "Conversation started. Atlas is listening.";
    }

    function toggleConvoMute() {
        const s = convo;
        if (!s || !s.live) return;
        const on = !s.live.muted;
        s.live.mute(on);
        convoControls.mute.setAttribute("aria-pressed", String(on));
        convoControls.mute.textContent = on ? "Unmute" : "Mute";
    }

    // Who said it: in a spoken conversation both sides are voices, so each
    // turn carries a small YOU / ATLAS label rather than relying on colour.
    function labelSpeaker(li, who) {
        if (!li || li.querySelector(".agent-who")) return li;
        const tag = document.createElement("span");
        tag.className = "agent-who";
        tag.textContent = who;
        li.prepend(tag);
        return li;
    }

    function openConvoAnswer(s) {
        const li = document.createElement("li");
        li.className = "agent-message agent-message-assistant is-avatar-turn";
        labelSpeaker(li, "Atlas");
        const text = document.createElement("p");
        text.className = "agent-message-text";
        const words = document.createElement("p");
        words.className = "agent-avatar-words";
        li.append(text, words);
        transcript.appendChild(li);
        s.assistantLi = li;
        s.wordsEl = words;
        s.turn = { done: false };
        maybeScrollToEnd();
    }

    function onConvoEvent(evt) {
        const s = convo;
        if (!s) return;
        if (typeof evt.state === "string") {
            s.face.convoState(evt.state);
        } else if (typeof evt.userWords === "string") {
            if (!s.userLi) { s.userLi = labelSpeaker(appendUser(""), "You"); s.heard = ""; }
            s.heard += evt.userWords;
            s.userLi.querySelector("p").textContent = s.heard.trim();
            maybeScrollToEnd();
        } else if (evt.words && typeof evt.words.text === "string") {
            if (!s.assistantLi) openConvoAnswer(s);
            const heardFrom = addCaptionChunk(s.wordsEl, evt.words.text, Number(evt.words.at));
            if (!s.spoke) { s.spoke = true; s.face.speaking(heardFrom); }
            const turn = s.turn;
            runKaraoke(s.wordsEl, () => s.face.time(), () => turn.done || s.face.closed);
        } else if (typeof evt.show === "string") {
            showOnSite(evt.show);
        } else if (evt.interrupted) {
            s.face.interrupt();
            if (s.assistantLi) appendStoppedNote(s.assistantLi);
        } else if (evt.turnEnd) {
            closeConvoTurn(s, evt.turnEnd);
        }
    }

    // Spec 78: Atlas puts a page or a home section on screen while the call
    // goes on. The key is resolved in site-stage.js; an unknown one does
    // nothing. The panel shrinks to a floating face so the whole page is
    // visible, and the call and its voice carry on (minimize would pause it).
    // A click on the face brings the full panel back.
    let siteStage = null;
    let stageOpen = false;
    async function showOnSite(key) {
        try {
            siteStage = siteStage || await import(_vq("./site-stage.js"));
        } catch (err) {
            console.warn("[atlas] site stage unavailable:", err);
            return;
        }
        const title = siteStage.showTarget(key, { onChange: onStageChange });
        if (title) liveRegion.textContent = `Opened ${title}.`;
    }
    function onStageChange(open) {
        stageOpen = open;
        // Spec 86: a float the visitor chose outlasts the page Atlas opened.
        setFloating((open || userFloat) && isOpen);
    }
    // Spec 86: in Avatar mode the header's minimize button floats the face
    // instead, so the call and its voice carry on. Any way back to the full
    // panel clears the visitor's choice.
    let userFloat = false;
    function setFloating(on) {
        if (!on) userFloat = false;
        panel.classList.toggle("is-floating", on);
        // Floating, the panel no longer covers the page, so it isn't modal.
        panel.setAttribute("aria-modal", on ? "false" : "true");
        if (!on) requestAnimationFrame(syncScrollHint);
    }

    // One turn done: settle both bubbles into the shared chat, as what was
    // actually said, so Text and Voice mode read it the same way.
    function closeConvoTurn(s, t) {
        const question = String(t.question || s.heard || "").trim();
        if (s.userLi) s.userLi.querySelector("p").textContent = question || s.userLi.querySelector("p").textContent;
        else if (question) s.userLi = labelSpeaker(appendUser(question), "You");
        if (question) messages.push({ role: "user", content: question });
        const answer = String(t.answer || "").trim();
        if (s.assistantLi) {
            finalizeAssistant(s.assistantLi, answer, {});
            tagVia(s.assistantLi, "avatar");
            if (t.status === "interrupted") appendStoppedNote(s.assistantLi);
        }
        if (answer) messages.push({ role: "assistant", content: answer });
        if (s.turn) s.turn.done = true;
        s.face.newTurn();
        if (Number.isFinite(t.first_word_ms)) console.info("[atlas] convoFirstWordMs:", t.first_word_ms);
        s.userLi = s.assistantLi = s.wordsEl = s.turn = null;
        s.spoke = false;
        s.heard = "";
        syncClearBtn();
    }

    function endConversation(end) {
        const s = convo;
        if (!s) return;
        convo = null;
        if (avatar) avatar.setMicLevel(null);
        try { if (s.live) s.live.end(); } catch (_) { /* already closed */ }
        if (s.turn) s.turn.done = true;
        s.face.abort();
        panel.classList.remove("is-conversing");
        // Spec 80: a page open beside the call floats the panel down to just
        // the face. Ending the call always brings the full panel back, so
        // "Start conversation" (or the rest card) is on screen right away —
        // otherwise the call had already ended, invisibly, behind the small
        // floating face, and looked like saying goodbye did nothing.
        setFloating(false);
        resetConvoControls();
        syncMinimizeLabel();
        liveRegion.textContent = "Conversation ended.";
        refreshSendMode();
        if (end && end.capped) restAvatar(end.reason);
        else if (end && end.reason) showConvoHint(end.reason);
    }

    // Spec 73: a call that ends (End, or the server closing it) breaks the
    // face into hexes and re-forms it idle. Not on a mode switch or a closed
    // panel: leaving Avatar has its own dissolve, and a capped call hands off
    // to Voice, which runs that one.
    // Resolves once the face has played everything it was sent, or after
    // `maxMs` so a stalled stream never leaves the call open.
    function playedOut(face, maxMs = 8000) {
        const until = performance.now() + maxMs;
        return new Promise((resolve) => {
            const check = () => {
                if (face.closed || face.time() >= face.edge() - 0.15 || performance.now() > until) resolve();
                else setTimeout(check, 100);
            };
            check();
        });
    }

    function hangUpFace() {
        if (avatar && avatarOn) avatar.hangUp();
    }

    // Spec 72: the avatar is out for today (this visitor's share, or the
    // site's). That's never a dead end: Atlas moves to Voice on its own,
    // which draws on the separate chat budget, says so in one line, and
    // asks the pending question there if there is one. Voice's audio
    // unlocks on the visitor's next tap, the same gesture a send uses.
    // Spec 80: out of avatar time for today. The visitor stays in Avatar and
    // sees why, on the face itself, with one button to carry on in Voice (or
    // Text). The chat gets one line the first time the cap is hit on this
    // page, never again. It used to switch modes on its own and add the same
    // line on every tap. A question that couldn't be asked goes back in the
    // composer, and the button asks it.
    let restNoted = false;
    let restQuestion = null;
    function restAvatar(reason, question) {
        avatarResting = true;
        avatarRestReason = reason || "That's all the avatar time for today.";
        try { localStorage.setItem(AVATAR_REST_KEY, todayUtc()); } catch (_) { /* private mode */ }
        if (!restNoted) {
            restNoted = true;
            appendSystem(`${avatarRestReason} Atlas is back on video tomorrow.`);
        }
        liveRegion.textContent = avatarRestReason;
        if (question) {
            restQuestion = question;
            input.value = question;
            autoGrowInput();
        }
        renderRestCard();
    }
    function renderRestCard() {
        const slot = panel.querySelector(".agent-avatar-slot");
        if (!slot || !avatarResting) return;
        let card = slot.querySelector(".agent-avatar-rest");
        if (!card) {
            card = document.createElement("div");
            card.className = "agent-avatar-rest";
            card.setAttribute("role", "status");
            const text = document.createElement("p");
            text.className = "agent-avatar-rest-text";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "agent-convo-btn agent-avatar-rest-btn";
            btn.addEventListener("click", continueWithoutAvatar);
            card.append(text, btn);
            slot.appendChild(card);
        }
        const to = FEATURES.speakReplies ? "Voice" : "Text";
        card.querySelector("p").textContent = `${avatarRestReason} Atlas is back on video tomorrow.`;
        card.querySelector("button").textContent = restQuestion ? `Ask this in ${to}` : `Continue in ${to}`;
        slot.classList.add("is-resting");
    }
    function continueWithoutAvatar() {
        const question = restQuestion || input.value.trim();
        restQuestion = null;
        Promise.resolve(selectMode(FEATURES.speakReplies ? "voice" : "text")).then(() => {
            if (!question || isPending) return;
            input.value = question;
            sendCurrent();
        });
    }

    // Spec 67: karaoke captions, one word at a time. Every word is a span
    // stamped with the media time it starts being heard. As the video clock
    // passes a stamp, that word becomes the one lit word ("is-now"), words
    // before it read normally and words after it wait dimmed.
    //
    // Live answers: each chunk from the server carries `at`, the media time
    // its last word is heard (server-side, from the fMP4 fragment times plus
    // the measured transcription lead). The chunk runs from the previous
    // chunk's end to `at`, and its words are spread across that by length.
    // The greeting passes its caption cue's start and end instead.
    const CAPTION_CHARS_PER_S = 15; // only used where the stream gives no time
    function addWords(p, text, start, end) {
        const letters = text.replace(/\s+/g, "").length || 1;
        let seen = 0;
        for (const piece of text.split(/(\s+)/)) {
            if (!piece) continue;
            if (/^\s+$/.test(piece)) { p.appendChild(document.createTextNode(piece)); continue; }
            const span = document.createElement("span");
            span.className = "agent-avatar-w is-ahead";
            span.dataset.at = String(start + (end - start) * (seen / letters));
            span.textContent = piece;
            p.appendChild(span);
            seen += piece.length;
        }
    }
    function addCaptionChunk(p, text, at) {
        const k = p._caption || (p._caption = { end: null });
        const dur = (text.replace(/\s+/g, "").length || 1) / CAPTION_CHARS_PER_S;
        let end = Number.isFinite(at) ? at : (k.end ?? 0) + dur;
        if (k.end !== null) end = Math.max(end, k.end + 0.05);
        // Continuous speech picks up where the last chunk ended; after a gap
        // (or for the first chunk) it starts a chunk's length before its end.
        const start = k.end !== null && end - k.end < dur * 2 ? k.end : end - dur;
        addWords(p, text, start, end);
        k.end = end;
        return start;
    }
    function paintCaptions(p, now) {
        let current = null;
        for (const span of p.querySelectorAll(".agent-avatar-w")) {
            const said = Number(span.dataset.at) <= now;
            span.classList.toggle("is-ahead", !said);
            span.classList.toggle("is-said", said);
            span.classList.remove("is-now");
            if (said) current = span;
        }
        if (current && Number.isFinite(now)) current.classList.add("is-now");
        return current;
    }
    // Keep the word being spoken comfortably in view: when it drifts out of
    // the band between the top and the bottom fade, bring its line back to
    // about 40% down. Never scrolls on every frame, so the text doesn't jitter.
    const CAPTION_FADE_PX = 56;
    function followCaption(span) {
        if (!span) return;
        const body = dom.body;
        const box = body.getBoundingClientRect();
        const r = span.getBoundingClientRect();
        if (r.top >= box.top + 8 && r.bottom <= box.bottom - CAPTION_FADE_PX - 16) return;
        body.scrollTop = Math.max(0, body.scrollTop + (r.top - box.top) - body.clientHeight * 0.4);
    }
    const karaokeRunning = new WeakSet();
    function runKaraoke(p, clock, isDone) {
        if (karaokeRunning.has(p)) return;
        karaokeRunning.add(p);
        const tick = () => {
            if (isDone()) {
                // Finished: every word reads as said, and the whole answer is
                // in view (nothing left under the fade).
                paintCaptions(p, Infinity);
                karaokeRunning.delete(p);
                scrollToEnd();
                return;
            }
            followCaption(paintCaptions(p, clock()));
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    // The greeting lands in the transcript like any answer, word by word, timed
    // inside each caption cue against the greeting video's own clock.
    let greetingWordsEl = null;
    function addGreetingWords(text, cue) {
        if (!greetingWordsEl) {
            const li = document.createElement("li");
            li.className = "agent-message agent-message-assistant is-avatar-turn is-avatar-greeting";
            greetingWordsEl = document.createElement("p");
            greetingWordsEl.className = "agent-avatar-words";
            li.appendChild(greetingWordsEl);
            transcript.appendChild(li);
        }
        const p = greetingWordsEl;
        addWords(p, text, cue.start, cue.end);
        runKaraoke(p, cue.now, cue.done);
    }

    // Spec 67: the face speaks a finished reply. Anything that stops it from
    // starting hands the same words to the TTS voice, so a visitor never
    // loses the spoken answer, only the face.
    function currentMode() {
        if (avatarOn) return "avatar";
        return speakerOn ? "voice" : "text";
    }
    // A mode change plays the switch's flip animation (glide stretch, colour
    // sweep, the new mode's icon greeting); first paint doesn't.
    let shownMode = null;
    let flipTimer = null;
    function syncModeSwitch() {
        const mode = currentMode();
        if (shownMode && mode !== shownMode) {
            modeSwitch.classList.remove("is-flipping");
            void modeSwitch.offsetWidth; // restart the animations on a quick re-flip
            modeSwitch.classList.add("is-flipping");
            clearTimeout(flipTimer);
            flipTimer = setTimeout(() => modeSwitch.classList.remove("is-flipping"), 800);
        }
        shownMode = mode;
        modeSwitch.dataset.active = mode;
        panel.dataset.mode = mode;
        panel.classList.toggle("is-avatar-mode", mode === "avatar");
        syncMinimizeLabel();
        modeSwitch.classList.toggle("is-speaking", isSpeaking);
        modeSwitch.classList.toggle("is-avatar-new", FEATURES.avatarMode && !avatarTried());
        modeSwitch.querySelectorAll(".agent-mode-opt").forEach((b) =>
            b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
    }

    // Spec 86: during a call the minimize button floats the face instead.
    function syncMinimizeLabel() {
        if (isMinimized) return; // reads "Restore" until restored
        const floats = !!convo;
        dom.minimizeBtn.setAttribute("aria-label", floats ? "Float the avatar" : "Minimize panel");
        dom.minimizeBtn.title = floats ? "Float" : "Minimize";
    }

    function setAvatarMode(on, { autoplay = false } = {}) {
        avatarOn = on;
        syncModeSwitch();
        if (!on) {
            setFloating(false); // spec 86: floating shows only the face
            if (avatar) { avatar.dispose(); avatar = null; }
            avatarBusy = false;
            refreshSendMode();
            return;
        }
        if (avatar) { if (autoplay) avatar.replay(); return; }
        if (avatarLoading) return;
        if (leavingAvatar) leavingAvatar(); // back before the last face finished dissolving
        avatarLoading = import(_vq("./agent-avatar.js"))
            .then(({ mountAvatarStage }) => {
                // Inside the header, as its last row: one surface with one
                // divider, rather than a second block stacked on the chat.
                const slot = document.createElement("div");
                slot.className = "agent-avatar-slot";
                dom.head.appendChild(slot);
                panel.classList.add("has-avatar");
                // The avatar started a clip: hush Atlas's own voice so the two
                // never talk over each other. The reverse (Atlas speaking hushes
                // the avatar) is wired at the speaker's onPlaying and at send.
                return mountAvatarStage(slot, {
                    autoplay,
                    onPlay: () => { if (speaker) speaker.cancel(); },
                    onWords: addGreetingWords,
                    onState: (state) => { avatarBusy = state !== "idle"; syncGreetingStop(state); refreshSendMode(); },
                })
                    .then((stage) => {
                        // Spec 73: leaving Avatar, the face breaks back into
                        // hex tiles before the stage goes, like hanging up.
                        const unmount = () => {
                            endConversation();
                            convoControls = null;
                            panel.classList.remove("is-handsfree");
                            stage.pause();
                            let gone = false;
                            const finish = () => {
                                if (gone) return;
                                gone = true;
                                if (leavingAvatar === finish) leavingAvatar = null;
                                stage.dispose();
                                slot.remove();
                                panel.classList.remove("has-avatar");
                            };
                            leavingAvatar = finish;
                            slot.classList.add("is-leaving");
                            stage.depart().then(finish);
                        };
                        // Switched away again while it was still loading.
                        if (!avatarOn) { unmount(); return; }
                        mountConvoControls(slot, stage.canSpeak);
                        syncGreetingStop(stage.el.dataset.state); // the greeting may already be playing
                        renderRestCard(); // spec 80: out of avatar time today
                        // Spec 81: an explicit, always-there way back to the
                        // full panel while floating, distinct from tapping the
                        // face itself (easy to miss on its own).
                        const restoreBtn = document.createElement("button");
                        restoreBtn.type = "button";
                        restoreBtn.className = "agent-avatar-restore";
                        restoreBtn.setAttribute("aria-label", "Restore the full panel");
                        restoreBtn.title = "Restore panel";
                        restoreBtn.innerHTML = "\u2921";
                        restoreBtn.addEventListener("click", (e) => { e.stopPropagation(); setFloating(false); });
                        slot.appendChild(restoreBtn);
                        avatar = {
                            canSpeak: stage.canSpeak,
                            pause: stage.pause,
                            replay: stage.replay,
                            idle: stage.idle,
                            startLive: stage.startLive,
                            hangUp: stage.hangUp,
                            setMicLevel: stage.setMicLevel,
                            dispose: unmount,
                        };
                    })
                    .catch((err) => {
                        slot.remove();
                        panel.classList.remove("has-avatar");
                        throw err;
                    });
            })
            .catch((err) => {
                console.warn("[agent-widget] avatar mode failed to load", err);
                avatarOn = false;
                syncModeSwitch();
                showVoiceNote("Avatar mode couldn't load. Try again in a moment.");
            })
            .finally(() => { avatarLoading = null; });
    }

    // Avatar mode owns the voice outright: turn the TTS speaker off without a
    // note and without touching its saved preference, so leaving Avatar for
    // Voice later brings the voice back exactly as the visitor had it.
    function silenceSpeakerForAvatar() {
        if (!speakerOn) return;
        speakerOn = false;
        if (speaker) speaker.cancel();
        clearSpeakingIndicator();
        setSpeakerMode("off");
    }

    // Every branch starts its audio work synchronously inside the click:
    // enableSpeaker() banks the gesture for Web Audio, and the avatar's
    // greeting needs the same gesture to play with sound. The three modes are
    // exclusive: exactly one of them is ever speaking.
    // Resolves once the new mode can speak (Voice loads its engine first).
    function selectMode(mode) {
        let ready = null;
        if (mode === currentMode()) return;
        if (mode === "text") {
            if (avatarOn) { writeAvatarPref(false); setAvatarMode(false); }
            if (speakerOn) toggleSpeaker();
            else writeSpeakerPref(false);
        } else if (mode === "voice") {
            if (avatarOn) { writeAvatarPref(false); setAvatarMode(false); }
            if (!speakerOn) ready = enableSpeaker();
        } else if (mode === "avatar") {
            // Spec 80: out for today still opens Avatar; the face shows why
            // and offers Voice (renderRestCard, once the stage mounts). No
            // greeting: it can't talk today.
            silenceSpeakerForAvatar();
            writeAvatarPref(true);
            const greet = !avatarResting && takeAvatarGreeting();
            if (greet) greetingWordsEl = null;
            setAvatarMode(true, { autoplay: greet });
        }
        syncModeSwitch();
        return ready;
    }
    modeSwitch.addEventListener("click", (e) => {
        const opt = e.target.closest(".agent-mode-opt");
        if (opt) selectMode(opt.dataset.mode);
    });
    // Radiogroup keyboard pattern: arrows move the choice.
    modeSwitch.addEventListener("keydown", (e) => {
        if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
        const opts = [...modeSwitch.querySelectorAll(".agent-mode-opt")].filter((b) => !b.hidden);
        const i = opts.findIndex((b) => b.dataset.mode === currentMode());
        const next = opts[(i + (e.key === "ArrowRight" ? 1 : opts.length - 1)) % opts.length];
        e.preventDefault();
        next.focus();
        selectMode(next.dataset.mode);
    });
    syncModeSwitch();

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
    input.addEventListener("input", warmLiveAvatar);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && stageOpen && siteStage) {
            e.preventDefault();
            siteStage.closeStage();
            return;
        }
        if (e.key === "Escape" && isOpen) {
            e.preventDefault();
            if (isPending || atlasTalking()) stopStreaming();
            else closePanel();
        }
    });

    // The send button doubles as the one Stop control. It is "stop" while a
    // turn streams, and also while Atlas is still talking afterwards, by
    // voice or as the avatar, so there is always a way to cut it off. Typing
    // a new question turns it back into Send (sending interrupts anyway).
    // Console-only timing, one line per milestone per turn, so a slow turn
    // on a machine we can't reach (reported on Windows) can be read from its
    // console: text late means server or network, voice late on top of
    // prompt text means synthesis. The avatar logs its own line on turn end.
    let turnTiming = null;
    function logTurnTiming(name) {
        if (!turnTiming || turnTiming.logged.has(name)) return;
        turnTiming.logged.add(name);
        console.info(`[atlas] ${name}:`, Math.round(performance.now() - turnTiming.t0));
    }

    // In a hands-free conversation the face is always "busy", but the send
    // button stays Send: typed lines go into the same conversation.
    function atlasTalking() { return isSpeaking || (avatarBusy && !convo); }
    function refreshSendMode() {
        const hasText = !!(input.value || "").trim();
        const stop = isPending || (atlasTalking() && !hasText);
        sendBtn.dataset.mode = stop ? "stop" : "send";
        const label = !stop ? "Send" : isPending ? "Stop generating" : "Stop Atlas";
        sendBtn.setAttribute("aria-label", label);
        sendBtn.title = label;
        updateSendReadiness();
        refreshActionSlot();
    }

    // Mic and send share one slot, so a visitor never has to pick between
    // two look-alike buttons: an empty composer offers the mic, any text
    // (typed or transcribed) offers send, and stop takes the slot while a
    // turn streams or Atlas talks. Hiding the mic once there's text also
    // keeps a transcript from overwriting what the visitor typed, since
    // prefillComposer replaces the composer's value.
    function refreshActionSlot() {
        const micAvailable = FEATURES.voiceInput && !micBtn.classList.contains("is-hidden");
        const micActive = micBtn.dataset.mode !== "idle"; // recording or transcribing
        const hasText = !!(input.value || "").trim();
        const showMic = micAvailable && (micActive || (sendBtn.dataset.mode === "send" && !hasText));
        const slot = showMic ? "mic" : "send";
        const row = dom.inputRow;
        if (row.dataset.slot === slot) return;
        // A keyboard user who pressed the button that's about to hide keeps
        // focus on the one that replaces it.
        const hadFocus = document.activeElement === micBtn || document.activeElement === sendBtn;
        row.dataset.slot = slot;
        if (hadFocus) (showMic ? micBtn : sendBtn).focus();
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
        pauseAvatar(); // spec 67: stop silences the face too
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
    // time a reply would ever be spoken, sendMessage() shows the consent card,
    // whose "Not now" mutes the turn already in flight. Consent is asked once,
    // then remembered, so this costs a returning visitor nothing. (The card
    // no longer pre-emptively silences turn one — it is shown alongside it.)
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
        refreshSendMode();
        speakerBtn.dataset.mode = mode;
        speakerBtn.setAttribute("aria-pressed", mode === "off" ? "false" : "true");
        speakerBtn.setAttribute(
            "aria-label",
            mode === "off" ? "Speak replies" : mode === "speaking" ? "Speaking, click to stop" : "Stop speaking replies",
        );
        syncModeSwitch(); // spec 67: the Text / Voice / Avatar switch mirrors this
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
                        // this is the authoritative "the turn's audio is fully
                        // done" signal, and it must fire even when speakerOn
                        // just flipped false (the speaker-off toggle cancels()
                        // before this callback runs). Without it the
                        // per-message "Reading aloud" strip would be left stuck
                        // on screen — clearSpeakingIndicator() used to sit
                        // behind the speakerOn guard below even though this
                        // comment already explained why nothing here can.
                        if (state === "idle") {
                            clearSpeakingIndicator();
                            if (voiceStatus.textContent === "Speaking…") {
                                voiceStatus.classList.add("is-hidden");
                            }
                        }
                        if (!speakerOn) return;
                        setSpeakerMode(state === "speaking" ? "speaking" : "on");
                    },
                    // Fires only when audio genuinely starts, so the status
                    // line distinguishes "synthesizing" from "actually
                    // audible" — the two are indistinguishable otherwise.
                    // The per-message "Reading aloud" strip lives here too
                    // (not on the earlier "speaking"/enqueued state above), so
                    // it appears when the voice does rather than while the
                    // first chunk is still being synthesized.
                    onPlaying: () => {
                        logTurnTiming("voiceAudibleMs");
                        pauseAvatar(); // spec 67: Atlas's voice wins over a recorded clip
                        showVoiceNote("Speaking…", 0);
                        showSpeakingIndicator(currentAssistantLi);
                    },
                    onError: (message) => {
                        // The reply is already on screen, so a synthesis
                        // failure is a note, not an error state.
                        showVoiceNote(message);
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
        // No separate consent gate here any more — enableSpeaker() records
        // consent itself the moment it actually turns sound on, and its own
        // voice note ("Reading answers aloud...") is the notice. There's no
        // reply in flight to pace text to from this icon alone, so unlike
        // sendCurrent()'s heads-up there's nothing else to show here.
        await enableSpeaker();
    }

    // The half of toggleSpeaker that actually turns sound on.
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
        try { localStorage.setItem(SPEAKER_CONSENT_KEY, "1"); } catch (_) { /* private mode */ }
        showVoiceNote("Reading answers aloud. Switch to Text to stop.", 4000);
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
    //
    // Non-blocking heads-up, not a gate: by the time this renders, the turn
    // it accompanies is already speaking (sendCurrent() no longer silences
    // it — see the call site). There's nothing left to agree to, so "Sounds
    // good" is gone; "Got it" just dismisses, "Not now" is a real, immediate
    // mute of whatever is currently playing.
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
        yes.textContent = "Got it";
        const no = document.createElement("button");
        no.type = "button";
        no.className = "agent-consent-no";
        no.textContent = "Not now";
        actions.append(no, yes);
        card.append(copy, actions);
        dom.panel.insertBefore(card, dom.inputRow);

        // A real mute of the turn in flight, not a pre-emptive block — audio
        // may already be mid-clip. cancel() drives the speaker to "idle".
        // Mirrors closePanel()'s teardown exactly.
        no.addEventListener("click", () => {
            card.remove();
            speakerOn = false;
            writeSpeakerPref(false);
            if (speaker) speaker.cancel();
            clearSpeakingIndicator();
            setSpeakerMode("off");
            showVoiceNote("Spoken replies off.", 2500);
        });
        yes.addEventListener("click", () => card.remove());
    }

    // Spec 48: mirrors setSendMode's shape for the mic button's three
    // states. "recording" and "busy" both get an aria-label announcing
    // themselves through liveRegion so a screen-reader user knows the mic
    // is live without having to poll it.
    let recordStartedAt = 0;
    let recordTickTimer = null;
    function setMicMode(mode) {
        micBtn.dataset.mode = mode === "recording" ? "recording" : mode === "busy" ? "busy" : "idle";
        const micLabel = mode === "recording" ? "Stop recording" : mode === "busy" ? "Transcribing" : "Ask by voice";
        micBtn.setAttribute("aria-label", micLabel);
        micBtn.title = micLabel;
        clearInterval(recordTickTimer);
        recordTickTimer = null;
        if (mode === "recording") {
            recordStartedAt = Date.now();
            voiceStatus.classList.remove("is-hidden");
            voiceStatus.textContent = "Listening… 0:00 · tap to finish";
            recordTickTimer = setInterval(() => {
                const secs = Math.floor((Date.now() - recordStartedAt) / 1000);
                voiceStatus.textContent = `Listening… 0:${String(secs).padStart(2, "0")} · tap to finish`;
            }, 1000);
        } else if (mode === "busy") {
            voiceStatus.classList.remove("is-hidden");
            voiceStatus.textContent = "Transcribing…";
        } else if (!isSpeaking) {
            // The speaker borrows this same line. Returning the mic to idle
            // must not wipe a live "Speaking…" out from under it.
            voiceStatus.classList.add("is-hidden");
        }
        refreshActionSlot();
    }

    // Lazy-imports agent-voice.js on first use so MediaRecorder code never
    // ships in the initial page payload (matches how main.js defers this
    // whole module until idle).
    // Ask the server to open this visitor's avatar session while they type or
    // talk, so it's warm when they send. At most once per 90s (the server
    // keeps a warm session 120s); a server with live answers off says no.
    let liveWarmedAt = 0;
    function warmLiveAvatar() {
        if (!FEATURES.avatarMode || !avatarOn || !avatar || !avatar.canSpeak || avatarResting || !liveWarmUrl) return;
        const now = Date.now();
        if (now - liveWarmedAt < 90_000) return;
        liveWarmedAt = now;
        fetch(liveWarmUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }),
            keepalive: true,
        }).catch(() => { liveWarmedAt = 0; });
    }

    async function startVoiceInput() {
        warmLiveAvatar();
        if (micLoading) return;
        if (!voiceEngine) {
            micLoading = true;
            try {
                const mod = await import(_vq("./agent-voice.js"));
                if (!mod.isVoiceSupported()) {
                    // Shouldn't happen — the button is hidden when unsupported —
                    // but guards a race between render and the capability check.
                    micBtn.classList.add("is-hidden");
                    refreshActionSlot();
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
        refreshSendMode();
    }

    // Sets the composer text and focuses it without sending. Shared by the
    // action chips and (spec 45) WebMCP's draft_note_to_gaurav tool — a real
    // human keystroke is always required to actually send. A direct .value
    // assignment never fires an "input" event, so this must call
    // autoGrowInput() itself rather than relying on the input listener below.
    function prefillComposer(text) {
        if (isPending) return false;
        // Spec 86: hands-free Avatar has no composer to fill. Move to Text,
        // so a drafted note is on screen rather than in a hidden box.
        if (avatarOn && panel.classList.contains("is-handsfree")) selectMode("text");
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
        // Spec 86: minimizing used to pause the face, which tore down a live
        // call's only audio while the call ran on. A call floats instead.
        // With no call there's nothing to keep alive, so minimize as usual.
        if (convo || stageOpen) {
            const on = !panel.classList.contains("is-floating");
            setFloating(on);
            userFloat = on;
            return;
        }
        if (isMinimized) restore(); else minimize();
    }
    function minimize() {
        isMinimized = true;
        panel.classList.add("is-minimized");
        pauseAvatar(); // spec 67: the stage is hidden while minimized, so stop its voice too
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
    // Once a day, in the background: does this visitor's network deliver
    // Atlas's streams live? A Netskope-managed laptop got text, voice and the
    // avatar seconds late although the server answered in ~1.6s; inspection
    // proxies can hold a stream and release it in one burst. This streams a
    // few clock ticks over SSE, padded SSE and a WebSocket (no AI, a few KB)
    // and posts only the per-tick delays, so the right fix can be chosen from
    // real visitors instead of guesses.
    const PROBE_KEY = "atlasStreamProbe_v1";
    let probeStarted = false;
    function runStreamProbe() {
        if (probeStarted || !probeBase) return;
        probeStarted = true;
        try {
            const last = Number(localStorage.getItem(PROBE_KEY) || 0);
            if (Date.now() - last < 24 * 60 * 60 * 1000) return;
            localStorage.setItem(PROBE_KEY, String(Date.now()));
        } catch (_) { return; } // no storage: skip rather than probe every visit
        if (navigator.connection && navigator.connection.saveData) return;
        const sse = async (pad) => {
            const t0 = performance.now();
            const r = await fetch(`${probeBase}?pad=${pad}&ticks=8`);
            const reader = r.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            const lag = [];
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let i;
                while ((i = buf.indexOf("\n\n")) >= 0) {
                    const frame = buf.slice(0, i);
                    buf = buf.slice(i + 2);
                    if (!frame.startsWith("data: ")) continue;
                    const ev = JSON.parse(frame.slice(6));
                    if ("tick" in ev) lag.push(Math.round(performance.now() - t0) - ev.serverMs);
                }
            }
            return lag;
        };
        const ws = () => new Promise((resolve) => {
            let sock;
            const lag = [];
            const t0 = performance.now();
            try { sock = new WebSocket(`${probeBase.replace(/^http/, "ws")}-ws?ticks=8`); }
            catch (err) { resolve(`ws blocked: ${err && err.name}`); return; }
            const giveUp = setTimeout(() => { try { sock.close(); } catch (_) { /* ignore */ } resolve(lag.length ? lag : "ws timeout"); }, 15000);
            sock.onmessage = (m) => {
                const ev = JSON.parse(m.data);
                if ("tick" in ev) lag.push(Math.round(performance.now() - t0) - ev.serverMs);
            };
            sock.onclose = () => { clearTimeout(giveUp); resolve(lag.length ? lag : "ws closed"); };
            sock.onerror = () => { clearTimeout(giveUp); resolve(lag.length ? lag : "ws error"); };
        });
        const settle = (p) => p.then((v) => v, (err) => `failed: ${err && err.name}`);
        (async () => {
            const result = {
                sessionId,
                sse: await settle(sse(0)),
                ssePadded: await settle(sse(8192)),
                ws: await settle(ws()),
            };
            fetch(`${probeBase}/report`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(result),
                keepalive: true,
            }).catch(() => {});
        })();
    }

    function openPanel() {
        setTimeout(runStreamProbe, 1500);
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
        // Spec 72: a visitor whose avatar is out for today reopens in Voice,
        // where the hand-off left them, and gets Avatar back tomorrow.
        const avatarPref = readAvatarPref() && !avatarResting;
        if (FEATURES.speakReplies && (speakerOn || readSpeakerPref() || (readAvatarPref() && avatarResting))
            && !(FEATURES.avatarMode && (avatarOn || avatarPref))) {
            speakerOn = true;
            setSpeakerMode("on");
            // Opening the panel is itself a click, so bank it for audio the
            // same way enableSpeaker() does.
            ensureSpeaker().then((ok) => { if (ok && speaker) speaker.unlock(); });
        }
        // Spec 67: bring a remembered avatar mode back, on its idle face. The
        // greeting plays once per visitor (takeAvatarGreeting), never on a
        // reopen.
        if (FEATURES.avatarMode && !avatarOn && avatarPref) {
            setAvatarMode(true, { autoplay: false });
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
        setFloating(false);
        panel.setAttribute("aria-hidden", "true");
        fab.setAttribute("aria-expanded", "false");
        document.body.removeAttribute("data-agent-panel-open");
        fab.focus();
        endConversation(); // spec 71: a closed panel never keeps listening
        pauseAvatar(); // spec 67: a closed panel never keeps talking
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
            // A fresh panel reads from the top: the intro stays whole, and the
            // fade says there is more below. Only a panel that already holds a
            // conversation follows it to the end.
            if (messages.length) scrollToEnd();
            else { dom.body.scrollTop = 0; syncScrollHint(); }
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
            appendSystem("That message is a bit long for me. Could you trim it under ~1000 characters?");
            return;
        }
        const emailError = validateEmailInMessage(text);
        if (emailError) {
            appendSystem(emailError);
            input.value = text;
            return;
        }
        // Spec 71: mid-conversation, a typed line is just another turn.
        if (convo && convo.live) {
            input.value = "";
            autoGrowInput();
            convo.userLi = labelSpeaker(appendUser(text), "You");
            convo.heard = text;
            convo.live.sendText(text);
            return;
        }
        pauseAvatar(); // spec 67: asking something stops a recorded clip mid-sentence
        // Spec 67: out of avatar answers for today. Don't spend a request
        // finding that out again; offer the other modes for this question.
        if (FEATURES.avatarMode && avatarOn && avatarResting) {
            restAvatar(avatarRestReason, text);
            return;
        }
        // Spec 67: in Avatar mode the face speaks this answer instead of the
        // TTS voice. Decided once per turn; the voice stays loaded as the
        // fallback for when the avatar can't (cap, budget, error, browser).
        turnTiming = { t0: performance.now(), logged: new Set() };
        let avatarVoice = !!(FEATURES.avatarMode && avatarOn && avatar && avatar.canSpeak && !avatarResting);
        // The live face for this turn: goes live now (idling while Atlas
        // thinks), then speaks the reply as it arrives on this same stream.
        const liveTurn = avatarVoice ? avatar.startLive() : null;
        let avatarWordsEl = null;
        let avatarSpoke = false;
        // Set when the server says this avatar turn is over the cap. It then
        // sends no answer, and the turn becomes an offer to switch modes.
        let cappedReason = "";
        // Remove suggestion chips from the previous assistant message
        transcript.querySelectorAll(".agent-suggestions").forEach(el => el.remove());

        promptsEl.classList.add("is-hidden");
        input.value = "";
        autoGrowInput();
        isPending = true;
        wasStopped = false;
        abortController = new AbortController();
        refreshSendMode();
        if (FEATURES.voiceInput) micBtn.disabled = true;

        // Voice is on by default. This used to silence a visitor's whole
        // first turn and ask permission before ever making a sound — but
        // that meant turn 1's text streamed in one unpaced block while turn
        // 2+ paced text to audio, an inconsistent first impression. The send
        // click below is itself the unlock gesture ensureSpeaker() needs
        // (same reasoning enableSpeaker() relies on for the manual toggle),
        // so turn 1 now speaks in sync like every other turn; this only
        // surfaces a non-blocking heads-up alongside it. Consent is recorded
        // right here, not from a button — there's nothing left to agree to
        // by the time anyone could click one, the turn is already speaking.
        if (FEATURES.speakReplies && speakerOn && !hasConsented()) {
            try { localStorage.setItem(SPEAKER_CONSENT_KEY, "1"); } catch (_) { /* private mode */ }
            renderConsentCard();
        }

        // Spec 49: a new turn silences the previous one and rebuilds the
        // engine if the panel was closed since it last spoke. Awaited here,
        // before the stream opens, so onDelta never races the lazy import.
        if (FEATURES.speakReplies && speakerOn) {
            if (speaker) speaker.cancel();
            await ensureSpeaker();
        }

        const userLi = appendUser(text);
        messages.push({ role: "user", content: text });
        syncClearBtn();

        const assistant = appendAssistantPlaceholder();
        currentAssistantLi = assistant;
        // Spec 67: in Avatar mode the only text is the transcript of what the
        // avatar says, appearing as it says it. The reply is still rendered
        // (hidden) so history, and a fallback, are unchanged.
        if (avatarVoice) {
            assistant.classList.add("is-avatar-turn");
            avatarWordsEl = document.createElement("p");
            avatarWordsEl.className = "agent-avatar-words";
            assistant.appendChild(avatarWordsEl);
        }
        // The avatar can't take this turn after all: show the reply as text.
        // Avatar mode never falls back to the TTS voice; the modes stay isolated.
        const dropAvatar = () => {
            if (!avatarVoice) return;
            avatarVoice = false;
            if (liveTurn) liveTurn.abort();
            assistant.classList.remove("is-avatar-turn");
            if (avatarWordsEl) avatarWordsEl.remove();
        };
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

        // Drops the loading dots/canned copy and folds the Thoughts panel, on
        // the first raw delta — always, whether or not this turn is spoken.
        // Spec 57: it used to be held until the first *spoken* word reached the
        // screen, which meant the loading dots sat there for the whole first
        // synthesis round trip.
        function markFirstDelta() {
            if (!firstDelta) return;
            firstDelta = false;
            logTurnTiming("firstTextMs");
            sessionWarmed = true;
            stages.cancel();
            settleThinking();
        }

        let errorShown = false;
        let midStreamError = false;
        let lastUserText = text;

        // Per-turn state holders written by SSE callbacks
        const turnState = { citations: {}, suggestions: [], cta: null, badges: [] };

        try {
            await streamAgent({
                apiUrl,
                sessionId,
                messages,
                identity,
                signal: abortController.signal,
                avatar: avatarVoice,
                mode: avatarVoice ? "avatar" : (FEATURES.speakReplies && speakerOn ? "voice" : "text"),
                onAvatar: avatarVoice ? {
                    video(b64) { if (avatarVoice) liveTurn.push(b64); },
                    words(text, at) {
                        if (!avatarVoice) return;
                        const heardFrom = addCaptionChunk(avatarWordsEl, text, at);
                        // The first caption's start is where speech begins on
                        // the video clock; the player may skip idle frames up
                        // to just before it, never past it.
                        if (!avatarSpoke) { avatarSpoke = true; liveTurn.speaking(heardFrom); logTurnTiming("avatarFirstWordsMs"); }
                        runKaraoke(avatarWordsEl, () => liveTurn.time(), () => liveTurn.closed);
                    },
                    end() { if (avatarVoice) liveTurn.end(); },
                    show(key) { showOnSite(key); },
                    unavailable(reason, capped) {
                        if (capped) {
                            cappedReason = reason || "The avatar has reached its limit for today.";
                            avatarResting = true;
                            avatarRestReason = cappedReason;
                        }
                        // Mid-answer failures just end the face; before it
                        // spoke, the reply shows as text.
                        if (avatarSpoke) { liveTurn.end(); return; }
                        dropAvatar();
                    },
                } : null,
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
                    maybeScrollToEnd();
                },
                onDelta(delta) {
                    // Spec 57: text is painted the moment it streams, whether
                    // or not this turn is spoken. Spec 55 used to route it
                    // through a queue paced to the audio clock, which kept
                    // voice and text in lockstep but meant the first word
                    // couldn't appear until a full /api/agent-speak round trip
                    // had returned (~2.4s warm, ~5.6s cold). Reading is never
                    // worth blocking on synthesis; the voice trails instead,
                    // and the "Reading aloud" strip is what keeps the
                    // relationship between the two legible.
                    markFirstDelta();
                    appendDelta(assistant, delta, FEATURES.typingCursor);
                    // Chunking happens inside the speaker; this just hands it
                    // the raw stream. Sanitization is server-side, so what is
                    // spoken and what is shown stay in sync.
                    if (FEATURES.speakReplies && speakerOn && speaker && !avatarVoice) speaker.feed(delta);
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
                onBadges(badges) {
                    turnState.badges = badges;
                },

                async onDone(full) {
                    stages.cancel();
                    settleThinking();
                    // Spec 67: a capped avatar turn has no answer. It is asked
                    // again in whichever mode the visitor picks from the offer.
                    if (cappedReason) {
                        assistant.remove();
                        messages.pop();
                        return;
                    }
                    // The tail after the last sentence boundary only becomes
                    // speakable once the stream is closed. Skipped on stop:
                    // stopStreaming() has already cancelled playback, and
                    // flushing here would start it up again.
                    if (FEATURES.speakReplies && speakerOn && speaker && !wasStopped && !avatarVoice) {
                        speaker.flush();
                    }
                    // Spec 67: nothing was spoken (an error, a stop, a reply with
                    // nothing to say): show the text instead of an empty turn.
                    if (avatarVoice && !avatarSpoke) {
                        dropAvatar();
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
                    // Spec 57: finalization runs at end-of-stream, not
                    // end-of-audio. This used to await the reveal queue
                    // draining, which meant citations, follow-up chips, the CTA
                    // and the cert badge strip all waited for the last audio
                    // sample to play — up to tens of seconds after the reply
                    // had finished arriving.
                    if (!full && !errorShown) {
                        appendDelta(assistant, "Hmm, I didn't quite get that through on my end. Could you try asking again?", false);
                    }
                    if (full) {
                        // Remove typing caret first, then do one-shot render with citations
                        finalizeAssistant(assistant, full, turnState.citations);
                        tagVia(assistant, avatarVoice ? "avatar" : (FEATURES.speakReplies && speakerOn ? "voice" : "text"));
                        messages.push({ role: "assistant", content: full });
                        liveRegion.textContent = stripUrls(full).slice(0, 240);

                        // Tick the hero "Atlas has responded to N questions"
                        // counter — only on a successful answer (not on send,
                        // not on empty/errored turns), so the count reflects
                        // real responses, matching the backend's logged total.
                        document.dispatchEvent(new CustomEvent("portfolio:agent-question"));

                        // Render certification badge art (spec 56). Above the
                        // chips and CTA so the badges read as part of the
                        // answer rather than as another action row.
                        if (FEATURES.badges && turnState.badges.length) {
                            renderBadgeStrip(assistant, turnState.badges);
                        }

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
                    // Spec 67: the avatar won't be saying an error, so show it now.
                    if (avatarVoice && !avatarSpoke) dropAvatar();
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
            // Spec 67: a turn that ended with nothing spoken must never leave
            // its reply hidden.
            if (avatarVoice && !avatarSpoke) dropAvatar();
            isPending = false;
            abortController = null;
            refreshSendMode();
            if (FEATURES.voiceInput) micBtn.disabled = false;
            // The question used up this visitor's warm avatar session, so
            // open the next one now: follow-ups get the same ~1.5s head start
            // instead of paying a cold start (seen in logs as warm=False).
            if (avatarVoice) { liveWarmedAt = 0; warmLiveAvatar(); }
        }
        if (clearPending) { clearConversation(); return; }
        syncClearBtn();
        if (cappedReason && !wasStopped) {
            userLi.remove(); // the rest card's button asks it again in Voice
            restAvatar(cappedReason, text);
        }
    }

    // Clear conversation: stop whatever Atlas is doing, forget the history on
    // both sides (a new sessionId is a fresh server-side session), and start
    // over from the intro. Mid-turn, the turn is stopped first and the clear
    // runs once it has wound down, so its late callbacks can't write into the
    // new conversation.
    let clearPending = false;
    function clearConversation() {
        endConversation();
        stopStreaming();
        if (isPending) { clearPending = true; return; }
        clearPending = false;
        messages.length = 0;
        sessionId = newSessionId();
        currentAssistantLi = null;
        greetingWordsEl = null;
        transcript.replaceChildren();
        clearSpeakingIndicator();
        input.value = "";
        autoGrowInput();
        if (agentIntro?.text) {
            renderIntroMessage();
        } else {
            promptsEl.classList.remove("is-hidden");
            renderStarters();
        }
        syncClearBtn();
        liveRegion.textContent = "Conversation cleared.";
        input.focus();
    }
    function syncClearBtn() {
        clearBtn.hidden = messages.length === 0 && !isPending;
    }
    clearBtn.addEventListener("click", clearConversation);

    // Spec 67: one conversation across modes. An answer says which mode it
    // came from ("via Avatar") whenever you're looking at it from another
    // mode, so it's clear switching re-shows it rather than asking again.
    const VIA_LABEL = { text: "via Text", voice: "via Voice", avatar: "via Avatar" };
    function tagVia(li, via) {
        li.dataset.via = via;
        if (li.querySelector(".agent-via")) return;
        const tag = document.createElement("span");
        tag.className = "agent-via";
        tag.textContent = VIA_LABEL[via] || "";
        li.appendChild(tag);
    }

    function appendStoppedNote(assistantLi) {
        if (assistantLi.querySelector(".agent-stopped-note")) return;
        const note = document.createElement("p");
        note.className = "agent-stopped-note";
        note.textContent = "Stopped.";
        assistantLi.appendChild(note);
        maybeScrollToEnd();
    }

    function appendRetryButton(assistantLi, userText) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "agent-retry-inline";
        btn.textContent = "Connection slipped. Try again?";
        btn.addEventListener("click", () => {
            btn.remove();
            // Re-send the last user message; append a fresh assistant bubble
            input.value = userText;
            sendCurrent();
        });
        assistantLi.appendChild(btn);
        maybeScrollToEnd();
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
        return li;
    }

    function appendSystem(text) {
        const li = document.createElement("li");
        li.className = "agent-message agent-message-system";
        const p = document.createElement("p");
        p.textContent = text;
        li.appendChild(p);
        transcript.appendChild(li);
        maybeScrollToEnd();
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
        maybeScrollToEnd();
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
        maybeScrollToEnd();
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
            } else if (/\[\d+(?:\s*,\s*\d+)*\]/.test(fullText)) {
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
        span.textContent = "Internal: profile data";
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
        maybeScrollToEnd();
    }

    // Spec 56: certification badge art.
    //
    // Atlas only ever sends slugs. Every image path and verification link is
    // resolved HERE, against the widget's own copy of profile.json, so a slug
    // the model invented resolves to nothing and renders nothing — the model
    // cannot introduce a URL into the page. Deliberately mirrors
    // renderCertTile() in main.js so the chat badges and the hero rail read as
    // one system rather than two lookalike implementations.
    function renderBadgeStrip(assistantLi, slugs) {
        const certs = (profile && profile.certifications) || [];
        if (!certs.length) return;
        const bySlug = new Map(
            certs.filter(c => c.slug && c.badge).map(c => [c.slug, c])
        );
        const matched = slugs.map(s => bySlug.get(s)).filter(Boolean);
        if (!matched.length) return;

        // Group by issuer: the known issuers in a fixed order, then anything
        // unrecognised appended in first-seen order rather than dropped.
        const groups = new Map();
        for (const c of matched) {
            const issuer = c.issuer || "Other";
            if (!groups.has(issuer)) groups.set(issuer, []);
            groups.get(issuer).push(c);
        }
        const rank = (issuer) => {
            const i = ISSUER_ORDER.indexOf(issuer);
            return i === -1 ? ISSUER_ORDER.length : i;
        };
        const ordered = [...groups.keys()].sort((a, b) => rank(a) - rank(b));

        const wrap = document.createElement("div");
        wrap.className = "agent-badges";
        // One group renders as a bare grid — a lone "Anthropic" header above
        // four Anthropic badges is just noise.
        const showLabels = ordered.length > 1;

        for (const issuer of ordered) {
            const group = document.createElement("div");
            group.className = "agent-badge-group";
            if (showLabels) {
                const label = document.createElement("div");
                label.className = "agent-badge-group-label";
                label.textContent = issuer;
                group.appendChild(label);
            }
            const grid = document.createElement("div");
            grid.className = "agent-badge-grid";
            groups.get(issuer).forEach(c => grid.appendChild(buildBadgeTile(c)));
            group.appendChild(grid);
            wrap.appendChild(group);
        }
        assistantLi.appendChild(wrap);
        maybeScrollToEnd();
    }

    function buildBadgeTile(c) {
        const art = document.createElement("span");
        art.className = "agent-badge-art";
        const img = document.createElement("img");
        img.src = c.badge;
        img.alt = "";           // the caption below carries the name
        img.loading = "lazy";
        img.decoding = "async";
        art.appendChild(img);

        // Visible caption, not just a title tooltip. The badge art alone is
        // unreadable at 56px, and hover doesn't exist in a screenshot or on
        // touch — so the name has to be on the page. `shortName` drops the
        // vendor prefix ("Claude Certified Architect — Professional" →
        // "Architect Pro") because the issuer is already the group heading.
        const caption = document.createElement("span");
        caption.className = "agent-badge-name";
        caption.textContent = c.shortName || c.name || "";

        // Real <a> when there's a credential record to verify against, plain
        // wrapper when there isn't — the same fallback the hero rail uses for
        // the one cert with no public verification URL.
        const wrapper = c.credlyUrl
            ? document.createElement("a")
            : document.createElement("div");
        wrapper.className = "agent-badge-tile";
        if (c.credlyUrl) {
            wrapper.href = escapeUrl(c.credlyUrl);
            wrapper.target = "_blank";
            wrapper.rel = "noopener noreferrer";
            wrapper.setAttribute(
                "aria-label",
                `${c.name} — verify credential (opens in new tab)`
            );
        }
        // Full name on hover, since the caption is the abbreviated form.
        wrapper.title = c.name || "";
        wrapper.append(art, caption);
        return wrapper;
    }

    function renderCta(assistantLi, cta, agentCopy) {
        const entry = agentCopy?.cta?.[cta];
        if (!entry?.url) return;
        // Drop an earlier button for the SAME target before adding this one.
        // The prompt sets cta "linkedin" for availability questions, off-topic
        // declines and after a note send (instruction.py), so two turns in a
        // row both offering "Continue on LinkedIn →" is easy to hit and reads
        // as a rendering bug.
        //
        // Matched on target rather than clearing every prior CTA the way
        // sendCurrent() clears .agent-suggestions: a Topmate button from two
        // turns back is still a live offer worth keeping, while a second
        // identical LinkedIn button directly above the new one is only noise.
        dom.transcript
            .querySelectorAll(`.agent-cta-action[data-cta="${CSS.escape(cta)}"]`)
            .forEach((el) => el.remove());
        const btn = document.createElement("a");
        btn.className = "agent-cta-action";
        btn.dataset.cta = cta;
        btn.href = entry.url;
        btn.target = "_blank";
        btn.rel = "noopener noreferrer";
        btn.textContent = entry.label || "Open →";
        assistantLi.appendChild(btn);
        maybeScrollToEnd();
    }

    // --- Transcript scroll (spec #63) --------------------------------------
    //
    // The panel used to rely on each insertion site remembering to call
    // scrollToEnd() by hand, and four of the seven end-of-stream paths didn't:
    // finalizeAssistant (which rebuilds the whole <p> with citation markers and
    // re-wraps every line), renderCitationList, renderFallbackSource, and the
    // async showSpeakingIndicator. So the last scroll of a turn ran against the
    // pre-finalization height and the transcript was left short of its own
    // bottom — which is also what switched the has-overflow fade on, since that
    // class means "overflowing AND not at the bottom". The visible symptom was
    // the CTA looking half-cut and dimmed at the bottom edge.
    //
    // Sprinkling three more calls would have fixed that screenshot and broken
    // again at the next insertion site, which is how it broke in the first
    // place. A ResizeObserver reacts to the height change itself, so it also
    // covers what nobody enumerated: the composer growing a line for
    // "Speaking…", the textarea growing with a long draft, and the mobile
    // keyboard resizing the panel.

    const AT_BOTTOM_SLOP_PX = 8;

    // True while the visitor is following along at the bottom. Goes false the
    // moment they scroll up to re-read something, and that is what stops a late
    // badge or CTA render from yanking the view away from them — the old
    // scrollToEnd() was unconditional and did exactly that.
    let stickToBottom = true;
    // Direction, not a flag. Our own scrollTop writes fire the same scroll
    // event a human does, and a "we're scrolling programmatically" boolean
    // cannot be cleared safely: scroll events dispatch asynchronously and
    // arrive after the next animation frame, so any timer-based guard is a
    // race. Caught live — a reply that grew once more between the auto-scroll
    // and its own scroll event read as "not at bottom", cleared the flag, and
    // the transcript stopped following mid-turn.
    //
    // An auto-scroll only ever moves DOWN, so treating "scrolled up" as the
    // signal to stop following is immune to the ordering entirely.
    let lastScrollTop = 0;

    function isAtBottom() {
        const b = dom.body;
        return b.scrollTop + b.clientHeight >= b.scrollHeight - AT_BOTTOM_SLOP_PX;
    }

    // Spec 67: the bottom fade is a mask painted over the scroll area, not a
    // spacer inside it, so it takes no room (the old 52px spacer read as a
    // band of empty space under every conversation) and can switch on and
    // off freely: it shows only while there is more below.
    function syncScrollHint() {
        const b = dom.body;
        b.classList.toggle("has-overflow", b.scrollHeight - b.clientHeight - b.scrollTop > 4);
    }

    function onTranscriptScroll() {
        const top = dom.body.scrollTop;
        if (isAtBottom()) {
            stickToBottom = true;
        } else if (top < lastScrollTop - 1) {
            // Moved away from the bottom deliberately. Anything else — growing
            // content, our own catch-up scrolls — leaves the choice alone.
            stickToBottom = false;
        }
        lastScrollTop = top;
        syncScrollHint();
    }

    // Force the view down regardless of where the visitor was. Only correct
    // when they've just acted — sending a message, or opening the panel.
    function scrollToEnd() {
        stickToBottom = true;
        requestAnimationFrame(() => {
            // Settle the fade BEFORE scrolling, not after. Switching the class
            // on adds ~52px to the scroll area, so doing it second left every
            // auto-scroll exactly that far short of the bottom — the last
            // element ended up under the fade, which is the bug this is all
            // about. Reading scrollHeight next forces the reflow.
            syncScrollHint();
            dom.body.scrollTop = dom.body.scrollHeight;
            lastScrollTop = dom.body.scrollTop;
        });
    }

    // The default. Follows new content only if the visitor hadn't scrolled up.
    function maybeScrollToEnd() {
        if (stickToBottom) scrollToEnd();
        else syncScrollHint();
    }

    dom.body.addEventListener("scroll", onTranscriptScroll, { passive: true });

    // Observes the scrollport and its content separately: the content grows
    // when a reply renders, the scrollport shrinks when the composer does.
    // Both leave the bottom out of view, and neither is an insertion site
    // anyone would think to annotate.
    if (typeof ResizeObserver === "function") {
        const ro = new ResizeObserver(() => maybeScrollToEnd());
        ro.observe(dom.body);
        if (dom.transcript) ro.observe(dom.transcript);
    }

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

    // On mobile (<540px) use a narrow viewBox so the diagram renders near
    // natural scale rather than shrunk, making it prominent.
    const mobile = !wide && window.innerWidth < 540;
    // Spec 67: the flow gained Output checks and a second speech branch (the
    // Live Avatar), so both layouts grew: desktop from 540x250 to 640x300,
    // mobile from 300x332 to 300x404.
    // Desktop widened to 816x320 so every model name fits on one line and
    // the mode fork has room to breathe.
    const VW = mobile ? 300 : 816;
    const VH = mobile ? 404 : 320;

    const svg = el("svg", { viewBox: `0 0 ${VW} ${VH}`, width: "100%", height: String(VH),
                             "data-layout": mobile ? "mobile" : "desktop",
                             class: "ad-svg", "aria-hidden": "true" });

    // Spec 67: the answer's way back is a PATH chosen by the mode, not a
    // sequence of stages. The visitor picks Text, Voice or Avatar before
    // asking (1); speech-to-text runs only when they use the mic (2, dashed); the agent reasons (3) and calls tools (4); every
    // answer passes the output checks (5); then exactly ONE of three paths
    // runs (6, colour-coded by mode, all numbered 6 because they are
    // alternatives, the same way Corpus and MCP share 4); and it comes back
    // to you (7). Nothing is written on the connectors except the tiny mode
    // tags at the fork, which is what makes the fork read as a choice.
    const edges = mobile ? [
        { d: "M 96 42 L 96 66", cls: "ad-edge--optional" },     // 1 You -> STT (mic only)
        { d: "M 96 108 L 96 138" },                              // 2 STT -> Agent
        { d: "M 152 155 L 180 155" },                            // 3 Agent -> reasoning
        { d: "M 152 160 L 180 207", cls: "ad-edge--plain" },     // 4 Agent -> corpus
        { d: "M 152 166 L 180 255", cls: "ad-edge--plain" },     // 4 Agent -> MCP
        { d: "M 96 172 L 96 214" },                              // 5 Agent -> Output checks
        { d: "M 60 248 L 60 272 L 18 272", cls: "ad-edge--text" },           // 6 Text
        { d: "M 86 248 L 86 310", cls: "ad-edge--voice" },                    // 6 Voice
        { d: "M 110 248 L 110 286 L 226 286 L 226 310", cls: "ad-edge--avatar" }, // 6 Avatar
        // 7 back to you: all three paths join the left corridor.
        { d: "M 30 331 L 18 331" },
        { d: "M 282 331 L 290 331 L 290 392 L 18 392 L 18 26 L 80 26" },
    ] : [
        { d: "M 86 150 L 130 150", cls: "ad-edge--optional" },   // 1 You -> STT (mic only)
        { d: "M 290 150 L 320 150" },                            // 2 STT -> Agent
        { d: "M 370 128 L 370 68" },                             // 3 Agent -> reasoning
        { d: "M 352 172 L 318 218", cls: "ad-edge--plain" },     // 4 Agent -> corpus
        { d: "M 388 172 L 424 218", cls: "ad-edge--plain" },     // 4 Agent -> MCP
        { d: "M 420 150 L 450 150" },                            // 5 Agent -> Output checks
        { d: "M 506 172 L 506 300", cls: "ad-edge--text" },                          // 6 Text
        // The fork sits 32 units off Output checks and 32 short of the
        // models, so the branch reads as a choice rather than a squeeze.
        { d: "M 562 140 L 594 140 L 594 70 L 626 70", cls: "ad-edge--voice" },       // 6 Voice
        { d: "M 562 160 L 594 160 L 594 230 L 626 230", cls: "ad-edge--avatar" },    // 6 Avatar
        // 7 back to you: all three paths meet on the bottom line.
        { d: "M 790 70 L 804 70 L 804 300 L 60 300 L 60 180" },
        { d: "M 790 230 L 804 230" },
    ];
    edges.forEach(({ d, cls }) => {
        svg.appendChild(el("path", { class: cls ? `ad-edge ${cls}` : "ad-edge ad-edge--key", d }));
    });

    // Numbered markers keyed to the legend below the figure. They appear one
    // after another on an 8s loop and stay lit, so the route builds up in
    // order, then clears and repeats. A marker can carry a mode, which
    // colours it like its path.
    const step = (n, cx, cy, mode) => {
        // Each number has its own keyframes (ad-step-seq-N): it appears on
        // its turn, stays lit, and they all clear together when the loop
        // restarts. Shared numbers (the two 4s, the three 6s) share a turn.
        const g = el("g", { class: `ad-step ad-step--n${n}` + (mode ? ` ad-step--${mode}` : "") });
        g.appendChild(el("circle", { cx: String(cx), cy: String(cy), r: "8" }));
        const t = el("text", { x: String(cx), y: String(cy + 3), "text-anchor": "middle" });
        t.textContent = String(n);
        g.appendChild(t);
        return g;
    };
    // A small pill naming a mode at the start of its path.
    const modeTag = (x, y, label, mode) => {
        const g = el("g", { class: `ad-mode-tag ad-mode-tag--${mode}` });
        const w = label.length * 4.6 + 8;
        g.appendChild(el("rect", { x: String(x), y: String(y), width: String(w), height: "11", rx: "5.5" }));
        const t = el("text", { x: String(x + w / 2), y: String(y + 8), "text-anchor": "middle" });
        t.textContent = label;
        g.appendChild(t);
        return g;
    };
    // Corpus and MCP SHARE step 4 (alternative tools), and the three mode
    // paths SHARE step 6 (exactly one runs): shared numbers light together.
    const steps = mobile
        ? [[1, 96, 54], [2, 96, 123], [3, 166, 155], [4, 166, 183], [4, 165, 207],
           [5, 96, 193], [6, 39, 272, "text"], [6, 86, 279, "voice"], [6, 168, 286, "avatar"], [7, 18, 160]]
        : [[1, 108, 150], [2, 305, 150], [3, 370, 98], [4, 337, 193], [4, 404, 193],
           [5, 435, 150], [6, 506, 214, "text"], [6, 594, 108, "voice"], [6, 594, 192, "avatar"], [7, 60, 236]];
    steps.forEach(([n, cx, cy, mode]) => svg.appendChild(step(n, cx, cy, mode)));
    const tags = mobile
        ? [[24, 283, "Text", "text"], [92, 256, "Voice", "voice"], [180, 292, "Avatar", "avatar"]]
        : [[514, 228, "Text", "text"], [602, 114, "Voice", "voice"], [602, 172, "Avatar", "avatar"]];
    tags.forEach(([x, y, label, mode]) => svg.appendChild(modeTag(x, y, label, mode)));


    // A waveform converting into text lines (or the reverse), shown beside the
    // speech nodes so they say what they do, not just which model does it.
    // `step` ties it to that stage's badge: same 8s cycle, same delay, so the
    // conversion plays while its number is lit and rests still otherwise.
    const BAR_W = 3, BAR_GAP = 4, BAR_HEIGHTS = [7, 13, 18, 11, 6];
    const LINE_WS = [30, 22, 26], LINE_GAP = 7;
    // "to-video" (spec 67, Avatar): text lines become a small video frame
    // with a face in it, the Live Avatar speaking the checked answer.
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
        if (dir === "to-video") {
            const frame = el("g", { class: "ad-xform-video" });
            if (!REDUCE_MOTION) frame.style.animationDelay = `${step - 1}s`;
            const fw = waveW, fh = 18, fx = waveX, fy = cy - fh / 2;
            frame.appendChild(el("rect", { x: String(fx), y: String(fy), width: String(fw), height: String(fh), rx: "3" }));
            frame.appendChild(el("circle", { cx: String(fx + fw / 2), cy: String(fy + 7), r: "3" }));
            frame.appendChild(el("path", { d: `M ${fx + fw / 2 - 6} ${fy + fh} a 6 5 0 0 1 12 0` }));
            g.append(text, arrow, frame);
            return g;
        }
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

    // Official marks for the ADK agent and the MCP server (spec 67). The MCP
    // mark is black on transparent, so it's inverted to read on the dark
    // theme, the same treatment the skills hex grid gives it.
    const brandMark = (href, cx, cy, size, extra) => {
        const im = el("image", {
            x: String(cx - size / 2), y: String(cy - size / 2),
            width: String(size), height: String(size),
            preserveAspectRatio: "xMidYMid meet",
            class: extra ? `ad-brand ${extra}` : "ad-brand",
        });
        im.setAttribute("href", href);
        return im;
    };

    // Spec 67: "You" is a person, not a box. A small figure with a speech
    // bubble that alternates between typing dots and voice bars, because a
    // question can be typed or spoken, in any mode.
    const youNode = (cx, cy, tip, details, compact) => {
        const g = el("g", { class: "ad-node ad-node--you ad-you" });
        const t = el("title", {}); t.textContent = tip; g.appendChild(t);
        const k = compact ? 0.72 : 1;
        // Invisible hit area so the tooltip works over the whole figure.
        g.appendChild(el("rect", { class: "ad-you-hit", x: String(cx - 16 * k), y: String(cy - 34 * k), width: String(46 * k), height: String(46 * k) }));
        g.appendChild(el("circle", { class: "ad-you-body", cx: String(cx), cy: String(cy - 8 * k), r: String(6.5 * k) }));
        g.appendChild(el("path", { class: "ad-you-body", d: `M ${cx - 11 * k} ${cy + 12 * k} v ${-1.5 * k} a ${11 * k} ${9 * k} 0 0 1 ${22 * k} 0 v ${1.5 * k}` }));
        // The bubble, up and to the right of the head.
        const bx = cx + 9 * k, by = cy - 34 * k, bw = 28 * k, bh = 16 * k;
        const bubble = el("g", { class: "ad-you-bubble" });
        bubble.appendChild(el("rect", { x: String(bx), y: String(by), width: String(bw), height: String(bh), rx: String(4 * k) }));
        bubble.appendChild(el("path", { d: `M ${bx + 4 * k} ${by + bh} L ${bx + 1 * k} ${by + bh + 5 * k} L ${bx + 9 * k} ${by + bh}` }));
        const typing = el("g", { class: "ad-you-typing" });
        [0, 1, 2].forEach((i) => {
            const dot = el("circle", { cx: String(bx + 8 * k + i * 6 * k), cy: String(by + bh / 2), r: String(1.7 * k) });
            if (!REDUCE_MOTION) dot.style.animationDelay = `${i * 0.18}s`;
            typing.appendChild(dot);
        });
        const voice = el("g", { class: "ad-you-voice" });
        [5, 9, 12, 8, 4].forEach((h, i) => {
            const bar = el("rect", { x: String(bx + 5.5 * k + i * 4 * k), y: String(by + bh / 2 - h * k / 2), width: String(2 * k), height: String(h * k), rx: String(1 * k) });
            if (!REDUCE_MOTION) bar.style.animationDelay = `${i * 0.1}s`;
            voice.appendChild(bar);
        });
        bubble.append(typing, voice);
        g.appendChild(bubble);
        const name = el("text", compact
            ? { class: "ad-node-name", x: String(cx + 11 * k + 5), y: String(cy + 10 * k), "text-anchor": "start" }
            : { class: "ad-node-name", x: String(cx), y: String(cy + 26), "text-anchor": "middle" });
        name.textContent = "You";
        g.appendChild(name);
        g.setAttribute("data-ad-tip", details.join("\n"));
        return g;
    };

    // A small shield with a tick: the Output checks every answer passes.
    const checkGlyph = (cx, cy) => {
        const g = el("g", { class: "ad-check" });
        g.appendChild(el("path", { d: `M ${cx} ${cy - 5.5} L ${cx + 4.5} ${cy - 3.5} V ${cy + 0.5} C ${cx + 4.5} ${cy + 3.5} ${cx + 2} ${cy + 5} ${cx} ${cy + 5.8} C ${cx - 2} ${cy + 5} ${cx - 4.5} ${cy + 3.5} ${cx - 4.5} ${cy + 0.5} V ${cy - 3.5} Z` }));
        g.appendChild(el("path", { d: `M ${cx - 2} ${cy} L ${cx - 0.4} ${cy + 1.8} L ${cx + 2.4} ${cy - 1.6}` }));
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
            else if (lead === "check") g.appendChild(checkGlyph(gx, nameY - 3.5));
            else if (lead === "adk") g.appendChild(brandMark("/diagram-icons/adk-64.png", gx, nameY - 3.5, LEAD_SIZE + 1));
            else if (lead === "mcp") g.appendChild(brandMark("/diagram-icons/mcp-64.png", gx, nameY - 3.5, LEAD_SIZE, "ad-brand--mono"));
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
        you:    ["pick Text, Voice or Avatar first", "then type, or hold the mic", "the mode sets how the answer comes back"],
        llm:    ["Gemini 3.6 Flash writes every answer", "in Text mode, its answer is what streams back", "picked for time to first word", "falls back to 3.5 Flash-Lite if it stalls"],
        agent:  ["9 tools: profile · work · projects · posts", "certifications · agents · labs · stats · email", "ADK on Cloud Run", "one call per question, whatever the mode"],
        corpus: ["profile.json · bio, roles, certs", "graph.json · projects", "posts.json · LinkedIn", "fetched live, short-TTL cache"],
        stt:    ["Gemini 3.5 Transcribe", "only when you use the mic, in any mode", "typed questions skip it", "runs outside the ADK loop"],
        checks: ["working note to the Thinking panel", "only Gaurav's real contact email", "one source per citation · no dashes", "answer sized for text or speech"],
        tts:    ["Gemini 3.1 Flash TTS · Voice mode only", "the browser sends each sentence as it arrives", "plays while the rest is still streaming"],
        avatar: ["Gemini 3.8 Live Avatar · Avatar mode only", "session opens when you ask, while Atlas thinks", "Sam speaks the checked answer word for word", "fMP4 video on the same SSE stream", "word-timed captions · 3 answers per visitor a day"],
        mcp:    ["send-email (Resend API)", "compose + fire transactional email", "agent-triggered · not a webhook"],
    };

    // ad-node--key marks the AI-model stages (Gemini, STT, TTS, Live Avatar)
    // with an accent node name; ad-node--you marks the human entry/exit point;
    // ad-node--checks is the gate every answer passes. Data Corpus and MCP
    // Server stay plain so the model stages read as the primary path.
    if (mobile) {
        svg.appendChild(youNode(96, 30, "You: pick a mode, then type or hold the mic", TIPS.you, true));
        svg.appendChild(node("ad-node--key",    40,  66, 112, 42, ["Gemini 3.5", "Transcribe"], "speech-to-text", "Gemini 3.5 Transcribe converts mic input to text, only when you use the mic", 96, TIPS.stt, "gemini"));
        svg.appendChild(node("ad-node--hub",    40, 138, 112, 34, "Agent",      "ADK",                  "ADK agent on Cloud Run, orchestrates all tool calls", 96, TIPS.agent, "adk"));
        svg.appendChild(node("ad-node--key",   180, 138, 116, 34, "Gemini 3.6 Flash", "reasoning", "Gemini 3.6 Flash works out the answer and writes it", 238, TIPS.llm, "gemini"));
        svg.appendChild(node(null,             180, 192, 116, 30, "Corpus",     "grounding",            "Live JSON fetch, grounding source for every reply", 238, TIPS.corpus));
        svg.appendChild(node(null,             180, 240, 116, 30, "MCP",        "actions",              "MCP-compatible Resend server, fires email on agent request", 238, TIPS.mcp, "mcp"));
        svg.appendChild(node("ad-node--checks", 40, 214, 112, 34, "Checks",     "grounded · clean",     "Output checks every answer passes before you see it", 96, TIPS.checks, "check"));
        svg.appendChild(node("ad-node--key ad-node--voice",    30, 310, 112, 42, ["Gemini 3.1", "Flash TTS"], "text-to-speech", "Gemini 3.1 Flash TTS reads the answer aloud", 86, TIPS.tts, "gemini"));
        svg.appendChild(node("ad-node--key ad-node--avatar",   170, 310, 112, 42, ["Gemini 3.8", "Live Avatar"], "lip-synced video", "Gemini 3.8 Live Avatar speaks the answer on video", 226, TIPS.avatar, "gemini"));
        svg.appendChild(xformStrip(226,  87, "to-text",  2));
        svg.appendChild(xformStrip(86,  370, "to-voice", 6));
        svg.appendChild(xformStrip(226, 370, "to-video", 6));
    } else {
        svg.appendChild(youNode(60, 146, "You: pick a mode, then type or hold the mic", TIPS.you));
        svg.appendChild(node("ad-node--key",    130, 124, 160, 52, "Gemini 3.5 Transcribe", "speech-to-text",   "Gemini 3.5 Transcribe converts mic input to text, only when you use the mic", 210, TIPS.stt, "gemini"));
        svg.appendChild(node("ad-node--hub",    320, 128, 100, 44, "Agent",            "ADK loop",             "ADK agent on Cloud Run, orchestrates all tool calls", 370, TIPS.agent, "adk"));
        svg.appendChild(node("ad-node--key",    295,  24, 150, 44, "Gemini 3.6 Flash", "reasoning",            "Gemini 3.6 Flash works out the answer and writes it", 370, TIPS.llm, "gemini"));
        svg.appendChild(node(null,              258, 218, 108, 38, "Data Corpus",      "grounding",            "Live JSON fetch, grounding source for every reply", 312, TIPS.corpus));
        svg.appendChild(node(null,              378, 218, 108, 38, "MCP Server",       "actions",              "MCP-compatible Resend server, fires email on agent request", 432, TIPS.mcp, "mcp"));
        svg.appendChild(node("ad-node--checks", 450, 128, 112, 44, "Output checks",    "grounded · clean",     "Output checks every answer passes before you see it", 506, TIPS.checks, "check"));
        svg.appendChild(node("ad-node--key ad-node--voice",  626,  44, 164, 52, "Gemini 3.1 Flash TTS",   "text-to-speech",   "Gemini 3.1 Flash TTS reads the answer aloud", 708, TIPS.tts, "gemini"));
        svg.appendChild(node("ad-node--key ad-node--avatar", 626, 204, 164, 52, "Gemini 3.8 Live Avatar", "lip-synced video", "Gemini 3.8 Live Avatar speaks the answer on video", 708, TIPS.avatar, "gemini"));
        // Under STT, clear of the reasoning box above the Agent.
        svg.appendChild(xformStrip(210, 196, "to-text",  2));
        // Above TTS, mirroring the video strip under Live Avatar (same gap).
        svg.appendChild(xformStrip(708,  24, "to-voice", 6));
        svg.appendChild(xformStrip(708, 276, "to-video", 6));
    }

    return svg;
}

// The seven pipeline steps, written once and used by both the legend under
// the diagram and the fullscreen view. Numbers match the badges in the SVG.
// Step 4 covers both tool nodes in the diagram, which share that badge:
// the model decides in step 3, then calls whichever tools it needs.
const AGENT_STEPS = [
    ["You pick a mode and ask", "Text, Voice or Avatar, chosen before you ask. Type, or hold the mic"],
    ["Speech-to-Text (STT)", "only when you use the mic: Gemini 3.5 Transcribe turns the recording into text. Typed questions skip it"],
    ["Reasoning", "Gemini 3.6 Flash works out the answer and writes it"],
    ["Tools", "the live corpus for facts, and the MCP server for actions like emailing the resume"],
    ["Output checks", "the working note moves to the Thinking panel, and only real contact details, clean citations and a length sized for the mode get through"],
    ["Your mode's path, one of three", "Text streams it · Voice: the browser has Gemini 3.1 Flash TTS read it a sentence at a time · Avatar: Sam speaks it on video through Gemini 3.8 Live Avatar, a session opened while Atlas was thinking"],
    ["Back to you", "text streams in, and audio plays or Sam speaks, with each word lit as it's said"],
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
    // Desktop keeps the top-right corner for the Voice strip, and its
    // top-left corner is empty, so Expand sits there.
    if (svg.getAttribute("data-layout") === "desktop") btn.classList.add("ad-expand--left");
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
        <div class="agent-mode" role="radiogroup" aria-label="How Atlas answers" data-active="text">
            <span class="agent-mode-glide" aria-hidden="true"></span>
            <button type="button" role="radio" class="agent-mode-opt" data-mode="text" aria-label="Text" aria-checked="true" title="Atlas answers in text">
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h6.5"/>
                </svg>
                <span>Text</span>
            </button>
            <button type="button" role="radio" class="agent-mode-opt" data-mode="voice" aria-label="Voice" aria-checked="false" title="Atlas reads new answers aloud. Earlier answers stay as they are, nothing is asked again.">
                <span class="agent-mode-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
                <span>Voice</span>
            </button>
            <button type="button" role="radio" class="agent-mode-opt" data-mode="avatar" aria-label="Avatar" aria-checked="false" title="Meet Atlas face to face. Earlier answers stay as they are, nothing is asked again.">
                <span class="agent-mode-orb" aria-hidden="true"><span class="agent-mode-orb-face">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="8" cy="6" r="2.75"/>
                        <path d="M3 14a5 5 0 0 1 10 0"/>
                        <path d="M1.5 4V2.5a1 1 0 0 1 1-1H4M12 1.5h1.5a1 1 0 0 1 1 1V4"/>
                    </svg>
                </span></span>
                <span>Avatar</span>
                <span class="agent-mode-new" aria-hidden="true"></span>
            </button>
        </div>
    `;
    const closeBtn = head.querySelector(".agent-panel-close");
    const speakerBtn = head.querySelector(".agent-speaker");
    const modeSwitch = head.querySelector(".agent-mode");
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
    sendBtn.title = "Send";
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
    micBtn.title = "Ask by voice";
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
    // Spec 67: a labelled control, next to the composer where the chat lives,
    // rather than a bare trash icon among the window controls.
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "agent-panel-clear";
    clearBtn.hidden = true;
    clearBtn.title = "Clear the conversation and start fresh";
    clearBtn.innerHTML =
        '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v2.6h2.6"/></svg>'
        + "<span>Clear chat</span>";
    foot.appendChild(clearBtn);

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
        prompts, transcript, input, inputRow, sendBtn, micBtn, speakerBtn, clearBtn, modeSwitch, voiceStatus, liveRegion, foot,
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
const SHORT_VIEWPORT_PX = 520;
function trackVisualViewport(panel) {
    const vv = window.visualViewport;
    if (!vv) return;
    let raf = 0;
    const sync = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            panel.style.setProperty("--agent-vv-height", `${vv.height}px`);
            // Spec 72: too short for the face and a usable composer (the
            // keyboard is up, or a landscape phone). The face steps aside
            // until there's room again; the chat and its captions carry on.
            panel.classList.toggle("is-short", vv.height < SHORT_VIEWPORT_PX);
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
                ? "Still on it. The first answer of the session takes a few extra seconds, so hang tight."
                : "Still on it. This one's taking a moment, so hang tight.";
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

// A fresh chat session id (same shape as main.js's page id).
function newSessionId() {
    if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// One chat turn. Tried over a WebSocket first: a corporate inspection proxy
// (measured on a Netskope-managed laptop) held the SSE stream until it was
// complete and released it in one burst, so text, voice and the avatar all
// arrived seconds late, while WebSocket frames came through live. Same
// server turn, same JSON events. If the socket can't open, the turn goes
// over SSE instead, and this tab stops trying sockets; once a turn has been
// sent over a socket it is never re-sent, so it can't be answered twice.
let chatSocketBroken = false;

async function streamAgent(opts) {
    if (!chatSocketBroken && typeof WebSocket === "function") {
        const outcome = await streamAgentSocket(opts);
        if (outcome !== "unavailable") return;
        chatSocketBroken = true;
    }
    return streamAgentSse(opts);
}

function chatRequestBody({ sessionId, messages, identity, avatar, mode }) {
    const reqBody = identity ? { sessionId, messages, identity } : { sessionId, messages };
    // Spec 67: ask this turn to be spoken by the avatar, on this stream.
    if (avatar) reqBody.avatar = true;
    // How the answer will reach the visitor; spoken modes get shorter ones.
    if (mode) reqBody.mode = mode;
    return reqBody;
}

function reportChatHttpError(status, detail, onError) {
    if (status === 429) {
        onError(detail || "Lots of people are chatting right now. Give it a minute, or find Gaurav on LinkedIn.", false);
    } else if (status >= 500) {
        onError("Hmm, something went wrong on my end. Mind trying that again?", false);
    } else {
        onError(detail || `Request failed (${status}).`, false);
    }
}

// Routes one server event to the turn's callbacks, the same for both
// transports. Returns true on `done`.
function chatEventSink({ onThinking, onDelta, onCitations, onSuggestions, onCta, onBadges, onAvatar }) {
    const sink = { full: "", hadDeltas: false };
    sink.handle = (evt) => {
        if (typeof evt.delta === "string") {
            sink.full += evt.delta;
            sink.hadDeltas = true;
            onDelta(evt.delta);
        } else if (typeof evt.thinking === "string" && FEATURES.thinking) {
            onThinking(evt.thinking);
        } else if (evt.citations && FEATURES.citations) {
            onCitations(evt.citations);
        } else if (evt.suggestions && FEATURES.suggestions) {
            onSuggestions(evt.suggestions);
        } else if (evt.cta && FEATURES.cta) {
            onCta(evt.cta);
        } else if (evt.badges && FEATURES.badges) {
            onBadges(evt.badges);
        } else if (onAvatar && typeof evt.avatarVideo === "string") {
            onAvatar.video(evt.avatarVideo); // spec 67: live avatar frames
        } else if (onAvatar && evt.avatarWords) {
            // { text, at }: `at` is when the chunk's last word is heard.
            const w = evt.avatarWords;
            if (typeof w === "string") onAvatar.words(w, NaN);
            else if (typeof w.text === "string") onAvatar.words(w.text, Number(w.at));
        } else if (onAvatar && typeof evt.avatarShow === "string") {
            onAvatar.show(evt.avatarShow); // spec 78: a target key, resolved by site-stage.js
        } else if (onAvatar && evt.avatarEnd) {
            onAvatar.end();
        } else if (onAvatar && evt.avatarUnavailable) {
            onAvatar.unavailable(evt.avatarUnavailable.reason || "", evt.avatarUnavailable.capped === true);
        } else if (evt.done === true) {
            return true;
        }
        return false;
    };
    return sink;
}

// Resolves "unavailable" only when nothing was sent (the socket never
// opened), so the caller may safely retry over SSE; otherwise "done".
function streamAgentSocket(opts) {
    const { apiUrl, signal, onDone, onError } = opts;
    const url = apiUrl.replace(/^http/, "ws").replace(/\/api\/agent-chat$/, "/api/agent-chat-ws");
    const sink = chatEventSink(opts);
    return new Promise((resolve) => {
        let ws;
        try { ws = new WebSocket(url); } catch (_) { resolve("unavailable"); return; }
        let opened = false;
        let finished = false;
        const finish = (text) => {
            if (finished) return;
            finished = true;
            clearTimeout(openTimer);
            signal?.removeEventListener("abort", onAbort);
            try { ws.close(); } catch (_) { /* already closed */ }
            onDone(text);
            resolve("done");
        };
        const onAbort = () => {
            if (opened) { try { ws.send(JSON.stringify({ abort: true })); } catch (_) { /* closing anyway */ } }
            finish(sink.hadDeltas ? sink.full : "");
        };
        // A socket that neither opens nor fails promptly is treated as
        // blocked, before anything has been sent.
        const openTimer = setTimeout(() => {
            if (opened || finished) return;
            finished = true;
            try { ws.close(); } catch (_) { /* ignore */ }
            resolve("unavailable");
        }, 4000);
        if (signal?.aborted) { clearTimeout(openTimer); onDone(""); resolve("done"); return; }
        signal?.addEventListener("abort", onAbort, { once: true });
        ws.onopen = () => {
            opened = true;
            clearTimeout(openTimer);
            ws.send(JSON.stringify(chatRequestBody(opts)));
        };
        ws.onmessage = (m) => {
            let evt;
            try { evt = JSON.parse(m.data); } catch { return; }
            if (typeof evt.httpStatus === "number") {
                reportChatHttpError(evt.httpStatus, evt.error, onError);
                finish("");
                return;
            }
            if (sink.handle(evt)) finish(sink.full);
        };
        const onBroken = () => {
            if (finished) return;
            if (!opened) {
                finished = true;
                clearTimeout(openTimer);
                signal?.removeEventListener("abort", onAbort);
                resolve("unavailable");
                return;
            }
            // Dropped mid-turn: same handling as a dropped SSE stream.
            onError("", sink.hadDeltas /* isMidStream */);
            finish(sink.hadDeltas ? sink.full : "");
        };
        ws.onerror = onBroken;
        ws.onclose = onBroken;
    });
}

async function streamAgentSse(opts) {
    const { apiUrl, signal, onDone, onError } = opts;
    let response;
    try {
        response = await fetch(apiUrl, {
            method: "POST",
            mode: "cors",
            cache: "no-store",
            signal,
            headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
            body: JSON.stringify(chatRequestBody(opts)),
        });
    } catch (err) {
        if (signal?.aborted) { onDone(""); return; }
        onError("I can't reach the server right now. It might be a connection hiccup. Gaurav's on LinkedIn if it's urgent.", false);
        onDone("");
        return;
    }
    if (!response.ok) {
        let detail;
        try { detail = (await response.json()).error; } catch { detail = null; }
        reportChatHttpError(response.status, detail, onError);
        onDone("");
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const sink = chatEventSink(opts);
    let buffer = "";
    let done = false;

    try {
        while (true) {
            let chunk;
            try {
                chunk = await reader.read();
            } catch (readErr) {
                if (signal?.aborted) { onDone(sink.hadDeltas ? sink.full : ""); return; }
                // Network dropped mid-stream
                onError("", true /* isMidStream */);
                onDone(sink.hadDeltas ? sink.full : "");
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
                if (sink.handle(evt)) { done = true; break; }
            }
            if (done) break;
        }
    } catch (err) {
        if (signal?.aborted) { onDone(sink.hadDeltas ? sink.full : ""); return; }
        onError("", sink.hadDeltas /* isMidStream */);
        onDone(sink.hadDeltas ? sink.full : "");
        return;
    }
    onDone(sink.full);
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

    // Build a combined regex for URLs and [N] markers. A combined marker
    // ("[1, 2]", which the server now splits, but older output may carry)
    // becomes one linked marker per source.
    const combined = /https?:\/\/[^\s<>()\[\]]+|\[(\d+(?:\s*,\s*\d+)*)\]/gi;
    combined.lastIndex = 0;
    let match;
    while ((match = combined.exec(text)) !== null) {
        if (match.index > pos) {
            segments.push({ type: "text", value: text.slice(pos, match.index) });
        }
        if (match[1] !== undefined) {
            // [N] citation marker(s)
            for (const n of match[1].split(",")) {
                segments.push({ type: "cite", n: Number(n.trim()), raw: `[${n.trim()}]` });
            }
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
            } else if (Object.keys(citationMap).length > 0) {
                // A marker with no source behind it (the server keeps at most
                // five): drop it, and the space before it, rather than show a
                // dead "[6]".
                const prev = container.lastChild;
                if (prev && prev.nodeType === Node.TEXT_NODE) prev.nodeValue = prev.nodeValue.replace(/\s+$/, "");
            } else {
                // No citation data at all: render plain (the "Internal:
                // profile data" source line explains it).
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
