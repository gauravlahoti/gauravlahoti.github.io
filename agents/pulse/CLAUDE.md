# pulse (ambient digest agent)

Google ADK Python agent powering the portfolio chat widget. Answers questions about Gaurav using five retrieval tools over a frozen JSON corpus. Deployed on Cloud Run (`min-instances=0`).

## Commands

| Command | Purpose |
|---------|---------|
| `make dev` | FastAPI dev server on `:8000` |
| `agents-cli playground` | Interactive ADK web UI |
| `agents-cli run "prompt"` | One-shot smoke test |
| `agents-cli eval run --evalset tests/eval/evalsets/portfolio.evalset.json` | Run eval gate |
| `uv run pytest tests/unit tests/integration` | Unit + integration tests |
| `agents-cli lint` | Code quality check |
| `make corpus` | Sync `content/*.json` → `app/corpus/` |
| `agents-cli deploy ... -- --allow-unauthenticated --cpu-boost --min-instances=0` | Deploy to Cloud Run |

## Workflow

1. Edit agent logic in `app/`
2. Run `agents-cli eval run` — iterate until evals pass (expect 5–10 rounds)
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
