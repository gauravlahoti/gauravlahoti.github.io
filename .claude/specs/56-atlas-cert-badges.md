# Spec 56 — Atlas renders certification badges in the chat widget

**Status:** implemented
**Branch:** `56-atlas-cert-badges`

## Problem

Asked "what certifications does Gaurav hold?", Atlas returned a plain-text list of
names. The badge art already existed (`assets/img/badges/`, 14 PNGs) and already ran in
the hero cert rail, but the chat widget had no way to show it.

The motivating artefact is a screenshot: Atlas answering a certification question with
the badges rendered inline. It proves two things at once that nobody else can post, the
credentials being real and the agent reporting them being Gaurav's own build.

## Constraint

Atlas replies are plain text. `renderTextWithLinks()` in `assets/js/agent-widget.js`
understands only bare allowlisted URLs and `[N]` citation markers, and `instruction.py`
explicitly tells the model the frontend does not render Markdown. Badges therefore
cannot come from the model writing image syntax.

## Design

Badges ride the existing `[[META]]` channel, the same one citations, suggestions and CTA
use: parsed and validated server-side, stripped from the visible stream, re-emitted as a
typed SSE event, rendered as DOM after the stream finishes.

**The model only ever emits slugs.** The widget already holds `profile.certifications`,
so it resolves every image path and verification link from its own data. The model cannot
introduce a URL into the page, and a slug it invented resolves to nothing and renders
nothing. Server-side validation is format-only (`_SLUG_RE`); authorization is structural.

No image is ever sent to the model, so there is no vision-token cost. The added cost is a
slug list in the meta block plus `slug` on the cert tool result, well under 200 tokens on
certification turns and zero on every other turn.

## Changes

| File | Change |
|------|--------|
| `agents/atlas/app/tools.py` | `get_certifications()` also returns `slug` (not `badge` — the widget owns image paths) |
| `agents/atlas/app/api.py` | `_SLUG_RE` + `_MAX_BADGES`; `_parse_meta` returns a 4-tuple with validated, de-duplicated, capped badge slugs; new `{"badges":[...]}` SSE event |
| `agents/atlas/app/instruction.py` | `badges` key in the META schema; rules for which slugs to emit; worked examples 9 and 10; example 8 updated; cert citation mapping now defers to badges |
| `content/profile.json` | `shortName` on all 14 certifications |
| `assets/js/agent-widget.js` | `FEATURES.badges`, SSE dispatch branch, `onBadges`, `renderBadgeStrip()` + `buildBadgeTile()`, `ISSUER_ORDER` |
| `assets/css/components.css` | `.agent-badges` / `-group` / `-group-label` / `-grid` / `-tile` / `-art` / `-name` |
| `index.html`, `assets/js/main.js` | asset version 281 → 282 (components.css 279 → 282) |
| `agents/atlas/tests/unit/test_meta_parser.py` | 8 badge cases; existing call sites updated for the 4-tuple |

## Rendering decisions

- **All 14 on a broad question, grouped by issuer** (`ISSUER_ORDER`: Anthropic, AWS,
  Google Cloud, Microsoft; unknown issuers sort last). A scoped question renders only the
  matching subset. Same code path either way.
- **Group labels appear only when the reply spans more than one issuer.** A lone
  "Anthropic" header over four Anthropic badges is noise.
- **Every badge carries a visible caption, not just a `title` tooltip.** Hover does not
  exist in a screenshot or on touch, and the art is unreadable at 48px, so the name has
  to be on the page. `shortName` drops the vendor prefix because the issuer is already
  the group heading.
- **Tiles are 78px so four fit per row** (4×78 + 3×8 gap = 336, inside ~346px of usable
  transcript width). This is what makes the Anthropic set land as one clean row instead
  of wrapping 3+1.
- **Badges link to their verification page**, reusing `renderCertTile()`'s `<a>`/`<div>`
  fallback. The Agentic Premier League cert has no `credlyUrl` and renders unlinked.
- Rendered in `onDone` after `finalizeAssistant()`, so it inherits
  `await revealQueue.whenDrained()` and is correctly skipped on a stopped turn.

## Definition of done

- [x] `get_certifications()` returns a slug for all 14 certs
- [x] `_parse_meta` drops non-strings, malformed slugs, duplicates; caps at `_MAX_BADGES`
- [x] `uv run pytest tests/unit tests/integration` green (97 passed, including 8 new badge cases)
- [x] `agents-cli lint` introduces no new errors (12 pre-existing on main, unchanged)
- [x] Scoped question renders 4 badges, one row, captions legible
- [x] Broad question renders 14 badges in 4 issuer groups, no clipped captions
- [x] No horizontal overflow; no CSP violations; no broken images
- [ ] `make corpus`, eval baselined, deploy approved

## Verification performed

A local stub served the real static site and a canned `/api/agent-chat` SSE stream from
one origin (so `connect-src 'self'` allowed it), driving the real widget code without a
deploy. Confirmed via DOM assertions: 14 tiles, groups Anthropic 4 / AWS 3 / Google Cloud
6 / Microsoft 1, one unlinked tile in Google Cloud, zero broken images, zero clipped
captions, no horizontal overflow.
