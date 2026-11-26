# Spec: Capabilities Bento

## Overview

"What I bring" (`#about`) was 15 cards and 67 chips across three axes, with
truncated descriptions, decorative 01–06 numbers, and a Business & Delivery
axis of generic soft skills. It repeated the hero's tech hexagons and showed
no evidence. This spec replaces it with a bento: two pillar tiles
(AI-native architecture, cloud foundations) carrying live signals from the
site's own data, four skill tiles with small SVG animations, and the full
67-item toolkit in a native `<details>`. Business & Delivery is no longer a
card (its items stay in the toolkit). The "eleven years" line is dropped
because the hero already says it.

## Depends on

Spec 22 (mobile collapse, removed here), spec 100 (Selected Work), spec 107.

## Routes

No backend.

## Database changes

No database.

## Templates

- **Create:** `assets/js/capabilities.js`, `assets/css/bring.css`.
- **Modify:** `index.html` `#about`, `assets/js/main.js`, `assets/css/layout.css`,
  `content/profile.json`.

## Files to change

- `content/profile.json`: new `bring` block (intro, two pillars, four tiles,
  toolkit label). `capabilities` is unchanged; Atlas and the toolkit read it.
- `index.html`: new eyebrow and intro (bound to `profile.bring.intro`), the
  axis markup replaced by one `[data-capabilities-root]`; `return Gaurav
  Lahoti;` line removed. Version bumps.
- `assets/js/main.js`: `initCapabilities` lazy-imports `capabilities.js` near
  the viewport. Old renderers (`renderAxis`, chips, scan lines, mobile
  collapse) removed.
- `assets/css/layout.css`: intro spans the content width.

## Files to create

- `assets/js/capabilities.js`: renders the bento; reads `agents.json` (live
  agents by name, never a count), `ai-concepts.json` (labs not already listed
  as agents), `profile.certifications` (count and per-issuer counts).
- `assets/css/bring.css`: grid, border spotlight (`@property --spot`, mask),
  scroll-driven entrance (`animation-timeline: view()`), container query for
  wide pillars, glyph animations, toolkit styles. Injected by the module.

## New dependencies

No new dependencies.

## Rules for implementation

- All identity content lives in `content/profile.json`.
- CSS variables only. Never hardcode hex.
- One JS module per visualization; lazy-load on viewport entry.
- No npm, no bundler, no Node toolchain.
- Respect `prefers-reduced-motion`: resting state is the final state; motion
  only inside `no-preference`. Glyph loops run 3 times per view (under 5s).
- No em-dashes in copy. No agent count anywhere (Gaurav's rule).

## Definition of done

- [ ] `#about` shows 2 pillar tiles, 4 skill tiles and a closed "Full toolkit".
- [ ] Live now lists every LIVE agent from `agents.json` by name, each linking to its card.
- [ ] Labs list skips labs already shown as live agents.
- [ ] Cloud tile shows the certification count, per-issuer counts and "Runs on".
- [ ] Full toolkit opens to all 67 items in 15 groups, and Find-in-page finds them closed.
- [ ] Section under 900px tall at 1440px (was ~1,250px); no horizontal scroll at 390px.
- [ ] Phones: skill tiles swipe in one row; the row is keyboard-focusable.
- [ ] Reduced motion: no entrance, no glyph loops, no spotlight easing; all content visible.
- [ ] No console errors; frontend tests pass; Atlas still reads `capabilities`.

## Additions from localhost review

- Cloud tile link reads "See the case studies →" (was "In production →").
- Skill-tile tool lines use `--ink-muted` instead of `--ink-subtle`, for contrast.
- `cursor.js`: the bracket cursor fades out (`.is-idle`) unless it is over a
  `data-cursor="magnet"` element, so it never sits on body text. New bento
  links and the toolkit summary are magnets.
