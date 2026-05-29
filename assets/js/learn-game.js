// learn-game.js — /learn/ bootstrap: state machine + screen renderers +
// interaction handlers + GSAP feedback. Content comes from data/learn.json;
// no copy is hardcoded here.

import { playEntranceWipe, runPageTransition } from "./page-transition.js";
import { createStore, load, clearSaved } from "./learn/state.js";
import { characterSvg, setPose } from "./learn/characters.js";
import { drawMap } from "./learn/worldmap.js";

const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const base = document.querySelector("base")?.href || window.location.origin + "/";

let DATA = null;
let store = null;
let root = null;
let resume = null;   // { stageIndex } when a saved in-progress game exists

// ─── DOM helper ────────────────────────────────────────────────────────────────
function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === false || v == null) continue;             // skip falsy boolean attrs
        if (k === "class") node.className = v;
        else node.setAttribute(k, v === true ? "" : v);     // attributes, not properties
    }
    for (const c of children) {
        if (typeof c === "string") node.insertAdjacentHTML("beforeend", c);
        else if (c) node.appendChild(c);
    }
    return node;
}

// Resolve a {tech, nontech} field (or a plain string) for the current mode.
function t(field, mode) {
    if (field == null) return "";
    if (typeof field === "object") return field[mode] ?? field.tech ?? field.nontech ?? "";
    return field;
}

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function charAccent(id) {
    const ch = DATA.characters.find(c => c.id === id);
    return ch ? `var(${ch.accentVar})` : "var(--accent)";
}

function modeLabel(mode) {
    return (DATA.modes.find(m => m.id === mode) || {}).label || "";
}

function pointsFor(attempts, meta, isReveal) {
    if (isReveal) return meta.pointsFirstTry;
    if (attempts <= 1) return meta.pointsFirstTry;
    if (attempts === 2) return meta.pointsRetry;
    return meta.pointsReveal;
}

// ─── Feedback animations ─────────────────────────────────────────────────────────
function entrance(node) {
    node.classList.add("is-visible");
    const g = window.gsap;
    if (!g || REDUCE_MOTION) return;
    g.fromTo(node.children,
        { opacity: 0, y: 20 },
        { opacity: 1, y: 0, duration: 0.45, ease: "power3.out", stagger: 0.07, clearProps: "opacity,transform" });
}

function reactCheer(node) {
    setPose(node, "cheer");
    const g = window.gsap;
    if (g && !REDUCE_MOTION) g.fromTo(node, { y: 0 }, { y: -14, duration: 0.2, yoyo: true, repeat: 1, ease: "power2.out", clearProps: "transform" });
}

function reactHurt(node) {
    setPose(node, "hurt");
    const g = window.gsap;
    if (g && !REDUCE_MOTION) g.fromTo(node, { x: 0 }, { x: -6, duration: 0.07, repeat: 5, yoyo: true, ease: "none", clearProps: "transform" });
}

function animateScore(node, from, to) {
    if (!node) return;
    const g = window.gsap;
    if (!g || REDUCE_MOTION) { node.textContent = to; return; }
    const o = { v: from };
    g.to(o, { v: to, duration: 0.5, ease: "power1.out", onUpdate() { node.textContent = Math.round(o.v); }, onComplete() { node.textContent = to; } });
}

function burst(host) {
    const g = window.gsap;
    if (!g || REDUCE_MOTION) return;
    const layer = el("div", { class: "learn-burst", "aria-hidden": "true" });
    host.appendChild(layer);
    const N = 14;
    for (let i = 0; i < N; i++) {
        const dot = el("span", { class: "learn-spark-dot" });
        layer.appendChild(dot);
        const ang = (Math.PI * 2 * i) / N;
        const dist = 40 + Math.random() * 55;
        g.fromTo(dot,
            { x: 0, y: 0, opacity: 1, scale: 1 },
            { x: Math.cos(ang) * dist, y: Math.sin(ang) * dist, opacity: 0, scale: 0.4, duration: 0.6 + Math.random() * 0.3, ease: "power2.out" });
    }
    g.delayedCall(1.1, () => layer.remove());
}

// ─── Interaction renderers ──────────────────────────────────────────────────────
// Each returns a DOM node and reports results via cbs.onCorrect(attempts, isReveal)
// / cbs.onWrong().

function renderQuiz(stage, mode, cbs) {
    let attempts = 0;
    const wrap = el("div", { class: "learn-quiz" });
    const list = el("div", { class: "learn-options", role: "list" });
    stage.options.forEach(opt => {
        const b = el("button", { class: "learn-option", type: "button", "data-id": opt.id });
        b.textContent = t(opt.text, mode);
        b.addEventListener("click", () => {
            if (b.disabled) return;
            attempts++;
            if (opt.correct) {
                list.querySelectorAll(".learn-option").forEach(x => { x.disabled = true; });
                b.classList.add("is-correct");
                cbs.onCorrect(attempts);
            } else {
                b.classList.add("is-wrong");
                b.disabled = true;
                cbs.onWrong();
            }
        });
        list.appendChild(b);
    });
    wrap.appendChild(list);
    return wrap;
}

function renderReveal(stage, mode, cbs) {
    const wrap = el("div", { class: "learn-reveal" });
    const grid = el("div", { class: "learn-flip-grid" });
    let flipped = 0;
    stage.cards.forEach(card => {
        const c = el("button", { class: "learn-flip", type: "button", "aria-pressed": "false", "aria-label": "Reveal fact" });
        c.innerHTML = `<span class="learn-flip-inner">
            <span class="learn-flip-face learn-flip-front">${t(card.front, mode)}</span>
            <span class="learn-flip-face learn-flip-back">${t(card.back, mode)}</span>
        </span>`;
        c.addEventListener("click", () => {
            if (c.classList.contains("is-flipped")) return;
            c.classList.add("is-flipped");
            c.setAttribute("aria-pressed", "true");
            flipped++;
            if (flipped === stage.cards.length) cbs.onCorrect(1, true);
        });
        grid.appendChild(c);
    });
    wrap.appendChild(grid);
    return wrap;
}

// Generic "assign each item to a target". kind: "puzzle" (1 item/slot) | "buckets".
function renderAssignment(stage, mode, cbs, kind) {
    let attempts = 0;
    const targets = kind === "puzzle" ? stage.slots : stage.buckets;
    const items = shuffle(kind === "puzzle" ? stage.pieces : stage.items);
    const solution = {};
    (kind === "puzzle" ? stage.pieces : stage.items).forEach(it => { solution[it.id] = it.slot || it.bucket; });
    const placement = {};        // itemId -> targetId
    let selectedId = null;

    const wrap = el("div", { class: `learn-assign learn-assign-${kind}` });
    const tray = el("div", { class: "learn-tray", role: "list", "aria-label": "Available pieces" });
    const board = el("div", { class: "learn-board" });
    const checkBtn = el("button", { class: "btn btn-ghost btn-sm learn-check", type: "button", disabled: "" }, "Check");

    const itemEls = {};
    const targetEls = {};

    function selectItem(id) {
        selectedId = id;
        Object.entries(itemEls).forEach(([k, b]) => {
            const on = k === id;
            b.classList.toggle("is-selected", on);
            b.setAttribute("aria-grabbed", on ? "true" : "false");
        });
    }

    function renderPlacements() {
        targets.forEach(tg => targetEls[tg.id].list.replaceChildren());
        items.forEach(it => {
            const node = itemEls[it.id];
            node.classList.remove("is-correct", "is-wrong", "is-selected");
            node.setAttribute("aria-grabbed", "false");
            const tid = placement[it.id];
            if (tid && targetEls[tid]) targetEls[tid].list.appendChild(node);
            else tray.appendChild(node);
        });
    }

    function updateCheck() {
        checkBtn.disabled = Object.keys(placement).length !== items.length;
    }

    function placeSelected(targetId) {
        if (!selectedId) return;
        if (kind === "puzzle") {
            Object.keys(placement).forEach(k => { if (placement[k] === targetId && k !== selectedId) delete placement[k]; });
        }
        placement[selectedId] = targetId;
        selectedId = null;
        renderPlacements();
        updateCheck();
    }

    items.forEach(it => {
        const b = el("button", { class: "learn-drag-item", type: "button", "data-id": it.id, "aria-grabbed": "false", draggable: "true" });
        b.textContent = t(it.label, mode);
        b.addEventListener("click", () => selectItem(it.id));
        b.addEventListener("dragstart", e => { selectItem(it.id); e.dataTransfer.setData("text/plain", it.id); });
        itemEls[it.id] = b;
        tray.appendChild(b);
    });

    targets.forEach(tg => {
        const zone = el("div", { class: "learn-drop", "data-target": tg.id, role: "button", tabindex: "0", "aria-label": `Drop into ${t(tg.label, mode)}` });
        const head = el("div", { class: "learn-drop-head" }, t(tg.label, mode));
        const listEl = el("div", { class: "learn-drop-list" });
        zone.append(head, listEl);
        const place = () => placeSelected(tg.id);
        zone.addEventListener("click", e => { if (e.target.closest(".learn-drag-item")) { return; } place(); });
        zone.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); place(); } });
        zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("is-over"); });
        zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
        zone.addEventListener("drop", e => {
            e.preventDefault();
            zone.classList.remove("is-over");
            const id = e.dataTransfer.getData("text/plain") || selectedId;
            if (id) { selectedId = id; placeSelected(tg.id); }
        });
        targetEls[tg.id] = { zone, list: listEl };
        board.appendChild(zone);
    });

    checkBtn.addEventListener("click", () => {
        attempts++;
        let ok = true;
        items.forEach(it => {
            const right = placement[it.id] === solution[it.id];
            itemEls[it.id].classList.toggle("is-correct", right);
            itemEls[it.id].classList.toggle("is-wrong", !right);
            if (!right) ok = false;
        });
        if (ok) {
            Object.values(itemEls).forEach(b => { b.disabled = true; b.setAttribute("draggable", "false"); });
            checkBtn.disabled = true;
            cbs.onCorrect(attempts);
        } else {
            cbs.onWrong();
        }
    });

    wrap.append(tray, board, checkBtn);
    return wrap;
}

function renderSortOrder(stage, mode, cbs) {
    let attempts = 0;
    const correct = stage.steps.map(s => s.id);
    let order = shuffle(stage.steps);
    let guard = 0;
    while (order.every((s, i) => s.id === correct[i]) && guard++ < 8) order = shuffle(stage.steps);

    const wrap = el("div", { class: "learn-order" });
    const list = el("ol", { class: "learn-order-list" });
    const checkBtn = el("button", { class: "btn btn-ghost btn-sm learn-check", type: "button" }, "Check order");

    function swap(i, j) { [order[i], order[j]] = [order[j], order[i]]; renderList(); }

    function renderList() {
        list.replaceChildren();
        order.forEach((step, idx) => {
            const li = el("li", { class: "learn-order-row" });
            const label = el("span", { class: "learn-order-label" }, t(step.label, mode));
            const ctrls = el("span", { class: "learn-order-ctrls" });
            const up = el("button", { class: "learn-order-btn", type: "button", "aria-label": "Move up" }, "▲");
            const down = el("button", { class: "learn-order-btn", type: "button", "aria-label": "Move down" }, "▼");
            up.disabled = idx === 0;
            down.disabled = idx === order.length - 1;
            up.addEventListener("click", () => swap(idx, idx - 1));
            down.addEventListener("click", () => swap(idx, idx + 1));
            ctrls.append(up, down);
            li.append(label, ctrls);
            list.appendChild(li);
        });
    }

    checkBtn.addEventListener("click", () => {
        attempts++;
        const ok = order.every((s, i) => s.id === correct[i]);
        if (ok) {
            checkBtn.disabled = true;
            list.querySelectorAll(".learn-order-btn").forEach(b => { b.disabled = true; });
            wrap.classList.add("is-correct");
            cbs.onCorrect(attempts);
        } else {
            cbs.onWrong();
        }
    });

    renderList();
    wrap.append(list, checkBtn);
    return wrap;
}

function renderInteraction(stage, mode, cbs) {
    switch (stage.type) {
        case "quiz": return renderQuiz(stage, mode, cbs);
        case "reveal": return renderReveal(stage, mode, cbs);
        case "buildPuzzle": return renderAssignment(stage, mode, cbs, "puzzle");
        case "sortOrder": return renderSortOrder(stage, mode, cbs);
        case "sortBuckets": return renderAssignment(stage, mode, cbs, "buckets");
        default: return el("p", { class: "learn-feedback" }, "// unknown stage");
    }
}

// ─── Screens ────────────────────────────────────────────────────────────────────
function renderIntro() {
    const s = store.state;
    root.replaceChildren();

    const screen = el("div", { class: "learn-screen learn-screen-intro", "data-screen": "intro" });

    const head = el("header", { class: "learn-intro-head" });
    head.innerHTML = `
        <p class="learn-eyebrow">// learn.ai — interactive</p>
        <h1 class="learn-title">Understand AI in 6 quick levels.</h1>
        <p class="learn-sub">Pick a hero, choose your style, and play your way to crystal-clear answers: what an LLM is, what an AI agent is, how they differ, and when to use each.</p>`;
    screen.appendChild(head);

    if (resume) {
        const banner = el("div", { class: "learn-resume" });
        const cont = el("button", { class: "btn btn-primary", type: "button" }, `Continue — Stage ${resume.stageIndex + 1}/${DATA.stages.length} →`);
        const over = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Start over");
        cont.addEventListener("click", () => { store.set({ screen: "stage" }); resume = null; render(); });
        over.addEventListener("click", () => { resume = null; clearSaved(); store.replay(); render(); });
        banner.append(cont, over);
        screen.appendChild(banner);
    }

    // Character pick
    const charWrap = el("div", { class: "learn-pick-group" });
    charWrap.appendChild(el("p", { class: "learn-pick-label" }, "Choose your hero"));
    const charGrid = el("div", { class: "learn-char-grid", role: "radiogroup", "aria-label": "Choose your hero" });
    DATA.characters.forEach(ch => {
        const card = el("button", {
            class: "learn-char-card", type: "button", "data-pick-char": ch.id,
            role: "radio", "aria-checked": s.character === ch.id ? "true" : "false",
        });
        if (s.character === ch.id) card.classList.add("is-selected");
        card.style.setProperty("--char-accent", `var(${ch.accentVar})`);
        const art = el("div", { class: "learn-char-art" });
        art.innerHTML = characterSvg(ch.id);
        card.append(art,
            el("span", { class: "learn-char-name" }, ch.name),
            el("span", { class: "learn-char-tag" }, t(ch.tagline, s.mode || "nontech")));
        card.addEventListener("click", () => { store.pickCharacter(ch.id); render(); });
        charGrid.appendChild(card);
    });
    charWrap.appendChild(charGrid);
    screen.appendChild(charWrap);

    // Mode pick
    const modeWrap = el("div", { class: "learn-pick-group" });
    modeWrap.appendChild(el("p", { class: "learn-pick-label" }, "Choose your style"));
    const modeRow = el("div", { class: "learn-mode-toggle", role: "radiogroup", "aria-label": "Choose your style" });
    DATA.modes.forEach(m => {
        const b = el("button", {
            class: "learn-mode-btn", type: "button", "data-pick-mode": m.id,
            role: "radio", "aria-checked": s.mode === m.id ? "true" : "false",
        });
        if (s.mode === m.id) b.classList.add("is-selected");
        b.innerHTML = `<span class="learn-mode-name">${m.label}</span><span class="learn-mode-blurb">${m.blurb}</span>`;
        b.addEventListener("click", () => { store.pickMode(m.id); render(); });
        modeRow.appendChild(b);
    });
    modeWrap.appendChild(modeRow);
    screen.appendChild(modeWrap);

    // Start
    const startBtn = el("button", { class: "btn btn-primary learn-start", "data-start-btn": "", type: "button" }, "Start the adventure →");
    startBtn.disabled = !(s.character && s.mode);
    startBtn.addEventListener("click", () => { resume = null; store.start(); render(); });
    screen.appendChild(startBtn);

    root.appendChild(screen);
    entrance(screen);
}

function renderStage() {
    const s = store.state;
    const stage = DATA.stages[s.stageIndex];
    const mode = s.mode;
    const lastStage = s.stageIndex === DATA.stages.length - 1;
    root.replaceChildren();

    const screen = el("div", { class: "learn-screen learn-screen-stage", "data-screen": "stage" });
    screen.style.setProperty("--char-accent", charAccent(s.character));

    const hud = el("div", { class: "learn-hud", "data-hud": "" });
    hud.innerHTML = `
        <span class="learn-hud-item">// ${modeLabel(mode)} mode</span>
        <span class="learn-hud-item">Stage ${s.stageIndex + 1}/${DATA.stages.length}</span>
        <span class="learn-hud-item learn-hud-score">Score <b data-score>${s.score}</b></span>`;

    const mapHost = el("div", { class: "learn-map", "data-worldmap": "" });

    const panel = el("div", { class: "learn-panel", "data-stage-panel": "" });
    const buddy = el("div", { class: "learn-buddy is-idle" });
    buddy.innerHTML = characterSvg(s.character);
    const title = el("h2", { class: "learn-panel-title" }, t(stage.title, mode));
    const prompt = el("p", { class: "learn-panel-prompt" }, t(stage.prompt, mode));
    const interactionHost = el("div", { class: "learn-interaction" });
    const feedback = el("p", { class: "learn-feedback", "data-stage-feedback": "", role: "status", "aria-live": "polite" });
    const continueBtn = el("button", { class: "btn btn-primary learn-continue", "data-stage-continue": "", type: "button", hidden: "" }, lastStage ? "See your results →" : "Next stage →");
    panel.append(buddy, title, prompt, interactionHost, feedback, continueBtn);

    screen.append(hud, mapHost, panel);
    root.appendChild(screen);

    const map = drawMap(mapHost, {
        stages: DATA.stages, currentIndex: s.stageIndex,
        tokenMarkup: characterSvg(s.character), reduceMotion: REDUCE_MOTION,
    });

    let resolved = false;
    const cbs = {
        onWrong() {
            feedback.textContent = t(stage.feedback.wrong, mode);
            feedback.className = "learn-feedback is-wrong";
            reactHurt(buddy);
        },
        onCorrect(attempts, isReveal = false) {
            if (resolved) return;
            resolved = true;
            const before = store.state.score;
            const pts = pointsFor(attempts, DATA.meta, isReveal);
            store.award({ stageId: stage.id, correct: true, points: pts });
            animateScore(hud.querySelector("[data-score]"), before, store.state.score);
            feedback.textContent = `${t(stage.feedback.correct, mode)}  +${pts}`;
            feedback.className = "learn-feedback is-correct";
            reactCheer(buddy);
            burst(panel);
            continueBtn.hidden = false;
            map.markDone(s.stageIndex);
            if (REDUCE_MOTION) continueBtn.focus();
        },
    };

    interactionHost.appendChild(renderInteraction(stage, mode, cbs));

    continueBtn.addEventListener("click", async () => {
        continueBtn.disabled = true;
        const next = s.stageIndex + 1;
        if (next < DATA.stages.length) await map.moveTo(next);
        store.advance(DATA.stages.length);
        render();
    });

    entrance(panel);
}

function renderRecap() {
    const s = store.state;
    root.replaceChildren();
    const maxScore = DATA.stages.length * DATA.meta.pointsFirstTry;

    const screen = el("div", { class: "learn-screen learn-screen-recap", "data-screen": "recap" });
    screen.style.setProperty("--char-accent", charAccent(s.character));

    const buddy = el("div", { class: "learn-recap-buddy is-cheer" });
    buddy.innerHTML = characterSvg(s.character);
    screen.appendChild(buddy);

    const head = el("div", { class: "learn-recap-head" });
    head.innerHTML = `
        <p class="learn-eyebrow">// run complete</p>
        <h1 class="learn-title">You did it!</h1>
        <p class="learn-sub">Here's everything you just unlocked.</p>`;
    screen.appendChild(head);

    const scoreEl = el("div", { class: "learn-recap-score", "data-recap-score": "" });
    scoreEl.innerHTML = `<b>0</b><span>/ ${maxScore} pts</span>`;
    screen.appendChild(scoreEl);

    const cards = el("div", { class: "learn-recap-cards", "data-recap-cards": "" });
    DATA.stages.forEach((stage, i) => {
        const c = el("div", { class: "learn-recap-card" });
        c.innerHTML = `
            <span class="learn-recap-num">${i + 1}</span>
            <span class="learn-recap-body">
                <span class="learn-recap-title">${t(stage.title, s.mode)}</span>
                <span class="learn-recap-text">${t(stage.recap, s.mode)}</span>
            </span>`;
        cards.appendChild(c);
    });
    screen.appendChild(cards);

    const actions = el("div", { class: "learn-recap-actions" });
    const replay = el("button", { class: "btn btn-primary", "data-replay-btn": "", type: "button" }, "Play again");
    const switchB = el("button", { class: "btn btn-ghost", "data-switch-mode-btn": "", type: "button" }, s.mode === "tech" ? "Replay in Plain mode" : "Replay in Tech mode");
    const home = el("a", { class: "btn btn-ghost", href: "/", "data-page-link": "" }, "Back to portfolio");
    replay.addEventListener("click", () => { store.replay(); render(); });
    switchB.addEventListener("click", () => { store.switchMode(); render(); });
    actions.append(replay, switchB, home);
    screen.appendChild(actions);

    root.appendChild(screen);
    entrance(screen);
    animateScore(scoreEl.querySelector("b"), 0, s.score);
}

function render() {
    const s = store.state;
    if (s.screen === "stage") renderStage();
    else if (s.screen === "recap") renderRecap();
    else renderIntro();
}

// ─── Page chrome (nav drawer, year, transitions) ──────────────────────────────
// Wired here (module is served from 'self') so no inline <script> is needed
// under the page's strict CSP.
function wireChrome() {
    const year = document.getElementById("learn-year");
    if (year) year.textContent = new Date().getFullYear();

    const trigger = document.querySelector("[data-nav-trigger]");
    const drawer = document.querySelector("[data-nav-drawer]");
    if (trigger && drawer) {
        trigger.addEventListener("click", () => {
            const open = drawer.getAttribute("aria-hidden") === "false";
            drawer.setAttribute("aria-hidden", open ? "true" : "false");
            trigger.setAttribute("aria-expanded", open ? "false" : "true");
            document.body.style.overflow = open ? "" : "hidden";
        });
        document.querySelectorAll("[data-nav-close]").forEach(c => c.addEventListener("click", () => {
            drawer.setAttribute("aria-hidden", "true");
            trigger.setAttribute("aria-expanded", "false");
            document.body.style.overflow = "";
        }));
    }

    document.querySelectorAll("[data-resume-trigger-learn]").forEach(a => {
        a.addEventListener("click", e => { e.preventDefault(); window.location.href = "/#"; });
    });

    document.addEventListener("click", e => {
        const a = e.target.closest("[data-page-link]");
        if (!a) return;
        const href = a.getAttribute("href");
        if (!href) return;
        e.preventDefault();
        runPageTransition(href);
    });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
    playEntranceWipe();
    wireChrome();

    root = document.querySelector("[data-learn-root]");
    if (!root) return;

    try {
        DATA = await fetch(new URL("assets/js/data/learn.json?v=1", base)).then(r => r.json());
    } catch (err) {
        console.warn("[learn] learn.json load failed", err);
        root.innerHTML = `<p class="learn-error" style="font-family:var(--font-mono);color:var(--ink-muted)">// learning module unavailable</p>`;
        return;
    }

    const saved = load();
    store = createStore(saved || undefined);
    if (saved && !saved.completed &&
        (saved.screen === "stage" || saved.stageIndex > 0 || Object.keys(saved.answers || {}).length)) {
        resume = { stageIndex: saved.stageIndex };
    }
    store.set({ screen: "intro" });   // always open on the intro
    render();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
