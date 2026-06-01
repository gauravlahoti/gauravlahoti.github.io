"""Custom HTTP routes for Pulse — the ambient digest agent.

Two scheduler-triggered routes plus a liveness probe:

- `POST /api/ambient/run`     — drive the twice-weekly ambient cycle once.
- `POST /api/ambient/metrics` — scrape LinkedIn engagement counts → D1 (no LLM,
  no email).
- `GET  /healthz`             — Cloud Run liveness probe.

Both ambient routes are gated by `AMBIENT_TRIGGER_TOKEN` — a dedicated secret
(NOT AGENT_LOG_TOKEN) supplied by Cloud Scheduler via the `x-internal-token`
header, so the trigger holds only a narrow credential.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from google.genai import types
from google.adk.runners import InMemoryRunner

from app.agent import root_agent
from app.app_utils.post_metrics import refresh_post_metrics

logger = logging.getLogger(__name__)

APP_NAME = "app"  # matches App(name="app") in agent.py

# One Runner per process for the ambient agent. Its sessions are ephemeral —
# one per scheduled trigger.
_runner = InMemoryRunner(agent=root_agent, app_name=APP_NAME)


def _fr_value(resp: Any) -> Any:
    """Unwrap an ADK function_response payload to the tool's return value."""
    if isinstance(resp, dict) and "result" in resp:
        return resp["result"]
    return resp


async def _run_ambient_cycle() -> dict[str, Any]:
    """Drive the ambient agent once and return count-only telemetry.

    Inspects the event stream's function_call / function_response parts to
    derive {interactions_seen, leads_processed, emails_sent} without surfacing
    any PII. Logs a warning if drafts were sent but leads were never marked
    (the autonomous agent skipped mark_leads_done).
    """
    session_id = f"ambient-{int(time.time())}"
    svc = _runner.session_service
    await svc.create_session(
        app_name=APP_NAME, user_id=session_id, session_id=session_id
    )

    kickoff = types.Content(
        role="user",
        parts=[types.Part.from_text(text="Run the twice-weekly ambient cycle now.")],
    )

    interactions_seen = 0
    leads_processed = 0
    leads_seen = 0
    emails_sent = 0
    saw_mark_call = False
    drafts_sent_ok = False
    call_trace: list[str] = []  # ordered tool calls the agent made
    finish_reasons: list[str] = []

    async for event in _runner.run_async(
        user_id=session_id,
        session_id=session_id,
        new_message=kickoff,
    ):
        fr_reason = getattr(event, "finish_reason", None) or getattr(
            getattr(event, "candidate", None), "finish_reason", None
        )
        if fr_reason:
            finish_reasons.append(str(fr_reason))
        content = getattr(event, "content", None)
        if content is None:
            continue
        for part in getattr(content, "parts", None) or []:
            fc = getattr(part, "function_call", None)
            if fc is not None:
                call_trace.append(str(getattr(fc, "name", None)))
                if getattr(fc, "name", None) == "mark_leads_done":
                    saw_mark_call = True

            fr = getattr(part, "function_response", None)
            if fr is None:
                continue
            name = getattr(fr, "name", None)
            value = _fr_value(getattr(fr, "response", None))
            if name == "get_recent_interactions" and isinstance(value, list):
                interactions_seen = len(value)
            elif name == "get_pending_leads" and isinstance(value, list):
                leads_seen = len(value)
            elif name == "mark_leads_done" and isinstance(value, dict):
                leads_processed = int(value.get("marked", 0) or 0)
            elif name == "send_review_email":
                if isinstance(value, dict) and value.get("ok"):
                    emails_sent += 1
                    # The single email carries the lead drafts; treat a
                    # successful send as drafts-sent when leads were pending.
                    if leads_seen > 0:
                        drafts_sent_ok = True
                else:
                    logger.warning("[ambient] send_review_email returned not-ok: %s", value)

    truncated = any("MAX_TOKENS" in r for r in finish_reasons)
    leads_dropped = leads_seen > 0 and not drafts_sent_ok
    if truncated or leads_dropped or (drafts_sent_ok and not saw_mark_call):
        # Loud only on anomaly: token truncation, leads fetched but never
        # drafted/sent, or drafts sent without the required mark.
        logger.warning(
            "[ambient] anomaly — calls=%s finish=%s leads_seen=%d emails=%d marked=%d",
            call_trace or "<none>",
            finish_reasons or "<none>",
            leads_seen,
            emails_sent,
            leads_processed,
        )

    return {
        "ok": True,
        "interactions_seen": interactions_seen,
        "leads_processed": leads_processed,
        "emails_sent": emails_sent,
    }


def register_routes(app: FastAPI) -> None:
    """Attach the Pulse ambient routes to a FastAPI app."""

    @app.get("/healthz")
    async def healthz() -> dict[str, bool]:
        return {"ok": True}

    @app.post("/api/ambient/run")
    async def ambient_run(request: Request) -> Any:
        token = os.environ.get("AMBIENT_TRIGGER_TOKEN", "").strip()
        if not token:
            return JSONResponse(
                status_code=503, content={"ok": False, "error": "Ambient trigger disabled"}
            )
        if request.headers.get("x-internal-token") != token:
            return JSONResponse(
                status_code=401, content={"ok": False, "error": "Unauthorized"}
            )
        try:
            result = await _run_ambient_cycle()
        except Exception as exc:
            logger.exception("ambient cycle failed")
            return JSONResponse(
                status_code=500, content={"ok": False, "error": repr(exc)[:300]}
            )
        return JSONResponse(status_code=200, content=result)

    @app.post("/api/ambient/metrics")
    async def ambient_metrics(request: Request) -> Any:
        """Scrape LinkedIn engagement counts and write to D1. No LLM, no email."""
        token = os.environ.get("AMBIENT_TRIGGER_TOKEN", "").strip()
        if not token:
            return JSONResponse(
                status_code=503, content={"ok": False, "error": "Ambient trigger disabled"}
            )
        if request.headers.get("x-internal-token") != token:
            return JSONResponse(
                status_code=401, content={"ok": False, "error": "Unauthorized"}
            )
        try:
            result = await refresh_post_metrics()
        except Exception as exc:
            logger.exception("metrics refresh failed")
            return JSONResponse(
                status_code=500, content={"ok": False, "error": repr(exc)[:300]}
            )
        return JSONResponse(status_code=200, content=result)
