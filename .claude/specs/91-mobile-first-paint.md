# Spec 91: Faster first paint on phones

PageSpeed scored the home page 96 on desktop but 60 to 67 on mobile: FCP 4.8 s, LCP 5.2 to 8.2 s, CLS 0.09 to 0.10. TBT was 0, so script cost wasn't the problem. The network was. On a phone, especially a cold LinkedIn in-app browser, the screen stayed black for about 5 s.

## What was slowing it down

1. **Two cross-origin render-blocking stylesheets** for fonts (`rsms.me/inter/inter.css`, jsdelivr's `@fontsource/jetbrains-mono`). Each needs DNS, TCP and TLS to a new host before first paint.
2. **458 KB of Inter**: four full static files (Regular, SemiBold, Bold, Italic), competing for bandwidth with the CSS and the portrait.
3. **The widget downloaded twice.** `<link rel="modulepreload" href="agent-widget.js?v=341">` had drifted from `main.js`'s `?v=348`, so phones fetched the 53 KB widget twice, and the first copy landed in the critical window.
4. **Oversized images.** Badge PNGs up to 1567 px (300 KB) shown at about 130 px, skill icons up to 1040 px shown at about 45 px, and a 736 px portrait inside a 170 to 220 px circle on phones. About 1.5 MB in total.
5. **Name-scramble reflow.** `scrambleName()` swapped random glyphs, each a different width, into the inline-block `.char` spans, which caused a dozen-plus small layout shifts per load.

## What changed

- **Self-hosted fonts** in `assets/fonts/`, declared at the top of `base.css`, which every page loads.
  - `inter-var.woff2` (48 KB) is Inter 4.1's variable font. It was cut with fonttools: `opsz` pinned to 14 (the "text" cut the static files used, so big headings keep their design), weight 200 to 700, and Latin plus every arrow and symbol the site prints. It's preloaded. No italic file; the four italic rules use the synthesized slant.
  - `jetbrains-mono-latin-400-normal.woff2` (21 KB), the only weight in use.
  - `"Inter Fallback"`: Arial with Inter's metrics (`size-adjust` etc.), placed second in `--font-sans` so the swap doesn't move text.
  - CDN font links, the rsms.me preconnect and rsms.me in the CSP are gone from `index.html`, `live-agents/`, `ai-labs/**`, `insights/**`, `scripts/gen-post-pages.mjs` and the diagram-video template.
  - To rebuild the Inter file: run `fonttools varLib.instancer InterVariable.woff2 opsz=14 wght=200:700`, then `pyftsubset` with the unicode list in the comment above the `@font-face`, `--layout-features+=tnum --flavor=woff2`.
- **Removed the stale widget `modulepreload`.** `main.js` already loads it on idle or first tap with the right `?v=`.
- **Smaller image copies, originals kept.** Badges are 256 px `.webp` and skill icons 192 px `.webp`, next to the untouched PNGs. `content/profile.json` (+ the Atlas corpus copy) and `skills-hex.js` point at them. The portrait gets 240 and 480 px cuts through `srcset`/`sizes`. Badges and skills went from 1,561 KB to 184 KB.
- **Scramble pins widths.** Each char is measured once when the scramble starts and held at that width while random glyphs cycle. It's unpinned when it locks to its real letter, which fits exactly.
- Cache-bust: `base.css?v=349` on every page, `ASSET_VERSION` and `main.js?v=349`, and the generator's `ASSET_V`.

## Not changed

- GitHub Pages' `Cache-Control: max-age=600` (the "efficient cache lifetimes" audit). It's not configurable on Pages and doesn't affect the score.
- Minify CSS/JS. That would need a build step, which the repo rules out.
- Splitting `components.css` (182 KB raw, 41 KB gzip). This is the next lever if mobile is still short of target.
- Insight pages were edited in place, not regenerated, because of the generator drift noted in spec 90.

## Definition of done

- [x] No `rsms.me` or `@fontsource` requests on any page; one Inter file, one mono file.
- [x] One `agent-widget.js` request per load.
- [x] Phones load `portrait-240`/`-480`, and badges and skills load as `.webp`.
- [x] No `.char` entries in a trace's layout-shift culprits.
- [x] Lighthouse mobile is better than before under the same conditions; desktop is no worse.
- [x] Visual parity at mobile and desktop widths (weights, mono labels, badges, hexes, portrait).
- [x] `node --test 'tests/**/*.test.mjs'` passes.

## Results

Measured with the Lighthouse 12 CLI (same scoring as PageSpeed). `main` and this branch were both served by a local gzip + HTTP/1.1 server, interleaved, with nothing else running.

| | Before (main) | After |
|---|---|---|
| Mobile score | 53 / 58 / 54 | 81 / 96 / 97 |
| Mobile FCP | 5.5 to 5.7 s | 1.6 to 2.4 s |
| Mobile LCP | 8.0 to 9.1 s | 2.0 to 3.5 s |
| Mobile CLS | 0.07 to 0.09 | 0 to 0.019 |
| Desktop score | 67 / 95 | 97 / 100 |

## Still open

The hero name's scramble intro hides each letter until GSAP, `main.js` and `profile.json` have all arrived. If the script runs before first paint, LCP waits for that reveal; that's the one 81 run above, at LCP 3.5 s. Starting the scramble from the visible name, as a "decode" over real letters instead of type-in from blank, would make LCP land at first paint every time. That's a visual change, so it's left for a follow-up.
