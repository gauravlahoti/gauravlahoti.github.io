# Spec: Book A Session CTA

## Overview
The Topmate page now sells real 1:1 sessions, but the site only reaches it through a grey ghost "Let's Talk" button in the nav. The label reads like a contact form, the styling is the quietest on the page, and nothing else on the site mentions sessions. This spec makes the booking path visible where intent is highest: a renamed, accent-styled nav button on every page, a third hero button, a session box at the end of every insight post, a footer link, and Atlas suggesting a session when the conversation is about certs, career moves or interview prep. Copy stays on mentorship and career guidance, never "consulting" or "hire me", so it sits safely beside a full-time Deloitte role. The time-boxed BF10 banner (announcement bar) is explicitly out of scope.

## Depends on
- Spec 99 (resume link and mobile nav): nav and drawer markup.
- Spec 104 (insight pages): `scripts/gen-post-pages.mjs` generates every insight page.
- Spec 21 / 37 (Atlas widget + corpus): `availability` fields in `profile.json`.

## Routes
No backend.

## Database changes
No database.

## Templates
- **Create:** none.
- **Modify:** nav + drawer CTA on all standalone pages, hero CTA group, insight post template, footers.

## Files to change
- `index.html`: nav CTA and drawer CTA become "Book a 1:1" with `btn-outline-accent`; a "Book a 1:1 session →" text link beside "See agents in production →" (a third hero button crowded the row and duplicated the nav CTA); footer gains a "1:1 sessions" link bound to `profile.links.topmate`.
- `live-agents/index.html`, `selected-work/index.html`, `ai-labs/index.html`, `ai-labs/mcp-lab/index.html`, `ai-labs/engineering-loops/index.html`, `ai-labs/agent-ready/index.html`: same nav + drawer CTA change.
- `scripts/gen-post-pages.mjs`: same nav + drawer CTA change; a new session box between the article and "More from Gaurav"; footer "1:1 sessions" link. Re-run to regenerate `insights/*/index.html` and `sitemap.xml`.
- `assets/css/insight.css`: styles for the session box (tokens only).
- `content/profile.json`: `availability.consulting` no longer says he takes outside consulting work; `availability.advisory` names what the sessions cover.
- `agents/atlas/app/instruction.py`, `agents/atlas/app/live_brain.py`: cert prep, moving into cloud/AI roles and architect interview prep route to Topmate (`cta: "topmate"`); examples that quote "select consulting" are updated to match the new availability copy.
- `agents/atlas/app/corpus/profile.json`: refreshed via `make corpus`.

### Added during review
- `content/profile.json` `heroAsk.prompts`: four questions that show Atlas acting, not reciting (agents in production, career arc, email the resume, pass a note).
- `content/ai-concepts.json`: hook-style `atlasPrompt` for the MCP, Agentic RAG and Agentic Harness labs; Engineering Loops and Agent-Ready Web leave the pop-up rotation (still on the AI Lab page).
- `assets/js/hero-ask.js` + `assets/js/agent-widget.js`: a pop-up click opens Atlas in Avatar mode (`ask(q, { mode: "avatar" })`). Session only, the saved mode preference is untouched; visitors out of avatar time today keep their current mode; text fallback if the face can't load in 3s.
- `assets/js/main.js` `ASSET_VERSION` and `index.html` `main.js?v=` bumped.
- Atlas (`instruction.py`, `live_brain.py`): asked what agents he has built, describe the range by kind (conversational, ambient, multi-agent, agentic RAG, harness) and never lead with a count. Suggestion chips no longer offer "Is he open to consulting engagements?".
- `content/agents.json` (Pulse): copy now matches the real Mon/Thu site performance report; the lead follow-up drafting it described was removed from Pulse on 2026-08-09.
- `index.html`: hero eyebrow "// open to architecture engagements" becomes "// building AI agents in public".
- Atlas answers end with one specific follow-up question; after a typed avatar answer the call button reads "Keep talking" with "Ask a follow-up out loud".

## Files to create
- `.claude/specs/107-book-a-session-cta.md` (this file).

## New dependencies
No new dependencies.

## Rules for implementation
- All identity content lives in `content/profile.json`.
- CSS variables only — never hardcode hex.
- One JS module per visualization; lazy-load on viewport entry.
- No npm, no bundler, no Node toolchain.
- Respect `prefers-reduced-motion`.
- Mobile fallbacks for every WebGL/Three.js feature.
- No em-dashes in copy. Mentorship wording only, no "consulting", "hire" or "freelance" in any new CTA.
- No coupon codes or discounts in permanent copy (BF10 is time-boxed and lives on Topmate only).
- Atlas redeploy needs `make eval` and explicit user approval first. Content-only changes go live without it (corpus is read live).

## Definition of done
- [ ] The hero pop-up rotates the four Gaurav questions with the three lab questions; clicking one opens Atlas in Avatar mode, for a first-time visitor too, without saving Avatar as their preference.
- [ ] "Which AI agents has Gaurav put into production?" is answered by kind of agent, with no count (after Atlas deploy).
- [ ] Every page's nav shows "Book a 1:1" in the cyan outline style, opening `topmate.io/gaurav_lahoti25` in a new tab; the mobile drawer shows the same.
- [ ] No "Let's Talk" text remains in any HTML or the generator.
- [ ] Desktop hero keeps two buttons; "Book a 1:1 session →" sits on the same row as "See agents in production →", above the buttons so the "Try asking Atlas" popover never covers it. Centred on phones.
- [ ] Every insight page ends with a session box above "More from Gaurav"; on 375px width the button is full width and nothing scrolls sideways.
- [ ] Home and insight footers include a "1:1 sessions" link.
- [ ] `node scripts/gen-post-pages.mjs` re-run is byte-identical on a second run.
- [ ] `node --test 'tests/**/*.test.mjs'` passes; Atlas `uv run pytest tests/unit` passes.
- [ ] Asking Atlas "which cert should I start with for cloud AI?" suggests a 1:1 session with the Topmate CTA (after Atlas deploy).
- [ ] Asking Atlas "is he available for consulting?" no longer says he takes select consulting work.
