// agent-avatar-fx.js — the avatar's hex effects (spec 73).
//
// One canvas over the avatar stage draws four things, all at the face's
// edges or between turns, never over the face while it talks (a moving
// mosaic on a talking mouth reads as a glitch):
//   - arrival: the face builds itself from hex tiles, like a call connecting,
//     and breaks back into them on the way out;
//   - a voice ring: hex cells around the frame that follow the real audio
//     level, magenta to amber while Atlas talks, cyan while the visitor does;
//   - tool hexes: a hex breaks off the ring and flies to the chat when Atlas
//     uses a tool;
//   - an interrupt burst: the ring scatters and snaps back on barge-in.
//
// Imported by agent-avatar.js, so it only loads with Avatar mode. Colours come
// from the panel's tokens (base.css), so they track the site's palette.

const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ARRIVE_S = 1.1;      // tiles flipping away, centre first
const BURST_S = 1.2;       // scatter and settle
const FLY_MS = 1000;
const HANG_UP_HOLD_MS = 350; // tiles rest this long before the face re-forms

function tokenRgb(style, name, fallback) {
    const v = style.getPropertyValue(name).trim();
    const m = /^#([0-9a-f]{6})$/i.exec(v);
    if (!m) return fallback;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));

export function mountHexFx(stage, frame) {
    const canvas = document.createElement("canvas");
    canvas.className = "agent-avatar-fx";
    canvas.setAttribute("aria-hidden", "true");
    stage.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    const style = getComputedStyle(stage);
    const COL = {
        avatar: tokenRgb(style, "--mode-avatar", [255, 111, 207]),
        amber: tokenRgb(style, "--mode-avatar-2", [255, 179, 107]),
        cyan: tokenRgb(style, "--accent", [0, 255, 209]),
        tile: tokenRgb(style, "--bg-card", [17, 17, 17]),
    };

    let W = 0, H = 0, DPR = 1, F = null;
    let ring = [], tiles = [];
    let state = "idle";
    let reveal = REDUCE_MOTION ? 1 : 0;   // 0 = face behind tiles, 1 = clear
    let revealTarget = 1;
    let level = 0;
    let burstAt = -1;
    let micLevel = null;
    let raf = 0;
    let last = 0;
    let disposed = false;
    let hangUpTimer = 0;

    // ---- geometry ----------------------------------------------------------
    function sd(x, y) {
        const qx = Math.abs(x - F.cx) - (F.w / 2 - F.r), qy = Math.abs(y - F.cy) - (F.h / 2 - F.r);
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - F.r;
    }
    function grid(r, keep) {
        const out = [], dx = Math.sqrt(3) * r, dy = 1.5 * r;
        for (let row = 0, y = 0; y < H + r; row++, y += dy) {
            for (let x = (row % 2) * dx / 2; x < W + r; x += dx) if (keep(x, y)) out.push({ x, y });
        }
        return out;
    }
    // Layout sizes, not getBoundingClientRect: the stage flips in with a 3D
    // transform, and a rect measured mid-flip would squash the whole grid.
    function layout() {
        W = stage.offsetWidth; H = stage.offsetHeight;
        const f = { width: frame.offsetWidth, height: frame.offsetHeight, left: frame.offsetLeft, top: frame.offsetTop };
        if (!W || !H || !f.width) return false;
        DPR = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(W * DPR);
        canvas.height = Math.round(H * DPR);
        const radius = parseFloat(getComputedStyle(frame).borderTopLeftRadius) || 16;
        F = { x: f.left, y: f.top, w: f.width, h: f.height, r: radius };
        F.cx = F.x + F.w / 2; F.cy = F.y + F.h / 2;
        const rr = Math.max(4.5, F.w / 40);
        ring = grid(rr, (x, y) => { const d = sd(x, y); return d > rr * 0.7 && d < rr * 3.2; })
            .map((c) => ({ ...c, r: rr, d: sd(c.x, c.y), a: Math.atan2(c.y - F.cy, c.x - F.cx), ph: Math.random() * 6.283 }));
        const tr = Math.max(8, F.w / 22), far = Math.hypot(F.w, F.h) / 2;
        tiles = grid(tr, (x, y) => sd(x, y) < tr)
            .map((c) => ({ ...c, r: tr, t0: (Math.hypot(c.x - F.cx, c.y - F.cy) / far) * 0.6 + Math.random() * 0.2 }));
        return true;
    }
    function hex(x, y, r) {
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
            const a = (Math.PI / 3) * k - Math.PI / 6;
            ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
        }
        ctx.closePath();
    }
    function clipFrame() {
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(F.x, F.y, F.w, F.h, F.r); else ctx.rect(F.x, F.y, F.w, F.h);
        ctx.clip();
    }

    // ---- voice level ---------------------------------------------------------
    // Atlas's voice is read from the playing <video> through captureStream,
    // which leaves the element's own sound alone. Where that's missing (Safari,
    // Firefox) or audio isn't unlocked yet, the ring runs on an even pulse.
    let actx = null, analyser = null, buf = null, source = null, sourceTrack = null, watched = null;
    function watch(video) {
        watched = video;
        if (typeof video.captureStream !== "function") return;
        try {
            if (!actx) {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                actx = new Ctx();
                analyser = actx.createAnalyser();
                analyser.fftSize = 512;
                buf = new Float32Array(analyser.fftSize);
                const sink = actx.createGain();
                sink.gain.value = 0; // keeps the graph pulled without a second copy of the voice
                analyser.connect(sink);
                sink.connect(actx.destination);
            }
            if (actx.state === "suspended") actx.resume().catch(() => {});
            if (!video._fxStream) video._fxStream = video.captureStream();
        } catch (_) { analyser = null; }
    }
    function atlasLevel(now) {
        const v = watched;
        if (analyser && v && v._fxStream && actx.state === "running") {
            const track = v._fxStream.getAudioTracks()[0];
            if (track && track !== sourceTrack) {
                try {
                    if (source) source.disconnect();
                    source = actx.createMediaStreamSource(new MediaStream([track]));
                    source.connect(analyser);
                    sourceTrack = track;
                } catch (_) { source = null; sourceTrack = null; }
            }
            if (source) {
                analyser.getFloatTimeDomainData(buf);
                let sum = 0;
                for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
                return Math.min(1, Math.sqrt(sum / buf.length) * 7);
            }
        }
        return 0.3 + 0.35 * Math.abs(Math.sin(now / 90)) * Math.abs(Math.sin(now / 230));
    }

    // ---- drawing ----------------------------------------------------------------
    function drawRing(now) {
        const t = now / 1000;
        const burstT = burstAt < 0 ? 99 : (now - burstAt) / 1000;
        const hearing = state === "hearing";
        for (const c of ring) {
            let inten = 0.05;
            if (REDUCE_MOTION) {
                if (state === "speaking" || hearing) inten += 0.35 * Math.max(0, 1 - c.d / (c.r * 3));
            } else if (level > 0.02) {
                const reach = 0.8 + level * 3.2;
                const fall = Math.max(0, 1 - (c.d / c.r) / reach);
                inten += level * fall * (0.65 + 0.35 * Math.sin(t * 7 - c.d * 0.25 + c.ph)) * 0.95;
            } else if (state === "listening") {
                // Thinking: a slow sweep around the frame.
                const ang = Math.atan2(Math.sin(c.a - t * 4), Math.cos(c.a - t * 4));
                inten += Math.max(0, (ang + Math.PI) / (2 * Math.PI) - 0.8) * 3 * Math.max(0, 1 - c.d / (c.r * 3));
            } else {
                inten += 0.05 * (0.5 + 0.5 * Math.sin(t * 1.6 + c.ph)) * Math.max(0, 1 - c.d / (c.r * 3));
            }
            let x = c.x, y = c.y;
            if (burstT < BURST_S && !REDUCE_MOTION) {
                const k = burstT < 0.1 ? burstT / 0.1 : Math.exp(-7 * (burstT - 0.1)) * Math.cos(11 * (burstT - 0.1));
                const push = k * 20 * Math.max(0.3, 1 - c.d / (c.r * 8));
                x += Math.cos(c.a) * push;
                y += Math.sin(c.a) * push;
                inten = Math.max(inten, (1 - burstT / BURST_S) * 0.8 * Math.max(0, 1 - c.d / (c.r * 5)));
            }
            if (inten < 0.02) continue;
            const col = hearing || burstT < 0.6 ? COL.cyan : mix(COL.avatar, COL.amber, 0.5 + 0.5 * Math.sin(c.a + t * 0.8));
            hex(x, y, c.r * 0.86);
            ctx.fillStyle = rgba(col, Math.min(0.7, inten * 0.7));
            ctx.fill();
            if (inten > 0.35) {
                ctx.strokeStyle = rgba(col, Math.min(1, inten));
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }
    }
    function drawTiles() {
        if (reveal >= 1) return;
        ctx.save();
        clipFrame();
        for (const tl of tiles) {
            const local = Math.min(1, Math.max(0, (reveal - tl.t0) / 0.25));
            if (local >= 1) continue;
            hex(tl.x, tl.y, tl.r * (1 - local) * 1.02);
            ctx.fillStyle = rgba(COL.tile, 1);
            ctx.fill();
            ctx.strokeStyle = rgba(mix(COL.avatar, COL.amber, tl.t0), 0.15 + Math.sin(local * Math.PI) * 0.85);
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        ctx.restore();
    }

    function tick(now) {
        raf = 0;
        if (disposed || document.hidden || !canvas.offsetParent) return; // resumes on resize/visibility
        if (!F && !layout()) return;
        const dt = Math.min(0.05, (now - (last || now)) / 1000);
        last = now;
        const target = state === "speaking" ? atlasLevel(now) : state === "hearing" && micLevel ? micLevel() : 0;
        level += (target - level) * (target > level ? 0.5 : 0.12);
        reveal += Math.sign(revealTarget - reveal) * Math.min(Math.abs(revealTarget - reveal), dt / ARRIVE_S);
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        ctx.clearRect(0, 0, W, H);
        drawRing(now);
        drawTiles();
        raf = requestAnimationFrame(tick);
    }
    function wake() { if (!raf && !disposed) raf = requestAnimationFrame(tick); }

    const ro = new ResizeObserver(() => { if (layout()) wake(); });
    ro.observe(stage);
    ro.observe(frame);
    const onVisible = () => { if (!document.hidden) wake(); };
    document.addEventListener("visibilitychange", onVisible);
    wake();

    return {
        setState(s) { state = s; wake(); },
        // The visitor's mic level (0..1), for the cyan ring in a conversation.
        setMicLevel(fn) { micLevel = typeof fn === "function" ? fn : null; },
        watch,
        arrive() {
            clearTimeout(hangUpTimer);
            if (REDUCE_MOTION) return;
            reveal = 0;
            revealTarget = 1;
            wake();
        },
        depart() {
            clearTimeout(hangUpTimer);
            if (REDUCE_MOTION || !canvas.offsetParent) return Promise.resolve();
            revealTarget = 0;
            wake();
            return new Promise((resolve) => setTimeout(resolve, ARRIVE_S * 1000));
        },
        // A conversation ended: the face breaks into tiles, holds a moment,
        // then re-forms as the idle face, like a call hanging up and the
        // line going back to standby.
        hangUp() {
            if (REDUCE_MOTION || !canvas.offsetParent) return;
            revealTarget = 0;
            wake();
            clearTimeout(hangUpTimer);
            hangUpTimer = setTimeout(() => { revealTarget = 1; wake(); }, ARRIVE_S * 1000 + HANG_UP_HOLD_MS);
        },
        burst() { burstAt = performance.now(); wake(); },
        // A hex leaves the ring's upper right and lands on `target` (the tool
        // chip's hex in the chat). Resolves when it lands.
        tool(target) {
            const s = stage.getBoundingClientRect();
            const to = target && target.getBoundingClientRect();
            if (REDUCE_MOTION || !F || !to || !s.width || !to.width) return Promise.resolve();
            const src = ring.filter((c) => c.d < c.r * 2 && c.x > F.cx && c.y < F.cy).sort((a, b) => b.x - a.x)[0]
                || { x: F.x + F.w, y: F.y };
            const fly = document.createElement("div");
            fly.className = "agent-hex-flyer";
            fly.setAttribute("aria-hidden", "true");
            document.body.appendChild(fly);
            const half = fly.offsetWidth / 2, halfH = fly.offsetHeight / 2;
            const a = { x: s.left + src.x - half, y: s.top + src.y - halfH };
            const b = { x: to.left + to.width / 2 - half, y: to.top + to.height / 2 - halfH };
            const mid = { x: Math.max(a.x, b.x) + 50, y: (a.y + b.y) / 2 - 20 };
            const anim = fly.animate([
                { transform: `translate(${a.x}px, ${a.y}px) scale(0.3) rotate(0deg)`, opacity: 0.2 },
                { transform: `translate(${a.x + 18}px, ${a.y - 14}px) scale(1.2) rotate(40deg)`, opacity: 1, offset: 0.2 },
                { transform: `translate(${mid.x}px, ${mid.y}px) scale(1) rotate(160deg)`, opacity: 1, offset: 0.6 },
                { transform: `translate(${b.x}px, ${b.y}px) scale(0.45) rotate(360deg)`, opacity: 1 },
            ], { duration: FLY_MS, easing: "cubic-bezier(.5,0,.3,1)" });
            return anim.finished.catch(() => {}).then(() => fly.remove());
        },
        dispose() {
            disposed = true;
            clearTimeout(hangUpTimer);
            if (raf) cancelAnimationFrame(raf);
            ro.disconnect();
            document.removeEventListener("visibilitychange", onVisible);
            try { if (source) source.disconnect(); } catch (_) { /* already */ }
            if (actx) actx.close().catch(() => {});
            canvas.remove();
        },
    };
}
