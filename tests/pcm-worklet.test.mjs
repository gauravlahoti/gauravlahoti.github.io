// The mic worklet's conversion to the Live API's input format (spec 71):
// 16 kHz, 16-bit, mono. A wrong rate or scale doesn't fail loudly: the
// model just hears chipmunk speech or silence, so pin it here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPcm16k, TARGET_RATE, FRAME_SAMPLES } from "../assets/js/pcm-worklet.js";

test("48 kHz input comes out at a third of the samples", () => {
    const out = toPcm16k(new Float32Array(480), 48000);
    assert.equal(out.length, 160);
});

test("full scale maps to the Int16 limits without overflow", () => {
    assert.deepEqual([...toPcm16k(new Float32Array(3).fill(1), 48000)], [32767]);
    assert.deepEqual([...toPcm16k(new Float32Array(3).fill(-1), 48000)], [-32768]);
    assert.deepEqual([...toPcm16k(new Float32Array(3).fill(2), 48000)], [32767]); // clipped
});

test("a 1 kHz tone keeps its frequency after downsampling", () => {
    const rate = 44100;
    const tone = Float32Array.from({ length: rate }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / rate));
    const out = toPcm16k(tone, rate);
    assert.ok(Math.abs(out.length - TARGET_RATE) <= 1);
    let crossings = 0;
    for (let i = 1; i < out.length; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) crossings++;
    assert.ok(Math.abs(crossings - 2000) <= 4, `crossings ${crossings}`);
});

test("chunked input matches one-shot input (no drift at chunk edges)", () => {
    const rate = 44100;
    const input = Float32Array.from({ length: 1280 }, (_, i) => Math.sin(i / 7));
    const whole = toPcm16k(input, rate);
    const carry = { pos: 0 };
    const parts = [];
    for (let i = 0; i < input.length; i += 128) parts.push(...toPcm16k(input.subarray(i, i + 128), rate, carry));
    assert.ok(Math.abs(parts.length - whole.length) <= 1);
});

test("a frame is 40 ms", () => {
    assert.equal(FRAME_SAMPLES / TARGET_RATE, 0.04);
});
