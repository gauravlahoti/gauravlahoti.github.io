# Convenience targets for the portfolio-agent sub-project.
# `make help` prints this list.

.PHONY: help corpus install dev playground smoke eval lint clean audit deploy

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-12s\033[0m %s\n", $$1, $$2}'

corpus: ## Sync the corpus snapshot from the static site (run before deploys).
	cp ../assets/js/data/profile.json app/corpus/profile.json
	cp ../assets/js/data/graph.json   app/corpus/graph.json
	cp ../assets/js/data/posts.json   app/corpus/posts.json
	@echo "Corpus synced. Don't forget to redeploy: agents-cli deploy"

install: ## Install Python deps (uv sync).
	uv sync

dev: ## Run the FastAPI app locally on :8000 with reload.
	uv run uvicorn app.fast_api_app:app --host 0.0.0.0 --port 8000 --reload

playground: ## Open the ADK web playground.
	agents-cli playground

smoke: ## One-shot smoke test against the local agent.
	agents-cli run "What has Gaurav shipped in production with multi-agent systems?"

eval: ## Run the eval suite.
	agents-cli eval run --evalset tests/eval/evalsets/portfolio_evalset.json

lint: ## Lint with ruff (auto-fix).
	agents-cli lint --fix

audit: ## Send a fixture log entry to AGENT_LOG_URL (local smoke test for audit log).
	uv run python -m app.app_utils.audit_log_smoke

deploy: ## Deploy to Cloud Run (cpu-boost + gen2 + concurrency=80 for fast cold starts).
	agents-cli deploy -- \
		--allow-unauthenticated \
		--default-url \
		--cpu-throttling \
		--cpu-boost \
		--execution-environment gen2 \
		--concurrency 80 \
		--min-instances 0

clean: ## Drop __pycache__ and .pytest_cache.
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf .pytest_cache
