# pulse (ambient digest agent)

**Note:** this file previously described Atlas's chat widget (five retrieval
tools, an eval gate, a `corpus` target) — none of which Pulse has. Rewritten
2026-08-29. Full detail: `DESIGN_SPEC.md` in this directory,
`.claude/docs/agents.md` at the repo root.

Google ADK Python agent that runs on a schedule with no human in the loop and
sends Gaurav one review-ready digest email. No chat surface, no
visitor-facing endpoint — its only callers are two Cloud Scheduler jobs
hitting `POST /api/ambient/run` (Mon/Thu) and `POST /api/ambient/metrics`
(every 2 days), gated by `AMBIENT_TRIGGER_TOKEN`. Deployed on Cloud Run
(`min-instances=0`, service `pulse`).

## Commands

| Command | Purpose |
|---------|---------|
| `make dev` | FastAPI dev server on `:8001` |
| `agents-cli playground` | Interactive ADK web UI |
| `make smoke` | Drives one real ambient cycle locally — **sends a real digest email** |
| `make lint` | Ruff, auto-fix |
| `uv run pytest tests/unit` | Unit tests (`test_ambient.py`, `test_dummy.py`) |
| `make deploy` | Deploy to Cloud Run |

No `eval` or `corpus` target — that machinery is Atlas-only. Pulse's
correctness is checked by unit tests plus watching real scheduled runs land
correctly, not an eval gate.

## Workflow

1. Edit agent logic in `app/` (`ambient_agent.py` for the instruction/tools,
   `app_utils/ambient_send.py` for the email itself).
2. `uv run pytest tests/unit`.
3. Get explicit approval, then `make deploy`.

There is no eval gate to pass before deploying. A bad prompt change here
doesn't fail loudly — it just sends a worse email — so treat a deploy as
needing a human to actually read the next digest, not just green tests.

## Rules

- **Never change the model** unless explicitly asked.
- **Never hand-edit** `pyproject.toml [tool.agents-cli]` or `App(name="app")`
  — the CLI owns them. `root_agent` (`app/agent.py`) is what points at the
  actual `ambient_agent` instance; that's the one you edit.
- **Model 404 errors:** fix `GOOGLE_CLOUD_LOCATION` (use `global`, not a
  region), not the model name.
- **ADK tool imports:** import the instance, not the module —
  `from app.app_utils.ambient_data import get_recent_interactions`.
- **Run Python via uv:** `uv run python script.py`.
- **Repeated errors (3+):** fix the root cause, don't retry.
- **Terraform 409:** use `terraform import` instead of recreating.
- **Every dashboard number in the email comes from `send_review_email`'s own
  D1 query, never from the model.** The model contributes only the
  qualitative insights block. Don't let the instruction start asking it to
  restate or compute a metric.
- Only modify code targeted by the request — preserve surrounding code,
  config values, and formatting.
