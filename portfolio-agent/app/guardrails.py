"""Input/output guardrails wired into the agent as ADK callbacks.

Defense in depth, layered:

- `before_model_callback`:
    - Length cap (1000 chars on the latest user message).
    - Prompt-injection regex short-circuit.
    - Stash `contact_intent` flag in session state for `after_model_callback`.

- `after_model_callback`:
    - Strip non-allowlisted URLs from the model output.
    - Redact Gaurav's email unless the latest user message had contact-intent.

These are cheap, deterministic filters. We deliberately do NOT use LLM-as-judge
for the input filter — at portfolio traffic levels and the simplicity of our
threats (off-topic, jailbreak attempts), regex is the honest choice.
"""

from __future__ import annotations

import re

from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
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

_URL_RE = re.compile(r"https?://[^\s<>()\[\]]+", re.IGNORECASE)
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

INJECTION_REPLY = (
    "I'm an agent representing Gaurav and I only answer questions about his "
    "work, perspectives, and projects. If you'd like to chat directly, the "
    "best place is LinkedIn: https://www.linkedin.com/in/glahoti/."
)
TOO_LONG_REPLY = (
    "Your message is a bit long for me to handle reliably. Could you keep it "
    "under ~1000 characters? Or reach Gaurav on LinkedIn for anything "
    "involved: https://www.linkedin.com/in/glahoti/."
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
        # Drop the URL but keep the surrounding sentence intact.
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
            new_parts.append(types.Part.from_text(text=new_text))
        else:
            new_parts.append(part)

    if not changed:
        return None

    return LlmResponse(
        content=types.Content(role=content.role, parts=new_parts),
    )
