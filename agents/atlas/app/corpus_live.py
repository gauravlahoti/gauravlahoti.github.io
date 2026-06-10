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

import json
import logging
import os
import threading
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
_lock = threading.Lock()


def _load_bundled(name: str) -> Any:
    return json.loads((_CORPUS_DIR / name).read_text(encoding="utf-8"))


def _fetch_live(name: str) -> Any:
    url = f"{_BASE}/content/{name}"
    resp = httpx.get(url, timeout=3.0)
    resp.raise_for_status()
    return resp.json()


def _get(name: str) -> Any:
    now = time.time()
    cached = _cache.get(name)
    if cached is not None and (now - _cache_ts.get(name, 0)) < _TTL:
        return cached
    with _lock:
        cached = _cache.get(name)
        if cached is not None and (now - _cache_ts.get(name, 0)) < _TTL:
            return cached
        if not _DISABLED:
            try:
                data = _fetch_live(name)
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


def get_profile() -> dict:
    return _get("profile.json")


def get_graph() -> dict:
    return _get("graph.json")


def get_posts() -> list:
    return _get("posts.json")


def get_agents() -> list:
    return _get("agents.json")


def prime() -> None:
    """Best-effort warm fetch — call at startup so first user request is fast."""
    for name in _FILES:
        try:
            _get(name)
        except Exception:
            pass
