# Spec: Signature Work — featured ErrorLens card

## Overview
Add a new top-level **Signature Work** section to the portfolio that surfaces Gaurav's strongest production artifact (ErrorLens) as a single, fully-formed card — not a generic projects grid. The section sits between Capabilities (`#bento`) and Perspectives (`#writing`) and renders one `<article class="signature-card">` per entry from `assets/js/data/signature.json`. Each card has a tagline, an embedded architecture diagram, a 3-line problem → approach → outcome blurb, a row of stack pills (`Google ADK · Gemini · AlloyDB + pgvector · MCP · A2A · Cloud Run`), an expandable "How it thinks" details block (collapsed by default, opens to show fast-path vs `sage_pipeline` split + the self-learning feedback loop), and optional outbound links (LinkedIn post, demo video, public GitHub). Source of truth is `assets/js/data/signature.json`; markup stays template-only. The render module mirrors `posts-list.js` shape and lazy-loads via `IntersectionObserver` so the hero canvas isn't blocked. The architecture supports adding more cards later, but v1 ships **one strong signature, not three weak ones** — closing the largest credibility gap on the site (the strongest artifact is currently invisible) without tipping into "every project deserves a card" sprawl.

## Depends on
- Spec 01 (foundation) — design tokens, section layout, nav structure
- Spec 06 (bento) — `.cap-card` styling pattern that `.signature-card` borrows from; `.cap-chip` reused for stack pills
- Spec 13 (mobile compatibility) — tap-target rules and breakpoints
- Spec 14 (LinkedIn posts) — native `<details>` accordion pattern reused for "How it thinks"

## Routes
No backend.

## Database changes
No database.

## Templates
- **Create:**
  - `assets/js/data/signature.json` — flat array of card entries. v1 contains exactly one entry (ErrorLens). Schema:
    ```json
    [
      {
        "slug": "errorlens",
        "name": "ErrorLens",
        "tagline": "Self-learning multi-agent incident response.",
        "diagramSrc": "assets/img/signature/errorlens-architecture.svg",
        "diagramAlt": "ErrorLens architecture: ingest → vector similarity fast-path → sage_pipeline novel-error path → self-learning feedback loop into AlloyDB pgvector store.",
        "problem": "Production incidents arrive faster than SREs can triage; runbooks rot; novel errors take humans down the same path twice.",
        "approach": "A multi-agent system over Google ADK + A2A + MCP. A vector-similarity fast-path resolves recurring errors in seconds; a sage_pipeline routes novel errors through diagnosis agents, and outcomes flow back into AlloyDB pgvector so the next occurrence hits the fast-path.",
        "outcome": "Triage that compounds — every novel incident makes the next one faster to resolve, with provenance the agents can show their work on.",
        "stack": ["Google ADK", "Gemini", "AlloyDB + pgvector", "MCP", "A2A", "Cloud Run"],
        "howItThinks": "Two paths share one memory. Fast-path: embed the incoming error, query pgvector for the nearest known signature, hand the resolution playbook to a runner agent. sage_pipeline: when similarity falls below threshold, spawn a diagnosis sub-graph (telemetry → hypothesis → verify → resolve), each step producing a citation trail. The loop closes when the resolution returns to the vector store with its outcome embedding, so future similar errors collapse onto the fast-path.",
        "links": [
          { "label": "LinkedIn post", "url": "https://www.linkedin.com/posts/glahoti_..." },
          { "label": "Demo video", "url": "" },
          { "label": "GitHub", "url": "" }
        ]
      }
    ]
    ```
    Empty `url` strings cause the link to be omitted at render time.
  - `assets/js/signature-work.js` — render module. Exports `initSignatureWork(root) → { destroy }`. Fetches `signature.json`, builds `<article class="signature-card">` rows into the section root using `textContent` only (no `innerHTML`).
  - `assets/img/signature/errorlens-architecture.svg` — diagram asset (you provide; the spec assumes SVG, PNG acceptable as fallback with `srcset` for retina if needed).
- **Modify:**
  - `index.html` — insert a new `<section id="signature-work" class="section section-signature">` between the closing `</section>` of `#bento` (line 297) and the opening `<section id="writing">` (line 299). Section contains:
    - eyebrow `// signature.work`
    - heading `Signature Work` (or `Built.` — pick one and stay consistent)
    - one-line lede pointing at "production-grade artifacts"
    - empty `<div class="signature-list" data-signature-root></div>` that the JS module fills.
    Add a `<a href="#signature-work" data-cursor="magnet">Work</a>` nav entry inside `.nav-links`, between the existing `About` link (line 108) and `Perspectives` link (line 109).
  - `assets/js/main.js` — add an `initSignatureWorkWhenVisible()` function modeled exactly on `initPostsListWhenVisible()` (300px IntersectionObserver `rootMargin`, disconnect on first hit, dynamic `import("./signature-work.js")`, store result on `window.__signatureWork` for debugging). Call it from the bootstrap block immediately after `initTrajectoryWhenVisible(profile)` and before `initPostsListWhenVisible()`. The module loads its own data file, so no `profile` argument is needed.
  - `assets/css/components.css` — append rules for `.signature-list`, `.signature-card`, `.signature-card-head`, `.signature-name`, `.signature-tagline`, `.signature-diagram`, `.signature-diagram-frame`, `.signature-blurb`, `.signature-blurb-row`, `.signature-stack`, `.signature-think`, `.signature-think-summary`, `.signature-think-body`, `.signature-links`, `.signature-link`. Reuse `.cap-chip` for stack pills.
  - `assets/css/layout.css` — add a `.section-signature` block only if vertical rhythm needs tightening. Likely inherits `.section` defaults with no override.

## Files to change
- `index.html`
- `assets/js/main.js`
- `assets/css/components.css`
- `assets/css/layout.css` (only if needed)

## Files to create
- `assets/js/data/signature.json`
- `assets/js/signature-work.js`
- `assets/img/signature/errorlens-architecture.svg`

## New dependencies
None.

## Rules for implementation
- All card content lives in `assets/js/data/signature.json`. Markup stays template-only.
- CSS variables only — never hardcode hex. All colors, spacing, type scale come from `assets/css/base.css` (`--bg-card`, `--bg-elev`, `--border`, `--border-strong`, `--accent`, `--accent-soft`, `--ink`, `--ink-muted`, `--ink-subtle`, `--space-*`, `--radius-md`, `--radius-lg`, `--text-*`, `--font-sans`, `--font-mono`, `--dur-base`, `--ease-out`).
- One JS module per surface. `signature-work.js` lazy-loads on viewport entry — does not block first paint or compete with the hero canvas.
- No npm, no bundler, no build step. Render path is HTML + ES module + JSON fetch only.
- Use native `<details>` / `<summary>` for the "How it thinks" expander. Hide the default disclosure marker (`summary { list-style: none }` and `summary::-webkit-details-marker { display: none }`); render a custom `::before` triangle that rotates 90° on `[open]`. No JS state machine for expand/collapse. Matches the pattern from spec 14.
- All text from `signature.json` rendered via `textContent` only — no `innerHTML`. JSON is trusted but treat content as untrusted at render time as a defensive default.
- The diagram is rendered as `<img loading="lazy" decoding="async" alt="{diagramAlt}">`, wrapped in a bordered `<figure class="signature-diagram-frame">` so it sits on a subtle card surface, not bare on the dark background. SVG preferred for crisp scaling at any density; PNG acceptable with `srcset="... 1x, ... 2x"` for retina.
- Diagram must be readable on mobile: `max-width: 100%; height: auto;` plus a `min-height` floor so dark-on-dark elements remain legible.
- Stack pills reuse `.cap-chip` styling. They are non-interactive in v1 (no click handler) — purely presentational. Mark with `aria-label="Stack: {item}"` on each pill for screen readers.
- Outbound links must use `target="_blank"` and `rel="noopener noreferrer"`. Links with empty `url` are omitted at render time, not rendered as disabled placeholders.
- Empty or missing `signature.json` → render nothing, log a single console warning, no broken layout shell.
- Respect `prefers-reduced-motion`. Default browser `<details>` behavior is non-animated, so this needs no explicit handling — but do not add custom expand animations that ignore the preference. Hover-state shimmer on the card border (if any) must be no-op under reduced motion.
- Minimum tap target on `<summary>` rows ≥ 44px (WCAG 2.5.5).
- Keyboard interaction: Tab focuses the summary; Enter/Space toggles open/closed; focus ring uses `var(--accent)` on `:focus-visible` (matches existing nav, chip, and post-summary focus treatment).
- Multiple cards (when more entries are added later) render top-to-bottom; each card's `<details>` operates independently — no force-close on expand of a sibling.
- Section anchor `#signature-work` must scroll-into-view correctly accounting for the sticky nav (`scroll-margin-top: var(--nav-h)`).

## Definition of done
Verifiable in a browser at `http://localhost:5173` (via `python3 -m http.server 5173`).

1. **Nav entry.** A new "Work" link sits between "About" and "Perspectives" in the top nav. Clicking it scrolls smoothly to the new section. Hover treatment matches the other nav links (cursor magnet + accent on hover).
2. **Section placement.** The Signature Work section appears between the Capabilities (`#bento`) section and the Writing (`#writing`) section. Eyebrow `// signature.work`, heading, and lede are visible and styled consistently with the other section headers.
3. **Lazy load.** With DevTools Network panel open and cleared, `signature.json`, `signature-work.js`, and the diagram asset only fetch when the Signature Work section approaches the viewport (300px rootMargin). They do not load on initial page render or while the hero is in view.
4. **Empty state.** With `signature.json` set to `[]`, the section renders header + lede + empty list, no console errors, no layout break.
5. **Populated state — ErrorLens card renders.** With the seeded ErrorLens entry, the card shows: name, tagline, framed architecture diagram, three-line problem/approach/outcome blurb, six stack pills in the documented order, "How it thinks" summary collapsed by default, and present outbound links (`url` non-empty) only.
6. **Diagram readable on mobile.** At 360 / 390 / 768 viewports (DevTools device emulation) the diagram fits within the card, no horizontal scroll on the page, contrast adequate for the dark theme. PNG variants (if used) load the 2x asset on retina.
7. **`<details>` expansion.** Clicking the "How it thinks" summary expands the body inline showing the fast-path vs sage_pipeline copy. Triangle marker rotates from ▸ to ▾. Clicking again collapses. **No layout shift in surrounding content** beyond the natural height growth of the card.
8. **Stack pills.** Each pill is rendered, has `aria-label="Stack: ..."`, is keyboard-focusable (or non-focusable if implemented as `<span>` — both acceptable in v1 since they're non-interactive). No visual disruption to the card layout when wrapping onto two lines on narrow viewports.
9. **Outbound links.** Each present link opens its URL in a new tab. DevTools Elements panel confirms `target="_blank"` and `rel="noopener noreferrer"`. Links with empty `url` in the data are not rendered at all.
10. **Keyboard navigation.** Tab focuses the `<summary>` → cyan focus ring visible. Enter and Space both toggle open/closed. Tab from an open summary moves into the body and onto the outbound links in document order. Shift+Tab returns cleanly. No focus traps.
11. **a11y audit.** Lighthouse Accessibility score on the page stays ≥ 95 with the section populated. axe DevTools scan reports zero new violations attributable to the Signature Work section. Diagram `<img>` has a meaningful `alt` (the JSON `diagramAlt`).
12. **`prefers-reduced-motion`.** With the OS preference enabled, the `<details>` still toggles (browser default behavior) and any hover-state shimmer on the card border is suppressed.
13. **No console errors** during full-page scroll-through with the section populated.
14. **No regression.** Existing sections (`#hero`, `#graph`, `#bento`, `#writing`) render unchanged; nav order is `Career · About · Work · Perspectives · Resume`; mobile drawer (if applicable) lists the new entry in the same slot.
15. **Single-card discipline.** v1 ships exactly one card (ErrorLens). The architecture supports more entries by appending to `signature.json`, but the spec is deliberate that v1 does not include placeholder/weak cards.
