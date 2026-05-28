# Resend MCP Server

A standalone MCP (Model Context Protocol) server for email functionality via [Resend](https://resend.com), deployed on Google Cloud Run.

This server exposes the Resend email API as an MCP endpoint that agents can connect to via Streamable HTTP transport.

---

## Features

- Send emails via Resend API
- Streamable HTTP transport for MCP
- Caller authentication gate (`MCP_CALLER_TOKEN`) — unauthenticated requests get 401
- Server-side Resend API key injection — callers never carry Resend credentials
- Deployable on Cloud Run (cpu-boost + gen2 for fast cold starts)
- Reusable by multiple agents (chat agent, ambient agent)

---

## Architecture

```
Client (Agent)
    │
    │ Authorization: Bearer <MCP_CALLER_TOKEN>
    ▼
Cloud Run (server.js - proxy)
    │
    │  ✓ validates MCP_CALLER_TOKEN
    │  ✓ swaps in RESEND_API_KEY before forwarding
    │
    │ Authorization: Bearer <RESEND_API_KEY>  (injected server-side)
    ▼
Internal resend-mcp server (port 3001)
    │
    ▼
Resend API
```

The proxy does two things: (1) gates callers with `MCP_CALLER_TOKEN`, and (2) rewrites the `Authorization` header to the `RESEND_API_KEY` before forwarding to the internal process. Agents hold `MCP_CALLER_TOKEN` only — the Resend key never leaves the server.

---

## Prerequisites

- [Resend](https://resend.com) account and verified domain
- Google Cloud project with Cloud Run and Secret Manager enabled
- `gcloud` CLI installed and configured

---

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Run locally

```bash
npm run dev
```

Server will be available at `http://localhost:3000/mcp`. In local dev `MCP_CALLER_TOKEN` is unset, so the auth gate is disabled — all requests pass through.

### 3. Test with MCP Inspector

1. Run: `npx @modelcontextprotocol/inspector`
2. Transport: **Streamable HTTP**
3. URL: `http://127.0.0.1:3000/mcp`
4. Add header: `Authorization: Bearer <your-resend-api-key>`
5. Click Connect

---

## Deploy to Cloud Run

### 1. Create secrets in Secret Manager (one-time)

```bash
# Resend API key
echo -n "re_xxxxxxxxxxxx" | gcloud secrets create resend-api-key \
  --data-file=- --project=gcp-experiments-490306

# Caller auth token (generate a random 32-byte hex string)
echo -n "$(openssl rand -hex 32)" | gcloud secrets create resend-mcp-caller-token \
  --data-file=- --project=gcp-experiments-490306

# Grant Cloud Run's default SA access to both secrets
SA="593919045544-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding resend-api-key \
  --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding resend-mcp-caller-token \
  --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
```

### 2. Deploy

```bash
make deploy
```

This runs:

```bash
gcloud run deploy resend-mcp-server \
  --source . \
  --project=gcp-experiments-490306 \
  --region=us-central1 \
  --allow-unauthenticated \
  --cpu-throttling \
  --cpu-boost \
  --execution-environment gen2 \
  --concurrency 20 \
  --min-instances 0 \
  --update-secrets RESEND_API_KEY=resend-api-key:latest \
  --update-secrets MCP_CALLER_TOKEN=resend-mcp-caller-token:latest
```

**Flag notes:**
- `--allow-unauthenticated` — Cloud Run IAM is open; `MCP_CALLER_TOKEN` is the auth gate at the app level
- `--cpu-throttling` + `--cpu-boost` — request-based billing with faster cold starts (free)
- `--execution-environment gen2` — newer, faster Cloud Run runtime
- `--concurrency 20` — conservative; one `resend-mcp` child process per instance
- `--min-instances 0` — scale to zero when idle

### 3. Get the service URL

```
https://resend-mcp-server-593919045544.us-central1.run.app/mcp
```

---

## Using with Agents

Add to your agent's `.env`:

```bash
RESEND_MCP_URL=https://resend-mcp-server-593919045544.us-central1.run.app/mcp
MCP_CALLER_TOKEN=<the value from resend-mcp-caller-token secret>
```

The portfolio agent reads both and calls via `streamablehttp_client`:

```python
caller_token = os.environ.get("MCP_CALLER_TOKEN", "")
mcp_headers = {"Authorization": f"Bearer {caller_token}"} if caller_token else {}

async with streamablehttp_client(mcp_url, headers=mcp_headers) as (read, write, _):
    async with ClientSession(read, write) as session:
        await session.initialize()
        result = await session.call_tool("send-email", arguments)
```

---

## MCP Tools Exposed

| Tool | Description |
|------|-------------|
| `send-email` | Send an email via Resend |

---

## Secret Rotation

To rotate `MCP_CALLER_TOKEN`:

```bash
# 1. Add a new version to Secret Manager
echo -n "$(openssl rand -hex 32)" | gcloud secrets versions add resend-mcp-caller-token --data-file=-

# 2. Redeploy the MCP server (picks up :latest)
make deploy

# 3. Update the portfolio-agent service
gcloud run services update portfolio-agent \
  --update-secrets MCP_CALLER_TOKEN=resend-mcp-caller-token:latest \
  --region=us-central1 --project=gcp-experiments-490306
```

---

## Undeploy

```bash
gcloud run services delete resend-mcp-server \
  --project=gcp-experiments-490306 \
  --region=us-central1 \
  --quiet
```

---

## Security

- **Caller auth gate:** every inbound request must carry `Authorization: Bearer <MCP_CALLER_TOKEN>`. Requests without the correct token get `401 Unauthorized` before any proxying occurs.
- **Secret isolation:** `RESEND_API_KEY` lives only on the Cloud Run service via Secret Manager. The portfolio agent holds `MCP_CALLER_TOKEN` only — it never sees the Resend key.
- **No rate limiting:** Resend's own per-day send limits apply. Rotate `MCP_CALLER_TOKEN` immediately if it is ever exposed.
- **Verified domain required:** Resend's free tier with `onboarding@resend.dev` only sends to your registered email. To send to arbitrary recipients, [verify a custom domain](https://resend.com/domains).
