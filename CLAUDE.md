# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Static, single-page AI-engineer portfolio for Gaurav Lahoti. Dark "AI terminal" aesthetic. Built spec-driven — every feature ships through a spec in `.claude/specs/`. No framework, no bundler, no Node toolchain. Open `index.html` and it runs.

## Running locally

```bash
python3 -m http.server 5173
# then open http://localhost:5173
```

Or use the project slash command: `/run-site`.

## Architecture

| Layer            | Location                                                | Notes                              |
|------------------|---------------------------------------------------------|------------------------------------|
| HTML             | `index.html`                                            | Single page; semantic anchors      |
| CSS              | `assets/css/{base,layout,components}.css`               | base = variables + typography      |
| JS modules       | `assets/js/{main,terminal,graph,shader,stories}.js`     | One module per visualization       |
| Content data     | `assets/js/data/*.json`                                 | Bio, career, projects, commands    |
| Static media     | `assets/img/`                                           | Resume PDF, OG image, favicon      |

## Conventions

- **Content lives in JSON, not HTML.** All identity, career, and project data flows out of `assets/js/data/`. Markup stays template-only so updating the bio never touches code.
- **CSS variables only — never hardcode hex.** All colours, spacing, type scale defined in `:root` in `base.css`.
- **One JS module per visualization.** Each module lazy-loads when its section enters the viewport (IntersectionObserver) so the hero isn't blocked by Three.js.
- **No npm, no bundler.** External deps load from CDN with `defer`. The repo is `git clone` → `python3 -m http.server` → working site.
- **No build step ever.** If a feature needs one, push back and find a simpler version.

## Spec workflow

Every feature follows the same loop:

1. `/create-spec <step> <slug>` writes `.claude/specs/<NN>-<slug>.md`
2. `/implement-spec <step>` reads the spec, plans, then implements
3. Manual verification per spec's "Definition of done"

Spec files are append-only history. Don't rewrite an old spec to match new code — write a new spec.

## Visualization rules

- **Hero shader** runs ≤ 60fps on a 2020 MacBook Air. Degrade to a static gradient on `prefers-reduced-motion`.
- **3D knowledge graph** has a 2D SVG fallback that triggers on small viewports (< 768px) or low-power mode.
- **Terminal** is an accelerator, not the only navigation. The visible scroll nav always works.

## Performance budget

- First Contentful Paint < 1.5s on 4G
- Total JS < 400 KB gzipped (Three.js is the largest dep)
- Lighthouse Performance ≥ 90 on desktop

## Stub routes

`index.html` currently shows a scaffolding stub. Spec 01 replaces it with the real shell (nav, hero placeholder, footer).
