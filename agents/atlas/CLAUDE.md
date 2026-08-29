# atlas (chat-widget agent)

Google ADK Python agent powering the portfolio chat widget. Answers questions about Gaurav using live retrieval tools that fetch `content/*.json` from the site at request time (`app/corpus_live.py`, short TTL + bundled snapshot as offline fallback), so content edits reflect with NO redeploy. Deployed on Cloud Run (`min-instances=0`).

## Commands

| Command | Purpose |
|---------|---------|
| `make dev` | FastAPI dev server on `:8000` |
| `agents-cli playground` | Interactive ADK web UI |
| `agents-cli run "prompt"` | One-shot smoke test |
| `make eval` | Full 21-case eval gate. Both the agent under test and the **grading judge run on Vertex** (adk-mas-demo project) — the agent's own `FallbackGemini.api_client` forces Vertex/adk-mas-demo unconditionally, regardless of this command's `GEMINI_API_KEY`/`GOOGLE_GENAI_USE_VERTEXAI=False` env vars |
| `make eval-quick` | Cheap 2-case smoke eval (routine checks) |
| `uv run pytest tests/unit tests/integration` | Unit + integration tests |
| `agents-cli lint` | Code quality check |
| `make corpus` | Sync `content/*.json` → `app/corpus/` |
| `make deploy` | Deploy to Cloud Run (`gcloud beta run deploy atlas --source .` with this service's actual flags/env/secrets — see the Makefile's `deploy` target; it is not the bare `agents-cli deploy` scaffold command, which lacks several flags this service needs) |

## Workflow

1. Edit agent logic in `app/`
2. Run `make eval` (agent and judge both on adk-mas-demo Vertex) — iterate until evals pass
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
- **New `app_utils` module calling Vertex directly** (own cached ADC creds / httpx client, following `speak.py`'s pattern): give it a `warm()` function and wire it into `GET /api/agent-chat/warm` in `api.py`, alongside `warm_mcp_server`/`warm_speak`/`warm_transcribe`. Skipping this was a real bug — `transcribe.py` shipped without one, so it was never pre-warmed by the keep-warm scheduler ping the way `speak.py` is, and most real transcribe requests paid a ~5s cold ADC/TLS tax every time.
- Only modify code targeted by the request — preserve surrounding code, config values, and formatting.
