# Spec: Polish (Cursor, Page Reveal, Mobile, Performance)

## Overview

The pass that takes the site from "well-built" to "genuinely
felt." Magnetic cursor on CTAs, a coordinated page-load
reveal sequence, mobile audit + fixes, and a perf sweep.
Nothing new conceptually; every existing section gets sharper.

## Depends on

- Specs 01–07.

## Routes

No backend.

## Database changes

No database.

## Templates

- **Create:** none.
- **Modify:** `index.html` — add a `<div class="cursor">` for
  the custom cursor.

## Files to change

- `assets/js/main.js` — add cursor module bootstrap, page
  reveal orchestrator (orders: shader fade-in → text scramble
  → CTAs ease-in → terminal hint blink).
- `assets/css/components.css` — `.cursor`, `.cursor-magnet`
  states.
- `assets/css/layout.css` — review every section for mobile
  bugs (touch target sizes, overflow, font scaling).
- `assets/js/main.js` — feature-detect Pointer Events; only
  enable custom cursor when fine pointer is available.

## Files to create

- `assets/js/cursor.js` — magnetic cursor module. Tracks
  pointer, applies attraction to elements with
  `data-cursor="magnet"`.

## New dependencies

None.

## Rules for implementation

- Custom cursor only activates on `(any-pointer: fine)` AND
  `(hover: hover)`. Fall back to native cursor on touch.
- Native cursor stays visible alongside the custom one (don't
  hide the system cursor — accessibility regression).
- Page reveal runs once per session (use sessionStorage flag
  so navigating back doesn't replay).
- Mobile audit checklist (must all pass):
  - No horizontal scroll at 320px.
  - Touch targets ≥ 44×44px.
  - Body font ≥ 16px to prevent iOS zoom.
  - All hover-only interactions have a tap equivalent.
- Performance budget enforcement:
  - Run Lighthouse → Performance ≥ 90 desktop, ≥ 80 mobile.
  - Total JS ≤ 400 KB gzipped.
  - LCP < 2.5s on simulated 4G.
- Add `loading="lazy"` and `decoding="async"` to any image
  below the fold.
- All CSS still uses variables; mobile breakpoints use
  `min-width` / `max-width` queries from `base.css` tokens.

## Definition of done

- [ ] Custom cursor follows the pointer on desktop, becomes
      magnetic near elements tagged `data-cursor="magnet"`
      (CTAs, graph nodes).
- [ ] Cursor disabled on touch devices.
- [ ] Initial page-load reveal runs in order: shader →
      headline scramble → CTAs → hint. No flash of unstyled
      content.
- [ ] Reveal runs once per session.
- [ ] Mobile (320px / 375px / 414px) shows zero horizontal
      scroll.
- [ ] All touch targets ≥ 44×44px (verify with DevTools
      device emulator).
- [ ] Lighthouse: Performance ≥ 90 desktop, ≥ 80 mobile;
      Accessibility ≥ 95; Best Practices ≥ 95.
- [ ] LCP < 2.5s on simulated Fast 3G.
- [ ] No console errors or warnings.
