---
description: Add a new project node to graph.json
argument-hint: "Project slug e.g. rag-cms"
allowed-tools: Read, Write, Edit, Bash(git:*)
---

Add a project to the portfolio dataset. Adding a new project
should not require touching any code, just JSON.

User input: $ARGUMENTS — the project slug (kebab-case).

## Step 1 — Validate slug
Slug must be lowercase, kebab-case, a-z 0-9 -, max 40 chars.
If invalid, ask the user to fix.

## Step 2 — Check for duplicates
Read `content/graph.json`. If a node with that `id`
already exists, ask whether to update it instead of adding.

## Step 3 — Gather missing fields
Ask the user (one AskUserQuestion call) for:
- Project name (display label)
- Year (YYYY)
- One-line description
- Company / context (which company node this links to)
- Stack (comma-separated skills that already exist as nodes)

## Step 4 — Append the node + edges to graph.json
- Append node: `{ id, type: "project", label, year, description }`
- Append edges: project → company, project → each stack item.
- If a stack item doesn't exist as a node, append it first as
  `type: "skill"`.

## Step 5 — Confirm and report
Print a diff summary:

```
graph.json: +1 node, +<n> edges
```

Do not commit automatically.
