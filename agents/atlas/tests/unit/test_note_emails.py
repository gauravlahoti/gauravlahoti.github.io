"""Spec 111: the two note emails, Atlas's read, and the send flow."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest

from app.app_utils import note_brief, note_emails, note_send
from app.app_utils.note_brief import Brief, Pick, parse_brief
from app.app_utils.note_emails import NoteEmail

_LAB = Pick("lab-mcp", "Model Context Protocol", "https://gauravlahoti.dev/ai-labs/mcp-lab/", "Lab", "USB-C for AI")
_AGENT = Pick("agent-atlas", "Atlas, Portfolio Intelligence Agent",
              "https://gauravlahoti.dev/live-agents/?agent=atlas", "Agent", "")
_ALLOW = [*note_brief._STATIC, _LAB, _AGENT]
_NOW = datetime(2026, 11, 27, 4, 0, tzinfo=UTC)
_CTX = {"referrer": "linkedin", "pages": ["/", "/ai-labs/mcp-lab/"], "city": "Pune", "country": "IN",
        "first_seen": _NOW.timestamp() - 600, "turns": 3, "modes": ["text"]}


def _note(**kw) -> NoteEmail:
    base = dict(visitor_email="jane@example.com", message="Hi Gaurav, would love to chat about agents.",
                sent_at=_NOW, context=_CTX, allowlist=_ALLOW, session_id="1b9d6bcd-bbfd")
    base.update(kw)
    return NoteEmail(**base)


def _brief() -> Brief:
    return Brief(next_step="Reply and offer a time.", suggest_call=True,
                 asked_about=["How MCP works"], picks=[(_LAB, "Since you asked about MCP."), (_AGENT, "See Atlas.")])


# ── parse_brief: the model can only ever pick allowlisted pages ─────────────

def test_picks_off_the_allowlist_are_dropped():
    raw = json.dumps({"next_step": "Reply.", "suggest_call": False, "asked_about": ["MCP"],
                      "picks": [{"id": "lab-mcp", "why": "Try it."}, {"id": "evil", "why": "x"},
                                {"id": "lab-mcp", "why": "again"}]})
    b = parse_brief(raw, _ALLOW)
    assert [p.id for p, _ in b.picks] == ["lab-mcp"]


def test_unusable_model_output_is_none():
    assert parse_brief("not json", _ALLOW) is None
    assert parse_brief("[]", _ALLOW) is None
    assert parse_brief(json.dumps({"next_step": "", "asked_about": [], "picks": []}), _ALLOW) is None


def test_model_text_is_capped_and_dash_free():
    raw = json.dumps({"next_step": "Reply now — they are keen " + "x" * 400, "suggest_call": "yes",
                      "asked_about": ["a" * 300], "picks": []})
    b = parse_brief(raw, _ALLOW)
    assert "—" not in b.next_step and len(b.next_step) <= 180
    assert len(b.asked_about[0]) <= 90
    assert b.suggest_call is False          # only a real boolean true counts


def test_brief_note_falls_back_on_timeout(monkeypatch):
    async def slow(*_a, **_k):
        await asyncio.sleep(5)
    monkeypatch.setattr(note_brief, "_generate", slow)
    monkeypatch.setattr(note_brief, "BRIEF_TIMEOUT_S", 0.05)
    assert asyncio.run(note_brief.brief_note("hello there", [], _ALLOW)) is None


# ── rendering ────────────────────────────────────────────────────────────────

def test_visitor_text_is_escaped_everywhere():
    evil = '<script>alert(1)</script> "quoted" & more'
    n = _note(message=evil, brief=Brief(next_step="<b>x</b>", asked_about=["<img src=x>"]))
    for html in (note_emails.briefing_html(n), note_emails.receipt_html(n)):
        assert "<script>" not in html and "<img src=x>" not in html and "<b>x</b>" not in html
        assert "&lt;script&gt;" in html


def test_briefing_shows_the_read_and_the_visit():
    html = note_emails.briefing_html(_note(brief=_brief()))
    assert "Reply and offer a time." in html and "Book a call" in html
    assert "How MCP works" in html and "Gemini" not in html
    assert "LinkedIn" in html and "Home &#8594; Model Context Protocol" in html
    assert "Pune, India" in html and "10 min after arriving" in html
    assert "mailto:jane@example.com" in html


def test_briefing_without_ai_still_has_everything_else():
    html = note_emails.briefing_html(_note(brief=None))
    assert "couldn&#39;t summarise this chat" in html
    assert "Hi Gaurav, would love to chat about agents." in html and "LinkedIn" in html


def test_receipt_uses_ai_picks_or_falls_back_to_defaults():
    personal = note_emails.receipt_html(_note(brief=_brief()))
    assert "Since you asked about MCP." in personal and "Picked from what we talked about." in personal
    plain = note_emails.receipt_html(_note(brief=None))
    assert "Live agents" in plain and "A few places to start." in plain
    assert "Gemini" not in personal and "Gemini" not in plain


def test_receipt_never_shows_the_private_read():
    html = note_emails.receipt_html(_note(brief=_brief()))
    assert "Reply and offer a time." not in html and "How MCP works" not in html
    assert "Pune" not in html and "LinkedIn" in html     # LinkedIn only as the button


def test_fixed_copy_has_no_em_dashes():
    for fn in (note_emails.briefing_html, note_emails.receipt_html,
               note_emails.briefing_text, note_emails.receipt_text):
        for b in (None, _brief()):
            assert "—" not in fn(_note(brief=b))
    assert "—" not in note_emails.RECEIPT_SUBJECT
    assert "—" not in note_emails.briefing_subject(_note())


def test_long_messages_get_a_short_subject():
    s = note_emails.briefing_subject(_note(message="word " * 40))
    assert len(s) < 100 and s.endswith('..."')


# ── send flow ────────────────────────────────────────────────────────────────

_ENV = {"NOTE_FROM_ADDRESS": "agent@gauravlahoti.dev", "RESEND_MCP_URL": "https://mcp.example/mcp",
        "GAURAV_CONTACT_EMAIL": "gaurav@example.com", "AGENT_LOG_TOKEN": "t"}


@pytest.fixture
def flow(monkeypatch):
    for k, v in _ENV.items():
        monkeypatch.setenv(k, v)
    send = AsyncMock(return_value=(True, None, 1))
    patches = [
        patch.object(note_send, "_check_rate_limit", AsyncMock(return_value=(True, None, None))),
        patch.object(note_send, "_record_send", AsyncMock()),
        patch.object(note_send, "record_send_failure", AsyncMock()),
        patch.object(note_send, "_send_via_mcp", send),
        patch.object(note_send, "_note_context", AsyncMock(return_value=_CTX)),
        patch.object(note_send, "build_allowlist", AsyncMock(return_value=_ALLOW)),
        patch.object(note_send, "brief_note", AsyncMock(return_value=_brief())),
        patch.object(note_send, "_links", AsyncMock(return_value=("https://li", "https://tm"))),
    ]
    for p in patches:
        p.start()
    yield send
    for p in patches:
        p.stop()


def test_two_emails_and_nobody_is_ccd(flow):
    result = asyncio.run(note_send.send_note_email("jane@example.com", "Hi Gaurav, let's talk soon.",
                                                   session_id="s-12345678", conversation=[]))
    assert result["ok"] is True
    (briefing,), (receipt,) = (c.args for c in flow.call_args_list)
    assert briefing["to"] == ["gaurav@example.com"] and briefing["replyTo"] == ["jane@example.com"]
    assert receipt["to"] == ["jane@example.com"]
    assert receipt["bcc"] == ["gaurav@example.com"] and receipt["replyTo"] == ["gaurav@example.com"]
    assert "cc" not in briefing and "cc" not in receipt and "bcc" not in briefing
    assert "Reply and offer a time." in briefing["html"]
    assert "Reply and offer a time." not in receipt["html"]
    note_send._record_send.assert_awaited_once()


def test_a_failed_briefing_is_a_failed_send(flow):
    flow.return_value = (False, "boom", 3)
    result = asyncio.run(note_send.send_note_email("jane@example.com", "Hi Gaurav, let's talk soon."))
    assert result["code"] == "send_failed"
    assert flow.await_count == 1                      # no receipt for a note Gaurav never got
    note_send._record_send.assert_not_awaited()


def test_a_failed_receipt_still_reports_success(flow):
    flow.side_effect = [(True, None, 1), (False, "boom", 3)]
    result = asyncio.run(note_send.send_note_email("jane@example.com", "Hi Gaurav, let's talk soon."))
    assert result["ok"] is True
    note_send.record_send_failure.assert_awaited_once()
    assert note_send.record_send_failure.await_args.args[:2] == ("note", "receipt_failed")
    note_send._record_send.assert_awaited_once()


def test_live_path_reads_the_chat_through_the_provider(flow):
    from google.genai import types
    seen = []

    async def provider(sid):
        seen.append(sid)
        return [types.Content(role="user", parts=[types.Part.from_text(text="How does MCP work?")])]

    note_send.set_history_provider(provider)
    try:
        asyncio.run(note_send.send_note_email("jane@example.com", "Hi Gaurav, let's talk soon.",
                                              session_id="live-1234"))
    finally:
        note_send.set_history_provider(None)
    assert seen == ["live-1234"]
    assert note_send.brief_note.await_args.args[1] == [("visitor", "How does MCP work?")]
