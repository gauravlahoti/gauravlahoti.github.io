// agent-voice.js — mic recording engine for the Atlas composer (spec #48).
//
// Ears only: records a short clip, POSTs it to /api/agent-transcribe, and
// hands the transcript back to the caller. It never sends a chat turn
// itself — agent-widget.js decides what happens to the text (prefills the
// composer via prefillComposer(), same as the WebMCP draft_note_to_gaurav
// tool, so "a human keystroke is always required to actually send" holds
// for voice too).
//
// Lazy-loaded: agent-widget.js only import()s this module on the first mic
// tap, so MediaRecorder code never ships in the initial page payload.

const MAX_RECORD_MS = 30000;
const AUDIO_BITS_PER_SECOND = 24000;

// First supported MIME wins. webm/opus covers Chrome, Edge, Firefox, and
// Safari 18.4+; audio/mp4 is the fallback for older iOS Safari.
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

export function isVoiceSupported() {
    return !!(
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function" &&
        typeof window.MediaRecorder === "function"
    );
}

function pickMimeType() {
    if (typeof MediaRecorder.isTypeSupported !== "function") return "";
    for (const mime of MIME_CANDIDATES) {
        if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return "";
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || "");
            const comma = result.indexOf(",");
            resolve(comma === -1 ? "" : result.slice(comma + 1));
        };
        reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
        reader.readAsDataURL(blob);
    });
}

// Returns { start, stop, dispose }. `start()` requests mic access and begins
// recording; `stop()` ends recording early and triggers transcription.
// Recording also auto-stops at MAX_RECORD_MS. `onStateChange(state)` fires
// with "recording" | "busy" | "idle"; `onTranscript(text)` fires once with
// the transcript on success; `onError(message)` fires on any failure and is
// always followed by an "idle" state change.
export function initVoiceInput({ apiUrl, sessionId, onStateChange, onTranscript, onError }) {
    let stream = null;
    let recorder = null;
    let chunks = [];
    let autoStopTimer = null;
    let disposed = false;

    function emitState(state) {
        if (!disposed && typeof onStateChange === "function") onStateChange(state);
    }

    function cleanupStream() {
        // Stopping every track is what clears the browser's recording
        // indicator — skipping this leaves the tab looking like it's still
        // listening after the user is done.
        if (stream) {
            stream.getTracks().forEach((t) => t.stop());
            stream = null;
        }
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
        recorder = null;
    }

    async function start() {
        if (recorder) return;
        chunks = [];
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            const message = err && err.name === "NotAllowedError"
                ? "Mic blocked. Check browser permissions."
                : err && err.name === "NotFoundError"
                    ? "No microphone found."
                    : "Couldn't access the microphone.";
            if (typeof onError === "function") onError(message);
            emitState("idle");
            return;
        }

        const mimeType = pickMimeType();
        try {
            recorder = mimeType
                ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND })
                : new MediaRecorder(stream);
        } catch (_) {
            cleanupStream();
            if (typeof onError === "function") onError("Recording isn't supported in this browser.");
            emitState("idle");
            return;
        }

        recorder.addEventListener("dataavailable", (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
        });
        recorder.addEventListener("stop", async () => {
            const usedMime = recorder && recorder.mimeType ? recorder.mimeType : (mimeType || "audio/webm");
            const blob = new Blob(chunks, { type: usedMime });
            chunks = [];
            cleanupStream();

            if (blob.size === 0) {
                if (typeof onError === "function") onError("Didn't catch any audio. Try again.");
                emitState("idle");
                return;
            }

            emitState("busy");
            try {
                const audio = await blobToBase64(blob);
                const res = await fetch(apiUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ sessionId, mimeType: usedMime, audio }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    if (typeof onError === "function") {
                        onError((data && data.error) || "Transcription failed. Try again.");
                    }
                    emitState("idle");
                    return;
                }
                const text = (data && data.text) || "";
                if (!text) {
                    if (typeof onError === "function") onError("Didn't catch that. Try again.");
                    emitState("idle");
                    return;
                }
                if (typeof onTranscript === "function") onTranscript(text);
                emitState("idle");
            } catch (_) {
                if (typeof onError === "function") onError("Network error. Try again.");
                emitState("idle");
            }
        });

        recorder.start();
        emitState("recording");
        autoStopTimer = setTimeout(() => {
            if (typeof onError === "function") onError("Stopped at 30s.");
            stop();
        }, MAX_RECORD_MS);
    }

    function stop() {
        if (recorder && recorder.state !== "inactive") {
            recorder.stop();
        }
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
    }

    function dispose() {
        disposed = true;
        if (recorder && recorder.state !== "inactive") {
            try { recorder.stop(); } catch (_) { /* ignore */ }
        }
        cleanupStream();
    }

    return { start, stop, dispose };
}
