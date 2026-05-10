.PHONY: help dev deploy

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-10s\033[0m %s\n", $$1, $$2}'

dev: ## Run the MCP server locally on :3000.
	npx resend-mcp --http --port 3000

deploy: ## Deploy to Cloud Run (cpu-boost + gen2 + concurrency=20 for fast cold starts).
	gcloud run deploy resend-mcp-server \
		--source . \
		--project=gcp-experiments-490306 \
		--region=us-central1 \
		--allow-unauthenticated \
		--cpu-throttling \
		--cpu-boost \
		--execution-environment gen2 \
		--concurrency 20 \
		--min-instances 0
