# Spec 58 — Atlas knows how this site was built

**Status:** Implemented
**Date:** 2026-09-14
**Branch:** `58-atlas-build-story`

## Why

A visitor asked Atlas: *"Which Anthropic certifications does Gaurav have, and what did he build with them?"*

Atlas answered with the four badges and one project, the Agentic RAG Lab. The honest answer is that he built the site the visitor was standing on, its backend, and the agent that was answering them, spec-driven with Claude Code. Atlas could not say that, because none of it is in its corpus.

Atlas's knowledge was exactly four files: `profile.json`, `graph.json`, `posts.json`, `agents.json`. `graph.json` holds four client projects and has no node for the portfolio itself. The entire build narrative lived in places the agent cannot reach: 8 `CLAUDE.md` files, 53 specs, 8 skills, 6 slash commands, 2 reference docs.

Two smaller gaps compounded it:

1. **The AI Labs were invisible.** `ai-concepts.json` was not in the corpus, so Atlas could not mention the MCP Lab, Engineering Loops, Agent-Ready Web or the RAG Lab at all.
2. **`get_live_agents()` was discarding the best data it had.** `agents.json` carries a `techDecisions` list per agent (why ADK, why a tiered model cascade, why voice bypasses the agent loop). The tool returned only name/role/status/headline/description/value/stack/liveUrl. The rationale was written, live, and dropped on the floor.

## What shipped

### New content

`content/build-story.json` — corpus-only, no page renders it. Holds `summary`, `stats`, `method`, `harness`, `highlights`, `constraints`, `sourceUrl`.

Framing is **proof of craft**: the site is the portfolio piece, not the frame around it. The `highlights` deliberately include the unflattering parts, because they are what makes it read as real engineering rather than tool worship:

- Spec 46 exists because a visitor got Atlas to write them a Python function.
- Spec 51 tried the free keep-warm ping first, and only escalated to a paid minimum instance when it kept failing.
- Spec 45 cut the WebMCP registry from 13 tool definitions to 5.
- Spec 55 shipped text/audio sync; spec 57 reversed it.
- Spec 54 is a postmortem for a rollup table a migration never created.

`stats` carries an `asOf` date. Atlas is instructed to quote the numbers as-of rather than as-live, and never to round up. `scripts/refresh-build-stats.mjs` recounts commits, specs, skills, commands, subagents and CLAUDE.md files from the repo and rewrites only the `stats` block, leaving the hand-written prose alone. It is deliberately **not** wired into `/publish`: a content edit should not silently rewrite prose the agent cites.

### Corpus additions

`build-story.json` and `ai-concepts.json` joined the corpus. `ai-concepts.json` is reused as-is rather than duplicating lab copy into the build story, so **adding a lab to the hub now teaches Atlas automatically**.

### Two new tools

- `get_build_story()` — the workflow, the harness, the numbers, the constraints.
- `get_ai_labs()` — the four labs, with site-relative `href` values resolved to absolute URLs **server-side**, so the model never assembles a portfolio URL itself.

And `get_live_agents()` gained an `agent_name` filter that both narrows to one agent **and** returns its `techDecisions` and `steps`.

The detail is opt-in for a measured reason. Returning the rationale for all four agents unconditionally took the payload from ~1,100 to ~4,600 tokens, a 4x jump on a tool that answers plenty of questions ("which agents has he shipped?") that never need it. Narrowing to one agent costs ~1,500 and leaves the common path exactly as cheap as before. This follows the filter-parameter idiom already used by `get_work_history(role_filter)` and `get_projects(domain)`. An unmatched name falls back to the full list rather than returning empty, so a near-miss does not leave the model with nothing.

### Prompt changes (`instruction.py`)

Five surgical edits plus two worked examples. The notable ones:

- **Scope carve-out.** The existing rule bans stand-alone explainers of a field, which would have suppressed lab answers. The line drawn: describing *a lab Gaurav built* and linking it is in scope, because the lab is his artifact. Explaining MCP generically is still out, and the right move is to hand over the lab rather than decline flat.
- **Links section.** Resolved a live contradiction: the prompt told Atlas the portfolio domain was "bare root ONLY, never append a path" while a section nine lines earlier told it to emit `/#insights` and `/live-agents/`. Replaced with an explicit short path allowlist.

### Guardrail hardening (`guardrails.py`)

`_HALLUCINATED_PORTFOLIO_PATH_RE` stripped only paths matching `.pdf|/resume|/download|/file`. Every other invented path on `gauravlahoti.dev` passed. Replaced with a **positive prefix allowlist**: root, `/#…`, `/live-agents…`, `/ai-labs…` survive; everything else is stripped.

This widens and tightens in the same change. Lab links now work, and the hole that let `gauravlahoti.dev/anything-at-all` through is closed. The streaming chunk-boundary guard is preserved, so a half-arrived `/ai-labs/…` is not judged on its prefix.

### Discovery

Post-reply suggestion chips are feature-flagged off (`agent-widget.js:17`), so the model's `suggestions` array does not render. Discovery had to come from the opening starter chips, so `profile.json → agentPrompts` gained `"How was this site built?"` as the first of four.

## Definition of done

- [x] `content/build-story.json` is valid JSON and free of em-dashes per the copy rules.
- [x] Stats in the file match what `scripts/refresh-build-stats.mjs --print` computes.
- [x] `make corpus` syncs both new files into `app/corpus/`.
- [x] `get_build_story()` and `get_ai_labs()` are registered and callable.
- [x] Every URL `get_ai_labs()` returns survives `_strip_disallowed_urls`.
- [x] An invented path such as `gauravlahoti.dev/made-up` is still stripped.
- [x] `get_live_agents(agent_name="atlas")` returns `techDecisions`; the unfiltered call stays slim.
- [x] Unit + integration suites pass (119).
- [x] Eval cases added for the five new behaviours.
- [x] `make eval` green: **29/29 cases, 0 errors** — `atlas_response_quality` mean 0.978, `atlas_tool_use_quality` mean 1.000. All five new cases scored 1.000 on both metrics, and the 24 pre-existing cases still pass, so the new tools did not perturb routing.
- [ ] Deployed, with explicit approval.

> The grade phase hung once (6+ hours, no output, killed) and then completed clean on an identical re-run with no code change in between. A stalled `Step 2/2: eval grade` is a judge-side stall, not a signal about the agent. Re-run before investigating.

## Notes for later

- **The visible thinking panel is very verbose, and it is not this spec's doing.** During verification it produced multi-paragraph notes with markdown headings and numbered lists ("**My Thought Process on AWS Certification Data Retrieval**", then five numbered sections) where the instruction asks for 1-3 sentences naming the tool. Confirmed pre-existing by running `get_certifications`, an untouched path and an existing eval case, which reproduced it identically. Worth its own spec; the prompt already spends a lot of words fighting this and is losing.
- One real regression **was** introduced here and fixed: `get_ai_labs()` initially pulled the model into first person about Gaurav's work in its thinking ("the AI Labs I've built", "on my site"). Standing on the artifact being discussed is a stronger pull than the existing warnings covered. Fixed by naming that case explicitly in the third-person rule and in both new tool docstrings, then re-verified.
- `app/corpus/resume.md` is read into `_RESUME_MD` at `tools.py` import and used by nothing. It is dead weight and predates the live-corpus design. Left alone here rather than widening this spec's blast radius.
- Because retrieval is live, editing `build-story.json` on the site reaches Atlas within the TTL with **no redeploy**. Only the tool additions in this spec needed one.
