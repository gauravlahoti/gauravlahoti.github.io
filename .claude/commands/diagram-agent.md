---
description: Read a codebase (GitHub URL or local path), understand its architecture, and generate an agent architecture SVG diagram matching the portfolio design language.
argument-hint: "<github-url-or-local-path> [agent-id]"
allowed-tools: Read, Write, Edit, Bash, WebFetch, AskUserQuestion
---

Generate an architecture diagram SVG for a given codebase, matching the exact design language used by the Agents Portfolio page at `/agents/`. The output SVG is saved to `agents/diagrams/<agent-id>-v1.svg` and is immediately usable as a `diagramSvg` value in `content/agents.json`.

User input: `$ARGUMENTS` — a GitHub URL (https://github.com/...) or an absolute local path, optionally followed by a short agent-id slug (e.g. `my-agent`). If agent-id is omitted, derive it from the repo/folder name.

---

## Step 1 — Parse arguments

Split `$ARGUMENTS` on whitespace. First token is the source (URL or path), second token (if present) is the agent-id slug.

- If source starts with `https://github.com/`, it is a GitHub repo URL.
- Otherwise treat it as an absolute local path.
- agent-id: lowercase, hyphenated, no spaces. Default: repo/folder name lowercased.

---

## Step 2 — Read the codebase

### 2a — If GitHub URL

Derive the raw-content base: `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/`.

Fetch these files in order (skip gracefully if 404):
1. `README.md`
2. `CLAUDE.md`
3. `GEMINI.md`
4. `package.json`
5. `pyproject.toml`
6. `requirements.txt`
7. `Dockerfile`
8. `docker-compose.yml` / `docker-compose.yaml`
9. `.env.example`
10. `wrangler.toml`
11. `cloudbuild.yaml` / `cloudbuild.yml`

Also fetch the repo tree via GitHub API to spot top-level directories and infer module boundaries:
```
https://api.github.com/repos/<owner>/<repo>/git/trees/HEAD?recursive=0
```

### 2b — If local path

Read the following files if they exist (skip if absent):
1. `<path>/README.md`
2. `<path>/CLAUDE.md`
3. `<path>/GEMINI.md`
4. `<path>/package.json`
5. `<path>/pyproject.toml`
6. `<path>/requirements.txt`
7. `<path>/Dockerfile`
8. `<path>/.env.example`
9. `<path>/wrangler.toml`

Run `find <path> -maxdepth 2 -name "*.py" -o -name "*.ts" -o -name "*.js" | head -60` to list source files and infer module structure.

---

## Step 3 — Extract architecture facts

From the files read in Step 2, extract:

| Fact | Where to look |
|---|---|
| **Agent name** | README title, pyproject.toml `[project] name`, package.json `name` |
| **Primary LLM / model** | README, .env.example (GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, MODEL=...), pyproject.toml |
| **Framework** | imports/deps: `google-adk`, `langchain`, `crewai`, `autogen`, `openai-agents`, `anthropic`, `llama-index` |
| **Runtime** | Dockerfile → Cloud Run / Lambda / ECS; wrangler.toml → Cloudflare Worker; no Dockerfile → local/serverless |
| **Trigger** | README / cloudbuild / cron expressions → Cloud Scheduler, EventBridge, HTTP, webhook, queue |
| **Tools / integrations** | .env.example keys, README tool list, imports: MCP, Resend, Slack, GitHub, Jira, databases |
| **Data sources** | README, imports: Pinecone, Weaviate, D1, Firestore, Postgres, Redis, S3, GCS |
| **Output / sinks** | README: email, Slack message, webhook, file, database write, API call |
| **Auth** | .env.example: API keys, OIDC, bearer tokens |

Build a structured node list:
```
nodes = [
  { id, label, sublabel, role: "hub"|"standard"|"external"|"boundary", icon },
  ...
]
edges = [
  { from, to, label, style: "accent"|"standard" },
  ...
]
```

**Hub node**: the primary agent process (exactly one per diagram).
**Standard nodes**: internal services, tools, data stores owned by this project.
**External nodes**: third-party APIs, managed cloud services the agent calls.
**Boundary nodes**: Cloud Run / Lambda wrappers (dashed rect, no fill icon).

---

## Step 4 — Map icons

Use only icons present in `/Users/gauravlahoti/portfolio/diagram-icons/`. Check which files exist:

```bash
ls /Users/gauravlahoti/portfolio/diagram-icons/
```

Map each node to one icon file. Common mappings:

| Service / concept | Icon file |
|---|---|
| Google ADK agent | `adk.png` |
| Gemini model | `gemini.png` |
| Cloud Run | `cloud-run.svg` |
| Cloud Scheduler | `cloud-scheduler.svg` |
| GCP outer boundary | `google-cloud.png` |
| Cloudflare D1 / Worker | `cloudflare.svg` (if present) |
| Generic database | inline cylinder SVG (no file needed) |
| Email / Resend | inline envelope SVG |
| Browser / client | inline monitor SVG |

If a needed icon file is absent, render a small inline SVG shape instead (16×16 circle or rect in `#888888`).

---

## Step 5 — Plan the layout

Canvas: **960 × 600**, black background `#000000`.

Layout rules (apply in order):
1. **GCP boundary** (if any GCP service used): `x=20 y=66 width=920 height=496 rx=16`, stroke `#4285F4` opacity 0.35. Centered Google Cloud label on top border.
2. **Hub node** always centered horizontally near y=244 (vertical midpoint of canvas minus ~50px).
3. **Trigger / client nodes** (schedulers, browsers, webhooks): left side, y=80 area.
4. **Output / sink nodes** (email inboxes, dashboards): right side, y=80 area.
5. **Data source nodes** (databases, corpora, vector stores): bottom-left cluster.
6. **Tool / MCP nodes**: bottom-center or bottom-right cluster.
7. If a node runs on Cloud Run: wrap it in a dashed Cloud Run boundary rect with centered label on top border.
8. Keep at least **40px clearance** between any two rects. No overlapping elements.
9. All edges are orthogonal (right-angle segments only). No diagonal lines.
10. Number flow steps 1–N following the primary happy-path left-to-right, top-to-bottom.

---

## Step 6 — Ask user to confirm the plan

Before generating SVG, print a compact plan to chat:

```
Architecture plan for <agent-id>:

Nodes:
  [hub]      <name> — <framework> / <model>
  [standard] <name> — <role>
  [external] <name> — <service>
  ...

Edges (numbered flow):
  1. <from> → <to>  "<edge label>"
  2. ...

Layout:
  Trigger/client: top-left
  Hub: center
  Data: bottom-left
  Tools: bottom-right
  Output: top-right
```

Use **AskUserQuestion** with options:
1. **Generate SVG** — proceed with this plan
2. **Edit nodes/edges** — let me adjust before generating
3. **Cancel** — abort

If "Edit nodes/edges": ask in chat what to change, update the plan, show the revised plan, ask again.

---

## Step 7 — Generate the SVG

Output a complete SVG following this **exact** template and design language. Every value is fixed — do not deviate.

### Design tokens (hardcoded — never vary)

```
Canvas:        960 × 600, background #000000
Font classes:  .node-title (15px #E5E5E5), .node-sub (11px #888888),
               .edge-label (11px #888888), .caption (12px #555555),
               .step-num (11px bold)
Accent color:  #00FFD1
Hub fill:      #0E1A19, stroke #00FFD1 1.5px, size 200×72 rx=8
Standard fill: #0F0F0F, stroke #555555 1.5px, size 200×72 rx=8  (can vary h for content)
Boundary:      fill none, stroke #666666 1px, stroke-dasharray="4 3", rx=10/12
GCP boundary:  fill none, stroke #4285F4 1px opacity=0.35, rx=16
Step circles:  r=11, fill #0E1A19, stroke #00FFD1 1.5px, text fill #00FFD1
Accent edges:  stroke #00FFD1 1.5px, marker-end url(#arr-acc)
Standard edges: stroke #2A2A2A 1.5px, marker-end url(#arr-std)
Edge label bg: rect fill #000000 rx=3, sized to text
Icons:         <image href="/diagram-icons/FILE" x=... y=... width=24 height=24/> (hub)
               <image href="/diagram-icons/FILE" x=... y=... width=18 height=18/> (standard)
Boundary label: <rect fill="#000000"/> + <image .cloud-run.svg 14×14/> + <text .caption>
               Centered over the boundary top border line
```

### SVG structure (in this exact order)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 600" width="960" height="600" style="background:#000000">
  <defs>
    <style>
      text { font-family: 'Cascadia Code', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace; }
      .node-title { font-size: 15px; fill: #E5E5E5; }
      .node-sub   { font-size: 11px; fill: #888888; }
      .edge-label { font-size: 11px; fill: #888888; }
      .caption    { font-size: 12px; fill: #555555; }
      .step-num   { font-size: 11px; font-weight: bold; }
    </style>
    <marker id="arr-std" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
      <path d="M0,0 L0,6 L6,3 z" fill="#2A2A2A"/>
    </marker>
    <marker id="arr-acc" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
      <path d="M0,0 L0,6 L6,3 z" fill="#00FFD1"/>
    </marker>
  </defs>

  <!-- Caption: // <agent-id> · <key-tech-1> · <key-tech-2> · ... -->
  <text x="40" y="52" class="caption">// ...</text>

  <!-- GCP boundary (if applicable) -->
  <!-- ... -->

  <!-- Nodes (boundaries first, then inner boxes, then icons+text on top) -->
  <!-- ... -->

  <!-- EDGES -->
  <!-- ... -->

  <!-- STEP CIRCLES -->
  <!-- ... -->

  <!-- Animation flow data -->
  <g class="anim-data" style="display:none">
    <!-- one <g data-traveler-path="x1,y1 x2,y2 ..." data-color="#00FFD1" data-step="N" data-delay="D"/> per edge -->
  </g>
</svg>
```

### Critical geometry rules

- **Boundary label centering**: mask rect and label text must be horizontally centered over the boundary's top border line. Formula: `mask_x = boundary_x + (boundary_width - mask_width) / 2`. Label `x` = `mask_x + mask_width/2` with `text-anchor="middle"` — OR compute explicit x if not using text-anchor.
- **Arrow endpoints**: arrows aimed at a boundary box must terminate **7px before** the boundary rect edge (not at the inner node edge). `marker-end` arrow tip sits at the coordinate given — back off by 7px.
- **Inner node centering inside boundary**: inner node `x = boundary_x + (boundary_width - node_width) / 2`.  Verify: `inner_x + node_width/2 === boundary_x + boundary_width/2`.
- **Edge labels**: place label rect **above** horizontal lines (rect `y = line_y - 18`) and **to the right** of vertical lines (rect `x = line_x + 6`). Never place a label rect directly on the line — always offset.
- **Step circle placement**: place on the midpoint of the longest segment of each edge path.
- **traveler-path**: coordinates must trace the same polyline as the drawn edge, starting from the source node edge, ending at the target node edge (before the arrowhead). Use `data-delay` increments of 0.7s between steps.

---

## Step 8 — Save and register

1. Save to `agents/diagrams/<agent-id>-v1.svg`.
2. Print the JSON snippet the user needs to add to `content/agents.json`:

```json
{
  "id": "<agent-id>",
  "name": "<Agent Name>",
  "subtitle": "<One-line subtitle>",
  "role": "<Role label>",
  "status": "LIVE",
  "headline": "<One-sentence hook>",
  "description": "<2-3 sentence description>",
  "value": "<1-2 sentence value prop>",
  "stack": ["<tech1>", "<tech2>", "..."],
  "diagramSvg": "agents/diagrams/<agent-id>-v1.svg",
  "diagramAlt": "<brief alt text>",
  "steps": [
    { "n": 1, "label": "<Step label>", "detail": "<1-2 sentences>" },
    ...
  ],
  "techDecisions": [
    { "tech": "<Tech>", "why": "<1-2 sentence rationale>" },
    ...
  ],
  "traits": [
    { "label": "Model", "value": "<model name>" },
    { "label": "Framework", "value": "<framework>" },
    { "label": "Runtime", "value": "<runtime>" }
  ],
  "links": []
}
```

3. Remind the user to bump the `?v=NNN` cache-buster in `agents-page.js` after adding the entry.

---

## On cancel

Leave all files untouched. Print:
```
Cancelled. No files written.
```
