# Spec 41: Warden — Autonomous Site-Manager Agent Team

## Overview
A third Google ADK service, **`agents/warden/`**, that keeps the portfolio current, healthy, fast, and idea-fed with **no routine human intervention** — but every change to the live site lands as a **GitHub PR you approve** (merge → existing `deploy.yml` deploys). Warden is the **coordinator / team lead**; it runs on a schedule, surveys site state, delegates to three in-process specialists (Scribe, Sentinel, Scout), queries the two existing agents as remote members, then opens **one PR + sends one summary email** per run.

This is greenfield in one important way: **no existing agent writes to the repo.** Atlas (chat) reads content live and logs to D1; Pulse (ambient) reads/writes D1 through the Worker and emails Gaurav. Neither edits `content/*.json`, opens a PR, or deploys. Warden adds that write surface, gated by PR review and CI.

Modeled directly on Pulse's proven plumbing: scheduled, token-gated HTTP trigger; Worker-as-data-gateway; Resend-MCP for email; `FallbackGemini` cost cascade.

## Locked decisions
| Decision | Choice |
|---|---|
| Autonomy model | **PR-for-approval.** Agents do the work, open a PR (or draft email); human merges. No auto-publish. |
| Team wiring | Coordinator with **`AgentTool`** composition (Warden stays in control, aggregates to one PR) — **not** `sub_agents` hand-off, **not** `SequentialAgent`. |
| Atlas/Pulse membership | **Remote members via A2A** (`to_a2a` AgentCard + `RemoteA2aAgent`). Keep them separate services. Phase 1 reaches them via wrapped HTTP; A2A upgrade later. |
| Repo write | **GitHub write tool** (thin MCP server *or* `httpx` function tool) exposing branch-write + open-PR **+ create-issue**, scoped to this one repo. Fine-grained **PAT in Secret Manager**, never model-supplied (mirrors the Resend-key isolation). |
| Performance monitoring | Synthetic **PageSpeed Insights API** first (no headless Chrome), **RUM Web Vitals beacon** next. Owned by Sentinel. |
| Idea generation | **Scout** proposes via **email + draft `idea` issues, never auto-PR** — ideas need human judgment before becoming work. |
| PR validation | **CI, not the agent** — new `.github/workflows/validate.yml` runs the JSON-parse + `node --check` checks already scripted in `/publish`. |
| Pulse triggering | Warden triggers **`/api/ambient/metrics`** on-demand (idempotent, needed before Scribe reads engagement). **Leaves `/api/ambient/run` on Cloud Scheduler** (it emails; avoid double-send / SPOF). |
| Model | `FallbackGemini(gemini-3.5-flash → gemini-2.5-flash → gemini-2.5-flash-lite)`, reused from atlas/pulse. |
| Scope (this spec) | **Content freshness (Scribe)** + **health & performance (Sentinel)** + **trend/idea generation (Scout)**. Code/feature edits and the full "conductor" cadence are out of scope. |

## Named roster
| Agent | Role | Membership | Deployment |
|---|---|---|---|
| **Warden** | Coordinator / lead — surveys, delegates, opens PRs, sends the one email | *is* the team runner | new Cloud Run svc `warden` |
| **Scribe** | Content freshness — drafts `posts.json` / `graph.json` / copy edits | in-process `AgentTool` | inside Warden |
| **Sentinel** | Site health & performance / self-heal — deploys, errors, cost, CSP, perf budget | in-process `AgentTool` | inside Warden |
| **Scout** | Trend & idea generator — tracks ADK/AI trends, proposes ideas (email + issues, never auto-PR) | in-process `AgentTool` | inside Warden |
| **Atlas** | Visitor chat *(exists)* — queried to replay/verify answers | remote member (A2A) | own svc, unchanged |
| **Pulse** | Ambient growth *(exists)* — metrics scrape triggered on-demand | remote member (A2A) | own svc, unchanged |

## Architecture
```
Cloud Scheduler (portfolio-warden, weekly)
  → POST /api/warden/run   (x-internal-token: WARDEN_TRIGGER_TOKEN)
      │
      ▼
  Warden (LlmAgent, coordinator) ── surveys state, composes ONE changeset + ONE email
      │
  in-process AgentTool:
      ├─ Scribe    → detects stale/missing content, proposes JSON edits → session.state
      ├─ Sentinel  → deploy fails, errors, cost, CSP, perf budget → proposes fixes → session.state
      └─ Scout     → tracks ADK/AI trends → curated ideas (email + draft issues, no auto-PR)
      │
  remote members (existing services; wrapped HTTP now / A2A later):
      ├─ trigger_pulse_metrics()  → refresh post_metrics BEFORE Scribe reads them
      └─ ask_atlas(question)      → replay a bad answer before proposing a corpus fix
      │
      ├─ github_tool.open_pr(branch, files[], title, body)  → PR opened → validate.yml → you Merge ✅
      └─ resend_mcp.send_email(...)                         → one dashboard email w/ PR links
```

**Why in-process for Scribe/Sentinel but A2A for Atlas/Pulse:** ADK teams are in-process (one runner). Scribe/Sentinel are new and batch-shaped, so they live inside Warden and share `session.state` (via `output_key`) so Warden merges their edits into one PR. Atlas/Pulse are separately-deployed with different shapes (Atlas: interactive, latency-sensitive, unauth + rate-limited; Pulse: batch, holds write secrets). Merging them would collapse three blast radii and put the git PAT on the live chat agent — so they join as remote members instead.

## Specialists

### Scribe — content freshness
- **Reads (reuse):** `corpus_live.py` live-fetch of `profile/graph/posts/agents.json`; Worker `/api/post-metrics` for staleness (after `trigger_pulse_metrics`).
- **Detects:** posts missing insight pages, graph nodes with no edges, stale metrics, bio/links drift.
- **Discovery (new post ingest):** LinkedIn has **no clean discovery API** (no public feed without OAuth partner access; activity-page scraping is brittle + ToS-risky + blocked). So discovery stays human, ingestion is automated: Scribe polls a **drop-point queue** — a URL dropped by Gaurav into a low-friction inbox (`content/pending-posts.txt`, a dedicated email address Warden reads, or a tiny endpoint). For each queued URL it runs the OG scrape (reuse `scripts/add-post.mjs`), drafts the `posts.json` entry + insight page, and opens a PR. (Optional later: an rss.app LinkedIn→RSS bridge polled and diffed against `posts.json` slugs to automate discovery too.)
- **Proposes:** edits to `content/*.json` in the exact shapes the `/add-post`, `/add-project`, `portfolio-content-update` skills use (reuse `scripts/add-post.mjs` OG-parse logic; `scripts/gen-post-pages.mjs` for insight pages). Writes proposed file-changes to `session.state`.

### Sentinel — site health, performance & self-heal
- **Reads:** last `deploy.yml` run (GitHub Actions API), Worker `/api/ambient/interactions` for Atlas error/injection spikes, `/api/gcp-cost` for spend drift, Atlas `/healthz`.
- **Performance (new — covers the "sluggishness" gap):** nothing in the roster measured the `CLAUDE.md` perf budget (FCP < 1.5s, JS < 400 KB, Lighthouse ≥ 90). Sentinel closes it two ways:
  - **Synthetic (Phase 2):** call the **PageSpeed Insights API** (runs Lighthouse server-side — no headless Chrome, ideal for Cloud Run) against key URLs on schedule; flag Lighthouse/FCP/LCP/TBT/CLS/bundle regressions vs budget.
  - **Real-user / RUM (Phase 3):** extend `assets/js/analytics.js` to beacon Core Web Vitals (INP/LCP/CLS via `PerformanceObserver`) → new `page_views` column → Sentinel spots real "sluggishness time to time" (best signal for scroll/interaction jank, which synthetic under-measures).
- **Detects:** red deploy, error-rate anomalies, cost trending up, CSP `connect-src` drift, perf-budget regressions.
- **Proposes:** a revert/fix PR, or flags an alert in the summary email when there's no safe auto-fix.

### Scout — trend & idea generator
- **Reads:** grounded web search (ADK built-in `google_search`) + `adk.dev/llms.txt` + model release notes. Tracks ADK releases (A2A, 2.0 workflow-graph API, ambient-agent samples), MCP/protocol news, Gemini/Claude updates.
- **Proposes (email + issues, never live content):** portfolio feature/content ideas (post angles, a new demo lab, skills refresh) **and** self-modernization of the agent stack itself ("migrate Warden's cycle to the ADK 2.0 workflow API", "adopt the new ambient-agent sample").
- **Output discipline:** raw ideas need human judgment, so Scout writes a **curated ideas section in the weekly email** and optionally opens **draft GitHub issues labeled `idea`** — it does **not** open content PRs.

All specialists reuse the Worker-as-data-gateway pattern (never touch D1/BigQuery directly) and `FallbackGemini`. Watch the AI-Studio spend cap — prod agents 429 when it's exhausted.

## Routes (new Warden FastAPI app)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/warden/run` | Full cycle: metrics refresh → Scribe + Sentinel → open PR(s) → one email. Gated by `WARDEN_TRIGGER_TOKEN` in `x-internal-token`. |
| GET | `/healthz` | Liveness |

## Repo & infra changes
- **`agents/warden/`** — new ADK project (`agents-cli scaffold create warden`); `App(name="app")`, manifest `name: warden`; coordinator + Scribe + Sentinel; per-project Makefile deploy. No shared package (per convention).
- **`.github/workflows/validate.yml`** — PR gate: every `content/*.json` parses + `node --check` on changed JS/mjs. The durable safety net that lets *any* agent PR be trusted.
- **GitHub write capability** — MCP server or `httpx` tool; `create_or_update_files(branch, files[])` + `create_pull_request(title, body)`.
- **Secrets (Secret Manager):** `WARDEN_TRIGGER_TOKEN`, `WARDEN_GITHUB_TOKEN` (fine-grained PAT: contents + pull_requests, this repo only), plus reused `AMBIENT_TRIGGER_TOKEN` (to call Pulse), `AGENT_LOG_TOKEN`, `RESEND_MCP_URL`/`MCP_CALLER_TOKEN`.
- **Cloud Scheduler:** new `portfolio-warden` job → `POST /api/warden/run`.

## Reuse map
| Need | Reuse from |
|---|---|
| Scheduled token-gated trigger | Pulse `POST /api/ambient/run`, `x-internal-token`, Secret Manager |
| Never touch datastores directly | Worker `/api/ambient/*`, `/api/agent-stats`, `/api/gcp-cost`, `/api/post-metrics` |
| Live content read | `agents/atlas/app/corpus_live.py` |
| Side-effect behind a server, secret isolated | Resend MCP (`agents/pulse/app/app_utils/ambient_send.py`) |
| One-run/one-email discipline | Pulse `AMBIENT_INSTRUCTION` ordered-steps |
| Model cost control | `FallbackGemini` (`agents/*/app/fallback_model.py`) |
| Content edit shapes | `/add-post`, `/add-project`, `portfolio-content-update`, `scripts/gen-post-pages.mjs` |
| PR validation checks | JSON-parse + `node --check` from `/publish` |

## Additional responsibilities (backlog — future specialists/tools)
Atlas quality flywheel (mine `agent_interactions` → propose corpus/`graph.json` additions) · link-rot & asset checks · SEO/OG hygiene · dependency/security bumps (`/audit`) · analytics-driven copy (`page_views`) · Perspectives auto-curation · cost governance · **visual-regression screenshot diff after deploy** · **accessibility (axe) audit on PRs** · **uptime/latency probe on Atlas/Pulse endpoints** · **rss.app LinkedIn→RSS discovery bridge**. Each slots in behind the same coordinator + PR-gate.

## Goals & success invariants (what "well-managed" means, measurably)
The run contract below says when a run *finishes*; **these invariants define what "good" is**, so "did Warden meet the goals?" is a concrete check rather than a judgment. Each specialist owns a set of **invariants** — target conditions it evaluates every run and records as `InvariantCheck` (green/red + observed value + the action addressing any red). This is the source of truth for goal-completion.

### Scribe — content invariants
| id | Green when | Source | On red |
|---|---|---|---|
| `content.insight_pages` | every `posts.json` entry has a matching page under `insights/` | `posts.json` vs `insights/` listing | PR: generate missing page |
| `content.metrics_fresh` | every post's `post_metrics` fetched ≤ 3 days ago | `/api/post-metrics` `fetched_at` | `trigger_pulse_metrics()` then re-check |
| `content.drop_queue_empty` | no URL sits in the drop-queue past one run | `content/pending-posts.txt` | PR: ingest queued post(s) |
| `content.graph_integrity` | no orphan node (every node ≥1 edge); no dangling edge endpoint | `graph.json` | PR: fix/flag |
| `content.links_resolve` | every `profile.json` link returns 2xx | HEAD probe | alert (external) / PR (internal) |

### Sentinel — health & performance invariants
| id | Green when | Source | On red |
|---|---|---|---|
| `health.deploy_green` | latest `deploy.yml` run == success | GitHub Actions API | alert + (if a bad commit) revert PR |
| `perf.lighthouse` | Lighthouse Performance ≥ 90 (desktop) | PageSpeed Insights API | alert / fix PR |
| `perf.fcp` | FCP < 1.5s (mobile 4G) | PageSpeed Insights API | alert |
| `perf.js_budget` | total JS < 400 KB gzipped | PSI resource summary | alert / fix PR |
| `health.atlas_up` | Atlas `/healthz` 200 and error+injection rate < 5% over last window | `/healthz`, `/api/ambient/interactions` | alert |
| `health.cost` | GCP spend within budget, not trending up past threshold | `/api/gcp-cost` | alert |
| `health.csp_current` | `index.html` CSP `connect-src` covers all live agent origins | parse `index.html` vs known URLs | PR: fix CSP |

### Scout — activity goal (no invariants)
Ideas aren't a required state, so Scout holds no pass/fail invariants. Its goal is simply **"completed a fresh trend scan this run"** (ran grounded search, emitted 0+ ideas). Advisory only.

### "Goals met" — the single machine-checkable rule
> **A run has met its goals when: every invariant is green, OR red with an open corrective action (this run's PR, a still-open prior PR, an email alert, or a draft issue) — i.e. no invariant is red *and* unaddressed — and Scout completed its scan.**

Because this is PR-for-approval, a single run usually can't flip a red invariant back to green itself (the fix needs merging); "goal met" therefore means **every gap is either closed or has an action in flight**, and the invariant flips to green on a later run once the PR merges. Each run emits the full **invariant scoreboard** in telemetry (`[{id, green, observed, action}]`) so Warden and a human can see at a glance that every goal is satisfied or being handled. All-green with no open actions = the steady "nothing to do" success state.

### Per-run goals checklist (emitted every run — leads the email + telemetry)
Warden fills this in each cycle. **A box is ticked `[x]` when the goal is green *or* has an open corrective action; `[ ]` means red-and-unaddressed (a real miss).** The run has met all goals ⇔ every box is ticked.

```
Warden run — <timestamp>  ·  outcome: <all-green | acting | partial>

Scribe · content
  [ ] content.insight_pages     every post has an insight page
  [ ] content.metrics_fresh     post_metrics fetched ≤ 3 days ago
  [ ] content.drop_queue_empty  no post URL waiting in the drop-queue
  [ ] content.graph_integrity   graph.json has no orphan nodes / dangling edges
  [ ] content.links_resolve     every profile.json link returns 2xx

Sentinel · health & performance
  [ ] health.deploy_green       latest deploy.yml run succeeded
  [ ] perf.lighthouse           Lighthouse Performance ≥ 90 (desktop)
  [ ] perf.fcp                  FCP < 1.5s (mobile 4G)
  [ ] perf.js_budget            total JS < 400 KB gzipped
  [ ] health.atlas_up           Atlas /healthz 200 & error+injection rate < 5%
  [ ] health.cost               GCP spend within budget, not trending up
  [ ] health.csp_current        CSP connect-src covers all live agent origins

Scout · trends
  [ ] scout.scan_done           completed a fresh ADK/AI trend scan this run

Coordinator · run hygiene
  [ ] run.one_pr                ≤ 1 PR opened this run
  [ ] run.file_cap              ≤ N files changed (default 8)
  [ ] run.one_email             single summary email sent (or suppressed if all-green)
  [ ] run.telemetry             invariant scoreboard returned to caller
```
Each ticked box that was red carries its action inline in the email, e.g. `[x] perf.lighthouse  84 → PR #123`. Any `[ ]` box is surfaced at the top as an unaddressed miss requiring attention.

## Run success criteria (per-cycle done contract)
Distinct from build acceptance below: this is how **Warden knows one scheduled run met its goals** and may terminate + report — not left to the model's discretion. Machine-checkable, not vibes. **Goal-completion is defined by the invariant rule above; the criteria here are the mechanical wrapper around it.**

**Each specialist returns a structured `SpecialistResult`** (pydantic) so completion is explicit:
```python
class ProposedChange(BaseModel):
    path: str            # repo-relative, e.g. "content/posts.json"
    new_content: str     # full file after edit
    reason: str          # why, for the PR body + email

class InvariantCheck(BaseModel):
    id: str              # e.g. "perf.lighthouse", "content.insight_pages"
    green: bool          # does the target condition currently hold?
    observed: str        # measured value, e.g. "Lighthouse 84 (target ≥90)"
    action: str          # "none" | pr_url | "alert" | issue_url — how a red is being addressed

class SpecialistResult(BaseModel):
    specialist: str                       # "scribe" | "sentinel" | "scout"
    status: str                           # "ok_no_action" | "proposed_changes" | "alert" | "error"
    invariants: list[InvariantCheck] = [] # the goal scoreboard this specialist owns
    changes: list[ProposedChange] = []    # empty unless status == "proposed_changes"
    alerts: list[str] = []                # human-readable, for the email (e.g. Sentinel perf regression)
    ideas: list[str] = []                 # Scout only — never become file changes
    summary: str                          # one line for the digest
```

**A run is DONE (success) when all of these hold:**
1. **Every engaged specialist returned a terminal `SpecialistResult`** with its full invariant scoreboard evaluated. A specialist that errors or exceeds its per-specialist timeout is recorded as `status="error"` — it does **not** block the run (partial success), but its invariants are reported `unknown` (treated as unmet → flagged).
2. **Goals rule satisfied:** no invariant is red *and* unaddressed — every red has an open corrective action (PR / prior open PR / alert / issue). This is the actual goal-completion check.
3. **Changeset resolved:** all `proposed_changes` merged into one changeset. If non-empty → **exactly one PR opened** (or, in dry-run, the unified diff logged) and its URL captured. If empty → no PR (valid no-op).
4. **One summary email sent** (Resend MCP) leading with the invariant scoreboard, then every specialist's `summary`, all `alerts`, Scout `ideas`, and the PR link — **unless** the run is all-green with no alerts/ideas, in which case the email is suppressed to avoid inbox noise (telemetry still records `no_action`). Scout `idea` issues, if enabled, are opened here.
5. **Endpoint returns PII-free telemetry** (assembled deterministically by inspecting the function-call/response stream, exactly like Pulse's `/api/ambient/run`): the invariant scoreboard `[{id, green, observed, action}]`, per-specialist `status`, files-changed count, PR URL, email message-id, duration, `FallbackGemini` level used.

**Three terminal outcomes, all "done":**
| Outcome | Condition | Effect |
|---|---|---|
| **Success (all-green)** | every invariant green, no open actions, Scout scanned | no PR, email suppressed, telemetry `no_action` |
| **Success (acting)** | ≥1 red invariant, each now has an open PR/alert/issue | ≤1 PR + 1 email (scoreboard + actions) |
| **Partial** | ≥1 specialist `error` (invariants `unknown`) but the rest terminal | PR/alerts for the known reds + email flags the unknowns |

**Termination guardrails (bound blast radius):**
- **≤1 PR per run** and a hard cap of **N files changed per run** (default 8). A specialist proposing beyond the cap → downgrade to an **email alert**, not a PR.
- **Per-run wall-clock + token budget**; on breach the coordinator finalizes with whatever terminal results it has (partial) rather than looping.
- The coordinator does **not** self-merge, retry a failed PR, or re-run a specialist — it reports and exits. Recovery is the next scheduled run or a human.

Because ADK's `output_schema` disables tool calling on the agent that carries it, the **coordinator keeps its tools** and the telemetry `RunResult` is assembled in the endpoint from the event stream (Pulse pattern) — the `SpecialistResult` schema applies to the **sub-agents** (which run in task/structured mode and finish via their typed result), not the tool-using coordinator.

## Out of scope
- Auto-merge / auto-publish (PR is the gate).
- Code/feature edits to HTML/JS/CSS (a "builder" specialist can come later; highest risk).
- Full "conductor" cadence (Warden owning Pulse's emailing digest schedule) — needs Warden self-health-alerting + idempotent triggers first.

## Definition of done (build acceptance)
> How **we** know each phase is *implemented* (distinct from the per-cycle run contract above, which is how **Warden** knows a run succeeded). This spec is the design contract; build is phased. Build complete when:

**Phase 0 — PR-gate infra (local, no cloud):**
1. `.github/workflows/validate.yml` runs on PRs; a bad `content/*.json` fails the check, a good one passes.
2. GitHub write tool opens a PR against a scratch branch from a local invocation (hand-driven, no agent yet).

**Phase 1 — Warden coordinator + Scribe:**
3. `agents/warden/` scaffolded; `agents-cli` local run of `/api/warden/run` executes: `trigger_pulse_metrics()` → Scribe proposes a `posts.json`/`graph.json` edit → `open_pr` → PR appears → `validate.yml` green → merge → Pages deploys.
4. **Dry-run flag** logs proposed diffs to the summary email **without** opening a PR (mirrors `add-post.mjs --print`) — validate reasoning before granting write.
5. One summary email via Resend MCP links the PR(s); PII-free telemetry returned like Pulse's `/api/ambient/run`.
6. The run honours the **goals rule + per-cycle done contract**: each specialist emits a terminal `SpecialistResult` with its invariant scoreboard; the run lands in exactly one terminal outcome (all-green / acting / partial); "goals met" = no invariant red-and-unaddressed; telemetry reports the scoreboard + per-specialist status + PR URL + email id; the ≤1-PR and N-file caps hold (verify by forcing an over-cap proposal → it downgrades to an email alert). Verify the loop end-to-end: red invariant (e.g. a post with no insight page) → PR opened → merge → next run reports that invariant **green**.

**Phase 2 — Sentinel (health + synthetic perf):** deploy status, error/cost anomalies, CSP drift, **PageSpeed Insights budget check** → fix PR or email alert.

**Phase 3 — Scout + RUM:** Scout ships an ideas section in the weekly email (grounded ADK/AI search) + draft `idea` issues; extend `analytics.js` with a Web Vitals beacon so Sentinel gets real-user perf.

**Phase 4+ — A2A upgrade + backlog specialists:** replace wrapped-HTTP calls to Atlas/Pulse with `RemoteA2aAgent`; add flywheel / link-rot / deps / visual-regression.

## Verification
- **Local:** `agents-cli` run of warden against a throwaway branch; confirm PR opens and `validate.yml` passes/fails on good/bad JSON.
- **Safety:** PAT scoped to this repo, contents + PRs only; token never in agent code; `min-instances=0` + `FallbackGemini` bound cost; a bad-content PR is blocked by `validate.yml`.
- **Regression:** Warden's schedule doesn't collide with Pulse's; services stay independent (no shared package); the emailing digest still fires only from Cloud Scheduler.

## Human steps (not auto-run)
Create the fine-grained GitHub PAT; add the three secrets to Secret Manager; `make deploy` warden; create the `portfolio-warden` Cloud Scheduler job; after deploy, add Warden's origin to `index.html` CSP if the frontend ever calls it (it does not in this spec).
