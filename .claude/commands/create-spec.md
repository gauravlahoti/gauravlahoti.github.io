---
description: Create a spec file and feature branch for the next portfolio step
argument-hint: "Step number and feature name e.g. 2 hero-shader"
allowed-tools: Read, Write, Glob, Bash(git:*)
---

You are a senior developer spinning up a new feature for the
AI portfolio site. Always follow the rules in CLAUDE.md.

User input: $ARGUMENTS

## Step 1 — Check working directory is clean
Run `git status` and check for uncommitted, unstaged, or
untracked files. If any exist, stop immediately and tell
the user to commit or stash changes before proceeding.
DO NOT CONTINUE until the working directory is clean.

## Step 2 — Parse the arguments
From $ARGUMENTS extract:

1. `step_number` — zero-padded to 2 digits: 2 → 02, 11 → 11
2. `feature_title` — Title Case (e.g. "Hero Shader", "Knowledge Graph")
3. `feature_slug` — kebab-case, a-z 0-9 -, max 40 chars
4. `branch_name` — `feature/<feature_slug>`

If you cannot infer these from $ARGUMENTS, ask the user
to clarify before proceeding.

## Step 3 — Check branch name is not taken
Run `git branch` to list existing branches.
If `branch_name` is taken, append a number suffix.

## Step 4 — Switch to main and pull latest
```
git checkout main
git pull origin main 2>/dev/null || true
```
(Pull is best-effort — there may be no remote yet.)

## Step 5 — Create and switch to the feature branch
```
git checkout -b <branch_name>
```

## Step 6 — Research the codebase
Read these files before writing the spec:
- `CLAUDE.md` — project rules and conventions
- `index.html` — current shell
- `assets/css/base.css` — design tokens
- `assets/js/main.js` — entry point
- `content/*.json` — content schemas
- All files in `.claude/specs/` — avoid duplicating existing specs

## Step 7 — Write the spec
Use this structure:

---
# Spec: <feature_title>

## Overview
One paragraph: what ships and why at this stage.

## Depends on
Which previous specs this requires.

## Routes
"No backend." (Always — static site.)

## Database changes
"No database." (Always.)

## Templates
- **Create:** list new files with paths
- **Modify:** list existing files and what changes

## Files to change

## Files to create

## New dependencies
CDN-loaded only. Pin versions. If none: "No new dependencies".

## Rules for implementation
Always include:
- All identity content lives in `content/profile.json`.
- CSS variables only — never hardcode hex.
- One JS module per visualization; lazy-load on viewport entry.
- No npm, no bundler, no Node toolchain.
- Respect `prefers-reduced-motion`.
- Mobile fallbacks for every WebGL/Three.js feature.

## Definition of done
Testable checklist verifiable in a browser.
---

## Step 8 — Save the spec
Save to: `.claude/specs/<step_number>-<feature_slug>.md`

## Step 9 — Report to the user
```
Branch:    <branch_name>
Spec file: .claude/specs/<step_number>-<feature_slug>.md
Title:     <feature_title>
```

Then tell the user:
"Review the spec at `.claude/specs/<step_number>-<feature_slug>.md`
then run `/implement-spec <step_number>` to begin."

Do not print the full spec in chat unless explicitly asked.
