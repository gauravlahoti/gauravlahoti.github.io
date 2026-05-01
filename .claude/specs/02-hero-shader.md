# Spec: Hero + WebGL Shader Background

## Overview

Make the hero section feel like an AI lab. Replace the empty
`#hero` placeholder with a full-viewport composition: a WebGL
curl-noise gradient shader rendered behind the headline, a
GSAP text-scramble effect on the user's name, two CTAs, and a
subtle "> try typing" hint that points at the terminal section.
This is the first impression — within 2 seconds the visitor
should feel something ambient, alive, and technical.

## Depends on

- Spec 01 (foundation shell with `#hero` anchor).

## Routes

No backend.

## Database changes

No database.

## Templates

- **Create:** none.
- **Modify:** `index.html` — populate `#hero` with the canvas,
  headline, subtitle, CTAs, and prompt hint.

## Files to change

- `index.html` — flesh out `#hero` markup; add a `<canvas>` for
  the shader, headline elements with `data-bind` attributes,
  CTA buttons, and the typing-hint footer.
- `assets/css/layout.css` — `.hero` layout rules (full viewport,
  centered content over canvas).
- `assets/css/components.css` — `.btn-primary`, `.btn-ghost`,
  `.hint-prompt` styles.
- `assets/js/main.js` — lazy-load `shader.js` when `#hero` is
  in view; trigger the GSAP text-scramble on `DOMContentLoaded`.
- `assets/js/shader.js` — implement `initHeroShader(canvas)`
  with a Three.js `OrthographicCamera` + fullscreen plane + a
  GLSL fragment shader doing curl noise.

## Files to create

- `assets/js/shaders/hero.frag.js` — the GLSL fragment shader
  source as a tagged template string (so we don't need a
  bundler to import .glsl files).

## New dependencies

CDN:
- Three.js core (only what we need: `Scene`, `Camera`,
  `WebGLRenderer`, `PlaneGeometry`, `ShaderMaterial`, `Mesh`)
- GSAP TextPlugin (for the scramble effect)

## Rules for implementation

- Shader runs at 60fps on a 2020 MacBook Air. Cap DPR at 1.5
  on retina to prevent shader cost from doubling.
- Pause `requestAnimationFrame` when the hero is not in
  viewport (IntersectionObserver). Resume on scroll back.
- On `prefers-reduced-motion`, render a single static frame
  and stop animating.
- WebGL fallback: if `gl` context is null, swap the canvas
  for a CSS gradient background (`background:
  radial-gradient(circle at 30% 20%, var(--accent-soft), var(--bg))`).
- Headline name uses `data-bind="profile.name"` so it renders
  from JSON. Scramble runs once on first paint, never on
  subsequent renders.
- No JS literals for colours. Pass `--accent` from CSS to the
  shader via a `uniform vec3 uAccent`.

## Definition of done

- [ ] Hero fills the viewport on desktop (100vh) and on
      mobile (svh-aware).
- [ ] WebGL canvas renders an animated curl-noise gradient
      using the accent colour.
- [ ] On load, the headline scrambles from random characters
      to "Gaurav Lahoti" over ~1s.
- [ ] Subtitle reads "AI Engineer · Deloitte" pulled from
      `profile.json`.
- [ ] One-liner shows `profile.tagline`.
- [ ] Two CTAs: "View Work" (scrolls to `#stories`) and
      "Book on Topmate" (opens `profile.links.topmate`).
- [ ] A small mono-font hint sits at the bottom: `> try typing`.
- [ ] Disabling JS still shows a static gradient + the
      headline (no blank screen).
- [ ] On `prefers-reduced-motion`, the shader renders a single
      frame and the scramble is skipped.
- [ ] Lighthouse Performance still ≥ 90; total JS ≤ 250 KB
      gzipped at this point.
