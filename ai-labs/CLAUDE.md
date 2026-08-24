# CLAUDE.md — AI Lab hub

Guidance for `/ai-labs/`, the landing page that lists every lab as a card. The repo-wide
rules in the root `CLAUDE.md` still apply and win on any conflict.

## What it is

A gallery page (`ai-labs/index.html`) that renders one card per entry in
`content/ai-concepts.json`'s `concepts[]` array, built by `assets/js/ai-concepts-page.js`.
It's the nav's "AI Lab" destination (`/ai-labs/`) and the parent folder for every lab:

| Path | What |
|------|------|
| `ai-labs/index.html` | This hub |
| `ai-labs/mcp-lab/` | MCP Lab — see its own `CLAUDE.md` |
| `ai-labs/engineering-loops/` | Engineering Loops — see its own `CLAUDE.md` |
| `ai-labs/agent-ready/` | Agent-Ready Web (WebMCP demo) — see its own `CLAUDE.md` |
| `ai-labs/rag-lab/` | RAG Lab redirect stub — see its own `CLAUDE.md` |

## Design choice: cards are pure data, the hub has no lab-specific code

`ai-concepts-page.js` doesn't know anything about any individual lab — it only knows the
card schema. Adding a new lab never touches this file; it's a `content/ai-concepts.json`
edit plus the lab's own directory:

```json
{
  "id": "loops",
  "num": "03",
  "status": "LIVE",
  "title": "Engineering Loops",
  "tagline": "How agents grew up, in four nested loops",
  "description": "Prompt, context, harness, loop. ...",
  "tags": ["Agents", "Prompting", "Harness"],
  "href": "/ai-labs/engineering-loops/",
  "internal": true,
  "cta": "Open Engineering Loops"
}
```

- `internal: true` routes the click through `runPageTransition()` (the Neural-Slash wipe
  shared with the rest of the site) instead of a plain navigation; **every lab that lives in
  this repo should be `internal: true`**. RAG Lab is `internal: false` since it redirects
  off-domain and a same-site page transition doesn't make sense for it.
- `num` is just display text (`"01"`, `"02"`, …), not an array index — keep it in sync with
  card order manually if you reorder `concepts[]`.
- `status` defaults to `"LIVE"` if omitted; use it for `"SOON"`/`"WIP"` etc. if a lab is
  linked before it's finished.
- The whole card is clickable (not just the CTA link) — `buildCard()` wires both pointer and
  keyboard (`Enter`/`Space`) activation, and `aria-label` is built from `title` + `tagline`.
  Don't hand-roll a competing click handler on card contents.

## Adding a new lab: checklist

1. Build the lab under `ai-labs/<slug>/` (own `index.html`, reusing the shared nav chrome —
   copy an existing lab's `<head>`/nav markup rather than the main site's, it's a different
   shell).
2. Add its content JSON under `content/` if it needs one, its JS engine under `assets/js/`,
   its CSS under `assets/css/` — same shared-top-level-folder convention every other lab
   uses (labs don't get their own nested `assets/`/`content/`).
3. Add one entry to `content/ai-concepts.json`'s `concepts[]`.
4. Add `<link rel="canonical">` / `og:url` in the new lab's `index.html` pointing at its real
   `/ai-labs/<slug>/` URL.
5. Write a `CLAUDE.md` inside the new lab's own directory (this repo's convention: every lab
   under `ai-labs/` documents its own critical design choices, style rules, and gotchas
   locally rather than bloating this file or the root one).
6. Update the root `CLAUDE.md`'s architecture table with the new lab's row.

## Verify

```bash
python3 -m http.server 5173   # then open /ai-labs/
```

Confirm the new card renders with correct copy/tags, the whole card (not just the button) is
clickable, keyboard nav (`Tab` → `Enter`) reaches it, and clicking it plays the page
transition into the lab (or navigates off-site cleanly for a redirect-style entry like RAG
Lab).
