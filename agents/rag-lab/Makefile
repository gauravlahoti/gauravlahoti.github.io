GCP_PROJECT = gcp-experiments-490306
REGION      = us-central1
SERVICE     = agentic-rag

.PHONY: install dev clean lint secrets deploy

install: ## Install Python deps.
	uv sync

dev: ## Run FastAPI locally on :8000 with reload.
	uv run uvicorn app.main:app --reload --port 8000

clean: ## Drop Chroma DB, pycache, and venv.
	rm -rf .chroma/ __pycache__ app/**/__pycache__ .venv

lint: ## Lint + format with ruff.
	uv run ruff check --fix .
	uv run ruff format .

secrets: ## Create Secret Manager secrets (one-time setup before first deploy).
	@echo "Creating secrets in $(GCP_PROJECT)..."
	gcloud secrets create anthropic-api-key  --project $(GCP_PROJECT) --replication-policy automatic 2>/dev/null || true
	gcloud secrets create voyage-api-key     --project $(GCP_PROJECT) --replication-policy automatic 2>/dev/null || true
	gcloud secrets create rag-lab-owner-key  --project $(GCP_PROJECT) --replication-policy automatic 2>/dev/null || true
	@echo ""
	@echo "Now populate each secret:"
	@echo "  echo -n 'sk-ant-...' | gcloud secrets versions add anthropic-api-key  --data-file=- --project $(GCP_PROJECT)"
	@echo "  echo -n 'pa-...'     | gcloud secrets versions add voyage-api-key     --data-file=- --project $(GCP_PROJECT)"
	@echo "  echo -n 'passphrase' | gcloud secrets versions add rag-lab-owner-key  --data-file=- --project $(GCP_PROJECT)"

deploy: ## Deploy Agentic RAG Lab to Cloud Run (service: agentic-rag, us-central1).
	gcloud run deploy $(SERVICE) \
		--project $(GCP_PROJECT) \
		--region $(REGION) \
		--source . \
		--memory 2Gi \
		--allow-unauthenticated \
		--cpu-throttling \
		--cpu-boost \
		--execution-environment gen2 \
		--concurrency 4 \
		--min-instances 0 \
		--max-instances 1 \
		--update-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest,VOYAGE_API_KEY=voyage-api-key:latest,OWNER_KEY=rag-lab-owner-key:latest,GOOGLE_API_KEY=google-api-key:latest
