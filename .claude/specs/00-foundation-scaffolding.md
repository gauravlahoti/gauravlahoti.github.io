# Spec: Foundation Scaffolding (Phase 0)

## Overview

Stand up the project's spec-driven harness before any feature
work. This spec describes the scaffolding pass that created the
folder structure, placeholder content, slash commands, skills,
and all subsequent spec files. It exists for traceability — so
six months from now you can answer "where did this all come
from?" by reading one document.

## Depends on

Nothing. This is the first step.

## Routes

No new routes (project has no backend).

## Database changes

No database (static site).

## Templates

- **Create:** `index.html` — minimal stub showing scaffold status.
- **Modify:** none.

## Files to change

None.

## Files to create

```
portfolio/
  .gitignore
  .nojekyll
  README.md
  CLAUDE.md
  index.html
  assets/
    css/{base,layout,components}.css
    js/{main,graph,shader,stories}.js
    js/data/{profile,graph,stories}.json
    img/{resume.pdf, og-image.png, favicon.svg}
  .claude/
    specs/00-09 (this file plus 01-09)
    commands/{create-spec,implement-spec,run-site,add-project,publish}.md
    skills/{portfolio-content-update,portfolio-deploy-troubleshoot}/SKILL.md
```

## New dependencies

None at scaffold time. Future specs introduce CDN-loaded:
- GSAP + ScrollTrigger
- Lenis
- Three.js
- 3d-force-graph

## Rules for implementation

- All identity content lives in `assets/js/data/profile.json`.
  Never hardcode the user's name, title, or links in HTML/CSS.
- CSS variables defined in `:root` in `base.css`. Never hardcode
  hex values anywhere else.
- One JS module per visualization. Each module exports an `init`
  function and is lazy-loaded by `main.js` when its anchor
  section enters the viewport.
- No npm, no bundler, no Node toolchain. CDN scripts only.
- Placeholder assets (PDF, PNG, SVG) ship inside `assets/img/`
  so spec implementations work without external content.

## Definition of done

- [ ] `~/Downloads/portfolio` exists with the file tree above.
- [ ] `git log` shows one initial scaffolding commit on `main`.
- [ ] `python3 -m http.server 5173` from the project root serves
      `index.html` without 404s for any referenced asset.
- [ ] Browser console shows the scaffolding `console.info`
      messages from `main.js` and zero errors.
- [ ] `assets/img/resume.pdf` opens as a valid 1-page PDF in any
      reader.
- [ ] `assets/img/og-image.png` opens as a valid 1200×630 PNG.
- [ ] `assets/img/favicon.svg` renders in the browser tab.
- [ ] `.claude/specs/` contains 10 files (00–09).
- [ ] `.claude/commands/` contains 5 files.
- [ ] `.claude/skills/` contains 2 skill subfolders, each with a
      `SKILL.md` file.
- [ ] All `assets/js/data/*.json` files parse as valid JSON.
