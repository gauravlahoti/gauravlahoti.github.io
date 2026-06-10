# Convenience targets for the Atlas chat-widget agent.
# `make help` prints this list.

.PHONY: help corpus install dev playground smoke eval eval-quick lint clean audit deploy

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-12s\033[0m %s\n", $$1, $$2}'

corpus: ## Sync the corpus snapshot from the static site (run before deploys).
	cp ../../content/profile.json app/corpus/profile.json
	cp ../../content/graph.json   app/corpus/graph.json
	cp ../../content/posts.json   app/corpus/posts.json
	cp ../../content/agents.json  app/corpus/agents.json
	uv run python scripts/build_skills.py
	@echo "Corpus + skills synced. Don't forget to redeploy: make deploy"

install: ## Install Python deps (uv sync).
	uv sync

dev: ## Run the FastAPI app locally on :8000 with reload.
	uv run uvicorn app.fast_api_app:app --host 0.0.0.0 --port 8000 --reload

playground: ## Open the ADK web playground.
	agents-cli playground

smoke: ## One-shot smoke test against the local agent.
	agents-cli run "What has Gaurav shipped in production with multi-agent systems?"

# Eval ALWAYS runs on the AI Studio free-tier key, never Vertex AI, so the
# agent + rubric-judge calls incur ZERO model charges. We reuse the same key
# prod uses (Secret Manager `gemini-api-key`), honoring an existing
# GEMINI_API_KEY in your env first. Forcing GOOGLE_GENAI_USE_VERTEXAI=False
# pins BOTH the agent (app/agent.py) and the judge (eval_config.json) to the
# free tier. Without this, missing creds fall through to paid Vertex AI.
_FREE_KEY = KEY="$${GEMINI_API_KEY:-$$(gcloud secrets versions access latest --secret=gemini-api-key --project gcp-experiments-490306 2>/dev/null)}"; \
	test -n "$$KEY" || { echo "ERROR: no free-tier key — set GEMINI_API_KEY or grant access to secret 'gemini-api-key'"; exit 1; }; \
	echo ">> Eval on AI Studio FREE TIER (Vertex disabled — no model charges)";

eval: ## Run the FULL 16-case eval gate on the free-tier key (no Vertex/paid usage). Use before deploy.
	@$(_FREE_KEY) \
	GEMINI_API_KEY="$$KEY" GOOGLE_API_KEY="$$KEY" GOOGLE_GENAI_USE_VERTEXAI=False \
		agents-cli eval run --evalset tests/eval/evalsets/portfolio.evalset.json

eval-quick: ## Cheap 2-case smoke eval on the free-tier key (routine checks; ~4 calls).
	@$(_FREE_KEY) \
	GEMINI_API_KEY="$$KEY" GOOGLE_API_KEY="$$KEY" GOOGLE_GENAI_USE_VERTEXAI=False \
		agents-cli eval run --evalset tests/eval/evalsets/basic.evalset.json

lint: ## Lint with ruff (auto-fix).
	agents-cli lint --fix

audit: ## Send a fixture log entry to AGENT_LOG_URL (local smoke test for audit log).
	uv run python -m app.app_utils.audit_log_smoke

deploy: ## Deploy Atlas (chat widget) to Cloud Run (service: atlas, us-central1).
	gcloud beta run deploy atlas \
		--project gcp-experiments-490306 \
		--region us-central1 \
		--source . \
		--memory 4Gi \
		--allow-unauthenticated \
		--cpu-throttling \
		--cpu-boost \
		--execution-environment gen2 \
		--concurrency 80 \
		--min-instances 0 \
		--update-env-vars "^;^AGENT_VERSION=0.1.0;APP_URL=https://atlas-lw4bt7nrba-uc.a.run.app;ALLOW_ORIGINS=https://gauravlahoti.dev,https://gauravlahoti.github.io,http://localhost:5173;AGENT_LOG_URL=https://gaurav-portfolio-resume-gate.gaurav-lahoti25.workers.dev/api/agent-log;RESEND_FROM_ADDRESS=resume@gauravlahoti.dev;RESUME_PDF_URL=https://gauravlahoti.dev/assets/img/resume.pdf;RESEND_MCP_URL=https://resend-mcp-server-593919045544.us-central1.run.app/mcp;NOTE_FROM_ADDRESS=agent@gauravlahoti.dev" \
		--update-secrets GEMINI_API_KEY=gemini-api-key:latest,AGENT_LOG_TOKEN=agent-log-token:latest,GAURAV_CONTACT_EMAIL=gaurav-contact-email:latest,MCP_CALLER_TOKEN=resend-mcp-caller-token:latest \
		--labels created-by=adk

clean: ## Drop __pycache__ and .pytest_cache.
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf .pytest_cache
