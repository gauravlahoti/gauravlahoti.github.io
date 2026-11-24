# Spec: Credly Link

## Overview
The hero badge strip links each certification to its own verification page, but nothing points to the full Credly profile. This spec adds a plain "Credly" link to the footer, next to LinkedIn and GitHub, on the home page and every insight page. It also adds the Credly profile to the Person `sameAs` so Google ties it to this site. A "Verify on Credly" tile at the end of the badge strip was tried first and dropped: every badge already links to its own verification, so the tile was redundant and looked out of place. It also corrects the hidden certification chip text. The site holds 13 certifications (the 12 on the resume plus Azure AI Fundamentals) and 1 award (the Agentic Premier League Champion).

## Depends on
- Spec 10 (certification badge rail), spec 22.1 (the mobile cert chip is hidden; the strip is the only certification surface), spec 103 (Person JSON-LD).

## Routes
No backend.

## Database changes
No database.

## Templates
- **Create:** this spec
- **Modify:** `content/profile.json`, `index.html`, `scripts/gen-post-pages.mjs`, `llms.txt`, the insight pages (regenerated)

## Files to change
- `content/profile.json`: `links.credly` = `https://www.credly.com/users/gaurav-lahoti.a6cc6340`
- `index.html`
  - Add the Credly URL to Person `sameAs`.
  - Hidden chip text becomes "13 certifications · Anthropic · GCP · AWS · Azure".
  - Footer: `<a class="footer-link" data-bind-href="profile.links.credly">Credly</a>` after GitHub. It uses the existing `bindDOM` href binding, so no JS changes are needed.
- `scripts/gen-post-pages.mjs`: the same Credly link in the insight page footer, after GitHub.
- `llms.txt`: add Credly under Contact.

## New dependencies
No new dependencies.

## Rules for implementation
- All identity content lives in `content/profile.json`.
- CSS variables only. Never hardcode hex.
- One JS module per visualization; lazy-load on viewport entry.
- No npm, no bundler, no Node toolchain.
- Respect `prefers-reduced-motion`.
- Mobile fallbacks for every WebGL/Three.js feature.

## Definition of done
- [ ] The home footer reads `... LinkedIn  GitHub  Credly`, and Credly opens the profile in a new tab
- [ ] Every insight page footer has the same link
- [ ] Re-running `node scripts/gen-post-pages.mjs` leaves the files unchanged
- [ ] Home JSON-LD parses and its `sameAs` includes the Credly URL
