import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

load_dotenv()

app = FastAPI(title="Agentic RAG")


@app.middleware("http")
async def _no_cache(request: Request, call_next):
    """Local demo: never let the browser cache HTML/JS/CSS, so edits always show."""
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, must-revalidate"
    return response

# Routes
from app.routes.ingest import router as ingest_router  # noqa: E402
from app.routes.query import router as query_router    # noqa: E402
from app.routes.session import router as session_router  # noqa: E402

app.include_router(ingest_router)
app.include_router(query_router)
app.include_router(session_router)


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/api/config")
async def config():
    has_voyage    = bool(os.getenv("VOYAGE_API_KEY"))
    has_anthropic = bool(os.getenv("ANTHROPIC_API_KEY"))
    has_google    = bool(os.getenv("GOOGLE_API_KEY"))

    embedding_models = []
    if has_voyage:
        embedding_models.append(
            {"id": "voyage-3", "name": "Voyage AI voyage-3", "dim": 1024, "default": True}
        )
    # Gemini embedding always shown — user supplies their own Google key
    embedding_models.append(
        {"id": "gemini-embedding-2", "name": "Gemini Embedding 2", "dim": 3072, "default": False}
    )
    if not embedding_models:
        embedding_models.append(
            {"id": "voyage-3", "name": "Voyage AI voyage-3 (no key set)", "dim": 1024, "default": True}
        )

    llms = [
        {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "default": True},
        {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash", "default": False},
        {"id": "gemini-3.5-flash", "name": "Gemini 3.5 Flash", "default": False},
    ]
    return {"embeddingModels": embedding_models, "llms": llms}


# Serve frontend last so API routes take priority
_frontend = Path(__file__).parent.parent / "frontend"
if _frontend.exists():
    app.mount("/", StaticFiles(directory=str(_frontend), html=True), name="frontend")
