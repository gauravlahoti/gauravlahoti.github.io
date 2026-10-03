// agents-page.js — /live-agents/ bootstrap

import { playEntranceWipe, runPageTransition, signalPageReady } from "./page-transition.js";
import { initNavDrawer } from "./nav-drawer.js";

const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

// This page has no pageview beacon to correlate with, so a fresh id per load
// is all initAgentWidget needs (same behavior it used to generate internally).
function _uuidv4() {
    if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Extract ?v= from this module's own URL so dynamic imports stay cache-busted.
const _selfV = new URL(import.meta.url).searchParams.get("v") || "";
const _vq = (path) => _selfV ? `${path}?v=${_selfV}` : path;

// Lazy-init the Atlas chat widget on demand (used by "Try it live" button).
let _widgetPromise = null;
async function _openAtlasWidget() {
    if (!_widgetPromise) {
        const base = document.querySelector("base")?.href || window.location.origin + "/";
        _widgetPromise = Promise.all([
            fetch(new URL(_vq("content/profile.json"), base)).then(r => r.json()),
            import(_vq("./agent-widget.js")),
        ]).then(([profile, { initAgentWidget }]) => {
            let root = document.getElementById("agent-root");
            if (!root) {
                root = document.createElement("div");
                root.id = "agent-root";
                document.body.appendChild(root);
            }
            const widget = initAgentWidget(root, profile, _uuidv4());
            window.__agentWidget = widget;
            return widget;
        }).catch(err => {
            console.warn("[agents-page] atlas widget failed to load", err);
            _widgetPromise = null;
            return null;
        });
    }
    const widget = await _widgetPromise;
    if (widget?.open) widget.open();
}

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role") node.setAttribute(k, v);
        else node[k] = v;
    }
    for (const c of children) {
        if (typeof c === "string") node.insertAdjacentHTML("beforeend", c);
        else if (c) node.appendChild(c);
    }
    return node;
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function buildCard(agent, onOpen) {
    const card = el("article", {
        class: "agent-card",
        tabindex: "0",
        "aria-label": `${agent.name}, ${agent.role}`,
    });

    const meta = el("div", { class: "agent-card-meta" });
    meta.append(
        el("span", { class: "agent-card-status" }, agent.status || "LIVE"),
        el("span", { class: "agent-card-role" }, agent.role),
        ...(agentStamp(agent) ? [el("span", { class: "agent-card-date" }, agentStamp(agent))] : []),
    );

    const name = el("h2", { class: "agent-card-name" }, agent.name);
    const headline = el("p", { class: "agent-card-headline" }, agent.headline);
    const desc = el("p", { class: "agent-card-desc" }, agent.description);

    const valueRow = el("div", { class: "agent-card-value-row" });
    valueRow.innerHTML = `<p class="agent-value-label">Value Driver</p><p class="agent-value-text">${agent.value}</p>`;

    const stack = el("div", { class: "agent-stack" });
    (agent.stack || []).forEach(s => stack.append(el("span", { class: "agent-chip" }, s)));

    const pane = el("div", { class: "agent-diagram-pane" });
    if (agent.diagramSvg) {
        const img = el("img", {
            src: agent.diagramSvg + "?v=178",
            alt: agent.diagramAlt || agent.name,
            loading: "lazy",
            decoding: "async",
        });
        pane.appendChild(img);
    }

    const footer = el("div", { class: "agent-card-footer" });
    const openBtn = el("button", { class: "agent-open-btn", type: "button" });
    openBtn.innerHTML = `Deep Dive <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
    footer.appendChild(openBtn);

    card.append(meta, name, headline, desc, valueRow, stack, pane, footer);

    const trigger = () => onOpen(agent);
    openBtn.addEventListener("click", e => { e.stopPropagation(); trigger(); });
    card.addEventListener("click", trigger);
    card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); trigger(); } });

    return card;
}

// ─── Diagram fullscreen ───────────────────────────────────────────────────────

function openDiagramFullscreen(svgEl) {
    const gsap = window.gsap;
    const fs = el("div", {
        class: "agent-diag-fs",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Architecture diagram, fullscreen",
    });

    const closeBtn = el("button", { class: "agent-diag-fs-close", type: "button", "aria-label": "Exit fullscreen" });
    closeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg> Exit`;

    // Clone without in-flight traveler dots
    const clone = svgEl.cloneNode(true);
    clone.querySelectorAll(".anim-dot").forEach(e => e.remove());
    // Preserve the aspect-ratio derived from viewBox (set in fetchInlineSvg).
    // cssText replacement wipes inline styles, so read it from the clone first.
    const ar = clone.style.aspectRatio || svgEl.style.aspectRatio || "";
    if (matchMedia("(max-width: 767px)").matches) {
        // Let CSS control width (640 px) and height (auto); keep aspect-ratio
        // so the SVG renders at correct height rather than collapsing to 0.
        clone.style.cssText = `display:block;${ar ? `aspect-ratio:${ar};` : ""}`;
    } else {
        clone.style.cssText = `width:auto;height:auto;max-width:calc(100vw - 64px);max-height:calc(100vh - 80px);display:block;${ar ? `aspect-ratio:${ar};` : ""}`;
    }

    fs.append(clone, closeBtn);
    document.body.appendChild(fs);

    let cloneTl = null;

    const close = () => {
        cloneTl?.kill();
        if (gsap && !REDUCE_MOTION) {
            gsap.to(fs, { opacity: 0, duration: 0.16, onComplete: () => fs.remove() });
        } else {
            fs.remove();
        }
    };

    closeBtn.addEventListener("click", close);
    fs.addEventListener("click", e => { if (e.target === fs) close(); });
    const onKey = e => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);

    if (gsap && !REDUCE_MOTION) {
        gsap.fromTo(fs, { opacity: 0 }, {
            opacity: 1, duration: 0.2, ease: "power2.out",
            onComplete() { cloneTl = animateDiagram(clone); },
        });
    } else {
        setTimeout(() => { cloneTl = animateDiagram(clone); }, 80);
    }
}

// ─── Pinch-to-zoom (mobile) ────────────────────────────────────────────────────
// In-place pinch zoom + drag pan on the panel diagram, so phone users zoom with
// their fingers instead of opening a space-eating fullscreen view.
//
// The diagram wrap uses `touch-action: none` on mobile, so we own every gesture:
//   · 2 fingers            → pinch zoom (anchored at the pinch midpoint)
//   · 1 finger, zoomed in  → pan the diagram
//   · 1 finger, at 1×      → forward the drag to the panel's scroll container
//     (so the page still scrolls past the diagram — the scroll bug stays fixed)
function enablePinchZoom(wrap, svg) {
    const MIN = 1, MAX = 4;
    // Resolved lazily at gesture time: at init the wrap isn't in the scroll
    // tree yet (buildPanel attaches it later), so closest() would return null.
    const getScroller = () => wrap.closest(".agent-panel-scroll");
    // Own every gesture on the diagram (set here, not in CSS, so the <img>
    // fallback — which has no zoom handler — keeps native pan-y scrolling).
    wrap.style.touchAction = "none";
    svg.style.touchAction = "none";
    svg.style.willChange = "transform";
    let scale = 1, tx = 0, ty = 0;
    let startDist = 0, startScale = 1, startTx = 0, startTy = 0, midX = 0, midY = 0;
    let lastX = 0, lastY = 0, mode = null;

    const apply = () => {
        svg.style.transformOrigin = "0 0";
        svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
        wrap.classList.toggle("is-zoomed", scale > 1.01);
    };
    const clamp = () => {
        const w = wrap.clientWidth, h = wrap.clientHeight;
        tx = Math.max(w - w * scale, Math.min(0, tx));
        ty = Math.max(h - h * scale, Math.min(0, ty));
    };
    const dist = (a, b) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);

    wrap.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) {
            const [a, b] = e.touches;
            const r = wrap.getBoundingClientRect();
            mode = "pinch";
            startDist = dist(a, b);
            startScale = scale;
            startTx = tx; startTy = ty;
            midX = (a.clientX + b.clientX) / 2 - r.left;
            midY = (a.clientY + b.clientY) / 2 - r.top;
            e.preventDefault();
        } else if (e.touches.length === 1) {
            lastX = e.touches[0].clientX;
            lastY = e.touches[0].clientY;
            mode = scale > 1.01 ? "pan" : "scroll";
        }
    }, { passive: false });

    wrap.addEventListener("touchmove", (e) => {
        if (mode === "pinch" && e.touches.length === 2) {
            const next = Math.max(MIN, Math.min(MAX, startScale * (dist(e.touches[0], e.touches[1]) / startDist)));
            tx = midX - (midX - startTx) * (next / startScale);
            ty = midY - (midY - startTy) * (next / startScale);
            scale = next;
            clamp(); apply();
            e.preventDefault();
        } else if (mode === "pan" && e.touches.length === 1) {
            const t = e.touches[0];
            tx += t.clientX - lastX; ty += t.clientY - lastY;
            lastX = t.clientX; lastY = t.clientY;
            clamp(); apply();
            e.preventDefault();
        } else if (mode === "scroll" && e.touches.length === 1) {
            // Not zoomed: drive the panel scroll so the page still moves.
            const sc = getScroller();
            if (sc) {
                const t = e.touches[0];
                sc.scrollTop -= t.clientY - lastY;
                lastX = t.clientX; lastY = t.clientY;
                e.preventDefault();
            }
        }
    }, { passive: false });

    const end = (e) => {
        if (e.touches.length === 0) {
            if (scale <= 1.01) { scale = 1; tx = 0; ty = 0; apply(); }
            mode = null;
        } else if (e.touches.length === 1) {
            lastX = e.touches[0].clientX;
            lastY = e.touches[0].clientY;
            mode = scale > 1.01 ? "pan" : "scroll";
        }
    };
    wrap.addEventListener("touchend", end);
    wrap.addEventListener("touchcancel", end);

    // Double-tap to reset zoom
    let lastTap = 0;
    wrap.addEventListener("touchend", (e) => {
        if (e.touches.length > 0) return;
        const now = Date.now();
        if (now - lastTap < 300 && scale > 1.01) {
            scale = 1; tx = 0; ty = 0; apply();
        }
        lastTap = now;
    });
}

// ─── SVG inline fetch ─────────────────────────────────────────────────────────

async function fetchInlineSvg(url) {
    try {
        const base = document.querySelector("base")?.href || (window.location.origin + "/");
        const resp = await fetch(new URL(url + "?v=178", base));
        if (!resp.ok) return null;
        const text = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, "image/svg+xml");
        const svgEl = document.importNode(doc.documentElement, true);
        svgEl.removeAttribute("width");
        svgEl.removeAttribute("height");
        // Derive aspect-ratio from viewBox so the SVG renders at correct
        // height when width:100% and no explicit height attribute is set.
        const vb = (svgEl.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
        const ar = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? `${vb[2]} / ${vb[3]}` : "16 / 10";
        svgEl.style.cssText = `width:100%;height:auto;display:block;aspect-ratio:${ar};`;
        return svgEl;
    } catch {
        return null;
    }
}

// ─── Diagram animation ────────────────────────────────────────────────────────

function animateDiagram(svgEl) {
    const gsap = window.gsap;
    if (!gsap || !svgEl || REDUCE_MOTION) return;

    const svgNS = "http://www.w3.org/2000/svg";
    const flows = Array.from(svgEl.querySelectorAll("[data-traveler-path]"));
    const reveals = Array.from(svgEl.querySelectorAll("[data-step-reveal]"));
    const stepCircles = svgEl.querySelectorAll("[data-step-circle]");

    if (!flows.length && !reveals.length) return;

    // Hide all step circles at start
    stepCircles.forEach(el => gsap.set(el, { opacity: 0 }));

    const SPEED = 260; // svg-units / second

    const master = gsap.timeline({
        repeat: -1,
        repeatDelay: 2,
        onRepeat() {
            stepCircles.forEach(el => gsap.set(el, { opacity: 0 }));
        },
    });

    // ── Traveler dot flows ──
    flows.forEach(flowEl => {
        const pathStr = flowEl.getAttribute("data-traveler-path") || "";
        const color   = flowEl.getAttribute("data-color") || "#00FFD1";
        const stepNum = flowEl.getAttribute("data-step");
        const delay   = parseFloat(flowEl.getAttribute("data-delay") || "0");

        const pts = pathStr.trim().split(/\s+/).map(p => {
            const [x, y] = p.split(",").map(Number);
            return { x, y };
        }).filter(p => !isNaN(p.x) && !isNaN(p.y));
        if (pts.length < 2) return;

        // Total distance → duration
        let totalLen = 0;
        for (let i = 1; i < pts.length; i++) {
            const dx = pts[i].x - pts[i - 1].x;
            const dy = pts[i].y - pts[i - 1].y;
            totalLen += Math.sqrt(dx * dx + dy * dy);
        }
        const travelDur = totalLen / SPEED;

        // Create glowing traveler dot
        const dot = document.createElementNS(svgNS, "circle");
        dot.setAttribute("class", "anim-dot");
        dot.setAttribute("r", "5");
        dot.setAttribute("fill", color);
        dot.style.filter = color === "#00FFD1"
            ? "drop-shadow(0 0 5px rgba(0,255,209,0.95))"
            : "drop-shadow(0 0 3px rgba(136,136,136,0.7))";
        gsap.set(dot, { opacity: 0, attr: { cx: pts[0].x, cy: pts[0].y } });
        svgEl.appendChild(dot);

        // Segment-by-segment travel
        const seg = gsap.timeline();
        seg.to(dot, { opacity: 1, duration: 0.08 });
        for (let i = 1; i < pts.length; i++) {
            const dx = pts[i].x - pts[i - 1].x;
            const dy = pts[i].y - pts[i - 1].y;
            seg.to(dot, {
                attr: { cx: pts[i].x, cy: pts[i].y },
                duration: Math.sqrt(dx * dx + dy * dy) / SPEED,
                ease: "none",
            });
        }
        seg.to(dot, { opacity: 0, duration: 0.12, ease: "power2.in" });

        master.add(seg, delay);

        // Reveal step circle when dot arrives
        if (stepNum) {
            const arriveAt = delay + 0.08 + travelDur;
            svgEl.querySelectorAll(`[data-step-circle="${stepNum}"]`).forEach(el => {
                master.fromTo(el,
                    { opacity: 0, scale: 0.5, transformOrigin: "center center" },
                    { opacity: 1, scale: 1, duration: 0.28, ease: "back.out(2)" },
                    arriveAt,
                );
            });
        }
    });

    // ── Step-only reveals (no traveler) ──
    reveals.forEach(el => {
        const stepNum = el.getAttribute("data-step-reveal");
        const delay   = parseFloat(el.getAttribute("data-delay") || "0");
        if (!stepNum) return;
        svgEl.querySelectorAll(`[data-step-circle="${stepNum}"]`).forEach(circleEl => {
            master.fromTo(circleEl,
                { opacity: 0, scale: 0.5, transformOrigin: "center center" },
                { opacity: 1, scale: 1, duration: 0.28, ease: "back.out(2)" },
                delay,
            );
        });
    });

    return master;
}

// ─── Full-screen panel ────────────────────────────────────────────────────────

let activePanel = null;

async function buildPanel(agent) {
    const overlay = el("div", {
        class: "agent-panel-overlay",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": `${agent.name} deep-dive`,
    });

    const inner = el("div", { class: "agent-panel-inner" });

    // Sticky header
    const hdr = el("div", { class: "agent-panel-header" });
    const hdrLeft = el("div", { class: "agent-panel-hdr-left" });
    hdrLeft.append(
        el("span", { class: "agent-card-status" }, agent.status || "LIVE"),
        el("span", { class: "agent-card-role" }, agent.role),
        ...(agentStamp(agent) ? [el("span", { class: "agent-card-date" }, agentStamp(agent))] : []),
    );
    const closeBtn = el("button", { class: "agent-panel-close", type: "button", "aria-label": "Close" });
    closeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
    closeBtn.addEventListener("click", () => closePanel(overlay));
    hdr.append(hdrLeft, closeBtn);

    // Title block
    const titleBlock = el("div", { class: "agent-panel-title-block" });
    titleBlock.append(
        el("h1", { class: "agent-panel-name" }, agent.name),
        el("p",  { class: "agent-panel-subtitle" }, agent.subtitle),
        el("p",  { class: "agent-panel-headline" }, agent.headline),
    );

    // Architecture diagram — inline SVG for animation support
    const diagSection = el("div", { class: "agent-panel-section" });
    diagSection.append(el("p", { class: "agent-panel-eyebrow" }, "// architecture"));
    let inlinedSvg = null;
    if (agent.diagramSvg) {
        const isMobile = matchMedia("(max-width: 767px)").matches;
        const diagWrap = el("div", { class: "agent-panel-diagram-wrap" });

        // Desktop: expand-to-fullscreen button. Mobile: pinch-to-zoom in place
        // (the button is hidden via CSS — fullscreen wastes the small screen).
        const expandBtn = el("button", { class: "agent-diag-expand", type: "button", "aria-label": "View fullscreen" });
        expandBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`;
        diagWrap.appendChild(expandBtn);

        // Mobile zoom hint (fades out after first interaction)
        if (isMobile) {
            const hint = el("span", { class: "agent-diag-zoom-hint" }, "pinch to zoom · drag to pan");
            diagWrap.appendChild(hint);
            diagWrap.addEventListener("touchstart", () => hint.classList.add("is-hidden"), { once: true, passive: true });
        }

        diagSection.appendChild(diagWrap);
        const svgEl = await fetchInlineSvg(agent.diagramSvg);
        if (svgEl) {
            diagWrap.appendChild(svgEl);
            inlinedSvg = svgEl;
            expandBtn.addEventListener("click", e => { e.stopPropagation(); openDiagramFullscreen(svgEl); });
            if (isMobile) enablePinchZoom(diagWrap, svgEl);
        } else {
            // Fallback img
            const img = el("img", {
                class: "agent-panel-diagram",
                src: agent.diagramSvg,
                alt: agent.diagramAlt || agent.name,
                decoding: "async",
            });
            diagWrap.appendChild(img);
            expandBtn.remove();
        }
    }

    // Numbered steps
    let stepsSection = null;
    if (agent.steps && agent.steps.length) {
        stepsSection = el("div", { class: "agent-panel-section" });
        stepsSection.append(el("p", { class: "agent-panel-eyebrow" }, "// how it works"));
        const stepsList = el("ol", { class: "agent-steps" });
        agent.steps.forEach(step => {
            const item = el("li", { class: "agent-step" });
            item.innerHTML = `
                <div class="agent-step-num" aria-hidden="true">${step.n}</div>
                <div class="agent-step-body">
                    <strong class="agent-step-label">${step.label}</strong>
                    <p class="agent-step-detail">${step.detail}</p>
                </div>`;
            stepsList.appendChild(item);
        });
        stepsSection.appendChild(stepsList);
    }

    // Tech decisions
    let techSection = null;
    if (agent.techDecisions && agent.techDecisions.length) {
        techSection = el("div", { class: "agent-panel-section" });
        techSection.append(el("p", { class: "agent-panel-eyebrow" }, "// why this stack"));
        agent.techDecisions.forEach(td => {
            const item = el("div", { class: "agent-tech-item" });
            item.innerHTML = `
                <span class="agent-tech-name">${td.tech}</span>
                <p class="agent-tech-why">${td.why}</p>`;
            techSection.appendChild(item);
        });
    }

    // Traits
    let traitsSection = null;
    if (agent.traits && agent.traits.length) {
        traitsSection = el("div", { class: "agent-panel-section" });
        traitsSection.append(el("p", { class: "agent-panel-eyebrow" }, "// at a glance"));
        const table = el("div", { class: "agent-traits-table" });
        agent.traits.forEach(({ label, value }) => {
            const row = el("div", { class: "agent-trait-row" });
            row.append(
                el("span", { class: "agent-trait-key" }, label),
                el("span", { class: "agent-trait-val" }, value),
            );
            table.appendChild(row);
        });
        traitsSection.appendChild(table);
    }

    // Links — exclude anything already rendered in the demo section
    let linksSection = null;
    if (agent.links && agent.links.length) {
        const otherLinks = agent.links.filter(({ label, href }) =>
            !(label === "Try it live" && href && href.startsWith("/#")) &&
            !(label === "Try it yourself")
        );
        if (otherLinks.length) {
            linksSection = el("div", { class: "agent-panel-section agent-panel-links" });
            otherLinks.forEach(({ label, href }) => {
                const a = el("a", {
                    class: "deepdive-link",
                    href,
                    target: href.startsWith("/") || href.startsWith("#") ? "_self" : "_blank",
                    rel: "noopener noreferrer",
                });
                a.innerHTML = `${label} <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M7 17L17 7M7 7h10v10"/></svg>`;
                linksSection.appendChild(a);
            });
        }
    }

    // Single-column layout: diagram full-width on top, all content below
    const body = el("div", { class: "agent-panel-body" });

    if (agent.demoVideo) {
        const videoSec = el("div", { class: "agent-panel-section agent-panel-video" });
        videoSec.append(el("p", { class: "agent-panel-eyebrow" }, "// demo"));
        const demoRow = el("div", { class: "demo-btn-row" });
        const btn = el("button", { class: "demo-watch-btn", type: "button" });
        btn.innerHTML = `<span class="demo-play-icon">▶</span><span>Watch Pipeline Demo</span>`;
        btn.addEventListener("click", () => _openVideoModal(agent.demoVideo));
        demoRow.appendChild(btn);
        const tryLink = agent.links?.find(l => l.label === "Try it yourself");
        if (tryLink) {
            const tryBtn = el("a", { class: "demo-try-btn", href: tryLink.href, target: "_blank", rel: "noopener noreferrer" });
            tryBtn.innerHTML = `<span>↗</span><span>Try it yourself</span>`;
            demoRow.appendChild(tryBtn);
        }
        videoSec.appendChild(demoRow);
        body.append(videoSec);
    } else {
        // No demo video — show "Try it live" in the demo section if present
        const tryItLive = agent.links?.find(({ label, href }) =>
            label === "Try it live" && href && href.startsWith("/#")
        );
        if (tryItLive) {
            overlay._isAtlas = true;
            const videoSec = el("div", { class: "agent-panel-section agent-panel-video" });
            videoSec.append(el("p", { class: "agent-panel-eyebrow" }, "// demo"));
            const demoRow = el("div", { class: "demo-btn-row" });
            const tryBtn = el("button", { class: "demo-try-btn", type: "button" });
            tryBtn.innerHTML = `<span>↗</span><span>Try it live</span>`;
            tryBtn.addEventListener("click", () => _openAtlasWidget());
            demoRow.appendChild(tryBtn);
            videoSec.appendChild(demoRow);
            body.append(videoSec);
        }
    }

    body.append(diagSection);
    body.append(titleBlock);
    if (traitsSection) body.append(traitsSection);
    if (stepsSection) body.append(stepsSection);
    if (techSection) body.append(techSection);

    inner.append(hdr, body);

    // Scroll root sits between the animated overlay and the content.
    // This isolates GSAP's opacity/transform on the overlay from the scroll
    // hit-testing, fixing the "scroll dead on Android" bug.
    const scrollRoot = el("div", { class: "agent-panel-scroll" });
    scrollRoot.appendChild(inner);
    overlay.appendChild(scrollRoot);

    // Links (CTA) sits outside the scroll so it's always visible at the bottom
    if (linksSection) overlay.appendChild(linksSection);

    document.body.appendChild(overlay);

    // Close when tapping the backdrop (overlay or the scroll root gutter)
    const onBackdrop = e => { if (e.target === overlay || e.target === scrollRoot) closePanel(overlay); };
    overlay.addEventListener("click", onBackdrop);
    const onKey = e => { if (e.key === "Escape") { closePanel(overlay); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);

    // Store inlined SVG reference for post-open animation
    overlay._diagSvg = inlinedSvg;

    return overlay;
}

function openPanel(overlay) {
    // Do NOT touch body.overflow — on Android Chrome, body overflow:hidden
    // kills touch-scroll in ALL position:fixed children (panel + fullscreen).
    // overscroll-behavior:contain on .agent-panel-scroll prevents chaining.
    overlay.classList.add("is-open");
    activePanel = overlay;
    if (overlay._isAtlas) document.body.setAttribute("data-deep-dive-open", "true");
    if (overlay._agentId) {
        history.pushState({ agentId: overlay._agentId }, "", `/live-agents/?agent=${overlay._agentId}`);
    }

    const gsap = window.gsap;
    if (gsap && !REDUCE_MOTION) {
        gsap.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.22, ease: "power2.out" });
        const inner = overlay.querySelector(".agent-panel-inner");
        const isMobile = matchMedia("(max-width: 767px)").matches;
        // On mobile: fade only — no translateY. A transform on the inner
        // creates a GPU compositing layer that blocks scroll hit-testing on
        // Android Chrome when the parent is the scroll container.
        gsap.fromTo(inner,
            isMobile ? { opacity: 0 } : { y: 32, opacity: 0 },
            {
                ...(isMobile ? {} : { y: 0 }),
                opacity: 1, duration: 0.32, ease: "power3.out", delay: 0.08,
                onComplete() {
                    if (overlay._diagSvg) overlay._diagTl = animateDiagram(overlay._diagSvg);
                },
            }
        );
    } else if (overlay._diagSvg) {
        setTimeout(() => { overlay._diagTl = animateDiagram(overlay._diagSvg); }, 80);
    }
}

function closePanel(overlay, onComplete) {
    const gsap = window.gsap;
    overlay._diagTl?.kill();
    history.replaceState(null, "", "/live-agents/");
    document.body.removeAttribute("data-deep-dive-open");
    window.__agentWidget?.close?.();

    const done = () => {
        overlay.classList.remove("is-open");
        overlay.remove();
        activePanel = null;
        onComplete?.();
    };
    if (gsap && !REDUCE_MOTION) {
        gsap.to(overlay, { opacity: 0, duration: 0.18, ease: "power2.in", onComplete: done });
    } else {
        done();
    }
}

// ─── Agent index: capability matrix (spec 89) ─────────────────────────────────
//
// One row per agent, one column per capability, grouped under three plain
// headings so a visitor knows what kind of thing each column is: how you
// talk to it, how it runs, and what it's built with (Anthropic's
// "augmented LLM" building blocks: retrieval, tools, memory). It replaced
// 25 filter chips for four agents, most of which matched exactly one.
// A capability's header filters the cards; an agent's name jumps to its
// card; a lit dot explains itself in the readout strip, from that agent's
// agents.json → index.evidence. Keys are stable; labels live here.

const CAPABILITY_GROUPS = [
    { key: "talk",  label: "Talk to it",  short: "Talk" },
    { key: "runs",  label: "How it runs", short: "Runs" },
    { key: "built", label: "Built with",  short: "Built" },
];

const CAPABILITIES = [
    { key: "text",       group: "talk",  label: "Chat",        hint: "Type a question and get a written answer.", tone: "text" },
    { key: "voice",      group: "talk",  label: "Voice",       hint: "Speak to it and it speaks back.", tone: "voice" },
    { key: "avatar",     group: "talk",  label: "Avatar",      hint: "A face on camera that talks back in real time.", tone: "avatar" },
    { key: "ondemand",   group: "runs",  label: "On demand",   hint: "Runs when a person asks, and answers right then." },
    { key: "autonomous", group: "runs",  label: "Ambient",     hint: "Works in the background on its own schedule, with nobody in the loop." },
    { key: "team",       group: "runs",  label: "Multi-agent", hint: "A team of agents with their own jobs, run by an orchestrator." },
    { key: "cites",      group: "built", label: "Retrieval",   hint: "Looks things up in real sources before it answers." },
    { key: "acts",       group: "built", label: "Tools",       hint: "Does things, like writing data, sending email or calling APIs." },
    { key: "learns",     group: "built", label: "Memory",      hint: "Keeps what it learned and uses it next time." },
];

// One date per agent: "updated Oct 2026" after a meaningful update,
// otherwise "shipped May 2026". It dates the model choice, so a model that
// was the newest when the agent shipped reads as of its time, not stale.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function agentStamp(agent) {
    const ym = agent.index?.updated || agent.index?.shipped;
    const m = /^(\d{4})-(\d{2})$/.exec(ym || "");
    if (!m) return "";
    return `${agent.index?.updated ? "updated" : "shipped"} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

// The model family's official mark, the same files the chat widget and the
// labs use. Unknown families get no logo rather than a wrong one.
function modelLogo(name) {
    if (/^claude/i.test(name)) return "/assets/img/logo-claude.svg";
    if (/^gemini/i.test(name)) return "/assets/img/logo-gemini.svg";
    return "";
}

function buildAgentIndex(agents, cards) {
    const caps = CAPABILITIES.filter(c => agents.some(a => a.index?.capabilities?.includes(c.key)));
    const has = (agent, key) => !!agent.index?.capabilities?.includes(key);

    const bar = el("div", { class: "agent-search-bar agent-console", role: "search" });
    ["tl", "tr", "bl", "br"].forEach(pos =>
        bar.appendChild(el("span", { class: `console-corner console-corner--${pos}`, "aria-hidden": "true" })),
    );

    // Input row
    const inputWrap = el("div", { class: "agent-search-input-wrap" });
    const prompt    = el("span", { class: "agent-search-prompt", "aria-hidden": "true" });
    prompt.innerHTML = "&gt;_";
    const input = el("input", {
        class: "agent-search-field",
        type: "search",
        placeholder: "query the agent index…",
        autocomplete: "off",
        spellcheck: false,
        "aria-label": "Search agents by name, model, or what they can do",
    });
    const hint = el("kbd", { class: "agent-search-hint", "aria-hidden": "true" }, "/");
    const clearBtn = el("button", { class: "agent-search-clear", type: "button", "aria-label": "Clear search and filters" });
    clearBtn.hidden = true;
    clearBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
    const readout = el("span", { class: "agent-search-readout" });
    const statusDot = el("span", { class: "agent-search-status", "aria-hidden": "true" });
    const countBadge = el("span", { class: "agent-search-count", "aria-live": "polite" });
    countBadge.textContent = `${agents.length} agents`;
    readout.append(statusDot, countBadge);
    inputWrap.append(prompt, input, hint, clearBtn, readout);

    // ── The matrix ──
    // Table semantics over one CSS grid. Rows are agents, columns are
    // capabilities, then the model. Row wrappers use display: contents, so
    // every cell sits on the same grid and a column's light trace can run
    // down across rows.
    const matrix = el("div", { class: "agent-matrix", role: "table", "aria-label": "What each agent can do" });
    matrix.style.setProperty("--caps", caps.length);
    matrix.appendChild(el("span", { class: "am-scan", "aria-hidden": "true" }));
    // Columns are CSS variables, not inline grid-column, so the phone layout
    // can re-place cells: --gc is the desktop column, --gcm the column
    // within its group when phones show one group at a time.
    const place = (node, row, column, phoneColumn, group) => {
        node.style.gridRow = String(row);
        node.style.setProperty("--gc", String(column));
        if (phoneColumn != null) node.style.setProperty("--gcm", String(phoneColumn));
        if (group) node.dataset.group = group;
    };
    // Where each capability sits within its own group (0, 1, 2).
    const inGroup = caps.map((k, c) => caps.slice(0, c).filter(x => x.group === k.group).length);

    // Group row: three headings over their columns. Decorative for the
    // table semantics; each column's accessible name already says it all.
    const firstOfGroup = new Set();
    CAPABILITY_GROUPS.forEach(g => {
        const cols = caps.map((k, c) => (k.group === g.key ? c : -1)).filter(c => c >= 0);
        if (!cols.length) return;
        firstOfGroup.add(cols[0]);
        const gh = el("div", { class: "am-group", "aria-hidden": "true" });
        place(gh, 1, `${cols[0] + 2} / ${cols[cols.length - 1] + 3}`, null, g.key);
        gh.innerHTML = `<span class="am-group-label" data-short=""></span>`;
        const lbl = gh.querySelector(".am-group-label");
        lbl.textContent = g.label;
        lbl.dataset.short = g.short;
        if (cols[0] > 0) gh.classList.add("is-split");
        matrix.appendChild(gh);
    });

    // Header row: capabilities (each one a filter) and the model column
    const headRow = el("div", { class: "am-row am-head", role: "row" });
    const corner = el("span", { class: "am-corner", role: "columnheader" }, `<span class="am-corner-label">agent</span>`);
    place(corner, "1 / 3", 1);
    headRow.appendChild(corner);
    const capHeads = caps.map((cap, c) => {
        const th = el("div", { class: "am-colhead", role: "columnheader" });
        place(th, 2, c + 2, inGroup[c] + 2, cap.group);
        if (firstOfGroup.has(c) && c > 0) th.classList.add("is-split");
        th.dataset.col = String(c);
        th.style.setProperty("--c", c);
        if (cap.tone) th.dataset.tone = cap.tone;
        const btn = el("button", { class: "am-cap-btn", type: "button", "aria-pressed": "false", title: cap.hint });
        btn.innerHTML = `<span class="am-cap-label"></span><span class="am-rail" aria-hidden="true"></span>`;
        btn.querySelector(".am-cap-label").textContent = cap.label;
        btn.setAttribute("aria-label", `${cap.label}: ${cap.hint} Show only agents that have it.`);
        btn.addEventListener("pointerenter", () => showReadout(null, cap));
        btn.addEventListener("focus", () => showReadout(null, cap));
        btn.addEventListener("click", () => toggleCap(cap.key));
        th.appendChild(btn);
        headRow.appendChild(th);
        return { th, btn, key: cap.key };
    });
    const modelHead = el("span", { class: "am-colhead am-model-head", role: "columnheader" }, `<span class="am-corner-label">model</span>`);
    place(modelHead, "1 / 3", caps.length + 2, "2 / -1", "model");
    headRow.appendChild(modelHead);
    matrix.appendChild(headRow);

    // Agent rows
    const rows = agents.map((agent, r) => {
        const gridRow = r + 3;
        const row = el("div", { class: "am-row am-agent-row", role: "row" });
        const rh = el("div", { class: "am-rowhead", role: "rowheader" });
        place(rh, gridRow, 1);
        rh.style.setProperty("--r", r);
        rh.dataset.row = String(r);
        const live = String(agent.status || "LIVE").toUpperCase() === "LIVE";
        const btn = el("button", { class: "am-agent", type: "button", "aria-label": `${agent.name}, ${agent.role}: jump to its card` });
        btn.innerHTML =
            `<span class="am-led${live ? " is-live" : ""}" aria-hidden="true"></span>` +
            `<span class="am-agent-text"><span class="am-agent-name"></span><span class="am-agent-role"></span></span>`;
        btn.querySelector(".am-agent-name").textContent = agent.name;
        btn.querySelector(".am-agent-role").textContent = agent.role || "";
        btn.addEventListener("click", () => jumpTo(r));
        rh.appendChild(btn);
        row.appendChild(rh);

        caps.forEach((cap, c) => {
            const on = has(agent, cap.key);
            const cell = el("div", { class: `am-cell${on ? " is-on" : ""}`, role: "cell" });
            place(cell, gridRow, c + 2, inGroup[c] + 2, cap.group);
            cell.dataset.col = String(c);
            cell.dataset.row = String(r);
            cell.style.setProperty("--r", r);
            cell.style.setProperty("--c", c);
            if (cap.tone) cell.dataset.tone = cap.tone;
            if (firstOfGroup.has(c) && c > 0) cell.classList.add("is-split");
            const why = agent.index?.evidence?.[cap.key] || "";
            cell.innerHTML = on
                ? `<span class="am-node" aria-hidden="true"><i></i></span><span class="sr-only"></span>`
                : `<span class="am-off" aria-hidden="true"></span><span class="sr-only">no</span>`;
            if (on) {
                // A lit dot explains itself: hover, focus or tap shows how.
                cell.querySelector(".sr-only").textContent = why ? `Yes. ${why}` : "yes";
                cell.tabIndex = 0;
                const show = () => showReadout(agent, cap, why);
                cell.addEventListener("pointerenter", show);
                cell.addEventListener("focus", show);
                cell.addEventListener("click", show);
            }
            row.appendChild(cell);
        });

        const model = el("div", { class: "am-cell am-model", role: "cell" }, "");
        const modelName = agent.index?.model || "";
        const logo = modelLogo(modelName);
        model.innerHTML = (logo ? `<img class="am-model-logo" src="${logo}" alt="" width="16" height="16" loading="lazy">` : "") +
            `<span class="am-model-name"></span>`;
        // "Gemini 3.6 Flash · Gemini 3.8 Live" reads as two models, one per
        // line, given equal weight: the second one powers Atlas's avatar.
        const nameEl = model.querySelector(".am-model-name");
        modelName.split(" · ").forEach((part, i) => {
            const line = el("span", { class: "am-model-line" });
            line.textContent = part;
            nameEl.appendChild(line);
        });
        const stamp = agentStamp(agent);
        if (stamp) nameEl.appendChild(el("span", { class: "am-model-date" }, stamp));
        place(model, gridRow, caps.length + 2, "2 / -1", "model");
        model.dataset.row = String(r);
        model.style.setProperty("--r", r);
        row.appendChild(model);

        matrix.appendChild(row);
        return row;
    });

    // A light trace runs down each capability's column, from its first agent
    // to its last, centre to centre, joining the agents that share it.
    caps.forEach((cap, c) => {
        const lit = agents.map((a, r) => (has(a, cap.key) ? r : -1)).filter(r => r >= 0);
        if (lit.length < 2) return;
        const from = lit[0], to = lit[lit.length - 1];
        const trace = el("span", { class: "am-trace", "aria-hidden": "true" });
        place(trace, `${from + 3} / ${to + 4}`, c + 2, inGroup[c] + 2, cap.group);
        trace.style.setProperty("--span", to - from + 1);
        trace.style.setProperty("--c", c);
        trace.dataset.col = String(c);
        trace.appendChild(el("i", { class: "am-pulse" }));
        matrix.appendChild(trace);
    });

    // Column hover: the capability's cells light up as one vertical beam;
    // row hover is plain CSS (each agent's row tints).
    let hot = null;
    const setHot = (c) => {
        if (c === hot) return;
        hot = c;
        matrix.querySelectorAll("[data-col]").forEach(n => n.classList.toggle("is-hot", n.dataset.col === c));
    };
    let hotRow = null;
    const setHotRow = (r) => {
        if (r === hotRow) return;
        hotRow = r;
        matrix.querySelectorAll("[data-row]").forEach(n => n.classList.toggle("is-row-hot", n.dataset.row === r));
    };
    matrix.addEventListener("pointerover", e => {
        setHot(e.target.closest(".am-cell[data-col], .am-colhead[data-col]")?.dataset.col ?? null);
        setHotRow(e.target.closest("[data-row]")?.dataset.row ?? null);
    });
    matrix.addEventListener("pointerleave", () => { setHot(null); setHotRow(null); resetReadout(); });
    matrix.addEventListener("focusout", e => { if (!matrix.contains(e.relatedTarget)) resetReadout(); });

    // ── Phones: one group at a time, behind a segmented switch ──
    // Nine columns don't fit a phone. Each group has three, so a phone
    // shows one group (plus a Model tab) as a tidy 4 x 3 grid. Hidden on
    // wider screens by CSS; the matrix carries the active group.
    const tabs = el("div", { class: "am-tabs", role: "tablist", "aria-label": "Capability group" });
    const tabDefs = [...CAPABILITY_GROUPS.filter(g => caps.some(k => k.group === g.key)), { key: "model", label: "Model" }];
    const tabBtns = tabDefs.map(g => {
        const t = el("button", { class: "am-tab", type: "button", role: "tab", "aria-selected": "false" });
        t.textContent = g.label;
        t.dataset.group = g.key;
        t.addEventListener("click", () => selectGroup(g.key));
        tabs.appendChild(t);
        return t;
    });
    function selectGroup(key) {
        matrix.dataset.group = key;
        tabBtns.forEach(t => t.setAttribute("aria-selected", String(t.dataset.group === key)));
        resetReadout();
    }

    // ── Readout strip: what the thing under the pointer actually means ──
    const strip = el("div", { class: "am-readout", "aria-hidden": "true" });
    strip.innerHTML =
        `<span class="am-readout-caret">&gt;</span>` +
        `<span class="am-readout-tag"></span>` +
        `<span class="am-readout-text"></span>`;
    const roTag = strip.querySelector(".am-readout-tag");
    const roText = strip.querySelector(".am-readout-text");
    const READOUT_IDLE = matchMedia("(hover: none)").matches
        ? "tap a dot to see how each agent does it"
        : "point at a dot to see how each agent does it";
    function setReadout(tag, text, tone) {
        roTag.textContent = tag;
        roText.textContent = text;
        strip.dataset.tone = tone || "";
        strip.classList.toggle("is-idle", !tag);
        // Retype: restart the reveal on every change.
        roText.classList.remove("is-typing");
        void roText.offsetWidth;
        roText.classList.add("is-typing");
        roText.style.setProperty("--chars", Math.max(8, text.length));
    }
    function showReadout(agent, cap, why) {
        if (agent) setReadout(`${agent.name} · ${cap.label}`, why || cap.hint, cap.tone);
        else setReadout(cap.label, cap.hint, cap.tone);
    }
    function resetReadout() { setReadout("", READOUT_IDLE, ""); }
    resetReadout();
    selectGroup(tabDefs[0].key);

    // Empty state (rendered inside grid via caller)
    const emptyState = el("div", { class: "agents-empty" });
    emptyState.hidden = true;
    emptyState.innerHTML = `<span class="agents-empty-prompt" aria-hidden="true">&gt;_ </span>no agents match, try a different search`;

    bar.append(inputWrap, tabs, matrix, strip);

    // ── State & filter logic ──────────────────────────────────────
    let query = "";
    let activeCap = null;

    function matches(agent) {
        if (activeCap && !has(agent, activeCap)) return false;
        if (query) {
            const q = query.toLowerCase();
            const hay = [
                agent.name, agent.subtitle, agent.role, agent.headline,
                agent.description, ...(agent.stack || []), agent.index?.model,
                ...caps.filter(k => has(agent, k.key)).map(k => k.label),
            ].join(" ").toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    }

    function setVisible(card, show) {
        if (show) {
            card.style.display = "";
            requestAnimationFrame(() => card.classList.remove("is-filtered-out"));
        } else {
            card.classList.add("is-filtered-out");
            setTimeout(() => { if (card.classList.contains("is-filtered-out")) card.style.display = "none"; }, 280);
        }
    }

    function applyFilters() {
        let count = 0;
        agents.forEach((agent, r) => {
            const ok = matches(agent);
            setVisible(cards[r], ok);
            matrix.querySelectorAll(`[data-row="${r}"]`).forEach(n => n.classList.toggle("is-dim", !ok));
            if (ok) count++;
        });
        capHeads.forEach(({ th, btn, key }, c) => {
            const on = key === activeCap;
            th.classList.toggle("is-locked", on);
            btn.setAttribute("aria-pressed", String(on));
            matrix.querySelectorAll(`.am-cell[data-col="${c}"], .am-trace[data-col="${c}"]`).forEach(n => n.classList.toggle("is-locked", on));
        });
        matrix.classList.toggle("has-lock", !!activeCap);
        const hasFilter = !!(query || activeCap);
        clearBtn.hidden = !hasFilter;
        countBadge.textContent = hasFilter ? `${count} of ${agents.length}` : `${agents.length} agents`;
        emptyState.hidden = count > 0;
    }

    function toggleCap(key) {
        activeCap = activeCap === key ? null : key;
        applyFilters();
    }

    function clearAll() {
        input.value = "";
        query = "";
        activeCap = null;
        applyFilters();
    }

    // An agent's header: bring its card into view and ping it. A filter
    // that hides that card is cleared first, so the jump always lands.
    function jumpTo(r) {
        if (!matches(agents[r])) clearAll();
        const card = cards[r];
        card.scrollIntoView({ behavior: REDUCE_MOTION ? "auto" : "smooth", block: "center" });
        card.classList.remove("is-pinged");
        void card.offsetWidth; // restart the ping on a quick re-click
        card.classList.add("is-pinged");
        setTimeout(() => card.classList.remove("is-pinged"), 1600);
    }

    input.addEventListener("input", () => { query = input.value.trim(); applyFilters(); });
    clearBtn.addEventListener("click", () => { clearAll(); input.focus(); });

    // "/" shortcut to focus search when not already in an input
    document.addEventListener("keydown", e => {
        if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
            e.preventDefault();
            input.focus();
            input.select();
        }
    });

    // Power on once, the first time the matrix scrolls into view.
    if (REDUCE_MOTION || typeof IntersectionObserver !== "function") {
        matrix.classList.add("is-on", "is-settled");
    } else {
        const io = new IntersectionObserver(entries => {
            if (!entries.some(en => en.isIntersecting)) return;
            io.disconnect();
            matrix.classList.add("is-on");
            // After the boot sequence, drop the per-cell delays so hover and
            // filter transitions respond immediately.
            setTimeout(() => matrix.classList.add("is-settled"), 1800);
        }, { threshold: 0.25 });
        io.observe(matrix);
    }

    return { bar, emptyState };
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

function runEntranceAnimation(grid) {
    const gsap = window.gsap;
    grid.classList.add("is-visible");
    if (!gsap || REDUCE_MOTION) return;
    gsap.fromTo(grid.querySelectorAll(".agent-card"),
        { opacity: 0, y: 28 },
        { opacity: 1, y: 0, duration: 0.45, ease: "power3.out", stagger: 0.1, delay: 0.1, clearProps: "opacity,transform" }
    );
}

// Page chrome (year, nav drawer, resume redirect, Insights flyout). Lives
// here — not in an inline <script> — because the page CSP is `script-src
// 'self'` with no 'unsafe-inline', so inline scripts are blocked. This
// module is loaded via <script src> and is allowed.
function initPageChrome() {
    const yearEl = document.getElementById("agents-year");
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    initNavDrawer();

    document.querySelectorAll("[data-resume-trigger-agents]").forEach(eln => {
        eln.addEventListener("click", e => {
            e.preventDefault();
            window.location.href = "/#";
        });
    });

    initInsightsFlyout();
}

// Reuse the exact initPostsFlyout from posts-list.js so the live-agents nav
// gets the identical dropdown as the main page.
function initInsightsFlyout() {
    const flyoutRoot = document.querySelector("[data-posts-flyout]");
    if (!flyoutRoot) return;
    import(_vq("./posts-list.js")).then(({ initPostsFlyout }) =>
        initPostsFlyout(flyoutRoot)
    ).then(inst => {
        if (!inst) return;
        // posts-list sets the footer href to "#insights" (same-page on
        // the main site). Here it must be the cross-page path.
        const footLink = flyoutRoot.querySelector(".nav-flyout-foot");
        if (footLink) footLink.href = "/#insights";

        const group = flyoutRoot.closest("[data-flyout-group]");
        const link  = group && group.querySelector("a[aria-haspopup]");
        if (!group || !link) return;
        const sync = open => link.setAttribute("aria-expanded", open ? "true" : "false");
        group.addEventListener("mouseenter", () => sync(true));
        group.addEventListener("mouseleave", () => sync(false));
        group.addEventListener("focusin",   () => sync(true));
        group.addEventListener("focusout",  () => sync(false));
        if (matchMedia("(any-pointer: coarse)").matches) {
            link.addEventListener("click", e => {
                if (!group.classList.contains("is-open")) {
                    e.preventDefault();
                    group.classList.add("is-open");
                    sync(true);
                }
            });
            document.addEventListener("click", e => {
                if (group.classList.contains("is-open") && !group.contains(e.target)) {
                    group.classList.remove("is-open");
                    sync(false);
                }
            });
        }
    }).catch(err => console.warn("[agents-page] insights flyout failed", err));
}

// WebMCP (spec 45). Fire-and-forget: fetches profile.json independently of
// this page's own content fetch (best-effort, never blocks page render) and
// registers this page's scoped tool subset if the browser exposes the API.
function initWebMcp() {
    const hasApi = () => document.modelContext || navigator.modelContext;
    const start = async () => {
        try {
            const base = document.querySelector("base")?.href || window.location.origin + "/";
            const profile = await fetch(new URL(_vq("content/profile.json"), base)).then(r => r.json());
            const { registerWebMcp } = await import(_vq("./webmcp.js"));
            await registerWebMcp({ scope: "live-agents", profile });
        } catch (err) {
            console.debug("[webmcp] unavailable", err);
        }
    };
    if (hasApi()) return void start();
    let tries = 0;
    const recheck = () => {
        if (hasApi()) return void start();
        if (++tries >= 2) return;
    };
    window.addEventListener("load", recheck, { once: true });
    setTimeout(recheck, 1500);
}

async function init() {
    playEntranceWipe();
    initPageChrome();
    initWebMcp();

    try {
        await initGrid();
    } finally {
        // Fires on every exit path from initGrid (missing root, failed
        // fetch, or success) — an in-flight transition waiting on this
        // signal must not hang because the page had nothing to show.
        signalPageReady();
    }

    document.addEventListener("click", async e => {
        const a = e.target.closest("[data-page-link]");
        if (!a) return;
        const href = a.getAttribute("href");
        if (!href) return;
        e.preventDefault();
        runPageTransition(href);
    });
}

async function initGrid() {
    const root = document.querySelector("[data-agents-root]");
    if (!root) return;

    let agents;
    try {
        const base = document.querySelector("base")?.href || window.location.origin + "/";
        agents = await fetch(new URL("content/agents.json?v=199", base)).then(r => r.json());
    } catch (err) {
        console.warn("[agents-page] agents.json load failed", err);
        root.innerHTML = `<p style="font-family:var(--font-mono);color:var(--ink-muted);font-size:0.875rem">// agent data unavailable</p>`;
        return;
    }

    const grid  = el("div", { class: "agents-grid" });
    const cards = [];

    agents.forEach(agent => {
        const card = buildCard(agent, async (a) => {
            const panel = await buildPanel(a);
            panel._agentId = a.id;
            openPanel(panel);
        });
        cards.push(card);
        grid.appendChild(card);
    });

    // Deep-link: open panel if ?agent=<id> is in the URL on page load
    const deepId = new URLSearchParams(location.search).get("agent");
    if (deepId) {
        const target = agents.find(a => a.id === deepId);
        // Spec 80: ?view=diagram (Atlas opening "its diagram") goes straight to
        // the fullscreen diagram, the same way the expand button does. Read it
        // now: openPanel() rewrites the URL to ?agent=<id>.
        const wantDiagram = new URLSearchParams(location.search).get("view") === "diagram";
        if (target) buildPanel(target).then(panel => {
            panel._agentId = target.id;
            openPanel(panel);
            if (wantDiagram) {
                const expand = panel.querySelector(".agent-diag-expand");
                if (expand) setTimeout(() => expand.click(), 450); // after the panel's slide-in
            }
        });
    }

    const { bar, emptyState } = buildAgentIndex(agents, cards);
    root.appendChild(bar);

    const teaser = el("div", { class: "agents-teaser" });
    teaser.innerHTML = `
        <div class="agents-teaser-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        </div>
        <span class="agents-teaser-text">// more agents in flight, on different stacks, added as Gaurav ships them</span>`;
    grid.appendChild(teaser);
    grid.appendChild(emptyState);

    root.appendChild(grid);

    if (window.gsap) {
        runEntranceAnimation(grid);
    } else {
        window.addEventListener("load", () => runEntranceAnimation(grid), { once: true });
        setTimeout(() => runEntranceAnimation(grid), 800);
    }
}

function _openVideoModal(src) {
    const overlay = el("div", { class: "video-modal-overlay", role: "dialog", "aria-modal": "true" });
    const wrap = el("div", { class: "video-modal-wrap" });
    const closeBtn = el("button", { class: "video-modal-close", "aria-label": "Close" }, "✕");

    // Video with native controls — no autoplay (blocked by browsers)
    const vid = document.createElement("video");
    vid.className = "video-modal-player";
    vid.controls = true;
    vid.playsInline = true;
    vid.preload = "auto";
    const source = document.createElement("source");
    source.src = src;
    source.type = "video/mp4";
    vid.appendChild(source);

    // Big centred play overlay — disappears once video starts
    const playOverlay = el("div", { class: "video-play-overlay" });
    playOverlay.innerHTML = `<div class="video-play-btn">▶</div>`;
    playOverlay.addEventListener("click", () => {
        vid.play();
        playOverlay.style.display = "none";
    });
    vid.addEventListener("play", () => { playOverlay.style.display = "none"; });
    vid.addEventListener("pause", () => { if (vid.paused && !vid.ended) playOverlay.style.display = "flex"; });

    wrap.append(closeBtn, vid, playOverlay);
    overlay.appendChild(wrap);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("video-modal-visible"));

    const close = () => {
        vid.pause();
        overlay.classList.remove("video-modal-visible");
        setTimeout(() => overlay.remove(), 250);
    };
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", function esc(e) {
        if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
