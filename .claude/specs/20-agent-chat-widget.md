# Spec: Agent chat widget — "Talk to my agent" floating assistant

## Overview
The single biggest credibility gap on the portfolio: the headline says **"AI-Native Architect"** and the site has zero AI on it. A visiting CTO clocks this immediately. This spec adds a **floating "Ask my agent" chat widget** in the bottom-right that opens to a slide-out panel hosting a Gemini-powered assistant grounded on Gaurav's resume, the ErrorLens architecture, and his top LinkedIn perspectives. The widget *demonstrates* AI-native thinking by *being* AI-native — walking the talk.

The widget is a new lazy-loaded JS module (`assets/js/agent-widget.js`) that mounts into a global `<div id="agent-root"></div>` near `</body>`. It deliberately does **not** use the section-scoped `IntersectionObserver` lazy-load pattern because the FAB is page-global; it loads via a `requestIdleCallback`-style deferral after the hero canvas has settled, ensuring zero impact on FCP and the hero shader budget. On click, the panel slides in from the right (380px wide on desktop, full-screen on mobile), shows a row of suggested starter prompts, and streams responses from the model token-by-token. Clear "experimental" / "AI" labelling makes it unambiguous to the visitor that they're talking to a model, not Gaurav.

The backend is a new Cloudflare Worker route, `POST /api/agent-chat`, that calls the Gemini API server-side (key never reaches the client). Server-Sent Events stream tokens back. A new D1 table `agent_chat_requests` enforces rate limits at both the session and IP-hash levels. The grounding system prompt is assembled at boot from markdown source files in `backend/grounding/` (resume distilled to text, ErrorLens architecture summary, top 5 LinkedIn post abstracts). CORS allowlist mirrors the existing resume-gate worker.

**Out of scope for v1:** authentication, conversation history persistence, voice. v1 is stateless per-session, with rate limiting as the only abuse mitigation.

This spec is sequenced **last** in the upgrade rollout (after specs 15–19) so that when the widget lands, it lands on a polished page where the rest of the AI-native signals (Signature Work, three-axis Capabilities, Outcomes, refined microcopy) already reinforce its credibility.

## Depends on
- Spec 01 (foundation) — design tokens, design system
- Spec 11 (resume-gate) — Cloudflare Worker scaffold, CORS pattern, D1 binding
- Spec 12 (resume-gate-google-auth) — server-side secret handling pattern via `wrangler secret put`
- Spec 13 (mobile compatibility) — tap targets, breakpoints
- Spec 15 (signature work) — ErrorLens architecture summary used as grounding source

## Routes
- **`POST /api/agent-chat`** (new, Cloudflare Worker — `backend/src/index.js`).
  - Request body (JSON):
    ```json
    {
      "sessionId": "uuid-v4-generated-client-side",
      "messages": [
        { "role": "user",      "content": "..." },
        { "role": "assistant", "content": "..." },
        { "role": "user",      "content": "..." }
      ]
    }
    ```
  - Response: **Server-Sent Events** stream. Each `data:` chunk carries a partial `{ delta: "next token chunk" }` JSON object; a final event `data: {"done": true}` closes the stream.
  - Errors: standard HTTP status codes (400 malformed body, 429 rate-limited, 502 upstream Gemini failure). Body is a small JSON `{ error: "human-readable message" }`.
  - CORS: allowlist mirrors the existing resume-gate Worker — the Pages domain plus `localhost:5173` for development.

## Database changes
New D1 table for rate limiting, appended to `backend/schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS agent_chat_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  ip_hash      TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  status       TEXT NOT NULL  -- 'ok' | 'rate_limited' | 'upstream_error'
);
CREATE INDEX IF NOT EXISTS idx_agent_chat_session_ts ON agent_chat_requests (session_id, ts);
CREATE INDEX IF NOT EXISTS idx_agent_chat_ip_ts      ON agent_chat_requests (ip_hash, ts);
```

Rate limits:
- **Per session:** ≤ 20 messages per 1 hour rolling window.
- **Per IP hash:** ≤ 100 messages per 24 hour rolling window.

`ip_hash` = SHA-256 of `(ip + DAILY_SALT)` — the salt rotates daily and is stored in Worker `env`. This avoids storing raw IPs while preserving rate-limit utility within a day.

A monthly cron (matching the existing `crons = ["0 2 1 * *"]` pattern in `backend/wrangler.toml`) prunes rows older than 30 days.

## Templates
- **Create:**
  - `assets/js/agent-widget.js` — render module. Exports `initAgentWidget(root, profile)`. Builds the FAB, panel, message list, suggested-prompt chips, input box, and streaming-render handler. Uses `fetch()` with `text/event-stream` parsing (manual SSE reader on the response body — Workers SSE works with the standard streaming Response API).
  - `backend/src/agent-chat.js` — handler exporting `handleAgentChat(request, env, origin, allowed, corsHeaders)`. Mirrors the shape of the existing `handleDownload` in `backend/src/index.js`. Responsibilities:
    - Parse and validate the request body.
    - Hash the IP with `env.DAILY_SALT`.
    - Check rate limits via D1 (`SELECT count(*) FROM agent_chat_requests WHERE session_id = ? AND ts > ?` and equivalent for `ip_hash`).
    - Assemble the prompt: system prompt (grounding) + the message history.
    - Call the Gemini API streaming endpoint server-side with `env.GEMINI_API_KEY`.
    - Pipe Gemini's stream into an SSE response body.
    - Insert one row into `agent_chat_requests` (`status='ok'` on success, `'rate_limited'` if blocked, `'upstream_error'` if Gemini fails).
  - `backend/src/grounding.js` — small module that loads and caches the grounding bundle (resume markdown, ErrorLens architecture summary, top LinkedIn perspectives) and assembles the system prompt. Cache for the worker lifetime.
  - `backend/grounding/resume.md` — distilled-to-text version of the resume. ~1500 words max. Single source of truth for what the agent knows about Gaurav's career.
  - `backend/grounding/errorlens.md` — ErrorLens architecture summary. Structured as: problem · approach · key components · how the self-learning loop closes · stack. Mirrors the data in `assets/js/data/signature.json` from spec 15 but elaborated for the model.
  - `backend/grounding/perspectives.md` — top 5 LinkedIn post abstracts, each: title + 2-3 sentence summary + URL. Source: `assets/js/data/posts.json` from spec 14.
  - `backend/grounding/system-prompt.md` — the meta-prompt template that wraps the three context files. Defines tone (concise, technical, candid; no over-claiming), guardrails (declines unrelated questions, points to LinkedIn for engagement enquiries, never invents experience or numbers), and persona (it's an *agent representing* Gaurav, not Gaurav himself).
- **Modify:**
  - `index.html` — add `<div id="agent-root"></div>` immediately before `</body>`. No nav entry — the FAB is global and intentionally not linked from the nav (it's a tool, not a page).
  - `assets/js/main.js` — add `initAgentWidgetWhenIdle(profile)`. Use `('requestIdleCallback' in window) ? requestIdleCallback(...) : setTimeout(..., 1500)` to defer module load until the page is idle. Inside the callback: dynamic `import("./agent-widget.js")`, call `initAgentWidget(document.getElementById("agent-root"), profile)`, store on `window.__agentWidget` for debugging. Skip entirely if `reduceMotion && saveData` are both true (respect bandwidth-saver mode).
  - `assets/js/data/profile.json` — add a new field under `links`:
    ```json
    "agentApi": "https://gaurav-portfolio-agent.gaurav-lahoti25.workers.dev/api/agent-chat"
    ```
    The Worker can be the same Worker as the resume-gate (one Worker, two routes) or a separate Worker — pick one at deploy time and align the URL accordingly. The spec is agnostic.
  - `backend/src/index.js:29-48` — add a new route check in `fetch()` forwarding `POST /api/agent-chat` to `handleAgentChat`. Preserve all existing routes (`/api/resume-download`, `/api/leads`).
  - `backend/wrangler.toml` — declare `GEMINI_API_KEY` and `DAILY_SALT` as expected secrets (set via `wrangler secret put GEMINI_API_KEY` — never committed). Bump the version label / comment if you maintain one.
  - `backend/schema.sql` — append the `agent_chat_requests` table and indexes.
  - `backend/local-server.js` — add a parallel route + Gemini call so the local dev environment supports the chat flow against the real model (or a stub, gated on `process.env.GEMINI_API_KEY`).
  - `assets/css/components.css` — append rules for `.agent-widget-host`, `.agent-fab`, `.agent-fab-pulse`, `.agent-panel`, `.agent-panel-head`, `.agent-panel-body`, `.agent-message`, `.agent-message-user`, `.agent-message-assistant`, `.agent-prompts`, `.agent-prompt-chip`, `.agent-input-row`, `.agent-input`, `.agent-send`, `.agent-meta`. Reuse `--accent`, `--accent-soft`, `--bg-card`, `--bg-elev`, `--border`, `--ink`, `--ink-muted`, `--ink-subtle`, `--space-*`, `--radius-md`, `--radius-lg`, `--dur-*`, `--ease-*`.

## Files to change
- `index.html`
- `assets/js/main.js`
- `assets/js/data/profile.json`
- `backend/src/index.js`
- `backend/wrangler.toml`
- `backend/schema.sql`
- `backend/local-server.js`
- `assets/css/components.css`

## Files to create
- `assets/js/agent-widget.js`
- `backend/src/agent-chat.js`
- `backend/src/grounding.js`
- `backend/grounding/resume.md`
- `backend/grounding/errorlens.md`
- `backend/grounding/perspectives.md`
- `backend/grounding/system-prompt.md`

## New dependencies
- **Backend:** none new at runtime. The Worker uses native `fetch()` to call the Gemini API; no `@google/generative-ai` SDK required. (If you prefer the SDK for ergonomics, that's acceptable — but the spec defaults to fetch-only to keep the Worker bundle small.)
- **Frontend:** none. SSE parsing uses the native Streams API.

## Rules for implementation
- **Keys are server-side only.** `GEMINI_API_KEY` lives only in `wrangler secret`. The frontend never sees it. Verify by inspecting the Network panel in production — no API key in any request URL or body.
- **Streaming.** Responses stream token-by-token via SSE. The frontend renders incrementally as chunks arrive; the user sees the first token within ~2s for typical queries.
- **Rate limits enforced server-side.** Client-side debounce + UI guard is a UX nicety, not security. The Worker is the source of truth. A user hitting 21 messages in a session must get a graceful 429 with a friendly message in the panel.
- **Grounding is source-of-truth.** The model only answers from the grounding bundle. The system prompt explicitly instructs: "If a question can't be answered from the provided context, decline politely and suggest the visitor reach Gaurav on LinkedIn." Never invent experience, numbers, or links not in the grounding.
- **Hallucination guardrails.** The system prompt explicitly bans inventing certifications, employers, project names, or outcome numbers not in the resume markdown.
- **Safety.** The system prompt declines politically charged or unrelated personal questions and steers back to professional context. No PII collection, no cookies, no fingerprinting.
- **Privacy.** Only IP **hash** stored in D1, salted with a daily-rotating salt. No raw IPs, no message content stored.
- **Lazy load.** Module load is deferred via `requestIdleCallback` with a `setTimeout(1500)` fallback. The FAB renders within ~1s of "page interactive" but not during the hero animation. Total widget JS size budget: ≤ 30 KB gzipped (per the global ≤ 400 KB JS budget in CLAUDE.md).
- **CDN dep loading.** Any external dep loads via CDN with `defer` and SRI integrity (matching the existing pattern in `index.html:58-72`). v1 ideally has no external frontend deps.
- **CSS variables only — never hardcode hex.**
- **`prefers-reduced-motion`.** The slide-in animation, FAB pulse, and any token-streaming "typing" effect are suppressed. The widget remains fully functional; only motion is removed.
- **Mobile-first.** At ≤ 768px the panel takes the full viewport (or `min(100vw, 100%)` with safe-area insets). At > 768px it's 380px wide, anchored bottom-right with `--space-6` margin.
- **Tap targets.** FAB, send button, and prompt chips all ≥ 44px tap target (WCAG 2.5.5).
- **Keyboard.** FAB is focusable; Enter/Space toggles the panel. Inside the panel: Tab cycles through prompts, input, send, close. Esc closes. Cmd/Ctrl+Enter sends a message from anywhere in the input.
- **Screen reader.** Panel is an `aria-modal="true"` `role="dialog"` with `aria-labelledby`. The FAB has an explicit `aria-label="Open agent chat (experimental)"`. Streaming messages use a polite `aria-live="polite"` region so each completed assistant message is announced once (not on every token).
- **Labelling — unambiguous AI.** The panel header reads `Agent · experimental`. The footer of the panel reads `Powered by Gemini · model may be wrong · contact Gaurav on LinkedIn`. The FAB tooltip says `Ask my agent (experimental AI)`. No ambiguity that the visitor is talking to a model.
- **Suggested starter prompts** (visible on first open):
  - *"What has Gaurav shipped in production with multi-agent systems?"*
  - *"Walk me through the ErrorLens architecture."*
  - *"What's his take on A2A vs orchestrator patterns?"*
  - *"Is he open to engagements?"* — answer routes to LinkedIn and Topmate.
- **Session model.** A `sessionId` (UUID v4) is generated in-memory per page load. Cleared on reload. No localStorage persistence in v1.
- **Outbound link rendering.** If the model emits a URL in its response, the frontend wraps it in `<a target="_blank" rel="noopener noreferrer">`. Render only `https://` URLs from a small allowlist (linkedin.com, github.com, gauravlahoti.github.io, topmate.io). Other URLs render as plain text. Defence in depth: the system prompt also instructs the model to only emit URLs from this allowlist.
- **No `innerHTML`.** All message content rendered via `textContent`. Markdown parsing in v1 is **not** included — keep responses plain text. (If markdown is desirable later, ship it as a follow-up spec with a hardened renderer; v1 stays plain text to eliminate XSS surface.)
- **Errors are friendly.** A 429 reads "I've been chatting a lot today — try again in a minute, or reach Gaurav on LinkedIn for anything urgent." A 502 reads similarly. The panel never blanks out; errors render as a system message in the transcript.
- **Cost cap.** Per-message Gemini call has a `maxOutputTokens` cap (e.g., 600 tokens) to bound cost. The system prompt is cached at the Worker layer so the bulk of token usage isn't repeated per call.

## Definition of done
Verifiable end-to-end against the deployed Worker on staging, and locally via `python3 -m http.server 5173` + `node backend/local-server.js`.

### Widget appearance & lifecycle
1. **FAB renders within ~1s of page interactive.** The bottom-right floating button is visible after the page reaches a stable "idle" state. It does not appear during the hero canvas reveal.
2. **FAB labelling.** The FAB tooltip / `aria-label` reads "Ask my agent (experimental AI)". Pulse animation visible by default, suppressed under `prefers-reduced-motion`.
3. **Panel opens on click.** Clicking the FAB opens the slide-out panel from the right. On desktop the panel is 380px wide, anchored bottom-right with proper spacing. On mobile (≤ 768px) the panel covers the viewport with safe-area insets respected.
4. **Suggested starter prompts.** First open shows the four documented starter prompts as chips. Clicking a chip pre-fills the input but does not auto-send (user confirms with Enter or Send button).
5. **Header labelling.** Panel header reads "Agent · experimental". Footer reads "Powered by Gemini · model may be wrong · contact Gaurav on LinkedIn" with the LinkedIn text being a real outbound link.
6. **Close behaviour.** Esc closes the panel. Clicking the close X closes the panel. Clicking the FAB while the panel is open also closes it. Focus returns to the FAB after close.

### Streaming & content
7. **First token < 2s for typical query.** Sending one of the starter prompts on a warm Worker returns the first visible token in the panel within 2 seconds (measured from Send-click to first visible character).
8. **Streaming renders incrementally.** As tokens arrive, the assistant message extends character-by-character. The transcript scrolls to keep the latest message visible.
9. **Grounded answers.** Asking "What has Gaurav shipped in production with multi-agent systems?" returns an answer that names ErrorLens specifically and references its architecture (vector fast-path + sage_pipeline + self-learning loop). The answer **does not** invent project names, employers, or numbers not in `backend/grounding/`.
10. **Off-topic decline.** Asking "What's the weather today?" or "Who's the current US president?" gets a polite decline that points to LinkedIn for non-portfolio questions.
11. **Engagement question routes correctly.** Asking "Is he open to engagements?" returns an answer with the Topmate link from `profile.links.topmate` (the link must be in the allowlist).

### Backend
12. **Keys server-side.** Inspecting the Network panel during a chat shows no Gemini API key in request URL, headers, or body. The frontend POST goes only to `/api/agent-chat`.
13. **Rate limit per session.** Sending 21 messages in one session within 1 hour: the 21st returns 429 with the friendly UI message, and a row with `status='rate_limited'` is inserted in `agent_chat_requests`.
14. **Rate limit per IP.** From two different `sessionId`s on the same IP, after 100 messages in 24 hours the next message returns 429.
15. **D1 schema.** `wrangler d1 execute --command "PRAGMA table_info(agent_chat_requests)"` shows the columns documented above. Indexes exist.
16. **No raw IP stored.** Inspecting D1 rows shows only the SHA-256 hash, not the source IP.
17. **CORS.** The Worker accepts `OPTIONS` preflight from the Pages domain and rejects unknown origins (mirrors resume-gate behaviour from spec 11).
18. **Cost cap.** A response is bounded at the documented `maxOutputTokens` (e.g. 600). Repeated long-form queries do not blow the budget.

### A11y & UX
19. **Tap targets.** FAB, send button, prompt chips, close X are all ≥ 44px tap target on mobile.
20. **Keyboard.** Tab through the panel cycles prompts → input → send → close. Esc closes. Cmd/Ctrl+Enter sends from inside the input. Focus is trapped within the dialog while open.
21. **Screen reader.** VoiceOver / NVDA announces panel open as a dialog. Each completed assistant message is announced once via `aria-live="polite"`. Streaming tokens are not announced individually.
22. **`prefers-reduced-motion`.** Panel slide-in, FAB pulse, and any token typewriter effect are suppressed. The widget remains fully functional.
23. **Lighthouse Accessibility ≥ 95** unchanged on the home page with the widget present.

### Performance & lazy load
24. **No FCP regression.** Lighthouse Performance ≥ 90 unchanged. The widget JS does not load before the hero canvas is initialized; verified via Network panel timeline.
25. **Module size.** The minified gzipped size of `agent-widget.js` is ≤ 30 KB. (`gzip -c assets/js/agent-widget.js | wc -c`.)
26. **Bandwidth saver respect.** With `connection.saveData = true` and `prefers-reduced-motion: reduce` simultaneously, the widget does not load (the FAB is not rendered).

### Failure modes
27. **Upstream error.** Forcing a Gemini failure (invalid key, simulated 500): the panel shows a friendly error message in the transcript; subsequent messages can still be sent (panel doesn't lock up); a row with `status='upstream_error'` is logged.
28. **Network offline.** With network offline, sending a message shows a friendly "you appear to be offline" message; no console errors; the widget recovers cleanly when network returns.

### Cross-cutting
29. **No console errors** during a 5-message conversation, panel toggle cycles, and rate-limit-hit scenarios.
30. **No regression** to existing portfolio sections, the resume-gate flow (spec 11/12), or the cert rail / hero canvas.
31. **Truthful footer line.** If the spec 18 footer line ("// built with Claude Code · Gemini · Three.js") is present, the Gemini reference is now substantively backed by this widget being live.
32. **Specs 15–19 already shipped.** Per the rollout sequencing, this spec is implemented after specs 15 (Signature Work), 16 (three-axis Capabilities), 17 (Outcomes), 18 (microcopy), and 19 (resume tiering). The agent grounding references the ErrorLens content from spec 15 — that section must already be live before the widget gives credible answers about it.
