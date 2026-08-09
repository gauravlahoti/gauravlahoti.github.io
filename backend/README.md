# Resume Gate Backend

⚠️ **The resume-download gate itself was retired 2026-06-10** (the site links
straight to `/resume.pdf` now — see `.claude/docs/backend.md`). This folder
kept the name because it grew into the site's general-purpose backend: the
agent audit log, resume/note send-and-rate-limit endpoints, analytics beacon,
LinkedIn post metrics, and GCP cost alerts all live here too.
`resume_downloads` stays read-only for its historical leads (2026-05 → 06);
nothing writes to it anymore.

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
`schema.sql`.

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
| `ADMIN_TOKEN` | unset | enables `GET /api/leads` if set |

## Cloudflare deploy (future)

Skip this section while you're running locally. When you're ready to
go serverless, deploy `src/index.js` to Cloudflare.

### Cloudflare D1

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

## Endpoints

- `GET /api/leads` — admin dump of historical `resume_downloads` rows (last
  200). Requires `Authorization: Bearer $ADMIN_TOKEN`. Read-only: nothing
  writes new rows to this table anymore (the gate that wrote it was retired
  2026-06-10).

This is a small slice — see `.claude/docs/backend.md` for the full endpoint
list (agent audit log, resume/note send + rate limits, analytics beacon, post
metrics, GCP cost alerts), which this README doesn't attempt to duplicate.

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

## Layout

```
backend/
├── wrangler.toml                          # Worker config + D1 binding + cron
├── src/index.js                           # Router, admin GET, cron handler, and every other endpoint
├── schema.sql                             # CREATE TABLE for fresh installs
├── migrations/001-add-google-fields.sql   # v1 (spec 11) → v2 (spec 12) migration
├── migrations/002-agent-interactions.sql  # spec 23 — adds agent_interactions table
├── README.md                              # this file
└── .gitignore                             # node_modules, .wrangler/, .dev.vars
```

## Privacy & retention

- **IP truncation:** stored IPs are truncated to `/24` (IPv4) or the first 4 hextets (IPv6). City-level geolocation is preserved; precise host identification is not. Applies to both the Worker and the local Node server.
- **Retention:** `resume_downloads` is deliberately **exempt** from the monthly cron — its write path (the gate) was retired 2026-06-10, so it's a finite historical dataset now, not one that needs ongoing purging. Every other table's retention window is documented in `.claude/docs/backend.md`. Handler is the `scheduled()` export in `src/index.js`.
- **Erasure requests:** to remove a lead manually, run e.g. `npx wrangler d1 execute resume-leads --remote --command="DELETE FROM resume_downloads WHERE email = 'x@y.com'"`.

## Agent audit log (Spec #23)

Every question asked in the "Ask my agent" widget is logged to a second table, `agent_interactions`, in the same D1 database. The Cloud Run agent calls `POST /api/agent-log` with a shared token after each turn. Gaurav can review correctness over time and identify question patterns to tune the corpus.

### Endpoints

- `POST /api/agent-log` — write endpoint for the Cloud Run agent (not the browser). `X-Internal-Token: <AGENT_LOG_TOKEN>`. Returns `{ok: true, id}`.
- `GET /api/agent-log` — admin dump (last 200 rows). `Authorization: Bearer $ADMIN_TOKEN` (same token as `/api/leads`).

### Local queries

```bash
# Quick view via npm script
npm run agent-log

# Or interactively
sqlite3 backend/leads.db
sqlite> SELECT session_id, turn_index, datetime(logged_at,'unixepoch') AS at,
               status, question, response
        FROM agent_interactions ORDER BY logged_at DESC LIMIT 20;

# Join to see who downloaded the resume AND asked questions. Only ever
# matches identities from before 2026-06-10 — both sides of this join
# (the gate's identity persistence and resume_downloads itself) stopped
# being written on that date, so it will never match a new row again.
sqlite> SELECT ai.session_id, ai.question, rd.email, datetime(ai.logged_at,'unixepoch') AS at
        FROM agent_interactions ai
        LEFT JOIN resume_downloads rd ON ai.google_sub = rd.google_sub
        ORDER BY ai.logged_at DESC LIMIT 20;
```

### Secrets

| Secret | Where set | Purpose |
|---|---|---|
| `AGENT_LOG_TOKEN` | `wrangler secret put AGENT_LOG_TOKEN` | Shared token between Cloud Run and this Worker. Without it, `/api/agent-log` returns 503. |

The token is also set on the Cloud Run service via Secret Manager → `--secrets AGENT_LOG_TOKEN=agent-log-token`. Both sides must match.

### Privacy & retention

- **Retention:** see `.claude/docs/backend.md` for the current cutoffs — they've changed since this section was first written and are tracked there, not duplicated here.
- **Identity:** `google_sub` and `email` were populated only when the visitor had signed in for the resume gate — since that gate was retired 2026-06-10 and nothing else sets this browser-side identity, both columns are `NULL` on every row going forward. Historical rows from before that date may still have them.
- **IP truncation:** same `/24` (IPv4) or `/64` (IPv6) rule as `resume_downloads`.
- **No local cron:** retention cleanup only runs in production (Cloudflare cron trigger). Delete rows manually if needed: `wrangler d1 execute resume-leads --remote --command="DELETE FROM agent_interactions WHERE google_sub = 'xxx'"`.

## Secret rotation

To rotate `ADMIN_TOKEN`:

```bash
wrangler secret put ADMIN_TOKEN
# paste the new token; old one is invalidated on next deploy
wrangler deploy
```

To rotate `AGENT_LOG_TOKEN`:

```bash
wrangler secret put AGENT_LOG_TOKEN          # update the Worker secret
# then update the Cloud Run service:
gcloud secrets versions add agent-log-token --data-file=-   # paste new token
gcloud run services update portfolio-agent --region=us-central1 \
  --update-secrets=AGENT_LOG_TOKEN=agent-log-token:latest
```

Tokens are stored in Cloudflare's secret store (not in `wrangler.toml`).

## Agent audit log — Spec #24 meta-block columns

Three nullable columns were added to `agent_interactions` in Spec #24 to capture the meta-block parsed server-side from each agent reply:

| Column | Type | Content |
|---|---|---|
| `citations_count` | INTEGER | Number of citation entries emitted (0 if none) |
| `suggestions_count` | INTEGER | Number of follow-up chip suggestions (2–3 for normal turns) |
| `cta` | TEXT | `'topmate'`, `'linkedin'`, or NULL |

Run the production migration once:

```bash
wrangler d1 execute resume-leads --file=backend/migrations/003-agent-meta.sql --remote
```

Sample analytics query — personal-punt rate and follow-up coverage:

```sql
SELECT
    DATE(logged_at, 'unixepoch') AS day,
    COUNT(*) AS turns,
    SUM(CASE WHEN cta = 'topmate' THEN 1 ELSE 0 END) AS topmate_punts,
    AVG(suggestions_count) AS avg_suggestions,
    AVG(citations_count) AS avg_citations
FROM agent_interactions
WHERE status = 'ok'
GROUP BY day
ORDER BY day DESC
LIMIT 30;
```
