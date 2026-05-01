# Spec: 3D Knowledge Graph

## Overview

The centerpiece visualization. A force-directed 3D graph where
nodes are companies, projects, AI domains, and skills; edges
encode "this project used this skill at this company". Visitors
spin it, hover nodes for detail, click a project node to scroll
to its case study. This single component does in five seconds
what a skills list does in five paragraphs — it shows how the
career fits together.

## Depends on

- Spec 01 (`#graph` anchor).
- Real career data — needs the user's resume + LinkedIn URL to
  populate `graph.json`. Until that arrives, ship with the
  placeholder dataset (single "Welcome" node).

## Routes

No backend.

## Database changes

No database. Data lives in `assets/js/data/graph.json`.

## Templates

- **Create:** none.
- **Modify:** `index.html` — `#graph` section gets a container
  div, a side panel (`<aside>`), and a 2D-fallback `<svg>` (used
  only on mobile or when WebGL is unavailable).

## Files to change

- `assets/js/data/graph.json` — populate with real career data
  during this spec. Schema:
  ```
  {
    "nodes": [
      { "id": "deloitte",  "type": "company",  "label": "Deloitte" },
      { "id": "rag-cms",   "type": "project",  "label": "RAG-CMS",
        "year": 2025, "description": "...",  "anchor": "#story-rag" },
      { "id": "llms",      "type": "domain",   "label": "LLMs" },
      { "id": "python",    "type": "skill",    "label": "Python" }
    ],
    "edges": [
      { "source": "rag-cms", "target": "deloitte" },
      { "source": "rag-cms", "target": "llms" },
      { "source": "rag-cms", "target": "python" }
    ]
  }
  ```
- `assets/js/graph.js` — implement `initGraph(container, data)`
  using `3d-force-graph`. Node colour by `type`. Hover →
  highlight neighbours, write description into the side panel.
  Click a `project` node → dispatch a custom event
  `portfolio:scroll-to` with the anchor.
- `assets/css/components.css` — graph container, side panel,
  type-colour CSS variables (`--node-company`, etc.).
- `assets/js/main.js` — listen for `portfolio:scroll-to` and
  call Lenis to scroll. Lazy-init the graph when `#graph`
  enters viewport.

## Files to create

None.

## New dependencies

CDN:
- `3d-force-graph` (built on top of Three.js).

## Rules for implementation

- Mobile fallback: viewports < 768px or `navigator.connection.saveData === true`
  render the 2D SVG instead. Same data, different renderer.
  SVG version uses d3-force or a hand-rolled iterative layout —
  prefer the simpler hand-roll if d3 adds significant weight.
- Lazy-init only — don't load `3d-force-graph` until the
  `#graph` anchor is in viewport. The library is the heaviest
  dep on the site.
- Nodes are sized by `type` weight (company > project >
  domain > skill).
- Hover writes into a single side-panel element; never create
  tooltip DOM on hover (causes paint thrash).
- Node labels render as Three.js sprites, not HTML overlays.
- The graph respects `prefers-reduced-motion`: spin animation
  is paused, only manual rotation is allowed.
- All node descriptions (`description` field) come from
  `graph.json`. Don't put descriptive text in JS.

## Definition of done

- [ ] `#graph` shows a rotating 3D force-directed graph on
      desktop.
- [ ] Each node is colour-coded by `type` (company / project /
      domain / skill).
- [ ] Hovering a node highlights it + its direct neighbours
      and writes the node description into the side panel.
- [ ] Clicking a project node scrolls smoothly to its
      case-study section in `#stories`.
- [ ] Mobile (375px) shows a 2D SVG layout of the same data.
- [ ] On `prefers-reduced-motion`, auto-rotation is paused.
- [ ] `graph.json` is the *only* place career data lives.
- [ ] `3d-force-graph` is fetched only after `#graph` enters
      the viewport (verifiable in Network panel).
- [ ] Total JS still ≤ 400 KB gzipped after this spec lands.
