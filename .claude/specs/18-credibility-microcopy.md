# Spec: Credibility microcopy — hero subline, verifiable cert badges, footer craft signal

## Overview
Three independently trivial edits, batched into a single spec to avoid spec sprawl. Each is a small textual or interaction tweak that compounds into a perceptible credibility lift; none introduces new sections, new modules, or backend changes.

1. **Hero subline.** Today the hero tagline (`profile.json:6`, rendered at `index.html:229`) reads:
   > *"Architecting autonomous workflows that bridge legacy enterprise stacks and production-grade AI."*
   "Production-grade AI" is generic — it sounds like brochure copy. The new tagline is sharper and matches the actual work showcased by spec 15:
   > *"Architecting multi-agent systems in production — bridging legacy enterprise stacks and AI-native workflows."*
   Single edit in `profile.json`. Data-bind in `index.html:229` is already wired (`data-bind="profile.tagline"`).

2. **Verifiable cert badges.** The cert rail (`renderCertTile()` in `assets/js/main.js:183-250`, rendering data from `profile.json:42-107`) currently renders each badge as an `<li role="button">` with an `<img>` and a tooltip popover. Each entry already has a `credlyUrl` field. The badges are decorative today; click does open the Credly URL but the affordance is weak. This spec wraps the tile content in `<a href="{credlyUrl}" target="_blank" rel="noopener">` so:
   - Right-click → "Open in new tab" / copy URL works (true for `<a>`, false for `<li>`).
   - Browser status bar previews the destination URL on hover.
   - Screen readers announce the link destination correctly.
   - Hover state gets a subtle scale + accent border to signal interactivity.

3. **Footer craft signal.** The footer (`index.html:310-317`) ends with copyright + email + LinkedIn + GitHub. Add one small line:
   > `// built with Claude Code · Gemini · Three.js`
   Tiny detail, but it signals taste and reinforces the AI-native positioning without bragging. Tools listed must reflect what was *actually* used; if Three.js is the largest dep but Claude Code authored the code and Gemini grounds the (eventual) agent widget, that's the truth — say so.

## Depends on
- Spec 01 (foundation) — design tokens, footer layout
- Spec 10 (cert rail) — cert rail markup and `renderCertTile()` being modified
- Spec 02 (hero shader) — hero layout containing the tagline

## Routes
No backend.

## Database changes
No database.

## Templates
- **Modify (1) hero subline:**
  - `assets/js/data/profile.json:6` — `tagline` value swapped for the new copy. The `data-bind="profile.tagline"` attribute on `index.html:229` already wires it.
- **Modify (2) cert badges as links:**
  - `assets/js/main.js:183-250` (`renderCertTile()`) — wrap the inner content of each `<li class="cert-tile">` in an `<a>` element:
    ```html
    <li class="cert-tile is-{category}" data-slug="{slug}">
      <a class="cert-tile-link" href="{credlyUrl}" target="_blank" rel="noopener" aria-label="Verify {name} on Credly (opens in new tab)">
        <img src="{badge}" alt="{name}">
        <div class="cert-tile-popover" role="tooltip">
          <div class="cert-tile-popover-name">{name}</div>
          <div class="cert-tile-popover-meta"><span class="issuer">{issuer}</span></div>
        </div>
      </a>
    </li>
    ```
    Remove the `tabindex="0"` and `role="button"` from the `<li>` — they were a workaround for the missing native semantics; the `<a>` provides them natively. Remove any JS click handler that currently navigates to the Credly URL programmatically (now redundant with the native link).
    
    Preserve all existing classes and the `data-slug` attribute (the marquee duplicates tiles by slug).
  - `assets/css/components.css` — extend `.cert-tile` rules:
    - `.cert-tile-link { display: block; text-decoration: none; color: inherit; }` so the wrapper anchor doesn't disrupt layout or colour.
    - `.cert-tile-link:hover` and `.cert-tile-link:focus-visible` — subtle scale (`transform: scale(1.04)`) + accent border (`outline: 1px solid var(--accent)` or `box-shadow: 0 0 0 1px var(--accent)`). Honour `prefers-reduced-motion` by suppressing the scale.
    - The marquee animation must continue regardless of hover/focus on individual tiles (the existing pause-on-rail-hover behaviour stays intact).
- **Modify (3) footer craft signal:**
  - `index.html:310-317` — append a new `<span class="footer-meta">// built with Claude Code · Gemini · Three.js</span>` inside `.footer-inner`, after the existing GitHub link.
  - `assets/css/components.css` — `.footer-meta` rule: `font-family: var(--font-mono); font-size: var(--text-xs); color: var(--ink-subtle); margin-left: auto;` (or align to the inline-end of the footer-inner row depending on flex direction). On mobile, drop to a new line.

## Files to change
- `assets/js/data/profile.json`
- `assets/js/main.js`
- `index.html`
- `assets/css/components.css`

## Files to create
None.

## New dependencies
None.

## Rules for implementation
- CSS variables only — never hardcode hex. Reuse `--accent`, `--ink`, `--ink-muted`, `--ink-subtle`, `--border`, `--space-*`, `--text-*`, `--font-mono`, `--dur-fast`, `--ease-out`.
- The hero tagline change is a pure data edit. **Do not** modify `index.html:229` directly — the data-bind already wires `profile.json:6`. Editing the markup would create two sources of truth.
- The cert rail's marquee animation, hover-pause behaviour, and tile duplication for seamless looping must all continue to work. The `<a>` wrapper is purely additive — it must not change layout, dimensions, or animation timing.
- Hover state on cert tiles: subtle scale + accent border. Must be **suppressed** under `prefers-reduced-motion`. The accent border without scale is fine under reduced motion.
- Cert badge accessibility: each anchor needs an `aria-label` that names the cert and indicates new-tab behaviour (e.g. `Verify {name} on Credly (opens in new tab)`). The inner `<img>` keeps a meaningful `alt` (the cert name). Don't double-announce the cert name to screen readers — if the `aria-label` covers it, the `<img>` `alt` can be `""` (empty alt for decorative-when-wrapped-in-link). Pick one approach and apply consistently.
- Cert badge keyboard: Tab moves to each tile in order, focus ring is the accent colour, Enter activates the link (native browser behaviour). Shift+Tab returns cleanly. The previous `tabindex="0"` + `role="button"` workaround is removed once the native `<a>` is in place — the spec must verify no double-tab-stop is introduced.
- Outbound `<a>` must have `target="_blank"` and `rel="noopener"`. `rel="noopener noreferrer"` is acceptable too (matches spec 14 outbound-link convention).
- Footer line must reflect tools actually used. If Three.js isn't actually in use yet (spec 02 may not have shipped a Three.js path on the live site), substitute the truthful list. The spec is "// built with Claude Code · Gemini · Three.js" as a placeholder — adjust to reality before merge.
- Footer line styling: small, monospace, subtle. Don't compete with the existing footer text. On mobile, the line drops below or wraps cleanly — it must not push other footer content off-screen or create awkward stacking.
- All text rendered via `textContent` (where applicable) or static HTML strings. No `innerHTML`.

## Definition of done
Verifiable in a browser at `http://localhost:5173`.

### Hero subline
1. **New tagline visible.** On hard reload the hero shows: *"Architecting multi-agent systems in production — bridging legacy enterprise stacks and AI-native workflows."* Old "production-grade AI" copy is nowhere on the page (`grep` of the rendered HTML and JSON confirms).
2. **No layout shift.** The new tagline length is comparable to the old; the hero's vertical rhythm and the cert rail's position below the tagline are unchanged at desktop and mobile widths.
3. **Single source of truth.** Editing `profile.json:6` and reloading updates the hero without any HTML change. Confirmed by reverting to old text in JSON and seeing the old text reappear, then restoring.

### Cert badges as verifiable links
4. **Each badge is a link.** DevTools Elements panel on each rendered tile shows an `<a class="cert-tile-link" href="https://credly.com/..." target="_blank" rel="noopener">` wrapping the `<img>` and tooltip.
5. **Click opens new tab.** Clicking any badge opens the Credly verification URL in a new tab. Confirmed for at least three different certs.
6. **Right-click → "Copy link" works.** The browser exposes the standard link context menu (Copy link address, Open in new tab, etc.) — confirming the badges are real anchors, not button-emulated nav.
7. **Hover affordance.** Mousing over a tile triggers a subtle scale + accent border. The marquee animation pauses on rail-hover (existing behaviour) and the per-tile hover layers cleanly without jitter.
8. **`prefers-reduced-motion`.** With the OS preference enabled, the per-tile scale is suppressed; the accent border on hover/focus remains.
9. **Keyboard accessibility.** Tab moves through tiles in document order; focus ring is the accent colour; Enter opens the Credly URL in a new tab. Shift+Tab returns cleanly. Each tile is a single tab stop (no double-stop from leftover `tabindex="0"` on the `<li>`).
10. **Screen reader.** VoiceOver / NVDA announces each tile as a link with the cert name and a "(opens in new tab)" hint. No duplicate announcement of the cert name from the inner `<img>`.
11. **No JS click handler regression.** The Credly URL navigation is now native (the `<a>` does the work). Any previous JS handler on `.cert-tile` for navigation is removed; click telemetry / analytics handlers (if any) still fire.
12. **Marquee animation intact.** The seamless horizontal scroll continues to loop with no visual seam at the duplicate-tile boundary; pause-on-rail-hover behaves as before.

### Footer craft signal
13. **Line visible.** The footer shows `// built with Claude Code · Gemini · Three.js` (or the truthful equivalent agreed at merge) in monospace, small, `--ink-subtle` colour. It sits to the inline-end of the footer-inner row on desktop, below the other footer items on mobile.
14. **No truthfulness mismatch.** Tools listed in the footer line are actually used in the codebase (verified by `grep`-ing for `three`, `gemini`, etc., and matching against the deps loaded by `index.html` and any future agent backend). Lying in the footer would undermine the credibility signal the line is meant to provide.
15. **No layout overflow.** At 360 / 390 / 768 / 1100 / 1440 widths the footer renders cleanly with the new line; no horizontal scroll, no clipped text.

### Cross-cutting
16. **Lighthouse Accessibility ≥ 95** unchanged on the home page. axe DevTools reports zero new violations attributable to the hero, cert rail, or footer.
17. **Lighthouse Performance ≥ 90** unchanged. The change is microcopy + interaction; no new assets, no new modules.
18. **No console errors** during page render and cert rail interaction.
