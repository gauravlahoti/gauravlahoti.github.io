---
name: update-tech
description: Update all CLI tools and agent dependencies to their latest versions. Use when you want to keep google-agents-cli, uv tools, and the google-adk dependency in atlas/pulse current.
argument-hint: ""
context: fork
allowed-tools: Bash, PowerShell, Read, Edit, Glob
---

Keep all project tooling current. Run each step in order, report what changed.

## Step 1 — Upgrade all uv tools

```
uv tool upgrade --all
```

Capture the output. Note any tool that actually bumped its version (lines with `->` in them).

## Step 2 — Find latest google-adk

```
pip index versions google-adk 2>&1 | head -2
```

Extract the latest stable version (first on the list).

## Step 3 — Update google-adk constraint in both agents

Read `agents/atlas/pyproject.toml` and `agents/pulse/pyproject.toml`.

In each file, update **both** occurrences of the `google-adk` version constraint (the main dep and the eval optional dep) so the lower bound matches the latest version and the upper bound is the next major:

```
"google-adk>=X.Y.Z,<(X+1).0.0"
"google-adk[eval]>=X.Y.Z,<(X+1).0.0"
```

Skip this step if the files already use the latest version.

## Step 4 — Regenerate lock files

For each agent whose pyproject.toml changed:

```
cd agents/atlas && uv lock --upgrade-package google-adk
cd agents/pulse && uv lock --upgrade-package google-adk
```

## Step 5 — Summary

Print a table:

| Tool / Package | Before | After |
|----------------|--------|-------|
| google-agents-cli | old | new |
| google-adk (atlas + pulse) | old | new |
| (any other uv tool that bumped) | old | new |

If nothing changed, say so clearly.
