# CLAUDE.md — RAG Lab (redirect stub)

Guidance for the **RAG Lab** entry under `ai-labs/`. This is a redirect stub, not a lab
implementation — the repo-wide rules in the root `CLAUDE.md` still apply.

## What it is

`ai-labs/rag-lab/index.html` is a static redirect to `https://agentic-rag.gauravlahoti.dev/`
— a standalone FastAPI agent (Spec 38, source at `agents/rag-lab/`) that teaches agentic
RAG with a 3D vector-space visualization. It is **deployed and served off-repo**; nothing in
this directory renders the actual lab.

## Design choice: why a redirect instead of a real page here

The RAG Lab needs a live backend (embeddings, vector search, a streaming model response) —
it can't be a static client-side explainer like MCP Lab or Engineering Loops. Rather than
proxy or iframe a separate service into the static Pages site, it's kept as its own
deployment with its own domain, and this repo only owns the thin pointer:

```html
<meta http-equiv="refresh" content="0;url=https://agentic-rag.gauravlahoti.dev/">
<script>window.location.replace("https://agentic-rag.gauravlahoti.dev/");</script>
```

Both the meta-refresh and the JS replace are present so the redirect still fires with
JavaScript disabled (meta-refresh) and fires instantly without a visible flash when JS is
available (`replace`, not `href=`, so the stub never enters browser history).

## If you're changing this

- **Moving the off-repo agent to a new domain:** update the URL in both places above (they
  must match) and in `content/ai-concepts.json`'s RAG Lab card if the *link text* or
  description references the domain.
- **Bringing RAG Lab in-repo as a real static lab:** that's a different, much bigger change
  (see `.claude/specs/38-agentic-rag-lab.md` for the original design) — don't just edit this
  stub, replace it as part of that larger effort and update `.claude/docs/agents.md`'s
  `agents/rag-lab/` entry accordingly.
- **This directory is not where the agent's actual code lives.** That's `agents/rag-lab/`
  (a completely separate part of the repo, deployed independently, excluded from the Pages
  rsync build). Don't confuse the two `rag-lab` paths.

## Verify

```bash
python3 -m http.server 5173   # then open /ai-labs/rag-lab/ — should redirect immediately
```
