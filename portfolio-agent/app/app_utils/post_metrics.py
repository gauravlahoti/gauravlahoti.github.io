"""LinkedIn post engagement metrics scraper (Spec #34).

Runs as a deterministic step inside the ambient agent cycle (not an LLM tool).
Fetches reactions, comments, and (best-effort) reposts from LinkedIn's public
embed endpoint for each post URL in posts.json, then writes the batch to D1
via the Worker.

All LinkedIn markup knowledge is isolated in _parse_counts + _parse_abbrev so
a layout change only requires editing those two functions.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_TIMEOUT_S = 12.0
_PACING_S = 1.5
_EMBED_BASE = "https://www.linkedin.com/embed/feed/update/urn:li:"
_SITE_POSTS_DEFAULT = "https://gauravlahoti.dev/assets/js/data/posts.json"
_CORPUS_POSTS = Path(__file__).parent.parent / "corpus" / "posts.json"

_BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# Reuse ambient_data helpers for Worker calls.
def _base_url() -> str:
    base = os.environ.get("AGENT_LOG_URL", "").strip()
    return base.replace("/api/agent-log", "") if base else ""


def _token() -> str:
    return os.environ.get("AGENT_LOG_TOKEN", "").strip()


def _headers(token: str) -> dict[str, str]:
    return {"X-Internal-Token": token, "Content-Type": "application/json"}


# ─── URN extraction ─────────────────────────────────────────────────────────

_URN_RE = re.compile(
    r"-(share|ugcPost|activity)-(\d{15,21})(?:-[A-Za-z0-9_]+)?/?$",
    re.IGNORECASE,
)
_URN_FALLBACK = re.compile(r"-(share|ugcPost|activity)-(\d{15,21})", re.IGNORECASE)
_URN_DIRECT = re.compile(r"urn:li:(share|ugcPost|activity):(\d{15,21})", re.IGNORECASE)


def _derive_urn(post_url: str) -> tuple[str, str] | None:
    """Extract (urn_type, activity_id) from a LinkedIn post URL, or None."""
    if not isinstance(post_url, str):
        return None
    clean = post_url.split("?")[0].split("#")[0]
    for pat in (_URN_RE, _URN_FALLBACK, _URN_DIRECT):
        m = pat.search(clean)
        if m:
            raw_type = m.group(1)
            activity_id = m.group(2)
            urn_type = "ugcPost" if raw_type.lower() == "ugcpost" else raw_type.lower()
            if urn_type not in ("share", "ugcpost", "activity"):
                urn_type = raw_type  # preserve original casing for unknown types
            return urn_type, activity_id
    return None


# ─── Embed fetch ─────────────────────────────────────────────────────────────

def _looks_like_auth_wall(html: str) -> bool:
    if not html or len(html) < 300:
        return True
    lc = html.lower()
    # "authwall" in the page key means a login gate; "session_redirect" appears
    # in hashtag links on valid public embeds and is NOT an auth wall signal.
    if "authwall" in lc:
        return True
    # Positive signal: social-action elements with data-num-reactions exist on valid embeds.
    has_counts = (
        "data-num-reactions=" in html
        or "data-num-comments=" in html
        or "social-actions__reactions" in html
    )
    return not has_counts


async def _fetch_embed(urn_type: str, activity_id: str) -> str | None:
    """Fetch the public LinkedIn embed HTML. Returns None on any failure."""
    url = f"{_EMBED_BASE}{urn_type}:{activity_id}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S, follow_redirects=True) as client:
            r = await client.get(
                url,
                headers={
                    "User-Agent": _BROWSER_UA,
                    "Accept": "text/html,application/xhtml+xml",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )
        if r.status_code != 200:
            logger.warning("[post-metrics] embed %s:%s → HTTP %s", urn_type, activity_id, r.status_code)
            return None
        html = r.text
        if _looks_like_auth_wall(html):
            logger.warning("[post-metrics] auth wall for %s:%s", urn_type, activity_id)
            return None
        return html
    except Exception as exc:
        logger.warning("[post-metrics] fetch error %s:%s: %s", urn_type, activity_id, exc)
        return None


async def _fetch_embed_with_fallback(urn_type: str, activity_id: str) -> str | None:
    """Try the URL-encoded type; fall back to 'activity' if it fails."""
    html = await _fetch_embed(urn_type, activity_id)
    if html is None and urn_type != "activity":
        html = await _fetch_embed("activity", activity_id)
    return html


# ─── Count parsing ───────────────────────────────────────────────────────────

# FRAGILITY NOTE: all LinkedIn markup knowledge lives here.
# When counts stop updating, add a new pattern to the relevant list.

def _parse_abbrev(raw: str) -> int | None:
    """Parse '1,234' → 1234, '1.2K' → 1200, '3M' → 3000000."""
    if not raw:
        return None
    s = re.sub(r",", "", raw.strip())
    m = re.match(r"^([\d.]+)\s*([KMB])?$", s, re.IGNORECASE)
    if not m:
        return None
    n = float(m.group(1))
    if not (n == n):  # NaN guard
        return None
    mult = {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000}.get((m.group(2) or "").upper(), 1)
    return round(n * mult)


def _first_number(html: str, patterns: list[str]) -> int | None:
    for pat in patterns:
        m = re.search(pat, html, re.IGNORECASE)
        if m:
            n = _parse_abbrev(m.group(1))
            if n is not None:
                return n
    return None


def _parse_counts(html: str) -> dict[str, int | None]:
    """Extract {reactions, comments, reposts} from embed HTML. Each may be None.

    FRAGILITY NOTE: all LinkedIn markup knowledge lives here.
    When counts stop updating, add a new pattern to the relevant list.
    Current embed format (2026): data attributes on social-action elements,
    e.g. data-num-reactions="64" data-num-comments="4".
    """
    reactions = _first_number(html, [
        r'data-num-reactions="(\d+)"',             # primary: data attribute
        r'social-actions__reactions[^>]+data-num-reactions="(\d+)"',
        r'"numLikes"\s*:\s*(\d+)',
        r'"reactionsCount"\s*:\s*(\d+)',
        r'([\d,KMBkmb]+)\s+Reaction',              # visible text fallback
    ])
    comments = _first_number(html, [
        r'data-num-comments="(\d+)"',              # primary: data attribute
        r'social-actions__comments[^>]+data-num-comments="(\d+)"',
        r'"numComments"\s*:\s*(\d+)',
        r'"commentsCount"\s*:\s*(\d+)',
        r'(\d+)\s+Comment',                        # visible text fallback
    ])
    reposts = _first_number(html, [
        r'data-num-reposts="(\d+)"',               # if LinkedIn adds this
        r'data-num-shares="(\d+)"',
        r'"numShares"\s*:\s*(\d+)',
        r'([\d,]+)\s+[Rr]epost',
    ])
    return {"reactions": reactions, "comments": comments, "reposts": reposts}


# ─── Posts source ────────────────────────────────────────────────────────────

async def _load_post_urls() -> list[dict[str, Any]]:
    """Fetch live posts.json; fall back to bundled corpus on failure."""
    site_url = os.environ.get("SITE_POSTS_URL", _SITE_POSTS_DEFAULT).strip()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(site_url, headers={"User-Agent": "portfolio-ambient/1.0"})
        if r.status_code == 200:
            data = r.json()
            if isinstance(data, list):
                return data
    except Exception as exc:
        logger.warning("[post-metrics] live posts.json fetch failed: %s", exc)
    # Fallback: bundled corpus
    try:
        with open(_CORPUS_POSTS) as f:
            data = json.load(f)
        if isinstance(data, list):
            logger.info("[post-metrics] using bundled corpus posts.json")
            return data
    except Exception as exc:
        logger.warning("[post-metrics] corpus posts.json unavailable: %s", exc)
    return []


# ─── Worker write ────────────────────────────────────────────────────────────

async def _write_to_worker(items: list[dict[str, Any]]) -> int:
    """POST the batch to Worker /api/post-metrics. Returns count written, or 0."""
    base = _base_url()
    token = _token()
    if not base or not token:
        logger.info("[post-metrics] Worker not configured; skipping write")
        return 0
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.post(
                f"{base}/api/post-metrics",
                json={"items": items},
                headers=_headers(token),
            )
        if r.status_code != 200:
            logger.warning("[post-metrics] write failed: %s %s", r.status_code, r.text[:200])
            return 0
        return int(r.json().get("written", 0))
    except Exception as exc:
        logger.warning("[post-metrics] write error: %s", exc)
        return 0


# ─── Main entry ──────────────────────────────────────────────────────────────

async def refresh_post_metrics() -> dict[str, Any]:
    """Scrape LinkedIn engagement counts and write to D1. Returns telemetry."""
    posts = await _load_post_urls()
    if not posts:
        logger.warning("[post-metrics] no posts to scrape")
        return {"ok": True, "posts_seen": 0, "posts_updated": 0}

    items: list[dict[str, Any]] = []
    for i, post in enumerate(posts):
        url = post.get("url", "") if isinstance(post, dict) else ""
        urn = _derive_urn(url)
        if not urn:
            logger.info("[post-metrics] skip (no URN): %s", url[:80])
            continue
        urn_type, activity_id = urn
        html = await _fetch_embed_with_fallback(urn_type, activity_id)
        if html is None:
            logger.info("[post-metrics] skip (no HTML): %s:%s", urn_type, activity_id)
            continue
        counts = _parse_counts(html)
        logger.info(
            "[post-metrics] %s:%s → reactions=%s comments=%s reposts=%s",
            urn_type, activity_id, counts["reactions"], counts["comments"], counts["reposts"],
        )
        items.append({
            "post_id":   activity_id,
            "urn_type":  urn_type,
            "reactions": counts["reactions"],
            "comments":  counts["comments"],
            "reposts":   counts["reposts"],
        })
        if i < len(posts) - 1:
            await asyncio.sleep(_PACING_S)

    written = await _write_to_worker(items) if items else 0
    return {"ok": True, "posts_seen": len(posts), "posts_updated": written}
