---
name: refresh-post-metrics
description: Trigger Pulse ad-hoc to scrape LinkedIn post engagement → D1 (updates the live site's Perspectives chips). No email. Examples - "refresh post metrics", "update engagement counts", "sync LinkedIn stats".
context: fork
disable-model-invocation: true
allowed-tools: Bash
---

> Forked from `.claude/commands/refresh-post-metrics.md`

Run the **Pulse** ambient-metrics job on demand. This scrapes current
LinkedIn engagement counts (hearts / comments / shares) for every post in
`content/posts.json` and writes them to the D1 `post_metrics` table, which
the live site reads via `GET /api/post-metrics`. **No LLM, no email** — this
is the `POST /api/ambient/metrics` route (`agents/pulse/app/api.py`).

It normally runs every 2 days via the `portfolio-ambient-metrics` Cloud
Scheduler job. This command fires that same job *now* by forcing it to run,
so the existing URI + `AMBIENT_TRIGGER_TOKEN` are reused — no secret handling.

## Step 1 — Preconditions

- Confirm `gcloud` is authenticated: `gcloud config get-value account`.
  If empty, tell the user to run `! gcloud auth login` and stop.
- The job lives in **`us-central1`** (project default). Service: `pulse`
  (Cloud Run, `min-instances=0`, so expect a cold start).

## Step 2 — Trigger the job

```
gcloud scheduler jobs run portfolio-ambient-metrics --location=us-central1
```

Exit 0 means the trigger was accepted (Cloud Scheduler fires the HTTP call
asynchronously). A non-zero exit → print stderr and stop.

## Step 3 — Verify it actually ran

Pulse cold-starts, then scrapes (LinkedIn fetch can take 30–90s). Poll the
Cloud Run logs in the **background** until the request lands — do NOT chain
foreground `sleep`. Use a `run_in_background` Bash poll like:

```
for i in $(seq 1 30); do
  hit=$(gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="pulse" AND httpRequest.requestUrl:"/api/ambient/metrics"' \
        --limit=3 --freshness=20m \
        --format="value(timestamp, httpRequest.status)" 2>/dev/null)
  if [ -n "$hit" ]; then echo "$hit"; break; fi
  sleep 6
done
```

A `200` status = success. A `401` = token mismatch (the scheduler header
drifted from the secret). A `5xx` = scrape failed — pull app logs:
`gcloud logging read '... service_name="pulse"' --limit=20 --freshness=20m --format="value(textPayload)"`
and surface the error line.

## Step 4 — Confirm the data moved (optional but preferred)

Read the public endpoint. **It is the Cloudflare Worker, NOT the Pages
domain** — use `profile.links.metricsApi` from `content/profile.json`
(currently `https://gaurav-portfolio-resume-gate.gaurav-lahoti25.workers.dev/api/post-metrics`).
The Pages host (`gauravlahoti.dev/api/...`) 404s — there is no `/api` there.

```
curl -fsS "$(python3 -c 'import json;print(json.load(open("content/profile.json"))["links"]["metricsApi"])')" | python3 -m json.tool | head -40
```

The shape is `{"ok": true, "metrics": { "<post-urn>": {reactions, comments,
reposts, fetchedAt}, ... }}`. Report the row count and confirm every row's
`fetchedAt` (Unix epoch) is within the last few minutes — that proves the
scrape just wrote, not stale data.

## Step 5 — Report

```
✓ Post metrics refreshed.

  Job:   portfolio-ambient-metrics (us-central1)
  Status: <200 / error>
  Live:  https://gauravlahoti.dev/  (Perspectives chips; hard-refresh)
```

The site fetches `post-metrics` live — no rebuild or `/publish` needed; a
hard refresh shows the new counts.

## Notes

- This does **not** send any email. For the full digest cycle (visitor
  stats + leads + dashboard email) use `/run-ambient-digest`.
- If `gcloud scheduler jobs run` ever stops being the right trigger (job
  renamed/removed), the fallback is a direct `POST` to the Pulse URL with
  the `x-internal-token` header — but prefer the job so the token stays out
  of the shell.
