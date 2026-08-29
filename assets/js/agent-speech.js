// agent-speech.js — spoken-reply playback for the Atlas composer (spec #50).
//
// Mouth only: takes the reply text as it streams, splits it into sentence
// chunks, asks /api/agent-speak to synthesize each one, and plays the clips
// back-to-back. It never sends a chat turn and never touches the composer.
//
// # Why this is built the way it is
//
// Synthesis runs at a measured ~0.69x realtime (39 chars -> 3.48s of audio in
// 2.39s; 171 chars -> 12.64s in 9.26s). Two consequences drive the whole
// design.
//
// 1. Generation is *faster* than playback, so a producer running ahead of a
//    consumer can keep the queue fed indefinitely. Spec 49 claimed to do this
//    but its pump() awaited synthesize() and then play() in one loop, so the
//    next chunk only started once the previous had finished *playing* — 2-4
//    seconds of dead air between every clip. That is what made it sound like
//    it was reading word by word. The producer/consumer split below is the fix.
//
// 2. Chunk sizes must *ramp*, not sit at a constant. For playback never to
//    starve, chunk N+1 must synthesize faster than chunk N plays:
//    0.69 * dur(N+1) <= dur(N), so each chunk can be at most ~1.45x the last
//    with one request in flight (more with LOOKAHEAD 2). A flat "just use big
//    chunks" would starve badly right after a short opener — 600 chars is ~44s
//    of audio and ~30s of synthesis.
//
// Playback goes through Web Audio rather than <audio> elements. Prefetching
// alone is not enough: new Audio().play() has a variable start delay, so
// clips would still join unevenly. decodeAudioData + source.start(when) with
// an accumulated start time is sample-accurate, so consecutive chunks butt
// together with no gap at all.
//
// Lazy-loaded: agent-widget.js only import()s this when the speaker is first
// switched on, so none of it ships in the initial page payload.

// Chunk size ramp, in characters. The first is small so speech starts fast
// (~1.4s to synthesize); later ones grow because every chunk boundary is a
// prosody reset — the model synthesizes each in isolation — so fewer, longer
// chunks sound markedly more natural. Growth stays under the ~1.45x-per-chunk
// ceiling the starvation rule allows. Capped at the last value.
const CHUNK_RAMP = [36, 140, 240, 350];

// How far past a ramp limit we will wait for a *natural* boundary before
// giving up and breaking on a bare word. Splitting mid-sentence is the one
// thing that reliably sounds wrong — an early build cut the opening at 45
// chars and produced "Gaurav has spent about eight years at" / "Deloitte."
// as two clips. Waiting a little longer for a comma or a full stop is worth
// more than shaving a few hundred milliseconds off the start.
const NATURAL_BOUNDARY_SLACK = 1.6;

// Only guards against absurdly short clips ("Yes."). Must stay well under the
// first ramp step or a short opening sentence gets merged into the next one
// and the fast-start win is lost.
const CHUNK_MIN = 20;

// How many chunks may be synthesized ahead of playback. 2 gives comfortable
// headroom against the starvation rule without multiplying rate-limit spend
// or per-minute Vertex quota pressure the way unbounded parallelism would.
const LOOKAHEAD = 2;

// Scheduling cushion. When starting a fresh run (or recovering from a starve)
// the first buffer is scheduled this far ahead of currentTime so the decode
// and graph wiring land before playback reaches them.
const START_LEAD_S = 0.06;

// Measured: text runs at ~13.5 characters per second of synthesized speech.
const CHARS_PER_SEC_OF_SPEECH = 13.5;

// Synthesis costs ~0.69x the audio duration (measured).
const SYNTH_RATIO = 0.69;

// Safety margin on top of the estimated synthesis time, covering network
// round-trip, decode, and the model's own variance.
const RUNWAY_MARGIN_S = 1.0;

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

    // No sentence end fits. A clause break is the next most natural place to
    // breathe, so take one if there is one inside the limit.
    const window = text.slice(0, limit);
    const clause = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "));
    if (clause >= CHUNK_MIN) return clause + 1;

    // Nothing natural yet. Keep waiting for more text rather than breaking
    // mid-sentence — but only up to a point, so a long unpunctuated run still
    // eventually speaks.
    const hardLimit = Math.round(limit * NATURAL_BOUNDARY_SLACK);
    if (!final && text.length <= hardLimit) return -1;
    if (final && text.length <= limit) return -1;

    const wide = text.slice(0, hardLimit);
    const lateClause = Math.max(wide.lastIndexOf(", "), wide.lastIndexOf("; "));
    if (lateClause >= CHUNK_MIN) return lateClause + 1;
    const space = wide.lastIndexOf(" ");
    return space >= CHUNK_MIN ? space : hardLimit;
}

function base64ToArrayBuffer(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

// Returns { speak, feed, flush, cancel, dispose, unlock }.
//
// `feed(delta)` accepts streaming text and emits chunks as they complete;
// `flush()` speaks whatever is left once the stream ends; `unlock()` must be
// called from inside a real click handler to satisfy autoplay policy.
// `onStateChange` fires with "speaking" | "idle"; `onPlaying()` fires when
// audio genuinely starts; `onError(message)` fires once per turn on failure
// and is always followed by an "idle" state change.
export function initSpeaker({ apiUrl, sessionId, onStateChange, onError, onPlaying, onChunkScheduled }) {
    let buffer = "";          // text received but not yet chunked
    let chunkIndex = 0;       // position in CHUNK_RAMP for the current turn
    let pending = [];         // {seq, text} awaiting synthesis
    // Decoded buffers keyed by sequence number, plus the next sequence that
    // may be scheduled. Synthesis runs LOOKAHEAD-wide in parallel and
    // completes out of order — a short chunk finishes before a long one sent
    // earlier — so buffers MUST be released in sequence or the reply is
    // spoken with its sentences shuffled.
    let decoded = new Map();
    let seqCounter = 0;
    let nextSeq = 0;
    let inFlight = 0;         // synthesis requests outstanding
    let producing = false;
    let disposed = false;
    let errored = false;      // one error message per turn, not one per chunk
    let announcedPlaying = false;
    let controllers = new Set();   // abortable in-flight fetches
    let sources = new Set();       // scheduled AudioBufferSourceNodes
    let nextStartTime = 0;         // accumulated schedule cursor, in ctx time
    let scheduledCount = 0;
    let finalised = false;         // flush() called: no more text is coming

    // Bumped by cancel(). Loops capture it on entry and bail the moment it
    // changes, which is what makes "stop" take effect while a synthesis
    // request is already in flight. A plain boolean cannot do this: cancel()
    // is synchronous and would have to reset the flag before the awaiting
    // loop ever got to read it.
    let generation = 0;

    let ctx = null;
    let gain = null;

    function emitState(state) {
        if (!disposed && typeof onStateChange === "function") onStateChange(state);
    }

    function emitError(message) {
        if (errored || disposed) return;
        errored = true;
        if (typeof onError === "function") onError(message);
    }

    // Creating and resuming the AudioContext inside a click handler is what
    // banks the user gesture for the whole page session. The first synthesized
    // clip arrives 1-2s later, long after the activation window closes, so
    // without this Safari and iOS refuse to play it.
    function unlock() {
        if (disposed) return;
        if (!ctx) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) return;
            ctx = new Ctor();
            gain = ctx.createGain();
            gain.connect(ctx.destination);
        }
        if (ctx.state === "suspended") ctx.resume().catch(() => { /* best effort */ });
    }

    async function synthesize(text) {
        const controller = new AbortController();
        controllers.add(controller);
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
            controllers.delete(controller);
        }
    }

    // Schedules one decoded buffer to start exactly where the previous one
    // ended. `nextStartTime` is the whole trick: because it accumulates real
    // buffer durations rather than being recomputed from the clock, clips join
    // sample-accurately instead of drifting apart by however long each
    // play() call happened to take.
    function schedule(audioBuffer, text) {
        if (disposed) return;
        // Should never happen — unlock() runs from the click that enables the
        // speaker — but dropping audio silently because a context was missing
        // is exactly the class of failure spec 50 exists to stop.
        if (!ctx) unlock();
        if (!ctx) { emitError("Audio isn't available in this browser."); return; }
        const now = ctx.currentTime;
        // Starved (or starting fresh): the cursor is in the past, so pull it
        // forward. This is the only place a gap can appear.
        if (nextStartTime < now + START_LEAD_S) nextStartTime = now + START_LEAD_S;

        // Spec 55: this is the exact schedule a text-reveal queue needs to
        // pace words against the voice — the same cursor and duration that
        // drive playback itself, not a second, independently-guessed timing.
        if (typeof onChunkScheduled === "function") {
            onChunkScheduled({ text, ctxNow: now, ctxStartAt: nextStartTime, durationSec: audioBuffer.duration });
        }

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(gain);
        source.start(nextStartTime);
        sources.add(source);
        scheduledCount += 1;

        const mine = generation;
        source.onended = () => {
            sources.delete(source);
            source.disconnect();
            if (mine !== generation || disposed) return;
            // Run finished: nothing scheduled, nothing queued, no more coming.
            if (!sources.size && !decoded.size && !pending.length && !inFlight && finalised) {
                emitState("idle");
            }
        };

        if (!announcedPlaying) {
            announcedPlaying = true;
            // Fire when audio genuinely begins, not when it was merely
            // requested — the two are seconds apart and the status line needs
            // to tell them apart.
            const delayMs = Math.max(0, (nextStartTime - now) * 1000);
            setTimeout(() => {
                if (mine === generation && !disposed && typeof onPlaying === "function") onPlaying();
            }, delayMs);
        }

        nextStartTime += audioBuffer.duration;
    }

    // Producer: keeps up to LOOKAHEAD requests outstanding, independent of
    // whatever playback is doing. This is the half spec 49 was missing.
    async function produce() {
        if (producing) return;
        producing = true;
        const mine = generation;
        try {
            while (mine === generation && !disposed) {
                if (!pending.length || inFlight >= LOOKAHEAD) break;
                const { seq, text } = pending.shift();
                inFlight += 1;
                // Deliberately not awaited: several may be in flight at once,
                // which is the point.
                (async () => {
                    const b64 = await synthesize(text);
                    inFlight -= 1;
                    if (mine !== generation || disposed) return;
                    let buf = null;
                    if (b64) {
                        if (!ctx) unlock();
                        try {
                            buf = ctx ? await ctx.decodeAudioData(base64ToArrayBuffer(b64)) : null;
                        } catch (_) {
                            emitError("Couldn't decode the audio.");
                        }
                    }
                    if (mine !== generation || disposed) return;
                    // Recorded even when null, so drainReady() can skip past a
                    // failed chunk instead of stalling the whole reply on it.
                    decoded.set(seq, { buf, text });
                    drainReady();
                    produce();
                    settleIfDone();
                })();
            }
        } finally {
            producing = false;
        }
    }

    // Releases buffers strictly in sequence. A chunk that failed to
    // synthesize is stored as null so it is skipped rather than blocking
    // every later chunk behind it forever.
    function drainReady() {
        while (decoded.has(nextSeq)) {
            const { buf, text } = decoded.get(nextSeq);
            decoded.delete(nextSeq);
            nextSeq += 1;
            if (buf) {
                schedule(buf, text);
            } else if (typeof onChunkScheduled === "function") {
                // Synthesis failed for this chunk: no audio to schedule, but
                // the text still needs to surface so a reveal queue tied to
                // this callback doesn't stall on it forever.
                const ctxNow = ctx ? ctx.currentTime : 0;
                onChunkScheduled({
                    text,
                    ctxNow,
                    ctxStartAt: ctxNow,
                    durationSec: text.length / CHARS_PER_SEC_OF_SPEECH,
                });
            }
        }
    }

    function settleIfDone() {
        if (disposed) return;
        if (!sources.size && !decoded.size && !pending.length && !inFlight && finalised) {
            emitState("idle");
        }
    }

    function enqueue(text) {
        const trimmed = text.trim();
        if (!trimmed) return;
        pending.push({ seq: seqCounter++, text: trimmed });
        chunkIndex += 1;
        if (!scheduledCount && !announcedPlaying) emitState("speaking");
        produce();
    }

    // True when nothing is queued, in flight, or sounding — i.e. the listener
    // is sitting in silence right now.
    function starving() {
        return !pending.length && !inFlight && !sources.size && !decoded.size;
    }

    // Seconds of audio already scheduled but not yet played, plus a rough
    // estimate for everything still queued or in flight. This is the runway
    // the producer has to work with. Text runs at ~13.5 characters per second
    // of speech (measured), and synthesis costs ~0.69x the audio duration.
    // How long chunk of `chars` will take to synthesize, from the measured
    // characters-per-second-of-speech and synthesis ratio.
    function synthCostSec(chars) {
        return (chars / CHARS_PER_SEC_OF_SPEECH) * SYNTH_RATIO;
    }

    function runwaySec() {
        const scheduledLeft = ctx ? Math.max(0, nextStartTime - ctx.currentTime) : 0;
        let queuedChars = 0;
        pending.forEach((c) => { queuedChars += c.text.length; });
        return scheduledLeft + queuedChars / CHARS_PER_SEC_OF_SPEECH;
    }

    function drain(final) {
        for (;;) {
            const limit = CHUNK_RAMP[Math.min(chunkIndex, CHUNK_RAMP.length - 1)];

            // Emit at the first natural boundary only when the listener would
            // otherwise be waiting in silence; the rest of the time, let the
            // buffer fill to the ramp limit first. Without this the chunker
            // fires on every sentence as it arrives and a reply comes out as
            // eight short clips instead of four long ones — every boundary is
            // a prosody reset, so fewer and longer is markedly more natural.
            // Fill the chunk for prosody when there is runway to spare; emit
            // at the first natural boundary when there is not. Filling alone
            // starves (a 130-char chunk needs ~6.6s to synthesize while a
            // 47-char opener only plays for 3.5s); emitting alone produces
            // eight short clips where four long ones sound better.
            // The threshold is the next chunk's own synthesis cost, not a
            // flat number: waiting to fill a 240-char chunk is only safe if
            // there is more than ~12s of audio still ahead of it. A constant
            // either starves on the long chunks or leaves the short ones
            // needlessly fragmented.
            //
            // This errs towards emitting. More chunks means more seams, but
            // seams land on sentence boundaries — where a speaker would pause
            // anyway — while starving means audible dead air, which is the
            // thing this spec exists to remove. Safety wins.
            if (!final && !starving() && buffer.length < limit
                && runwaySec() > synthCostSec(limit) + RUNWAY_MARGIN_S) break;

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

    function stopAll() {
        controllers.forEach((c) => { try { c.abort(); } catch (_) { /* ignore */ } });
        controllers.clear();
        sources.forEach((s) => {
            try { s.onended = null; s.stop(); s.disconnect(); } catch (_) { /* ignore */ }
        });
        sources.clear();
        pending = [];
        decoded.clear();
        seqCounter = 0;
        nextSeq = 0;
        buffer = "";
        inFlight = 0;
        scheduledCount = 0;
        nextStartTime = 0;
        announcedPlaying = false;
        finalised = false;
        chunkIndex = 0;
        errored = false;
    }

    return {
        unlock,

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
            finalised = true;
            settleIfDone();
        },

        // One-shot: speak a complete string that never streamed.
        speak(text) {
            if (disposed) return;
            buffer += text;
            drain(true);
            finalised = true;
        },

        // Stop now: aborts in-flight synthesis, drops the queue, silences
        // anything scheduled. Resets for the next turn, so this doubles as
        // the per-turn cleanup.
        cancel() {
            generation += 1;
            if (gain && ctx) {
                // A short ramp instead of a hard cut — stopping a buffer
                // mid-sample otherwise clicks audibly.
                try {
                    const now = ctx.currentTime;
                    gain.gain.cancelScheduledValues(now);
                    gain.gain.setValueAtTime(gain.gain.value, now);
                    gain.gain.linearRampToValueAtTime(0.0001, now + 0.04);
                    setTimeout(() => {
                        if (!gain || !ctx) return;
                        gain.gain.cancelScheduledValues(ctx.currentTime);
                        gain.gain.setValueAtTime(1, ctx.currentTime);
                    }, 60);
                } catch (_) { /* ignore */ }
            }
            stopAll();
            emitState("idle");
        },

        dispose() {
            disposed = true;
            generation += 1;
            stopAll();
            if (ctx) {
                try { ctx.close(); } catch (_) { /* ignore */ }
                ctx = null;
                gain = null;
            }
        },
    };
}
