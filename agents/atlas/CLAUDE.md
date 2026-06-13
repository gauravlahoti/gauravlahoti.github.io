# atlas (chat-widget agent)

Google ADK Python agent powering the portfolio chat widget. Answers questions about Gaurav using live retrieval tools that fetch `content/*.json` from the site at request time (`app/corpus_live.py`, short TTL + bundled snapshot as offline fallback), so content edits reflect with NO redeploy. Deployed on Cloud Run (`min-instances=0`).

## Commands

| Command | Purpose |
|---------|---------|
| `make dev` | FastAPI dev server on `:8000` |
| `agents-cli playground` | Interactive ADK web UI |
| `agents-cli run "prompt"` | One-shot smoke test |
| `make eval` | Full 16-case eval gate — **free-tier key only, never Vertex** (no model charges) |
| `make eval-quick` | Cheap 2-case smoke eval (routine checks) |
| `uv run pytest tests/unit tests/integration` | Unit + integration tests |
| `agents-cli lint` | Code quality check |
| `make corpus` | Sync `content/*.json` → `app/corpus/` |
| `agents-cli deploy ... -- --allow-unauthenticated --cpu-boost --min-instances=0` | Deploy to Cloud Run |

## Workflow

1. Edit agent logic in `app/`
2. Run `make eval` (free-tier key, no Vertex charges) — iterate until evals pass
3. Run `uv run pytest tests/unit tests/integration`
4. Get explicit approval, then deploy

Eval must pass before every deploy.

## Rules

- **Never change the model** unless explicitly asked.
- **Never hand-edit** `pyproject.toml [tool.agents-cli]` or `App(name="app")` — the CLI owns them.
- **Model 404 errors:** fix `GOOGLE_CLOUD_LOCATION` (use `global`, not a region), not the model name.
- **ADK tool imports:** import the instance, not the module — `from google.adk.tools.load_web_page import load_web_page`
- **Run Python via uv:** `uv run python script.py`
- **Repeated errors (3+):** fix the root cause, don't retry.
- **Terraform 409:** use `terraform import` instead of recreating.
- Only modify code targeted by the request — preserve surrounding code, config values, and formatting.
