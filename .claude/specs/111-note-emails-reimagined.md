# Spec: Note Emails Reimagined

## Overview

When a visitor sends Gaurav a note through Atlas, the email was a bare HTML block: a bold line, a grey quote and a footer. It went out as a single email with the visitor CC'd, so it could carry nothing private and ignored everything Atlas knew about the conversation. This spec splits it into two branded emails:

- A private briefing to Gaurav. It shows the message as the hero, then "Atlas's read" (a suggested next step, plus what the visitor asked before writing) and the visit's facts (arrival source, pages, mode, place, timing).
- A confirmation to the visitor, with their message quoted and 2–3 "while you wait" pages Atlas picked from the conversation.

Gaurav chose these options:
- Two emails, not one with a CC.
- Briefing contents: conversation context and a suggested next step. No intent or urgency tags, no drafted replies.
- Visitor email: personal picks taken from an allowlist of real site links.
- Privacy: a documented exception to the page_views aggregate-only policy, for sessions that send a note.

## Depends on

- Spec 46: the note content guardrail
- Spec 81: confirming the address before sending
- Spec 84: Pulse v2 (the `referrerHost` helper and the Gemini chip style)
- Spec 110: honest visitor counts (session ids, owner sessions)

## Routes

- **New:** `GET /api/note-context?session=<id>` on the Worker. Internal only (X-Internal-Token = AGENT_LOG_TOKEN), no CORS. Mirrored in `backend/local-server.js`.
- No new Atlas routes.

## Database changes

None. The new endpoint reads `page_views` and `agent_interactions`.

## Design

- `note_brief.py` makes one `gemini-3.6-flash` call that returns schema-constrained JSON: `next_step`, `suggest_call`, `asked_about`, and `picks` (ids from an enum). It has a 6s cap, and any failure falls back to no read. The note and the chat go in as quoted data the model must not follow. Picks map to allowlisted URLs. All strings are capped and dash-cleaned.
- `note_emails.py` builds both emails in the resume email's visual system, escaping every input.
- Send order:
  1. The briefing. It must succeed.
  2. The visitor confirmation. Best effort: a failure is logged as `note/receipt_failed` and the tool still returns ok.
  3. The rate-limit ledger is recorded once.
- Tool codes and messages are unchanged, so Atlas's instruction is unchanged.
- Voice and avatar notes read the chat through `note_send.set_history_provider` (registered in `api.py`).
- Fixed alongside: `referrerHost()` now reads the bare hostnames `page_views` stores. Before this, every real traffic source in Pulse showed as "other".

## Files

- **Create:**
  - `agents/atlas/app/app_utils/{note_brief,note_emails,conversation}.py`
  - `agents/atlas/app/dev_scripts/preview_note_emails.py`
  - `agents/atlas/tests/unit/test_note_emails.py`
  - `backend/test/digest.test.mjs`
- **Modify:**
  - `agents/atlas/app/app_utils/note_send.py`, `agents/atlas/app/tools.py`, `agents/atlas/app/api.py`
  - `backend/src/{digest,index}.js`, `backend/local-server.js`
  - `.claude/docs/{backend,agents}.md`

## New dependencies

No new dependencies.

## Rules for implementation

- Every value a visitor or the model wrote is HTML-escaped. The model never supplies a URL.
- The visitor's email never contains Atlas's private read or the visit facts.
- No em-dashes in the copy. The repo voice rules apply.
- The page_views exception stays limited to this endpoint and to sessions that send a note.

## Definition of done

- [x] Atlas unit tests pass: escaping, allowlist-only picks, AI timeout fallback, no em-dashes, two sends with no CC, a failed receipt still returns ok, ledger recorded once, live-path history.
- [x] `node --test 'backend/test/**/*.test.mjs'` passes (referrerHost, noteContext).
- [x] Preview renders both emails, with and without the AI read, at desktop and phone widths.
- [ ] The Worker returns note context for a real session in prod. A wrong token gets a 401.
- [ ] A real note sent from the site lands as two emails, the briefing with Atlas's read and the visitor email with picks, in Gmail on desktop and mobile.
