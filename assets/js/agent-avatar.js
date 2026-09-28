// agent-avatar.js — Atlas's avatar mode (spec 67).
//
// Avatar mode is a video call with Atlas: the Gemini Live Avatar face fills
// the panel, and the only text is a transcript of what it says, appearing as
// it says it. Lazy-imported by agent-widget.js only when the visitor picks
// Avatar, so plain chat never pays for it.
//
// Two things play on the face:
//   - the greeting, a pre-recorded clip (free to serve), and
//   - live turns. The chat request itself opens a Gemini 3.8 Live session as
//     the avatar while Atlas thinks, so the face idles live (blinks,
//     breathes) instead of freezing, then speaks the reply the moment it is
//     written. Video arrives on the chat's own SSE stream as base64 fMP4
//     chunks and is fed into this <video> through MediaSource.
//
// The widget owns the transcript; this module owns the face.

// Resolve against the site root, not the page: the widget also mounts on
// /live-agents/, where a page-relative "content/..." would 404.
const SITE_ROOT = new URL("../../", import.meta.url);
const at = (path) => new URL(path, SITE_ROOT).href;

const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

// What the Live API streams: H.264 Constrained Baseline + AAC-LC in
// fragmented MP4, read from the stream's own avcC box (spec 67).
const STREAM_MIME = 'video/mp4; codecs="avc1.42C01F, mp4a.40.2"';
// Safari on iOS only exposes ManagedMediaSource.
const MS = window.ManagedMediaSource || window.MediaSource;
// Live, not buffered playback: if the player falls this far behind the
// newest frame it skips ahead, so the face never lags the words.
const MAX_LAG_S = 1.2;
// Safety ceiling on one live turn. Replies are capped well under a minute of
// speech (instruction.py keeps them under ~120 words), so this never fires on
// a genuinely still-speaking turn. It exists for the case a browser/hardware
// combo can't actually decode this stream: captions still arrive and paint
// (the server drives them independently of whether the client's video is
// playing), so the karaoke loop in agent-widget.js starts regardless — but if
// the video itself never reaches "ended" because it's stuck (stalled, or an
// error the `error` listener below doesn't catch), nothing else closes the
// live session, and that loop's only exit is the session being closed. Left
// alone, it runs one requestAnimationFrame tick forever, which is a real,
// ongoing cost even after the visitor moves on — reported as the site
// feeling laggy on a machine where this stream doesn't decode cleanly.
const LIVE_WATCHDOG_MS = 45_000;

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

/** True when this browser can play a live avatar turn at all. */
export function canStreamAnswers() {
    return !!(MS && MS.isTypeSupported && MS.isTypeSupported(STREAM_MIME));
}

function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// opts.autoplay — play the greeting now (only pass true from a real click).
// opts.onPlay   — called whenever the face starts talking, so the widget can
//                 hush Atlas's TTS voice.
// opts.onWords  — (text, {start, end, now, done}) for each greeting caption
//                 cue as it is said, so the widget can add its words to the
//                 transcript and light them in time with the video.
// opts.onState  — "idle" | "listening" | "speaking" on every change, so the
//                 widget can offer Stop while the face is busy.
export async function mountAvatarStage(host, { autoplay = false, onPlay, onWords, onState } = {}) {
    const data = await loadData();
    const clip = (data.chapters || []).find((c) => c.autoplay) || (data.chapters || [])[0];
    if (!clip) throw new Error("avatar.json has no greeting clip");
    const idle = data.idle || null;

    const stage = el("div", "agent-avatar", { role: "region", "aria-label": "Atlas avatar", "data-state": "idle" });
    const frame = el("div", "agent-avatar-frame");
    const video = el("video", "agent-avatar-video", { playsinline: "", preload: "auto" });
    // Needed for ManagedMediaSource on Safari, harmless elsewhere.
    video.disableRemotePlayback = true;
    // The greeting's cues drive its transcript; they are never drawn on the face.
    const track = el("track", null, { kind: "captions", srclang: "en", label: "English" });
    video.appendChild(track);

    // The only label: a tag on the video that says what the face is doing.
    const tag = el("span", "agent-avatar-tag");
    const tagName = el("strong");
    tagName.textContent = "Atlas";
    const tagState = el("span", "agent-avatar-tag-state");
    tag.append(el("i", null, { "aria-hidden": "true" }), tagName, tagState);

    // Live turns play on their own layer over the idle loop and fade in on
    // their first frame, so the face never blanks while the session spins up.
    const liveVideo = el("video", "agent-avatar-video agent-avatar-video-live", { playsinline: "", "aria-hidden": "true" });
    liveVideo.disableRemotePlayback = true;
    liveVideo.addEventListener("playing", () => liveVideo.classList.add("is-on"));
    liveVideo.addEventListener("ended", () => { if (mode === "live") endLive(); });
    // A genuine decode/network failure (MediaError) will never reach "ended"
    // on its own, so without this the session — and the karaoke loop reading
    // its `closed` flag — would hang until the watchdog below finally times
    // it out. Tearing down immediately here is just faster, and the logged
    // error is the actual diagnostic for what failed.
    liveVideo.addEventListener("error", () => {
        if (mode !== "live") return;
        const err = liveVideo.error;
        console.warn("[atlas-avatar] liveVideo error:", err && err.code, err && err.message);
        endLive();
    });

    frame.append(video, liveVideo, tag);
    stage.append(frame);
    host.appendChild(stage);

    const LABEL = { idle: "live", listening: "thinking", speaking: "speaking" };
    function setState(state) {
        stage.dataset.state = state;
        tagState.textContent = LABEL[state] || LABEL.idle;
        if (onState) onState(state);
    }

    // "idle" loops a muted clip cut from a live idle session, so the face
    // never looks frozen or recorded; "greeting" is the one-time hello;
    // "live" is a MediaSource turn.
    let mode = "idle";
    let live = null;

    function showIdle() {
        mode = "idle";
        track.removeAttribute("src");
        video.loop = true;
        video.muted = true;
        video.setAttribute("aria-label", "Atlas, listening");
        setState("idle");
        if (!idle) { video.removeAttribute("src"); video.poster = at(clip.poster); return; }
        video.poster = at(idle.poster);
        video.src = at(idle.clip);
        // Reduced motion keeps the still; otherwise the face breathes.
        if (!REDUCE_MOTION) video.play().catch(() => {});
    }
    function playGreeting() {
        mode = "greeting";
        video.loop = false;
        video.muted = false;
        video.poster = at(clip.poster);
        video.src = at(clip.clip);
        track.src = at(clip.captions);
        track.track.mode = "hidden";
        video.setAttribute("aria-label", `Atlas says: ${clip.script || "hello"}`);
        video.play().catch(() => showIdle());
    }

    video.addEventListener("play", () => {
        if (mode === "greeting") { setState("speaking"); onPlay && onPlay(); }
    });
    video.addEventListener("ended", () => {
        if (mode === "greeting") showIdle();
    });
    // The greeting's words, cue by cue, with the timing the widget needs to
    // light each word as it is said: the cue's span and the video's clock.
    const greetingClock = () => (mode === "greeting" ? video.currentTime : Infinity);
    const greetingDone = () => mode !== "greeting";
    track.addEventListener("cuechange", () => {
        if (mode !== "greeting" || !onWords) return;
        const cue = track.track.activeCues && track.track.activeCues[0];
        if (cue) {
            onWords(cue.text + " ", { start: cue.startTime, end: cue.endTime, now: greetingClock, done: greetingDone });
        }
    });

    // ---- live turns -------------------------------------------------------

    function endLive() {
        const l = live;
        live = null;
        if (!l) return;
        if (l.watchdog) clearTimeout(l.watchdog);
        l.closed = true;
        liveVideo.classList.remove("is-on");
        liveVideo.pause();
        liveVideo.removeAttribute("src");
        liveVideo.load();
        if (l.objectUrl) URL.revokeObjectURL(l.objectUrl);
        showIdle();
    }

    // Start a live turn: the face goes live and waits for frames. Returns a
    // handle the widget feeds from the chat stream.
    function startLive() {
        endLive();
        // The idle loop keeps breathing underneath until the live frames land.
        if (mode === "greeting") showIdle();
        mode = "live";
        const l = { queue: [], appending: false, started: false, ended: false, closed: false, objectUrl: null, sb: null, ms: null, watchdog: null };
        live = l;
        setState("listening");
        video.setAttribute("aria-label", "Atlas, thinking");
        // See LIVE_WATCHDOG_MS above: a last-resort guarantee this session
        // (and the karaoke loop it feeds) can't run forever if it never
        // reaches "ended" or "error" on its own.
        l.watchdog = setTimeout(() => {
            if (live !== l || l.closed) return;
            console.warn("[atlas-avatar] live turn watchdog: forcing cleanup after", LIVE_WATCHDOG_MS, "ms with no end signal");
            endLive();
        }, LIVE_WATCHDOG_MS);

        const ms = new MS();
        l.ms = ms;
        l.objectUrl = URL.createObjectURL(ms);
        liveVideo.src = l.objectUrl;
        ms.addEventListener("sourceopen", () => {
            if (l.closed) return;
            l.sb = ms.addSourceBuffer(STREAM_MIME);
            l.sb.addEventListener("updateend", () => { l.appending = false; pump(l); });
            pump(l);
        }, { once: true });

        return {
            push(b64) {
                if (l.closed) return;
                l.queue.push(b64ToBytes(b64));
                pump(l);
            },
            speaking() {
                if (l.closed) return;
                video.setAttribute("aria-label", "Atlas, speaking");
                setState("speaking");
                onPlay && onPlay();
            },
            end() {
                if (l.closed) return;
                l.ended = true;
                pump(l);
            },
            abort() { if (live === l) endLive(); },
            // For karaoke captions: where playback is now, and the media time
            // of the newest frame received (a chunk of words arriving now
            // will be heard at about that time).
            time() { return l.closed ? Infinity : liveVideo.currentTime; },
            edge() {
                const b = liveVideo.buffered;
                return b.length ? b.end(b.length - 1) : 0;
            },
            get closed() { return l.closed; },
        };
    }

    function pump(l) {
        if (l.closed || !l.sb || l.appending || l.sb.updating) return;
        if (l.queue.length) {
            l.appending = true;
            const chunk = l.queue.shift();
            try {
                l.sb.appendBuffer(chunk);
            } catch (err) {
                l.appending = false; // quota/decoder hiccup: drop the chunk, keep going
                // Diagnostic only (no behavior change): a browser/hardware
                // combo that can't actually decode this stream would show up
                // here as repeated errors. See agent-avatar.js's `ended`
                // listener comment above for the wider investigation.
                console.warn("[atlas-avatar] appendBuffer failed, dropping chunk:", err, "bytes:", chunk.byteLength);
                return;
            }
            if (!l.started) {
                l.started = true;
                liveVideo.play().catch((err) => {
                    console.warn("[atlas-avatar] liveVideo.play() rejected:", err);
                });
            }
            keepLive();
            return;
        }
        if (l.ended && l.ms.readyState === "open") {
            try { l.ms.endOfStream(); } catch (_) { /* already closed */ }
            // A turn whose video never arrived has nothing to play out.
            if (!l.started) endLive();
        }
    }

    function keepLive() {
        const b = liveVideo.buffered;
        if (!b.length) return;
        const edge = b.end(b.length - 1);
        if (edge - liveVideo.currentTime > MAX_LAG_S) liveVideo.currentTime = Math.max(0, edge - 0.25);
    }

    if (autoplay && !REDUCE_MOTION) playGreeting(); else showIdle();

    // Diagnostic only: whether this browser CLAIMS it can decode the live
    // stream. A `true` here that still fails to actually play (see the
    // `error` listener and the appendBuffer/play() logging above) is the
    // signature of a browser/hardware combo whose codec support is wrong,
    // not a code bug — this is what tells the two apart.
    const canSpeak = canStreamAnswers();
    console.debug("[atlas-avatar] canStreamAnswers():", canSpeak, STREAM_MIME);

    return {
        el: stage,
        canSpeak,
        startLive,
        // Stop whatever the face is saying and go back to listening. A live
        // turn ends outright (there is nothing to resume into).
        pause() {
            if (mode === "live") { endLive(); return; }
            if (mode === "greeting") showIdle();
        },
        idle() { if (mode === "live") endLive(); else if (mode === "greeting") showIdle(); },
        replay() { playGreeting(); },
        dispose() {
            endLive();
            liveVideo.remove();
            video.pause();
            video.removeAttribute("src");
            video.load();
            stage.remove();
        },
    };
}
