// agents-page.js — /agents/ bootstrap

import { playEntranceWipe, runPageTransition } from "./page-transition.js";

const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

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
        "aria-label": `${agent.name} — ${agent.role}`,
    });

    const meta = el("div", { class: "agent-card-meta" });
    meta.append(
        el("span", { class: "agent-card-status" }, agent.status || "LIVE"),
        el("span", { class: "agent-card-role" }, agent.role),
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
            src: agent.diagramSvg + "?v=177",
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
        "aria-label": "Architecture diagram — fullscreen",
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
        const resp = await fetch(new URL(url + "?v=177", base));
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

    // Links
    let linksSection = null;
    if (agent.links && agent.links.length) {
        linksSection = el("div", { class: "agent-panel-section agent-panel-links" });
        agent.links.forEach(({ label, href }) => {
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

    // Single-column layout: diagram full-width on top, all content below
    const body = el("div", { class: "agent-panel-body" });

    body.append(diagSection);
    body.append(titleBlock);
    if (traitsSection) body.append(traitsSection);
    if (stepsSection) body.append(stepsSection);
    if (techSection) body.append(techSection);
    if (linksSection) body.append(linksSection);

    inner.append(hdr, body);

    // Scroll root sits between the animated overlay and the content.
    // This isolates GSAP's opacity/transform on the overlay from the scroll
    // hit-testing, fixing the "scroll dead on Android" bug.
    const scrollRoot = el("div", { class: "agent-panel-scroll" });
    scrollRoot.appendChild(inner);
    overlay.appendChild(scrollRoot);
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

function closePanel(overlay) {
    const gsap = window.gsap;
    // Kill the looping diagram animation timeline
    overlay._diagTl?.kill();

    const done = () => {
        overlay.classList.remove("is-open");
        overlay.remove();
        activePanel = null;
    };
    if (gsap && !REDUCE_MOTION) {
        gsap.to(overlay, { opacity: 0, duration: 0.18, ease: "power2.in", onComplete: done });
    } else {
        done();
    }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

function runEntranceAnimation(grid) {
    const gsap = window.gsap;
    grid.classList.add("is-visible");
    if (!gsap || REDUCE_MOTION) return;
    gsap.fromTo(grid.querySelectorAll(".agent-card"),
        { opacity: 0, y: 28 },
        { opacity: 1, y: 0, duration: 0.45, ease: "power3.out", stagger: 0.1, delay: 0.1 }
    );
}

async function init() {
    playEntranceWipe();

    const root = document.querySelector("[data-agents-root]");
    if (!root) return;

    let agents;
    try {
        const base = document.querySelector("base")?.href || window.location.origin + "/";
        agents = await fetch(new URL("assets/js/data/agents.json?v=185", base)).then(r => r.json());
    } catch (err) {
        console.warn("[agents-page] agents.json load failed", err);
        root.innerHTML = `<p style="font-family:var(--font-mono);color:var(--ink-muted);font-size:0.875rem">// agent data unavailable</p>`;
        return;
    }

    const grid = el("div", { class: "agents-grid" });

    agents.forEach(agent => {
        const card = buildCard(agent, async (a) => {
            const panel = await buildPanel(a);
            openPanel(panel);
        });
        grid.appendChild(card);
    });

    const teaser = el("div", { class: "agents-teaser" });
    teaser.innerHTML = `
        <div class="agents-teaser-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        </div>
        <span class="agents-teaser-text">// more agents in flight — different stacks, added as Gaurav ships them</span>`;
    grid.appendChild(teaser);

    root.appendChild(grid);

    if (window.gsap) {
        runEntranceAnimation(grid);
    } else {
        window.addEventListener("load", () => runEntranceAnimation(grid), { once: true });
        setTimeout(() => runEntranceAnimation(grid), 800);
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

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
