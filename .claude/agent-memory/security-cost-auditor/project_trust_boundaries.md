---
name: project-trust-boundaries
description: Confirmed trust boundaries for all endpoints — which are public, which are bearer-gated, which are internal-token-gated
metadata:
  type: project
---

Confirmed endpoint trust model as of 2026-05-28 full audit:

**Cloudflare Worker (backend/src/index.js) — publicly reachable:**
- `POST /api/resume-download` — CORS-gated to ALLOWED_ORIGINS; requires Google ID token (jose JWKS verify)
- `POST /api/pageview` — CORS-gated to ALLOWED_ORIGINS; public beacon, no auth; writes page_views row
- `GET /api/agent-stats` — public, no auth; 1h CDN cache; returns total_conversations count only
- `GET /api/post-metrics` — public, CORS-gated; 1h CDN cache; returns engagement counts

**Worker — gated by ADMIN_TOKEN (Authorization: Bearer):**
- `GET /api/leads` — admin dump of resume_downloads
- `GET /api/agent-log` — admin dump of agent_interactions (same ADMIN_TOKEN)

**Worker — gated by AGENT_LOG_TOKEN (X-Internal-Token header):**
- `POST /api/agent-log` — written by Cloud Run agent after each turn
- `POST /api/resume-send-check` — rate-limit check before Resend send
- `POST /api/resume-send-record` — record successful send
- `POST /api/post-metrics` — write LinkedIn engagement counts from Cloud Run
- `GET /api/ambient/interactions` — recent agent turns for ambient digest
- `GET /api/ambient/leads` — pending follow-up leads
- `POST /api/ambient/leads/mark` — stamp followup_sent_at
- `GET /api/ambient/stats` — pre-aggregated stats for weekly digest

**Worker — gated by COST_MONITOR_TOKEN (Authorization: Bearer):**
- `GET /api/gcp-cost` — BigQuery billing data
- `POST /api/gcp-cost-send` — send cost email via Resend

**Cloud Run agent (portfolio-agent/app/api.py):**
- `POST /api/agent-chat` — public, --allow-unauthenticated; rate-limited 4/24h per session+IP
- `GET /api/agent-chat/warm` — public warm-up ping
- `GET /healthz` — public health probe
- `POST /api/ambient/run` — gated by AMBIENT_TRIGGER_TOKEN (X-Internal-Token); triggers LLM+email cycle
- `POST /api/ambient/metrics` — gated by AMBIENT_TRIGGER_TOKEN; LinkedIn scrape only, no LLM

**Resend MCP Server (resend_mcp_server/server.js):**
- `POST /mcp` — --allow-unauthenticated on Cloud Run; NO caller auth gate; auto-injects RESEND_API_KEY

**Why:** Establishes baseline for future audits — what's intentionally public vs protected.
**How to apply:** Use this to quickly assess whether a new endpoint is correctly gated before flagging false positives.
