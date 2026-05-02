# Spec: Capabilities — restructure into three axes

## Overview
Today the Capabilities section (`#bento`) renders **two axes**: Technical (8 sub-cards) and Business (5 sub-cards), each sub-card with a label, a context blurb, and a chip list. Two problems:

1. **The differentiator is buried.** "AI-Native architecture" sits inside a generic "Technical" bucket alongside Terraform and Oracle SOA. The lead capability is invisible at a glance.
2. **The section is text-heavy.** 13 cards × (label + context paragraph + chip list) is a wall of prose for a portfolio page. The visitor reads everything or nothing — there's no quick visual scan.

This spec does two things together:

**A. Restructure into three axes**, with **AI-Native first** as the lead capability:

1. **AI-Native Architecture** (`axis.01`) — agentic frameworks · LLMs & model garden · AI protocols (MCP / A2A) · RAG & vector data · **coding agents & AI-native dev tooling** (new sub-card: Claude Code, Gemini CLI, Cursor, VS Code, Agent Skills, Progressive Disclosure).
2. **Cloud Foundations** (`axis.02`) — cloud native (GCP Cloud Run, BigQuery, **Agent Platform** (formerly Vertex AI), Gemini Enterprise, AWS Lambda, EventBridge, SageMaker, Kubernetes, Terraform) · integration & API · security · languages & tools.
3. **Business & Delivery** (`axis.03`) — engagement leadership · pursuit & pre-sales · delivery & governance · strategy & advisory · people & mentorship (existing five sub-cards copied across unchanged).

**B. Reduce text density and lift visual impact** so the section reads as three confident axes instead of thirteen wordy panels. Mechanism (detailed in **Visual treatment** below): per-axis accent theming, oversized axis numerals as visual anchors, icon-prefixed chips, context blurb collapsed by default (revealed on hover/expand — a literal nod to the *Progressive Disclosure* pattern the AI-Native axis itself names), and chip lists capped to a "top-N + show more" reveal.

Implementation is still **mostly a JSON + render-loop edit**, with focused CSS additions for the new visual treatment. `assets/js/data/profile.json` restructures the `capabilities` object from `{ technical, business }` to `{ aiNative, cloud, business }`. `assets/js/main.js:114-162` (`renderAxis()`) extends from two iterations to three and grows a small icon-resolver helper plus an "expand to see more" affordance. The bento grid in CSS extends from a 2-column desktop layout to 3-column on wide viewports while keeping the existing stacking behaviour on mobile. The section header subtitle is updated to acknowledge three axes.

The `// axis.0X` numeric labelling pattern is preserved (and amplified visually). AI-Native goes first because it's now the lead capability.

## Depends on
- Spec 01 (foundation) — design tokens, section layout
- Spec 06 (bento) — original two-axis structure being restructured
- Spec 04 (knowledge graph) — chip-click → scroll-to-`#graph` interaction preserved for AI-Native and Cloud chips

## Routes
No backend.

## Database changes
No database.

## Templates
- **Modify:**
  - `assets/js/data/profile.json` — restructure the `capabilities` object. Old shape (`technical`, `business`) → new shape (`aiNative`, `cloud`, `business`). Preserve the per-axis array shape: each axis is an array of `{ key, label, context, items: [...] }` entries (matching the existing schema observed in the file at lines 23–40).

    **Required redistribution and rename:**
    - `aiNative` — five sub-cards. Move the existing `agentic`, `llms`, `protocols`, `rag` entries from `technical` (lines 25–28) into `aiNative` in that order. **Add one new sub-card** as the fifth entry:
      ```json
      {
        "key": "coding-agents",
        "label": "Coding agents & dev tooling",
        "context": "Building software with agents in the loop — and shipping agent-native skills end-users can install",
        "items": [
          "Claude Code",
          "Gemini CLI",
          "Cursor",
          "VS Code",
          "Agent Skills",
          "Progressive Disclosure",
          "Cloud deployment patterns"
        ]
      }
      ```
      Order matters: `agentic` first (defines the practice), `llms` second, `protocols` third, `rag` fourth, `coding-agents` fifth (keeps it as the freshest signal at the bottom of the card column).
    - `cloud` — four sub-cards. Move existing `cloud`, `integration`, `security`, `languages` entries (lines 29–32) into `cloud` in that order. **Rename "Vertex AI" → "Agent Platform (Vertex AI)"** in both:
      - the `cloud` sub-card's `items` (line 29: `"Vertex AI"` → `"Agent Platform (Vertex AI)"`),
      - the `aiNative > llms` sub-card's `items` (originally line 26: `"Vertex AI"` → `"Agent Platform (Vertex AI)"`).
      Google rebranded Vertex AI Agent Builder to **Agent Platform**; surfacing "(Vertex AI)" in parentheses keeps the SEO and reader recognition intact while showing you track the rename. Apply this rename **everywhere** Vertex AI appears in `profile.json` (a `grep` of the file is the right safety net).
    - `business` — five sub-cards. Copy the existing `leadership`, `pursuit`, `delivery`, `strategy`, `people` entries (lines 34–39) across **unchanged**.

    Final shape: `aiNative` has 5 sub-cards, `cloud` has 4, `business` has 5. None is sparse.
  - `assets/js/main.js` (the `initCapabilities()` block, currently around lines 105–113 plus the `renderAxis()` helper at 114–162) — extend to iterate three axes instead of two. Axis indices are `01`, `02`, `03`. AI-Native renders **first**, Cloud second, Business third. `data-axis` attribute on each `<article class="cap-card">` distinguishes the three (use `data-axis="ai-native"`, `data-axis="cloud"`, `data-axis="business"`); the existing chip-click → scroll-to-`#graph` behaviour applies to `aiNative` and `cloud` axes (technical-flavoured), while `business` chips remain non-interactive (matching today's behaviour).

    `renderAxis()` also grows two small responsibilities for the visual upgrade:
    - **Icon resolver.** Each chip's text is matched against a small static map (`{ "Claude Code": "claude", "Gemini CLI": "gemini", "Cursor": "cursor", "VS Code": "vscode", "GCP Cloud Run": "gcp", "AWS Lambda": "aws", "Kubernetes": "k8s", "Terraform": "terraform", … }`) to look up an inline SVG glyph. If no match, an abstract diamond/dot glyph is used. Markup becomes:
      ```html
      <li>
        <button class="cap-chip">
          <svg class="cap-chip-icon" aria-hidden="true">…</svg>
          <span class="cap-chip-label">Claude Code</span>
        </button>
      </li>
      ```
    - **Top-N + reveal.** When `items.length > 5`, render the first 5 chips inline and an additional `<li><button class="cap-chip cap-chip-more" data-cap-more>+{N-5} more</button></li>` that toggles `aria-expanded` on the surrounding `<ul>` to reveal the remainder. No external library; pure class toggling.
  - `index.html:282-295` — update the section header subtitle to reflect three axes (e.g. `// three axes — AI-native · cloud foundations · delivery craft`). The grid container's class stays the same; CSS handles the column count change.
  - `assets/css/components.css` and/or `assets/css/layout.css` — extend the `.bento-grid` (or equivalent grid container) rule to `grid-template-columns: repeat(3, 1fr)` on desktop, falling back through 2-column at medium widths and stacking at the existing `@media (max-width: 768px)` breakpoint. Preserve gap, alignment, and card aspect. Add the new visual treatment rules listed under **Visual treatment** below.
  - `assets/css/base.css` — add three new tokens to `:root` for per-axis accent theming:
    ```css
    --axis-ai:    var(--accent);                 /* mint #00FFD1 — lead axis */
    --axis-cloud: color-mix(in oklch, #6FB1FF 80%, var(--ink) 20%); /* cool steel blue */
    --axis-biz:   color-mix(in oklch, #C7A6FF 80%, var(--ink) 20%); /* muted lavender */
    ```
    Or use direct hex if `color-mix` support is a concern (only legacy browsers). The exact swatches can be tuned at implementation; what matters is that the three axes are visually distinguishable at a glance without any one of them feeling decorative or "girly". Mint stays as the lead.
  - `assets/img/icons/` — new directory. Drop minimal monochrome SVG glyphs (16×16, single path, `currentColor`) for the brand icons referenced in the icon resolver. Inline-compatible (`viewBox="0 0 16 16"`). Approx 12–16 icons total. No external icon library — the static set lives in the repo. Acceptable to bundle them as inline JS strings in `main.js` instead of separate files if that reads cleaner; pick one approach.

## Files to change
- `assets/js/data/profile.json`
- `assets/js/main.js`
- `index.html`
- `assets/css/components.css` (and/or `assets/css/layout.css` — wherever the bento grid rule lives today)
- `assets/css/base.css` (new per-axis CSS variables)

## Files to create
- `assets/img/icons/*.svg` — minimal monochrome icon set (or equivalent inline SVG strings co-located in `main.js`).

## New dependencies
None.

## Visual treatment

The bento today is wall-of-text. The visual upgrade has five concrete moves; each is small on its own, together they shift the section from "read everything" to "scan three axes, dive on demand".

1. **Per-axis accent theming.** Each `<article class="cap-card">` reads its accent from a CSS variable scoped by `[data-axis="..."]`:
   ```css
   .cap-card[data-axis="ai-native"] { --card-accent: var(--axis-ai); }
   .cap-card[data-axis="cloud"]     { --card-accent: var(--axis-cloud); }
   .cap-card[data-axis="business"]  { --card-accent: var(--axis-biz); }
   ```
   The brackets (`.cap-bracket-tl`, `.cap-bracket-br`), index numeral, scan-line, focus rings, and chip-hover glow all use `var(--card-accent)` instead of `var(--accent)`. AI-Native keeps the strong mint signal; Cloud and Business get distinct but quieter tints so the eye treats AI-Native as primary.

2. **Oversized axis numeral.** The `.cap-index` (currently a small `01.` inline with the label) becomes a large display number (e.g. `4rem`, `--font-mono`, weight 200, `color: color-mix(in oklch, var(--card-accent) 30%, transparent)`) absolutely positioned in the top-right of the card. The `<h4 class="cap-label">` sits below it. This anchors each card visually with a single character of strong typographic weight, so the eye scans `01 02 03` down the column before reading any prose.

3. **Context blurb is collapsed by default.** The `<p class="cap-context">` paragraph (10–20 words today) renders one-line clipped (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`) with the full text revealed on card hover, on `:focus-within`, and via a small "info" affordance for keyboard/touch users. This is a literal expression of the **Progressive Disclosure** pattern named in the AI-Native axis content — the section practices what it preaches.

4. **Chips become icon-prefixed.** Every chip carries a small monochrome SVG (16×16, `currentColor`) before its label. Branded chips (Claude Code, Gemini, GCP, AWS, Cursor, VS Code, Kubernetes, Terraform, Pinecone, etc.) get recognisable monogram-style glyphs from `assets/img/icons/`. Concept chips (RAG, MCP, A2A, Agent Skills, Progressive Disclosure, OAuth2, etc.) get an abstract glyph from a 3–4-shape vocabulary (dot, diamond, ring, link). The icon adds visual rhythm without adding words. On the `[data-axis="ai-native"]` card the icons subtly tint to `var(--card-accent)` on hover.

5. **Top-5 + reveal.** Long chip lists (`cloud > cloud` has 12 items today) render only the first 5 chips inline plus a `+N more` chip that expands the rest in place. Mobile inherits the same behaviour. Encourages the visitor to skim, then drill in. No `<details>` element here — the toggle is a `<button data-cap-more>` flipping `aria-expanded` on the `<ul class="cap-chips">`, with CSS `[aria-expanded="false"] li:nth-child(n+6) { display: none; }`.

Optional, only if implementation time allows:

6. *Subtle background scan.* Each axis card gets a faint diagonal-stripe or dot-grid pattern in `var(--card-accent)` at very low opacity (`opacity: .04`). Not required for v1; mention only because the existing `.cap-scan` element already exists and a small enhancement may land cheaply.

The combined effect: each card displays three things at a glance — the **axis numeral**, the **label**, and **5 chips with icons** — and reveals the rest on engagement. Total visible glyphs and short labels, not paragraphs.

## Rules for implementation
- All capability copy lives in `profile.json`. No content moves into HTML.
- CSS variables only — never hardcode hex. Reuse `--bg-card`, `--border`, `--accent`, `--ink`, `--ink-muted`, `--space-*`, `--radius-md`, `--text-*`, `--font-mono`. New per-axis tokens (`--axis-ai`, `--axis-cloud`, `--axis-biz`) are defined in `:root` in `base.css`; cards reference them via the `--card-accent` indirection.
- AI-Native is **first** in render order. The `// axis.0X` numbering renumbers accordingly: AI-Native = `01`, Cloud = `02`, Business = `03`.
- Each axis must have at least 3 sub-cards at all times: `aiNative` ships with 5, `cloud` with 4, `business` with 5. The render layer must not crash if an axis has fewer, but the JSON must ship with no sparse axes.
- The new `coding-agents` sub-card must include `Claude Code`, `Gemini CLI`, `Cursor`, `VS Code`, `Agent Skills`, `Progressive Disclosure`, and `Cloud deployment patterns` in `items` (in that order or another sensible order — what matters is that all seven appear).
- The **Vertex AI → Agent Platform (Vertex AI)** rename is applied **everywhere** Vertex AI appears in `profile.json`. A `grep -i "vertex ai" assets/js/data/profile.json` after the change should return only occurrences with the new wrapped form.
- Preserve the chip-click interaction from spec 04: clicking an AI-Native or Cloud chip highlights the corresponding skill in the trajectory and scrolls to `#graph`. Business chips remain static (no click). Use the existing `data-axis` attribute as the discriminator (`data-axis="ai-native"` and `data-axis="cloud"` are interactive; `data-axis="business"` is not).
- The `+N more` reveal button is **not** a scroll-to-graph trigger. It only toggles `aria-expanded` on the chip list. Click does nothing else.
- Icons inside chips are decorative (`aria-hidden="true"`); the chip's accessible name is its `<span class="cap-chip-label">` text.
- Mobile: at `(max-width: 768px)` the grid stacks to a single column. Top-5 + reveal still applies — small viewports especially benefit from the trim.
- Mid-width: at the existing `(max-width: 1100px)` breakpoint, the grid reduces to 2 columns. AI-Native + Cloud share row 1, Business takes row 2 — pick a layout that doesn't orphan Business across half a row; full width is acceptable.
- Section header: the subtitle copy must mention three axes (the numbers should be obvious from the rendered cards, but the eyebrow / lede should not contradict the new structure).
- Preserve all existing card chrome (`.cap-bracket-tl`, `.cap-bracket-br`, `.cap-scan`, `.cap-card-head`, `.cap-label`, `.cap-context`, `.cap-chips`, `.cap-chip`). The `.cap-index` is repurposed visually (oversized numeral) but the class name and DOM position are stable. The card markup gains: an extra `<svg>` inside each chip, an optional `<button data-cap-more>` after the 5th chip, and a focus/hover-revealed full-context behaviour on `.cap-context` — all additive, no removal.
- No regression to keyboard navigation: chips remain `<button>` elements where interactive, focus ring uses `var(--card-accent)` on `:focus-visible` (was `var(--accent)`; the new variable resolves to the same mint for AI-Native, distinct for the other axes).
- No regression to the cursor effect (`data-cursor="magnet"` etc.) on cards.
- `prefers-reduced-motion`: any new hover transitions (chip icon tint, context-reveal slide) are suppressed under reduced motion. Static accent and context-reveal still work; only the easing/transition is removed.

## Definition of done
Verifiable in a browser at `http://localhost:5173`.

### Structure
1. **Three axis sections render.** The Capabilities (`#bento`) area shows three axis groups in document order: AI-Native (`01`), Cloud (`02`), Business (`03`). Each axis group renders its sub-cards via `renderAxis()`. Total `<article class="cap-card">` count = 5 + 4 + 5 = 14.
2. **AI-Native is first.** The leftmost / topmost axis is AI-Native, not Cloud or Business. Visual hierarchy communicates AI-Native as the lead capability — the eye finds it before anything else.
3. **Section header.** The subtitle / eyebrow copy on `#bento` references three axes. No leftover "Technical & Business" wording anywhere on the page.
4. **JSON schema integrity.** `profile.json` validates as well-formed JSON; the `capabilities` object has exactly three keys (`aiNative`, `cloud`, `business`) and each value is an array of `{ key, label, context, items }` objects. No leftover `technical` key.
5. **No sparse axes.** `aiNative` has 5 sub-cards, `cloud` has 4, `business` has 5. None is empty.

### Coding-agents content
6. **Coding-agents sub-card present.** A new card with `data-key="coding-agents"` (or rendered with the new label "Coding agents & dev tooling") is visible inside the AI-Native axis. It contains `Claude Code`, `Gemini CLI`, `Cursor`, `VS Code`, `Agent Skills`, `Progressive Disclosure`, and `Cloud deployment patterns` as chips.
7. **Branded chips have icons.** `Claude Code`, `Gemini CLI`, `Cursor`, and `VS Code` each render with a recognisable monogram/glyph SVG before the label. Concept chips (`Agent Skills`, `Progressive Disclosure`, `Cloud deployment patterns`) render with an abstract glyph from the small shape vocabulary.
8. **Vertex AI rename applied.** A page-wide `grep` (DevTools find, or visual scan) finds **no** standalone "Vertex AI" — every occurrence is wrapped as **"Agent Platform (Vertex AI)"** in both the `aiNative > llms` chip and the `cloud > cloud` chip.

### Visual treatment
9. **Per-axis accent applied.** Each card's brackets, scan-line, focus ring, and chip-hover glow honour the per-axis `--card-accent`. AI-Native uses mint; Cloud uses the cool-blue tint; Business uses the lavender tint. The three accents are distinguishable side-by-side without colour-blindness aids (for AA audiences) and remain accessible with the existing `--bg-card` background.
10. **Oversized axis numeral.** Each card displays a large display-weight numeral (`01`, `02`, `03`) in the top-right area, partially transparent, in the per-axis accent. The numeral does not overlap or clip the label or chips at any breakpoint.
11. **Context blurb collapsed by default.** Each `.cap-context` paragraph renders one line with truncation. Hovering the card or moving keyboard focus into the card reveals the full context (height grows or the line un-clamps). On touch devices, an info affordance or tap on the context line reveals the full text.
12. **Top-5 + reveal works.** On the `cloud > cloud` sub-card (which has 12 chips today), only the first 5 chips render inline plus a `+7 more` button. Clicking the button expands to show all 12 chips with the same icon prefix treatment; the button toggles to `Show fewer` (or hides) and `aria-expanded` flips. Sub-cards with ≤ 5 chips render no `+N more` button.
13. **Icon set complete.** Every chip renders with an icon — branded where matched, abstract glyph as the default fallback. No chip renders as plain text without a leading icon.

### Interaction
14. **Chip interaction preserved.** Clicking any chip on the AI-Native or Cloud cards highlights the related skill in the trajectory section and smoothly scrolls to `#graph` (matching spec 04). Clicking a Business chip does nothing.
15. **`+N more` does not scroll.** Clicking the `+N more` chip expands the list and does not navigate or trigger the trajectory scroll behaviour.
16. **Keyboard.** Tab moves through interactive chips in document order; the per-axis focus ring is visible on `:focus-visible`. Enter/Space activates a chip. Tab also reaches the `+N more` button and activates it the same way.
17. **Hover/focus on card reveals context.** Mousing over (or Tab-into) a card shows the full context paragraph; mouse-out (or Tab-away with no chip-focus inside) collapses it back. No layout shift in adjacent cards during reveal.
18. **`prefers-reduced-motion`.** Hover/focus context reveal still works (because it's a structural disclosure), but the easing/transition on tint, scale, and reveal is removed. No motion plays.

### Layout
19. **Desktop grid.** At ≥ 1100px viewport, the three axis groups render in a single row, three columns. The gap and card width feel balanced — no orphaned single column on the right.
20. **Mid-width grid.** At 768–1100px, the layout reduces to 2 columns (AI-Native + Cloud row 1, Business row 2 spanning full width or one column — verify no overlap, no clipped cards).
21. **Mobile stack.** At 360 / 390 / 768 viewports, the three axis groups stack in a single column in axis order: AI-Native, Cloud, Business. Top-5 chip trim applies. No horizontal scroll on the page. Existing mobile padding tokens are preserved.

### Cross-cutting
22. **No regression to existing chrome.** `.cap-bracket-*`, `.cap-scan`, hover treatment behave as they did pre-change (just retinted to per-axis accent).
23. **a11y audit.** Lighthouse Accessibility ≥ 95 with the new structure. axe DevTools scan reports zero new violations attributable to `#bento`. Each chip has an accessible name from its label `<span>`; SVG icons are `aria-hidden`.
24. **No console errors** during page render, hover, focus, chip-click, and `+N more` toggle.
25. **Lighthouse Performance ≥ 90.** No regression vs the pre-change baseline. The icon set adds at most a few KB inline; no external icon library is loaded.
