// agent-avatar.js — Atlas's avatar mode (spec 67).
//
// A compact stage inside the Atlas panel: the Gemini Live Avatar face on the
// left, live captions on the right. Lazy-imported by agent-widget.js only when
// the visitor turns avatar mode on, so plain chat never pays for it.
//
// It carries no buttons of its own. Atlas's existing prompt chips already
// cover the topics, so the avatar only greets; the conversation stays in the
// chat below. Pre-recorded clip only, no live model call here (see
// .claude/specs/67-atlas-avatar.md). The widget pauses this stage whenever
// Atlas itself starts talking, and this stage tells the widget when it
// starts, so two voices never overlap.

// Resolve against the site root, not the page: the widget also mounts on
// /live-agents/, where a page-relative "content/..." would 404.
const SITE_ROOT = new URL("../../", import.meta.url);
const at = (path) => new URL(path, SITE_ROOT).href;

const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

let dataPromise = null;
function loadData() {
    if (!dataPromise) {
        dataPromise = fetch(at("content/avatar.json"), { cache: "no-cache" })
            .then((r) => { if (!r.ok) throw new Error(`avatar.json ${r.status}`); return r.json(); })
            .catch((err) => { dataPromise = null; throw err; });
    }
    return dataPromise;
}

function el(tag, className, attrs) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
}

// opts.autoplay — play the greeting now (only pass true from a real click).
// opts.onPlay   — called when the clip starts, so the widget can hush Atlas's voice.
export async function mountAvatarStage(host, { autoplay = false, onPlay } = {}) {
    const data = await loadData();
    const clip = (data.chapters || []).find((c) => c.autoplay) || (data.chapters || [])[0];
    if (!clip) throw new Error("avatar.json has no greeting clip");

    const stage = el("div", "agent-avatar", { role: "region", "aria-label": "Atlas avatar" });

    const frame = el("div", "agent-avatar-frame");
    const video = el("video", "agent-avatar-video", {
        playsinline: "",
        preload: "none",
        poster: at(clip.poster),
        src: at(clip.clip),
        "aria-label": "Atlas introducing itself",
    });
    // Captions render in the side column, not over a 64px-wide face, so the
    // track is "hidden": its cues still fire, the browser just doesn't draw them.
    const track = el("track", null, { kind: "captions", srclang: "en", label: "English", src: at(clip.captions) });
    video.appendChild(track);
    const playBtn = el("button", "agent-avatar-play", { type: "button", "aria-label": "Play Atlas's introduction" });
    playBtn.textContent = "▶";
    frame.append(video, playBtn);

    const side = el("div", "agent-avatar-side");
    const name = el("p", "agent-avatar-name", { title: "Generated with Gemini 3.8 Live Avatar" });
    const strong = el("strong");
    strong.textContent = "Atlas";
    name.append(strong, " · AI avatar");
    const idleLine = data.idleCaption || "Generated with Gemini. Tap my face to replay.";
    const caption = el("p", "agent-avatar-caption", { "aria-live": "polite" });
    caption.textContent = idleLine;
    side.append(name, caption);

    stage.append(frame, side);
    host.appendChild(stage);
    track.track.mode = "hidden";

    function syncPlay() { playBtn.hidden = !video.paused; }
    function play() { video.play().catch(syncPlay); }

    video.addEventListener("play", () => { syncPlay(); onPlay && onPlay(); });
    // Paused mid-sentence (Atlas took over, or a tap): don't leave half a
    // sentence hanging in the caption line.
    video.addEventListener("pause", () => { if (!video.ended) caption.textContent = idleLine; syncPlay(); });
    // Back to the poster when the clip ends rather than freezing on its last
    // frame. load() re-shows the poster and keeps src, so play replays it.
    video.addEventListener("ended", () => {
        video.load();
        track.track.mode = "hidden";
        caption.textContent = idleLine;
        syncPlay();
    });
    video.addEventListener("click", () => (video.paused ? play() : video.pause()));
    playBtn.addEventListener("click", play);

    track.addEventListener("cuechange", () => {
        const cue = track.track.activeCues && track.track.activeCues[0];
        if (cue) caption.textContent = cue.text;
    });

    if (autoplay && !REDUCE_MOTION) play(); else syncPlay();

    return {
        el: stage,
        pause() { if (!video.paused) video.pause(); },
        replay() { video.currentTime = 0; play(); },
        dispose() {
            video.pause();
            video.removeAttribute("src");
            video.load();
            stage.remove();
        },
    };
}
