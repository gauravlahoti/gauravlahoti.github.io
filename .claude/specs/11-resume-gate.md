# Spec: Resume Download Gate

## Overview

The resume PDF (`assets/img/resume.pdf`) sits behind a name + email
modal. When a visitor clicks `Download Resume` (in the nav or in the
connect section), a dialog opens; on form submit, a serverless backend
records `{ name, email, downloaded_at, ip, user_agent, referrer }` to a
SQLite database (Cloudflare D1) and only on a successful write does the
PDF download trigger. After a successful submit, the gate is bypassed
on the same device for 30 days via `localStorage`. This adds a backend
concern to the project but keeps the static frontend rules intact: the
portfolio still ships as plain HTML/CSS/JS to GitHub Pages, and the
backend lives as a separate sub-project at `<repo>/backend/`.

## Depends on

- Spec 01 (`#hero` shell + nav structure).
- Spec 07 (`#connect` section — secondary CTA placement).
- Existing `assets/img/resume.pdf`.
- Existing `profile.json` (`links.resume`); extended with `links.resumeApi`.

## Routes

- **POST** `https://<worker>.workers.dev/api/resume-download`
  - Body (JSON): `{ name: string (1–100), email: string (valid) }`
  - 200: `{ ok: true, url: "/assets/img/resume.pdf" }`
  - 400: `{ ok: false, error: "<reason>" }` for invalid input
  - 403: `{ ok: false, error: "Origin not allowed" }`
  - 500: `{ ok: false, error: "Internal" }` on D1 failure
- **OPTIONS** `/api/resume-download` → CORS preflight.
- **GET** `/api/leads` (optional admin endpoint, requires
  `Authorization: Bearer <ADMIN_TOKEN>`) → JSON dump of recent leads.

## Database changes

New SQLite database `resume-leads` (Cloudflare D1) with one table:

```sql
CREATE TABLE IF NOT EXISTS resume_downloads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  downloaded_at   INTEGER NOT NULL,            -- unix seconds (UTC)
  ip              TEXT,
  user_agent      TEXT,
  referrer        TEXT
);
CREATE INDEX IF NOT EXISTS idx_rd_email ON resume_downloads(email);
CREATE INDEX IF NOT EXISTS idx_rd_at    ON resume_downloads(downloaded_at);
```

## Templates

- **Create:** `<dialog class="resume-modal" data-resume-modal>` block at
  the bottom of `<body>` in `index.html`.
- **Modify:** `index.html` — add `Resume` button to the nav (between
  the channel icons and the Topmate CTA) and a `Download Resume` ghost
  button in the connect section (below the Topmate primary).

## Files to change

- `index.html`:
  - Add nav button: `<button class="btn btn-primary btn-sm" data-resume-trigger>Resume</button>` (with `data-cursor="magnet"`).
  - Add connect-section button: `<button class="btn btn-ghost connect-resume-cta" data-resume-trigger>Download Resume</button>`, placed below the Topmate primary CTA.
  - Add modal markup at the bottom of `<body>` (just before the brand-logo SVG sprite or at the very end), per the markup contract below.
- `assets/css/components.css`: add `.resume-modal`, `.resume-form`,
  `.resume-form input`, `.resume-form-actions`, `.resume-error`,
  `.resume-loading` (spinner), `.resume-success`, plus
  `prefers-reduced-motion: reduce` overrides.
- `assets/js/main.js`: in bootstrap, attach a single delegated click
  listener for `[data-resume-trigger]` that lazy-imports
  `./resume-gate.js` and calls `initResumeGate(profile)` on first
  trigger. Subsequent clicks reuse the same instance.
- `assets/js/data/profile.json`: add `links.resumeApi` (the Worker's
  POST URL). Until the backend is deployed, set to an empty string
  and the frontend gracefully shows "Resume gate not configured" on
  submit instead of triggering a broken POST.

## Files to create

- `assets/js/resume-gate.js` — exports `initResumeGate(profile) → { open, destroy }`.
- `backend/wrangler.toml` — Worker + D1 binding config.
- `backend/src/index.js` — request router, validation, D1 insert, optional admin GET.
- `backend/schema.sql` — schema above.
- `backend/README.md` — one-time setup + deploy commands.
- `backend/.gitignore` — `node_modules/`, `.wrangler/`, `.dev.vars`.

## New dependencies

- **Frontend:** none. No new CDN scripts. The native `<dialog>`
  element is used for the modal (ESC + backdrop close come for free).
- **Backend (separate sub-project, not deployed via the static site):**
  `wrangler` CLI installed globally on the developer's machine. The
  Worker itself has zero npm dependencies — single-file handler
  using only the Workers runtime.

## Markup contract for the modal

```html
<dialog class="resume-modal" data-resume-modal aria-labelledby="resume-modal-title">
  <form method="dialog" class="resume-form" data-resume-form>
    <header class="resume-form-head">
      <p class="resume-form-eyebrow">// resume::request</p>
      <h3 id="resume-modal-title">Resume</h3>
      <p class="resume-form-sub">Tell me a bit about you and the PDF will download.</p>
    </header>
    <label class="resume-field">
      <span>Name</span>
      <input name="name" type="text" required minlength="2" maxlength="100" autocomplete="name"/>
    </label>
    <label class="resume-field">
      <span>Email</span>
      <input name="email" type="email" required autocomplete="email"/>
    </label>
    <p class="resume-form-privacy">Your details help me follow up. I won't share them.</p>
    <p class="resume-error" data-resume-error hidden></p>
    <div class="resume-form-actions">
      <button type="button" class="btn btn-ghost" data-resume-cancel>Cancel</button>
      <button type="submit" class="btn btn-primary" data-resume-submit>
        <span data-resume-submit-label>Download</span>
        <span class="resume-loading" data-resume-loading hidden aria-hidden="true"></span>
      </button>
    </div>
  </form>
</dialog>
```

## Backend layout

```
backend/
├── wrangler.toml      # Worker config + D1 binding
├── src/
│   └── index.js       # POST /api/resume-download handler
├── schema.sql         # CREATE TABLE for resume_downloads
├── README.md          # one-time setup + deploy commands
└── .gitignore         # node_modules, .wrangler/, .dev.vars
```

### `backend/wrangler.toml`

```toml
name = "gaurav-portfolio-resume-gate"
main = "src/index.js"
compatibility_date = "2026-04-01"

[[d1_databases]]
binding = "DB"
database_name = "resume-leads"
database_id = "<filled-in-after-create>"

[vars]
ALLOWED_ORIGINS = "https://gauravlahoti.github.io,http://localhost:5173"
```

### One-time deploy walkthrough (in `backend/README.md`)

```bash
# Prereq: Cloudflare account (free), wrangler installed globally
npm install -g wrangler
cd backend
wrangler login

# Create the D1 database
wrangler d1 create resume-leads
# Copy the printed database_id into wrangler.toml

# Apply schema
wrangler d1 execute resume-leads --remote --file=schema.sql

# (Optional) set admin token for the GET /api/leads endpoint
wrangler secret put ADMIN_TOKEN

# Deploy
wrangler deploy

# Returns: https://gaurav-portfolio-resume-gate.<account>.workers.dev
# Paste this into profile.json links.resumeApi
```

### Querying leads later

```bash
# Recent downloads
wrangler d1 execute resume-leads --remote --command \
  "SELECT name, email, datetime(downloaded_at,'unixepoch') AS at FROM resume_downloads ORDER BY downloaded_at DESC LIMIT 50"

# Or via the admin API (after setting ADMIN_TOKEN)
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<worker-url>/api/leads
```

## Rules for implementation

- The static site stays static. No build step is added to the
  portfolio. The backend is its own sub-project deployed via
  wrangler; the portfolio repo only stores its source.
- The frontend NEVER ships the backend URL hardcoded in JS — it
  reads from `profile.links.resumeApi`. If that field is empty, the
  modal renders but submit shows "Resume gate not configured"
  instead of a broken POST.
- Validation runs on both client (HTML5 + JS regex) and server
  (Worker re-validates). Don't trust client-side checks alone.
- The Worker's `ALLOWED_ORIGINS` env var must include the production
  GitHub Pages origin AND `http://localhost:5173` for local dev.
- The Worker captures `CF-Connecting-IP` (real client IP) but only
  stores it in the row — does not return it. The PII column is read
  by the user (via wrangler) for follow-up; not exposed to the page.
- **Strict gate:** download triggers ONLY after the API write
  succeeds. On any error (network, 4xx, 5xx), keep modal open, show
  retry-friendly message in `[data-resume-error]`, re-enable submit.
- After a successful download, set
  `localStorage.setItem("resumeGatePassed", String(Date.now()))`.
  On subsequent CTA clicks within 30 days, skip the form and
  download directly. After 30 days, gate again.
- The native `<dialog>` element provides ESC + backdrop close.
  Submit button shows a spinner and is disabled while the request
  is in flight.
- Modal markup uses semantic form elements with `<label>`s wrapping
  inputs for a11y. `aria-labelledby` on the `<dialog>` points to the
  title.
- `prefers-reduced-motion: reduce` removes the modal's slide-in /
  fade transitions; modal appears instantly.
- Mobile (< 600 px): modal is full-width with comfortable touch
  targets (≥ 44 px on inputs and buttons).
- Total local JS budget after this spec: ≤ 18 KB gzipped (the new
  `resume-gate.js` is ~3–4 KB gzip, lazy-loaded on first CTA click).

## Privacy / abuse mitigation

- Modal includes a one-line privacy note: "Your details help me
  follow up. I won't share them."
- Worker enforces an Origin allowlist; rejects any POST whose
  `Origin` is not in `ALLOWED_ORIGINS`.
- Cloudflare's built-in DDoS protection covers basic abuse.
- Future v2 (NOT in this spec): add Cloudflare Turnstile (free
  CAPTCHA) before submit if abuse materializes.
- PII discipline: name + email + timestamp + technical context (IP,
  UA, referrer). No tracking pixels, no cookies, no analytics IDs.

## Definition of done

- [ ] `Resume` button appears in the top-right nav (between the
      channel icons and the Topmate CTA).
- [ ] `Download Resume` ghost button appears in the connect section
      below the Topmate primary.
- [ ] Clicking either CTA opens the `<dialog>` modal centered on
      screen with a frosted/glass backdrop.
- [ ] Form has Name (required, 2–100 chars) and Email (required,
      valid email regex) fields with proper labels.
- [ ] Submitting valid input POSTs to `profile.links.resumeApi`.
      Backend returns 200; frontend triggers `<a href="<resume>"
      download>` click; modal shows "Downloading…" momentarily;
      closes.
- [ ] Backend writes a row to `resume_downloads` with name, email,
      `downloaded_at` (unix), ip, user_agent, referrer.
- [ ] If backend is unreachable / returns non-200, modal stays open
      with `[data-resume-error]` populated; submit re-enabled.
- [ ] Origin check blocks POSTs from any host not in
      `ALLOWED_ORIGINS` (verified via curl from a third origin).
- [ ] After a successful download, `localStorage.resumeGatePassed`
      is set. Within 30 days, clicking the CTA downloads
      immediately without re-prompting.
- [ ] ESC and backdrop click close the modal (native `<dialog>`).
- [ ] `prefers-reduced-motion: reduce` skips slide / fade transitions.
- [ ] Mobile (375 px) renders modal full-width with usable touch
      targets.
- [ ] `wrangler d1 execute resume-leads --remote --command "SELECT
      COUNT(*) FROM resume_downloads"` returns the expected count
      after submitting a test entry.
- [ ] No console errors on either page or backend during the full
      flow.
- [ ] Local JS gzip total stays ≤ 18 KB after this spec lands.

## User input required before /implement-spec

- A Cloudflare account (free) with `wrangler` CLI installed.
- The user runs the deploy walkthrough (in `backend/README.md`)
  once to provision D1 and deploy the Worker. The resulting Worker
  URL goes into `profile.links.resumeApi`.
- Until the backend is provisioned, the frontend is implemented but
  shows "Resume gate not configured" on submit.
