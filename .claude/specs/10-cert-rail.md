# Spec: Certification Badge Rail

## Overview

A horizontal news-ticker strip across the bottom of the hero, scrolling
all eight certification badges continuously from right to left. AI/ML
certifications appear first in the running order, followed by cloud
fundamentals and security. Glass-morphism tiles with cyan glow; three
layered motion effects (continuous marquee crawl, per-tile shimmer
sweep, magnetic hover with slide-in popover detail). The marquee
pauses on hover so visitors can read or click any badge. CSS mask
gradient fades badges in/out at the strip's left/right edges. The
bento certs card renders the same eight badges as a static 4-column
image grid for the canonical/static view (used at every viewport, but
especially relevant on small screens where the ticker is more
constrained).

## Depends on

- Spec 02 (`#hero` foundation; the rail nests inside the hero composition).
- Spec 06 (`#bento` certs card; upgraded to render badge images alongside
  text, sharing the same data source as the rail).
- `assets/js/data/profile.json` `certifications[]` extended with
  `slug`, `category`, `issuedAt`, `badge`, `credlyUrl`.

## User input required

The user must provide **8 official badge images** (PNG, ~256×256,
transparent background where possible), one per certification, dropped
into `assets/img/badges/<slug>.png`. Sourced from Credly or directly
from each issuer's badge program. Implementation is blocked on these
files; without them the rail renders empty placeholders.

## Routes

No backend.

## Database changes

No database.

## Templates

- **Create:** none.
- **Modify:** `index.html` — add `<aside class="cert-rail" data-cert-rail>`
  inside `#hero`, after `.hero-chrome` and before `.hero-stack`.

## Files to change

- `assets/js/data/profile.json` — extend each `certifications[]` entry
  with `slug`, `category` (`ai` | `cloud` | `security`), `issuedAt`
  (YYYY-MM), `badge` (path to image), `credlyUrl` (optional). Validate
  JSON.
- `index.html` — add the empty `<aside class="cert-rail" data-cert-rail>`
  block inside `#hero`. JS hydrates it.
- `assets/css/components.css` — add ~150 LOC for `.cert-rail`,
  `.cert-rail-head`, `.cert-rail-list`, `.cert-divider`, `.cert-tile`,
  `.cert-tile.is-ai`, `.cert-tile-popover`, `@keyframes cert-shimmer`,
  hover/focus states, `prefers-reduced-motion` overrides, and the
  `display: none` mobile override.
- `assets/js/main.js` — add `initCertRail(profile)` called from the
  bootstrap. Upgrade existing `populateCerts(profile.certifications)` so
  the bento card renders badge images alongside text labels.

## Files to create

- `assets/img/badges/<slug>.png` × 8 — provided by the user. One per
  certification entry. Recommended size 256×256 PNG, transparent.

## New dependencies

No new dependencies. GSAP + ScrollTrigger are already loaded by spec 02.

## Data shape (extension)

Each entry in `profile.certifications` after this spec:

```
{
  "name":      "AWS Certified Machine Learning — Specialty",
  "issuer":    "AWS",
  "category":  "ai",
  "slug":      "aws-ml-specialty",
  "issuedAt":  "2024-09",
  "badge":     "assets/img/badges/aws-ml-specialty.png",
  "credlyUrl": "https://www.credly.com/badges/..."
}
```

Category mapping for the current 8 entries:
- `ai` (5): AWS ML Specialty, AWS ML Engineer Associate, AWS AI
   Practitioner, GCP Generative AI Leader, Azure AI Fundamentals.
- `cloud` (2): GCP Digital Leader, GCP Associate Cloud Engineer.
- `security` (1): GCP Professional Security Engineer.

JSON insertion order is preserved as authored; render code groups by
category with `ai` first, then `cloud`, then `security`.

## Rules for implementation

- All identity / cert data lives in `profile.json`. No copy in JS or HTML.
- CSS variables only — never hardcode hex. Use `--accent`, `--ink`,
  `--ink-muted`, `--border-strong`, `--accent-glow`.
- The rail is anchored absolutely inside `#hero` as a full-width strip
  near the bottom: `left: 0; right: 0; bottom: calc(var(--space-12) +
  24px); height: 96px; overflow: hidden`. It sits *above* the existing
  bottom chrome (`// 11y · since Apr 2015` and `↓ scroll to explore`)
  so chrome stays readable.
- A CSS mask gradient on the strip fades the leftmost and rightmost
  ~6 % of the row to transparent, so badges fade in/out at the edges
  rather than popping mid-tile.
- The list (`<ul class="cert-rail-list">`) is a horizontal flex row,
  `width: max-content`, animated via `@keyframes cert-ticker` from
  `translateX(0) → translateX(-50%)` over 30 s, `linear infinite`.
  The list pauses (`animation-play-state: paused`) on `:hover`.
- The list is rendered with the badge set duplicated back-to-back —
  the second copy makes the `-50%` translate land seamlessly on the
  first copy's start position. The duplicate copy is `aria-hidden`
  and `tabindex="-1"` so screen readers and keyboard users see only
  one set.
- Tiles are 72 × 72 (`flex: 0 0 72px`) with the badge image sized
  84 % inside the tile. Glass-morphism: 1 px `--border-strong` border,
  `backdrop-filter: blur(8px)`, background `rgba(255,255,255,0.04)`,
  drop-shadow with cyan glow at 0.18 alpha.
- AI tiles get a 1 px ring in `--accent` rendered as a `::before`
  pseudo (preserves the layout box) and a stronger glow (0.32 alpha).
- Three motion effects (capped — no fourth):
  1. **Marquee crawl** — pure CSS, no JS animation library. The
     30 s `cert-ticker` keyframe runs continuously; pauses on hover.
  2. **Shimmer sweep** — CSS `::after` pseudo with a diagonal gradient
     highlight, animated via `@keyframes cert-shimmer`. Duration ~7 s,
     phase randomized per tile via a `--shimmer-delay` CSS variable
     set from JS so the highlights don't sync across tiles.
  3. **Magnetic hover** — `:hover` / `:focus-visible` on a tile lifts
     it (`transform: translateY(-4px) scale(1.04)`), brightens the
     border to `--accent`, raises the glow, and reveals a
     `.cert-tile-popover` (full credential name + issuer) anchored
     below the tile (works regardless of the tile's horizontal
     position in the row, including the masked edges). Click opens
     the official Credly URL in a new tab.
- Each badge `<img>` uses `loading="lazy"` and `decoding="async"` so the
  rail does not regress LCP (which stays the hero name).
- The non-duplicate tiles are keyboard-focusable (tabindex 0,
  role=button) with Enter/Space → opens Credly, Esc → blur.
- `prefers-reduced-motion: reduce` must: stop the marquee animation
  (`animation: none`), allow `overflow-x: auto` on the rail so users
  can swipe/scroll the row manually, kill the shimmer, soften the
  hover lift, make the popover transition instant.
- Mobile (`max-width: 600px`): strip height shrinks to 80 px and
  tile size to 56 × 56; the marquee + the bento grid both stay
  visible. The strip is *not* hidden on mobile — horizontal motion
  works at every viewport.
- Total local JS budget after this spec: ≤ 18 KB gzipped (lower
  than the prior grid version since GSAP entry-stagger and
  ScrollTrigger fade-out are deleted).

## Definition of done

- [ ] `<aside class="cert-rail">` renders a full-width horizontal strip
      near the bottom of `#hero`, with 8 badge tiles cycling
      continuously right-to-left.
- [ ] The marquee loop is seamless — there is no visible jump or gap
      where the row wraps (achieved via the duplicated-tile-set + 50 %
      translate trick).
- [ ] AI tiles (5 of 8) appear first in the running order with extra
      cyan ring and stronger glow.
- [ ] Each tile renders the official badge image from
      `assets/img/badges/<slug>.png`.
- [ ] Shimmer sweep runs continuously per tile with randomized phase.
- [ ] Hovering anywhere on the strip pauses the marquee; mouse-off
      resumes it.
- [ ] Hover/focus on a tile lifts it, brightens the border, and slides
      in a popover with full credential name + issuer.
- [ ] Click on a tile opens the official Credly URL in a new tab.
- [ ] CSS mask gradient on the rail's left/right edges produces a soft
      fade-in / fade-out (no hard tile-pop at the boundaries).
- [ ] At ≤ 600 px width, strip height + tile size shrink; ticker stays
      visible (NOT hidden on mobile).
- [ ] The bento certs card still renders the same 8 badges in a 4-col
      image grid (3-col on `<375px`).
- [ ] `prefers-reduced-motion: reduce` stops the marquee; the row
      becomes horizontally scrollable manually; shimmer off; popover
      transition instant.
- [ ] Tab cycles only the first set of 8 tiles (the duplicate set is
      `aria-hidden` + `tabindex="-1"`); Enter/Space opens Credly; Esc
      blurs.
- [ ] Duplicate-set `<img>` tags use `alt=""` so screen readers don't
      announce the same 8 credentials twice.
- [ ] All badge `<img>` tags use `loading="lazy"` and
      `decoding="async"`.
- [ ] LCP unchanged (still hero name, sub-2.5 s on simulated 4G).
- [ ] Local JS gzip total ≤ 18 KB.
