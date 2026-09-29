// Mic capture for the hands-free avatar conversation (spec 71). Runs in the
// AudioWorklet: takes the mic at the device's own rate (usually 48 kHz),
// averages it down to the 16 kHz 16-bit mono the Live API expects, and posts
// 40 ms frames (640 samples, 1280 bytes) to the page, which forwards them over
// the conversation's WebSocket. The conversion is a plain exported function
// so it can be tested without an audio device.

export const TARGET_RATE = 16000;
export const FRAME_SAMPLES = 640; // 40 ms at 16 kHz

// Float32 samples at `inRate` -> Int16 samples at 16 kHz. Each output sample
// averages the input samples it covers (a box filter), which keeps speech
// clean enough for transcription without a full resampler. `carry` holds
// the fractional position between calls so frame boundaries don't drift.
export function toPcm16k(input, inRate, carry = { pos: 0 }) {
    const step = inRate / TARGET_RATE;
    const out = [];
    let pos = carry.pos;
    while (pos + step <= input.length) {
        const start = Math.floor(pos);
        const end = Math.min(input.length, Math.floor(pos + step));
        let sum = 0;
        for (let i = start; i < end; i++) sum += input[i];
        const v = Math.max(-1, Math.min(1, end > start ? sum / (end - start) : input[start]));
        out.push(v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff));
        pos += step;
    }
    carry.pos = pos - input.length;
    return Int16Array.from(out);
}

if (typeof AudioWorkletProcessor === "function" && typeof registerProcessor === "function") {
    class Pcm16kProcessor extends AudioWorkletProcessor {
        constructor() {
            super();
            this.carry = { pos: 0 };
            this.buf = new Int16Array(FRAME_SAMPLES);
            this.fill = 0;
        }

        process(inputs) {
            const channel = inputs[0] && inputs[0][0];
            if (!channel) return true;
            const pcm = toPcm16k(channel, sampleRate, this.carry); // eslint-disable-line no-undef
            for (let i = 0; i < pcm.length; i++) {
                this.buf[this.fill++] = pcm[i];
                if (this.fill === FRAME_SAMPLES) {
                    const frame = this.buf.buffer.slice(0);
                    this.port.postMessage(frame, [frame]);
                    this.fill = 0;
                }
            }
            return true;
        }
    }
    registerProcessor("pcm16k", Pcm16kProcessor);
}
