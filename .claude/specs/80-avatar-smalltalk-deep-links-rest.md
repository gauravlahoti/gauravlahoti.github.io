# Spec 80: Small talk, open anything by name, a calmer "out of time", and a floating-panel fix

Live-testing specs 77–79 surfaced four things.

## 1. Small talk misread as an identity question

"Yes, how are you?" got "I am Atlas, an AI agent representing Gaurav Lahoti…". Spec 77's "About you" rule ("if asked whether you are Gaurav, a person, or what you are") fired on plain small talk too.

**Fix:** small talk ("how are you", "thanks", "that's great") now gets a short, warm, human reply in its own words, then one light offer to help; no self-description. The AI-agent line is reserved for actually being asked what it is. Verified live: *"I'm doing well, thank you for asking. How can I help you explore Gaurav's work today?"*

## 2. "Open the Pulse architecture diagram" was declined

`show_on_site` only knew nine fixed pages and sections, so anything one click away on the Live Agents page ("open Pulse", "show me its diagram") was refused, even though the visitor could see it themselves.

**Fix:** the catalog now includes, built live from `agents.json` so a new agent needs no code change:
- `agent:<id>` — that agent's panel on the Live Agents page,
- `agent:<id>:diagram` — its architecture diagram, fullscreen, only offered when it has one,
- `loops:prompt|context|harness|loop` — a layer of the Engineering Loops lab, deep-linked by hash.

`resolve_show_target()` accepts an agent's id or name ("agent:ErrorLens"), slugifies it, and checks it against the live agent list before it ever reaches the page; an unmatched id is `invalid_argument`. `site-stage.js`'s `resolveTarget()` mirrors the same patterns, with its own regex, so a key with a slash, a dot or a scheme never resolves to a path outside the site. `agents-page.js` reads `?view=diagram` before opening the panel (`openPanel` rewrites the URL to `?agent=<id>`) and clicks the existing expand button once the diagram has loaded, the same path a person's own click takes.

**On-screen awareness:** every `show_on_site` result carries `canOpenNext`, built from the same catalog, so "open Pulse" then "now its diagram" or "open the harness layer" needs no keyword. It's in the tool result's data, never its message, since the model reads the message aloud.

Verified live end to end: "open the live agents page" → `live-agents`; "open Pulse" → `agent:pulse`; "show me its architecture diagram" → `agent:pulse:diagram`; "show me the harness layer" → `loops:harness`; "the ErrorLens diagram" → `agent:error-lens:diagram`.

## 3. Running out of avatar time spammed the chat

Every tap on Avatar while resting called `handOffToVoice()`, which appended "That's all the avatar time for today. Switching you to Voice." again and switched away on its own.

**Fix:** `restAvatar()` replaces it. Avatar stays selectable; a rest card sits in the face's slot — one line, dimmed face, and a **Continue in Voice** button (or **Ask this in Voice** when a question couldn't be asked). The chat gets at most one system line, the first time the cap is hit on this page load. Switching mode is now the visitor's choice, not automatic.

## 4. The call ending while a page was open looked like nothing happened

Once a page opens, the panel floats down to a small face so the page stays readable. Ending the call (a spoken goodbye, End, idle timeout, or a capped call) never un-floated it, so the call had already ended behind the scenes, invisibly, and looked like saying goodbye did nothing until the face was tapped open by hand.

**Fix:** `endConversation()` now calls `setFloating(false)` before the hang-up animation plays, for every way a call can end. The full panel is back, showing "Start conversation" (or the rest card), and the hex break/reform animation plays at full size instead of unnoticed in the corner.

## Definition of done

- [x] `uv run pytest tests/unit` (357) and `node --test 'tests/**/*.test.mjs'` (19) pass.
- [x] `TestSpeechInstruction` pins the small-talk and open-anything rules; `TestOpenAnything` covers resolving and rejecting agent, diagram and loops-layer targets, and that opening a page lists what can open next.
- [x] `speech_edge_cases.py` run live on Vertex: small talk and every open-by-name case above read right.
- [x] Frontend-only fixes (3 and 4) verified by code path, not live audio: every ending (End, idle, goodbye, capped) routes through `endConversation()`, which now always restores the panel before the hang-up plays.
- [ ] On the live site: small talk, "open Pulse" then "its diagram", running the avatar out of time, and a spoken goodbye while a page is open.
