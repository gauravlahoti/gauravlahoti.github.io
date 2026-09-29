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
// Live turns never skip speech. They used to jump to the newest frame
// whenever playback fell 1.2s behind, so "the face never lags the words".
// On a machine slow to start or decode the stream (reported on Windows)
// playback was behind the whole time, so every new chunk triggered another
// jump: the reply flashed through its captions in a second and only the last
// word was heard.
//
// The idle face before the first word is a different matter. The stream
// starts the moment the visitor sends, and idles on camera while the reply
// is written (3-6s). If playback starts late, or stutters, during that idle
// stretch, every word after it inherits the delay: a Windows laptop heard
// the avatar 6-10s after the server started speaking. So until the first
// word, playback is held near the newest frame, and when the first words
// arrive (the server sends captions ~1.5s ahead of the audio) it jumps to
// just before where they'll be heard. That drops only idle frames nobody
// has seen yet; nothing after the first word is ever skipped.
const IDLE_MAX_LAG_S = 0.8;     // how far behind the idle face may fall
const IDLE_SEEK_COOLDOWN_MS = 1500; // a seek needs a moment to settle before the next
const SPEECH_MARGIN_S = 0.35;   // land this far before the first spoken word
//
// Safety net for a live turn that stops making progress: no new chunk and
// no playback movement for this long. Re-armed on every chunk and every
// timeupdate, so a slow but moving turn is never cut off. It exists for a
// browser/hardware combo that can't actually decode this stream: captions
// still arrive (the server drives them), so the karaoke loop in
// agent-widget.js starts regardless, and its only exit is this session
// closing. A stuck video never reaches "ended", so without this the loop ran
// one requestAnimationFrame tick forever, reported as the site feeling laggy
// on a machine where the stream doesn't decode cleanly.
const LIVE_WATCHDOG_MS = 30_000;

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
    // Timing for the per-turn console line, and the progress that keeps the
    // watchdog from firing on a slow but healthy turn.
    liveVideo.addEventListener("playing", () => {
        if (mode === "live" && live && live.stats.playing === null) {
            live.stats.playing = Math.round(performance.now() - live.stats.t0);
            // A late start is exactly when the idle stretch has piled up.
            catchUp(live, true);
        }
    });
    liveVideo.addEventListener("waiting", () => { if (mode === "live" && live && live.started) live.stats.waits += 1; });
    liveVideo.addEventListener("timeupdate", () => {
        if (mode !== "live" || !live) return;
        armWatchdog(live);
        keepLive(live);
    });
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

    // "hearing" is the hands-free conversation's own state: the face is
    // live and the visitor has the floor (spec 71).
    const LABEL = { idle: "live", listening: "thinking", speaking: "speaking", hearing: "listening" };
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
        logTurn(l);
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
        const l = {
            queue: [], appending: false, started: false, ended: false, closed: false, objectUrl: null, sb: null, ms: null, watchdog: null,
            speechStarted: false, speechAt: null, lastSeekAt: 0, lastTrim: 0,
            stats: { t0: performance.now(), firstChunk: null, playing: null, waits: 0, maxLag: 0, bytes: 0, chunks: 0, idleSkips: 0, idleSkippedS: 0 },
        };
        live = l;
        setState("listening");
        video.setAttribute("aria-label", "Atlas, thinking");
        armWatchdog(l);

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

        const handle = {
            push(b64) { handle.pushBytes(b64ToBytes(b64)); },
            pushBytes(bytes) {
                if (l.closed) return;
                if (l.stats.firstChunk === null) l.stats.firstChunk = Math.round(performance.now() - l.stats.t0);
                l.stats.chunks += 1;
                l.stats.bytes += bytes.byteLength;
                l.queue.push(bytes);
                armWatchdog(l);
                pump(l);
            },
            // `speechAt`: the media time the first spoken word will be heard
            // (from its caption). Everything before it is idle face.
            speaking(speechAt) {
                if (l.closed) return;
                l.speechAt = Number.isFinite(speechAt) ? speechAt : null;
                catchUp(l, true);
                l.speechStarted = true;
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
            // --- hands-free conversation (spec 71): one stream, many turns --
            // Talking over the avatar: jump to the newest frame. Skipping is
            // right here, the visitor asked it to stop.
            interrupt() {
                if (l.closed) return;
                const b = liveVideo.buffered;
                if (b.length) liveVideo.currentTime = Math.max(liveVideo.currentTime, b.end(b.length - 1) - 0.1);
                handle.newTurn();
            },
            // A turn ended: the idle face before the next answer may be
            // skipped again (see catchUp), never the answer itself.
            newTurn() {
                l.speechStarted = false;
                l.speechAt = null;
            },
            // The conversation's own states on the tag.
            convoState(state) {
                if (l.closed) return;
                const internal = { listening: "hearing", thinking: "listening", speaking: "speaking" }[state];
                if (!internal) return;
                setState(internal);
                video.setAttribute("aria-label", `Atlas, ${LABEL[internal]}`);
            },
        };
        return handle;
    }

    function pump(l) {
        if (l.closed || !l.sb || l.appending || l.sb.updating) return;
        if (l.pendingTrim) {
            const upTo = l.pendingTrim;
            l.pendingTrim = 0;
            try { l.appending = true; l.sb.remove(0, upTo); return; } catch (_) { l.appending = false; }
        }
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
            keepLive(l);
            trimPlayed(l);
            return;
        }
        if (l.ended && l.ms.readyState === "open") {
            try { l.ms.endOfStream(); } catch (_) { /* already closed */ }
            // A turn whose video never arrived has nothing to play out.
            if (!l.started) endLive();
        }
    }

    // Never discards unheard speech. It crosses a gap *before* the first
    // frame (a stream whose first fragment doesn't start at 0 would otherwise
    // wait there forever), and keeps the idle face live (see catchUp).
    function keepLive(l) {
        const b = liveVideo.buffered;
        if (!b.length) return;
        if (liveVideo.currentTime < b.start(0) - 0.05) liveVideo.currentTime = b.start(0);
        const lag = b.end(b.length - 1) - liveVideo.currentTime;
        if (lag > l.stats.maxLag) l.stats.maxLag = lag;
        if (lag > IDLE_MAX_LAG_S) catchUp(l, false);
    }

    // Skip idle frames only: never past the first spoken word. `force`
    // ignores the cooldown, for the two moments that matter most (playback
    // finally starting, and the first words arriving). Once playback has
    // reached the first word, or speech began without a known start, it
    // never seeks again.
    function catchUp(l, force) {
        if (l.speechStarted && l.speechAt === null) return;
        if (l.speechAt !== null && liveVideo.currentTime >= l.speechAt - SPEECH_MARGIN_S) return;
        const b = liveVideo.buffered;
        if (!b.length) return;
        const now = performance.now();
        if (!force && now - l.lastSeekAt < IDLE_SEEK_COOLDOWN_MS) return;
        let target = b.end(b.length - 1) - 0.15;
        if (l.speechAt !== null) target = Math.min(target, l.speechAt - SPEECH_MARGIN_S);
        const from = liveVideo.currentTime;
        if (target - from < 0.3) return;
        liveVideo.currentTime = target;
        l.lastSeekAt = now;
        l.stats.idleSkips += 1;
        l.stats.idleSkippedS += target - from;
    }

    // A conversation can stream for minutes: drop what has already played,
    // keeping ten seconds behind the playhead, so the buffer never fills.
    function trimPlayed(l) {
        const now = performance.now();
        if (now - l.lastTrim < 10_000 || liveVideo.currentTime < 20) return;
        l.lastTrim = now;
        const upTo = liveVideo.currentTime - 10;
        const b = liveVideo.buffered;
        if (!b.length || b.start(0) >= upTo) return;
        l.pendingTrim = upTo; // applied by pump once the buffer is idle
    }

    function armWatchdog(l) {
        if (l.watchdog) clearTimeout(l.watchdog);
        l.watchdog = setTimeout(() => {
            if (live !== l || l.closed) return;
            console.warn("[atlas-avatar] live turn watchdog: no progress for", LIVE_WATCHDOG_MS, "ms, forcing cleanup");
            endLive();
        }, LIVE_WATCHDOG_MS);
    }

    // One line per live turn, so a slow or silent turn on a machine we can't
    // reach can be read from its console: when the first video arrived
    // (server + network), when it began playing (this machine's decoder), how
    // often playback starved, and how far behind it ran.
    function logTurn(l) {
        const s = l.stats;
        if (!s.chunks) return;
        console.info("[atlas-avatar] turn:", JSON.stringify({
            firstVideoMs: s.firstChunk,
            playingMs: s.playing,
            startDelayMs: s.playing === null ? null : s.playing - s.firstChunk,
            idleSkips: s.idleSkips,
            idleSkippedS: Math.round(s.idleSkippedS * 100) / 100,
            stalls: s.waits,
            maxLagS: Math.round(s.maxLag * 100) / 100,
            chunks: s.chunks,
            kb: Math.round(s.bytes / 1024),
            totalMs: Math.round(performance.now() - s.t0),
        }));
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
