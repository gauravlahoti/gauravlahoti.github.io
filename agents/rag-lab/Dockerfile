FROM python:3.11-slim AS builder

WORKDIR /build
RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

FROM python:3.11-slim

# ChromaDB's ONNX runtime requires libgomp
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/.venv /app/.venv
COPY app/ app/
COPY frontend/ frontend/

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PORT=8080

EXPOSE 8080

CMD ["/app/.venv/bin/python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
