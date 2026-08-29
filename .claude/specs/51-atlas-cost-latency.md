# Spec 51: Atlas cost and cold-start latency

## Overview

Two numbers, measured while costing out `min-instances=1`, drove this:

**Cold start is 17.7 seconds.** Measured back to back against the live
service: 17.71s, then 1.64s, then 0.37s. The `/api/agent-chat/warm` call the
widget fires on FAB-open only helps a visitor who waits ~18s before sending,
which nobody does. The first visitor after an idle period was getting an
18-second wait.

**At `min-instances=0`, idle keep-alive is not billed.** Atlas served 442
requests in 30 days for 7,879 billable instance-seconds — about 17.8s per
request, which is just the SSE turns and the cold starts themselves. Time an
instance spends alive but idle between requests does not appear on the bill.

So the cold start can be removed with periodic cheap requests rather than by
paying for a minimum instance.

A third measurement came out of the same investigation: **memory was
over-provisioned about 10x.** p99 utilization was 9-10% of the 2 GiB limit
(~200 MiB) over 14 days, while CPU p99 ran 21-43% of 1 vCPU.

## Approach

**Keep `--min-instances 0`.** Always-on would have cost ~$18.50/month at 2 GiB
(~₹1,630) against $0 today — every Cloud Run service in the project (atlas,
pulse, resend-mcp-server, agentic-rag) totals 2.92 billable instance-hours a
month, entirely inside the free tier. Organic traffic is ~2.6 requests/day;
442 requests in the last 30 days, but 380 of those were one day of testing.

**`--memory 2Gi` → `512Mi`.** Memory is the component that dominates an
always-on bill because, unlike CPU, it gets no idle discount. This does not
change cold-start time — that is image pull plus Python/ADK imports, and CPU is
allocated independently with `--cpu-boost` already on — so it is a pure cost
change. It saves nothing today (free tier either way); what it buys is that
`min-instances=1` becomes an ~$8.70/month decision instead of ~$18.50, if that
is ever wanted.

**A Cloud Scheduler keep-warm job**, `portfolio-atlas-keepwarm`, hitting the
existing `GET /api/agent-chat/warm` every 5 minutes. That endpoint is already
the right one: it primes the resend-mcp server and, since spec 50,
`speak.warm()`'s cached ADC credentials and httpx client. 8,640 pings a month
at ~50ms each is a rounding error against the free tier's 180,000 vCPU-seconds
and 2M requests, so this is effectively $0/month for the latency that
`min-instances=1` charges $8.70-18.50 for.

This is the third scheduler job in the project, so still within the 3 free.

## Caveats

**Keep-warm is best-effort, not guaranteed.** Only `min-instances` guarantees a
warm instance; Cloud Run may still evict one despite traffic. A 5-minute
interval sits comfortably inside the ~15-minute idle window, but if measurement
shows instances still going cold, the fallback is `min-instances=1` at 512 MiB
for ~$8.70/month — still half what it would have cost at 2 GiB.

**A permanently-alive instance stops the rate limiter resetting.**
`app/rate_limit.py` keeps counters in process, so scale-to-zero silently
refreshed every bucket. With the instance kept warm, the 4-question chat cap
actually binds — which is the correct behaviour, and it is the cap that bounds
Gemini spend, but it also means the daily budget no longer quietly resets
during testing.

## Files changed

- `agents/atlas/Makefile` — `--memory 2Gi` → `--memory 512Mi` in the `deploy`
  target. Nothing else in the deploy flags moved.
- Cloud Scheduler job `portfolio-atlas-keepwarm` (infrastructure, not in the
  repo): `*/5 * * * *`, `GET .../api/agent-chat/warm`, 60s deadline, 1 retry.

## Definition of done

- Revision reports `cpu=1000m;memory=512Mi`. Verified on `atlas-00027-4gc`.
- No OOM kills or errors after exercising the memory-heaviest paths: three
  `/api/agent-speak` calls returning ~680 KB base64 WAV payloads, and a real
  streaming `/api/agent-chat` turn with thinking enabled. Verified.
- Memory p99 on the new revision sits well under the limit. Verified at 32% of
  512 MiB (~164 MiB) while under that load.
- Keep-warm job runs and reaches Cloud Run. Verified: 200 in 50ms.
- Cold start no longer visible to visitors. To confirm over time, compare
  against the recorded baseline (17.71s / 1.64s / 0.37s).

## Deferred

- `min-instances=1` — the fallback if keep-warm proves unreliable.
- `max-instances=1` — would make the in-process rate limiter correct, at the
  cost of all scale-out headroom exactly when a post might land.
- Moving rate-limit counters to D1, which would make the caps correct
  regardless of scaling. Worth doing if traffic becomes real.
