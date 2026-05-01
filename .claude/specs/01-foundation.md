# Spec: Foundation

## Overview

Replace the scaffolding stub in `index.html` with the real page
shell: top nav, semantic section anchors for every later spec,
and a footer. This is the visual frame every other spec will
populate. After this step, the page has a navbar, a hero
placeholder, and empty sections for terminal, graph, stories,
bento, and connect — each with the right anchor id and aria
label, ready to be filled.

## Depends on

- Spec 00 (scaffolding).

## Routes

No backend.

## Database changes

No database.

## Templates

- **Create:** none. We modify the existing `index.html`.
- **Modify:** `index.html` — replace the scaffold stub with the
  full page shell.

## Files to change

- `index.html` — full restructure into nav + sections + footer.
- `assets/css/layout.css` — add nav, container, section, footer
  rules. Remove the `.stub` rules.
- `assets/css/components.css` — add primary button (`.btn`) and
  ghost button styles.
- `assets/js/main.js` — read `profile.json`, populate
  name/title/tagline placeholders, set up Lenis (CDN) for smooth
  scroll. Stop only at scaffolding-level wiring; visualizations
  come in 02–05.
- `index.html` — add CDN `<script>` tags (with `defer`) for
  Lenis and GSAP.

## Files to create

None.

## New dependencies

CDN, loaded with `defer`:
- GSAP (`https://cdn.jsdelivr.net/npm/gsap@3.12/dist/gsap.min.js`)
- GSAP ScrollTrigger
- Lenis (`https://cdn.jsdelivr.net/npm/@studio-freight/lenis`)

Pin specific versions to avoid silent breakage.

## Rules for implementation

- All identity rendering pulls from `profile.json`. The HTML
  contains *placeholders* that JS replaces on load (e.g.
  `<span data-bind="profile.name">…</span>`).
- CSS variables only — no hex literals outside `base.css`.
- The page must remain readable and navigable with JS disabled
  (graceful fallback). Placeholders show defaults if JS fails.
- Lenis init only on viewports > 768px and only when
  `prefers-reduced-motion` is not set.
- Nav uses anchor links, not JS routing. Each section in the
  shell carries its own `id` corresponding to the slug used by
  `commands.json` (e.g. `#stories`, `#graph`).
- All templates extend nothing — single page, no template engine.

## Definition of done

- [ ] `index.html` boots without console errors.
- [ ] Top nav shows "Gaurav Lahoti" brand on the left and links
      "Work / About / Connect" plus a Topmate CTA on the right.
- [ ] Each section anchor exists in DOM order: `#hero`,
      `#terminal`, `#graph`, `#stories`, `#bento`, `#connect`.
- [ ] Each section is empty but visible (placeholder height of
      80vh) so scroll works end-to-end.
- [ ] `profile.json` values populate: page title, nav brand,
      hero name, footer email.
- [ ] Smooth scroll works when clicking nav links (Lenis active
      on desktop).
- [ ] The page is readable with JS disabled (placeholders fall
      back to text written into the HTML).
- [ ] Lighthouse: Performance ≥ 90, Accessibility ≥ 95.
- [ ] Mobile viewport (375px) shows nav as a hamburger or wraps
      gracefully — no horizontal scroll.
