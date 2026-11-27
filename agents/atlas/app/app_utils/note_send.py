"""Send-a-note-to-Gaurav helpers for the portfolio agent.

A site visitor composes a personal message and provides their email
address. Since spec 111 that sends two emails: a private briefing TO Gaurav
(Reply-To the visitor) with Atlas's read of the chat and the visit's facts,
and a separate confirmation TO the visitor. Nobody is CC'd, so the briefing
can say things the visitor shouldn't see.

Architecture:
  agent.send_note_to_gaurav(visitor_email, message)
    → validate inputs
    → POST /api/note-send-check (Worker) → {allowed}
    → GET /api/note-context (Worker) → this session's pages, source, place
    → note_brief.brief_note() → Atlas's read (Gemini, ~6s cap, optional)
    → MCP `send-email`: Gaurav's briefing (must succeed)
    → MCP `send-email`: the visitor's confirmation (best effort)
    → POST /api/note-send-record (Worker) → row in note_sends
    → return {ok, message, code}

No limit on how often Gaurav gets contacted, that's desirable
behaviour, but the visitor's address (used as CC + Reply-To) is
rate-limited per-recipient the same way send_resume rate-limits its
recipient, so the same third-party inbox can't be spammed via a
crafted CC. Resend's own send limits apply as a further backstop.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import httpx

from app import corpus_live
from app.app_utils.conversation import plain_turns
from app.app_utils.note_brief import build_allowlist, brief_note
from app.app_utils.note_emails import (
    RECEIPT_SUBJECT,
    NoteEmail,
    briefing_html,
    briefing_subject,
    briefing_text,
    receipt_html,
    receipt_text,
)
from app.app_utils.resume_send import (
    _FALLBACK_CTX,
    _check_rate_limit,
    _check_url,
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
_CONTEXT_TIMEOUT_S = 2.0

# session_id -> the chat as ADK Content turns. api.py registers one so voice
# and avatar notes (live_brain's ToolDispatcher has no ToolContext) still get
# Atlas's read. The text path passes `conversation` directly instead.
_history_provider: Callable[[str], Awaitable[list]] | None = None


def set_history_provider(fn: Callable[[str], Awaitable[list]] | None) -> None:
    global _history_provider
    _history_provider = fn


async def _conversation(session_id: str | None, given: list | None) -> list[tuple[str, str]]:
    if given is not None:
        return plain_turns(given)
    if not session_id or _history_provider is None:
        return []
    try:
        return plain_turns(await _history_provider(session_id))
    except Exception:
        logger.warning("note: chat history unavailable", exc_info=True)
        return []


async def _note_context(session_id: str | None, token: str) -> dict[str, Any] | None:
    """This session's visit facts from the Worker (spec 111), or None."""
    url = _check_url("note-context")
    if not url or not token or not session_id:
        return None
    try:
        async with httpx.AsyncClient(timeout=_CONTEXT_TIMEOUT_S) as client:
            r = await client.get(url, params={"session": session_id}, headers={"X-Internal-Token": token})
        if r.status_code != 200:
            logger.warning("note-context failed: %s", r.status_code)
            return None
        ctx = r.json().get("context")
        return ctx if isinstance(ctx, dict) else None
    except Exception as exc:
        logger.warning("note-context errored: %s", type(exc).__name__)
        return None


async def _links() -> tuple[str, str]:
    """(linkedin, topmate) from the live profile, with the static fallback."""
    try:
        links = (await corpus_live.get_profile() or {}).get("links") or {}
        return (links.get("linkedin") or _FALLBACK_CTX["linkedin"],
                links.get("topmate") or _FALLBACK_CTX["topmate"])
    except Exception:
        return _FALLBACK_CTX["linkedin"], _FALLBACK_CTX["topmate"]


async def send_note_email(
    visitor_email: str, message: str, *, session_id: str | None = None,
    conversation: list | None = None,
) -> dict[str, Any]:
    """Validate inputs → send via MCP → return result dict.

    session_id is server-side context (injected via ToolContext in tools.py,
    never something the model supplies) — recorded on failure so a send that
    failed can be traced back to the conversation it happened in. It also
    keys the visit facts and, without `conversation`, the chat history.

    conversation: the chat so far as ADK Content turns (text path); None
    means read it through the registered history provider (live path).

    Schema returned to the agent:
        {"ok": bool, "message": str, "code": "<short-code>"}

    Codes:
        invalid_email   — bad format; agent should ask for a valid address.
        empty_message   — message too short; agent should ask for more.
        not_configured  — server-side env vars missing (dev / misconfig).
        rate_limited    — this recipient was already CC'd a note in the last 24h.
        send_failed     — MCP / Resend rejected or transport error.
        ok              — sent successfully.

    One more code can reach the agent without this function ever running:
    `unsupported_content`, returned by guardrails.before_tool_callback when the
    note body carries code or blows past its length cap. That check lives in
    the callback on purpose — it short-circuits the tool, so a blocked note
    costs no Resend call and no row in the rate-limit ledger.
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

    # Visit facts and Atlas's read. Both optional: a slow or failed lookup
    # leaves its section out, never the note.
    chat, context, allowlist, (linkedin, topmate) = await asyncio.gather(
        _conversation(session_id, conversation),
        _note_context(session_id, log_tok),
        build_allowlist(),
        _links(),
    )
    brief = await brief_note(msg, chat, allowlist)
    note = NoteEmail(
        visitor_email=visitor_clean, message=msg, sent_at=datetime.now(UTC),
        context=context, brief=brief, allowlist=allowlist,
        linkedin=linkedin, topmate=topmate, session_id=session_id or "",
    )

    briefing = {
        "from":    sender,
        "to":      [to_addr],
        "replyTo": [visitor_clean],  # Gaurav hits Reply → goes straight to visitor
        "subject": briefing_subject(note),
        "html":    briefing_html(note),
        "text":    briefing_text(note),
    }

    mcp_start = time.monotonic()
    ok, _, attempts = await _send_via_mcp(briefing)
    if not ok:
        latency_ms = int((time.monotonic() - mcp_start) * 1000)
        await record_send_failure(
            "note", "send_failed", h,
            session_id=session_id, attempts=attempts, latency_ms=latency_ms,
        )
        return {
            "ok": False,
            "code": "send_failed",
            "message": (
                "Couldn't send the note right now — try again in a moment, "
                "or reach Gaurav directly on LinkedIn."
            ),
        }

    # The visitor's copy. Gaurav already has the note, so a failure here is
    # logged and reported, never turned into a failed send.
    receipt_start = time.monotonic()
    # BCC Gaurav so he sees exactly what the visitor got; a reply to the
    # confirmation reaches him too. send-email requires a replyTo.
    ok, _, attempts = await _send_via_mcp({
        "from":    sender,
        "to":      [visitor_clean],
        "bcc":     [to_addr],
        "replyTo": [to_addr],
        "subject": RECEIPT_SUBJECT,
        "html":    receipt_html(note),
        "text":    receipt_text(note),
    })
    if not ok:
        await record_send_failure(
            "note", "receipt_failed", h, session_id=session_id, attempts=attempts,
            latency_ms=int((time.monotonic() - receipt_start) * 1000),
        )

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
