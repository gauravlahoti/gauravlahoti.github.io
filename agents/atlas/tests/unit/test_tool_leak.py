"""Unit tests for app/app_utils/tool_leak.py: a tool call typed out as the reply.

The two leaks below were captured from a real Atlas turn (spec 98 testing).
Run with: uv run pytest tests/unit/test_tool_leak.py -v
"""

import pytest

from app.app_utils.tool_leak import ToolLeakGuard

# Captured verbatim: the reply opened with the ADK function namespace...
LEAK_NAMESPACE = (
    "out:default_api:get_ai_labs[{description:A visual explainer comparing Model "
    "Context Protocol (MCP) to open web APIs,id:web-mcp,status:live,"
    "url:https://gauravlahoti.dev/ai-labs/web-mcp/}]"
)
# ...and, another run, with a stray id followed by a JSON block of made-up labs.
LEAK_JSON = (
    '...4000302832599763595\n```json\n[\n  {\n    "description": "An interactive '
    'explainer on why agents need a standard protocol",\n    "id": "mcp-lab"'
)


def feed(text: str, size: int = 7) -> tuple[str, bool]:
    """Push `text` in small streaming-sized pieces, then flush. Returns what
    reached the visitor and whether a leak was flagged."""
    guard = ToolLeakGuard()
    shown = ""
    for i in range(0, len(text), size):
        out, leaked = guard.push(text[i:i + size])
        shown += out
        if leaked:
            return shown, True
    tail, leaked = guard.flush()
    return shown + tail, leaked


@pytest.mark.parametrize("leak", [LEAK_NAMESPACE, LEAK_JSON])
@pytest.mark.parametrize("size", [1, 3, 7, 40, 500])
def test_captured_leaks_are_caught_and_none_of_it_is_shown(leak, size):
    shown, leaked = feed(leak, size)
    assert leaked
    assert shown == ""


@pytest.mark.parametrize("opening", [
    "default_api.get_ai_labs()",
    "print(default_api.get_profile())",
    "tool_code\nprint(get_certifications())",
    "```python\nget_projects()\n```",
    '[{"id": "mcp-lab"}]',
    '{"id": "mcp-lab", "url": "https://x"}',
    "get_ai_labs()",
])
def test_other_ways_a_tool_call_gets_printed(opening):
    assert feed(opening)[1] is True


@pytest.mark.parametrize("reply", [
    "Gaurav has deployed five production AI agents: Atlas, Pulse and ErrorLens.",
    "Gaurav's Engineering Loops lab covers four nested ways to steer AI.",
    "Yes, he does.",                       # shorter than the decision point
    "No.",
    "Two things worth knowing about Pulse: it runs on a schedule.",
    "The harness lab shows how the loop calls tools and checks the result.",
    "[1] is the Credly badge page",        # starts with a bracket, not a JSON record
    "He built it on Google ADK, with a get_profile style retrieval layer.",  # a tool name mid-sentence
    "Out of scope for me, but he wrote about it on LinkedIn.",  # starts with "Out"
])
@pytest.mark.parametrize("size", [1, 5, 50])
def test_normal_replies_come_through_untouched(reply, size):
    shown, leaked = feed(reply, size)
    assert not leaked
    assert shown == reply


def test_a_clean_reply_is_released_as_soon_as_it_is_judged():
    """The first words must not wait for the whole reply."""
    guard = ToolLeakGuard()
    out, leaked = guard.push("Gaurav has deployed five production AI agents")
    assert not leaked and out.startswith("Gaurav has deployed")
    # ...and everything after goes straight through.
    assert guard.push(" and more.") == (" and more.", False)


def test_a_short_leak_is_flagged_on_the_push_that_completes_it():
    guard = ToolLeakGuard()
    assert guard.push("get_ai_") == ("", False)   # not yet recognisable, held
    assert guard.push("labs()") == ("", True)     # now it is
    clean = ToolLeakGuard()
    assert clean.push("Yes, he does.") == ("", False)  # under the decision point, held
    assert clean.flush() == ("Yes, he does.", False)   # then released at the end


def test_once_flagged_the_guard_stays_shut():
    guard = ToolLeakGuard()
    guard.push(LEAK_NAMESPACE)
    assert guard.push("Here is a real answer.") == ("", True)
    assert guard.flush() == ("", True)
