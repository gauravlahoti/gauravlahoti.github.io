// Chunker/producer simulation for assets/js/agent-speech.js (spec #62).
//
// Run: node --test tests/agent-speech.chunker.test.mjs
//
// No dependencies, no bundler, no npm install — Node's built-in test runner
// against the real module, which Node loads as ESM by syntax detection.
//
// # Why a simulation and not unit assertions
//
// The bug this guards against is a *ratchet*, and a ratchet is invisible to
// any single-call assertion. drain() would emit one reasonable chunk, then a
// slightly smaller one, then smaller again, because each undersized chunk
// bought back less runway than it needed to be emitted in the first place.
// Every individual decision looked defensible. Only the trajectory was wrong,
// and only on replies long enough to reach the top of the chunk ramp — which
// is why short smoke tests never caught it and long spoken answers stuttered.
//
// So the test drives the real producer/consumer loop against a virtual clock
// and a synthesis latency model taken from the measurements in the module
// header, then asserts on the whole run: chunk sizes, chunk count, and gaps
// between scheduled clips.

import test from "node:test";
import assert from "node:assert/strict";

import { findSplit, initSpeaker } from "../assets/js/agent-speech.js";

// Mirrors of the module's own constants. Deliberately duplicated rather than
// exported: if someone retunes the module, these stop matching and the test
// fails loudly, which is the conversation worth having.
const CHARS_PER_SEC_OF_SPEECH = 13.5;
const SPEECH_RATE = 1.1;
const EMIT_FLOOR = 140;
const EMIT_FLOOR_RATIO = 0.6;
const CHUNK_RAMP = [70, 120, 200, 300, 350];
const RAMP_MAX = CHUNK_RAMP[CHUNK_RAMP.length - 1];

// Measured in spec 50: 39 chars -> 2.39s, 171 chars -> 9.26s.
const SYNTH_FIXED_S = 0.36;
const SYNTH_PER_CHAR_S = 0.0521;
const synthLatency = (chars) => SYNTH_FIXED_S + chars * SYNTH_PER_CHAR_S;

// Roughly what Gemini streams at. Text arrives several times faster than
// speech consumes it, which is the condition the producer is designed around.
const TEXT_CHARS_PER_SEC = 80;

const flush = () => new Promise((resolve) => setImmediate(resolve));

// setTimeout in schedule() fires the onPlaying callback minutes of virtual
// time later. Left alone those pending timers keep the runner alive after the
// assertions have passed, so hand back unref'd handles.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
    const handle = realSetTimeout(fn, ms, ...rest);
    if (handle && typeof handle.unref === "function") handle.unref();
    return handle;
};

class Clock {
    constructor() {
        this.now = 0;
        this.timers = [];
    }

    after(dt, fn) {
        this.timers.push({ at: this.now + dt, fn });
    }

    // Runs every timer due at or before `to`, letting promise callbacks settle
    // between each so the module's async chains actually advance.
    async advanceTo(to) {
        for (;;) {
            this.timers.sort((a, b) => a.at - b.at);
            if (!this.timers.length || this.timers[0].at > to) break;
            const next = this.timers.shift();
            this.now = next.at;
            next.fn();
            await flush();
        }
        this.now = to;
        await flush();
    }
}

function makeContext(clock, scheduled) {
    let prevEnd = null;
    return {
        state: "running",
        destination: {},
        get currentTime() { return clock.now; },
        createGain: () => ({
            connect() {},
            gain: {
                value: 1,
                setValueAtTime() {},
                linearRampToValueAtTime() {},
                cancelScheduledValues() {},
            },
        }),
        createBufferSource: () => ({
            buffer: null,
            playbackRate: { value: 1 },
            onended: null,
            connect() {},
            disconnect() {},
            stop() {},
            start(when) {
                const duration = this.buffer.duration / SPEECH_RATE;
                scheduled.push({
                    when,
                    duration,
                    gap: prevEnd === null ? 0 : when - prevEnd,
                });
                prevEnd = when + duration;
            },
        }),
        // One byte of payload per character of text, so duration tracks the
        // real chars-per-second-of-speech relationship.
        decodeAudioData: async (buf) => ({
            duration: buf.byteLength / CHARS_PER_SEC_OF_SPEECH,
        }),
        resume: async () => {},
        close: async () => {},
    };
}

// Drives a full reply through the real speaker and returns what it did.
async function runReply(reply) {
    const clock = new Clock();
    const chunks = [];
    const scheduled = [];
    const errors = [];

    globalThis.fetch = (_url, opts) => {
        const { text } = JSON.parse(opts.body);
        chunks.push(text);
        return new Promise((resolve) => {
            clock.after(synthLatency(text.length), () => resolve({
                ok: true,
                json: async () => ({ audio: btoa("x".repeat(text.length)) }),
            }));
        });
    };

    const ctx = makeContext(clock, scheduled);
    const speaker = initSpeaker({
        apiUrl: "https://example.test/api/agent-speak",
        sessionId: "sim",
        audioContext: ctx,
        onError: (m) => errors.push(m),
    });

    // Stream the reply in SSE-sized deltas at a realistic token rate.
    for (let i = 0; i < reply.length; i += 15) {
        const delta = reply.slice(i, i + 15);
        await clock.advanceTo(clock.now + delta.length / TEXT_CHARS_PER_SEC);
        speaker.feed(delta);
        await flush();
    }
    speaker.flush();
    await flush();

    // Let every outstanding synthesis land.
    await clock.advanceTo(clock.now + 300);

    speaker.dispose();
    return { chunks, scheduled, errors };
}

// ~1,300 characters of plausible reply. Sentences vary in length so the
// chunker faces real boundary choices rather than a uniform grid.
const LONG_REPLY = [
    "Gaurav built this entire portfolio platform himself, spec-driven with Claude Code.",
    "Every feature starts as a written specification with a clear definition of done.",
    "It is then implemented against that spec and checked back against it before merging.",
    "Specs are append-only, so an old one is never rewritten to match what happened later.",
    "If the approach changes, that becomes a new spec instead.",
    "The result is a readable trail of why things are the way they are, reversals included.",
    "A reviewer agent checks correctness, style, security and the project conventions.",
    "It keeps persistent notes on the repo, so recurring mistakes get caught by name.",
    "The routine parts of the workflow stopped being manual very early on.",
    "Scaffolding, implementing and merging all run as automated workflows now.",
    "Jobs he found himself repeating became reusable skills that live in the repo.",
    "There is no build step anywhere in the project, and no bundler and no npm.",
    "Clone the repository, run a static file server, and the whole site is running.",
    "All of the content lives in JSON files rather than being baked into the markup.",
    "The agent reads those same files live, so a content edit needs no redeploy.",
].join(" ");

test("long reply grows into large chunks and does not decay", async () => {
    const { chunks, errors } = await runReply(LONG_REPLY);

    assert.deepEqual(errors, [], "synthesis should not have errored");
    assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`);

    const sizes = chunks.map((c) => c.length);

    // The opener is deliberately small (fast start) and the final flush speaks
    // whatever is left, so neither is held to the floor. Everything between
    // them is the steady state, and the steady state is what used to decay.
    //
    // Each chunk is judged against its own ramp step, the way the module's
    // floor is, not against a flat number — chunk 1's limit is 120, so a
    // 110-char clip there is healthy while the same size at the 350 step
    // would mean the producer had given up.
    sizes.slice(1, -1).forEach((n, i) => {
        const limit = CHUNK_RAMP[Math.min(i + 1, CHUNK_RAMP.length - 1)];
        const floor = Math.min(EMIT_FLOOR, Math.round(limit * EMIT_FLOOR_RATIO));
        assert.ok(
            n >= floor,
            `chunk ${i + 1} collapsed to ${n} chars, floor ${floor} at limit `
            + `${limit}: ${JSON.stringify(sizes)}`,
        );
    });

    // The actual shape of the bug: chunk sizes trending DOWN over the reply.
    // Comparing the back half against the front half catches that regardless
    // of how the ramp is retuned later, which a fixed size bound would not.
    const half = Math.floor(sizes.length / 2);
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    assert.ok(
        mean(sizes.slice(half)) > mean(sizes.slice(0, half)),
        `chunk sizes trended downward over the reply: ${JSON.stringify(sizes)}`,
    );
});

test("long reply is spoken in few, large chunks", async () => {
    const { chunks } = await runReply(LONG_REPLY);

    // Every boundary is a prosody reset, and every chunk is a rate-limited
    // /api/agent-speak call. Before the fix this reply fragmented well past
    // this bound. The ceiling is what the ramp can justify plus slack.
    const ceiling = Math.ceil(LONG_REPLY.length / RAMP_MAX) + 3;
    assert.ok(
        chunks.length <= ceiling,
        `expected <= ${ceiling} chunks for ${LONG_REPLY.length} chars, got ${chunks.length}: `
        + JSON.stringify(chunks.map((c) => c.length)),
    );

    // Nothing may exceed the hard boundary the splitter is allowed to reach.
    for (const c of chunks) {
        assert.ok(
            c.length <= Math.round(RAMP_MAX * 1.6),
            `chunk over the hard limit at ${c.length} chars`,
        );
    }
});

test("playback never starves mid-reply", async () => {
    const { scheduled } = await runReply(LONG_REPLY);

    assert.ok(scheduled.length >= 3, "expected several clips scheduled");

    // A gap here is literal silence: schedule() pulls nextStartTime forward
    // when the cursor has fallen behind the clock, which is the one and only
    // place dead air can enter the stream. The first clip is excluded — its
    // "gap" is just the initial synthesis wait, not a starve.
    //
    // The bound is 1.5s rather than zero. Perfect coverage from a cold start
    // is not reachable without delaying the first word further than it is
    // worth: early on there is no queue to parallelize, so the opener alone
    // has to cover the next chunk's whole synthesis. This ramp measures at
    // ~0.8s; the old one measured at ~4.1s, and at ~6.1s under latency
    // stress. The point of the bound is to catch a return to that regime.
    const gaps = scheduled.slice(1).map((s) => s.gap);
    const worst = Math.max(...gaps);
    assert.ok(
        worst < 1.5,
        `playback starved: worst gap ${worst.toFixed(2)}s across ${gaps.length} seams`,
    );
});

test("short reply still starts fast", async () => {
    const { chunks } = await runReply(
        "Gaurav holds all four of Anthropic's certifications. "
        + "The largest thing he built with them is the site you are on.",
    );

    assert.ok(chunks.length >= 1);
    // The fast-start opener must stay small, or the first word is late. The
    // emit floor explicitly exempts chunk 0 for exactly this reason.
    assert.ok(
        chunks[0].length < EMIT_FLOOR,
        `opener should be small for fast start, was ${chunks[0].length} chars`,
    );
    // A two-sentence answer is the common case, and it must not fragment.
    assert.ok(
        chunks.length <= 3,
        `short reply fragmented into ${chunks.length}: ${JSON.stringify(chunks.map((c) => c.length))}`,
    );
});

test("findSplit prefers the last sentence end that fits", () => {
    const text = "One sentence here. Another sentence here. A third one here.";
    assert.equal(findSplit(text, 45, false), "One sentence here. Another sentence here.".length);
});

test("findSplit does not break on abbreviations or initials", () => {
    // Both of these produced real mis-splits: "e." / "g. networking" as two
    // clips, and a break after the initial in a name.
    assert.equal(findSplit("Works with e.g. networking gear and more", 30, false), -1);
    assert.equal(findSplit("Written by G. Lahoti in the repo", 25, false), -1);
});

test("findSplit waits rather than cutting mid-sentence", () => {
    // Mid-stream, the end of the buffer is wherever the delta stopped, not a
    // sentence end. Returning a split here is what cut "...eight years at" /
    // "Deloitte." into two clips.
    assert.equal(findSplit("Gaurav has spent about eight years at", 45, false), -1);
});
