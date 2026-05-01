---
description: Read a spec file end-to-end, plan, then implement it step by step
argument-hint: "Spec file path or step number, e.g. .claude/specs/03-terminal.md or 03"
allowed-tools: Read, Write, Edit, Glob, Bash, Agent, TaskCreate, TaskUpdate, TaskList
---

You are implementing one of the portfolio specs. Always follow
the rules in CLAUDE.md.

User input: $ARGUMENTS — either a path to a spec file or a step
number (zero-padded or not).

## Step 1 — Resolve the spec file

Resolve `$ARGUMENTS` to an absolute spec path:

- If it points at an existing file → use that path directly.
- If it's a bare number (e.g. `3`, `03`, `09`) → zero-pad it
  and `Glob` `.claude/specs/<NN>-*.md`. If exactly one
  matches, use it. If multiple match, ask the user. If none,
  stop and tell the user to run `/create-spec` first.
- If it's neither → tell the user the input couldn't be
  resolved and show the available specs in `.claude/specs/`.

Print the resolved path back to the user before continuing.

## Step 2 — Read the spec in full

Use the `Read` tool on the resolved path. Print:

- **Title** (the H1)
- **Depends on** block
- **Files to change** list (paths only)
- **Files to create** list (paths only)
- **Definition of done** checklist (verbatim)

This confirms scope. Stop here only if the spec is empty or
malformed.

## Step 3 — Confirm the branch

Run `git branch --show-current`. If on `main` and the user
hasn't explicitly opted to implement straight on `main`, refuse
and tell them to run `/create-spec <step>` first to get a
feature branch. Otherwise proceed.

## Step 4 — Read every "Files to change" + "Files to create"

For each path the spec lists, read the current file (or note
if it doesn't exist yet for `create` entries). If the spec
touches more than three files, dispatch a single `Explore`
subagent to bring back a structured summary instead of reading
each file individually — keep the main thread lean.

## Step 5 — Plan

Enter plan mode and write a plan that:

- Restates the goal in one paragraph
- Lists every file edit with the precise change (one bullet
  per file, naming the section / function / selector touched)
- Names any CDN scripts to add to `index.html`
- Maps each Definition-of-done checkbox to a concrete
  manual-verification step

Exit plan mode only after the user approves the plan.

## Step 6 — Track work as discrete tasks

Once the plan is approved, call `TaskCreate` once per
implementation step (typically: one task per file edit, plus
one for "verify"). Mark `in_progress` before starting each
task and `completed` immediately when it finishes — don't
batch updates. This keeps progress visible and makes it
obvious which step blew up if something fails.

## Step 7 — Implement step by step

Work through the task list in order:

- Prefer `Edit` over `Write` for existing files (smaller
  diffs, cheaper to review).
- Use `Write` only for genuinely new files or full rewrites.
- After each file edit, sanity-check with the relevant tool
  (`node --check` for JS, `python3 -c "import json; json.load(open(...))"` for JSON,
  `curl` for served assets).
- Stage related changes together so the eventual commit is
  coherent. Don't commit unless the user explicitly says so.

If a step fails, stop and report — do not silently proceed to
the next task.

## Step 8 — Verify against the Definition of done

- If a static server isn't already on `:5173`, boot one in the
  background: `python3 -m http.server 5173`.
- Walk every Definition-of-done checkbox in order. For each:
  describe what you did to test it and mark `✅` / `❌`.
- For visual / interactive items you can't verify from the
  CLI, say so explicitly ("requires manual browser check at
  http://localhost:5173/#<anchor>") rather than claiming
  success.

## Step 9 — Hand back to the user

Print:

```
Spec:    <resolved path>
Branch:  <current branch>
Tasks:   <completed>/<total>
Status:  implemented + verified  |  implemented (manual checks pending)  |  blocked
Next:    review the diff, then commit + merge to main
```

If anything is `❌` or pending manual verification, list those
items under `Next:` so the user knows exactly what's open.
