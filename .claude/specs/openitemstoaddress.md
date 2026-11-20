# Open items to address (spec 98 follow-ups)

> **Read this first in a new session.** Everything here was parked on 2026-11-20 on purpose. None of it
> breaks anything for visitors. Full context for the feature is in `.claude/specs/98-hero-ask-atlas.md`.
>
> Resume prompt to paste into a new session:
> "Read `.claude/specs/openitemstoaddress.md` and `.claude/specs/98-hero-ask-atlas.md`, then work through
> section 1 first. Ask me before any production deploy."

Last updated: 2026-11-20

## Where things stand

| Piece | State |
|---|---|
| Website (pop-up, phone chip, slim top bar) | **Live.** PRs #211, #212, #213, #214. |
| Atlas (Cloud Run `atlas`, project `gcp-experiments-490306`, `us-central1`) | **Live** as revision `atlas-00074-6n8`: tool-call leak guard, harness target for the voice avatar, corpus snapshot (PR #215). Previous revision, the rollback point: `atlas-00073-vhx`. |
| Pulse (Cloud Run `pulse`) | **Not deployed.** Still runs the code from before PR #211. The digest works as before. |
| Cloudflare Worker `gaurav-portfolio-resume-gate` | **Not deployed.** Has no `/api/widget-event` route yet. |
| Prod D1 `resume-leads` | **Migration 014 not applied.** No `widget_events` table. |

Severity of everything below: low. Section 1 is the only one that loses something while it waits (funnel data).

---

## 1. Tracking backend (Cloudflare migration, Worker, then Pulse)

**Why parked:** Wrangler is not installed on the dev machine and there is no Cloudflare login. It needs an
interactive login by Gaurav.

**Cost of waiting:** the pop-up works, but the page's funnel beacons (`open`, `chip`, `first_send`) fail
silently with a 404 and are not recorded. Every day without it is a day missing from the before/after
comparison. Visitors see nothing wrong.

**Order matters:** migration, then Worker, then Pulse. Pulse reads the new table. If it is deployed first,
its new numbers just show zero.

**Steps**
1. Log in: type `! npx wrangler login` in the session (interactive). The first `npx wrangler` run downloads
   Wrangler and can look hung for a minute. Work from `backend/`.
2. Look before changing anything. The table should not exist yet:
   `cd backend && npx wrangler d1 execute resume-leads --remote --command "SELECT name FROM sqlite_master WHERE name='widget_events'"`
3. Apply the migration (additive, `CREATE TABLE IF NOT EXISTS`):
   `npx wrangler d1 execute resume-leads --remote --file=migrations/014-widget-events.sql`
4. Deploy the Worker: `npx wrangler deploy` (from `backend/`).
5. Verify. The endpoint always answers 204, even when it stored nothing, so check the row, not the status:
   ```
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://gaurav-portfolio-resume-gate.gaurav-lahoti25.workers.dev/api/widget-event \
     -H "Origin: https://gauravlahoti.dev" -H "User-Agent: Mozilla/5.0 (Macintosh) Safari" -H "Content-Type: text/plain" \
     --data '{"sessionId":"verify-todo-0001","event":"open","source":"hero-try"}'
   npx wrangler d1 execute resume-leads --remote --command "SELECT * FROM widget_events WHERE session_id='verify-todo-0001'"
   npx wrangler d1 execute resume-leads --remote --command "DELETE FROM widget_events WHERE session_id LIKE 'verify-%'"
   ```
   Then open the live site, wait for the pop-up, click it, and confirm real `open` and `chip` rows appear.
6. Pulse: `cd agents/pulse && uv run pytest tests/unit` (45 pass today), then **ask Gaurav**, then `make deploy`.
7. Run `/run-ambient-digest` once (it sends one real email) and check that the Journey section shows
   "Opened Atlas", where opens came from, and which suggestions were clicked.

**Done when:** `widget_events` fills as visitors use the pop-up, and the next digest shows the new lines.

**Where the code is:** `backend/src/index.js` (`handleWidgetEvent`, retention), `backend/src/digest.js`
(`widgetEventFields`, `digestExtras`), `backend/migrations/014-widget-events.sql`,
`agents/pulse/app/app_utils/ambient_send.py` (`_journey`, `_entry_points`), `assets/js/agent-widget.js`
(`trackWidget`). The endpoint was tested locally (valid events stored, bad ones dropped, 20 per session cap).

**Gotcha:** never put a `;` inside a comment in `backend/schema.sql`. `local-server.js` splits the file on every
semicolon and silently skips the broken statement.

---

## 2. Atlas quality

### 2a. Atlas sends a note after refusing a code request
Found by `make eval` on 2026-11-20, case `refuse_code_then_note`. The user asks for a Python snippet to be
sent as a note. Atlas refuses the code, then still calls `send_note_to_gaurav` with a made-up message. The
correct behavior is to refuse and call no action tool. This is existing behavior, not something the spec 98
deploy introduced. The note only goes to Gaurav, and it is rare.

Two smaller misses in the same run: `note_missing_email` (called `get_profile` when it should just ask for the
missing email) and `no_tooling_inventory` (called `get_build_story` with an invented `section: harness`).

**Fix direction:** prompt level in `agents/atlas/app/instruction.py`, possibly a check next to the note
guardrail (see `tests/unit/test_note_guardrail.py`). Re-run the three cases to confirm, and run the whole eval
before and after.

### 2b. The eval gate is flaky and red
2026-11-20 result: 31 cases, response quality mean 0.98 (all pass), tool use mean 0.90, three cases at 0.0.
Per earlier notes, tool-use scores swing between 1.0 and 0.0 on identical code. `CLAUDE.md` says the eval must
pass before every deploy, which it cannot reliably do today. Atlas 00074 was deployed with the gate red, with
Gaurav's go-ahead, because none of the failing behavior was touched by that deploy.

**Fix direction:** get a baseline by running `make eval` on a commit before the change, compare case by case,
re-run before believing a regression. Then decide on temperature, thresholds or a different judge. It is long
running, so run it in the background.

### 2c. Clean up the eval's real side effects
The eval calls the live Worker for resume and note sends (see `agents/atlas/tests/eval/prepare_evalset.py`,
which gives each run a fresh test address with a `+eval` suffix). The 2026-11-20 run very likely sent a
made-up note to Gaurav's inbox. Look for it and delete it. A future run will do the same until the eval stops
using the live Worker.

**Also:** the new leak guard logs "retrying once" or "typed-out tool call" when it fires. Search the Atlas logs
for those after a few weeks to see whether the guard is ever doing anything.

---

## 3. Mobile and desktop checks

### 3a. Real iPhone: spoken avatar answer after clicking the pop-up
Not testable from the dev machine. Steps: on a real iPhone set Avatar mode in the panel, reload, wait for the
pop-up, tap it, and listen. Expected: the face answers out loud. `ask()` in `assets/js/agent-widget.js` waits up
to 3 seconds for the face to load before sending, so the click should still count as the gesture that unlocks
sound. If it is silent, the video is started in `assets/js/agent-avatar.js` (`liveVideo.play()` when the first
data arrives, not inside the tap). An untested idea is to prime the video element inside the tap. Typing a
question into the panel behaves the same way today, so this is not a regression from the pop-up.

### 3b. Real-phone look at the new layout
Check on a real phone after a hard refresh: the pop-up chip above the bottom bar (it covers the lower part of
the certificate rail for its 30 seconds, by choice), and the one-line top bar at the phone's text size. The
phone line is `mobileText` in `content/announcement.json` (24 characters or fewer, enforced by
`tests/announcement-copy.test.mjs` and the `/announce` skill).

### 3c. Desktop top bar is 36px but the page reserves 40px
`--banner-reserve: 40px` in `assets/css/base.css`, while the real desktop bar measures 36px. That is a 4px
shift when the bar appears. The phone value (44px) was set to match and does. Fix: set the desktop value to 36px,
then bump `base.css?v=` on all six pages (`index.html`, `live-agents/`, `ai-labs/`, and the three lab pages)
and re-measure.
