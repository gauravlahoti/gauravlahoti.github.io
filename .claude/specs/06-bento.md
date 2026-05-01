# Spec: Bento Grid (Stats, Skills, Education, Certifications)

## Overview

Lower the temperature after the headline visualizations.
A bento-grid section that gives substance — concrete numbers
(years, projects, talks), the full skills list, education,
and certifications. Scroll-reveal animation, but no WebGL.
This is where the visitor who's already impressed comes to
verify the credentials match the spectacle.

## Depends on

- Spec 01 (`#bento` anchor).

## Routes

No backend.

## Database changes

No database.

## Templates

- **Create:** none.
- **Modify:** `index.html` — populate `#bento` with a CSS
  grid of cards.

## Files to change

- `assets/js/data/profile.json` — extend `stats` with real
  values (after the user provides resume info). Add
  `education`, `certifications`, `skills` arrays.
- `assets/css/layout.css` — `.bento`, `.bento-grid`,
  `.bento-card` styles. CSS Grid with `grid-template-areas`
  for hero card + 5-6 sub-cards.
- `assets/css/components.css` — card hover, accent borders,
  skill chip.
- `assets/js/main.js` — when `#bento` enters viewport, call
  GSAP to stagger-fade the cards in.

## Files to create

None.

## New dependencies

None.

## Rules for implementation

- Card content comes from `profile.json` (stats, skills,
  education, certifications). No literals in HTML beyond
  layout structure.
- Use a 12-column CSS Grid with named areas for
  desktop. Mobile collapses to single-column stack.
- Skills are rendered as clickable chips. Clicking a skill
  scrolls to `#graph` with that skill's node pre-highlighted
  (custom event `portfolio:highlight-skill` consumed by
  `graph.js`).
- Stats use the GSAP `to` tween from 0 to target on enter
  (counter animation). Cap at 60fps.
- No icons from external icon libraries. Use a small inline
  SVG sprite at the top of `index.html`.

## Definition of done

- [ ] `#bento` shows a hero card ("I build LLM systems that
      ship.") plus stat cards, skills card, education card,
      certifications card.
- [ ] Stats animate from 0 on first enter.
- [ ] Skills render as chips pulled from `profile.json`.
- [ ] Clicking a skill chip scrolls to `#graph` and
      highlights that skill node.
- [ ] All copy lives in `profile.json`.
- [ ] Mobile (375px) shows the same content as a
      single-column stack.
- [ ] Cards stagger-reveal on scroll with no layout shift.
- [ ] Lighthouse Performance still ≥ 90.
