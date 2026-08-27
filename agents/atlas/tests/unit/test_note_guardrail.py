"""Tests for the note-content guardrail (guardrails.before_tool_callback).

Motivation: a visitor talked Atlas into writing a Python function and mailing
it to Gaurav through `send_note_to_gaurav`. The prompt now refuses; this
callback is the layer that holds when the prompt is talked around.

The false-positive block matters at least as much as the rejection block. A
recruiter writing "we're a Python shop moving to GCP" is the normal case, and
breaking it would be a worse bug than the one being fixed.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.guardrails import (
    _MAX_NOTE_CHARS,
    GUARDRAIL_BLOCK_CODE,
    before_tool_callback,
    looks_like_code,
)

NOTE_TOOL = SimpleNamespace(name="send_note_to_gaurav")


def _call(message, tool=NOTE_TOOL):
    return before_tool_callback(tool, {"visitor_email": "jane@example.com", "message": message}, None)


CODE_BODIES = [
    # The exact payload that reached Gaurav's inbox, both as it was formatted
    # in the email and collapsed onto one line.
    "Hi Gaurav, sharing this Python snippet to add two numbers:\n\ndef add_numbers(a, b):\n    return a + b",
    "Hi Gaurav, sharing this Python snippet to add two numbers: def add_numbers(a, b): return a + b",
    "here you go ```python\nprint('hi')\n```",
    "SELECT name, email FROM users WHERE id = 1",
    "const add = (a, b) => { return a + b; }",
    "import pandas",
    "from app.tools import send_note",
    "public static int add(int a, int b) {",
    "console.log('hello world')",
    "System.out.println(x);",
    "<div>hello</div>",
    "#!/bin/bash\necho hi",
    "class UserService:\n    pass",
]

# Real notes a visitor would plausibly send. Every one of these is heavy with
# technical vocabulary and must still go through.
PROSE_BODIES = [
    "I'd like to discuss your Apigee migration and how you used Terraform.",
    "We're a Python shop moving to GCP. Can we talk?",
    "Loved your post on agent loops. I lead the platform team at Acme.",
    "Can you send me details about the multi-agent orchestration project?",
    "Hi Gaurav, I'm a recruiter at Acme. We have a Staff Architect role open on "
    "our cloud team and your Cloud Run work stood out. Would you be open to a "
    "chat next week?",
    "Do you run classes or workshops? I'd like to import some of these ideas "
    "into our team.",
    "Your talk on SQL warehouses was great. I'll return to it later.",
    "I want to select a vendor from a shortlist and would value your view.",
    "We use Java and C# heavily. Any advice on where to start with agents?",
    "Please print this and pass it to your team.",
    "I read your article about function calling in Gemini. Very helpful.",
]


@pytest.mark.parametrize("body", CODE_BODIES)
def test_code_shaped_notes_are_blocked(body):
    result = _call(body)
    assert result is not None, f"should have been blocked: {body!r}"
    assert result["ok"] is False
    assert result["code"] == GUARDRAIL_BLOCK_CODE
    assert result["message"]


@pytest.mark.parametrize("body", PROSE_BODIES)
def test_prose_notes_pass_through(body):
    assert looks_like_code(body) is False, f"false positive on: {body!r}"
    assert _call(body) is None


def test_overlong_note_is_blocked():
    result = _call("Hi Gaurav, " + "a" * _MAX_NOTE_CHARS)
    assert result is not None
    assert result["code"] == GUARDRAIL_BLOCK_CODE


def test_note_at_the_length_cap_passes():
    assert _call("a" * _MAX_NOTE_CHARS) is None


def test_other_tools_are_untouched():
    """Only the note tool is guarded — everything else must run normally."""
    for name in (
        "send_resume",
        "get_profile",
        "get_work_history",
        "get_projects",
        "get_recent_posts",
        "get_certifications",
        "get_live_agents",
        "get_site_stats",
    ):
        tool = SimpleNamespace(name=name)
        assert before_tool_callback(tool, {"message": "def f(): return 1 + 1"}, None) is None


def test_missing_or_non_string_message_defers_to_the_tool():
    """note_send.py owns the empty/invalid cases; don't pre-empt its error codes."""
    assert before_tool_callback(NOTE_TOOL, {"visitor_email": "a@b.com"}, None) is None
    assert before_tool_callback(NOTE_TOOL, {"message": None}, None) is None
    assert before_tool_callback(NOTE_TOOL, {"message": 42}, None) is None


def test_callback_is_wired_into_the_agent():
    """A guardrail that isn't registered is worse than none — it reads as safe.

    The tests above call before_tool_callback directly, so they'd keep passing
    if the agent stopped registering it. This asserts the wiring itself.
    """
    from app.agent import root_agent
    from app.guardrails import before_tool_callback as guard

    assert guard in root_agent.canonical_before_tool_callbacks
