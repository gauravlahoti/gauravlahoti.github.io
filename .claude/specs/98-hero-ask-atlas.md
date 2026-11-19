# Spec: Hero Ask Atlas

## Overview
Pulse's digest of 2026-11-19 reported that none of 37 homepage sessions started a chat, voice or avatar session with Atlas. The homepage already had an Atlas button, a floating button and starter questions, but the questions only appeared after the panel was open, so a first-time visitor never saw what they could ask. This spec adds a quiet nudge on the page and the measurement to tell whether it works.

**The nudge** is a small speech bubble that pops out of the "Chat with my AI agent, Atlas" button (above the bottom bar on phones) about a second after every page load, refresh, or back/forward-cache restore. It stays for 30 seconds, typing sample questions that alternate between AI questions and questions about the AI Labs. Clicking it opens Atlas with that question already sent. It is not a fixture: × or opening Atlas any other way takes it down, and hovering freezes it on the whole question and holds it past the 30 seconds.

An earlier draft put a permanent terminal-style ask-bar and four pills in the hero. It was rejected as too much to show all the time. The hero buttons are unchanged.

**The measurement** is a small funnel: opens by source, first messages, and which suggested question was clicked, reported through the existing Pulse digest.

## Depends on
- Spec 21/22: agent widget, `[data-agent-open]` triggers, mobile bottom bar
- Spec 24: in-panel starter chips
- Spec 33: cookieless analytics beacon and the shared page `sessionId`
- Spec 45: WebMCP (`go_to` chat-open is tagged as its own source)
- Spec 84: Pulse v2 digest (`digestExtras`, the Journey section)

## Routes
- `POST /api/widget-event` (Cloudflare Worker, mirrored in `backend/local-server.js`): origin-gated beacon, `text/plain` JSON `{ sessionId, event, source }`, always 204. Bots dropped. `event` is `open | chip | first_send`. `source` is allowlisted (`widgetEventFields` in `backend/src/digest.js`). Capped at 20 rows per session and 60 per daily visitor hash.
- `GET /api/ambient/stats` gains `funnel.opened`, `asked`, `open_sources[]`, `chips[]`.

## Database changes
- `backend/migrations/014-widget-events.sql` (also in `schema.sql`): `widget_events (id, at, session_id, visitor_hash, event, source)`. No free text, no question, no IP. Deleted after 30 days by the monthly retention cron.
- **Apply to prod D1 before deploying the Worker:** `wrangler d1 execute resume-leads --remote --file=migrations/014-widget-events.sql`. Until it is applied the endpoint logs insert errors (still 204) and the digest leaves the new numbers at zero.

## Templates
- **Create:** `assets/js/hero-ask.js`, `backend/migrations/014-widget-events.sql`
- **Modify:** `index.html`, `assets/js/main.js`, `assets/js/agent-widget.js`, `assets/js/webmcp.js`, `assets/css/components.css`, `content/profile.json`, `content/ai-concepts.json`, `backend/schema.sql`, `backend/src/index.js`, `backend/src/digest.js`, `backend/local-server.js`, `agents/pulse/app/app_utils/ambient_send.py`, `agents/pulse/tests/unit/test_ambient.py`

## Files to change
- `assets/js/agent-widget.js`: `ask(text, {source, chip})` and `warm()` on the widget API, `openPanel(source)`, `trackWidget()` beacons. `ask()` waits up to 3 s for a remembered Avatar mode to load before sending, so the answer is spoken rather than text under an idle face, and falls back to text if the face is late.
- `assets/js/main.js`: lazy-import `hero-ask.js`, and read `data-agent-source` on `[data-agent-open]` clicks.
- `assets/js/webmcp.js`: chat opens are tagged `webmcp`.
- `index.html`: `data-agent-source="bottombar"` on the bottom-bar button, `?v=` bumps. The hero markup is unchanged.
- `content/profile.json`: `heroAsk.prompts` (the AI questions).
- `content/ai-concepts.json`: an `atlasPrompt` on each lab. Every LIVE lab with one joins the rotation automatically.
- Atlas (`agents/atlas/app/app_utils/tool_leak.py`, wired into `app/api.py`): found while testing the lab questions. Now and then the model types a tool call into the reply (`out:default_api:get_ai_labs[...]`, or a ```json block of made-up lab records) instead of calling it. `ToolLeakGuard` holds the first ~24 characters of a reply, drops it if it opens like a leak, and the turn is retried once with a server-side nudge. A second leak shows the standard apology, and the leak is never stored in the audit row. Needs an Atlas deploy to take effect.
- Pulse: the Journey section shows "Opened Atlas", where opens came from, and which suggestions were clicked. The step is left out until the beacon has data.

## Files to create
- `assets/js/hero-ask.js`: the pop-up. Builds its own DOM and is positioned off the button, so it never moves the layout.
- `backend/migrations/014-widget-events.sql`

## Questions (all checked against Atlas before shipping)
- AI: "What AI agents has Gaurav shipped?", "How was Atlas, this agent, built?", "Which AI certifications does Gaurav hold?"
- Labs (worded about Gaurav's lab, because Atlas answers generic "what is X" questions with a refusal): "What does Gaurav's MCP lab show?", "What does Gaurav's agentic RAG lab show?", "What are the four loops in Gaurav's Engineering Loops lab?", "What does Gaurav's Agent-Ready Web lab show?", "What does Gaurav's harness lab show about agents?"

## New dependencies
No new dependencies.

## Rules for implementation
- All identity content lives in `content/profile.json`.
- CSS variables only. Never hardcode hex.
- One JS module per visualization. Lazy-load it.
- No npm, no bundler, no Node toolchain.
- Respect `prefers-reduced-motion`: no pop, no typing, questions swap in place.
- No em-dashes in copy. Plain voice.
- SQL in `schema.sql` must not put a semicolon inside a comment: the local server splits the file on every `;`.

## Definition of done
- [x] On every load and refresh the bubble appears about 1 s in and leaves at 30 s. A back/forward-cache restore relaunches it, and only one is ever on screen.
- [x] Clicking it opens Atlas with the question on screen already sent. A visitor whose saved mode is Avatar gets a spoken answer.
- [x] × and opening Atlas any other way remove it. Hover freezes it.
- [x] Phones: the bubble spans the bottom bar, the × is a 44px target, no sideways page scroll at 390px.
- [x] `POST /api/widget-event` stores valid events, drops invalid ones, and holds the per-session cap. `/api/ambient/stats` returns the funnel.
- [x] Pulse tests pass (45) and frontend tests pass (39).
- [x] Atlas leak guard: unit tests with the captured leaks, plus stream tests for retry and give-up (Atlas unit and integration suites pass; the one e2e server test also fails without these changes).
- [ ] Atlas: `make eval` before `make deploy`.
- [ ] Migration 014 applied to prod D1, then Worker deployed, then site published, then Pulse deployed.
- [ ] Real iPhone check of the Avatar-after-click sound.
- [ ] `/run-ambient-digest` once after deploy: the Journey section shows opens and entry points.
