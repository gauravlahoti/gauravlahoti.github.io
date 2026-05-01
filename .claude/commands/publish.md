---
description: Commit, push, and trigger GitHub Pages deploy
argument-hint: "Optional commit message"
allowed-tools: Bash(git:*), Bash(gh:*), Read
---

Stage and ship the current changes to GitHub. Only run after
spec 09 has set up the deploy workflow — until then, this
command will refuse.

User input: $ARGUMENTS — optional commit message.

## Step 1 — Pre-flight checks
- `git status` must show changes (else nothing to publish).
- A `.github/workflows/deploy.yml` must exist (else spec 09
  hasn't shipped; refuse and tell the user to run
  `/implement-spec 09` first).
- The current branch must be `main` (else refuse and ask the
  user to merge first).
- `git remote -v` must include `origin` (else refuse and tell
  the user to set the remote).

## Step 2 — Show the diff
Print `git status` + `git diff --stat` so the user sees what
they're publishing.

## Step 3 — Commit
If $ARGUMENTS contains a message, use it. Otherwise, infer a
short message from the diff (look at which sections / data
files changed).

Stage only files explicitly listed in `git status` (not
`git add .`) to avoid sweeping in stray files.

Use the project's commit footer:

```
git commit -m "<message>" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

## Step 4 — Push
`git push origin main`.

## Step 5 — Watch the deploy
Print the GitHub Actions URL (extract repo from
`origin`). Run `gh run watch` if `gh` is available; else tell
the user to check the Actions tab.

## Step 6 — Report
Once the deploy completes, print the live URL (custom domain
if set, else `<user>.github.io/<repo>`). If the deploy fails,
print the failing log line and stop — don't auto-retry.
