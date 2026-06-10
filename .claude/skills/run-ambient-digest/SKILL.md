---
name: run-ambient-digest
description: Run the full Pulse ambient cycle ad-hoc — visitor stats + leads + one dashboard email to Gaurav. Sends email. Examples - "run the digest", "trigger ambient agent", "send the weekly summary now".
context: fork
disable-model-invocation: true
allowed-tools: Bash, AskUserQuestion
---

> Forked from `.claude/commands/run-ambient-digest.md`

Run the **Pulse** full ambient digest on demand. This is the `POST
/api/ambient/run` route (`agents/pulse/app/api.py`): the agent reasons over
recent visitor stats + agent interactions, drafts any pending leads, and
sends **one dashboard email** via the Resend MCP. **This sends a real
email** — it is the heavier, twice-weekly cycle, not the metrics scrape.

> For just refreshing the LinkedIn engagement counts on the site (no email,
> no LLM), use `/refresh-post-metrics` instead.

It normally runs Mon/Thu 08:00 IST via the `portfolio-ambient-agent` Cloud
Scheduler job. This command forces that same job to run *now*, reusing its
URI + `AMBIENT_TRIGGER_TOKEN` (no secret handling).

## Step 1 — Confirm intent (it emails)

Because this sends an email to Gaurav, confirm with the user before firing
unless they were explicit ("run the digest now"). State plainly: "This will
run the full cycle and send one dashboard email. Proceed?"

## Step 2 — Preconditions

- `gcloud` authenticated: `gcloud config get-value account`. If empty, tell
  the user to run `! gcloud auth login` and stop.
- Job is in **`us-central1`**. Service: `pulse` (Cloud Run, cold start
  likely). The cycle is LLM-driven, so it can take 1–3 minutes.

## Step 3 — Trigger

```
gcloud scheduler jobs run portfolio-ambient-agent --location=us-central1
```

Exit 0 = accepted (async). Non-zero → print stderr and stop.

## Step 4 — Verify it ran

Poll Cloud Run logs in the **background** (no foreground `sleep`-chaining)
until the request lands — the LLM cycle is slow, so allow up to ~3 min:

```
for i in $(seq 1 40); do
  hit=$(gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="pulse" AND httpRequest.requestUrl:"/api/ambient/run"' \
        --limit=3 --freshness=20m \
        --format="value(timestamp, httpRequest.status)" 2>/dev/null)
  if [ -n "$hit" ]; then echo "$hit"; break; fi
  sleep 8
done
```

A `200` returns count-only telemetry: `{ok, interactions_seen,
leads_processed, emails_sent}`. Pull the JSON body from the app logs to show
the user those counts. `401` = token drift; `5xx` = cycle failed — surface
the `[ambient] anomaly` / exception line from:
`gcloud logging read '... service_name="pulse"' --limit=30 --freshness=20m --format="value(textPayload)"`.

## Step 5 — Report

```
✓ Ambient digest run complete.

  Job:    portfolio-ambient-agent (us-central1)
  Status: <200 / error>
  Seen:   <interactions_seen> interactions, <leads_processed> leads
  Email:  <emails_sent> sent  →  check Gaurav's inbox
```

## Notes

- `emails_sent: 0` is normal when there's nothing worth surfacing — the
  agent is designed to stay quiet below threshold.
- Watch for the `[ambient] anomaly` warning in logs (leads fetched but never
  drafted, or MAX_TOKENS truncation) — report it if present.
