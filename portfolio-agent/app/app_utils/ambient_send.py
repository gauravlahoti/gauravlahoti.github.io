"""Ambient-agent email tools — send the digest and lead drafts to Gaurav.

Reuses the same Resend MCP path the chat agent already uses for resume/note
sends (`_send_via_mcp` in resume_send.py), so no Resend credentials live on the
ambient agent. Both emails go ONLY to Gaurav's inbox — the recipient is read
from GAURAV_CONTACT_EMAIL and is NEVER an argument, so visitor-authored text in
the digest can't redirect mail (injection containment, mirrors note_send.py).

Each function is registered as an ADK tool: returns {ok, code, message} and
never raises.
"""
from __future__ import annotations

import html as _htmllib
import logging
import re
from typing import Any

from app.app_utils.resume_send import _env, _send_via_mcp

logger = logging.getLogger(__name__)

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\n{3,}")


def _html_to_text(html: str) -> str:
    """Derive a plain-text fallback from the model-authored HTML.

    The Resend MCP `send-email` tool requires a `text` field; without it the
    send is rejected (-32602 invalid_type on "text"). Block tags become
    newlines, list items get a bullet, remaining tags are stripped, entities
    unescaped.
    """
    text = re.sub(r"(?i)</(p|div|h[1-6]|ul|ol|blockquote|tr)>", "\n", html)
    text = re.sub(r"(?i)<li[^>]*>", "\n- ", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = _TAG_RE.sub("", text)
    text = _htmllib.unescape(text)
    text = _WS_RE.sub("\n\n", text)
    return text.strip()


def _wrap(html: str, intro: str = "") -> str:
    """Wrap the model-authored HTML body in a simple email shell."""
    lead = f'<p style="color:#555">{intro}</p>' if intro else ""
    return (
        '<div style="font-family:sans-serif;max-width:600px;color:#111">'
        f"{lead}{html}"
        "</div>"
    )


async def _send_to_gaurav(subject: str, html: str) -> dict[str, Any]:
    sender = _env("NOTE_FROM_ADDRESS") or _env("RESEND_FROM_ADDRESS")
    to_addr = _env("GAURAV_CONTACT_EMAIL")
    mcp_url = _env("RESEND_MCP_URL")
    if not sender or not to_addr or not mcp_url:
        return {
            "ok": False,
            "code": "not_configured",
            "message": "Ambient email isn't configured on this environment.",
        }
    arguments = {
        "from": sender,
        "to": [to_addr],  # hardcoded recipient — never taken from model input
        "subject": subject,
        "html": html,
        "text": _html_to_text(html),  # Resend MCP requires a text part
    }
    ok, _ = await _send_via_mcp(arguments)
    if not ok:
        return {"ok": False, "code": "send_failed", "message": "The email couldn't be sent right now."}
    return {"ok": True, "code": "ok", "message": "Sent to Gaurav."}


async def send_digest_email(html_body: str) -> dict[str, Any]:
    """Email the visitor-intelligence digest to Gaurav.

    Call this once, after composing the digest from get_recent_interactions.

    Args:
        html_body: The digest as plain HTML (use <strong>, <ul><li> — no
            markdown, no code fences). It is wrapped in an email shell for you.

    Returns:
        {ok: bool, code: str, message: str}. code is one of:
            ok | not_configured | send_failed.
    """
    return await _send_to_gaurav(
        subject="Agent digest — visitor intelligence",
        html=_wrap(html_body),
    )


async def send_lead_drafts(html_body: str) -> dict[str, Any]:
    """Email the follow-up drafts for pending leads to Gaurav for review.

    Call this once, after composing one draft per lead from get_pending_leads.
    On a successful (ok) result, follow up by calling mark_leads_done with the
    drafted lead ids.

    Args:
        html_body: The drafts as plain HTML (e.g. an <h4> per lead followed by a
            <blockquote> draft). It is wrapped in an email shell for you.

    Returns:
        {ok: bool, code: str, message: str}. code is one of:
            ok | not_configured | send_failed.
    """
    return await _send_to_gaurav(
        subject="New leads — follow-up drafts ready",
        html=_wrap(
            html_body,
            intro="These visitors downloaded your resume and haven't been followed up. "
            "AI-drafted outreach below — edit and send as you see fit.",
        ),
    )
