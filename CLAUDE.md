# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Static, single-page Cloud & AI architect portfolio for Gaurav Lahoti. Dark "AI terminal" aesthetic — landing hero is an "Agent Mesh" (3D node-edge graph with A2A-style edge pulses, chrome status panel, LLM-style token-streaming tagline). Built spec-driven — every feature ships through a spec in `.claude/specs/`. No framework, no bundler, no Node toolchain. Open `index.html` and it runs.

## Running locally

```bash
python3 -m http.server 5173
# then open http://localhost:5173
```

## Slash commands

- `/run-site` — boot the static server
- `/create-spec <step> <slug>` — scaffold a new spec + feature branch
- `/implement-spec <step>` — read spec, plan, implement
- `/add-project` — add a node to `graph.json` + a story stub to `stories.json` (don't hand-edit both)
- `/publish` — commit, push, trigger Pages deploy

## Architecture

| Layer            | Location                                                | Notes                              |
|------------------|---------------------------------------------------------|------------------------------------|
| HTML             | `index.html`                                            | Single page; semantic anchors      |
| CSS              | `assets/css/{base,layout,components}.css`               | base = variables + typography      |
| JS modules       | `assets/js/{main,terminal,graph,shader,stories}.js`     | One module per visualization       |
| Content data     | `assets/js/data/*.json`                                 | See data files below               |
| Static media     | `assets/img/`                                           | Resume PDF, OG image, favicon      |

Data files: `profile.json` (identity, bio, socials), `graph.json` (career nodes/edges), `stories.json` (case-study beats), `commands.json` (terminal registry).

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

Spec files are append-only history. Don't rewrite an old spec to match new code — write a new spec. Specs are zero-padded (`00-`, `01-`, …); `00` documents initial scaffolding, new features pick the next unused number.

## Visualization rules

- **Hero shader** runs ≤ 60fps on a 2020 MacBook Air. Degrade to a static gradient on `prefers-reduced-motion`.
- **3D knowledge graph** has a 2D SVG fallback that triggers on small viewports (< 768px) or low-power mode.
- **Terminal** is an accelerator, not the only navigation. The visible scroll nav always works.

## Performance budget

- First Contentful Paint < 1.5s on 4G
- Total JS < 400 KB gzipped (Three.js is the largest dep)
- Lighthouse Performance ≥ 90 on desktop

## Deploy

Deploys to GitHub Pages from `main`. `.nojekyll` at the repo root disables Jekyll processing so paths starting with `_` aren't dropped. Spec 09 covers Pages + custom domain setup.
