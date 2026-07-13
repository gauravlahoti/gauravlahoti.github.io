---
name: loop-to-done
description: Run a goal as a supervised loop until a machine-checkable Definition of Done passes. Resolves the done-rule from a spec, audit, eval, content-health, repo invariants, or a LinkedIn post draft (or pins one with you), then loops do → check → fix, skipping checks that already pass and re-running only failures, under Loop Training Mode. Training mode defaults ON. Examples - "loop until spec 42's definition of done passes", "run audit to green", "loop-to-done content-health", "keep fixing until npm audit is clean", "loop-to-done invariants training=off", "loop the LinkedIn post to done".
argument-hint: "<spec-NN | audit | content-health | invariants | eval | linkedin-post | \"free-text goal\"> [training=off]"
context: fork
allowed-tools: Bash, Read, Grep, Edit, AskUserQuestion, Skill, Agent
---

Run a goal as a **supervised loop until a machine-checkable Definition of
Done passes**. This skill's whole job is to first *determine* the done-rule,
then loop `do → check → fix` until it's met — skipping checks that already
pass, re-running only the ones that fail, and capping retries.

User input: `$ARGUMENTS` — a target (`spec-NN`, `audit`, `content-health`,
`invariants`, `eval`, or a free-text goal) plus optional `training=off`.

## Core rule — never loop blind

A loop is only allowed once there is **at least one machine-checkable
done-rule** (a shell command with a clear pass condition). If the target
can't be resolved to one and you can't author one, **stop and ask the user
to state a checkable rule**. Iterating without a done-rule is the failure
mode this skill exists to prevent.

## Loop Training Mode

Default **ON**. Turn it off only when `$ARGUMENTS` contains `training=off`
(`training=on` forces ON).

- **ON** — before touching anything, evaluate each check's done-rule; if it
  already passes, mark **SKIP**. For a failing check, **pause** with
  `AskUserQuestion` (Approve fix / Skip / Abort) showing the concrete fix you
  intend, and apply it only on approval. Re-check after. If it still fails,
  re-run **only that check** up to the retry cap, then ask again (retry /
  skip / abort).
- **OFF** (`training=off`) — no per-step prompts. Apply fixes autonomously,
  but **still** evaluate every done-rule and honour the retry cap. When a
  check's cap is exhausted, mark it **BLOCKED** and move on (don't spin).
- **Both modes** — skip checks that already pass, re-run only failures, cap
  retries. Default cap **3** per check; the `eval` target is capped at **1**
  (protects the Gemini judge quota).

## Step 0 — Parse args + announce

- Resolve the **target** (first token) and the **mode** (ON unless
  `training=off` is present).
- Print one line before doing anything:

```
Loop Training Mode: <ON | OFF>   Target: <target>
```

## Step 1 — Determine the Definition of Done

Resolve the target to concrete check(s). Each check = a command + a pass
condition. Use this resolver:

| Target | Checks (command → pass condition) |
|---|---|
| `audit` | For each of `backend/`, `resend_mcp_server/`: `npm --prefix <dir> audit` → **0 vulnerabilities**. (`resend_mcp_server` may need `npm --prefix resend_mcp_server install` first — no lockfile.) |
| `content-health` | (a) each `content/*.json`: `python3 -c "import json,sys;json.load(open(sys.argv[1]))" <f>` → exit 0. (b) each `assets/js/*.js` and `scripts/*.mjs`: `node --check <f>` → exit 0. (c) `grep -nF` on `content/posts.json` for `Sample post — replace via`, `accordion expand/collapse demo`, `keyboard navigation works` → **0 matches**. |
| `invariants` | (a) no hardcoded hex *values* (token **definitions** `--x: #hex` are allowed): `grep -rnE '#[0-9a-fA-F]{3,8}\b' assets/css --include='*.css' \| grep -v 'base.css' \| grep -vE -- '--[A-Za-z0-9_-]+:[[:space:]]*#'` → **0 hits**. (b) no em-dash in copy: `grep -nF '—' content/*.json` → **0 hits**. (c) JS budget: `gzip -c assets/js/*.js \| wc -c` → **< 409600** bytes. |
| `eval` | `make -C agents/atlas eval` → exit 0 (rubric ≥ 0.85). **Warn first**: it needs a Gemini key and burns judge quota. Retry cap 1. |
| `spec-NN` | Read `.claude/specs/NN-*.md`, take the `## Definition of done` section, and **classify every line** (see below). |
| `linkedin-post` | Draft (path or pasted text) must pass a **fresh independent review pass** — spawn a new `general-purpose` agent via the Agent tool (never `fork`, never the same run that wrote/revised the draft) and hand it `.claude/skills/loop-to-done/linkedin-post-checklist.md` plus the current draft. Pass condition: the reviewer reports **zero violations** across all four criteria in that file (voice, fact-check, structure, length/format). This is the durable done-rule for *any* LinkedIn post loop — don't re-derive it per request, just point at the checklist file and swap in the draft under review. |
| free-text goal | No pre-wired rule. `AskUserQuestion`: "State a checkable done-rule (a command + pass condition) for this goal, or cancel." If the user can't, **stop** — do not loop. |

**Spec DoD classification** — for each bullet/checkbox under `## Definition
of done`, decide:
- **machine-checkable** → attach a concrete check (`grep`/`node --check`/JSON
  parse/`curl -fsS <url>`/file-exists). E.g. "no em-dashes in copy" → the
  `invariants` (b) grep; "`/ai-concepts/` lists the card" → `grep` the JSON.
- **browser/visual-only** (animation, "looks right", interaction feel) → tag
  **NEEDS-HUMAN**; it is never auto-passed.

Print the resolved checklist before looping. If **zero** machine-checkable
checks resolved, invoke the core rule (stop / ask).

## Step 2 — Baseline

Run every resolved check once. Record PASS / FAIL per check. If **all** pass,
report the green scoreboard and exit with "already done — nothing to loop".

## Step 3 — The loop

Walk the failing checks in order. For each:

1. Propose a fix. Delegate where a tool already exists:
   - `audit` → `npm --prefix <dir> audit fix` (then re-audit).
   - `spec-NN` → invoke `/implement-spec NN` via the Skill tool for the
     implementation work.
   - `linkedin-post` → targeted `Edit` addressing only the violation(s) the
     reviewer named (see "Fix delegation" in the checklist file); for a
     voice/tone rewrite, route through the `linkedin-post-writer` skill
     instead of hand-editing prose.
   - everything else → targeted `Edit`s (fix the hex, remove the em-dash,
     trim/split the JS, correct the JSON).
2. Apply it per the mode (ON = gated by `AskUserQuestion`; OFF = directly).
3. Re-run **only that check**. On pass → advance. On fail → retry to the cap,
   then (ON) ask retry/skip/abort or (OFF) mark **BLOCKED** and advance.

**Never re-run a check that already passed.** Never touch prod, push, or
deploy from inside the loop.

## Step 4 — Report scoreboard

```
loop-to-done — <target>   (mode: <ON|OFF>)

  <check name>            <PASS | SKIP | FAIL | BLOCKED | NEEDS-HUMAN>  (retries: n)
  ...

  Done: <YES | NO>   (YES only if every machine-checkable check passes)
```

List every **NEEDS-HUMAN** item explicitly for manual sign-off. If anything
is BLOCKED, name the last error line so the user can pick it up.

## Notes

- **Loop-safe targets** are the local, no-side-effect ones: `audit`,
  `content-health`, `invariants`, spec verification, and `linkedin-post`
  (edits a draft file only, never posts to LinkedIn). `eval` is heavier
  (quota) — cap 1 and warn.
- `linkedin-post` reviewer passes call WebSearch/WebFetch and spawn a fresh
  sub-agent each check — real cost, just not prod risk. Don't re-check a
  criterion that already passed.
- This skill **never deploys or pushes**. After it's green, run `/publish`
  yourself — deploy stays human-gated. (That's exactly why `publish`/`ship`
  and `run-ambient-digest` are *not* loop targets: they mutate prod or send
  email, so they fail the "can afford waste" test and must stay manual.)
- Recurrence is out of scope — that belongs to Cloud Scheduler or the
  built-in `/loop` and `/schedule`. This skill governs one supervised *run*
  to a done-rule, not a cadence.
