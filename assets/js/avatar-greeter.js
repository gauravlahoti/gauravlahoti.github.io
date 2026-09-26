// avatar-greeter.js — the recorded Atlas video card (spec 67).
//
// Pre-recorded clips only. No live model call happens here — that's a
// separate, not-yet-built phase (see .claude/specs/67-atlas-avatar.md).
// "Ask me anything" hands off to the existing chat widget via the same
// [data-agent-open] delegation main.js already wires up for the hero CTA
// and mobile bottom bar, so this module never needs to know how to load
// agent-widget.js itself.

const GREETED_KEY = "atlasAvatarGreeted_v1";
const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SAVE_DATA = !!(navigator.connection && navigator.connection.saveData);

function alreadyGreeted() {
    try { return localStorage.getItem(GREETED_KEY) === "1"; } catch (_) { return false; }
}
function markGreeted() {
    try { localStorage.setItem(GREETED_KEY, "1"); } catch (_) { /* ignore */ }
}

function el(tag, className, attrs) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
}

export async function initAvatarGreeter(root) {
    if (!root) return null;

    let data;
    try {
        data = await fetch("content/avatar.json", { cache: "no-cache" }).then((r) => r.json());
    } catch (err) {
        console.warn("[avatar-greeter] avatar.json missing or invalid", err);
        return null;
    }
    if (!data || !Array.isArray(data.chapters) || !data.chapters.length) return null;

    const greeting = data.chapters.find((c) => c.autoplay) || data.chapters[0];
    const chipChapters = data.chapters.filter((c) => c.chip);

    // -- launcher pill: always available, re-opens the card on demand --
    const launcher = el("button", "avatar-launcher", { type: "button", "aria-label": "Meet Atlas" });
    launcher.hidden = true;
    launcher.textContent = "Meet Atlas";

    // -- card --
    const card = el("div", "avatar-card", { role: "dialog", "aria-label": "Meet Atlas" });
    card.hidden = true;

    const dismiss = el("button", "avatar-card-dismiss", { type: "button", "aria-label": "Close" });
    dismiss.textContent = "×";

    const video = el("video", "avatar-card-video", {
        muted: "",
        playsinline: "",
        preload: "none",
    });
    video.muted = true;

    const track = document.createElement("track");
    track.kind = "captions";
    track.srclang = "en";
    track.label = "English";
    track.default = true;
    video.appendChild(track);

    const soundBtn = el("button", "avatar-card-sound", { type: "button", "aria-label": "Turn on sound" });
    soundBtn.textContent = "🔊";

    const captionLabel = el("p", "avatar-card-label");
    captionLabel.textContent = data.captionLabel || "AI avatar, generated with Gemini";

    const chips = el("div", "avatar-card-chips");

    function loadChapter(chapter, { autoplay } = {}) {
        video.poster = chapter.poster || "";
        video.src = chapter.clip || "";
        track.src = chapter.captions || "";
        if (autoplay) {
            video.play().catch(() => { /* needs a gesture; poster still shows */ });
        }
    }

    function openCard({ autoplay } = { autoplay: true }) {
        card.hidden = false;
        launcher.hidden = true;
        loadChapter(greeting, { autoplay: autoplay && !REDUCE_MOTION });
        markGreeted();
    }

    function closeCard() {
        card.hidden = true;
        video.pause();
        launcher.hidden = false;
    }

    dismiss.addEventListener("click", closeCard);
    launcher.addEventListener("click", () => openCard({ autoplay: !REDUCE_MOTION }));

    soundBtn.addEventListener("click", () => {
        video.muted = !video.muted;
        soundBtn.setAttribute("aria-label", video.muted ? "Turn on sound" : "Mute");
        soundBtn.classList.toggle("is-muted", video.muted);
        if (!video.muted) video.play().catch(() => {});
    });

    chipChapters.forEach((chapter) => {
        const chip = el("button", "avatar-card-chip", { type: "button" });
        chip.textContent = chapter.chip;
        chip.addEventListener("click", () => loadChapter(chapter, { autoplay: true }));
        chips.appendChild(chip);
    });

    if (data.askAnything) {
        const askChip = el("button", "avatar-card-chip avatar-card-chip-ask", {
            type: "button",
            "data-agent-open": "",
        });
        askChip.textContent = data.askAnything.chip || "Ask me anything";
        chips.appendChild(askChip);
    }

    card.append(dismiss, video, soundBtn, captionLabel, chips);
    root.append(card, launcher);

    // First visit: greet once, muted, after the page has settled. Skip the
    // auto-open on save-data — the launcher pill stays available either way.
    if (!alreadyGreeted() && !SAVE_DATA) {
        openCard({ autoplay: !REDUCE_MOTION });
    } else {
        launcher.hidden = false;
    }

    return { open: openCard, close: closeCard };
}
