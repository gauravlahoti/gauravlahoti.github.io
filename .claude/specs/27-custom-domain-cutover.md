# Spec: Custom Domain Cutover

## Overview

Move the portfolio off the default `gauravlahoti.github.io` URL and onto
the purchased apex domain `gauravlahoti.dev`. The cutover is split across
GitHub Pages, the Cloudflare Worker (resume-gate CORS), the Cloud Run
agent (citation/guardrail allowlists + outbound resume email copy), the
Google OAuth client (Sign-In origins), and the registrar DNS. This spec
covers the in-repo code changes (the only part `/implement-spec` can do);
DNS, OAuth, and backend redeploys are documented in "Definition of done"
as manual operator steps because they live outside the repo.

## Depends on

- Spec 09 (deploy / GitHub Pages) — added the deploy workflow; this spec
  finally adds the `CNAME` it left as a TODO.
- Spec 11 / 12 (resume gate + Google auth) — the OAuth origin and Worker
  CORS list both reference the portfolio host.
- Spec 21 (ADK agent on Cloud Run) — frozen-in-prompt allowlist hosts.
- Spec 24 (agent conversation upgrades) — server-side citation host
  allowlist (`_ALLOWED_CITE_HOSTS`).

## Routes

No backend.

## Database changes

No database.

## Templates

- **Create:** `CNAME` at repo root (single line: `gauravlahoti.dev`).
- **Modify:** `index.html` — canonical, OG, Twitter, JSON-LD URLs swap
  from `gauravlahoti.github.io` to `gauravlahoti.dev`.

## Files to change

- `index.html` — replace `https://gauravlahoti.github.io` with
  `https://gauravlahoti.dev` in: `<link rel="canonical">`, `og:image`,
  `og:url`, `twitter:image`, JSON-LD `url`, JSON-LD `image`.
- `backend/wrangler.toml` — `ALLOWED_ORIGINS` swap. Keep the old
  `https://gauravlahoti.github.io` alongside the new
  `https://gauravlahoti.dev` (comma-separated) so the Worker keeps
  serving both during DNS propagation; can be trimmed later.
- `backend/README.md` — update the example origin in the CORS section.
- `assets/js/agent-widget.js` — `ALLOWED_HOSTS` array: replace
  `gauravlahoti.github.io` with `gauravlahoti.dev`.
- `portfolio-agent/app/api.py` — `_ALLOWED_CITE_HOSTS`: same swap.
- `portfolio-agent/app/guardrails.py` — suspicious-URL host list: same
  swap.
- `portfolio-agent/app/instruction.py` — five occurrences of the host
  in the model prompt (citation allowlist, root URL example, "do NOT
  paste any path on …" guardrail line, the example META JSON).
- `portfolio-agent/app/app_utils/resume_send.py` — outbound resume
  email body (HTML and text variants) and `RESUME_PDF_URL` fallback.
- `portfolio-agent/tests/eval/eval_config.json` — two rubric
  `textProperty` strings.
- `portfolio-agent/tests/unit/test_meta_parser.py` — `required` host
  set in the citation-validation unit test.

## Files to create

- `CNAME` (repo root) — one line, `gauravlahoti.dev`, no protocol, no
  trailing newline-content. GitHub Pages reads this on every deploy.

## New dependencies

No new dependencies.

## Rules for implementation

- All identity content lives in `assets/js/data/profile.json`.
  (`profile.json` has no host references today; nothing changes there.)
- CSS variables only — never hardcode hex. (No CSS in this spec.)
- One JS module per visualization; lazy-load on viewport entry. (No new
  modules.)
- No npm, no bundler, no Node toolchain.
- Respect `prefers-reduced-motion`. (No motion changes.)
- Mobile fallbacks for every WebGL/Three.js feature. (No viz changes.)
- Do not edit prior spec files in `.claude/specs/` — they are
  append-only history.
- Do not touch the generic placeholder `<user>.github.io` strings in
  `.claude/skills/portfolio-deploy-troubleshoot/SKILL.md` or
  `.claude/commands/publish.md` — those are template variables, not
  literal hostnames.
- Bump `ASSET_VERSION` in `index.html` if any asset URL changes (none
  do here, so bump is optional — only if cache-busting the OG/canonical
  meta is desired).

## Definition of done

In-repo (verifiable via `git diff main`):

- [ ] `/CNAME` exists with content `gauravlahoti.dev`.
- [ ] `index.html` has zero remaining `gauravlahoti.github.io` strings.
- [ ] `assets/js/agent-widget.js` `ALLOWED_HOSTS` includes
      `gauravlahoti.dev` and excludes the old host (or includes both).
- [ ] `portfolio-agent/app/api.py`, `guardrails.py`, `instruction.py`,
      `app_utils/resume_send.py` all reference `gauravlahoti.dev`.
- [ ] `backend/wrangler.toml` `ALLOWED_ORIGINS` includes
      `https://gauravlahoti.dev`.
- [ ] `backend/README.md` example references the new domain.
- [ ] Eval rubric `textProperty` and unit-test host set updated.
- [ ] `grep -rn 'gauravlahoti\.github\.io' .` returns only matches in
      `.claude/specs/` (history), `.claude/skills/`, and
      `.claude/commands/` (generic placeholders).
- [ ] `python3 -m http.server 5173` and load `http://localhost:5173/`
      → page renders, no console errors, OG/canonical meta inspect to
      `gauravlahoti.dev`.

Out-of-repo (operator steps after merge):

- [ ] DNS at registrar: four A records on apex
      `gauravlahoti.dev` → `185.199.108.153`, `.109.153`, `.110.153`,
      `.111.153` (and matching AAAA `2606:50c0:8000-8003::153`).
      `www.gauravlahoti.dev` CNAME → `gauravlahoti.github.io.`.
- [ ] GitHub repo Settings → Pages → Custom domain set to
      `gauravlahoti.dev`; DNS check passes; Enforce HTTPS ticked once
      cert provisions.
- [ ] Google Cloud Console → OAuth 2.0 Client → Authorized JavaScript
      origins includes `https://gauravlahoti.dev` and
      `https://www.gauravlahoti.dev`.
- [ ] `cd backend && npx wrangler deploy` to ship new
      `ALLOWED_ORIGINS`.
- [ ] `cd portfolio-agent && agents-cli eval run --evalset
      tests/eval/evalsets/portfolio.evalset.json` passes, then
      `agents-cli deploy ...` to ship new prompt + guardrails.
- [ ] `curl -I https://gauravlahoti.dev/` → 200 + valid TLS;
      `https://gauravlahoti.github.io/` → 301 to apex.
- [ ] Browser smoke test on `https://gauravlahoti.dev`: hero loads,
      resume gate Google Sign-In completes and downloads the PDF, agent
      widget streams a reply with citation chips labelled to
      `gauravlahoti.dev`.
- [ ] OG preview on `https://www.opengraph.xyz/` for the new URL
      shows the correct image and metadata.
