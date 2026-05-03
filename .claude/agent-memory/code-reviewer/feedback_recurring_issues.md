---
name: Recurring Issues Found in Code Reviews
description: Patterns to watch for across all future reviews of this codebase
type: feedback
---

**Dead markup left in HTML after spec pivots:**
Spec 22 shipped `.hero-mobile-actions` (containing `.hero-cta-mobile` and `.cert-rail-chip-mobile`) in index.html. Fix commits then set the wrapper to `display: none` globally and never re-enable it on mobile. The cert-rail-chip-mobile button also has `aria-haspopup="dialog"` and `data-cert-chip-trigger` with no JS handler. This dead markup accumulates technical debt.
Why: Fix commits change the design decision mid-stream without removing the now-unused HTML.
How to apply: After any fix commit that reverts a feature, check whether the corresponding HTML, CSS, and JS were cleaned up.

**`aria-hidden="false"` on `display: none` elements:**
`div.hero-mobile-actions` has `aria-hidden="false"` in HTML but is `display: none` globally. While AT ignores `display: none` regardless, the explicit `aria-hidden="false"` is misleading markup. Convention: omit `aria-hidden` entirely on elements that are display:none, or don't add it at all.

**CSS `display:none` + CSS transitions = no animation:**
The agent panel uses `display: none` as its base hidden state and `display: flex` in `.is-open`. Any CSS transitions on `transform` or `opacity` do not play when toggling from `display: none` to `display: flex` in a single class change. On mobile, the bottom-sheet slide-in animation does not play as a result. Fix: use `visibility: hidden` + `pointer-events: none` as the hidden state, or use a JS two-step (set display first in one frame, then add the transition class).

**Hardcoded rgba for background-color gradients:**
When using semi-transparent versions of design tokens in gradients, the codebase lacks `--bg-rgb` or similar channel-separated tokens. Developers reach for hardcoded `rgba(8, 10, 18, ...)` instead. A `--bg-rgb: 8, 10, 18` or similar token would let them write `rgba(var(--bg-rgb), 0.85)`.
