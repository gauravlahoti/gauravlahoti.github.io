# Spec: Agent Corpus as ADK Skills

## Overview
Today the chat agent injects the **entire corpus** (full `profile` + `graph` + `posts` JSON) into the system instruction on **every turn** via `guardrails._inject_live_corpus` — roughly 6–8K input tokens per turn, regardless of what the visitor asked. This spec replaces that with **ADK Skills** (native `SkillToolset`, progressive disclosure): a lightweight metadata menu (~500 tokens) is always in context, and the agent loads a specific domain's detail **on demand** via `load_skill`. Baseline per-turn input context drops ~90%, and the pattern scales cleanly as the corpus grows. Skills are **static, rebuilt at deploy** from the corpus snapshot (chosen tradeoff: corpus changes are rare and `make corpus` already snapshots at deploy; with `min-instances=0` warm instances are short-lived, so staleness is negligible).

This also makes the portfolio itself a live demonstration of ADK Skills + progressive disclosure — on-brand for an AI architect.

## Depends on
- The chat-widget agent (`portfolio-agent/`) and its retrieval tools.
- Spec 34 (post metrics) — `posts.json` shape feeds the `recent-posts` skill.
- Requires `google-adk >= 1.32.0` (Skills API present; pinned floor is `>=1.15.0` — bump floor to `>=1.32.0`).

## Routes
No new routes. (Existing `POST /api/agent-chat` unchanged.)

## Database changes
No database.

## Design

### Skill layout (filesystem, loaded via `load_skill_from_dir`)
Five skills under `portfolio-agent/app/skills/`, one per corpus domain. Each `SKILL.md` carries L1 frontmatter (`name`, `description`) + L2 instructions; bulky data lives as an L3 resource JSON fetched only when the skill is loaded.

```
portfolio-agent/app/skills/
  gaurav-profile/    SKILL.md   references/profile.json       # bio, headline, capabilities, public links
  work-history/      SKILL.md   references/work-history.json  # flattened roles (company/title/dates/skills)
  projects/          SKILL.md   references/projects.json      # DENORMALIZED from graph (company/domains/skills joined)
  recent-posts/      SKILL.md   references/posts.json         # latest LinkedIn posts + engagement
  certifications/    SKILL.md   references/certifications.json
```

| Skill | L1 description (the menu line the model scans) |
|---|---|
| `gaurav-profile` | "Gaurav's bio, headline, location, current focus, core capabilities, and public contact links." |
| `work-history` | "Gaurav's roles and employers — titles, companies, dates, locations, and skills per role." |
| `projects` | "Notable projects Gaurav has shipped — architecture, outcomes, the company/domains/skills behind each." |
| `recent-posts` | "Gaurav's most recent LinkedIn posts — his public perspectives and what he's shipped lately." |
| `certifications` | "Gaurav's certifications, badges, and competition placements." |

### Critical: resources hold *curated* data, not raw corpus
`scripts/build_skills.py` (new) regenerates each skill's `references/*.json` by **reusing the existing transform logic** in `app/tools.py` — most importantly `get_projects`'s node+edge denormalization (raw `graph.json` is unusable dumped; the joined project records are compact and grounded) and `get_work_history`'s experience→roles flattening. This preserves the curation the tools provide today and keeps L2/L3 token counts lean. The `make corpus` target calls this script so skills stay in sync with `assets/js/data/*.json`.

### Agent wiring (`app/agent.py`)
- Replace `tools=[get_profile, get_work_history, get_projects, get_recent_posts, get_certifications, send_resume, send_note_to_gaurav]` with:
  ```python
  from google.adk.skills import load_skill_from_dir
  from google.adk.tools.skill_toolset import SkillToolset
  skills = [load_skill_from_dir(p) for p in sorted((Path(__file__).parent / "skills").iterdir()) if p.is_dir()]
  skill_toolset = SkillToolset(skills=skills, additional_tools=[portfolio_tools.send_resume, portfolio_tools.send_note_to_gaurav])
  ...
  tools=[skill_toolset],
  ```
- Keep the two **action** tools (`send_resume`, `send_note_to_gaurav`) as `additional_tools` — they are behavior, not corpus.
- Confirm whether `SkillToolset` requires enabling the experimental feature flag (the import emits `[EXPERIMENTAL]`); if so, set the documented enablement (env var / `is_feature_enabled`) at import time in `agent.py` and the `Dockerfile`/deploy env.

### Remove per-turn corpus injection (`app/guardrails.py`)
- Delete `_build_corpus_block`, `_inject_live_corpus`, and the call to it in `before_model_callback`. The auto-injected `list_skills` menu replaces it.
- **Keep** all injection-defense logic (`[[META]]` stripping, prompt-injection short-circuit, URL allowlist, email redaction) — untouched.

### Instruction updates (`app/instruction.py`)
- Replace tool-name guidance that references the old `get_*` tools with skills guidance: "You have a menu of skills (see `list_skills`). Before answering anything about Gaurav's profile, roles, projects, posts, or certifications, call `load_skill` for the relevant skill and ground your answer in it. Do not answer corpus questions from memory." Keep the existing "if you don't see it in tool output, STOP" grounding rule.
- Keep the recognition/wins rule (load both `projects`/`certifications` + `recent-posts` before saying "no win found").

### Tools (`app/tools.py`)
- The five `get_*` retrieval functions are superseded by skills. Keep their transform helpers (reused by `build_skills.py`) but remove them from the agent's tool list. Action tools stay.

## Files to change
- `portfolio-agent/app/agent.py` — swap retrieval tools → `SkillToolset`.
- `portfolio-agent/app/guardrails.py` — remove corpus injection; keep defenses.
- `portfolio-agent/app/instruction.py` — retrieval guidance → skills guidance.
- `portfolio-agent/app/tools.py` — drop `get_*` from tool list; keep transforms as importable helpers.
- `portfolio-agent/Makefile` — `corpus` target also runs `build_skills.py`.
- `portfolio-agent/pyproject.toml` — bump `google-adk` floor to `>=1.32.0` (CLI owns `[tool.agents-cli]`; do not touch that block).
- `portfolio-agent/tests/eval/evalsets/portfolio.evalset.json` — extend tool-trajectory expectations to `list_skills`/`load_skill` instead of `get_*` (if the evalset asserts tool names).

## Files to create
- `portfolio-agent/app/skills/<5 dirs>/SKILL.md` + `references/*.json` (generated, but committed so deploys are reproducible).
- `portfolio-agent/scripts/build_skills.py` — regenerates SKILL.md + curated resources from `app/corpus/*.json` using `tools.py` transforms.

## New dependencies
No new dependencies. ADK Skills ships in the already-installed `google-adk 1.32.0`; only the version *floor* in `pyproject.toml` is raised.

## Rules for implementation
- **Eval gate is mandatory.** This changes retrieval behavior — run `agents-cli eval run --evalset tests/eval/evalsets/portfolio.evalset.json` and iterate (expect several rounds) until it passes BEFORE deploy. Grounding/tool-trajectory evals are the safety net against under-fetching.
- **Never change the model** (`gemini-3.5-flash`) — CLAUDE.md rule.
- **Do not hand-edit** `pyproject.toml [tool.agents-cli]` or `App(name="app")`.
- Preserve all guardrail injection defenses and the `[[META]]` contract.
- Keep `send_resume` / `send_note_to_gaurav` working exactly as today.
- Static-at-deploy freshness: skills built from the corpus snapshot; `make corpus` must run before every deploy (already required) and now also regenerates skills.
- Run Python via `uv run`.
- No npm/bundler/Node toolchain (frontend rules N/A — this is the Python agent backend; no CSS/WebGL surface).

## Definition of done
Verifiable via `agents-cli` and a deployed smoke test:
1. `agents-cli eval run --evalset tests/eval/evalsets/portfolio.evalset.json` **passes**.
2. `list_skills` appears once in the model's context (the L1 menu) and the full corpus JSON no longer appears in the system instruction (confirm via a trace/log or `before_model` inspection).
3. Measured per-turn **input tokens drop materially** vs. baseline (target: system-instruction context from ~6–8K → < 1K on a turn that needs no data; data turns add only the loaded skill).
4. Grounded answers still correct across all five domains: "who is Gaurav / capabilities" (profile), "where has he worked" (work-history), "what has he shipped" (projects, denormalized company/domain correct), "what's he writing lately" (recent-posts), "what certs / did he win X" (certifications) — each triggers a `load_skill` for the right domain.
5. `send_resume` (with email) and `send_note_to_gaurav` (message + email) still send and return the correct `[[META]]`/CTA.
6. Deploy via `make corpus && make deploy`; live smoke test against `/api/agent-chat` returns a grounded answer with citations.
7. `make deploy-ambient` unaffected (ambient agent keeps its own instruction; verify it still boots).
