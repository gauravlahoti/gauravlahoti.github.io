---
description: Add a new project node to graph.json + a story stub to stories.json
argument-hint: "Project slug e.g. rag-cms"
allowed-tools: Read, Write, Edit, Bash(git:*)
---

Add a project to the portfolio dataset. Useful after spec 04
(graph) and spec 05 (stories) ship — adding a new project
should not require touching any code, just JSON.

User input: $ARGUMENTS — the project slug (kebab-case).

## Step 1 — Validate slug
Slug must be lowercase, kebab-case, a-z 0-9 -, max 40 chars.
If invalid, ask the user to fix.

## Step 2 — Check for duplicates
Read `assets/js/data/graph.json`. If a node with that `id`
already exists, ask whether to update it instead of adding.

## Step 3 — Gather missing fields
Ask the user (one AskUserQuestion call) for:
- Project name (display label)
- Year (YYYY)
- One-line description
- Company / context (which company node this links to)
- Stack (comma-separated skills that already exist as nodes)
- Whether to also create a story (yes/no)

## Step 4 — Append the node + edges to graph.json
- Append node: `{ id, type: "project", label, year, description,
  anchor: "#story-<slug>" if story=yes else "" }`
- Append edges: project → company, project → each stack item.
- If a stack item doesn't exist as a node, append it first as
  `type: "skill"`.

## Step 5 — Append story stub to stories.json (if requested)
Append:
```
{
  "id": "story-<slug>",
  "title": "<label>",
  "problem": "TODO",
  "role": "TODO",
  "stack": [...],
  "beats": [
    { "title": "Problem",  "body": "TODO", "visual": "" },
    { "title": "Approach", "body": "TODO", "visual": "" },
    { "title": "Insight",  "body": "TODO", "visual": "" },
    { "title": "Result",   "body": "TODO", "visual": "" }
  ]
}
```

## Step 6 — Confirm and report
Print a diff summary:

```
graph.json: +1 node, +<n> edges
stories.json: +1 story stub
```

Tell the user to fill in the TODO fields in `stories.json`.
Do not commit automatically.
