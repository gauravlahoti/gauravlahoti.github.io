# Spec: Connect Section

## Overview

The closing CTA. Centered, minimal, single message: "Let's
build something." Below it, the Topmate primary action
(resume review / coaching) and a quiet row of email,
LinkedIn, GitHub links. This is the section that converts
interest into a Topmate booking — which is the whole point of
the site.

## Depends on

- Spec 01 (`#connect` anchor).
- User input: real Topmate URL, LinkedIn URL, GitHub URL.

## Routes

No backend.

## Database changes

No database.

## Templates

- **Create:** none.
- **Modify:** `index.html` — populate `#connect` with the CTA
  and link row.

## Files to change

- `assets/js/data/profile.json` — replace the placeholder
  links with real URLs (`topmate`, `linkedin`, `github`).
- `assets/css/layout.css` — `.connect` centered layout.
- `assets/css/components.css` — `.cta-primary`, `.link-row`,
  link-icon styling.
- `assets/js/main.js` — bind link hrefs from `profile.links`
  into `data-bind` placeholders.

## Files to create

None.

## New dependencies

None.

## Rules for implementation

- Topmate, LinkedIn, GitHub, email URLs come from
  `profile.json`. Never hardcode.
- The Topmate CTA gets a magnetic-cursor effect (deferred to
  spec 08; this spec just sets up the markup so spec 08
  doesn't have to retrofit).
- Email link uses `mailto:` scheme.
- All external links open in a new tab with
  `rel="noopener noreferrer"`.
- The section must be reachable in two ways: scroll, and
  the terminal `contact` command (already wired in spec 03).

## Definition of done

- [ ] `#connect` shows the headline "Let's build something."
      in the hero typography.
- [ ] Primary Topmate button links to `profile.links.topmate`
      and opens in a new tab.
- [ ] Below it, a sub-line lists "Resume Review · Career
      Coaching".
- [ ] A row of three icon links: email, LinkedIn, GitHub.
- [ ] All four URLs render from `profile.json`.
- [ ] All external links use `target="_blank"
      rel="noopener noreferrer"`.
- [ ] Terminal `contact` scrolls here.
- [ ] Mobile (375px) collapses gracefully — no overflow.
