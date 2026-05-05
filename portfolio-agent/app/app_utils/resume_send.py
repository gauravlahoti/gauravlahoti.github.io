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

import hashlib
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

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


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def hash_email(email: str) -> str:
    """sha256(email|UTC_DATE)[:16]. Daily-rotating salt, no manual rotation."""
    salt = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return hashlib.sha256(f"{email.lower()}|{salt}".encode("utf-8")).hexdigest()[:16]


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
        "<p>You requested Gaurav Lahoti's resume from the chat agent at "
        "<a href=\"https://gauravlahoti.github.io\">gauravlahoti.github.io</a>. "
        "The PDF is attached.</p>"
        "<p>If you didn't request this, ignore the email — your address won't be used again.</p>"
        "<p>To follow up directly:<br>"
        "LinkedIn: <a href=\"https://www.linkedin.com/in/glahoti/\">linkedin.com/in/glahoti</a><br>"
        "Topmate (advisory): <a href=\"https://topmate.io/gaurav_lahoti\">topmate.io/gaurav_lahoti</a></p>"
        "<p style=\"color:#666;font-size:13px;margin-top:24px;\">"
        "— Sent automatically by the portfolio agent. Replies are not monitored.</p>"
        "</div>"
    )


def _email_text() -> str:
    return (
        "Hi,\n\n"
        "You requested Gaurav Lahoti's resume from the chat agent at "
        "https://gauravlahoti.github.io. The PDF is attached.\n\n"
        "If you didn't request this, ignore the email — your address won't be used again.\n\n"
        "To follow up directly:\n"
        "LinkedIn: https://www.linkedin.com/in/glahoti/\n"
        "Topmate (advisory): https://topmate.io/gaurav_lahoti\n\n"
        "— Sent automatically by the portfolio agent. Replies are not monitored.\n"
    )


async def _send_via_mcp(arguments: dict[str, Any]) -> tuple[bool, str | None]:
    """Call the resend-mcp-server's `send-email` tool. Returns (ok, error_message)."""
    mcp_url = _env("RESEND_MCP_URL")
    if not mcp_url:
        return False, "RESEND_MCP_URL not configured"
    try:
        async with streamablehttp_client(mcp_url) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool("send-email", arguments)
        if getattr(result, "isError", False):
            payload = getattr(result, "content", None)
            logger.warning("MCP send-email returned error: %r", payload)
            return False, "MCP server returned error"
        return True, None
    except Exception as exc:
        logger.warning("MCP send-email errored: %s", exc)
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
    pdf_url  = _env("RESUME_PDF_URL") or "https://gauravlahoti.github.io/assets/img/resume.pdf"
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
        # The resend-mcp tool wraps attachments differently from Resend's
        # REST API — `url` here is renamed to `path` before forwarding.
        # See node_modules/resend-mcp/dist/tools/emails.js (att.url → result.path).
        "attachments": [{
            "filename": "Gaurav-Lahoti-Resume.pdf",
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
