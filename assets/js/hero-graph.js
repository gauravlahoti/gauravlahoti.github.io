// hero-graph.js — Agent Mesh: 3D node-edge graph with A2A-style edge pulse.
// Replaces the curl-noise shader from spec 02 draft.
//
// Contract: initHeroGraph(canvas, opts) → { canvas, destroy(), setPaused(bool) }

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

export async function initHeroGraph(canvas, opts = {}) {
    const { accent = "#00FFD1", isTouch = false, isMobile = false } = opts;

    let THREE;
    try {
        THREE = await import(THREE_URL);
    } catch (err) {
        console.warn("[hero-graph] failed to import three", err);
        canvas.remove();
        return null;
    }

    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
            alpha: true,
            powerPreference: "low-power",
        });
    } catch (err) {
        console.warn("[hero-graph] WebGL unavailable", err);
        canvas.remove();
        return null;
    }

    // Mobile gets a tighter pixel ratio so the GPU has less to do.
    const dprCap = isMobile ? 1.25 : 1.5;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 7;

    const accentColor = new THREE.Color(accent);

    // ---- Build node positions on Fibonacci sphere with jitter ----
    // Mobile profile: ~half the nodes so the k-NN edge-build (O(n²)) and
    // per-frame draw cost both come down.
    const NODE_COUNT = isMobile ? 40 : 80;
    const RADIUS = 3.2;
    const JITTER = 0.12;
    const positions = [];
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < NODE_COUNT; i++) {
        const y = 1 - (i / (NODE_COUNT - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const theta = goldenAngle * i;
        const x = r * Math.cos(theta);
        const z = r * Math.sin(theta);
        const j = () => (Math.random() - 0.5) * JITTER;
        positions.push([(x + j()) * RADIUS, (y + j()) * RADIUS, (z + j()) * RADIUS]);
    }

    // ---- Build edges via k=2 nearest neighbors (undirected, deduped) ----
    const K = 2;
    const edgeSet = new Set();
    const edges = [];
    for (let i = 0; i < positions.length; i++) {
        const ranked = positions
            .map((p, j) => [j, distSq3(positions[i], p)])
            .filter(([j]) => j !== i)
            .sort((a, b) => a[1] - b[1]);
        for (let k = 0; k < K; k++) {
            const j = ranked[k][0];
            const key = i < j ? `${i}-${j}` : `${j}-${i}`;
            if (edgeSet.has(key)) continue;
            edgeSet.add(key);
            edges.push([i, j]);
        }
    }

    // ---- Adjacency for path walking ----
    const adj = positions.map(() => []);
    edges.forEach(([a, b], i) => {
        adj[a].push([b, i]);
        adj[b].push([a, i]);
    });

    // ---- Node points ----
    const nodeGeo = new THREE.BufferGeometry();
    nodeGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(positions.flat()), 3)
    );
    const nodeMat = new THREE.PointsMaterial({
        color: accentColor,
        size: 3.5,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(nodeGeo, nodeMat);

    // ---- Edge segments + custom pulse shader ----
    const edgeGeo = new THREE.BufferGeometry();
    const edgePos = new Float32Array(edges.length * 6);
    const edgeT = new Float32Array(edges.length * 2);
    edges.forEach(([a, b], i) => {
        edgePos.set(positions[a], i * 6);
        edgePos.set(positions[b], i * 6 + 3);
        edgeT[i * 2] = -1;
        edgeT[i * 2 + 1] = -1;
    });
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(edgePos, 3));
    edgeGeo.setAttribute("aPathT", new THREE.BufferAttribute(edgeT, 1));

    const edgeMat = new THREE.ShaderMaterial({
        uniforms: {
            uHead: { value: 0.0 },
            uAccent: { value: new THREE.Vector3(accentColor.r, accentColor.g, accentColor.b) },
            uBaseAlpha: { value: 0.09 },
        },
        vertexShader: /* glsl */ `
            attribute float aPathT;
            varying float vT;
            void main() {
                vT = aPathT;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: /* glsl */ `
            precision mediump float;
            uniform float uHead;
            uniform vec3 uAccent;
            uniform float uBaseAlpha;
            varying float vT;
            void main() {
                float a;
                if (vT < 0.0) {
                    a = uBaseAlpha;
                } else {
                    float d = abs(vT - uHead);
                    float amp = exp(-d * 1.6);
                    a = uBaseAlpha + (1.0 - uBaseAlpha) * amp;
                }
                gl_FragColor = vec4(uAccent, a);
            }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    const lines = new THREE.LineSegments(edgeGeo, edgeMat);

    // ---- Group structure: parallax wraps base; base auto-rotates ----
    const baseGroup = new THREE.Group();
    baseGroup.add(points);
    baseGroup.add(lines);
    const parallaxGroup = new THREE.Group();
    parallaxGroup.add(baseGroup);
    scene.add(parallaxGroup);

    // ---- Pulse state ----
    const PATH_LEN = 6;
    const PULSE_DUR = 1.4;
    let pulseStart = performance.now() / 1000;
    let currentPath = [];

    function pickNewPath() {
        currentPath.forEach((edgeIdx) => {
            edgeT[edgeIdx * 2] = -1;
            edgeT[edgeIdx * 2 + 1] = -1;
        });
        const visitedEdges = new Set();
        let node = Math.floor(Math.random() * positions.length);
        const path = [];
        for (let s = 0; s < PATH_LEN; s++) {
            const candidates = adj[node].filter(([, e]) => !visitedEdges.has(e));
            if (candidates.length === 0) break;
            const [nextNode, edgeIdx] = candidates[Math.floor(Math.random() * candidates.length)];
            visitedEdges.add(edgeIdx);
            path.push(edgeIdx);
            edgeT[edgeIdx * 2] = s;
            edgeT[edgeIdx * 2 + 1] = s;
            node = nextNode;
        }
        currentPath = path;
        edgeGeo.attributes.aPathT.needsUpdate = true;
    }

    pickNewPath();

    // ---- Mouse parallax ----
    let targetRX = 0, targetRY = 0, curRX = 0, curRY = 0;
    function onMouseMove(e) {
        const x = (e.clientX / window.innerWidth) * 2 - 1;
        const y = (e.clientY / window.innerHeight) * 2 - 1;
        targetRY = x * 0.105;
        targetRX = -y * 0.105;
    }
    if (!isTouch) window.addEventListener("mousemove", onMouseMove, { passive: true });

    // ---- Resize ----
    function resize() {
        const w = canvas.clientWidth || canvas.parentElement.clientWidth || window.innerWidth;
        const h = canvas.clientHeight || canvas.parentElement.clientHeight || window.innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    resize();
    window.addEventListener("resize", resize);

    // ---- Pause when hero leaves viewport ----
    let paused = false;
    const io = new IntersectionObserver(([entry]) => {
        paused = !entry.isIntersecting;
    }, { threshold: 0 });
    io.observe(canvas);

    // ---- Render loop ----
    // Mobile targets 30fps (cap render to ~33ms gaps); desktop free-runs at
    // the rAF cadence (typically 60fps).
    const targetFrameMs = isMobile ? 1000 / 30 : 0;
    let rafId;
    let lastRenderMs = 0;

    // FPS watchdog: sample over 1s windows; if 3 consecutive windows average
    // under 24fps, dispose the canvas and reveal the gradient fallback.
    let fpsWindowStart = performance.now();
    let fpsFrames = 0;
    let lowFpsStreak = 0;
    let watchdogTripped = false;

    function tick() {
        rafId = requestAnimationFrame(tick);
        if (paused) return;
        const now = performance.now();

        if (targetFrameMs > 0 && now - lastRenderMs < targetFrameMs - 1) return;
        lastRenderMs = now;

        const t = now / 1000;

        // Auto Y-rotation on base
        baseGroup.rotation.y += 0.0014;

        // Parallax lerp on outer group
        curRX += (targetRX - curRX) * 0.06;
        curRY += (targetRY - curRY) * 0.06;
        parallaxGroup.rotation.x = curRX;
        parallaxGroup.rotation.y = curRY;

        // Pulse progress
        const elapsed = t - pulseStart;
        if (elapsed >= PULSE_DUR) {
            pulseStart = t;
            pickNewPath();
        }
        const u = Math.min(Math.max(elapsed / PULSE_DUR, 0), 1);
        edgeMat.uniforms.uHead.value = u * (PATH_LEN - 1);

        renderer.render(scene, camera);

        // FPS watchdog tick
        fpsFrames += 1;
        const windowMs = now - fpsWindowStart;
        if (windowMs >= 1000) {
            const fps = (fpsFrames * 1000) / windowMs;
            const target = isMobile ? 24 : 30;
            if (fps < target) {
                lowFpsStreak += 1;
                if (lowFpsStreak >= 3 && !watchdogTripped) {
                    watchdogTripped = true;
                    console.info("[hero-graph] FPS watchdog tripped at", fps.toFixed(1), "fps — falling back");
                    destroy();
                    canvas.remove();
                    return;
                }
            } else {
                lowFpsStreak = 0;
            }
            fpsFrames = 0;
            fpsWindowStart = now;
        }
    }
    tick();

    function destroy() {
        cancelAnimationFrame(rafId);
        io.disconnect();
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("resize", resize);
        nodeGeo.dispose();
        edgeGeo.dispose();
        nodeMat.dispose();
        edgeMat.dispose();
        renderer.dispose();
    }

    return {
        canvas,
        destroy,
        setPaused: (v) => { paused = !!v; },
    };
}

function distSq3(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
}
