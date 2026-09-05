"""Live corpus loader.

Fetches the canonical JSON data (profile, graph, posts) from the public
portfolio site with a short TTL cache, so the agent always works against the
latest content without redeploying. Falls back to the bundled snapshot in
`app/corpus/` if the network fetch fails or is disabled.

Env vars:
    CORPUS_LIVE_BASE   — base URL (default: https://gauravlahoti.dev)
    CORPUS_LIVE_TTL    — seconds (default: 60)
    CORPUS_LIVE_OFF    — set to "1" to disable live fetch (use bundled only)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger(__name__)

_BASE = os.getenv("CORPUS_LIVE_BASE", "https://gauravlahoti.dev").rstrip("/")
_TTL = int(os.getenv("CORPUS_LIVE_TTL", "60"))
_DISABLED = os.getenv("CORPUS_LIVE_OFF") == "1"
_CORPUS_DIR = Path(__file__).parent / "corpus"

_FILES = ("profile.json", "graph.json", "posts.json", "agents.json")

_cache: dict[str, Any] = {}
_cache_ts: dict[str, float] = {}
_lock = asyncio.Lock()

_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    """Cached keep-alive client — a fresh `httpx.AsyncClient` per call means a
    full TLS handshake to gauravlahoti.dev every time. Never explicitly
    closed; the process dies with the Cloud Run container."""
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=3.0)
    return _client


def _load_bundled(name: str) -> Any:
    return json.loads((_CORPUS_DIR / name).read_text(encoding="utf-8"))


async def _fetch_live(name: str) -> Any:
    url = f"{_BASE}/content/{name}"
    resp = await _get_client().get(url)
    resp.raise_for_status()
    return resp.json()


async def _get(name: str) -> Any:
    now = time.time()
    cached = _cache.get(name)
    if cached is not None and (now - _cache_ts.get(name, 0)) < _TTL:
        return cached
    async with _lock:
        cached = _cache.get(name)
        if cached is not None and (now - _cache_ts.get(name, 0)) < _TTL:
            return cached
        if not _DISABLED:
            try:
                data = await _fetch_live(name)
                _cache[name] = data
                _cache_ts[name] = now
                return data
            except Exception as exc:
                log.warning("live corpus fetch failed for %s: %s — using bundled", name, exc)
        # Fall through to bundled snapshot. Cache it briefly so we don't retry
        # the network on every call when the live fetch is failing.
        data = _load_bundled(name)
        _cache[name] = data
        _cache_ts[name] = now
        return data


async def get_profile() -> dict:
    return await _get("profile.json")


async def get_graph() -> dict:
    return await _get("graph.json")


async def get_posts() -> list:
    return await _get("posts.json")


async def get_agents() -> list:
    return await _get("agents.json")


async def _prime_async() -> None:
    for name in _FILES:
        try:
            await _get(name)
        except Exception:
            pass


def prime() -> None:
    """Best-effort warm fetch — call at startup so first user request is fast.

    Called once at process import time (see `agent.py`). Whether that import
    happens before any event loop exists (a bare script/REPL) or from inside
    one that's already running (uvicorn imports the app module from within
    its own startup coroutine) varies by how the process was launched, so
    this handles both: run synchronously via `asyncio.run` if no loop is
    running yet, otherwise schedule as a background task on the existing loop
    rather than raising `asyncio.run() cannot be called from a running event
    loop`.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(_prime_async())
    else:
        loop.create_task(_prime_async())
