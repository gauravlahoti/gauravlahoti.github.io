"""Send-resume-by-email helpers for the portfolio agent.

Architecture:
  agent.send_resume(email)
    → validate format
    → POST /api/resume-send-check (Worker) → {allowed}
    → call MCP tool `send-email` on the resend-mcp-server (Streamable HTTP)
    → POST /api/resume-send-record (Worker) → row in resume_sends
    → return {ok, message}

The Resend API key lives ONLY on the resend-mcp-server (mounted via
Secret Manager). The portfolio agent has no Resend credentials — it
just speaks MCP to a trusted internal service. Recipient address is
hashed (sha256(email|UTC_DATE)[:16]) before any persistence.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

logger = logging.getLogger(__name__)

# RFC 5322-loose: enough to reject obvious typos, not strict enough to bounce
# valid edge cases. Resend will reject malformed addresses anyway.
_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
_MAX_EMAIL_LEN = 200

_HTTP_TIMEOUT_S = 8.0
_MCP_TIMEOUT_S = 15.0  # MCP initialize + tool call may legitimately take a few seconds

# Retry budget for the MCP hop. Kept identical to the atlas copy of this file.
# The resend-mcp-server runs at min-instances=0, so a send can arrive while it is
# still cold. Its readiness gate makes Cloud Run queue the request rather than
# refuse it, but the queue wait can outlast a single attempt's timeout, so one
# transport failure is not evidence the send is impossible.
_MCP_MAX_ATTEMPTS = 3
_MCP_BACKOFF_S = (1.0, 4.0)  # sleep before attempts 2 and 3
_MCP_TOTAL_BUDGET_S = 32.0
_MCP_MIN_ATTEMPT_S = 3.0  # don't start an attempt that can't plausibly finish


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def hash_email(email: str) -> str:
    """sha256(email|UTC_DATE)[:16]. Daily-rotating salt, no manual rotation."""
    salt = datetime.now(UTC).strftime("%Y-%m-%d")
    return hashlib.sha256(f"{email.lower()}|{salt}".encode()).hexdigest()[:16]


def is_valid_email(email: str) -> bool:
    if not isinstance(email, str):
        return False
    e = email.strip()
    if not (3 <= len(e) <= _MAX_EMAIL_LEN):
        return False
    return bool(_EMAIL_RE.match(e))


def _check_url() -> str:
    base = _env("AGENT_LOG_URL")
    return base.replace("/api/agent-log", "/api/resume-send-check") if base else ""


def _record_url() -> str:
    base = _env("AGENT_LOG_URL")
    return base.replace("/api/agent-log", "/api/resume-send-record") if base else ""


async def _check_rate_limit(email_hash: str, token: str) -> tuple[bool, str | None]:
    url = _check_url()
    if not url or not token:
        # No Worker configured (local dev without backend) → permit but log.
        logger.info("resume-send-check skipped: AGENT_LOG_URL/TOKEN unset")
        return True, None
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_S) as client:
            r = await client.post(
                url,
                json={"emailHash": email_hash},
                headers={"X-Internal-Token": token, "Content-Type": "application/json"},
            )
        if r.status_code != 200:
            return False, f"check failed: {r.status_code}"
        data = r.json()
        return bool(data.get("allowed", False)), None
    except Exception as exc:
        logger.warning("resume-send-check errored: %s", exc)
        return False, "check unavailable"


async def _record_send(email_hash: str, token: str) -> None:
    url = _record_url()
    if not url or not token:
        return
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_S) as client:
            r = await client.post(
                url,
                json={"emailHash": email_hash},
                headers={"X-Internal-Token": token, "Content-Type": "application/json"},
            )
            if r.status_code >= 400:
                logger.warning("resume-send-record failed: %s %s", r.status_code, r.text[:200])
    except Exception as exc:
        logger.warning("resume-send-record errored: %s", exc)


def _email_html() -> str:
    return (
        "<div style=\"font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;"
        "font-size:15px;line-height:1.5;color:#1a1a1a;\">"
        "<p>Hi,</p>"
        "<p>You requested Gaurav Lahoti's resume from the AI Agent at "
        "<a href=\"https://gauravlahoti.dev\">gauravlahoti.dev</a>. "
        "The PDF is attached.</p>"
        "<p>If this email lands in spam or doesn't arrive at all, you can grab the "
        "resume directly from <a href=\"https://gauravlahoti.dev\">gauravlahoti.dev</a> "
        "— click the Resume button at the top of the page.</p>"
        "<p>If you didn't request this, ignore the email — your address won't be used again.</p>"
        "<p>To follow up directly:<br>"
        "LinkedIn: <a href=\"https://www.linkedin.com/in/glahoti/\">linkedin.com/in/glahoti</a><br>"
        "Topmate (advisory): <a href=\"https://topmate.io/gaurav_lahoti\">topmate.io/gaurav_lahoti</a></p>"
        "<p style=\"color:#666;font-size:13px;margin-top:24px;\">"
        "— Sent automatically by the AI Agent. Replies are not monitored.</p>"
        "</div>"
    )


def _email_text() -> str:
    return (
        "Hi,\n\n"
        "You requested Gaurav Lahoti's resume from the AI Agent at "
        "https://gauravlahoti.dev. The PDF is attached.\n\n"
        "If this email lands in spam or doesn't arrive at all, you can grab "
        "the resume directly from https://gauravlahoti.dev — click the Resume "
        "button at the top of the page.\n\n"
        "If you didn't request this, ignore the email — your address won't be used again.\n\n"
        "To follow up directly:\n"
        "LinkedIn: https://www.linkedin.com/in/glahoti/\n"
        "Topmate (advisory): https://topmate.io/gaurav_lahoti\n\n"
        "— Sent automatically by the AI Agent. Replies are not monitored.\n"
    )


def _mcp_health_url() -> str:
    """Derive the MCP server's /healthz from RESEND_MCP_URL (which ends in /mcp)."""
    url = _env("RESEND_MCP_URL")
    if not url:
        return ""
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return ""
    return urlunsplit((parts.scheme, parts.netloc, "/healthz", "", ""))


async def warm_mcp_server(timeout_s: float = 3.0) -> bool:
    """Nudge the resend-mcp-server awake. Best effort, never raises.

    The service sits at min-instances=0 and takes several seconds to boot, so
    waking it before the cycle needs it keeps the digest send off the cold path.
    """
    url = _mcp_health_url()
    if not url:
        return False
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            r = await client.get(url)
        return r.status_code == 200
    except Exception as exc:
        # A cold instance may not answer within the timeout; that is fine, the
        # request still triggered the scale-up, which was the point.
        logger.info("MCP warm ping did not complete: %s", exc)
        return False


async def _attempt_send_via_mcp(
    mcp_url: str, mcp_headers: dict[str, str], arguments: dict[str, Any], timeout_s: float
) -> tuple[bool, str | None]:
    """One MCP `send-email` attempt.

    Returns (ok, error_message). Raises on transport failure so the caller can
    decide whether to retry; a tool-level rejection returns (False, msg) instead,
    because that is Resend refusing the message and retrying would not help.
    """
    async with streamablehttp_client(mcp_url, headers=mcp_headers, timeout=timeout_s) as (
        read,
        write,
        _,
    ):
        async with ClientSession(
            read, write, read_timeout_seconds=timedelta(seconds=timeout_s)
        ) as session:
            await session.initialize()
            result = await session.call_tool("send-email", arguments)
    if getattr(result, "isError", False):
        payload = getattr(result, "content", None)
        logger.error("EMAIL_SEND_FAILED MCP send-email rejected the message: %r", payload)
        return False, "MCP server returned error"
    return True, None


async def _send_via_mcp(arguments: dict[str, Any]) -> tuple[bool, str | None]:
    """Call the resend-mcp-server's `send-email` tool, retrying transport failures.

    Returns (ok, error_message). Retries cover the cold-start window on the MCP
    server; a tool-level rejection is returned immediately without retry, since
    re-sending could deliver the same email twice.
    """
    mcp_url = _env("RESEND_MCP_URL")
    if not mcp_url:
        logger.error("EMAIL_SEND_FAILED RESEND_MCP_URL not configured")
        return False, "RESEND_MCP_URL not configured"
    caller_token = _env("MCP_CALLER_TOKEN")
    mcp_headers = {"Authorization": f"Bearer {caller_token}"} if caller_token else {}

    deadline = time.monotonic() + _MCP_TOTAL_BUDGET_S
    last_exc: Exception | None = None

    for attempt in range(1, _MCP_MAX_ATTEMPTS + 1):
        remaining = deadline - time.monotonic()
        if remaining < _MCP_MIN_ATTEMPT_S:
            break
        try:
            return await _attempt_send_via_mcp(
                mcp_url, mcp_headers, arguments, min(_MCP_TIMEOUT_S, remaining)
            )
        except Exception as exc:
            last_exc = exc
            # Intermediate attempts stay at WARNING on purpose: the alert policy
            # matches EMAIL_SEND_FAILED, and a transient that we then recover
            # from is not something to wake anyone up for.
            logger.warning(
                "MCP send-email attempt %d/%d failed: %s", attempt, _MCP_MAX_ATTEMPTS, exc
            )
            if attempt <= len(_MCP_BACKOFF_S):
                backoff = _MCP_BACKOFF_S[attempt - 1]
                if deadline - time.monotonic() > backoff + _MCP_MIN_ATTEMPT_S:
                    await asyncio.sleep(backoff)

    logger.error(
        "EMAIL_SEND_FAILED MCP send-email exhausted %d attempts in %.0fs budget: %s",
        _MCP_MAX_ATTEMPTS,
        _MCP_TOTAL_BUDGET_S,
        last_exc,
    )
    return False, "MCP transport error"


async def send_resume_email(email: str) -> dict[str, Any]:
    """Validate → rate-limit → send via MCP → record. Returns a result dict.

    Schema returned to the agent:
        {"ok": bool, "message": str, "code": "<short-code>"}

    Codes:
        invalid_email     — bad format, agent should ask for a valid one
        rate_limited      — already sent in the past 24h to this address
        not_configured    — server-side env vars missing (dev / misconfig)
        send_failed       — MCP / Resend rejected or transport error
        ok                — sent successfully
    """
    if not is_valid_email(email):
        return {"ok": False, "code": "invalid_email",
                "message": "That doesn't look like a valid email address. Could you double-check it?"}

    sender   = _env("RESEND_FROM_ADDRESS")
    pdf_url  = _env("RESUME_PDF_URL") or "https://gauravlahoti.dev/assets/img/resume.pdf"
    log_tok  = _env("AGENT_LOG_TOKEN")
    mcp_url  = _env("RESEND_MCP_URL")

    if not sender or not mcp_url:
        return {"ok": False, "code": "not_configured",
                "message": "Email send isn't configured on this environment."}

    email_clean = email.strip()
    h = hash_email(email_clean)

    allowed, err = await _check_rate_limit(h, log_tok)
    if not allowed:
        if err:
            return {"ok": False, "code": "send_failed",
                    "message": "Couldn't reach the rate-limit service — try again in a minute."}
        return {"ok": False, "code": "rate_limited",
                "message": "Looks like that resume already went out to that address today. Check your inbox (and spam folder)."}

    arguments = {
        "from": sender,
        "to": [email_clean],
        "subject": "Resume — Gaurav Lahoti",
        "html": _email_html(),
        "text": _email_text(),
        "attachments": [{
            "filename": "Gaurav_Lahoti_Senior_Architect.pdf",
            "url": pdf_url,
        }],
    }

    ok, mcp_err = await _send_via_mcp(arguments)
    if not ok:
        return {"ok": False, "code": "send_failed",
                "message": "The email couldn't be sent right now. Try again, or reach Gaurav on LinkedIn."}

    await _record_send(h, log_tok)
    return {"ok": True, "code": "ok",
            "message": "Sent — should arrive in your inbox in a moment. Check the spam folder if it doesn't show up."}
