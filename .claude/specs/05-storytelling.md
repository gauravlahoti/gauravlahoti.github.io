# Spec: Scroll-Driven Storytelling (Case Studies × 2)

## Overview

Pick the two strongest projects and turn each into a pinned,
scroll-driven case study. The left column stays fixed
(title, problem, role, stack); the right column hosts a visual
that morphs as you scroll through 4-5 narrative beats:
problem → approach → key insight → result. This converts a
flat "here's a project" card into a 30-second story that
recruiters actually read to the end.

## Depends on

- Spec 01 (`#stories` anchor).
- Spec 04 (graph nodes link here via `anchor` field).
- `assets/js/data/stories.json` is populated with three
  candidate case studies: `fiber-broadband-fabric`,
  `ssd-lead-to-cash`, `quote-to-cash-cpq`. This spec features
  **two** of them (default: `fiber-broadband-fabric` +
  `ssd-lead-to-cash` — most recent, biggest scope, strongest
  metrics). The third stays in the JSON as a candidate for
  later swap.

## Routes

No backend.

## Database changes

No database.

## Templates

- **Create:** none.
- **Modify:** `index.html` — `#stories` section gets two
  pinned `<article class="story">` elements with sticky
  left + scrolling right.

## Files to change

- `assets/js/data/stories.json` — already populated with three
  case studies. Schema (real example from `fiber-broadband-fabric`):
  ```
  {
    "stories": [
      {
        "id": "fiber-broadband-fabric",
        "title": "Cloud-native fabric for a US fiber broadband leader",
        "problem": "...",
        "role": "Lead Architect · 20+ developer squad",
        "stack": ["GCP", "Cloud Run", "Pub/Sub", "Apigee X", "Python"],
        "client": "Fiber Broadband Service Provider (US)",
        "period": "2023 — Present",
        "beats": [
          { "title": "Problem",  "body": "...", "visual": { "type": "code", "lang": "text", "body": "..." } },
          { "title": "Approach", "body": "...", "visual": { ... } },
          { "title": "Insight",  "body": "...", "visual": { ... } },
          { "title": "Result",   "body": "...", "visual": { ... } }
        ]
      }
    ]
  }
  ```
  The DOM anchor for each story is `#story-<id>` (e.g.
  `#story-fiber-broadband-fabric`), matching the `anchor` field
  on the graph's project nodes.
- `assets/js/stories.js` — implement `initStories(sections, data)`
  using GSAP ScrollTrigger pin + scrub. Each beat's text fades
  in/out and the right-column visual swaps.
- `assets/css/layout.css` — sticky two-column layout for each
  story.
- `assets/css/components.css` — beat card, role/stack chip,
  visual frame styling.

## Files to create

None.

## New dependencies

None beyond what spec 02 / 04 already loaded (GSAP +
ScrollTrigger).

## Rules for implementation

- All story content comes from `stories.json`. No copy lives
  in HTML or JS.
- Each story pins its left column for the duration of its
  scroll. Use ScrollTrigger `pin: true, scrub: 0.5` for
  smooth coupling.
- Visuals on the right are swappable: support `image`,
  `svg`, `code`, and `iframe` types. Implementation can ship
  with `image` + `code` only and add others later.
- On mobile (< 768px): no pinning. The story degrades to a
  vertical sequence of beats, each full-viewport, with
  scroll-fade transitions.
- The horizontal sticky layout uses CSS Grid, not JS
  positioning — only the morph is animated via GSAP.
- ScrollTrigger.refresh() runs once on font-load so layout
  shifts don't break pin offsets.

## Definition of done

- [ ] `#stories` shows exactly two pinned case studies on
      desktop (default: `fiber-broadband-fabric` and
      `ssd-lead-to-cash`).
- [ ] Scrolling each story advances through 4-5 beats; the
      left column stays pinned, the right visual morphs.
- [ ] `stories.json` is the only place beat copy lives.
- [ ] Clicking a project node in the graph (spec 04) scrolls
      precisely to the matching `#story-…` anchor.
- [ ] Mobile shows the same content as a vertical scroll
      sequence, no horizontal pin.
- [ ] No layout shift after the first paint (ScrollTrigger
      refresh on font-load).
- [ ] `prefers-reduced-motion` skips the scrub animation;
      beats appear instantly when entered.
