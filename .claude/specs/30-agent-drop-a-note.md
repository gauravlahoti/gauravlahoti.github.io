# Spec 30: Agent "Drop a Note to Gaurav" email feature

## Overview

Visitors can already ask the AI agent to email them Gaurav's resume. This spec adds the reverse: a visitor can compose a personal message through the agent and the agent fires a transactional email TO Gaurav, CC'ing the visitor so both sides have a record and Gaurav can reply directly.

The frontend gets one new action chip ("Drop Gaurav a note") mirroring the existing "Email me his resume" chip UX.

## Depends on

- Spec 20 / 21 — agent widget + Cloud Run deployment (the surface this runs on).
- Spec 23 — Resend MCP server (`resend-mcp-server` on Cloud Run, `RESEND_MCP_URL` env var, `_send_via_mcp()` helper in `resume_send.py` — reused, not modified).

## Routes

No new backend routes. The Resend MCP server already handles `send-email` — this spec adds a second caller.

## Database changes

No database changes.

## New env var

`GAURAV_CONTACT_EMAIL` — Gaurav's personal inbox that receives visitor notes. Set via Secret Manager on Cloud Run (same pattern as `RESEND_FROM_ADDRESS`). Documented in `portfolio-agent/.env.example`.

## Python changes

### New file: `portfolio-agent/app/app_utils/note_send.py`

- `send_note_email(visitor_email, message)` — validates inputs, builds email args, calls `_send_via_mcp()` (imported from `resume_send.py`).
- Email args: `from=RESEND_FROM_ADDRESS`, `to=[GAURAV_CONTACT_EMAIL]`, `cc=[visitor_email]`, `replyTo=visitor_email`, subject, HTML + plain-text body.
- Return schema: `{ok: bool, code: str, message: str}` — same shape as `send_resume_email`.
- No rate-limiting (contact messages are desired; Resend limits apply on the free tier).

### Modified: `portfolio-agent/app/tools.py`

- Import `send_note_email` from `app.app_utils.note_send`.
- New ADK tool function `send_note_to_gaurav(visitor_email, message)` — wraps `send_note_email`, full docstring for ADK schema inference.

### Modified: `portfolio-agent/app/agent.py`

- Add `portfolio_tools.send_note_to_gaurav` to `tools=[...]`.

### Modified: `portfolio-agent/app/instruction.py`

- Update tools preamble: "two action tools".
- New `# Drop-a-note routing` section with 4-step decision tree, response handling per code, and "NEVER call without explicit message intent" guard.

## Frontend changes

### Modified: `assets/js/data/profile.json`

Added second entry to `agentActions`:
```json
{ "label": "Drop Gaurav a note", "prefill": "I'd like to send Gaurav a note: " }
```

No JS changes — the existing chip rendering loop handles any `agentActions` entry generically.

## Definition of done

- [ ] Visitor sends `"I'd like to send Gaurav a note: Hi, loved your ADK work. My email is test@example.com"` → agent calls `send_note_to_gaurav` once, confirms delivery. Email arrives in Gaurav's inbox; test@example.com gets CC'd.
- [ ] Multi-turn: `"I want to message Gaurav"` → agent asks for message → provide it → agent asks for email → provide it → tool fires.
- [ ] Bad email → agent asks for a valid one without crashing.
- [ ] Short message → agent asks for more detail.
- [ ] `GAURAV_CONTACT_EMAIL` unset → `not_configured` error message, agent routes to LinkedIn.
- [ ] "Drop Gaurav a note" chip visible in widget alongside "Email me his resume"; tap prefills textarea correctly.
- [ ] After successful send, `[[META]]` includes `"cta":"linkedin"`.
- [ ] `uv run pytest tests/unit` passes (no import errors on new module).
