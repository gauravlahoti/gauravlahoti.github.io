---
description: Commit feature-branch work, open a PR, squash-merge to main, delete the branch
argument-hint: "Optional commit/PR title. Otherwise inferred from branch name + diff."
allowed-tools: Bash, Read
---

You are shipping a feature branch end-to-end. The user is on a
`feature/<slug>` branch with work ready to merge into `main`.
This command commits any uncommitted work, pushes, opens a PR,
squash-merges, and deletes both the remote and local branch.

User input: $ARGUMENTS — optional title for the commit / PR.
If empty, derive from the branch slug + diff summary.

## Step 0 — Preflight

Run all checks in parallel:
- `git rev-parse --is-inside-work-tree` (must be `true`)
- `git branch --show-current` → capture as `BRANCH`
- `git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null` (does upstream exist?)
- `git remote get-url origin`
- `gh auth status`
- `git status --porcelain`

Fail fast with a clear message if any of these is broken. Do
not attempt to fix gh-auth or add a remote — tell the user.

Refuse with a hard error if `BRANCH == main` (or `master`).
This command is for shipping a feature branch only.

If `BRANCH` doesn't start with `feature/`, warn but ask the
user once whether to proceed (some workflows use other
prefixes). Don't loop.

## Step 1 — Sync main reference

Run `git fetch origin main` so we know what main looks like
right now. If `BRANCH` is behind `main` (i.e. main has commits
not on this branch), refuse and tell the user to rebase first:

```bash
git fetch origin main
git rebase origin/main
```

Don't auto-rebase — conflicts here mean human judgment.

## Step 2 — Commit any uncommitted work

If `git status --porcelain` is empty, skip to Step 3.

Otherwise:
- `git status --short` and `git diff --stat` to see what's
  changed.
- Detect files that should NOT be committed (`.env*`,
  `*.pem`, `*credentials*`, `id_rsa`, `*.key`). If any are in
  the diff, refuse and ask the user.
- Stage with **explicit paths**, not `git add .` (avoid
  sweeping in untracked secrets):
  - For modifications + deletions: `git add -u`
  - For known-good untracked files (e.g. new spec/code files
    listed in the diff): add by name. Don't blindly add
    everything untracked.
- Build a commit message:
  - **Title**: `$ARGUMENTS` if provided. Otherwise infer from
    the branch slug. For `feature/03-terminal` → "feat:
    implement spec 03 terminal". For `feature/<slug>` with
    no spec number → "feat: <slug humanized>".
  - **Body**: a 2–4 line summary of what changed, derived
    from `git diff --stat` and the file paths. Keep it
    factual — what files / features, not narrative.
  - Trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- Commit via heredoc:
  ```bash
  git commit -m "$(cat <<'EOF'
  <title>

  <body>

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```
- If the commit fails (pre-commit hook): stop. Do not retry
  with `--no-verify`. Report the hook output to the user.

## Step 3 — Push the branch

- If upstream is set: `git push`.
- Else: `git push -u origin <BRANCH>`.

If push is rejected (non-fast-forward), refuse — tell the user
to investigate. Don't `--force`.

## Step 4 — Open or reuse a PR

Check for an existing PR for this branch:

```bash
gh pr view --json number,state,url 2>/dev/null
```

If one exists and is `OPEN`, capture its URL and skip
creation.

Otherwise create a new PR:
- **Title**: same as the commit title.
- **Body**: include `## Summary` (the commit body) and a
  `## Test plan` checklist appropriate to the feature. For
  spec implementations, mirror the spec's "Definition of
  done" as the checklist.
- `gh pr create --base main --head <BRANCH> --title "..." --body "$(cat <<'EOF' ... EOF)"`

Capture the PR URL.

## Step 5 — Merge

Squash-merge with branch deletion:

```bash
gh pr merge --squash --delete-branch --auto=false
```

`--auto=false` forces an immediate merge attempt — this command
is interactive shipping, not "queue when checks pass." If
required checks haven't run / passed, `gh` will refuse; surface
that error to the user verbatim.

If merge succeeds: the remote branch is already deleted by
`--delete-branch`.

## Step 6 — Local cleanup

- `git checkout main`
- `git pull --ff-only origin main` — fast-forward only; if
  this fails, the local main has diverged and the user needs
  to look at it manually.
- `git branch -D <BRANCH>` — force-delete the local feature
  branch (it's safely merged on origin).

## Step 7 — Report

Print a final block:

```
Branch:  <BRANCH>
PR:      <url>  (squash-merged)
Commit:  <new main HEAD short SHA + title>
Local:   on main · branch deleted
Remote:  origin/main updated · feature branch deleted
Next:    /create-spec for the next step  |  /run-site to verify  |  /publish to deploy
```

If anything failed mid-flight (push rejected, PR conflict,
merge blocked by checks): stop where you are, do NOT continue
to subsequent steps, and report:

```
Branch:  <BRANCH>     (still checked out)
Status:  blocked at step <N> — <reason>
Fix:     <concrete next-action for the user>
```

## Safety rules

- Never `git push --force` or `--force-with-lease` from this
  command.
- Never use `--no-verify` to skip hooks.
- Never `git add .` or `git add -A` — always specify paths.
- Never run `gh pr merge` against `main` directly.
- Never delete a branch that hasn't been merged on origin.
- If at any step the user's working tree is dirty in
  unexpected ways (untracked binaries, large files, secrets),
  STOP and ask.
