"""Send-a-note-to-Gaurav helpers for the portfolio agent.

A site visitor composes a personal message and provides their email
address. send_note_email() fires a transactional email TO Gaurav,
CC'd to the visitor so both sides have a record. Gaurav's Reply-To
goes directly back to the visitor.

Architecture:
  agent.send_note_to_gaurav(visitor_email, message)
    → validate inputs
    → POST /api/note-send-check (Worker) → {allowed}
    → call MCP tool `send-email` on the resend-mcp-server
    → POST /api/note-send-record (Worker) → row in note_sends
    → return {ok, message, code}

No limit on how often Gaurav gets contacted, that's desirable
behaviour, but the visitor's address (used as CC + Reply-To) is
rate-limited per-recipient the same way send_resume rate-limits its
recipient, so the same third-party inbox can't be spammed via a
crafted CC. Resend's own send limits apply as a further backstop.
"""
from __future__ import annotations

import logging
from typing import Any

from app.app_utils.resume_send import (
    _check_rate_limit,
    _env,
    _record_send,
    _send_via_mcp,
    hash_email,
    is_valid_email,
    record_send_failure,
)

logger = logging.getLogger(__name__)

_MIN_MESSAGE_LEN = 10
_CHECK_PATH = "note-send-check"
_RECORD_PATH = "note-send-record"


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
        rate_limited    — this recipient was already CC'd a note in the last 24h.
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

    sender  = _env("NOTE_FROM_ADDRESS") or _env("RESEND_FROM_ADDRESS")
    mcp_url = _env("RESEND_MCP_URL")
    to_addr = _env("GAURAV_CONTACT_EMAIL")
    log_tok = _env("AGENT_LOG_TOKEN")

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
    h = hash_email(visitor_clean)

    allowed, err, reason = await _check_rate_limit(h, log_tok, path=_CHECK_PATH)
    if not allowed:
        if err:
            logger.error("EMAIL_SEND_FAILED rate-limit service unreachable: %s", err)
            return {
                "ok": False,
                "code": "send_failed",
                "message": "Couldn't reach the rate-limit service — try again in a minute.",
            }
        if reason == "global_cap":
            return {
                "ok": False,
                "code": "rate_limited",
                "message": (
                    "I'm handling a lot of notes right now, so this one is "
                    "throttled. Try again shortly, or reach Gaurav directly on "
                    "LinkedIn: https://www.linkedin.com/in/glahoti/"
                ),
            }
        return {
            "ok": False,
            "code": "rate_limited",
            "message": (
                "A note was already sent to that address today — check the "
                "inbox (and spam folder). You can also reach Gaurav directly "
                "on LinkedIn: https://www.linkedin.com/in/glahoti/"
            ),
        }

    arguments = {
        "from":    sender,
        "to":      [to_addr],
        "cc":      [visitor_clean],
        "replyTo": [visitor_clean],  # Gaurav hits Reply → goes straight to visitor
        "subject": f"Note from {visitor_clean} via gauravlahoti.dev",
        "html":    _note_html(visitor_clean, msg),
        "text":    _note_text(visitor_clean, msg),
    }

    ok, _ = await _send_via_mcp(arguments)
    if not ok:
        await record_send_failure("note", "send_failed", h)
        return {
            "ok": False,
            "code": "send_failed",
            "message": (
                "Couldn't send the note right now — try again in a moment, "
                "or reach Gaurav directly on LinkedIn."
            ),
        }

    await _record_send(h, log_tok, path=_RECORD_PATH)
    return {
        "ok": True,
        "code": "ok",
        "message": (
            f"Your note is on its way to Gaurav, and a copy is heading to {visitor_clean} "
            f"so you have a record. Corporate filters can sometimes hold things up, "
            f"so while you wait you can also reach him directly on LinkedIn: "
            f"https://www.linkedin.com/in/glahoti/"
        ),
    }
