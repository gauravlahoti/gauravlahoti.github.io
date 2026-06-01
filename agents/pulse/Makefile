# Convenience targets for the Pulse ambient-digest agent.
# `make help` prints this list.

.PHONY: help install dev playground smoke lint clean deploy

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install Python deps (uv sync).
	uv sync

dev: ## Run the FastAPI app locally on :8001 with reload.
	uv run uvicorn app.fast_api_app:app --host 0.0.0.0 --port 8001 --reload

playground: ## Open the ADK web playground.
	agents-cli playground

smoke: ## Drive one ambient cycle locally (NOTE: sends a real digest email).
	agents-cli run "Run the twice-weekly ambient cycle now."

lint: ## Lint with ruff (auto-fix).
	agents-cli lint --fix

deploy: ## Deploy Pulse (ambient digest) to Cloud Run (service: pulse, us-central1).
	gcloud beta run deploy pulse \
		--project gcp-experiments-490306 \
		--region us-central1 \
		--source . \
		--memory 4Gi \
		--allow-unauthenticated \
		--cpu-throttling \
		--cpu-boost \
		--execution-environment gen2 \
		--concurrency 10 \
		--min-instances 0 \
		--update-env-vars "^;^AGENT_VERSION=0.1.0;APP_URL=https://pulse-lw4bt7nrba-uc.a.run.app;AGENT_LOG_URL=https://gaurav-portfolio-resume-gate.gaurav-lahoti25.workers.dev/api/agent-log;RESEND_FROM_ADDRESS=resume@gauravlahoti.dev;RESEND_MCP_URL=https://resend-mcp-server-593919045544.us-central1.run.app/mcp;NOTE_FROM_ADDRESS=agent@gauravlahoti.dev" \
		--update-secrets GEMINI_API_KEY=gemini-api-key:latest,AGENT_LOG_TOKEN=agent-log-token:latest,GAURAV_CONTACT_EMAIL=gaurav-contact-email:latest,MCP_CALLER_TOKEN=resend-mcp-caller-token:latest,AMBIENT_TRIGGER_TOKEN=ambient-trigger-token:latest \
		--labels created-by=adk

clean: ## Drop __pycache__ and .pytest_cache.
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf .pytest_cache
