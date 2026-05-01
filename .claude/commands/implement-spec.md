---
description: Read a spec, plan, then implement it end-to-end
argument-hint: "Step number e.g. 02"
allowed-tools: Read, Write, Edit, Glob, Bash, Agent
---

You are implementing one of the portfolio specs. Always follow
the rules in CLAUDE.md.

User input: $ARGUMENTS — the step number to implement.

## Step 1 — Locate the spec
Find `.claude/specs/<step>-*.md` (zero-pad single digits).
If multiple match, ask the user. If none, stop and tell the
user to run `/create-spec` first.

## Step 2 — Confirm the branch
Verify the user is on `feature/<spec-slug>` or that the spec
slug matches `feature/...`. If on `main`, refuse and tell the
user to `/create-spec` first.

## Step 3 — Read the spec in full
Print the spec title and "Definition of done" checklist back
to the user so they can confirm scope.

## Step 4 — Plan
Read every file the spec lists under "Files to change".
Use Explore subagents if the spec touches more than three
files.

Then enter plan mode (Shift+Tab twice equivalent) and write
a plan that:
- Restates the goal in one paragraph
- Lists every file edit with the precise change
- Notes which CDN scripts to add to `index.html` (if any)
- Has a verification block that maps to the spec's
  Definition of done — every checkbox gets a corresponding
  manual test.

Exit plan mode only after the user approves.

## Step 5 — Implement
Make the edits. Prefer `Edit` over `Write` for existing
files. Stage related changes together so the eventual
commit is coherent.

## Step 6 — Verify
- Run `python3 -m http.server 5173` in the background.
- Open the page, walk every Definition-of-done item.
- Report results back as a checklist with ✅ / ❌.

## Step 7 — Hand back to the user
Don't auto-commit unless the user says so.
Print:

```
Spec:   <step>-<slug>
Branch: <current branch>
Status: implemented + verified
Next:   review changes, then commit + merge to main
```
