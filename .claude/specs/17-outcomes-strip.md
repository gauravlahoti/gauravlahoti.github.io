# Spec: Outcomes — second stats strip on the trajectory section

## Overview
Today the Career trajectory section (`#graph`) leads with a stats row showing "11y / 3 firms / 7 roles" — that's structure without outcome. This spec adds a **second stats strip immediately below the existing one** to surface directional business outcomes that demonstrate impact, not just tenure. Examples:

```
incidents auto-triaged    ~XK
MTTR reduction (pilot)    ~70%
agents in production      X
enterprise integrations   XX+
```

The strip ships with **directional placeholders** (`~XK`, `~70%`, `X`, `XX+`). The user populates real numbers later by editing `profile.json`. The spec is deliberate that placeholders look obviously like placeholders so they can never be mistaken for live data — the design rule is "better directional and honest than precise and inflated."

Implementation is small: a new `outcomes` array at the top level of `profile.json`, a sibling `<dl class="trail-stats trail-stats-outcomes">` rendered immediately below the existing `<dl class="trail-stats">` (currently at `index.html:241-254`), and a tiny CSS rule for the divider line above the new strip. Render lives in `assets/js/trajectory.js:8-40` (which already reads `profile.experience` and renders the trajectory graph) — extending it to also render the outcomes from `profile.outcomes` keeps the trajectory module as the single owner of the section's stats. A micro-caption `// outcomes.observed` sits between the two strips for contextual labelling.

Numeric typography matches the existing `.trail-stat` markup so the two strips read as a coherent pair, not a bolted-on extra.

## Depends on
- Spec 01 (foundation) — design tokens, section layout
- Spec 04 (knowledge graph) — same `#graph` section being extended

## Routes
No backend.

## Database changes
No database.

## Templates
- **Modify:**
  - `assets/js/data/profile.json` — add a top-level `outcomes` array. Schema:
    ```json
    "outcomes": [
      { "key": "triage",       "label": "incidents auto-triaged",   "value": "~XK" },
      { "key": "mttr",         "label": "MTTR reduction (pilot)",   "value": "~70%" },
      { "key": "agents",       "label": "agents in production",     "value": "X" },
      { "key": "integrations", "label": "enterprise integrations",  "value": "XX+" }
    ]
    ```
    Order in the JSON is the render order. Four entries is the recommended count; three or five is acceptable but not fewer than three or more than five (the strip must not wrap to two rows on desktop).
  - `index.html:241-254` — keep the existing `<dl class="trail-stats">` exactly as-is. Add a new sibling block immediately below it:
    ```html
    <p class="trail-stats-caption">// outcomes.observed</p>
    <dl class="trail-stats trail-stats-outcomes" data-outcomes-root></dl>
    ```
    The new `<dl>` is empty in the HTML; `trajectory.js` populates it from `profile.outcomes` on init.
  - `assets/js/trajectory.js:8-40` — extend `initTrajectory(root, profile)`. After the existing trajectory render, find `[data-outcomes-root]` inside the section and populate it with one `<div class="trail-stat">` per outcome entry, mirroring the existing markup:
    ```html
    <div class="trail-stat" data-outcome="{key}">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
    ```
    No `data-era` attribute (era colours don't apply to outcomes). Use `textContent` only.
  - `assets/css/components.css` — append rules:
    - `.trail-stats-caption` — small `--font-mono`, `--ink-subtle`, `--text-xs`, top margin `--space-4`, bottom margin `--space-2`.
    - `.trail-stats-outcomes` — `border-top: 1px solid var(--border)` with top padding `--space-3`. Numeric typography (`<dd>`) is byte-equivalent to the existing `.trail-stats dd` rule (reuse, do not redeclare).
    - Mobile: at `(max-width: 768px)`, the strip wraps via the existing `flex-wrap` on `.trail-stats` — verify and tighten gaps if needed.

## Files to change
- `assets/js/data/profile.json`
- `index.html`
- `assets/js/trajectory.js`
- `assets/css/components.css`

## Files to create
None.

## New dependencies
None.

## Rules for implementation
- Outcomes content lives in `profile.json`. Markup is template-only.
- CSS variables only — never hardcode hex. Reuse `--ink`, `--ink-muted`, `--ink-subtle`, `--accent`, `--border`, `--space-*`, `--text-*`, `--font-mono`.
- Numeric typography of the outcomes strip must be **byte-equivalent** to the existing trajectory stats — i.e. the same CSS rules govern `<dd>` size, weight, and tabular-nums treatment. Do not introduce a separate type scale for outcomes.
- The unit suffix pattern from the existing strip (`<span class="trail-stat-unit">y</span>` for "11y") is **not** reused for outcomes — outcomes use the raw `value` string verbatim (so `~70%` stays as one rendered unit). If a future outcome needs a unit decoration, that's a future refinement, not v1.
- Placeholder values must be visually obvious as placeholders: prefer `~XK`, `~70%`, `X`, `XX+` over fake-precise numbers like `1,247`. The point is to ship the *structure* now and let the user fill in defensible numbers later.
- The `// outcomes.observed` micro-caption uses the existing eyebrow/code-comment treatment from the section (look at the `// axis.01` styling in `#bento` for prior art — same colour, same font).
- The divider `border-top: 1px solid var(--border)` must be subtle, not heavy. The two strips should read as a *pair*, not as two unrelated rows.
- Mobile (`(max-width: 768px)`): the four outcome stats wrap onto two lines via the existing `flex-wrap` on `.trail-stats`. Verify no overflow at 360 / 390 / 768 widths.
- Render order in the DOM matches the array order in `profile.outcomes`. Editing the JSON re-orders the strip on reload with no other code changes.
- Empty or missing `outcomes` array → render the caption-less, empty `<dl>` removed from the DOM (or omitted entirely). No layout break, no console error.
- All text from `profile.outcomes` rendered via `textContent` only — no `innerHTML`.

## Definition of done
Verifiable in a browser at `http://localhost:5173`.

1. **Two strips render.** The trajectory section shows the existing `11y / 3 firms / 7 roles` row, immediately below it the `// outcomes.observed` caption, and immediately below that a second strip with the four outcomes (or however many are seeded in JSON, between 3 and 5).
2. **Placeholder values visible.** The strip ships with `~XK`, `~70%`, `X`, `XX+` (or equivalent obvious-placeholder values). Anyone reading them recognises them as placeholders, not fudged stats.
3. **Numeric typography matches.** Side-by-side, the `<dd>` text size, weight, and letter-spacing of the outcomes row is byte-equivalent to the existing trajectory stats row.
4. **Divider line.** A subtle 1px border separates the two strips. The treatment is unobtrusive — they read as a pair, not as a disconnected new section.
5. **Caption styling.** `// outcomes.observed` renders in monospace, `--ink-subtle`, small. Vertical rhythm above and below feels balanced (no awkward gap, no crammed against the divider).
6. **Mobile stacks cleanly.** At 360 / 390 / 768 viewports, the outcomes wrap onto two lines (2-up) without horizontal scroll, without overlap with the existing trajectory stats, without clipping the labels.
7. **Editable from JSON.** Editing one outcome's `value` in `profile.json` and reloading updates the DOM with no other changes. Adding a fifth entry renders five stats; reducing to three renders three; both within the strip's flex layout.
8. **No `data-era` colouring.** Unlike the existing trajectory stats which colour-code by company (`data-era="accenture"` etc.), outcomes have no era colour. They render in the default `--ink` foreground.
9. **Keyboard / screen reader.** `<dl>`/`<dt>`/`<dd>` semantics are preserved so the strip is announced correctly. `<dt>` is the label, `<dd>` is the value. Each pair is grouped via the existing `.trail-stat` wrapper. No `<button>` or focusable elements introduced.
10. **a11y audit.** Lighthouse Accessibility ≥ 95 with the new strip in place. axe DevTools reports zero new violations.
11. **No console errors** during page render with outcomes seeded.
12. **No regression.** Existing trajectory rendering (company blocks, left rail with stroke-dashoffset animation, era colour-coding on the original stats) behaves unchanged. Trajectory section's section-level scroll-into-view is unaffected.
13. **Empty outcomes.** Setting `profile.outcomes` to `[]` (or omitting it) renders the trajectory section with only the original stats strip, the caption removed, no console error, no layout break.
14. **Lighthouse Performance ≥ 90.** No regression — this is a content + DOM change, no new assets.
