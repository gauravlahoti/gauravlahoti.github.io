---
name: portfolio-content-update
description: Use when the user wants to update bio, add/remove a role, swap the resume PDF, change Topmate or social links, or add a new project to the portfolio site. Walks through editing the right JSON file (profile.json, graph.json) and the matching media in assets/img/ so spec implementations don't break. Examples - "update my bio", "add a new role at Anthropic", "the resume changed", "change my Topmate URL", "add a project I just shipped".
---

# Portfolio content update

The portfolio site is content-driven by JSON files under
`content/`. Updating the user's information should never
require touching HTML, CSS, or JS code. This skill is the
checklist for doing that cleanly.

## Where each thing lives

| What                          | File                             | Notes                              |
|-------------------------------|----------------------------------|------------------------------------|
| Name, title, tagline, bio     | `content/profile.json`    | Top-level fields                   |
| Topmate / LinkedIn / GitHub   | `content/profile.json`    | `links` object                     |
| Email                         | `content/profile.json`    | `links.email`                      |
| Stats (years, projects)       | `content/profile.json`    | `stats` object                     |
| Skills list (bento card)      | `content/profile.json`    | `skills` array                     |
| Education / certifications    | `content/profile.json`    | arrays                             |
| Career graph (companies, projects, skills, edges) | `content/graph.json` | nodes + edges                      |
| Cert badges (images)          | `assets/img/badges/<slug>.png`   | one per certification              |
| Resume PDF                    | `assets/img/resume.pdf`          | replace file in place              |
| OG image                      | `assets/img/og-image.png`        | 1200×630 PNG                       |
| Favicon                       | `assets/img/favicon.svg`         | SVG with project tokens            |

## Workflow

### Updating bio / links

1. Open `content/profile.json`.
2. Edit the relevant field.
3. Validate the JSON parses (`python3 -m json.tool < profile.json`).
4. Refresh the local site to confirm.

### Adding a project

Use `/add-project <slug>` — it appends a node + edges to
`graph.json` and prompts for the missing fields.

### Adding a new role at a new company

1. Add a `company` node to `graph.json` with `id` matching the
   slug.
2. Add edges from existing project nodes to the new company if
   relevant.
3. Update `profile.stats.yearsInAi` if applicable.

### Replacing the resume

1. Drop the new PDF at `assets/img/resume.pdf` (same path).
2. The terminal `resume` command and the bento download button
   both already point here — no code change needed.

### Replacing the OG image

1. Generate a 1200×630 PNG with the user's name + tagline +
   accent.
2. Save as `assets/img/og-image.png`.
3. Optionally, also bump the `og:image` query string in
   `index.html` (`?v=2`) to bust social-platform caches.

## Validation checklist

After any update:

- [ ] All edited JSON files parse (`python3 -m json.tool`).
- [ ] Local server (`python3 -m http.server 5173`) shows the
      change.
- [ ] No console errors.
- [ ] Lighthouse Performance still ≥ 90.

## What NOT to do

- Don't put copy in HTML or JS strings. If a spec template
  references content directly, fix the spec first.
- Don't rename JSON fields without searching the JS modules
  that consume them.
- Don't commit and push at the same time as content updates
  unless `/publish` checks pass.
