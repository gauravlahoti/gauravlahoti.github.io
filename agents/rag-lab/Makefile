.PHONY: install dev clean lint

install:
	uv sync

dev:
	uv run uvicorn app.main:app --reload --port 8000

clean:
	rm -rf .chroma/ __pycache__ app/**/__pycache__ .venv

lint:
	uv run ruff check --fix .
	uv run ruff format .
