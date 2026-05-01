# Portfolio — Gaurav Lahoti

Static, single-page AI-engineer portfolio. Dark terminal aesthetic. Built spec-driven with [Claude Code](https://claude.com/claude-code).

## Run locally

```bash
python3 -m http.server 5173
open http://localhost:5173
```

No build step. No dependencies installed locally — Three.js, GSAP, and Lenis load from CDN at runtime.

## Update content

Personal content lives in `assets/js/data/`:

| File             | Holds                                       |
|------------------|---------------------------------------------|
| `profile.json`   | Name, title, tagline, bio, social links     |
| `graph.json`     | Career nodes + edges for the 3D graph       |
| `stories.json`   | Case-study narrative beats                  |

The resume PDF lives at `assets/img/resume.pdf`. Replace the file in place — no code change needed.

## Spec workflow

Every feature is built through a spec under `.claude/specs/`. The roadmap:

| Spec | Title                       |
|------|-----------------------------|
| 01   | Foundation                  |
| 02   | Hero + WebGL shader         |
| 04   | Career trajectory           |
| 05   | Scroll storytelling         |
| 06   | Bento grid                  |
| 07   | Connect section             |
| 08   | Polish                      |
| 09   | Deploy                      |

To start a new feature: `/create-spec <step> <slug>`.
To implement an existing spec: `/implement-spec <step>`.

## Deploy

Spec 09 sets up GitHub Pages + custom domain. Until then, the site only runs locally.

## License

All rights reserved.
