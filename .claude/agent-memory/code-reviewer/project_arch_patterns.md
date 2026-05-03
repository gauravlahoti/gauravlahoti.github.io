---
name: Architectural Patterns — JS Modules and Event Bus
description: How isNarrow, event delegation, and agent widget API are wired in this codebase
type: project
---

**`isNarrow` is a boolean snapshot, not a live MQL:**
`const isNarrow = matchMedia("(max-width: 767px)").matches;` in both `main.js` and `trajectory.js`. This is intentional — mobile JS behaviors only trigger on a mobile-width load. CSS media queries handle resize. Spec 22 codified this pattern.

**Agent widget open/close API:**
`initAgentWidget()` returns `{ open, close }`. The widget is lazy-loaded via `requestIdleCallback`. External callers (bottom-bar button, hero CTA) use a delegated click listener in `main.js` that matches `[data-agent-open]`, calls `start()` (which imports the module on demand if not already loaded), then calls `api.open()`. The FAB's own click handler is excluded by class check.

**Body attribute for panel state:**
When the agent panel is open, `document.body.setAttribute("data-agent-open", "true")` is set. CSS uses `body[data-agent-open="true"]` to hide the FAB and mobile-bottombar. Note: `[data-agent-open]` (without value) is also used as a trigger attribute on buttons — this is a naming collision in HTML attribute semantics but does not cause bugs because the CSS selector uses the `="true"` value form and the JS click delegation targets the button elements by attribute presence.

**Event bus conventions:**
- Custom events dispatched on `window` must be listened on `window`, not `document`.
- Custom events dispatched on `document` bubble to `window`.
- Spec 22 introduced a bug: `portfolio:scroll-to` is dispatched on `window` in `setupSectionProgress()` but the listener is on `document` in `wireScrollTo()`. The event never reaches its handler. The direct `scrollIntoView()` call is the actual scroll mechanism.

**IntersectionObserver for visibility:**
Every lazy-loaded module (hero-graph, trajectory, bento, posts) uses IntersectionObserver. The section-progress strip also uses IO with `rootMargin: "-40% 0px -55% 0px"` to track which section is "active."
