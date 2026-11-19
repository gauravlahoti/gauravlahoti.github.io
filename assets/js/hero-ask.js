// hero-ask.js — spec 98: a pop-up nudge to try Atlas.
//
// A small speech bubble pops out of the "Chat with my AI agent, Atlas" button
// right after the page lands (above the bottom bar on phones). It types sample
// questions, alternating AI questions with questions about the AI Labs, and
// clicking the bubble opens Atlas with that question already sent.
//   - every page load, on screen for 30 seconds, then it leaves on its own;
//   - × or opening Atlas any other way takes it down early;
//   - hover or focus freezes it on the whole question (and holds it past the
//     30 seconds), so the click sends exactly what was read;
//   - reduced motion: no pop, no typing, the questions swap in place.
// Positioned absolutely off the button, so it never moves anything.
//
// Contract: initHeroAsk({ content, getWidget })
//   content   = profile.heroAsk { prompts: string[] }
//   getWidget = () => Promise<widget api | undefined>  (main.js's lazy start())

const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

const SHOW_AFTER_MS = 1200;  // just long enough for the hero to land
const LIFETIME_MS = 30000;   // then it goes, unless the visitor is on it
const TYPE_MS = 40;
const ERASE_MS = 18;
const HOLD_MS = 3400;
const GAP_MS = 350;

// Labs plug themselves in: every LIVE lab in content/ai-concepts.json with an
// `atlasPrompt` joins the rotation, no code change. Atlas answers a lab
// question by pointing at the lab (its get_ai_labs tool), so each one is a
// way into a lab as much as a question.
async function loadLabPrompts() {
    try {
        const data = await fetch("content/ai-concepts.json").then((r) => r.json());
        const labs = (data.concepts || [])
            .filter((c) => c && c.status === "LIVE" && c.atlasPrompt)
            .map((c) => ({ text: String(c.atlasPrompt).trim(), id: `lab-${c.id}`, isLab: true }));
        // A different lab leads each visit, so they all get seen.
        for (let i = labs.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [labs[i], labs[j]] = [labs[j], labs[i]];
        }
        return labs;
    } catch (_) {
        return []; // no labs: the AI questions alone still work
    }
}

// AI question, lab question, AI question, lab question… whichever runs out
// first, the other carries on.
function interleave(ai, labs) {
    const out = [];
    for (let i = 0; i < Math.max(ai.length, labs.length); i++) {
        if (ai[i]) out.push(ai[i]);
        if (labs[i]) out.push(labs[i]);
    }
    return out;
}

export function initHeroAsk({ content = {}, getWidget }) {
    const ai = (Array.isArray(content.prompts) ? content.prompts : [])
        .map((s) => String(s || "").trim()).filter(Boolean)
        .map((text, i) => ({ text, id: `ai-${i}` }));

    // Desktop: the hero button. Phones hide the hero buttons, so the bubble
    // speaks from the bottom bar instead.
    const pickAnchor = () => {
        const desktop = document.querySelector(".hero-cta-desktop");
        if (desktop && desktop.offsetParent) return { el: desktop, where: "hero" };
        const bar = document.querySelector(".mobile-bottombar-btn-primary");
        if (bar && bar.offsetParent) return { el: bar, where: "bar" };
        return null;
    };

    let launchTimer = null;
    // One launch per page view: a fresh load, a refresh, or a restore from the
    // browser's back/forward cache (which re-runs no scripts, so `pageshow`
    // below starts it again). Each launch gets its own 30 seconds.
    function launch() {
        clearTimeout(launchTimer);
        document.querySelectorAll(".hero-try").forEach((b) => b.remove());
        const labsP = loadLabPrompts(); // off the critical path, ready before the pop
        launchTimer = setTimeout(async () => {
            if (document.body.hasAttribute("data-agent-panel-open")) return;
            const anchor = pickAnchor();
            if (!anchor) return;
            const prompts = interleave(ai, await labsP);
            if (!prompts.length) return;
            show(anchor, prompts, getWidget);
        }, SHOW_AFTER_MS);
    }

    launch();
    addEventListener("pageshow", (e) => { if (e.persisted) launch(); });
}

function show(anchor, prompts, getWidget) {
    const host = anchor.el.parentElement;
    host.classList.add("hero-try-host");

    const bubble = document.createElement("div");
    bubble.className = `hero-try hero-try--${anchor.where}`;
    bubble.innerHTML = `
        <button type="button" class="hero-try-ask">
            <span class="hero-try-eyebrow" aria-hidden="true"><span class="hero-try-dot"></span>Try asking Atlas<span class="hero-try-tag">AI Lab</span></span>
            <span class="hero-try-q" aria-hidden="true"></span>
        </button>
        <button type="button" class="hero-try-close" aria-label="Dismiss">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>`;
    const askBtn = bubble.querySelector(".hero-try-ask");
    const qEl = bubble.querySelector(".hero-try-q");
    const closeBtn = bubble.querySelector(".hero-try-close");
    host.appendChild(bubble);

    // Desktop: size the bubble once, around the longest question with the
    // "AI Lab" tag showing, so it holds still while text types and erases.
    // (Phones span the bar in CSS.)
    if (anchor.where === "hero") {
        bubble.classList.add("is-lab");
        qEl.textContent = prompts.reduce((a, b) => (b.text.length > a.text.length ? b : a)).text;
        bubble.style.width = `${bubble.offsetWidth + 2}px`; // offsetWidth: layout size, ignores the pop-in scale
        qEl.textContent = "";
        bubble.classList.remove("is-lab");
    }

    let idx = 0;
    let timer = null;
    let paused = false;
    let expired = false;
    let gone = false;

    const item = () => prompts[idx % prompts.length];
    const current = () => item().text;
    // The aria-label and the "AI Lab" tag follow whichever question is up.
    const label = () => {
        askBtn.setAttribute("aria-label", `Ask Atlas: ${current()}`);
        bubble.classList.toggle("is-lab", !!item().isLab);
    };

    function leave() {
        if (gone) return;
        gone = true;
        clearTimeout(timer);
        clearTimeout(lifeTimer);
        mo.disconnect();
        bubble.classList.remove("is-shown");
        bubble.classList.add("is-leaving");
        setTimeout(() => bubble.remove(), REDUCE_MOTION ? 0 : 320);
    }

    function type(n) {
        if (gone || paused) return;
        const q = current();
        qEl.textContent = q.slice(0, n);
        if (n < q.length) timer = setTimeout(() => type(n + 1), TYPE_MS);
        else { label(); timer = setTimeout(next, HOLD_MS); }
    }
    function erase() {
        if (gone || paused) return;
        const t = qEl.textContent;
        if (t.length) { qEl.textContent = t.slice(0, -1); timer = setTimeout(erase, ERASE_MS); }
        else { idx++; label(); timer = setTimeout(() => type(1), GAP_MS); }
    }
    function next() {
        if (gone || paused) return;
        if (REDUCE_MOTION) { // swap in place, no typing
            idx++;
            qEl.textContent = current();
            label();
            timer = setTimeout(next, HOLD_MS);
            return;
        }
        erase();
    }

    // Freeze on the whole question while the visitor looks at it.
    const pause = () => {
        paused = true;
        clearTimeout(timer);
        qEl.textContent = current();
        label();
        Promise.resolve(getWidget()).then((api) => api && api.warm && api.warm());
    };
    const resume = () => {
        paused = false;
        if (gone) return;
        if (expired) return leave(); // its 30 seconds ran out while hovered
        timer = setTimeout(next, HOLD_MS);
    };
    bubble.addEventListener("pointerenter", pause);
    bubble.addEventListener("pointerleave", resume);
    bubble.addEventListener("focusin", pause);
    bubble.addEventListener("focusout", (e) => { if (!bubble.contains(e.relatedTarget)) resume(); });

    askBtn.addEventListener("click", () => {
        const q = current();
        const chip = item().id; // "ai-0" / "lab-mcp", for the funnel's chip mix
        leave();
        Promise.resolve(getWidget()).then((api) => api && api.ask && api.ask(q, { source: "hero-try", chip }));
    });
    closeBtn.addEventListener("click", leave);

    // Atlas opened some other way: the nudge has done its job.
    const mo = new MutationObserver(() => {
        if (document.body.hasAttribute("data-agent-panel-open")) leave();
    });
    mo.observe(document.body, { attributes: true, attributeFilter: ["data-agent-panel-open"] });

    const lifeTimer = setTimeout(() => {
        expired = true;
        if (!paused) leave();
    }, LIFETIME_MS);

    // Pop in, then start typing.
    label();
    if (REDUCE_MOTION) {
        qEl.textContent = current();
        bubble.classList.add("is-shown");
        timer = setTimeout(next, HOLD_MS);
        return;
    }
    requestAnimationFrame(() => {
        bubble.classList.add("is-shown");
        timer = setTimeout(() => type(1), 420);
    });
}
