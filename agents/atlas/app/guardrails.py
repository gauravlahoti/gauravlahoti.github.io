"""Input/output guardrails wired into the agent as ADK callbacks.

Defense in depth, layered:

- `before_model_callback`:
    - Length cap (1000 chars on the latest user message).
    - Prompt-injection regex short-circuit.
    - Stash `contact_intent` flag in session state for `after_model_callback`.

- `after_model_callback`:
    - Strip non-allowlisted URLs from the model output.
    - Redact Gaurav's email unless the latest user message had contact-intent.

- `before_tool_callback`:
    - Content check on `send_note_to_gaurav`'s `message` argument. Atlas is
      not a general-purpose assistant: it talks about Gaurav's work, it does
      not do work for visitors. A visitor once talked it into writing a Python
      function and mailing it to Gaurav, which is what this exists to stop.
      The prompt (`instruction.py`) refuses the request; this callback is the
      layer that holds when the prompt is talked around. Returning a dict here
      skips the tool entirely, so a blocked note never reaches Resend and never
      burns a row in the rate-limit ledger.

These are cheap, deterministic filters. We deliberately do NOT use LLM-as-judge
for the input filter — at portfolio traffic levels and the simplicity of our
threats (off-topic, jailbreak attempts), regex is the honest choice.
"""

from __future__ import annotations

import re
from typing import Any

from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext
from google.genai import types

# Email lives in profile.json under links.email; we hardcode the redaction
# pattern here rather than importing the corpus loader to keep this module
# zero-dep on tools.py.
_EMAIL_RE = re.compile(r"\bgaurav\.lahoti25@gmail\.com\b", re.IGNORECASE)

_INJECTION_RE = re.compile(
    r"ignore (?:previous|all|prior) instructions"
    r"|disregard (?:previous|all) (?:instructions|context)"
    r"|system\s*:\s*you are"
    r"|<\|im_start\|>"
    r"|reveal (?:your|the) system prompt"
    r"|print (?:your|the) system prompt",
    re.IGNORECASE,
)

_CONTACT_INTENT_RE = re.compile(
    r"\b(?:contact|reach|email|e-mail|mail|get in touch|hire|engage|engagement|"
    r"book|schedule|consult)\b",
    re.IGNORECASE,
)

# Stop the match at JSON/quote punctuation too. Without "',}` excluded, a bare
# apex URL inside the [[META]] JSON (e.g. "url":"https://gauravlahoti.dev",...)
# would greedily swallow the trailing `","label":"…` — there is no path `/` to
# terminate host extraction — and the mangled host fails the allowlist, turning
# a valid citation into "(link removed)". URLs with a path survive by luck; the
# bare apex projects citation does not. Excluding these chars fixes it for all.
_URL_RE = re.compile(r"https?://[^\s<>()\[\]\"',}]+", re.IGNORECASE)
_ALLOWED_HOSTS = (
    "linkedin.com",
    "github.com",
    "gauravlahoti.dev",
    "gauravlahoti.github.io",  # legacy host, kept during cutover
    "topmate.io",
    "credly.com",          # certification badge verification
    "cp.certmetrics.com",  # AWS cert verify links
    "learn.microsoft.com", # Microsoft/Azure cert verify
)

# Defense against the model hallucinating a direct PDF or download path on
# the portfolio domain (observed: it invented `gauravlahoti.dev/resume.pdf`
# which doesn't exist). Only the bare root URL is legitimate; any path that
# looks like a download or a deep link is treated as a hallucination and
# replaced with a navigation hint.
_HALLUCINATED_PORTFOLIO_PATH_RE = re.compile(
    r"https?://(?:www\.)?gauravlahoti\.(?:dev|github\.io)/[^\s<>()\[\]]*"
    r"(?:\.pdf|/resume|/download|/file)[^\s<>()\[\]]*",
    re.IGNORECASE,
)
_RESUME_HINT = "(click the Resume button on this page)"

_MAX_USER_CHARS = 1000

# Public prefixes imported by api.py for audit-log status detection.
# Must match the opening of the corresponding full reply strings below.
INJECTION_REPLY_PREFIX = "I'm an agent representing Gaurav and I only answer"
TOO_LONG_REPLY_PREFIX  = "Your message is a bit long for me to handle"

# Both canned replies short-circuit before the LLM runs (see _short_circuit
# below), so they never go through the model's own [[META]] sentinel
# generation. instruction.py's contract is "every reply, including
# declines, must end with a [[META]] block" — append an empty one by hand
# so these two match every other reply path.
_EMPTY_META = '[[META]]\n{"citations":[],"suggestions":[],"cta":null}\n[[/META]]'

INJECTION_REPLY = (
    "I'm an agent representing Gaurav and I only answer questions about his "
    "work, perspectives, and projects. If you'd like to chat directly, the "
    "best place is LinkedIn: https://www.linkedin.com/in/glahoti/.\n\n"
    f"{_EMPTY_META}"
)
TOO_LONG_REPLY = (
    "Your message is a bit long for me to handle reliably. Could you keep it "
    "under ~1000 characters? Or reach Gaurav on LinkedIn for anything "
    "involved: https://www.linkedin.com/in/glahoti/.\n\n"
    f"{_EMPTY_META}"
)
_EMAIL_REDACT_REPLACEMENT = (
    "(reach Gaurav via LinkedIn https://www.linkedin.com/in/glahoti/ or "
    "Topmate https://topmate.io/gaurav_lahoti25)"
)


def _latest_user_text(llm_request: LlmRequest) -> str:
    """Pull the latest user-role message text out of the LLM request."""
    contents = getattr(llm_request, "contents", None) or []
    for content in reversed(contents):
        if getattr(content, "role", None) != "user":
            continue
        parts = getattr(content, "parts", None) or []
        text = "".join(getattr(p, "text", "") or "" for p in parts)
        if text:
            return text
    return ""


def _short_circuit(text: str) -> LlmResponse:
    return LlmResponse(
        content=types.Content(
            role="model",
            parts=[types.Part.from_text(text=text)],
        ),
    )


def before_model_callback(
    callback_context: CallbackContext,
    llm_request: LlmRequest,
) -> LlmResponse | None:
    """Run before each model call. Return an LlmResponse to short-circuit."""
    user_text = _latest_user_text(llm_request)
    # Strip meta-block sentinels so a hostile visitor can't smuggle a forged
    # [[META]] payload through the user message. Server-side rfind is the
    # primary defense; this removes the attack surface on the input side.
    user_text = user_text.replace("[[META]]", "").replace("[[/META]]", "")
    state = callback_context.state

    # Stash contact-intent flag for the output filter.
    state["contact_intent"] = bool(_CONTACT_INTENT_RE.search(user_text))

    if len(user_text) > _MAX_USER_CHARS:
        return _short_circuit(TOO_LONG_REPLY)

    if _INJECTION_RE.search(user_text):
        return _short_circuit(INJECTION_REPLY)

    return None


def _strip_disallowed_urls(text: str) -> str:
    # First: catch hallucinated portfolio paths (resume.pdf etc.) before the
    # general filter would let them through (the host IS allowed, but the
    # path is fictional).
    text = _HALLUCINATED_PORTFOLIO_PATH_RE.sub(_RESUME_HINT, text)

    def _replace(match: re.Match[str]) -> str:
        url = match.group(0)
        host = url.split("//", 1)[-1].split("/", 1)[0].lower()
        if any(host == h or host.endswith("." + h) for h in _ALLOWED_HOSTS):
            return url
        # In streaming mode, after_model_callback runs on each incremental
        # chunk. A URL at the very end of the chunk may be partial (the domain
        # continues in the next chunk), so don't strip it — the full URL will
        # be re-evaluated when the next chunk arrives. This prevents allowed
        # subdomains (e.g. agentic-rag.gauravlahoti.dev) from being stripped
        # as "(link removed)" when the streaming boundary falls mid-URL.
        if match.end() == len(text):
            return url
        return "(link removed)"

    return _URL_RE.sub(_replace, text)


def after_model_callback(
    callback_context: CallbackContext,
    llm_response: LlmResponse,
) -> LlmResponse | None:
    """Run after each model call. Return a modified LlmResponse to replace."""
    content = getattr(llm_response, "content", None)
    if content is None:
        return None
    parts = getattr(content, "parts", None) or []
    if not parts:
        return None

    contact_intent = bool(callback_context.state.get("contact_intent"))
    changed = False
    new_parts = []
    for part in parts:
        text = getattr(part, "text", None)
        if text is None:
            new_parts.append(part)
            continue
        new_text = _strip_disallowed_urls(text)
        if not contact_intent:
            new_text = _EMAIL_RE.sub(_EMAIL_REDACT_REPLACEMENT, new_text)
        if new_text != text:
            changed = True
            # Preserve `thought` on rebuild — types.Part.from_text() would
            # silently drop it, reclassifying a filtered thought chunk as an
            # answer part downstream (api.py's answer/thought bifurcation,
            # and the audit log's `response` field).
            new_parts.append(types.Part(text=new_text, thought=getattr(part, "thought", None)))
        else:
            new_parts.append(part)

    if not changed:
        return None

    return LlmResponse(
        content=types.Content(role=content.role, parts=new_parts),
    )


# --- Tool-argument guardrail: note content -------------------------------
#
# Atlas describes Gaurav's work; it does not do work for visitors. That line
# used to live only in the system prompt, and a visitor walked straight over
# it: they asked Atlas to write a Python function and mail it to Gaurav, and
# the tool relayed it happily because `note_send.py` only ever checked the
# email format and a 10-char minimum.
#
# These patterns are deliberately structural, not lexical. A note that merely
# *mentions* Python, Terraform or SQL is a completely normal thing for a
# recruiter or an engineer to write and must go through untouched — only code
# SHAPE (a def, a fence, a SELECT…FROM, an arrow function) trips the filter.
_NOTE_TOOL_NAME = "send_note_to_gaurav"
_MAX_NOTE_CHARS = 2000

_CODE_SHAPE_PATTERNS = (
    re.compile(r"```"),                                             # fenced block
    re.compile(r"\bdef\s+[A-Za-z_]\w*\s*\("),                       # python def
    re.compile(r"^[ \t]*class[ \t]+[A-Za-z_]\w*[ \t]*[:(]", re.M),  # python/java class
    re.compile(r"^[ \t]*import[ \t]+[\w.]+[ \t]*;?[ \t]*$", re.M),  # bare import line
    re.compile(r"^[ \t]*from[ \t]+[\w.]+[ \t]+import\b", re.M),     # from x import y
    re.compile(r"\bfunction\s+[A-Za-z_]\w*\s*\("),                  # js function decl
    re.compile(r"=>\s*[{(]"),                                       # js arrow body
    re.compile(r"^[ \t]*(?:const|let|var)[ \t]+\w+[ \t]*=", re.M),  # js declaration
    re.compile(r"\breturn\s+[\w.]+\s*[-+*/%]\s*[\w.]+"),            # `return a + b`
    re.compile(r"^[ \t]{2,}return\b", re.M),                        # indented return
    re.compile(r"\bSELECT\b[\s\S]{0,200}\bFROM\b"),                 # SQL (case-sensitive)
    re.compile(r"console\.log\s*\("),
    re.compile(r"System\.out\.print"),
    re.compile(r"\bprintf?\("),
    re.compile(                                                     # java/c# method
        r"^[ \t]*(?:public|private|protected)[ \t]+(?:static[ \t]+)?"
        r"[\w<>\[\]]+[ \t]+\w+[ \t]*\(",
        re.M,
    ),
    re.compile(r"</[A-Za-z][\w-]*>"),                               # closing markup tag
    re.compile(r"^#!/", re.M),                                      # shebang
)

NOTE_CODE_REPLY = (
    "I can only pass along a note written in your own words, so I've held that "
    "one back. Writing code or drafting content isn't something I do. Tell me "
    "what you'd like to say to Gaurav and I'll send that across."
)
NOTE_TOO_LONG_REPLY = (
    "That note is longer than I can pass along. Could you trim it under "
    f"{_MAX_NOTE_CHARS} characters and I'll send it on?"
)

# Codes this module can hand back in place of a real tool result. api.py reads
# this to tell a deliberate guardrail block apart from a genuine send failure.
GUARDRAIL_BLOCK_CODE = "unsupported_content"


def looks_like_code(text: str) -> bool:
    """True if `text` carries the *structure* of code, not just its vocabulary."""
    return any(p.search(text) for p in _CODE_SHAPE_PATTERNS)


def before_tool_callback(
    tool: BaseTool,
    args: dict[str, Any],
    tool_context: ToolContext,
) -> dict | None:
    """Run before each tool call. Return a dict to skip the tool and use it as the result.

    Only `send_note_to_gaurav` is guarded — it's the one tool whose payload is
    free text that leaves the system. Returning here means Resend is never
    called and no row lands in the note rate-limit ledger.
    """
    if getattr(tool, "name", None) != _NOTE_TOOL_NAME:
        return None

    message = args.get("message")
    if not isinstance(message, str):
        return None  # let the tool's own validation produce the error

    if len(message) > _MAX_NOTE_CHARS:
        return {"ok": False, "code": GUARDRAIL_BLOCK_CODE, "message": NOTE_TOO_LONG_REPLY}

    if looks_like_code(message):
        return {"ok": False, "code": GUARDRAIL_BLOCK_CODE, "message": NOTE_CODE_REPLY}

    return None
