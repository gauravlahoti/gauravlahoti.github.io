"""Send-a-note-to-Gaurav helpers for the portfolio agent.

A site visitor composes a personal message and provides their email
address. send_note_email() fires a transactional email TO Gaurav,
CC'd to the visitor so both sides have a record. Gaurav's Reply-To
goes directly back to the visitor.

Architecture:
  agent.send_note_to_gaurav(visitor_email, message)
    → validate inputs
    → call MCP tool `send-email` on the resend-mcp-server
    → return {ok, message, code}

No rate-limiting: contact messages are desirable behaviour.
Resend's own send limits apply (emails/day on the free tier).
"""
from __future__ import annotations

import logging
from typing import Any

from app.app_utils.resume_send import _env, _send_via_mcp, is_valid_email

logger = logging.getLogger(__name__)

_MIN_MESSAGE_LEN = 10


def _note_html(visitor_email: str, message: str) -> str:
    def _esc(s: str) -> str:
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    safe_email = _esc(visitor_email)
    safe_msg   = _esc(message).replace("\n", "<br>")
    return (
        "<div style=\"font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;"
        "font-size:15px;line-height:1.5;color:#1a1a1a;\">"
        "<p><strong>New message from a site visitor</strong></p>"
        f"<p>From: <a href=\"mailto:{safe_email}\">{safe_email}</a></p>"
        "<blockquote style=\"border-left:4px solid #ccc;padding:8px 16px;"
        "margin:16px 0;color:#333;\">"
        f"{safe_msg}"
        "</blockquote>"
        "<p style=\"color:#666;font-size:13px;margin-top:24px;\">"
        "— Sent via the AI Agent on "
        "<a href=\"https://gauravlahoti.dev\">gauravlahoti.dev</a>. "
        "Reply directly to this email to reach the visitor.</p>"
        "</div>"
    )


def _note_text(visitor_email: str, message: str) -> str:
    return (
        "New message from a site visitor\n"
        f"From: {visitor_email}\n\n"
        f"{message}\n\n"
        "---\n"
        "Sent via the AI Agent on https://gauravlahoti.dev.\n"
        "Reply directly to this email to reach the visitor.\n"
    )


async def send_note_email(visitor_email: str, message: str) -> dict[str, Any]:
    """Validate inputs → send via MCP → return result dict.

    Schema returned to the agent:
        {"ok": bool, "message": str, "code": "<short-code>"}

    Codes:
        invalid_email   — bad format; agent should ask for a valid address.
        empty_message   — message too short; agent should ask for more.
        not_configured  — server-side env vars missing (dev / misconfig).
        send_failed     — MCP / Resend rejected or transport error.
        ok              — sent successfully.
    """
    if not is_valid_email(visitor_email):
        return {
            "ok": False,
            "code": "invalid_email",
            "message": "That doesn't look like a valid email address — could you double-check it?",
        }

    msg = message.strip()
    if len(msg) < _MIN_MESSAGE_LEN:
        return {
            "ok": False,
            "code": "empty_message",
            "message": "The message is a bit short — could you add a little more so Gaurav has something to respond to?",
        }

    sender  = _env("RESEND_FROM_ADDRESS")
    mcp_url = _env("RESEND_MCP_URL")
    to_addr = _env("GAURAV_CONTACT_EMAIL")

    if not sender or not mcp_url or not to_addr:
        return {
            "ok": False,
            "code": "not_configured",
            "message": (
                "The note-send feature isn't fully configured on this environment. "
                "You can reach Gaurav directly on LinkedIn."
            ),
        }

    visitor_clean = visitor_email.strip()
    arguments = {
        "from":    sender,
        "to":      [to_addr],
        "cc":      [visitor_clean],
        "replyTo": visitor_clean,   # Gaurav hits Reply → goes straight to visitor
        "subject": f"Note from {visitor_clean} via gauravlahoti.dev",
        "html":    _note_html(visitor_clean, msg),
        "text":    _note_text(visitor_clean, msg),
    }

    ok, _ = await _send_via_mcp(arguments)
    if not ok:
        return {
            "ok": False,
            "code": "send_failed",
            "message": (
                "Couldn't send the note right now — try again in a moment, "
                "or reach Gaurav directly on LinkedIn."
            ),
        }

    return {
        "ok": True,
        "code": "ok",
        "message": (
            f"Your note is on its way to Gaurav. "
            f"You'll get a copy at {visitor_clean} too, so you have a record of it."
        ),
    }
