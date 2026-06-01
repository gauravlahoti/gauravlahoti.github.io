# Convenience targets for the portfolio-agent sub-project.
# `make help` prints this list.

.PHONY: help corpus install dev playground smoke eval lint clean audit deploy deploy-ambient

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-12s\033[0m %s\n", $$1, $$2}'

corpus: ## Sync the corpus snapshot from the static site (run before deploys).
	cp ../assets/js/data/profile.json app/corpus/profile.json
	cp ../assets/js/data/graph.json   app/corpus/graph.json
	cp ../assets/js/data/posts.json   app/corpus/posts.json
	uv run python scripts/build_skills.py
	@echo "Corpus + skills synced. Don't forget to redeploy: agents-cli deploy"

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

deploy: ## Deploy chat widget backend to Cloud Run (portfolio-chat-agent, us-central1).
	gcloud beta run deploy portfolio-chat-agent \
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
		--update-env-vars AGENT_VERSION=0.1.0,APP_URL=https://portfolio-chat-agent-lw4bt7nrba-uc.a.run.app \
		--update-secrets GEMINI_API_KEY=gemini-api-key:latest \
		--labels created-by=adk

deploy-ambient: ## Deploy background digest agent to Cloud Run (portfolio-ambient-agent, us-central1).
	gcloud beta run deploy portfolio-ambient-agent \
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
		--update-env-vars AGENT_VERSION=0.1.0,APP_URL=https://portfolio-ambient-agent-lw4bt7nrba-uc.a.run.app \
		--update-secrets GEMINI_API_KEY=gemini-api-key:latest \
		--labels created-by=adk

clean: ## Drop __pycache__ and .pytest_cache.
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf .pytest_cache
