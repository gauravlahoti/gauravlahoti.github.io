# Spec: Resume-Send Fallback Link

## Overview

When the agent's `send_resume` tool succeeds, today the spoken reply says
*"I sent it"* and stops there. After spec 27 we observed
real-world bounces from corporate Microsoft 365 / Defender tenants
(`@deloitte.com` was the trigger): the SMTP edge rejects with
`550 5.7.1 "Your access to submit messages to this e-mail system has been
rejected"` — pre-content, no way to defeat from the sender side. The
visitor trusts the "sent" confirmation and never sees the resume.

This spec ships the simplest possible mitigation: every successful send
confirmation includes a one-line manual fallback pointer to
`https://gauravlahoti.dev` (the Resume button at the top of the page,
which gates the PDF behind Google Sign-In). If the email arrives → great.
If it doesn't → the visitor already had the link in front of them when
the agent confirmed the send. Same line gets mirrored in the email body
itself for the case where the email lands in spam but the link is the
escape hatch.

No async machinery, no bounce detection, no schema changes — pure prompt
+ email-copy update.

## Depends on

- Spec 21 (ADK agent on Cloud Run) — establishes `send_resume`.
- Spec 24 (agent conversation upgrades) — meta block + citation
  allowlist; `gauravlahoti.dev` is already on the allowlist.
- Spec 27 (custom domain cutover) — the fallback URL `gauravlahoti.dev`
  is the canonical portfolio host.

## Routes

No backend.

## Database changes

No database.

## Templates

- **Create:** none.
- **Modify:** `portfolio-agent/app/instruction.py`,
  `portfolio-agent/app/app_utils/resume_send.py`.

## Files to change

- `portfolio-agent/app/instruction.py` — under "Resume routing" the
  `When send_resume returns: ok=true →` line gets tightened so the model
  always names the manual fallback URL alongside the confirmation. Add
  a worked example to make the format unambiguous. The bare apex URL
  `https://gauravlahoti.dev` is already allowlisted; the existing
  guardrail forbidding deep paths (`/resume.pdf`, `/download…`) on the
  portfolio domain stays intact.
- `portfolio-agent/app/app_utils/resume_send.py` — `_email_html()` and
  `_email_text()` get one extra line: "If this didn't reach your inbox,
  the resume is also at https://gauravlahoti.dev — Resume button at
  the top." Mirrors the spoken reply in the email itself.
- `portfolio-agent/tests/eval/evalsets/portfolio.evalset.json` — adjust
  the existing `email-the-resume` style case (or add one) so the
  expected reply contains both the confirmation **and** the
  manual-fallback URL. Rubric-graded, no exact match.

## Files to create

None.

## New dependencies

No new dependencies.

## Rules for implementation

- All identity content lives in `assets/js/data/profile.json`. (No
  identity copy changes here; the fallback URL is the portfolio host
  itself, baked into the prompt.)
- CSS variables only — never hardcode hex. (No CSS in this spec.)
- One JS module per visualization; lazy-load on viewport entry. (No JS
  changes.)
- No npm, no bundler, no Node toolchain.
- Respect `prefers-reduced-motion`. (No motion changes.)
- Mobile fallbacks for every WebGL/Three.js feature. (No viz changes.)
- Bare apex `https://gauravlahoti.dev` only — never a deep path. The
  existing `_HALLUCINATED_PORTFOLIO_PATH_RE` in
  `portfolio-agent/app/guardrails.py` would strip a path-looking URL
  anyway; the prompt change must keep the URL on the apex.
- Do not change the `send_resume` tool signature or its return shape.
  This is a copy-only spec.

## Definition of done

- [ ] `instruction.py` "Resume routing" section's `ok=true` rule
      explicitly requires the model to include a `https://gauravlahoti.dev`
      manual-fallback line in the reply, with a worked example.
- [ ] `_email_html()` and `_email_text()` in `resume_send.py` include
      the same fallback line.
- [ ] One eval case in `portfolio.evalset.json` exercises the new
      pattern (LLM-as-judge confirms confirmation + fallback URL both
      present).
- [ ] Local smoke (`agents-cli playground` or `agents-cli run`):
      *"Email me the resume at test@example.com"* → reply contains
      both the confirmation and `https://gauravlahoti.dev`.
- [ ] Local smoke: *"How do I get the resume?"* (no email offered) →
      still routes to the on-site flow (no regression).
- [ ] `agents-cli eval run --evalset
      tests/eval/evalsets/portfolio.evalset.json` passes at least the
      pre-change baseline (13/16 from spec 27 deploy).
- [ ] Cloud Run agent redeployed via `agents-cli deploy
      --project=gcp-experiments-490306 --region=us-central1 --
      --allow-unauthenticated --cpu-boost --min-instances=0`.
- [ ] Production smoke: ask the agent on `https://gauravlahoti.dev`
      to email a personal Gmail. Reply includes the fallback URL.
      Email body also includes the new "also at gauravlahoti.dev"
      line.
