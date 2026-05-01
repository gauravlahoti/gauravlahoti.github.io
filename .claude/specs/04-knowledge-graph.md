# Spec: Career Trajectory (replaces 3D Knowledge Graph)

## Overview

The `#graph` section is no longer a graph. It is a vertical, scroll-driven
career trajectory: **Accenture (2015) → EY (2018) → Deloitte (2019 → now)**.
A pinned left rail draws itself in cyan as the visitor scrolls, year
markers brighten as they're passed, and the right column shows three
company blocks — each with the official brand logo, tenure, work mode,
and a nested list of every role held there. The component answers one
question in five seconds: how did this career compound?

History note: this file replaces the prior "3D Knowledge Graph" spec.
The 3D force-directed visualization, the `3d-force-graph` CDN dep, and
`assets/js/graph.js` are removed. The section anchor `#graph` is
preserved so existing nav links and `portfolio:scroll-to` listeners
keep working.

## Depends on

- Spec 01 (`#graph` anchor, design tokens).
- `assets/js/data/profile.json` — `experience[]` is restructured into
  3 companies × 7 roles total. See "Data shape" below.
- `assets/js/data/graph.json` — kept (consumed by other sections, e.g.
  bento skill chips). Not rendered by this section.

## Routes / Database / New deps

None. No new CDN scripts. GSAP + ScrollTrigger are already loaded.

## Data shape

`profile.experience` is a company-grouped array, oldest first:

```
[
  {
    "company": "Accenture",
    "logo": "accenture",
    "tenure": "3 yrs 3 mos",
    "workMode": "On-site",
    "roles": [
      { "title": "Associate Software Engineer",
        "start": "2015-04", "end": "2016-05", "duration": "1 yr 2 mos",
        "location": "Greater Hyderabad Area", "skills": [] },
      { "title": "Application Development Analyst",
        "start": "2016-06", "end": "2017-11", "duration": "1 yr 6 mos",
        "location": "Bengaluru, Karnataka, India",
        "skills": ["Oracle BPM", "Oracle Data Integrator (ODI)"],
        "extraSkills": 2 },
      { "title": "Application Development Senior Analyst",
        "start": "2017-12", "end": "2018-06", "duration": "7 mos",
        "location": "Bengaluru, Karnataka, India",
        "skills": ["Oracle SOA Suite", "Oracle Data Integrator (ODI)"],
        "extraSkills": 2 }
    ]
  },
  { "company": "EY", "logo": "ey", "tenure": "1 yr 3 mos",
    "workMode": "On-site", "roles": [ … 1 entry … ] },
  { "company": "Deloitte", "logo": "deloitte", "tenure": "6 yrs 9 mos",
    "workMode": "Hybrid", "roles": [ … 3 entries: Consultant →
    Senior Consultant → Manager … ] }
]
```

Roles within each company are also oldest-first.
`profile.careerStart` stays `"2015-04"` (drives the hero `// uptime`
ticker, unchanged).

## Templates

- **Modify** `index.html`:
  - Add a hidden `<svg>` brand-logo sprite near the top of `<body>`
    defining `<symbol id="logo-accenture">`, `<symbol id="logo-ey">`,
    `<symbol id="logo-deloitte">`. Each is a tight viewBox built from
    paths/rect/text — no external image assets.
  - Replace the entire `<section id="graph">…</section>` block with
    `section.section-trajectory` containing: header (eyebrow / title /
    sub), `.trail-grid` with sticky `<aside class="trail-rail">`
    holding one `<svg>` and `<ol class="trail-companies"
    data-trajectory-root>`. Keep `id="graph"`. Update `aria-label`
    to "Career trajectory".

## Files to change

- `assets/js/data/profile.json` — expanded `experience[]` per shape
  above (already populated).
- `assets/css/base.css` — delete `--node-company / --node-project /
  --node-domain / --node-skill`. Add:
  - `--era-accenture: #A100FF` (Accenture purple)
  - `--era-ey: #FFE600` (EY yellow)
  - `--era-deloitte: #86BC25` (Deloitte green) — used only for the
    brand dot in the logo and the rail gradient anchor; the
    highlight/pulse color stays `--accent` cyan.
- `assets/css/components.css` — delete every `.section-graph`,
  `.graph-*`, `.legend-*`, `.graph-svg *`, `.graph-panel*` rule.
  Add `.section-trajectory`, `.trail-grid`, `.trail-rail`,
  `.trail-rail svg`, `.trail-station`, `.trail-year`,
  `.trail-company`, `.company-header`, `.company-logo`,
  `.company-name`, `.company-tenure`, `.company-mode`, `.role-list`,
  `.role-tile`, `.role-title`, `.role-period`, `.role-duration`,
  `.role-location`, `.role-skills`, `.skill-pill`, plus a
  `@media (max-width: 768px)` collapse block.
- `assets/js/main.js` — remove `initGraphWhenVisible()`,
  `hasWebGL()` (if unused), and the `import("./graph.js")` call. Add
  `initTrajectoryWhenVisible()` using the same IntersectionObserver
  pattern. The skill-chip click handler (in `populateSkills`) keeps
  dispatching `portfolio:highlight-skill` + `portfolio:scroll-to
  #graph` — no change there.

## Files to create

- `assets/js/trajectory.js` — exports `initTrajectory(root, profile,
  graph) → { destroy, highlightSkill }`. Responsibilities:
  - Render company tiles + nested role rows from `profile.experience`.
  - Build the rail SVG: measure each company header's center y after
    paint, write polyline `points` and `<circle>` station positions,
    apply `stroke-dasharray = stroke-dashoffset = pathLength`.
  - Wire one ScrollTrigger (`scrub: true`) that animates
    `stroke-dashoffset → 0` across the section's scroll range, and
    one `ScrollTrigger.batch` for company-header + role-tile reveals.
  - Listen for `portfolio:highlight-skill` — find the role whose
    `skills` (case-insensitive) includes the matching label; scroll
    to that tile and pulse it (single GSAP yoyo).
  - Re-measure on `ResizeObserver` (debounced 100ms).

## Files to delete

- `assets/js/graph.js`.

## Rules for implementation

- The `#graph` anchor id MUST be preserved so existing
  `portfolio:scroll-to` listeners and the nav link don't break.
- No new CDN scripts. No 3D, no canvas, no WebGL fallback. The rail
  is a single inline SVG; tiles are plain DOM.
- Use only the locked design tokens. New colors limited to `--era-*`.
  The rail gradient interpolates Accenture purple → EY amber →
  Deloitte green along its length.
- Cap motion at 3 effects: rail draw (scrub), tile reveal (once),
  skill-pulse (one-shot). No parallax, no idle ambient motion, no
  hover-driven layout shifts.
- `prefers-reduced-motion: reduce` MUST: render the rail fully
  drawn at load; replace tile reveals with instant visibility;
  replace skill-pulse with a 1.5s outline.
- Mobile (<768px): rail SVG is `display:none`. Each company header
  shows an inline year chip above the company name. Role rows still
  nest under the header but use a smaller type scale. Same DOM order
  as desktop. No pinning.
- All copy comes from `profile.json` and `graph.json`. No literal
  company / role / period strings in JS or HTML.
- Each company header carries an inline `<svg><use href="#logo-…">`
  reference to the brand sprite defined once at the top of `<body>`.
- Project metrics + descriptions remain in the storytelling section
  (spec 05). The trajectory section does NOT re-render them.
- Total JS budget after this spec: ≤ 360 KB gzipped (the
  `3d-force-graph` removal should drop ~40 KB vs. the previous spec).

## Definition of done

- [ ] `#graph` renders three company blocks in chronological order:
      Accenture (top) → EY → Deloitte (bottom).
- [ ] Each company header shows the brand logo (Accenture purple
      `>`, EY yellow tile, Deloitte black `D.` with green dot),
      company name, tenure (`3 yrs 3 mos` / `1 yr 3 mos` /
      `6 yrs 9 mos`), and work-mode chip.
- [ ] Role rows nest under each company header — Accenture 3, EY 1,
      Deloitte 3 (total 7). Each shows title + period + duration +
      location + skill chips.
- [ ] Left rail draws from top to bottom as the user scrolls
      through the section (verifiable: scroll halfway → rail is
      ~50% drawn).
- [ ] Each station circle on the rail flips to its `--era-*` color
      and the corresponding year numeral brightens to `--ink` as
      its station is passed by the rail head.
- [ ] Clicking a skill chip in `#bento` whose label matches a role
      skill scrolls to `#graph` and pulses that role tile (cyan
      box-shadow yoyo, ≤ 1s total).
- [ ] At 375px width, the rail SVG is hidden, each company header
      gets an inline year chip, and tiles are full-width single-
      column with role rows still nested.
- [ ] `prefers-reduced-motion: reduce` removes scrub and reveal
      animations; rail renders fully drawn; skill-pulse becomes a
      1.5s outline.
- [ ] `assets/js/graph.js` is deleted; `3d-force-graph` no longer
      appears in the Network tab.
- [ ] `--node-*` tokens are gone from `base.css`; only `--era-*`
      remain.
- [ ] No `.graph-*` selectors remain in `components.css`.
- [ ] `profile.json` and `graph.json` remain the only sources of
      career data.
- [ ] Total JS ≤ 360 KB gzipped after this spec lands.
