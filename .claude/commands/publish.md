---
description: Validate prereqs, commit, push to main, and watch the GitHub Pages deploy
argument-hint: "Optional commit message"
allowed-tools: Read, Bash(git:*), Bash(gh:*), Bash(node:*), Bash(python3:*), Bash(test:*), Bash(ls:*), Bash(cat:*), Bash(grep:*), Bash(find:*)
---

Ship pending work to GitHub Pages safely. Walk every pre-flight check;
refuse on the first hard failure rather than pushing a broken site.

User input: $ARGUMENTS — optional commit message.

## Step 0 — Discover context

Run in parallel:
- `git rev-parse --abbrev-ref HEAD` → current branch
- `git remote get-url origin` → origin URL (extract `<owner>/<repo>` from
  `https://github.com/<owner>/<repo>.git` or `git@github.com:<owner>/<repo>.git`)
- `test -f CNAME && cat CNAME` → custom domain (if any)
- `git fetch origin main --quiet` → refresh remote ref (best-effort)

Compute the live URL:
- If `CNAME` exists → `https://<contents of CNAME>/`
- Else if repo == `<owner>.github.io` → `https://<owner>.github.io/`
- Else → `https://<owner>.github.io/<repo>/`

Hold these for later steps.

## Step 1 — Hard pre-flight (refuse on any failure)

Run all checks, collect failures, then refuse with a single block listing
every failure. Don't bail on the first one — the user wants a full punch
list, not whack-a-mole.

| # | Check | How |
|---|---|---|
| 1.1 | On `main` | current branch is `main`; if not, tell user to merge their feature branch first via `/ship` |
| 1.2 | `origin` remote configured | `git remote -v` lists `origin` (fetch + push) |
| 1.3 | Deploy workflow present | `.github/workflows/deploy.yml` exists. If missing, tell user to run `/implement-spec 09` |
| 1.4 | `.nojekyll` present | `test -f .nojekyll`. Without it, GH Pages runs Jekyll and silently drops `_`-prefixed paths |
| 1.5 | Local in sync with `origin/main` | `git status -sb` mentions `[ahead N]` only (or clean). If `[behind]` or diverged → refuse and tell user to `git pull --rebase origin main` and resolve manually |
| 1.6 | Working tree has something to publish | either staged/unstaged changes, or unpushed commits ahead of `origin/main` (`git rev-list --count origin/main..HEAD > 0`). If neither, exit with "Nothing to publish." (success, not failure) |
| 1.7 | No untracked junk | `git status --porcelain` should not list `.DS_Store`, `*.tmp`, `*.bak`, `*.swp`, or anything inside `node_modules/`. If found, tell user to add to `.gitignore` or delete |

If any of 1.1–1.5, 1.7 fail, **refuse** — print the failures, exit. The
user fixes and re-runs.

## Step 2 — Content health (refuse on any failure)

Run all in parallel and collect results.

### 2.1 — All data JSON files parse

For each file in `assets/js/data/*.json`:
```
python3 -c "import json,sys; json.load(open(sys.argv[1]))" <file>
```
Any non-zero exit → refuse, naming the file + parse error.

### 2.2 — JS modules pass syntax check

For each `assets/js/*.js`, `assets/js/data/*.js` (none expected, defensive),
and `scripts/*.mjs`:
```
node --check <file>
```
Any failure → refuse, naming the file + line number from stderr.

### 2.3 — No obvious placeholder content shipped

Grep `assets/js/data/posts.json` for substrings the helper script never
writes but the seeded placeholders did:
- `Sample post — replace via`
- `accordion expand/collapse demo`
- `keyboard navigation works`

If any match, **warn loudly** but don't refuse — the user may have a
deliberate reason. Print the offending lines and ask via `AskUserQuestion`:
"Placeholder text detected. Continue anyway?" Default option is "No, cancel
publish."

## Step 3 — Cache-bust sanity (warn only)

Find files staged or modified under `assets/css/` or `assets/js/` (excluding
`assets/js/data/`):
```
git diff --name-only HEAD origin/main -- 'assets/css/' 'assets/js/' ':!assets/js/data/'
```

If any matched AND `index.html`'s `?v=` query string did NOT change between
`HEAD` and `origin/main` (`git diff origin/main HEAD -- index.html | grep -E '\?v='`),
**warn**:

> Asset code changed but `?v=N` in `index.html` was not bumped. Visitors
> with the previous CSS/JS cached will see stale code until they hard-refresh.
> Bump every `?v=N` in `index.html` (and `ASSET_VERSION` in `assets/js/main.js`)
> before continuing.

Ask via `AskUserQuestion`: "Bump the asset version now, continue without
bumping, or cancel?" If "bump now" — read `index.html` and `assets/js/main.js`,
identify the current version, bump by 1, write back. Then continue.

## Step 4 — Show what's shipping

```
git status -sb
git diff --stat HEAD origin/main
git log --oneline origin/main..HEAD
```

Print a one-line summary: `Shipping: <N files>, <M unpushed commits>`.

## Step 5 — Stage + commit (only if there are working-tree changes)

If `git status --porcelain` is empty (clean tree, only unpushed commits),
skip to Step 6.

Otherwise:
- Stage **only files explicitly listed in `git status`**, by name. Do not
  use `git add .` or `git add -A`. (Avoids sweeping in files just escaped
  the `.gitignore` net.)
- Compose commit message:
  - If `$ARGUMENTS` is non-empty, use it as the subject.
  - Else infer from the diff: e.g. "update posts.json" if only data changed,
    "tweak Perspectives styling" if components.css changed, etc. Aim for
    one concise sentence (≤ 70 chars).
- Commit:
  ```
  git commit -m "<subject>" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
  ```

If the commit fails (pre-commit hook etc.), **refuse** — show the failure
and stop. Do not retry with `--no-verify`.

## Step 6 — Push to `origin/main`

```
git push origin main
```

If push is rejected (remote has new commits), refuse and tell the user to
`git pull --rebase origin main` and re-run.

## Step 7 — Watch the deploy

Capture the run ID of the freshly-triggered workflow:
```
sleep 3
gh run list --workflow=deploy.yml --branch=main --limit=1 --json databaseId,status,url
```

If `gh` is available:
- Print the run URL.
- `gh run watch <run-id> --exit-status` to follow until completion.
- On non-zero exit: pull the failing log line(s) via
  `gh run view <run-id> --log-failed | tail -40` and print them. Stop —
  don't retry.

If `gh` is not on PATH, print the Actions URL and ask the user to watch
manually:
```
https://github.com/<owner>/<repo>/actions/workflows/deploy.yml
```

## Step 8 — Report

Once deploy succeeds, print:

```
✓ Deployed.

  Live:    <live-url>
  Run:     <run-url>
  Commit:  <sha (short)>
```

Hint a 30–60s propagation delay if a custom domain is in use (CDN cache).

## Step 9 — Notes

- **Don't** force-push, `--no-verify`, or `--amend` an already-pushed commit.
- **Don't** edit `.github/workflows/deploy.yml` from this command. Workflow
  changes go through a normal feature branch + `/ship`.
- Tell the user if there's anything specific to verify in the browser
  (e.g. a new section, new dataset) — pull the relevant snippet from the
  most recent commit subject.
