# Spec: Agentic Harness Lab

## Overview
Adds the **Agentic Harness** as a new AI Lab and a new agent on `/live-agents/`. The harness is a
from-scratch Python agent harness (own repo, `github.com/gauravlahoti/agentic-harness`) whose
CloudCo Contract Agent runs on Gemini, with a voiced guided tour that replays recorded runs. The
hosted copy is **tour only**: visitors won't type their own API keys, so the container ships with
**no key at all** and the harness runs in a read-only "public tour mode" (built in that repo as its
stage S14). It is served from Cloud Run (`agentic-harness`, min 0, max 1) at
`https://agentic-harness.gauravlahoti.dev/`, the same pattern as the Agentic RAG lab. This repo
only owns the pointer: a lab card, a redirect stub, an agent entry and its diagram.

## Locked decisions
| Decision | Choice |
|---|---|
| Visitor experience | Guided tour only; live runs need a local clone and your own key |
| Model spend | None: no key in the container, and public mode ignores keys anyway |
| Hosting | Cloud Run `agentic-harness`, `gcp-experiments-490306`, us-central1, min 0, max 1, no secrets |
| Domain | `agentic-harness.gauravlahoti.dev` (Cloudflare CNAME → `ghs.googlehosted.com`, DNS-only) |
| Source link | Yes, "View code" to the GitHub repo (repo goes public before this ships) |
| Lab number | `05` on main; becomes `06` once the stashed AI-Native SDLC lab (specs 92–93) lands |

## Depends on
- Spec 38 (Agentic RAG Lab): the redirect-stub + off-repo Cloud Run pattern.
- Spec 89 (agent index capability matrix): `index.capabilities` vocabulary.
- Harness repo stage S14 (public tour mode + Dockerfile), deployed before this ships.

## Routes
No backend in this repo. (The harness service is deployed from its own repo.)

## Database changes
No database.

## Templates
- **Create:** `ai-labs/agentic-harness/index.html` (redirect stub), `ai-labs/agentic-harness/CLAUDE.md`
- **Modify:** none of the page shells; the AI Lab hub and `/live-agents/` render from JSON.

## Files to change
- `content/ai-concepts.json`: new card `05` (`id: harness`, LIVE, `internal: false`,
  href `/ai-labs/agentic-harness/`, CTA "Take the Guided Tour").
- `content/agents.json`: new `agentic-harness` entry (same shape as `agentic-rag`; no `demoVideo`;
  links "Try it yourself" + "View code"; capabilities `ondemand`, `team`, `acts`, `learns`).
- `assets/js/agents-page.js`: bump `agents.json?v=199` → `?v=200`.
- `CLAUDE.md`: architecture row for the new redirect stub.
- `ai-labs/CLAUDE.md`, `.claude/docs/agents.md`, `content/README.md` (if it lists labs): mention the lab.

## Files to create
- `ai-labs/agentic-harness/index.html`, `ai-labs/agentic-harness/CLAUDE.md`
- `agent-portfolio/diagrams/agentic-harness-v1.svg` (via the `diagram-agent` skill)

## New dependencies
No new dependencies.

## Rules for implementation
- All identity content lives in `content/profile.json`.
- CSS variables only — never hardcode hex.
- One JS module per visualization; lazy-load on viewport entry.
- No npm, no bundler, no Node toolchain.
- Respect `prefers-reduced-motion`.
- Mobile fallbacks for every WebGL/Three.js feature.
- Copy reads human: no em-dashes, short plain sentences.
- The redirect stub keeps both meta-refresh and `location.replace`, with the same URL in both.

## Definition of done
- [ ] `https://agentic-harness.gauravlahoti.dev/` serves the harness over HTTPS, opens on the tour, plays the voice after Start Tour.
- [ ] On the hosted app, any write (`POST /api/run`, `PUT /api/tour/audio/...`) returns 403 and `/api/health` reports `mode: public`, `key: missing`.
- [ ] `/ai-labs/` shows the Agentic Harness card; its CTA reaches the hosted tour.
- [ ] `/ai-labs/agentic-harness/` redirects to the hosted tour (also with JS disabled).
- [ ] `/live-agents/` lists Agentic Harness; its panel shows the diagram, steps, tech decisions, traits, and both links; the capability matrix includes it.
- [ ] All of the above look right at desktop and at 375px width, with no console errors.
- [ ] No em-dashes in new copy.
- [ ] `node --test 'tests/**/*.test.mjs'` passes.
- [ ] Cloud Run service: minScale 0, maxScale 1, no secrets or key env vars.
