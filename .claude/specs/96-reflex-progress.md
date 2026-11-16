# Progress: Reflex (working name) / self-service triage agent with Jev

> **Read this first when resuming on another device or another Claude account.**
> Then read `.claude/specs/96-reflex-system-one-desk.md` (the full spec). Update the "Progress log" and
> "Next actions" below at the end of every work session, then commit and push.
>
> Resume prompt to paste into a new session:
> "Read `.claude/specs/96-reflex-progress.md` and `.claude/specs/96-reflex-system-one-desk.md`, then continue
> from the Next actions. Do not re-decide anything listed under Locked decisions."

Last updated: 2026-11-16 · Branch: `feature/reflex-system-one-desk` · Based on `main` at `bf07799`

## Status in one line
Spec and visual mock are done and pushed. **No agent code exists yet.** Sprint 1 has not started. It is
waiting on three decisions: the name, a TypeSafe (Jev) key, and the three LLM tier model IDs.

## What this project is
A self-service IT triage agent, an ADK 2.0 graph workflow, that shows System 1 vs System 2 thinking.
- **TypeSafe's Jev** (a "System One" decision model) makes fast, typed, calibrated judgments:
  category, urgency, complexity, security flag, tool choice, and later "is this step safe".
- **Code** owns every rule (truth tables). Jev judges, code decides.
- **An LLM** (small, mid or frontier, picked by Jev's complexity score) reasons and writes only.
- Goal: a LinkedIn-worthy demo like the Agentic Harness lab: clean UI, graph lighting up node by node,
  natural chat with latency and cost on every message, voiced replay. **Recording and voice come last.**
  First we build a real agent that does the job.

## Locked decisions (do not re-open)
- Scenario: self-service IT triage for an enterprise service desk. Synthetic users, tickets, KB. No real systems.
- Agile delivery. **Sprint 1 = Screen and route, for real:** Jev screens the query (category, urgency,
  complexity, security flag), code picks the model tier from complexity, Jev picks the tool (Choice plus a
  `tool_fits` Noul), the chosen LLM fills arguments, a real tool runs on a synthetic store, `reply` writes.
- Real Jev, real LLM tiers, real tools over **synthetic data**. Not mocks, not fixtures-only.
- Risky tools (`restart_service`, `grant_access`) are registered but disabled until the safety gate (sprint 2).
- Sprints: 1 screen and route, 2 safety gate and approval, 3 UI, 4 recording/voice/hosting, 5 portfolio wiring.
- The UI is a pure function of trace events. Every node emits a trace event from sprint 1.
- The agent and UI live in **their own repo** (like Agentic RAG and Agentic Harness), hosted on Cloud Run,
  keyless public replay. This repo (`gauravlahoti.github.io`) holds only the spec, card, stub and agent entry.
- Soft light theme, natural chat look (not a trace log), Jev's raw structured output shown as it comes back,
  latency and cost on every message, no top header bar. See the spec's Visual design section.
- No Jev vs LLM live comparison for now. Show measured numbers from recorded runs only.
- No em-dashes in any copy (spec 90).

## Open decisions (blocking marked)
1. **Name.** Preferred **Switchboard**. Others: Dispatch, Reflex (current working name), Usher, Fastlane,
   Waypoint, Triage Desk, Sorter. Trademarks and domains not checked.
2. **TypeSafe key (BLOCKS sprint 1 live calls).** Need `TYPESAFE_API_KEY` (early access), the data terms,
   and a small experiment budget. Only synthetic queries are sent. Ask before any live probe.
3. **LLM tiers (BLOCKS sprint 1).** Which models are small, mid, frontier. Resolve exact IDs, never from memory:
   `gcloud ai model-garden models list --project=adk-deploy-trail | grep -i <family>` and check the
   **second** column (`CAN_PREDICT`) says `Yes`. IDs often carry a `-preview` suffix.
4. Domain (e.g. `<name>.gauravlahoti.dev`), lab number (06 vs 07 vs the stashed SDLC lab), palette match to
   the harness, A2UI decision (sprint 5), whether a public typed-ticket live mode ever ships.

## Next actions (in order)
1. Pick the name. Replace the working name in the spec if it changes.
2. Get the Jev key and the data terms. Store it in Secret Manager or a git-ignored local `.env`.
3. Resolve the three LLM tier model IDs with `gcloud` (see above).
4. Create the new repo and scaffold the ADK project (use the `google-agents-cli-scaffold` skill).
   Requires `google-adk >= 2.0` and Python >= 3.11 for the graph `Workflow` API. Atlas and Pulse may pin
   older versions, which is why this is its own project.
5. Build sprint 1 against the spec's Definition of done. Write `app/questions.py` first (every Jev question in
   one file), then the truth tables and tier table with unit tests, then the nodes, then the tools and the
   synthetic store, then the trace events.
6. Build the ~30 query eval set. Run it. **Write the baseline below** (category, tool, tier accuracy,
   confusion table, calibration buckets). Only then set accuracy targets.

## Sprint 1 checklist
- [ ] Name chosen, repo created, ADK project scaffolded
- [ ] Jev key available, one live call verified against the live docs' request shape
- [ ] LLM tier IDs resolved and callable
- [ ] `app/questions.py` (triage questions, tool choice, `tool_fits`)
- [ ] `policy_router` and tier table with unit tests (including the 0.3 to 0.7 band)
- [ ] Synthetic store seeded (users, tickets, KB, logs) and the five non-risky tools working
- [ ] Graph runs end to end: intake, jev_triage, policy_router, tier_llm, execute_tool, reply (+ clarify, + escalate stub)
- [ ] Trace events emitted by every node
- [ ] Failure paths: forced Jev failure and forced LLM failure stop safely with an error event
- [ ] Eval set built and baseline recorded here

## Baseline results
Not run yet.

## Progress log
| Date | What happened |
|---|---|
| 2026-11-16 | Brainstormed System 1 vs System 2 demos. Researched Jev (TypeSafe) and Google's Gemini Decisions API. Built and iterated a clickable UI mock. Wrote spec 96 with the visual reference. Reworked it into agile sprints. Shipped an unrelated cursor zoom fix (PR #208). No agent code yet. |

## Where everything is
| What | Path |
|---|---|
| Full spec | `.claude/specs/96-reflex-system-one-desk.md` |
| This progress file | `.claude/specs/96-reflex-progress.md` |
| Clickable UI mock (design reference) | `.claude/specs/assets/96-reflex/mock.html` |
| Screenshots | `.claude/specs/assets/96-reflex/welcome.png`, `running.png` |
| Run the mock | `cd .claude/specs/assets/96-reflex && python3 -m http.server 5174` then open `http://localhost:5174/mock.html` |

The mock is desktop only (about 1200px and up). All its numbers are invented. It is a design reference, not
production code. Production must add the narrow-screen progress rail, accessibility and reduced motion.

## Things learned that are not in the code
**Jev (TypeSafe AI)**
- First "System One" model. Launched about 2026-09-15, early access, no open weights, no self-hosting.
- Endpoint reported as `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`. **Read the live
  docs for exact shapes:** https://docs.typesafe.ai/llms.txt (OpenAPI at https://api.typesafe.ai/openapi.json).
- Four primitives: **Choice** (pick one), **Score** (rubric levels), **Noul** (is this true, 0 to 1), **Box**
  (where in an image, needs Jev 1.14). It cannot write prose, chat or count reliably.
- Images: PNG or JPEG, 280 to 1568 px a side, 16 MiB, header `TypeSafe-Danger-Zone-Images: true`. Labelled
  "Dreamer-ready", not production.
- Vendor claims (193x faster, 444x cheaper, latency and cost figures) conflict across sources and are
  **unverified**. Show only what we measure.
- A `typesafe:typesafe-ai` skill exists (plugin v0.6.2). Install it on the new device if available. Its rules
  are summarised next.

**TypeSafe integration rules (from that skill)**
- Jev makes judgments, code decides. Never ask "should we escalate". Ask the atomic judgments and write the
  decision as a truth table in code.
- One judgment per question. Bundle questions that share state into one request. Questions cannot see each
  other. Use named JSON fields, only what a person would look at.
- Pair every Choice or Box that always returns something with a Noul that asks whether anything fits.
- Confidence is not the gate. Start Noul thresholds at 0.7 and 0.3, and treat the middle band as its own row.
- Keep all question wording in one module. A failed API call is an error, never a "no". Keys stay server-side.
- Counting, date arithmetic and exact lookups belong in code.

**Alternative:** Google's Gemini Decisions API (preview, announced about 2026-11-11) is a closed-set,
multimodal decision endpoint (up to 1,000 questions per request, reported $0.10 per million input tokens,
not in EU data residency). Secondary sources only, unverified. Not used for this project.

**ADK**
- Graph `Workflow` API cheatsheet is in the `google-agents-cli-adk-code` skill, `references/adk-python-workflows.md`.
  Function nodes, `LlmAgent` nodes (always set `output_schema`), route edges, `RequestInput` for HITL.
- Never hand-edit `pyproject.toml [tool.agents-cli]` or `App(name="app")`. Agents are hosted in
  `gcp-experiments-490306` but call Vertex on `adk-deploy-trail` (needs the cross-project IAM grant). A
  `403 CONSUMER_INVALID` points at that grant.
- Resolve every Google model ID with `gcloud` first.

**Mock gotchas (do not repeat)**
- Never name a top-level script variable `top`. It collides with `window.top` and silently kills the script.
- Do not put a CSS `transform` animation on an SVG element that also uses a `transform` attribute. Wrap it.
- Google Sans is not available. Production falls back to self-hosted Inter. Self-host fonts, no CDN font sheet.
- An attempt to run `npx modern-web-guidance` was denied by the permission classifier. It was not retried.

## Parked ideas (not part of this project)
- **Workplace photo inspection with Jev's Box primitive:** classify the photo area, pick the applicable
  rules, one Noul per rule for compliance, Score for severity, Box to localise the issue, then an LLM writes
  the finding. Pair every Box with a Noul. Count in code. Full plan text is in a **local git stash on the
  original device** (`stash@{0}: jev photo inspector plan (plan.md)`). It does **not** travel with the repo.
- Resume-to-job matching with Jev (Score per job, one Noul per requirement for missing keywords, LLM for
  advice). Brainstorm only.
- A live Jev vs LLM side-by-side comparison. Deferred on purpose.

## Working preferences (from the user)
- Natural, human copy. No em-dashes. Short plain sentences.
- Soft, soothing light theme. Natural chat look. Real Google-level polish and animation.
- Build the agent for real before any recording. Agile, small sprints.
- Confirm before anything outward-facing (push to main, deploy, sending data to an external API).
