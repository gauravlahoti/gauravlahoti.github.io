---
name: cost-optimizer
description: Scan the Google Cloud billing account behind this site for cost leaks, compare spend with the free tiers, and recommend fixes. `--setup` installs the budget and the always-on alert. Read-only until you approve each change. Examples - "run the cost optimizer", "why is my GCP bill up", "check for cost leaks", "/cost-optimizer --setup".
context: fork
allowed-tools: Bash, AskUserQuestion
---

Scan Gaurav's Google Cloud spend and find what to cut (spec 83). Everything is
**read-only** until step 6, and every change there is approved one item at a
time. Prefer reversible fixes (pause, disable, min-instances 0). Never delete
on your own initiative.

**Cadence:** monthly, in the first days after the invoice closes (Pulse's first
email of the month nudges this), and after any new service, test deployment or
teardown. Leaks come from deployments, not from drift: the 2026-09 `intake`
test (min-instances=1 and an every-minute scheduler, both left on) cost about
₹32/day for 11 days.

**Scope:** billing account `Gaurav_billing` (`014177-2DE01D-E2374B`), project
`gcp-experiments-490306`. `adk-deploy-trail` and `confident-melody-k5bll` are
billed to accounts this login can't read; mention them in the report and say
they weren't scanned.

## Known intentional (never recommend removing)

| Item | Why |
|---|---|
| `atlas` min-instances=1 (~₹28/day) | No cold starts for visitors, and the avatar's in-memory daily spend cap depends on the instance staying up. See memory `atlas-min-instances-1`. |
| Secrets `GEMINI_API_KEY`, `google-ai-api-key` | Bound to an off-repo project (Verity). |
| Scheduler jobs `portfolio-ambient-agent`, `portfolio-ambient-metrics` | Pulse's digest and LinkedIn metrics. |
| `cloud-run-source-deploy` cleanup policy (keep 2, untagged after 3 days) | Already right; a recent burst of deploys shrinks on its own. |

## 1. Discover

```bash
A=014177-2DE01D-E2374B; P=gcp-experiments-490306
gcloud billing accounts list --filter=open=true --format='table(name.basename(),displayName)'
gcloud billing projects list --billing-account=$A --format='value(projectId,billingEnabled)'
gcloud billing budgets list --billing-account=$A --format=json
```

Note each budget's amount, its thresholds and whether any threshold uses
`FORECASTED_SPEND`. Without one, a leak only alerts after the money is spent.

## 2. Cost

Real numbers come from the BigQuery billing export,
`gcp-experiments-490306.billing_data.gcp_billing_export_v1_014177_2DE01D_E2374B`.
Net cost = `cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)`.
Google's billing day is Pacific time.

```bash
T='gcp-experiments-490306.billing_data.gcp_billing_export_v1_014177_2DE01D_E2374B'
NET="cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)"
DAY="DATE(usage_start_time, 'America/Los_Angeles')"
bq query --use_legacy_sql=false --project_id=$P "
  SELECT project.id, service.description AS service,
    ROUND(SUM(IF($DAY >= DATE_TRUNC(CURRENT_DATE('America/Los_Angeles'), MONTH), $NET, 0)), 2) AS mtd,
    ROUND(SUM(IF($DAY >= DATE_SUB(CURRENT_DATE('America/Los_Angeles'), INTERVAL 7 DAY), $NET, 0)), 2) AS last_7d,
    ROUND(SUM(IF($DAY <  DATE_SUB(CURRENT_DATE('America/Los_Angeles'), INTERVAL 7 DAY), $NET, 0)), 2) AS prior_7d
  FROM \`$T\` WHERE $DAY >= DATE_SUB(CURRENT_DATE('America/Los_Angeles'), INTERVAL 40 DAY)
  GROUP BY 1, 2 HAVING mtd > 0.01 OR last_7d > 0.01 ORDER BY mtd DESC"
```

Then the daily series for the top 3 services (`GROUP BY day, service`), to see
*when* something stepped up. Flag a service that is up more than 50% week over
week **and** runs above ~₹100/month (`last_7d / 7 * 30`). Match a step-up date
to deployments (`gcloud run revisions list`, `git log --since`).

**If the export table is missing or more than 3 days stale**, say so plainly
and fall back to pricing usage metrics (label it "estimate"):
- Cloud Run: daily `run.googleapis.com/container/billable_instance_time` per
  service (ALIGN_SUM, 86400s, grouped by `resource.label.service_name`) via
  the Monitoring REST API. Price idle time at about $0.0000025/vCPU-s plus
  $0.0000025/GiB-s (us-central1, request-based billing). One always-on
  1 vCPU / 512 MiB instance comes to about $0.32/day (~₹28).
- Enabling the export is a one-time Console step: Billing → Gaurav_billing →
  Billing export → Standard usage cost → project `gcp-experiments-490306`,
  dataset `billing_data`. There is no gcloud or API for it.

## 3. Leak scan (read-only)

Run per project. Each line is a known way this account has leaked before, or a
standard one.

```bash
# Cloud Run: always-on instances, always-on CPU, recent services
for s in $(gcloud run services list --project $P --format='value(metadata.name)'); do
  gcloud run services describe $s --region us-central1 --project $P --format=json | python3 -c "
import json,sys;d=json.load(sys.stdin);a=d['spec']['template']['metadata'].get('annotations',{})
print(d['metadata']['name'],'min=',a.get('autoscaling.knative.dev/minScale','0'),
      'cpu-throttling=',a.get('run.googleapis.com/cpu-throttling','true'),
      'created=',d['metadata']['creationTimestamp'][:10])"; done
# Scheduler: anything every <=5 min, or named test/tmp/smoke
gcloud scheduler jobs list --location us-central1 --project $P --format='table(name.basename(),schedule,state,httpTarget.uri)'
# Artifact Registry: size vs 0.5 GB free, and the cleanup policy
gcloud artifacts repositories list --project $P --format='table(name.basename(),location,sizeBytes)'
# Secret Manager: enabled versions (6 free per account), and which service mounts each
for s in $(gcloud secrets list --project $P --format='value(name)'); do
  echo "$s $(gcloud secrets versions list $s --project $P --filter=state=ENABLED --format='value(name)' | wc -l)"; done
# Compute: VMs, unattached disks, idle static IPs
gcloud compute instances list --project $P; gcloud compute disks list --project $P --filter='-users:*'
gcloud compute addresses list --project $P --filter='status=RESERVED'
# Vertex AI: deployed endpoints bill per hour even when idle
gcloud ai endpoints list --project $P --region us-central1 2>/dev/null
# Document AI processors (the 2026-06 leak), Cloud SQL, GKE
gcloud sql instances list --project $P 2>/dev/null; gcloud container clusters list --project $P 2>/dev/null
# Buckets without lifecycle rules
for b in $(gcloud storage buckets list --project $P --format='value(name)'); do
  echo "$b lifecycle=$(gcloud storage buckets describe gs://$b --format='value(lifecycle_config)' | head -c 40)"; done
```

A secret is "unused" only if no Cloud Run service mounts it **and** `git grep`
finds no reference. Even then, recommend *disabling* its versions (reversible),
not deleting.

## 4. Free-tier check

Compare the month's usage with the free tiers and say which ones are exceeded:
- Cloud Run: 180k vCPU-s, 360k GiB-s, 2M requests per month (request-based
  billing).
- Artifact Registry: 0.5 GB.
- Secret Manager: 6 active versions, 10k access operations.
- Cloud Scheduler: 3 jobs.
- Cloud Logging: 50 GiB ingestion.

An always-on instance always exceeds the Cloud Run free tier; that's expected
for atlas.

## 5. Report

One table, most expensive first, leaving out the known-intentional items:

| Finding | ₹/month (est.) | Recommendation | Reversible? |
|---|---|---|---|

Then: month-to-date, forecast (month-to-date plus the last 7 days' daily
average times the days left), the budget, and whether the budget has a
forecast threshold. Say which projects weren't scanned and why.

## 6. Act (only with approval)

For each finding worth acting on, ask with AskUserQuestion (one item at a
time), with the reversible option first:
- Cloud Run leak: `gcloud run services update <svc> --min-instances 0`,
  or delete the service if Gaurav says it's dead.
- Scheduler: `gcloud scheduler jobs pause <job>` (delete only on request).
- Secret: `gcloud secrets versions disable <n> --secret <name>`.

`gcloud scheduler jobs delete` takes one job per call. After each change,
re-run its read-only check to confirm. Then update the memory notes
(`intake-service-deleted`, `atlas-min-instances-1`, or a new one).

## `--setup`: budget and alert (idempotent)

Check first and change only what differs. These are account-level changes, so
confirm with Gaurav before running them.

```bash
A=014177-2DE01D-E2374B; P=gcp-experiments-490306
CH=projects/$P/notificationChannels/16636717936510693287   # Gaurav's email channel
B=$(gcloud billing budgets list --billing-account=$A --filter='displayName=gcp_budget' --format='value(name)')
gcloud billing budgets update $B --billing-account=$A --budget-amount=1200INR \
  --clear-threshold-rules \
  --add-threshold-rule=percent=0.5 --add-threshold-rule=percent=0.9 \
  --add-threshold-rule=percent=1.0 --add-threshold-rule=percent=1.0,basis=forecasted-spend

# Alert: a non-atlas Cloud Run service averaging ~1 instance for 6h, or atlas >2 instances for 1h.
# Create only if no policy has this displayName yet.
gcloud alpha monitoring policies list --project $P --filter='displayName="Cost: unexpected always-on Cloud Run"' --format='value(name)' \
  | grep -q . || gcloud alpha monitoring policies create --project $P \
  --policy-from-file=.claude/skills/cost-optimizer/always-on-alert.json
```

Verify with `gcloud billing budgets describe $B --billing-account=$A` (look for
`FORECASTED_SPEND`) and `gcloud alpha monitoring policies list --project $P`.
Run against 2026-09-21 data, the alert's first condition shows `intake` at 1.0
instance for every hour and every other non-atlas service near 0. It would
have fired about 6 hours into that leak.
