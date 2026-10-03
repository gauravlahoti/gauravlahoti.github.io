# Spec 90: No em dashes in user-facing copy

The voice rules in `CLAUDE.md` already say no em dashes in copy; they read as machine-written. Plenty had crept in anyway, for example the live-agents intro: "agentic architecture — and it keeps growing." This sweeps every em dash out of text a visitor can see or hear.

## Scope

**In:** anything shown on screen or read by a screen reader.
- `content/*.json` values: agents, AI Lab concepts, graph, MCP Lab, posts, profile.
- Page `<title>`s, meta and Open Graph descriptions, visible HTML text, `aria-label`s on `index.html`, `live-agents/`, `ai-labs/**` and `insights/**`.
- JS string literals that render: card and badge labels, the MCP Lab narration, the Agent-Ready lab's tool picker, and WebMCP tool descriptions and outputs, which the Agent-Ready lab displays.

**Out:** code comments, CSS, developer docs (`content/README.md`, specs), backend and agent prompts. Also out is `agents/rag-lab/frontend/` (served separately at agentic-rag.gauravlahoti.dev, its own deploy). Atlas's generated replies are model output, not site copy.

## How

Each one was rewritten by hand to whatever reads naturally (a comma, a period, a colon or parentheses), never a blind replace. Certification names use the site's existing " · " separator ("Claude Certified Architect · Professional"); nothing parses those names, and the widget's captions use `shortName`.

## Found along the way

`scripts/gen-post-pages.mjs` has drifted from the live insight pages. Running it would drop `insight-nav.js`, swap in an older CSP, and roll `layout.css` / `components.css` back to stale versions on all 17 pages. It would also add `slug`s to the four newest posts. So the insight pages here were hand-edited, not regenerated. **`/add-post` runs this script**, so the next new post would regress every insight page until the template is brought back in line with the live pages. Worth its own spec.

## Definition of done

- [x] `content/*.json`: 0 em dashes in any value.
- [x] Site HTML outside comments, scripts and styles: 0.
- [x] JS string literals in `assets/js/`: 0 (remaining hits are comments).
- [x] `node --test 'tests/**/*.test.mjs'` (19) passes; every JSON file parses.
