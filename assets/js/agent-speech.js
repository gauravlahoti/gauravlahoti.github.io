// agent-speech.js — spoken-reply playback for the Atlas composer (spec #49).
//
// Mouth only: takes the reply text as it streams, splits it into sentence
// chunks, asks /api/agent-speak to synthesize each one, and plays the clips
// back in order. It never sends a chat turn and never touches the composer.
//
// Why chunks rather than one call at the end: synthesis runs at ~0.69x
// realtime, so a whole 12-second answer costs ~9s of silence before anything
// plays. Chunking means playback starts after the first sentence. Because
// 0.69 < 1, generation outruns playback, so a single in-flight request is
// enough to keep the queue fed — no parallel fetches, which would also spend
// the rate-limit bucket several times faster.
//
// Lazy-loaded: agent-widget.js only import()s this when the speaker is first
// switched on, so none of it ships in the initial page payload.

// The first chunk is the only latency a listener actually feels, so it is cut
// short on purpose (~2.4s to synthesize at this size). Later chunks run long
// to spend fewer rate-limit slots and sound less choppy.
const FIRST_CHUNK_MAX = 90;
const CHUNK_MAX = 320;
// Only guards against absurdly short clips ("Yes."); it must stay well under
// FIRST_CHUNK_MAX or a short opening sentence gets merged into the next one
// and the first-chunk latency win is lost.
const CHUNK_MIN = 20;

// A sentence ending: . ! or ? that is genuinely the end of a sentence.
//
// Two exclusions, both learned from the chunker mis-splitting real replies:
//   - the abbreviation list, so "e.g. networking" doesn't end a sentence;
//   - a single letter before the dot, which covers initials ("G. Lahoti") and
//     the second half of "e.g." that the list above doesn't catch.
const ABBREV = "e\\.g|i\\.e|etc|vs|approx|Mr|Mrs|Ms|Dr|Sr|Jr|St|No";
const SENTENCE_END_MID = new RegExp(`(?<!\\b(?:${ABBREV}))(?<![\\s(][A-Za-z])[.!?]+(?=\\s)`, "g");
const SENTENCE_END_FINAL = new RegExp(`(?<!\\b(?:${ABBREV}))(?<![\\s(][A-Za-z])[.!?]+(?=\\s|$)`, "g");

// `final` is load-bearing, not a nicety. Mid-stream the buffer ends wherever
// the last SSE delta happened to stop, so letting `$` count as a sentence
// boundary splits words in half — "e.g." arriving as "...first, e." made the
// chunker emit "e." and "g. networking..." as two separate clips. Only once
// the stream is done is the end of the buffer a real end of sentence.
function findSplit(text, limit, final) {
    const re = final ? SENTENCE_END_FINAL : SENTENCE_END_MID;
    let best = -1;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        const end = m.index + m[0].length;
        if (end > limit) break;
        best = end;   // take the last boundary that fits, to fill the chunk
    }
    if (best >= CHUNK_MIN) return best;

    // No usable sentence end. If we're already over the limit, fall back to
    // the last clause or word break so a long unpunctuated run still speaks.
    if (text.length <= limit) return -1;
    const window = text.slice(0, limit);
    const clause = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "));
    if (clause >= CHUNK_MIN) return clause + 1;
    const space = window.lastIndexOf(" ");
    return space >= CHUNK_MIN ? space : limit;
}

// Returns { speak, feed, flush, cancel, dispose }.
// `feed(delta)` accepts streaming text and emits chunks as they complete;
// `flush()` speaks whatever is left once the stream ends. `onStateChange`
// fires with "speaking" | "idle"; `onError(message)` fires once per turn on
// failure and is always followed by an "idle" state change.
export function initSpeaker({ apiUrl, sessionId, onStateChange, onError }) {
    let buffer = "";          // text received but not yet chunked
    let isFirstChunk = true;
    let queue = [];           // chunks awaiting synthesis
    let pumping = false;      // a synth+play loop is running
    let audio = null;         // the <audio> currently playing
    let objectUrl = null;
    let controller = null;    // aborts the in-flight synthesis fetch
    let disposed = false;
    let errored = false;      // one error message per turn, not one per chunk
    // Bumped by cancel(). A pump loop captures it on entry and bails the
    // moment it changes, which is what makes "stop" take effect while a
    // synthesis request is already in flight. A plain boolean can't do this:
    // cancel() is synchronous and would have to reset the flag before the
    // awaiting loop ever gets to read it.
    let generation = 0;

    function emitState(state) {
        if (!disposed && typeof onStateChange === "function") onStateChange(state);
    }

    function emitError(message) {
        if (errored || disposed) return;
        errored = true;
        if (typeof onError === "function") onError(message);
    }

    function releaseAudio() {
        if (audio) {
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
            audio = null;
        }
        if (objectUrl) {
            // Revoking is what lets the decoded clip be collected — a long
            // conversation would otherwise hold every reply it ever spoke.
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
        }
    }

    async function synthesize(text) {
        controller = new AbortController();
        try {
            const res = await fetch(apiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId, text }),
                signal: controller.signal,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                emitError((data && data.error) || "Couldn't speak that reply.");
                return null;
            }
            return (data && data.audio) || null;
        } catch (err) {
            if (!(err && err.name === "AbortError")) {
                emitError("Couldn't reach the voice service.");
            }
            return null;
        } finally {
            controller = null;
        }
    }

    function play(base64Wav) {
        return new Promise((resolve) => {
            let bytes;
            try {
                const binary = atob(base64Wav);
                bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            } catch (_) {
                resolve();
                return;
            }
            // A Blob URL rather than a data: URI — a 300KB base64 string in the
            // DOM is both slower to parse and awkward to revoke.
            objectUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
            audio = new Audio(objectUrl);
            const done = () => { releaseAudio(); resolve(); };
            audio.addEventListener("ended", done, { once: true });
            audio.addEventListener("error", done, { once: true });
            // Rejection here means the browser refused autoplay. The toggle is
            // only ever switched on by a click, so this should not happen —
            // resolving rather than throwing keeps the queue draining if it does.
            audio.play().catch(() => done());
        });
    }

    async function pump() {
        if (pumping) return;
        pumping = true;
        const mine = generation;
        emitState("speaking");
        try {
            while (queue.length && mine === generation && !disposed) {
                const text = queue.shift();
                const wav = await synthesize(text);
                if (mine !== generation || disposed) break;
                if (!wav) continue;  // this chunk failed; keep the rest going
                await play(wav);
            }
        } finally {
            pumping = false;
            if (!disposed && mine === generation) emitState("idle");
        }
    }

    function enqueue(text) {
        const trimmed = text.trim();
        if (!trimmed) return;
        queue.push(trimmed);
        isFirstChunk = false;
        pump();
    }

    function drain(final) {
        for (;;) {
            const limit = isFirstChunk ? FIRST_CHUNK_MAX : CHUNK_MAX;
            const at = findSplit(buffer, limit, final);
            if (at === -1) break;
            enqueue(buffer.slice(0, at));
            buffer = buffer.slice(at);
        }
        if (final && buffer.trim()) {
            enqueue(buffer);
            buffer = "";
        }
    }

    return {
        // Streaming entry point: called from the chat turn's onDelta.
        feed(delta) {
            if (disposed) return;
            buffer += delta;
            drain(false);
        },
        // Called from onDone — speaks the tail that never hit a boundary.
        flush() {
            if (disposed) return;
            drain(true);
        },
        // One-shot: speak a complete string that never streamed.
        speak(text) {
            if (disposed) return;
            buffer += text;
            drain(true);
        },
        // Stop now: aborts in-flight synthesis, drops the queue, kills audio.
        // Reset for the next turn, so this doubles as the per-turn cleanup.
        cancel() {
            generation += 1;
            queue = [];
            buffer = "";
            if (controller) controller.abort();
            releaseAudio();
            isFirstChunk = true;
            errored = false;
            emitState("idle");
        },
        dispose() {
            disposed = true;
            generation += 1;
            queue = [];
            buffer = "";
            if (controller) controller.abort();
            releaseAudio();
        },
    };
}
