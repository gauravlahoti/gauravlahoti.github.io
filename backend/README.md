# Resume Gate Backend

Verifies a **Google Sign-In** credential and records the authenticated
visitor whenever someone clicks **Download Resume** on the portfolio.
The PDF download fires on the client only after the backend confirms
the JWT is valid and the row was written.

Two interchangeable runtimes live in this folder:

| Runtime | File | Storage | When to use |
|---|---|---|---|
| **Local Node** | `local-server.js` | `leads.db` (plain SQLite file) | Dev / running on your own box |
| **Cloudflare Worker** | `src/index.js` | Cloudflare D1 (also SQLite) | Production / serverless |

Both speak the same protocol and use the same `schema.sql`, so leads
captured locally are schema-compatible with a future Cloudflare deploy.

This sub-project is separate from the static portfolio — the portfolio
itself stays plain HTML/CSS/JS and ships to GitHub Pages.

## Local mode (current)

```bash
cd backend
npm install               # installs better-sqlite3 (one-time)
npm start                 # listens on http://localhost:8787
```

The server creates `backend/leads.db` automatically on first run from
`schema.sql`. Your portfolio's `assets/js/data/profile.json` already
points `links.resumeApi` at `http://localhost:8787/api/resume-download`.

### Querying locally

```bash
# Quick view via npm script (uses the system sqlite3 CLI)
npm run leads

# Or interactively
sqlite3 backend/leads.db
sqlite> SELECT name, email, datetime(downloaded_at,'unixepoch') AS at
        FROM resume_downloads ORDER BY downloaded_at DESC LIMIT 50;
sqlite> .quit
```

The `.db` file lives at `backend/leads.db` and is git-ignored — it
contains PII, do not commit it.

### Environment overrides

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | listen port |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | CORS allowlist |
| `GOOGLE_CLIENT_ID` | (baked-in fallback for dev) | OAuth client id used to verify `aud` |
| `ADMIN_TOKEN` | unset | enables `GET /api/leads` if set |

## Cloudflare deploy (future)

Skip this section while you're running locally. When you're ready to
go serverless, deploy `src/index.js` to Cloudflare and swap
`profile.json` → `links.resumeApi` to the deployed Worker URL.

### 1. Google OAuth client

1. Open <https://console.cloud.google.com/apis/credentials>.
2. **Create credentials → OAuth client ID → Web application.**
3. Name: `gaurav-portfolio-resume-gate`.
4. **Authorized JavaScript origins:**
   - `https://gauravlahoti.github.io`
   - `http://localhost:5173`
5. **Authorized redirect URIs:** none (GIS One Tap / button doesn't use them).
6. Copy the **Client ID** (looks like `1234-abcdef.apps.googleusercontent.com`).
7. Paste it into:
   - `assets/js/data/profile.json` → `links.googleClientId`
   - `backend/wrangler.toml` → `[vars] GOOGLE_CLIENT_ID`

The Client ID is public — safe to commit. Do **not** copy the *Client
secret*; we don't need it.

### 2. Cloudflare D1

```bash
# Prereq: free Cloudflare account, wrangler installed globally
npm install -g wrangler

cd backend
wrangler login

# Fresh install: create the D1 database and apply schema
wrangler d1 create resume-leads
# → copy the printed `database_id` into wrangler.toml

wrangler d1 execute resume-leads --remote --file=schema.sql

# OR — if you already ran spec 11, apply the v1 → v2 migration instead:
wrangler d1 execute resume-leads --remote \
  --file=migrations/001-add-google-fields.sql

# (Optional) set admin token to enable GET /api/leads
wrangler secret put ADMIN_TOKEN

# Deploy
wrangler deploy
# → returns: https://gaurav-portfolio-resume-gate.<account>.workers.dev
```

Paste the deployed URL + path `/api/resume-download` into
`assets/js/data/profile.json` under `links.resumeApi`.

## Endpoints

- `POST /api/resume-download` — body `{ credential: <Google ID token> }`.
  Verifies the JWT via Google's `tokeninfo` endpoint (checks `aud`,
  `iss`, `exp`, `email_verified`). Inserts a row, returns
  `{ ok: true, url }`. Origin must be in `ALLOWED_ORIGINS`.
- `OPTIONS /api/resume-download` — CORS preflight.
- `GET /api/leads` — admin dump (last 200 rows). Requires
  `Authorization: Bearer $ADMIN_TOKEN`.

## Querying leads

```bash
# Recent downloads via wrangler
wrangler d1 execute resume-leads --remote --command \
  "SELECT name, email, email_verified, datetime(downloaded_at,'unixepoch') AS at FROM resume_downloads ORDER BY downloaded_at DESC LIMIT 50"

# Or via the admin API
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://<worker-url>/api/leads
```

## Local dev

```bash
wrangler dev
# Worker available at http://localhost:8787
```

Update the portfolio's `profile.json` `resumeApi` to the local URL while
testing, or keep it pointed at production.

## Layout

```
backend/
├── wrangler.toml                          # Worker config + D1 binding + GOOGLE_CLIENT_ID + cron
├── src/index.js                           # Router, JWKS verify, dedupe, D1 insert, admin GET, cron handler
├── schema.sql                             # CREATE TABLE for fresh installs
├── migrations/001-add-google-fields.sql   # v1 (spec 11) → v2 (spec 12) migration
├── README.md                              # this file
└── .gitignore                             # node_modules, .wrangler/, .dev.vars
```

## Privacy & retention

- **JWT verification:** the Worker validates Google ID tokens cryptographically against Google's JWKS (`oauth2/v3/certs`) — no dependency on the `tokeninfo` debug endpoint.
- **IP truncation:** stored IPs are truncated to `/24` (IPv4) or the first 4 hextets (IPv6). City-level geolocation is preserved; precise host identification is not. Applies to both the Worker and the local Node server.
- **Per-user dedupe:** the same `google_sub` recorded within a 24h window is collapsed to a single row. Closes JWT-replay and limits table bloat from repeat visitors.
- **Retention:** rows older than 12 months are auto-deleted by a Cloudflare cron trigger that runs at `02:00 UTC` on the 1st of each month. Configured in `wrangler.toml` (`[triggers] crons`); handler is the `scheduled()` export in `src/index.js`. Adjust the cutoff via `RETENTION_SECONDS` in `src/index.js`.
- **Erasure requests:** to remove a lead manually, run e.g. `npx wrangler d1 execute resume-leads --remote --command="DELETE FROM resume_downloads WHERE email = 'x@y.com'"`.

## Secret rotation

To rotate `ADMIN_TOKEN`:

```bash
wrangler secret put ADMIN_TOKEN
# paste the new token; old one is invalidated on next deploy
wrangler deploy
```

Tokens are stored in Cloudflare's secret store (not in `wrangler.toml`).
