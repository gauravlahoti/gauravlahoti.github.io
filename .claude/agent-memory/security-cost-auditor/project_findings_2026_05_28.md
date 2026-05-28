---
name: project-findings-2026-05-28
description: Security and cost audit findings from full codebase sweep on 2026-05-28
metadata:
  type: project
---

Full audit completed 2026-05-28. Key findings:

**HIGH — Resend MCP server has no caller authentication:**
- resend_mcp_server/server.js: deployed --allow-unauthenticated, no X-Internal-Token or bearer check for callers
- Any attacker who discovers the URL can send unlimited emails at Resend account cost
- URL is exposed in portfolio-agent/.env.example (committed to git)
- Fix: add bearer token gate to proxy layer

**HIGH — portfolio-agent/ and resend_mcp_server/ are NOT excluded from GitHub Pages deploy:**
- .github/workflows/deploy.yml rsync does NOT exclude these dirs
- Source code, .env.example (with placeholder tokens + real URLs), Dockerfile, Makefile, corpus JSON all deployed to gauravlahoti.github.io
- Fix: add --exclude='portfolio-agent' --exclude='resend_mcp_server' to rsync in deploy.yml

**MEDIUM — post-metrics.json is not gitignored:**
- assets/js/data/post-metrics.json appears as untracked (??) in git status
- No gitignore entry for it; could be accidentally committed with raw engagement data
- Fix: add post-metrics.json to .gitignore

**MEDIUM — Token comparison not timing-safe:**
- backend/src/index.js lines 306, 493, 609, 1009: uses string === for bearer/X-Internal-Token comparison
- In Cloudflare Workers crypto.subtle.timingSafeEqual exists but isn't used
- Low real-world risk (tokens are long random secrets), but a hardening gap

**MEDIUM — X-Forwarded-For trusted without validation in rate limiter:**
- portfolio-agent/app/api.py line 80: takes first entry of X-Forwarded-For as client IP
- Cloud Run's load balancer appends the real client IP; first-entry approach could be spoofed
- Should use last entry or trust GCP-specific headers

**LOW — Google Client ID hardcoded in local-server.js:**
- backend/local-server.js line 23: fallback hardcode of real OAuth client ID
- Google OAuth client IDs are considered public (they're in HTML/JS), not secret
- But any developer who clones the repo and runs local server gets a real client ID without thinking

**MEDIUM — GCP project IDs and BQ table names in wrangler.toml [vars] (committed):**
- wrangler.toml lines 31-32: GCP project ID and BQ table name are non-secret config
- GCP_SA_KEY_JSON is correctly a Wrangler secret, not committed

**CLEAN AREAS verified:**
- All D1/SQLite queries use parameterized .bind() — no SQL injection
- JWT verification (jose) correct: JWKS, audience, issuer, maxTokenAge, clockTolerance, email_verified
- CSP is well-formed: no unsafe-eval, connect-src limited to specific hosts
- [[META]] injection defense: before_model_callback strips sentinels; server uses rfind last-wins
- Citation host allowlist enforced server-side in api.py _parse_meta and guardrails.py
- CORS: origin allowlist, no wildcard, reflected-origin pattern
- Rate limiter: 4/24h per session AND per IP-hash; IP check is the ceiling
- leads.db gitignored; .env gitignored; secrets properly in Wrangler secrets

**Why:** Documents findings for future incremental audits.
**How to apply:** Check these specific areas first in future audits; don't re-flag known-clean patterns.
