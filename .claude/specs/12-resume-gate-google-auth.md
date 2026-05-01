# Spec: Resume Gate — Google Sign-In Upgrade

## Overview

Spec 11 shipped the resume gate as a name+email form. Anyone can type
"John Doe / john@fake.com" and walk away with the PDF, which makes the
lead capture worthless. This spec swaps the form for **Sign in with
Google** (Google Identity Services / GIS).

Frontend renders a Google-branded button inside the existing modal.
On click, GIS hands the page a JWT signed by Google. The frontend
POSTs the JWT to the Worker; the Worker verifies it with Google's
`tokeninfo` endpoint, double-checks the `aud` claim against our
configured client id, and only then writes a row to D1. The PDF
download triggers only after the verified row is written.

The static-frontend rule still holds: the portfolio ships as plain
HTML/CSS/JS. The only new external dependency is the GIS script
(`https://accounts.google.com/gsi/client`), loaded from Google's CDN.

## Depends on

- Spec 11 (`<dialog>` modal markup, lazy loader in `main.js`,
  localStorage 30-day bypass, Worker scaffold + D1 binding).
- A Google Cloud project with an OAuth 2.0 Web client ID configured
  with the portfolio's origins as Authorized JavaScript origins.

## Routes (unchanged paths, new body shape)

- **POST** `/api/resume-download`
  - Body (JSON): `{ credential: <Google ID token JWT> }`
  - 200: `{ ok: true, url: "/assets/img/resume.pdf" }`
  - 400: `{ ok: false, error: "Invalid credential" }`
  - 401: `{ ok: false, error: "Token verification failed" }`
  - 403: `{ ok: false, error: "Origin not allowed" }`
  - 500: `{ ok: false, error: "Internal" }`
- **OPTIONS** `/api/resume-download` → CORS preflight (unchanged).
- **GET** `/api/leads` (admin) → now returns the new columns too.

## Database changes

The `resume_downloads` table gains four columns. For fresh installs,
`schema.sql` is rewritten to include them. For installs where spec 11
already ran, a one-shot migration file applies `ALTER TABLE` statements.

```sql
-- schema.sql (fresh install)
CREATE TABLE IF NOT EXISTS resume_downloads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub      TEXT NOT NULL,
  email           TEXT NOT NULL,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  name            TEXT NOT NULL,
  picture         TEXT,
  downloaded_at   INTEGER NOT NULL,
  ip              TEXT,
  user_agent      TEXT,
  referrer        TEXT
);
CREATE INDEX IF NOT EXISTS idx_rd_email ON resume_downloads(email);
CREATE INDEX IF NOT EXISTS idx_rd_at    ON resume_downloads(downloaded_at);
CREATE INDEX IF NOT EXISTS idx_rd_sub   ON resume_downloads(google_sub);
```

```sql
-- migrations/001-add-google-fields.sql (existing v1 → v2)
ALTER TABLE resume_downloads ADD COLUMN google_sub     TEXT;
ALTER TABLE resume_downloads ADD COLUMN email_verified INTEGER DEFAULT 0;
ALTER TABLE resume_downloads ADD COLUMN picture        TEXT;
CREATE INDEX IF NOT EXISTS idx_rd_sub ON resume_downloads(google_sub);
```

## Files to change

- `index.html`:
  - Add `<script src="https://accounts.google.com/gsi/client" async></script>` to `<head>`.
  - Inside `<dialog data-resume-modal>`: drop the `<input name="name">` and
    `<input name="email">` fields. Keep eyebrow, title, sub. Insert
    `<div id="g-signin-btn" data-gsi-button></div>` and a privacy note
    `<p class="resume-form-google-note">…</p>` between the title and
    Cancel button. Submit button is removed; sign-in itself is the action.
- `assets/css/components.css`: add `#g-signin-btn` (centered) and
  `.resume-form-google-note` styles. Drop the now-unused
  `.resume-field` block.
- `assets/js/main.js`: no change (existing `initResumeGateLazy` still
  works).
- `assets/js/resume-gate.js`: rewrite the form-submit path. Reuse the
  open/close, dialog backdrop close, localStorage bypass, and download
  trigger. New `onGoogleCredential` callback POSTs `{ credential }`
  and on 200 triggers download.
- `assets/js/data/profile.json`: add `links.googleClientId: ""`.
- `backend/wrangler.toml`: add `GOOGLE_CLIENT_ID = "<paste>"` to `[vars]`.
- `backend/src/index.js`: rewrite `handleDownload` to verify the JWT
  via `https://oauth2.googleapis.com/tokeninfo?id_token=<jwt>` and
  insert the verified row.
- `backend/schema.sql`: replace with the new shape above.
- `backend/README.md`: add a "Google OAuth setup" section before the
  D1 walkthrough; add the migration command.

## Files to create

- `backend/migrations/001-add-google-fields.sql` (above).

## New dependencies

- **Frontend (CDN, deferred):** `https://accounts.google.com/gsi/client`
  (Google Identity Services). Loaded once with `async`. ~50 KB gzip.
- **Backend:** none. The Worker uses `fetch()` to call Google's
  tokeninfo endpoint — no npm packages.

## Markup contract for the modal (replacement)

```html
<dialog class="resume-modal" data-resume-modal aria-labelledby="resume-modal-title">
  <div class="resume-form" data-resume-form>
    <header class="resume-form-head">
      <p class="resume-form-eyebrow">// resume::request</p>
      <h3 id="resume-modal-title">Resume</h3>
      <p class="resume-form-sub">Sign in to download. I'll record your name and email so I can follow up.</p>
    </header>
    <div id="g-signin-btn" data-gsi-button></div>
    <p class="resume-form-google-note">Verified by Google. I won't share your details.</p>
    <p class="resume-error" data-resume-error hidden></p>
    <div class="resume-form-actions">
      <button type="button" class="btn btn-ghost" data-resume-cancel>Cancel</button>
    </div>
  </div>
</dialog>
```

## Token verification (Worker)

```js
const verifyUrl = "https://oauth2.googleapis.com/tokeninfo?id_token=" +
                  encodeURIComponent(credential);
const res = await fetch(verifyUrl);
if (!res.ok) return 401;
const claims = await res.json();
if (claims.aud !== env.GOOGLE_CLIENT_ID) return 401;
if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) return 401;
if (Number(claims.exp) <= Math.floor(Date.now() / 1000)) return 401;
if (claims.email_verified !== "true" && claims.email_verified !== true) return 401;
// claims.sub, claims.email, claims.name, claims.picture are now trustworthy
```

## Rules for implementation

- The frontend NEVER ships a Google client *secret*. Only the
  *client ID* is needed (it's a public audience identifier).
- The Worker re-verifies every token. Don't trust the frontend.
- `aud` MUST equal the configured `GOOGLE_CLIENT_ID` env var. This
  prevents tokens minted for another app from working here.
- Reject `email_verified: false`. (Hosted G Suite emails not yet
  confirmed.)
- Origin allowlist stays in effect — the JWT alone isn't enough.
- After a successful response, set
  `localStorage.resumeGatePassed = Date.now()`. Subsequent CTA clicks
  within 30 days download the PDF directly without re-prompting.
- If `profile.links.googleClientId` is empty, render the modal but
  show "Sign-in not configured" in `[data-resume-error]` instead of
  attempting to call GIS.
- The `<dialog>` provides ESC + backdrop close. Cancel button still
  closes.
- Mobile (< 600 px): GIS button uses `width: "100%"` configuration so
  it fills the modal cleanly.

## One-time GCP setup (before deploy)

1. <https://console.cloud.google.com/apis/credentials> →
   **Create credentials → OAuth client ID → Web application**.
2. Authorized JavaScript origins:
   - `https://gauravlahoti.github.io`
   - `http://localhost:5173`
3. Copy the Client ID (`<n>-<hash>.apps.googleusercontent.com`).
4. Paste into `assets/js/data/profile.json` under
   `links.googleClientId`.
5. Paste into `backend/wrangler.toml` under `[vars] GOOGLE_CLIENT_ID`.
6. Apply migration + redeploy:
   ```bash
   cd backend
   wrangler d1 execute resume-leads --remote \
     --file=migrations/001-add-google-fields.sql
   wrangler deploy
   ```

## Privacy / abuse mitigation

- Only the Google account info is recorded. No tracking pixels, no
  cookies set by the portfolio.
- Origin allowlist on the Worker.
- Cloudflare DDoS protection.
- Future v3 (NOT in this spec): rate-limit per `google_sub` if abuse
  appears.

## Definition of done

- [ ] GIS script loads from
      `https://accounts.google.com/gsi/client` once per page.
- [ ] Clicking either Resume CTA opens the centered `<dialog>` modal
      with a Google-branded sign-in button rendered inside.
- [ ] Selecting a Google account triggers a POST to
      `profile.links.resumeApi` with `{ credential }`.
- [ ] Worker verifies the JWT via tokeninfo: bad signature, wrong
      `aud`, wrong `iss`, expired, or `email_verified=false` → 401
      and no row inserted.
- [ ] Worker rejects requests from unknown origins (403, no row).
- [ ] Successful verification inserts a row with `google_sub`,
      `email`, `email_verified=1`, `name`, `picture`, `downloaded_at`,
      `ip`, `user_agent`, `referrer`.
- [ ] Frontend triggers `<a download>` only on 200; on any failure
      modal stays open with `[data-resume-error]` populated.
- [ ] After success, `localStorage.resumeGatePassed` set; within 30
      days, CTA clicks download immediately without opening modal.
- [ ] ESC and backdrop click still close the modal.
- [ ] If `profile.links.googleClientId` is empty, modal renders the
      error "Sign-in not configured" instead of calling GIS.
- [ ] Mobile (375 px) renders modal full-width; GIS button is
      tap-friendly.
- [ ] No console errors during the full flow.
- [ ] Local JS gzip total stays ≤ 18 KB after this spec lands (the
      Google CDN script is not counted).
- [ ] `wrangler d1 execute resume-leads --remote --command "SELECT
      email, email_verified FROM resume_downloads ORDER BY id DESC
      LIMIT 1"` returns a row with `email_verified = 1` for a real
      sign-in.

## User input required before /implement-spec

- A Google Cloud project + OAuth 2.0 Web client ID (free).
- The user pastes the client id into `profile.json` and
  `wrangler.toml`, runs the migration, redeploys the Worker.
- Until those steps are done, the gate renders the
  "Sign-in not configured" message on click.
