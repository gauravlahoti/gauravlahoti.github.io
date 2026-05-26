"""Ambient-agent data tools — read/mark D1 via the resume-gate Worker.

The ambient agent has no direct database access; the Worker is the only thing
that can reach D1. These helpers GET/POST the Worker's /api/ambient/* endpoints,
authenticating with the shared X-Internal-Token (AGENT_LOG_TOKEN) — the same
secret audit_log.py uses. The base URL is derived from AGENT_LOG_URL by
stripping the /api/agent-log suffix (same trick as resume_send._check_url).

Each function is registered as an ADK tool, so it returns a plain
JSON-serialisable structure and NEVER raises: on misconfig or transport error
it returns an empty list / {"ok": False, ...} so the agent can react in-band.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_TIMEOUT_S = 8.0


def _base_url() -> str:
    base = os.environ.get("AGENT_LOG_URL", "").strip()
    return base.replace("/api/agent-log", "") if base else ""


def _token() -> str:
    return os.environ.get("AGENT_LOG_TOKEN", "").strip()


def _headers(token: str) -> dict[str, str]:
    return {"X-Internal-Token": token, "Content-Type": "application/json"}


async def get_recent_interactions(days: int = 3) -> list[dict[str, Any]]:
    """Return recent visitor conversations with the portfolio chat agent.

    Pulls the last `days` of rows from the agent interaction log so the ambient
    agent can summarise visitor activity into a digest. Use this first when
    running the visitor-intelligence task.

    Args:
        days: How many days back to include. Clamped server-side to 1..30.
            Default 3.

    Returns:
        A list of interaction dicts, most-recent first. Each:
        {question, response, status, country, city, logged_at}. `status` is one
        of ok | error | injection_blocked | too_long | rate_limited — anything
        other than "ok" is a gap worth flagging. Returns an empty list when the
        Worker is unreachable or unconfigured.
    """
    base = _base_url()
    token = _token()
    if not base or not token:
        logger.info("ambient interactions skipped: AGENT_LOG_URL/TOKEN unset")
        return []
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.get(
                f"{base}/api/ambient/interactions",
                params={"days": days},
                headers=_headers(token),
            )
        if r.status_code != 200:
            logger.warning("ambient interactions failed: %s %s", r.status_code, r.text[:200])
            return []
        return list(r.json().get("interactions", []))
    except Exception as exc:
        logger.warning("ambient interactions errored: %s", exc)
        return []


async def get_visitor_stats(days: int = 4) -> dict[str, Any]:
    """Return pre-aggregated site + agent metrics for the weekly digest.

    Combines real pageview analytics, agent conversations, and resume downloads.
    Use this once to ground the digest in numbers; the email template renders the
    dashboard from it (you do not need to restate these figures in your insights).

    Args:
        days: Size of the "this week" window, compared against the prior window
            of the same length for percentage change. Defaults to 4.

    Returns:
        A dict (empty {} if the Worker is unreachable) with keys:
          all_time:    {pageviews, unique_visitors, downloads, conversations}
          window:      {pageviews, unique_visitors, downloads, conversations,
                        agent_turns, agent_errors}
          prev_window: {pageviews, unique_visitors, downloads}
          top_questions: [{question, count}], geo: [{country, city, count}],
          errors: [{question, status, error_message, logged_at}]
    """
    base = _base_url()
    token = _token()
    if not base or not token:
        logger.info("ambient stats skipped: AGENT_LOG_URL/TOKEN unset")
        return {}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.get(
                f"{base}/api/ambient/stats",
                params={"days": days},
                headers=_headers(token),
            )
        if r.status_code != 200:
            logger.warning("ambient stats failed: %s %s", r.status_code, r.text[:200])
            return {}
        return dict(r.json())
    except Exception as exc:
        logger.warning("ambient stats errored: %s", exc)
        return {}


# Cap leads drafted per run. Drafting many leads in one turn overruns the
# model's output budget (MAX_TOKENS truncates send_lead_drafts mid-call), so the
# batch is bounded; the remaining backlog is picked up on subsequent runs once
# this batch is marked done. With a Mon+Thu cadence this drains quickly.
_MAX_LEADS_PER_RUN = 5


async def get_pending_leads() -> list[dict[str, Any]]:
    """Return resume downloaders who are awaiting a follow-up.

    These are visitors who downloaded the resume more than 24h ago and have not
    yet had a follow-up drafted. Use this to draft personalised outreach copy.

    At most a handful of leads are returned per run (the rest are deferred to the
    next run) so the drafting fits in one response — draft for ALL leads returned.

    Returns:
        A list of lead dicts, most-recent first. Each:
        {id, email, name, downloaded_at}. The `id` values are what you pass to
        mark_leads_done after drafting. Returns an empty list when the Worker is
        unreachable or unconfigured (treat as "no leads").
    """
    base = _base_url()
    token = _token()
    if not base or not token:
        logger.info("ambient leads skipped: AGENT_LOG_URL/TOKEN unset")
        return []
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.get(
                f"{base}/api/ambient/leads",
                headers=_headers(token),
            )
        if r.status_code != 200:
            logger.warning("ambient leads failed: %s %s", r.status_code, r.text[:200])
            return []
        return list(r.json().get("leads", []))[:_MAX_LEADS_PER_RUN]
    except Exception as exc:
        logger.warning("ambient leads errored: %s", exc)
        return []


async def mark_leads_done(lead_ids: list[int]) -> dict[str, Any]:
    """Mark leads as followed-up so they don't resurface on the next run.

    Call this ONLY after send_lead_drafts has returned ok, passing exactly the
    lead `id` values you just drafted outreach for. This is idempotent and
    required — without it, the same leads reappear next cycle and get re-drafted.

    Args:
        lead_ids: The `id` values from get_pending_leads that were drafted.

    Returns:
        {ok: bool, marked: int} on success, or {ok: False, error: str} if the
        Worker is unreachable or unconfigured.
    """
    base = _base_url()
    token = _token()
    if not base or not token:
        return {"ok": False, "error": "Worker not configured"}
    ids = [n for n in (lead_ids or []) if isinstance(n, int) and n > 0]
    if not ids:
        return {"ok": True, "marked": 0}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.post(
                f"{base}/api/ambient/leads/mark",
                json={"ids": ids},
                headers=_headers(token),
            )
        if r.status_code != 200:
            logger.warning("ambient mark failed: %s %s", r.status_code, r.text[:200])
            return {"ok": False, "error": f"mark failed: {r.status_code}"}
        return {"ok": True, "marked": int(r.json().get("marked", 0))}
    except Exception as exc:
        logger.warning("ambient mark errored: %s", exc)
        return {"ok": False, "error": "mark unavailable"}
