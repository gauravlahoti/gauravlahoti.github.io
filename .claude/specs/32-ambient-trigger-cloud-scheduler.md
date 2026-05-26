# 32 — Ambient trigger: Cloud Scheduler (supersedes the Claude-scheduler trigger in Spec 31)

## Overview

Spec 31 shipped the ambient agent on Cloud Run, triggered twice weekly by a **Claude scheduler** POSTing to
`/api/ambient/run`. In practice the Claude routine could not reach the Cloud Run host: remote routines run in a
sandboxed environment whose *Trusted network access* policy allows only package registries and cloud-provider
APIs, so the `curl` failed with `host_not_allowed`. The custom Cloud Run domain is only allowlistable through the
claude.ai environment UI — not via the routine API — which is brittle and invisible to this repo.

This spec records the switch of the **trigger** to **Google Cloud Scheduler**. Nothing else from Spec 31 changes:
the autonomous ADK `ambient_agent`, its five tools, the Worker's three D1 endpoints, and the two-token security
model all stand. Only the thing that fires `POST /api/ambient/run` is different.

## What changed

- **Trigger:** Google Cloud Scheduler job `portfolio-ambient-agent` (region `us-central1`), replacing the Claude
  scheduler routine. Schedule `0 8 * * 1,4`, time zone `Asia/Kolkata` (Mon + Thu 08:00 IST). It does an HTTP
  `POST` to `https://portfolio-agent-593919045544.us-central1.run.app/api/ambient/run` with header
  `x-internal-token: <AMBIENT_TRIGGER_TOKEN>` and `Content-Type: application/json`. `attempt-deadline=300s`.
- **API enabled:** `cloudscheduler.googleapis.com` on `gcp-experiments-490306`.
- **Secret:** `AMBIENT_TRIGGER_TOKEN` lives in Secret Manager (`ambient-trigger-token`) and is mounted on the
  Cloud Run service; the Cloud Run compute SA was granted `roles/secretmanager.secretAccessor` on it. The token
  value sits in the scheduler job's header config (GCP-internal), never in any Claude prompt.
- **Removed:** the Claude `RemoteTrigger` routine and the session `CronCreate` job from Spec 31.

## Why Cloud Scheduler over the Claude scheduler

- Runs entirely inside GCP → Cloud Run; no sandbox network policy, no host allowlist to maintain.
- Never expires (Claude routines auto-expire ~7 days and need re-arming).
- Configurable and inspectable from `gcloud`/this repo, not a web UI.
- It is the idiomatic ADK production trigger (Cloud Scheduler → Cloud Run), the doc-native alternative Spec 31
  noted but deferred. The only reason Spec 31 chose the Claude scheduler — mirroring the GCP cost-monitor pattern —
  is moot here because that pattern hits allowlisted Google APIs, whereas this hits a custom Cloud Run host.

## Bug fixed alongside (PR #60)

The first live runs returned `emails_sent:0` despite the agent calling `send_digest_email`: the Resend MCP
`send-email` tool requires a `text` part, but `ambient_send._send_to_gaurav` sent only `html`, so every send was
rejected with `-32602` (`text: expected string, received undefined`). Fix: derive a plain-text fallback from the
model-authored HTML (`_html_to_text`) and include it as the `text` part, matching `note_send.py`. A regression
test asserts the `text` part is present, non-empty, and tag-free.

## Definition of done

- [x] Cloud Scheduler job `portfolio-ambient-agent` exists, `ENABLED`, `0 8 * * 1,4` `Asia/Kolkata`.
- [x] A manual `gcloud scheduler jobs run` produces `POST /api/ambient/run → 200` in Cloud Run logs.
- [x] `POST /api/ambient/run` returns `{ok:true, interactions_seen, leads_processed, emails_sent}`; with real
  data `emails_sent:1` (digest delivered).
- [x] Lead-drafts path verified by seeding a >24h-old un-contacted `resume_downloads` row: run reports
  `leads_processed:1`, a re-run reports `leads_processed:0` (idempotent); test row cleaned up.
- [x] Claude routine + session cron removed.

## Operate

```bash
# Inspect / run now / pause
gcloud scheduler jobs describe portfolio-ambient-agent --location us-central1 --project gcp-experiments-490306
gcloud scheduler jobs run     portfolio-ambient-agent --location us-central1 --project gcp-experiments-490306
gcloud scheduler jobs pause   portfolio-ambient-agent --location us-central1 --project gcp-experiments-490306

# Rotate the trigger token: add a new secret version, then update the job header.
echo -n "$(openssl rand -hex 32)" | gcloud secrets versions add ambient-trigger-token --data-file=- --project gcp-experiments-490306
gcloud run services update portfolio-agent --region us-central1 --project gcp-experiments-490306 \
  --update-secrets=AMBIENT_TRIGGER_TOKEN=ambient-trigger-token:latest
gcloud scheduler jobs update http portfolio-ambient-agent --location us-central1 --project gcp-experiments-490306 \
  --update-headers="x-internal-token=<new-value>"
```
