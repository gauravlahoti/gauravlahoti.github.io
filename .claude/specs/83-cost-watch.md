# Spec 83: Cost watch

On 2026-10-01 the September bill showed Cloud Run doubling from about ₹32/day to
₹65/day on Sep 20. The cause was the `intake` service, deployed for an SLA smoke
test with `min-instances=1` and an every-minute Cloud Scheduler tick. Neither was
rolled back after the test. It ran for 11 days (₹352) before anyone looked, and
nothing would have flagged it:

- The ₹1,500 budget (`gcp_budget`) alerted only on *actual* spend, and the month
  closed at ₹1,160.
- The BigQuery billing export pointed at a closed trial account. Its table has
  been frozen since 2026-05, so the Worker's `/api/gcp-cost` read stale data.
- Pulse's email had no cost section.

`intake` and both leftover scheduler jobs were removed by hand on 2026-10-01.
This spec makes the next leak show up within hours.

## Layers

| Layer | Cadence | Catches |
|---|---|---|
| Budget with a forecast threshold | Several times a day (GCP) | A month heading over budget, days before it gets there |
| Alert policy "Cost: unexpected always-on Cloud Run" | Within ~6h | A non-atlas service holding an instance all day, or an atlas surge |
| Pulse "Cost watch" section (spec 84) | Mon and Thu | Month-to-date, forecast, movers, flagged services |
| `/cost-optimizer` | Monthly, and after any new or test deployment | Everything else: idle VMs, disks, endpoints, secrets, free tiers |

## Changes

1. **Billing export (manual, one time).** Cloud Console → Billing →
   Gaurav_billing → Billing export → Standard usage cost → project
   `gcp-experiments-490306`, dataset `billing_data`. There is no API or gcloud
   command for this. `backend/wrangler.toml` pins `GCP_BQ_TABLE` to
   `gcp_billing_export_v1_014177_2DE01D_E2374B` instead of the
   `gcp_billing_export_v1_*` wildcard, which also matched the dead table.
   The `cost-monitor` service account already holds BigQuery Data Viewer and
   Job User on the project, so it needs no new grant.
2. **`/cost-optimizer` skill** (`.claude/skills/cost-optimizer/SKILL.md`).
   Discover → cost (BQ, or priced usage metrics as an estimate when the export
   is missing) → leak scan → free-tier check → report → act per item with
   approval, reversible first. It has a "known intentional" list (atlas
   min-instances=1, the Verity-bound Gemini secrets, Pulse's jobs) so the
   report doesn't keep recommending them.
3. **`--setup`** installs:
   - the budget: ₹1,200 with 50/90/100% actual plus 100% *forecasted*;
   - the alert policy `always-on-alert.json`, sent to the existing email
     channel.
   Both are account-level changes, so they run only with Gaurav's go-ahead.
   (The auto-mode permission check refused them when they were tried during
   implementation.)

## Verification of the alert

Both conditions' filters and aggregations were run as read-only Monitoring
queries over 2026-09-21, the first full day of the leak:
- `intake` read 1.0 instance in every hourly point, so the first condition
  (> 0.8 for 6h) would have fired about 6 hours in;
- agentic-rag, pulse and resend-mcp-server stayed below 0.02;
- atlas peaked at 3 instances. The 1h duration on the surge condition keeps a
  deploy's brief overlap of two revisions from triggering it.

## Definition of done

- [x] Skill written, with copy-paste commands for every step.
- [x] Alert filters validated against real Monitoring data (above).
- [x] `GCP_BQ_TABLE` pinned. The four cost queries of spec 84's `?view=digest`
      dry-run cleanly in BigQuery.
- [ ] Billing export enabled in the Console (Gaurav).
- [ ] `/cost-optimizer --setup` run: the budget shows `FORECASTED_SPEND` and
      the policy is listed.
- [ ] First `/cost-optimizer` run after the export has a few days of data.
