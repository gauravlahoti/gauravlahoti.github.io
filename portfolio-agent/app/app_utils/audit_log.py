"""Fire-and-forget audit logger for portfolio agent turns.

Posts each (question, response) turn to the resume-gate Worker's
/api/agent-log endpoint. Authenticates with a shared HMAC token in the
X-Internal-Token header. Both the URL and the token are read from env;
when either is unset, log_interaction is a no-op (so local dev without
the Worker stays silent).

Failures NEVER propagate — the user response must never be blocked by
a logging hiccup.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_AGENT_LOG_URL = os.environ.get("AGENT_LOG_URL", "").strip()
_AGENT_LOG_TOKEN = os.environ.get("AGENT_LOG_TOKEN", "").strip()
_TIMEOUT_S = 2.0  # short — runs after the SSE 'done' event has already shipped


async def log_interaction(payload: dict[str, Any]) -> None:
    """Post one agent turn to the audit log endpoint. Swallows all exceptions."""
    if not _AGENT_LOG_URL or not _AGENT_LOG_TOKEN:
        return
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.post(
                _AGENT_LOG_URL,
                json=payload,
                headers={
                    "X-Internal-Token": _AGENT_LOG_TOKEN,
                    "Content-Type": "application/json",
                },
            )
            if r.status_code >= 400:
                logger.warning(
                    "audit-log post failed: %s %s", r.status_code, r.text[:200]
                )
    except Exception as exc:
        logger.warning("audit-log post errored: %s", exc)
