// Hands-free avatar conversation, browser side (spec 71). Lazy-loaded by
// agent-widget.js only when a visitor presses "Start conversation".
//
// Streams the mic (through pcm-worklet.js, 16 kHz PCM16 in 40 ms frames) to
// /api/agent-live over one WebSocket, and hands back what comes the other
// way: binary frames are the avatar's fMP4 video, text frames are JSON events
// (state, userWords, words, interrupted, turnEnd, end). A WebSocket, not SSE,
// because an inspection proxy on a corporate laptop held SSE streams back and
// released them in bursts, while WebSocket frames came through live.

// Same ?v= cache-bust as the module that loaded this one.
const _selfV = new URL(import.meta.url).searchParams.get("v");
const WORKLET_URL = new URL(`./pcm-worklet.js${_selfV ? `?v=${_selfV}` : ""}`, import.meta.url);

export function liveSupported() {
    return !!(
        typeof WebSocket === "function" &&
        navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function" &&
        typeof window.AudioWorkletNode === "function" &&
        (window.AudioContext || window.webkitAudioContext)
    );
}

// Call from the click that starts the conversation: the mic prompt and the
// audio context both need that gesture. Resolves once the server has
// accepted the conversation (its first "state" event), or rejects with a
// readable reason.
export async function startLiveConversation({ url, sessionId, onEvent, onVideo, onEnd }) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
    } catch (err) {
        ctx.close().catch(() => {});
        throw new Error(err && err.name === "NotAllowedError"
            ? "Microphone access was blocked. Allow it in the browser to talk to Atlas."
            : "Couldn't open the microphone.");
    }
    await ctx.audioWorklet.addModule(WORKLET_URL.href);
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "pcm16k");
    source.connect(node); // not to the speakers: the visitor shouldn't hear themselves
    // Spec 73: how loud the visitor is, for the avatar's cyan ring.
    const meter = ctx.createAnalyser();
    meter.fftSize = 512;
    const meterBuf = new Float32Array(meter.fftSize);
    source.connect(meter);

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    let muted = false;
    let closed = false;

    const cleanup = () => {
        if (closed) return;
        closed = true;
        node.port.onmessage = null;
        try { source.disconnect(); node.disconnect(); meter.disconnect(); } catch (_) { /* already */ }
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        try { ws.close(); } catch (_) { /* already */ }
    };

    node.port.onmessage = (e) => {
        if (!muted && ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };

    return new Promise((resolve, reject) => {
        let accepted = false;
        let ended = false;
        const finish = (end) => {
            if (ended) return;
            ended = true;
            cleanup();
            if (!accepted) reject(new Error((end && end.reason) || "Couldn't start the conversation."));
            else onEnd(end || { reason: "The conversation ended.", capped: false });
        };
        const handle = {
            end() {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ end: true }));
                finish({ reason: "", capped: false });
            },
            mute(on) {
                muted = !!on;
                if (muted && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ mute: true }));
            },
            get muted() { return muted; },
            // 0..1, read once a frame by the avatar's ring (spec 73).
            level() {
                if (muted || closed) return 0;
                meter.getFloatTimeDomainData(meterBuf);
                let sum = 0;
                for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
                return Math.min(1, Math.sqrt(sum / meterBuf.length) * 6);
            },
            sendText(text) {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ text }));
            },
        };
        const timeout = setTimeout(() => { if (!accepted) finish({ reason: "The avatar didn't answer. Try again in a moment." }); }, 12000);
        ws.onopen = () => ws.send(JSON.stringify({ start: { sessionId } }));
        ws.onmessage = (m) => {
            if (m.data instanceof ArrayBuffer) { onVideo(new Uint8Array(m.data)); return; }
            let evt;
            try { evt = JSON.parse(m.data); } catch { return; }
            if (evt.end) { finish(evt.end); return; }
            if (!accepted && evt.state) {
                accepted = true;
                clearTimeout(timeout);
                resolve(handle);
            }
            onEvent(evt);
        };
        ws.onerror = () => finish({ reason: "Lost the connection to the avatar.", capped: false });
        ws.onclose = () => finish(accepted ? { reason: "", capped: false } : { reason: "Couldn't reach the avatar." });
    });
}
