# Spec 78: "Show me" opens the site beside the avatar

Asked "show me the labs", the avatar could only describe them or say they're linked. Opening a lab meant leaving the page, and leaving the page ends the call. Now the avatar opens it for you and keeps talking.

## Changes

**Server (`live_brain.py`, `api.py`)**
- New client tool `show_on_site(target)`. Targets are keys, never URLs: `top`, `career`, `about`, `insights` (home sections), `labs`, `mcp-lab`, `engineering-loops`, `agent-ready`, `live-agents`. `rag-lab` is a real place that runs off-site, so it returns `off_site` ("say it's linked from the AI Labs page"). Anything else is `invalid_argument` and never reaches the page.
- `ToolDispatcher.on_show` is bound by `LiveConversation` and `LiveBrainTurn` (and rebound on `attach`, for warm sessions). The relay sends WS `{"show": key}` and SSE `{"avatarShow": key}`. The tool name stays on the server (spec 74).
- Prompt: open something only when the visitor asks to see, open or go somewhere, or says yes to an offer. At most one per turn. Say one line about what's on screen.

**Widget (`site-stage.js` new, `agent-widget.js`, `components.css`, `base.css`, `main.js`)**
- `site-stage.js` owns the key → place map. A section scrolls into view with the site's own `portfolio:scroll-to`. A page opens in a same-origin frame over the home page and under the panel (`--z-site-stage: 58`: over the nav at 50, under the widget at 60). The document never unloads, so the call, its socket and the face keep running. The frame's bar has "Back to home" on the left, because the panel covers the right end, plus the page title. Escape closes it. A link home inside the frame closes it too, instead of loading a second copy of the site.
- While a page is open, the panel **floats** as a small face with Mute and End, on every screen size (the user's call). Clicking the face brings the full panel back, and the minimize button floats it again. Closing the page restores the panel. Unlike minimize, floating never pauses the avatar.
- `main.js` doesn't start Atlas inside a frame, so there's never a second mic or a second call.
- Cache-bust `v=339`.

## Definition of done

- [x] `uv run pytest tests/unit`: a known target is shown; URLs, paths, `__proto__` and empty keys never reach the page; `rag-lab` is a link; no page to show on → `unavailable`; a warm turn rebinds on `attach`; the stream sends `avatarShow`; the server's keys match `site-stage.js` (read from the file); every lab in `ai-concepts.json` can be shown or linked; showing a page mid-answer is still one reply.
- [x] `node --test`: every page is a path on this site that exists in the repo, every section exists on the home page, and unknown or inherited keys resolve to nothing.
- [x] Browser, desktop (local Atlas with `ATLAS_LIVE_BRAIN=1`): "Show me the MCP lab" opens the lab behind the panel. The panel floats as a face, and Atlas says the lab is on screen and offers to walk through it. The log shows `tools=['show_on_site']`.
- [x] Browser, 390×844 emulated phone: the lab fills the screen and the face floats in the corner. Tap → full panel, minimize → floats, "Back to home" → the lab closes and the panel is back and still open.
- [ ] Spoken conversation on the live site: "show me the labs" by voice.
