// trajectory.js — vertical career timeline. Three company blocks with
// nested role rows; left rail draws itself in cyan as the user scrolls.
//
// Contract: initTrajectory(root, profile) → { destroy, highlightSkill }

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function initTrajectory(root, profile) {
    if (!root || !profile || !Array.isArray(profile.experience)) {
        return { destroy() {}, highlightSkill() {} };
    }

    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isNarrow = matchMedia("(max-width: 767px)").matches;
    const gsap = window.gsap;
    const ScrollTrigger = window.ScrollTrigger;
    const triggers = [];
    let resizeObserver;

    /* ---------- render company tiles ---------- */

    root.replaceChildren();
    const companies = profile.experience;
    const companyEls = companies.map(co => renderCompany(co));
    companyEls.forEach(({ li }) => root.appendChild(li));

    /* ---------- build station list (one per company) ---------- */

    const stationsRoot = document.querySelector("[data-trail-stations]");
    const stationEls = companies.map(co => {
        const li = document.createElement("li");
        li.className = "trail-station";
        li.dataset.era = co.logo;
        li.innerHTML = `
            <span class="trail-station-dot"></span>
            <span class="trail-station-year">${getStartYear(co)}</span>
        `;
        if (stationsRoot) stationsRoot.appendChild(li);
        return li;
    });

    /* ---------- rail SVG sizing + scrub ---------- */

    const railSvg = document.querySelector(".trail-rail-svg");
    const railLine = railSvg ? railSvg.querySelector(".trail-rail-line") : null;
    let lineLength = 1000;

    function measureRail() {
        if (!railSvg || !railLine || !stationsRoot) return;

        // Position each station at the y-center of its company header within the trail-rail (sticky context).
        // The rail is sticky to viewport; we map company header centers to station list positions
        // using the rail's own bounding box.
        const railRect = stationsRoot.getBoundingClientRect();
        if (railRect.height === 0) return;

        companyEls.forEach(({ li, header }, i) => {
            const headerRect = header.getBoundingClientRect();
            const midY = headerRect.top + headerRect.height / 2 - railRect.top;
            const pct = clamp(midY / railRect.height, 0, 1) * 100;
            const station = stationEls[i];
            station.style.top = `${pct}%`;
        });

        // Set the SVG line length so stroke-dashoffset animates cleanly.
        try {
            lineLength = railLine.getTotalLength
                ? railLine.getTotalLength()
                : railSvg.clientHeight || 1000;
        } catch (_) { lineLength = 1000; }
        railLine.setAttribute("stroke-dasharray", String(lineLength));
        railLine.style.strokeDashoffset = reduceMotion ? "0" : String(lineLength);
    }

    measureRail();
    requestAnimationFrame(measureRail); // re-measure once layout has settled

    /* ---------- ScrollTrigger: rail draw + station activation + tile reveal ---------- */

    if (gsap && ScrollTrigger && !reduceMotion && !isNarrow) {
        gsap.registerPlugin(ScrollTrigger);
        const section = document.getElementById("graph");

        // Rail draw — scrub through the section's scroll range.
        const drawTrigger = ScrollTrigger.create({
            trigger: section,
            start: "top top+=64",
            end: "bottom bottom",
            scrub: 0.4,
            onUpdate(self) {
                if (!railLine) return;
                railLine.style.strokeDashoffset = String(lineLength * (1 - self.progress));
                // toggle station activation based on progress past each station
                stationEls.forEach((el) => {
                    const topPct = parseFloat(el.style.top || "0") / 100;
                    const dot = el.querySelector(".trail-station-dot");
                    if (!dot) return;
                    if (self.progress >= topPct) dot.classList.add("is-active");
                    else dot.classList.remove("is-active");
                });
            },
        });
        triggers.push(drawTrigger);

        // Tile reveal for company headers + role tiles.
        const revealTargets = [];
        companyEls.forEach(({ li, header, roleEls }) => {
            revealTargets.push(header, ...roleEls);
            // initial state
            gsap.set([header, ...roleEls], { opacity: 0, y: 16 });
        });
        const batch = ScrollTrigger.batch(revealTargets, {
            start: "top 85%",
            once: true,
            onEnter(els) {
                gsap.to(els, {
                    opacity: 1, y: 0, duration: 0.55, stagger: 0.05, ease: "power3.out",
                });
            },
        });
        if (Array.isArray(batch)) triggers.push(...batch);
    }

    /* ---------- responsive re-measure ---------- */

    if (typeof ResizeObserver === "function") {
        let raf = 0;
        resizeObserver = new ResizeObserver(() => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => {
                measureRail();
                if (window.ScrollTrigger) window.ScrollTrigger.refresh();
            });
        });
        resizeObserver.observe(root);
    }

    /* ---------- spec 22: external remeasure trigger ----------
       Mobile <details>/<summary> toggles change the page layout under us,
       so we need to re-run the rail measurement and refresh ScrollTrigger
       once the toggle settles. Fired by main.js. */
    function onExternalRemeasure() {
        requestAnimationFrame(() => {
            measureRail();
            if (window.ScrollTrigger) window.ScrollTrigger.refresh();
        });
    }
    window.addEventListener("portfolio:trajectory-remeasure", onExternalRemeasure);

    /* ---------- skill highlight listener ---------- */

    function findRoleByLabel(label) {
        if (!label) return null;
        const needle = String(label).trim().toLowerCase();
        for (const co of companyEls) {
            for (const r of co.roleEls) {
                const skills = (r.dataset.skills || "").split("|");
                if (skills.some(s => s.toLowerCase() === needle)) return r;
            }
        }
        // fallback: substring match
        for (const co of companyEls) {
            for (const r of co.roleEls) {
                const skills = (r.dataset.skills || "").toLowerCase();
                if (skills.includes(needle)) return r;
            }
        }
        return null;
    }

    function highlightSkill(label) {
        const tile = findRoleByLabel(label);
        if (!tile) return;
        const lenis = window.__lenis;
        if (lenis && typeof lenis.scrollTo === "function") {
            lenis.scrollTo(tile, { offset: -96, duration: 1.1 });
        } else {
            tile.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        pulseTile(tile);
    }

    function pulseTile(tile) {
        if (reduceMotion) {
            tile.classList.add("is-pulsing");
            setTimeout(() => tile.classList.remove("is-pulsing"), 1500);
            return;
        }
        tile.classList.add("is-pulsing");
        if (gsap) {
            gsap.fromTo(tile, { scale: 1 }, {
                scale: 1.015, duration: 0.35, yoyo: true, repeat: 1,
                ease: "power2.inOut",
                onComplete() { tile.classList.remove("is-pulsing"); }
            });
        } else {
            setTimeout(() => tile.classList.remove("is-pulsing"), 800);
        }
    }

    function onSkillHighlight(e) {
        const label = e.detail && e.detail.label;
        highlightSkill(label);
    }
    document.addEventListener("portfolio:highlight-skill", onSkillHighlight);

    /* ---------- public API ---------- */

    return {
        destroy() {
            triggers.forEach(t => { try { t.kill(); } catch (_) {} });
            try { resizeObserver && resizeObserver.disconnect(); } catch (_) {}
            document.removeEventListener("portfolio:highlight-skill", onSkillHighlight);
            window.removeEventListener("portfolio:trajectory-remeasure", onExternalRemeasure);
            if (stationsRoot) stationsRoot.replaceChildren();
            root.replaceChildren();
        },
        highlightSkill,
    };
}

/* ---------- helpers ---------- */

function renderCompany(co) {
    const li = document.createElement("li");
    li.className = "trail-company";
    li.dataset.era = co.logo;

    const header = document.createElement("div");
    header.className = "company-header";
    header.innerHTML = `
        <div class="company-logo" aria-hidden="true">
            <svg viewBox="0 0 64 64"><use href="#logo-${escapeAttr(co.logo)}"/></svg>
        </div>
        <div class="company-meta">
            <p class="company-year-chip">${getStartYear(co)} →</p>
            <h3 class="company-name">${escapeHtml(co.company)}<span class="company-mode">${escapeHtml(co.workMode || "")}</span></h3>
            <p class="company-tenure">${escapeHtml(co.tenure || "")}</p>
        </div>
    `;

    const roleListEl = document.createElement("ol");
    roleListEl.className = "role-list";
    const roleEls = (co.roles || []).map(r => renderRole(r));
    roleEls.forEach(el => roleListEl.appendChild(el));

    li.appendChild(header);
    li.appendChild(roleListEl);
    return { li, header, roleEls };
}

function renderRole(r) {
    const tile = document.createElement("li");
    tile.className = "role-tile";
    tile.dataset.skills = (r.skills || []).join("|");

    const period = `${formatPeriod(r.start)} – ${r.end ? formatPeriod(r.end) : "Present"}`;
    const skills = r.skills || [];
    const extra = r.extraSkills || 0;

    tile.innerHTML = `
        <h4 class="role-title">${escapeHtml(r.title)}</h4>
        <p class="role-period">
            <span>${escapeHtml(period)}</span>
            <span class="sep">·</span>
            <span class="role-duration">${escapeHtml(r.duration || "")}</span>
        </p>
        <p class="role-location">${escapeHtml(r.location || "")}</p>
        ${skills.length || extra ? `
        <ul class="role-skills" aria-label="Key skills">
            ${skills.map(s => `<li class="skill-pill">${escapeHtml(s)}</li>`).join("")}
            ${extra ? `<li class="skill-pill-extra">+${extra} more</li>` : ""}
        </ul>` : ""}
    `;
    return tile;
}

function getStartYear(co) {
    if (!co.roles || co.roles.length === 0) return "—";
    const oldest = co.roles[0].start || "";
    return oldest.slice(0, 4) || "—";
}

function formatPeriod(yyyymm) {
    if (!yyyymm) return "";
    const [y, m] = yyyymm.split("-").map(Number);
    if (!y || !m) return yyyymm;
    return `${MONTHS[m - 1]} ${y}`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
}
