# Convenience targets for the Atlas chat-widget agent.
# `make help` prints this list.

.PHONY: help corpus install dev playground smoke eval lint clean audit deploy

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-12s\033[0m %s\n", $$1, $$2}'

corpus: ## Sync the corpus snapshot from the static site (run before deploys).
	cp ../../content/profile.json app/corpus/profile.json
	cp ../../content/graph.json   app/corpus/graph.json
	cp ../../content/posts.json   app/corpus/posts.json
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

eval: ## Run the eval suite.
	agents-cli eval run --evalset tests/eval/evalsets/portfolio.evalset.json

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
