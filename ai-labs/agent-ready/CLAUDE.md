# CLAUDE.md — Agent-Ready Web (WebMCP lab)

Guidance for working on the **Agent-Ready Web** lab: a demo of the WebMCP tools this whole
site registers (spec 45, `.claude/specs/45-webmcp-agent-ready.md`). This file is scoped to
the lab; the repo-wide rules in the root `CLAUDE.md` and the shared `ai-labs/CLAUDE.md` still
apply and win on any conflict.

## What it is

Two panes, no narrative build like MCP Lab or Engineering Loops:

- **Registry** — reads `document.modelContext.getTools()` live in the visitor's own browser
  and renders exactly what it returns, including a `toolchange` subscription so it stays
  current. With no WebMCP support it renders an explained "unsupported" state instead of a
  blank list.
- **Console** — lets a visitor pick any of this page's own tools, fill in a form built
  straight from that tool's `inputSchema`, and run it. The Run button calls the tool's own
  `execute()` **directly** (imported from `webmcp.js`), so the console works in every browser
  regardless of WebMCP support. A second "run through the browser" button appears only when
  `document.modelContext.executeTool` exists, and routes the same call through it — the point
  is to make the difference between "the page ran this" and "the browser ran this" visible,
  not to hide it behind one button.

## File map

| Concern | File | Notes |
|---------|------|-------|
| Page shell | `ai-labs/agent-ready/index.html` | Chrome, CSP, origin-trial meta tag, mounts `webmcp-lab-page.js` |
| Page boot | `assets/js/webmcp-lab-page.js` | Year/nav/flyout chrome; fetches JSON + profile; registers this page's own tools (scope `lab-agent-ready`); lazy-imports the lab UI |
| Lab engine | `assets/js/webmcp-lab.js` | Both panes. Contract: `initWebMcpLab(rootEl, { content, profile }) → { destroy() }`. Imports `defineTools` from `webmcp.js` — it does not duplicate the tool definitions |
| Tool registry | `assets/js/webmcp.js` | The actual tool source of truth for the whole site, not lab-specific. See its own header comment and `.claude/specs/45-webmcp-agent-ready.md` |
| Content | `content/webmcp-lab.json` | Intro copy, registry pane copy (including the unsupported-browser explainer), console pane copy |
| Styles | `assets/css/webmcp-lab.css` | Tokens only, mirrors `engineering-loops.css`'s container/header/footer pattern |

**Cache-bust rule:** bump `?v=` in `ai-labs/agent-ready/index.html` (the CSS link and the page
script tag) after editing `webmcp-lab.js`, `webmcp-lab.css`, or `webmcp-lab.json`. If you edit
`webmcp.js` itself, every page that registers tools needs its own `?v=` bumped too — see the
bump table in `.claude/specs/45-webmcp-agent-ready.md`.

## Design choice: this page reuses the real tool definitions, never a copy

`webmcp-lab.js` imports `defineTools` from `webmcp.js` and filters by `scopes.includes("lab-agent-ready")`
— the exact same filter `registerWebMcp()` uses when it actually registers tools on this page.
There is no separate "demo" tool list to keep in sync. If you add a tool to `webmcp.js` and
give it the `lab-agent-ready` scope, it appears in both the live registry (once the browser
registers it) and the console (immediately, since the console reads local defs) with zero
changes here.

## Scope on this page: read-only tools only

This page registers 9 tools: the 8 read-only tools plus `list_ai_labs`. `navigate_to_section`,
`open_agent_chat`, and `draft_note_to_gaurav` are home-page-only (they need `#career`-style
section ids or the Atlas chat widget, neither of which exists here), and `open_lab` is
hub-only. Don't widen this page's scope to include them without adding the DOM they depend on
first — a tool that always errors is worse than no tool.

## Verify

```bash
python3 -m http.server 5173   # then open /ai-labs/agent-ready/
```

With no WebMCP support (default Chrome, Safari, Firefox): confirm the registry pane shows the
explained unsupported state, not a blank list, and that every tool in the console still runs
and returns real JSON. With `chrome://flags/#enable-webmcp-testing` enabled: confirm the
registry pane populates from the live browser API, the badges match each tool's real
`annotations`, and the "run through the browser" button appears and returns the same result
as the local Run button.
