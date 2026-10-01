"""Custom HTTP routes for the portfolio chat widget.

The static site (`assets/js/agent-widget.js`) talks to these routes — not
ADK's native `/run_sse` — so the frontend stays decoupled from ADK's internal
event format. Five routes:

- `POST /api/agent-chat` — SSE stream emitting `{"delta": str}` per chunk and
  `{"done": true}` to close. Request shape mirrors spec #20:
      {"sessionId": "uuid-v4", "messages": [{"role": "user|assistant", "content": str}, ...]}
- `POST /api/agent-transcribe` — speech-to-text for the mic button (spec #48).
  Ears only: turns a recorded clip into text for the composer, never sends a
  turn itself.
      {"sessionId": "uuid-v4", "mimeType": "audio/webm", "audio": "<base64>"}
  → 200 {"text": str} | 400 bad input | 429 voice budget exhausted |
    502 transcription unavailable. See `app/app_utils/transcribe.py`.
- `POST /api/agent-speak` — text-to-speech for the spoken-replies toggle
  (spec #49). Synthesizes one sentence chunk of an answer; the frontend
  calls it repeatedly as a reply streams.
      {"sessionId": "uuid-v4", "text": "<one or two sentences>"}
  → 200 {"audio": "<base64 wav>", "mime": "audio/wav", "model": str} |
    400 bad input | 429 speak budget exhausted | 502 synthesis unavailable.
  See `app/app_utils/speak.py`.
- `GET  /api/agent-chat/warm` — 200 OK, no work. Frontend fires this on
  FAB-open to spin up Cloud Run before the user types.
- `GET  /healthz` — Cloud Run liveness probe.

Rate limiting is enforced before the ADK runner (or the transcribe call) is
invoked. Each route has its own independent budget bucket — see
`rate_limit.py` for details. The chat bucket is layered: 10 messages per
sessionId per 24h AND 10 messages per IP-hash per 24h. The IP cap is the
ceiling — reloading to get a fresh sessionId does not bypass it.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import time
from collections.abc import AsyncIterator
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.events import Event
from google.adk.runners import InMemoryRunner
from google.genai import types
from google.genai.errors import APIError

from app import live_brain
from app.agent import root_agent
from app.app_utils import avatar_speak
from app.app_utils.audit_log import log_interaction
from app.app_utils.citations import CitationGuard, split_markers
from app.app_utils.dashes import DashGuard, strip_dashes
from app.app_utils.emails import EmailGuard, emails_in, fix_emails
from app.app_utils.geo_lookup import lookup_geo
from app.app_utils.lead_note import NoteFilter
from app.app_utils.resume_send import warm_mcp_server
from app.app_utils.speak import MAX_TEXT_CHARS, sanitize_for_speech, speak_text
from app.app_utils.speak import warm as warm_speak
from app.app_utils.transcribe import normalize_mime, transcribe_audio
from app.app_utils.transcribe import warm as warm_transcribe
from app.guardrails import (
    _INJECTION_RE,
    GUARDRAIL_BLOCK_CODE,
    INJECTION_REPLY_PREFIX,
    REPLY_MODES,
    TOO_LONG_REPLY_PREFIX,
    has_contact_intent,
)
from app.rate_limit import limiter

_AGENT_VERSION = os.environ.get("COMMIT_SHA", "dev")

logger = logging.getLogger(__name__)

# Quota exhaustion (429), a model outage (503), and a rejected project or
# credential (403) all mean the model is unreachable for everyone, not that
# this one request was malformed. Asking again won't help, so these get a
# maintenance notice instead of the generic "try that again" copy.
_MODEL_UNAVAILABLE_CODES = frozenset({403, 429, 503})

_MAINTENANCE_REPLY = (
    "I'm down for maintenance right now, so I can't answer that one. "
    "Please check back in a bit. Gaurav's on LinkedIn if it's urgent."
)
_GENERIC_ERROR_REPLY = (
    "Hmm, something went wrong on my end. Mind trying that again? "
    "Gaurav's on LinkedIn for anything urgent."
)


def _failure_reply(exc: BaseException) -> str:
    """Maintenance notice when the model is unreachable, generic retry copy otherwise."""
    if isinstance(exc, APIError) and getattr(exc, "code", None) in _MODEL_UNAVAILABLE_CODES:
        return _MAINTENANCE_REPLY
    return _GENERIC_ERROR_REPLY


def _model_candidates() -> list[str]:
    """[primary, *fallbacks] from root_agent's model config, for depth lookup.

    Defensive about shape: if the agent is ever reconfigured to a bare model
    string instead of FallbackGemini, this just yields an empty list and
    model_fallback_depth stays None rather than crashing at import time.
    """
    m = getattr(root_agent, "model", None)
    primary = getattr(m, "model", None)
    fallbacks = getattr(m, "fallback_models", None) or []
    return [c for c in [primary, *fallbacks] if c]


_MODEL_CANDIDATES = _model_candidates()

APP_NAME = "app"  # matches App(name="app") in agent.py

# One Runner per process. Holds the in-memory session service so multi-turn
# conversations on the same `sessionId` retain history within an instance.
_runner = InMemoryRunner(agent=root_agent, app_name=APP_NAME)


async def _ensure_session(session_id: str) -> str:
    """Get-or-create an ADK session keyed on the client's sessionId.

    We use sessionId as both `user_id` and `session_id` — visitors are
    anonymous, sessions are page-load-scoped (per spec #20), and we don't
    want a separate user identity surface.
    """
    svc = _runner.session_service
    existing = await svc.get_session(
        app_name=APP_NAME, user_id=session_id, session_id=session_id
    )
    if existing is not None:
        return session_id
    await svc.create_session(
        app_name=APP_NAME, user_id=session_id, session_id=session_id
    )
    return session_id


def _client_ip(request: Request) -> str:
    # Cloud Run's front end (GFE) appends the true client IP as the last
    # hop in X-Forwarded-For rather than replacing client-supplied values;
    # anything before that last entry is attacker-controlled and must not
    # be trusted for rate-limiting.
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else "0.0.0.0"


def _truncate_ip(ip: str) -> str:
    """Truncate an IP to /24 (IPv4) or first 4 hextets (IPv6). Mirrors backend/src/index.js."""
    if not ip:
        return ""
    if ":" in ip:
        hextets = [h for h in ip.split(":") if h][:4]
        return ":".join(hextets) + "::x"
    parts = ip.split(".")
    if len(parts) == 4:
        return f"{parts[0]}.{parts[1]}.{parts[2]}.x"
    return ""


def _sse(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


# Sentinel constants for the Spec #24 meta-block protocol.
_META_OPEN  = "[[META]]"
_META_CLOSE = "[[/META]]"
_ALLOWED_CTA = {"topmate", "linkedin", "resume"}
# Certification badge slugs (spec 56). The model may only name a slug it saw in
# a get_certifications() result; this regex is a format check, not an authority
# check. Authorization is structural: the widget resolves each slug against its
# own copy of profile.json and silently drops anything that doesn't match, so a
# slug invented here can never become an image path or a link.
_SLUG_RE = re.compile(r"^[a-z0-9-]{1,64}$")
# Up to five sources (spec 67): a list answer (four AI Labs, say) cites one
# per item, and a cap of three left "[4]" in the text with nothing behind it.
_MAX_CITATIONS = 5
_MAX_BADGES = 16  # profile.json currently holds 14; leaves headroom without being unbounded

_ALLOWED_CITE_HOSTS = {
    "linkedin.com", "www.linkedin.com",
    "github.com", "topmate.io",
    "gauravlahoti.dev", "www.gauravlahoti.dev",
    "gauravlahoti.github.io",                  # legacy host, kept during cutover
    "credly.com", "www.credly.com",            # certification badge verification
    "cp.certmetrics.com",                      # AWS cert verify links
    "learn.microsoft.com",                     # Microsoft/Azure cert verify
}

# Off-scope suggestion filter. Atlas declines generic technology-definition
# questions ("What is AlloyDB?") — its scope is Gaurav's use of tech, not the
# tech itself — so it must never *suggest* one either. The instruction already
# forbids this, but a weaker fallback model can slip; enforce it server-side.
# Drop a suggestion that opens with a definitional stem AND never references
# Gaurav (he/his/him/Gaurav) — that combination is the generic-definition shape.
_DEFINITION_STEM_RE = re.compile(
    r"^\s*(?:what(?:'s|s| is| are)|explain|define|describe|tell me about)\b",
    re.IGNORECASE,
)
_GAURAV_REF_RE = re.compile(r"\b(?:gaurav|he|his|him|he's)\b", re.IGNORECASE)


def _is_offscope_suggestion(s: str) -> bool:
    return bool(_DEFINITION_STEM_RE.match(s)) and not _GAURAV_REF_RE.search(s)


def _parse_meta(raw: str) -> tuple[list[dict], list[str], str | None, list[str]]:
    """Parse a raw meta-block JSON string into (citations, suggestions, cta, badges).

    Returns empty collections on any failure — never raises.
    Uses rfind so the LAST [[META]] in the full response wins (defends
    against a forged earlier sentinel echoed by the model).
    """
    try:
        obj = json.loads(raw)
        # citations: validate each entry
        raw_cites = obj.get("citations") or []
        citations: list[dict] = []
        for c in raw_cites[:_MAX_CITATIONS]:
            if not isinstance(c, dict):
                continue
            cid = c.get("id")
            url = c.get("url", "")
            label = c.get("label", "")
            if not isinstance(cid, int):
                continue
            host = (url.split("//", 1)[-1].split("/", 1)[0]).lower() if "//" in url else ""
            if not any(host == h or host.endswith("." + h) for h in _ALLOWED_CITE_HOSTS):
                continue  # server is canonical — drop off-allowlist entries
            citations.append({"id": cid, "url": url[:500], "label": strip_dashes(str(label))[:80]})
        # suggestions: 2–3 non-empty strings ≤ 80 chars; drop off-scope
        # (generic tech-definition) suggestions Atlas would only decline.
        raw_sugg = obj.get("suggestions") or []
        suggestions = [
            strip_dashes(str(s))[:80]
            for s in raw_sugg
            if isinstance(s, str) and s.strip() and not _is_offscope_suggestion(s)
        ][:3]
        # cta: null or one of the allowed values
        raw_cta = obj.get("cta")
        cta = raw_cta if isinstance(raw_cta, str) and raw_cta in _ALLOWED_CTA else None
        # badges: certification slugs to render as badge art. De-duplicated with
        # order preserved — the model emits them in the order it discussed them,
        # and the widget's own issuer grouping is what actually sets layout.
        raw_badges = obj.get("badges") or []
        badges: list[str] = []
        for b in raw_badges:
            if not isinstance(b, str):
                continue
            slug = b.strip().lower()
            if not _SLUG_RE.match(slug) or slug in badges:
                continue
            badges.append(slug)
            if len(badges) >= _MAX_BADGES:
                break
        return citations, suggestions, cta, badges
    except Exception:
        logger.warning("meta-block parse failed on: %r", raw[:200])
        return [], [], None, []


async def _log_turn(geo_task: asyncio.Task | None, payload: dict[str, Any]) -> None:
    """Resolve the pending geo lookup, then write the audit row.

    Split out so `lookup_geo` stays off the request's critical path. It is
    telemetry — country/region/city never feed the model — so it belongs
    after the SSE stream has closed, not before it opens.

    Never raises: this runs detached, and `log_interaction` already swallows
    its own errors. A failed geo lookup logs the row without geo rather than
    losing the row.
    """
    if geo_task is not None:
        try:
            geo = await geo_task
        except Exception:
            geo = None
        payload["country"] = (geo or {}).get("country")
        payload["region"] = (geo or {}).get("region")
        payload["city"] = (geo or {}).get("city")
    await log_interaction(payload)


def _reply_mode(body: Any, want_avatar: bool) -> str:
    """The widget's mode for this turn: text, voice or avatar (spec 67)."""
    if want_avatar:
        return "avatar"
    mode = (body or {}).get("mode") if isinstance(body, dict) else None
    return mode if mode in REPLY_MODES else "text"


# Spec 72: the avatar's two caps. Both hand the visitor to Voice mode, which
# draws on the separate chat budget, so the copy says where they're going.
AVATAR_VISITOR_CAP_REPLY = "That's all the avatar time for today."
AVATAR_SITE_CAP_REPLY = "The avatar is resting for the rest of today."


async def _capped_avatar_stream(reason: str, kind: str = "avatar") -> AsyncIterator[str]:
    """The whole reply to an avatar turn over its cap: `capped` tells the
    widget to offer Voice mode for this same question."""
    yield _sse({"avatarUnavailable": {"reason": reason, "capped": True, "kind": kind}})
    yield _sse({"done": True})


# Sent (server-side, never shown) when a turn ends with no answer text.
_EMPTY_REPLY_NUDGE = (
    "(Your previous reply reached the visitor empty. Answer their last question "
    "now, following all your rules, starting with your [[NOTE]] block.)"
)


_AVATAR_SCRIPT_KEY = "_avatarScript"
_AVATAR_TIMEOUT_S = 150.0


async def _with_avatar(text_stream: AsyncIterator[str]) -> AsyncIterator[str]:
    """Spec 67: one chat turn, spoken by the avatar, on one SSE stream.

    Opens the Live avatar session the moment the turn starts, in parallel
    with the agent thinking, and relays its idle video straight away. When
    the reply's script arrives it goes into the already-open session, and
    the avatar's video (`avatarVideo`, base64 fMP4) and spoken words
    (`avatarWords`) follow on this same stream. The text stream's final
    `done` is held until the avatar has finished, so the widget's turn ends
    when the talking does. Any avatar failure becomes `avatarUnavailable`,
    and the widget reads the reply aloud with the TTS voice instead.
    """
    out: asyncio.Queue[str | None] = asyncio.Queue()
    live = avatar_speak.LiveAvatar()
    script: asyncio.Future[str | None] = asyncio.get_running_loop().create_future()
    held_done: list[str] = []
    reserved = avatar_speak.RESERVE_SECONDS

    async def pump_text() -> None:
        try:
            async for chunk in text_stream:
                if chunk.startswith("data: ") and _AVATAR_SCRIPT_KEY in chunk:
                    payload = json.loads(chunk[6:])
                    if _AVATAR_SCRIPT_KEY in payload:
                        if not script.done():
                            script.set_result(payload[_AVATAR_SCRIPT_KEY])
                        continue
                if chunk.startswith('data: {"done"'):
                    held_done.append(chunk)
                    continue
                await out.put(chunk)
        finally:
            if not script.done():
                script.set_result(None)  # no speakable reply this turn

    async def pump_avatar() -> None:
        try:
            started = time.monotonic()
            await live.open()
            logger.info("avatar session open in %d ms", int((time.monotonic() - started) * 1000))
            aligner: list[avatar_speak.ScriptAligner] = []
            reader = asyncio.ensure_future(_relay_avatar(live, out, aligner))
            text = await script
            if not text:
                reader.cancel()
                return
            aligner.append(avatar_speak.ScriptAligner(text))
            await live.say(text)
            await reader
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("avatar turn failed")
            await out.put(_sse({"avatarUnavailable": {"reason": "Avatar is unavailable right now."}}))

    text_task = asyncio.ensure_future(pump_text())
    avatar_task = asyncio.ensure_future(asyncio.wait_for(pump_avatar(), _AVATAR_TIMEOUT_S))

    async def closer() -> None:
        await asyncio.gather(text_task, avatar_task, return_exceptions=True)
        await out.put(None)

    closing = asyncio.ensure_future(closer())
    try:
        while (item := await out.get()) is not None:
            yield item
        for chunk in held_done:
            yield chunk
    finally:
        for task in (text_task, avatar_task, closing):
            task.cancel()
        await live.close()
        spoken = live.spoken_seconds
        avatar_speak.budget.settle(reserved, spoken)
        logger.info(
            "avatar spoke %.1fs ($%.3f) bytes=%d day_used=%.0fs",
            spoken, spoken * avatar_speak.USD_PER_SPEAKING_SECOND,
            live.bytes, avatar_speak.budget.used_seconds,
        )


def _words_event(text: str, live: avatar_speak.LiveAvatar) -> dict[str, Any]:
    """A caption chunk plus the media time its last word is heard at, so the
    widget can highlight each word as it is said (spec 67 karaoke)."""
    return {"text": text, "at": round(live.clock.edge + avatar_speak.WORDS_LEAD_S, 3)}


async def _relay_avatar(
    live: avatar_speak.LiveAvatar,
    out: asyncio.Queue,
    aligner: list[avatar_speak.ScriptAligner],
) -> None:
    """Forward the avatar's video and spoken words onto the turn's stream.

    Words are aligned to the script the avatar is reading (`aligner` holds
    it once the reply exists), so captions carry the script's own spacing
    and punctuation rather than the raw transcription's.
    """
    async for kind, value in live.events():
        if kind == "video":
            await out.put(_sse({"avatarVideo": base64.b64encode(value).decode("ascii")}))
        else:
            words = aligner[0].feed(value) if aligner else value
            if words:
                await out.put(_sse({"avatarWords": _words_event(words, live)}))
    if aligner and (tail := aligner[0].rest().strip()):
        await out.put(_sse({"avatarWords": _words_event(" " + tail, live)}))
    await out.put(_sse({"avatarEnd": True}))


# --- avatar turns answered by gemini-3.8-live directly -------------------------
# ATLAS_LIVE_BRAIN=1 routes Avatar-mode questions to `live_brain`: one Live
# session answers with Atlas's tools and speaks as it goes, instead of
# gemini-3.6-flash writing a whole reply for the avatar to read. Read per
# request, so it is switched on or off with an env change alone.
_LIVE_HISTORY_TURNS = 12
_META_BLOCK_RE = re.compile(r"\[\[META\]\].*", re.DOTALL)


def _live_brain_on() -> bool:
    return os.environ.get("ATLAS_LIVE_BRAIN", "") == "1"


async def _chat_history(session_id: str) -> list[types.Content]:
    """The chat so far, from any mode, as plain user/model text turns."""
    session = await _runner.session_service.get_session(
        app_name=APP_NAME, user_id=session_id, session_id=session_id
    )
    turns: list[types.Content] = []
    for event in (session.events if session else []):
        content = event.content
        if not content or not content.parts:
            continue
        text = "".join(p.text or "" for p in content.parts if p.text and not p.thought)
        if content.role == "model":
            text = split_markers(_META_BLOCK_RE.sub("", text))
        text = text.strip()
        if text:
            turns.append(types.Content(role="user" if content.role == "user" else "model",
                                       parts=[types.Part.from_text(text=text)]))
    return turns[-_LIVE_HISTORY_TURNS:]


async def _remember_live_turn(session_id: str, question: str, answer: str) -> None:
    """Write the avatar turn into the chat's ADK session, so a follow-up in
    Text or Voice mode knows what was asked and said (one shared chat)."""
    svc = _runner.session_service
    session = await svc.get_session(app_name=APP_NAME, user_id=session_id, session_id=session_id)
    if session is None:
        return
    if question:
        await svc.append_event(session, Event(
            author="user", content=types.Content(role="user", parts=[types.Part.from_text(text=question)])))
    if answer:
        await svc.append_event(session, Event(
            author=root_agent.name, content=types.Content(role="model", parts=[types.Part.from_text(text=answer)])))


async def _live_avatar_stream(
    session_id: str,
    user_text: str,
    *,
    turn_index: int,
    identity: dict[str, str] | None,
    client_meta: dict[str, str],
    geo_task: asyncio.Task | None,
    fallback: AsyncIterator[str],
) -> AsyncIterator[str]:
    """One avatar turn answered by gemini-3.8-live itself, on the same SSE
    events the widget already plays (`avatarVideo`, `avatarWords`,
    `avatarEnd`, `done`). The spoken words also go out as `delta`, so the
    turn reads the same in Text and Voice mode. If the session fails before
    a word is spoken, the turn becomes a normal text answer (`fallback`).
    """
    start = time.monotonic()
    dispatcher = live_brain.ToolDispatcher(session_id)
    # A session the widget warmed while the visitor was typing answers ~1.5s
    # sooner; otherwise open one now.
    turn = live_brain.warm_pool.claim(session_id)
    warm = turn is not None
    if turn is None:
        turn = live_brain.LiveBrainTurn(dispatcher)
    else:
        turn.attach(dispatcher)
    status, error_message = "ok", None
    spoke = False
    try:
        history = await _chat_history(session_id)
        if not warm:
            await turn.open()
        await turn.ask(user_text, history)
        async with asyncio.timeout(_AVATAR_TIMEOUT_S):
            async for kind, value in turn.events():
                if kind == "video":
                    yield _sse({"avatarVideo": base64.b64encode(value).decode("ascii")})
                elif kind == "show":
                    yield _sse({"avatarShow": value})  # spec 78: a target key, never a URL
                else:
                    spoke = True
                    yield _sse({"avatarWords": _words_event(value, turn)})
                    yield _sse({"delta": value})
        yield _sse({"avatarEnd": True})
        yield _sse({"done": True})
    except asyncio.CancelledError:
        status = "cancelled"
        raise
    except GeneratorExit:
        # The visitor talked over the avatar (`{"abort": true}` on the chat
        # socket): agent-chat-ws stops reading and closes this generator.
        # Logged as `ok` until spec 82, which made cut-off answers look like
        # the avatar truncating itself.
        status = "interrupted"
        raise
    except Exception as err:  # noqa: BLE001 - the visitor still gets an answer
        logger.exception("live avatar turn failed")
        status, error_message = "error", type(err).__name__
        if spoke:
            yield _sse({"avatarEnd": True})
            yield _sse({"done": True})
        else:
            # Nothing said yet: drop the face and answer in text instead.
            yield _sse({"avatarUnavailable": {"reason": "Avatar is unavailable right now."}})
            async for chunk in fallback:
                yield chunk
    finally:
        await turn.close()
        spoken = turn.spoken_seconds
        avatar_speak.budget.settle(avatar_speak.RESERVE_SECONDS, spoken)
        answer = turn.text
        logger.info(
            "live-avatar: turn=%d warm=%s first_word_ms=%s tools=%s spoke=%.1fs ($%.3f) status=%s",
            turn_index, warm, turn.first_word_ms, [c["name"] for c in turn.dispatcher.calls],
            spoken, spoken * avatar_speak.USD_PER_SPEAKING_SECOND, status,
        )
        if spoke:
            try:
                await _remember_live_turn(session_id, user_text, answer)
            except Exception:  # history is best effort; the answer already went out
                logger.exception("live avatar: could not record the turn in the session")
        asyncio.create_task(
            _log_turn(geo_task, {
                "sessionId":  session_id,
                "turnIndex":  turn_index,
                "question":   user_text[:4000],
                "response":   answer[:16000],
                "toolCalls":  turn.dispatcher.calls[:20],
                "model":      avatar_speak.AVATAR_MODEL,
                "latencyMs":  turn.first_word_ms or int((time.monotonic() - start) * 1000),
                "status":     status,
                "errorMessage": error_message,
                "identity":   identity,
                "userAgent":  client_meta.get("ua"),
                "referrer":   client_meta.get("ref"),
                "ip":         client_meta.get("ip_truncated"),
                "agentVersion": _AGENT_VERSION,
            })
        )


class _OutputFilter:
    """Everything Atlas shows goes through here (spec 67): no em/en dashes,
    no email address other than Gaurav's contact address or one the visitor
    typed, and one source per citation marker ("[1, 2]" -> "[1][2]").
    Streaming push()/flush(), or whole() for finished text."""

    def __init__(self, visitor_emails: frozenset[str], contact_intent: bool) -> None:
        self._cites = CitationGuard()
        self._dashes = DashGuard()
        self._emails = EmailGuard(set(visitor_emails), contact_intent)
        self._visitor_emails = set(visitor_emails)
        self._contact = contact_intent

    def push(self, chunk: str) -> str:
        return self._emails.push(self._dashes.push(self._cites.push(chunk)))

    def flush(self) -> str:
        tail = self._dashes.push(self._cites.flush()) + self._dashes.flush()
        return self._emails.push(tail) + self._emails.flush()

    def whole(self, text: str) -> str:
        return fix_emails(strip_dashes(split_markers(text)), self._visitor_emails, self._contact)


async def _stream_agent(
    session_id: str,
    user_text: str,
    *,
    turn_index: int,
    identity: dict[str, str] | None,
    client_meta: dict[str, str],
    geo_task: asyncio.Task | None = None,
    avatar: bool = False,
    reply_mode: str = "text",
    visitor_emails: frozenset[str] = frozenset(),
    contact_intent: bool = False,
) -> AsyncIterator[str]:
    """Run the latest user message through the ADK runner and yield SSE chunks.

    Spec #24: detects the [[META]]…[[/META]] sentinel block at the end of
    every model reply, strips it from the user-visible delta stream, parses
    it, and emits structured `citations`, `suggestions`, and `cta` SSE events
    before the final `done`. Falls back gracefully (no structured events) if
    the block is missing or malformed.
    """
    new_message = types.Content(
        role="user", parts=[types.Part.from_text(text=user_text)]
    )

    start = time.monotonic()
    # Time-to-first-token, split two ways. `latencyMs` alone is whole-turn wall
    # clock, which can't tell "the model is slow" apart from "our pre-stream
    # work is slow" — and the widget's stall message is driven purely by how
    # long the FIRST event takes, not by total duration. Record both so a
    # latency regression can be attributed instead of guessed at.
    ttf_thinking_ms: int | None = None
    ttf_delta_ms: int | None = None
    # user_visible: text actually forwarded to the client (excludes meta block)
    user_visible: list[str] = []
    # Spec 67: the working note ([[NOTE]] block, or an untagged one) goes to
    # the Thinking panel, never into the reply.
    lead_guard = NoteFilter()
    step_streamed = False  # this model step has streamed partial answer text
    # Spec 67: no em/en dashes in anything Atlas writes (see dashes.py).
    # Spec 67: and no email address Atlas wasn't given (see emails.py).
    dash_guard = _OutputFilter(visitor_emails, contact_intent)
    thought_guard = _OutputFilter(visitor_emails, contact_intent)
    # pending: holds back chars that might be the start of [[META]]
    pending = ""
    meta_open = False
    meta_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    # Action tools that returned ok=false this turn (e.g. "send_resume:send_failed").
    tool_failures: list[str] = []
    usage: dict[str, int | str | None] = {
        "input": None, "output": None, "model": None, "thinkingTokens": None,
    }
    status = "ok"
    error_message: str | None = None
    # For delta de-dup (cumulative vs incremental Gemini events)
    # Thinking (part.thought == True) is a fully separate stream from the
    # answer — its own de-dup state, never touches user_visible/meta_parts/
    # the audit log's `response` field. See thinking_config in agent.py.
    thought_visible: list[str] = []

    _SENTINEL_LEN = len(_META_OPEN)  # 8

    def _flush_pending() -> str:
        """Yield as much of `pending` as is safe to stream."""
        nonlocal pending
        safe_len = max(0, len(pending) - (_SENTINEL_LEN - 1))
        to_send = pending[:safe_len]
        pending = pending[safe_len:]
        return to_send

    def _absorb(new_text: str) -> list[str]:
        """Process new_text through the sentinel detector. Returns delta chunks to yield."""
        nonlocal pending, meta_open, meta_parts, user_visible
        chunks: list[str] = []
        buf = pending + new_text
        pending = ""

        while buf:
            if meta_open:
                # In meta-accumulation mode — don't stream anything
                meta_parts.append(buf)
                buf = ""
                break

            # Look for [[META]] in buf
            idx = buf.find(_META_OPEN)
            if idx == -1:
                # No sentinel start anywhere — safe to buffer everything except trailing window
                pending = buf
                flushed = _flush_pending()
                if flushed:
                    user_visible.append(flushed)
                    chunks.append(flushed)
                break
            else:
                # Found sentinel: flush everything before it, switch to meta mode
                before = buf[:idx]
                if before:
                    user_visible.append(before)
                    chunks.append(before)
                meta_open = True
                rest = buf[idx + _SENTINEL_LEN:]
                if rest:
                    meta_parts.append(rest)
                buf = ""

        return chunks

    # Spec 67: a turn can end with no answer at all (the model stops after
    # its thinking, or after its [[NOTE]] block). Rather than show a blank
    # reply, run it once more with a short server nudge.
    turn_message = new_message
    for attempt in range(2):
        try:
            async for event in _runner.run_async(
                user_id=session_id,
                session_id=session_id,
                new_message=turn_message,
                # Spec 67: how this answer will reach the visitor (guardrails.py
                # gives spoken modes a tighter length).
                state_delta={"reply_mode": reply_mode},
                run_config=RunConfig(streaming_mode=StreamingMode.SSE),
            ):
                # Collect tool calls from function_call parts.
                content = getattr(event, "content", None)
                if content is not None:
                    for part in getattr(content, "parts", None) or []:
                        fc = getattr(part, "function_call", None)
                        if fc is not None:
                            try:
                                args_repr = json.dumps(dict(fc.args or {}))[:2048]
                                tool_calls.append({"name": fc.name, "args": json.loads(args_repr)})
                            except Exception:
                                tool_calls.append({"name": getattr(fc, "name", "?"), "args": {}})

                        # Collect tool *outcomes*. Without this the audit row records
                        # a failed send as a success: the turn streams fine, so
                        # status stays "ok" and every downstream dashboard (including
                        # Pulse's digest, which counts `status != 'ok'`) reports clean
                        # while visitors are being told the email couldn't be sent.
                        fr = getattr(part, "function_response", None)
                        if fr is not None:
                            fr_name = getattr(fr, "name", None) or "?"
                            value = _fr_value(getattr(fr, "response", None))
                            code = None
                            if isinstance(value, dict):
                                raw_code = value.get("code")
                                code = str(raw_code)[:64] if raw_code is not None else None
                                if value.get("ok") is False:
                                    # ADK can emit the same part across more than one
                                    # event, so guard against a repeated entry.
                                    failure = f"{fr_name}:{code or 'failed'}"
                                    if failure not in tool_failures:
                                        tool_failures.append(failure)
                            for entry in reversed(tool_calls):
                                if entry.get("name") == fr_name and "code" not in entry:
                                    if code is not None:
                                        entry["code"] = code
                                    break

                # Collect token usage from usage_metadata. Last-wins: a turn with a
                # tool call makes two internal LLM calls, and this keeps whichever
                # one's counts are recorded, so pair "model" from the SAME event
                # rather than any event that merely mentions a model — otherwise
                # tokens from one internal call could be attributed to a different
                # model than the one that actually produced them.
                um = getattr(event, "usage_metadata", None)
                if um is not None:
                    inp = getattr(um, "prompt_token_count", None)
                    out = getattr(um, "candidates_token_count", None)
                    if inp is not None:
                        usage["input"] = int(inp)
                    if out is not None:
                        usage["output"] = int(out)
                    tt = getattr(um, "thoughts_token_count", None)
                    if tt is not None:
                        usage["thinkingTokens"] = int(tt)
                    mv = getattr(event, "model_version", None)
                    if mv:
                        usage["model"] = str(mv)

                if content is None:
                    continue
                # Skip events that are not from the model (tool calls etc.).
                author = getattr(event, "author", None)
                if author is not None and author == "user":
                    continue
                parts = getattr(content, "parts", None) or []
                # The final event of a streaming turn (partial=False, emitted once
                # the whole response is assembled) can return thought text that is
                # a TRUNCATED/windowed recap rather than a clean superset of what
                # streamed live (confirmed empirically: on longer reasoning, the
                # final thought part dropped its earliest segment). Treating that
                # as fresh content would re-emit stale/incomplete thinking after
                # the real answer has already started. Thinking is only ever
                # useful live anyway, so only process it while partial=True; the
                # final event's answer text (never observed to have this problem)
                # still flows through the unchanged dedup below.
                is_partial = bool(getattr(event, "partial", False))
                answer_texts: list[str] = []
                thought_texts: list[str] = []
                for part in parts:
                    t = getattr(part, "text", None)
                    if not t:
                        continue
                    if getattr(part, "thought", False):
                        if is_partial:
                            thought_texts.append(t)
                    else:
                        answer_texts.append(t)

                if thought_texts:
                    full_thought = "".join(thought_texts)
                    thought_so_far = "".join(thought_visible)
                    if full_thought.startswith(thought_so_far):
                        new_thought = full_thought[len(thought_so_far):]
                    elif thought_so_far.startswith(full_thought):
                        new_thought = ""
                    else:
                        # Disjoint (fresh reasoning round after a tool call) — treat as fresh
                        new_thought = full_thought
                    if new_thought:
                        thought_visible.append(new_thought)
                        # Cosmetic only — the real [[META]] protocol lives entirely on
                        # the answer stream and is untouched by this.
                        cleaned = (new_thought.replace("[[META]]", "").replace("[[/META]]", "")
                                   .replace("[[NOTE]]", "").replace("[[/NOTE]]", ""))
                        if cleaned:
                            if ttf_thinking_ms is None:
                                ttf_thinking_ms = int((time.monotonic() - start) * 1000)
                            cleaned = thought_guard.push(cleaned)
                            if cleaned:
                                yield _sse({"thinking": cleaned})

                if not answer_texts:
                    continue
                full = "".join(answer_texts)

                # Spec 67: partial events carry the NEXT piece of text; the final
                # event of a step (partial=False) repeats the whole step once
                # assembled (checked against live ADK SSE events). The old
                # prefix-matching dedup guessed from the text instead, and dropped
                # real pieces whenever one looked like a prefix of what had
                # streamed: a lone "[" vanished, "[[NOTE]]" arrived as "[NOTE]]",
                # and a lost "[" in "[[/NOTE]]" left a note block open that
                # swallowed the whole reply.
                if is_partial:
                    new_text = full
                    step_streamed = True
                elif step_streamed:
                    new_text = ""  # the recap of a step that already streamed
                    step_streamed = False
                else:
                    new_text = full  # a step that arrived only as a final event

                if not new_text:
                    continue

                for chunk in _absorb(new_text):
                    if chunk:
                        # Spec 67: a working note written into the reply goes
                        # to the Thinking panel instead (see lead_note.py).
                        shown, note = lead_guard.push(chunk)
                        if note:
                            yield _sse({"thinking": dash_guard.whole(note)})
                        shown = dash_guard.push(shown) if shown else ""
                        if shown:
                            if ttf_delta_ms is None:
                                ttf_delta_ms = int((time.monotonic() - start) * 1000)
                            yield _sse({"delta": shown})

        except Exception as exc:
            logger.exception("agent-chat stream failed")
            status = "error"
            error_message = repr(exc)[:500]
            held, _ = lead_guard.flush()
            held = dash_guard.push(held) + dash_guard.flush() if held else dash_guard.flush()
            if held:
                yield _sse({"delta": held})
            yield _sse({"delta": _failure_reply(exc)})

        answered = lead_guard.without_note(
            "".join(user_visible) + ("" if meta_open else pending)
        ).strip()
        if answered or status != "ok" or attempt == 1:
            break
        logger.warning("atlas: turn produced no answer text, retrying once")
        user_visible, pending, meta_open, meta_parts = [], "", False, []
        lead_guard = NoteFilter()
        turn_message = types.Content(role="user", parts=[types.Part.from_text(text=_EMPTY_REPLY_NUDGE)])

    # Flush any remaining safe pending chars (unlikely but defensive).
    if pending and not meta_open:
        user_visible.append(pending)
        shown, note = lead_guard.push(pending)
        if note:
            yield _sse({"thinking": dash_guard.whole(note)})
        shown = dash_guard.push(shown) if shown else ""
        if shown:
            yield _sse({"delta": shown})
        pending = ""
    held, note = lead_guard.flush()
    if note:
        yield _sse({"thinking": dash_guard.whole(note)})
    held = (dash_guard.push(held) if held else "") + dash_guard.flush()
    if held:
        yield _sse({"delta": held})
    tail = thought_guard.flush()
    if tail:
        yield _sse({"thinking": tail})

    # Assemble the user-visible response text (no [[META]] content, and no
    # working note the guard diverted).
    visible_text = dash_guard.whole(lead_guard.without_note("".join(user_visible)))

    # Detect guardrail short-circuits by matching the canned reply prefixes.
    if status == "ok":
        if visible_text.startswith(INJECTION_REPLY_PREFIX):
            status = "injection_blocked"
        elif visible_text.startswith(TOO_LONG_REPLY_PREFIX):
            status = "too_long"

    # Parse the meta block (if present). Use rfind on the full raw output for
    # last-wins semantics — defends against an echoed earlier forged sentinel.
    citations_payload: list[dict] = []
    suggestions_payload: list[str] = []
    cta_payload: str | None = None
    badges_payload: list[str] = []

    if status == "ok" and meta_parts:
        raw_meta = "".join(meta_parts)
        # Strip trailing [[/META]] if present
        close_idx = raw_meta.find(_META_CLOSE)
        if close_idx != -1:
            raw_meta = raw_meta[:close_idx]
        citations_payload, suggestions_payload, cta_payload, badges_payload = _parse_meta(
            raw_meta.strip()
        )

    # Emit structured events before done.
    if citations_payload:
        yield _sse({"citations": citations_payload})
    if suggestions_payload:
        yield _sse({"suggestions": suggestions_payload})
    if cta_payload:
        yield _sse({"cta": cta_payload})
    if badges_payload:
        yield _sse({"badges": badges_payload})

    # Spec 67: in Avatar mode, hand the reply's speech text to the avatar.
    # This event is consumed by `_with_avatar` and never reaches the browser.
    if avatar and status == "ok" and visible_text:
        speech = avatar_speak.clip_to_sentences(sanitize_for_speech(visible_text))
        if speech:
            yield _sse({_AVATAR_SCRIPT_KEY: speech})

    yield _sse({"done": True})

    # A turn where an action tool returned ok=false is not an "ok" turn, even
    # though the stream itself succeeded. Recording it as ok is what let failed
    # resume sends look healthy in the digest, which counts `status != 'ok'`.
    # Applied only here, after the [[META]] block has been parsed and emitted, so
    # a failed send still gets its citations, chips and CTA.
    # A guardrail block is not an infrastructure failure — Atlas deliberately
    # refused to relay something out of scope. Give it its own status so the
    # digest doesn't read a working guardrail as a broken send. It still counts
    # as non-"ok", the same way injection_blocked and too_long already do.
    if status == "ok" and tool_failures:
        blocked = all(f.endswith(":" + GUARDRAIL_BLOCK_CODE) for f in tool_failures)
        status = "scope_blocked" if blocked else "error"
        label = "guardrail blocked: " if blocked else "tool failed: "
        error_message = (label + ", ".join(tool_failures))[:500]

    # index into _MODEL_CANDIDATES, so the digest can tell how often the
    # 429/503 cascade fires — None if the model wasn't captured, or (rare,
    # e.g. after reconfiguring the model) if it doesn't match a known candidate.
    model_fallback_depth = (
        _MODEL_CANDIDATES.index(usage["model"]) if usage["model"] in _MODEL_CANDIDATES else None
    )

    # Time-to-first-token goes to Cloud Logging, not the audit row: the Worker
    # persists a fixed column set and would silently drop unknown keys, and
    # adding a D1 column for a diagnostic is more migration than it is worth.
    # `turn` is here because the whole question is how turn 2+ differs from
    # turn 1 — the replayed history is what made it slow.
    logger.info(
        "chat-timing: turn=%s latency_ms=%d ttf_thinking_ms=%s ttf_delta_ms=%s "
        "tokens_in=%s thinking=%s out=%s model=%s",
        turn_index,
        int((time.monotonic() - start) * 1000),
        ttf_thinking_ms,
        ttf_delta_ms,
        usage["input"],
        usage["thinkingTokens"],
        usage["output"],
        usage["model"],
    )

    # Fire-and-forget audit log after the response is fully streamed. The geo
    # lookup is resolved HERE rather than before the stream opens: it is a
    # third-party HTTP call whose result never reaches the model, so making
    # every visitor wait on it to see their first token was pure dead time.
    # It is already bounded (250ms timeout, swallows its own exceptions), and
    # by this point the client has had `done` for a while.
    asyncio.create_task(
        _log_turn(geo_task, {
            "sessionId":      session_id,
            "turnIndex":      turn_index,
            "question":       user_text[:4000],
            "response":       visible_text[:16000],  # no [[META]] content
            "toolCalls":      tool_calls[:20],
            "tokensInput":    usage["input"],
            "tokensOutput":   usage["output"],
            "model":          usage["model"],
            "thinkingTokens": usage["thinkingTokens"],
            "hadThinking":    bool(thought_visible),
            "modelFallbackDepth": model_fallback_depth,
            "latencyMs":      int((time.monotonic() - start) * 1000),
            "status":         status,
            "errorMessage":   error_message,
            "identity":       identity,
            "userAgent":      client_meta.get("ua"),
            "referrer":       client_meta.get("ref"),
            "ip":             client_meta.get("ip_truncated"),
            "agentVersion":   _AGENT_VERSION,
            "citationsCount": len(citations_payload),
            "suggestionsCount": len(suggestions_payload),
            "cta":            cta_payload,
        })
    )


def _fr_value(resp: Any) -> Any:
    """Unwrap an ADK function_response payload to the tool's return value."""
    if isinstance(resp, dict) and "result" in resp:
        return resp["result"]
    return resp



def _ws_origin_allowed(ws: WebSocket) -> bool:
    """CORS doesn't cover WebSockets and ADK's origin middleware skips them,
    so check the Origin header against ALLOW_ORIGINS here. With no allowlist
    configured (local dev), anything goes, as for HTTP."""
    allowed = [o.strip() for o in os.environ.get("ALLOW_ORIGINS", "").split(",") if o.strip()]
    return not allowed or ws.headers.get("origin") in allowed


async def _open_chat_turn(body: Any, conn: Any) -> tuple[int, dict[str, Any]] | AsyncIterator[str]:
    """Validate one chat turn, apply the limits, and start its SSE-shaped
    stream. Returns (status, error body) when the turn can't run.

    Shared by the HTTP route (SSE) and the WebSocket route, so both answer
    identically: same limits, audit log, avatar paths and fallbacks. `conn`
    is the Request or WebSocket (headers and client address only).
    """
    session_id = (body or {}).get("sessionId")
    messages = (body or {}).get("messages")
    if not isinstance(session_id, str) or not session_id:
        return (400, {"error": "Missing sessionId."})
    if not isinstance(messages, list) or not messages:
        return (400, {"error": "Missing messages."})

    # Pull the latest user message.
    last_user = next(
        (
            m
            for m in reversed(messages)
            if isinstance(m, dict)
            and m.get("role") == "user"
            and isinstance(m.get("content"), str)
        ),
        None,
    )
    if last_user is None:
        return (400, {"error": "No user message in payload."})
    user_text = last_user["content"].strip()
    if not user_text:
        return (400, {"error": "Empty user message."})

    # Parse optional self-asserted identity (forwarded from localStorage by
    # agent-widget.js when the visitor has signed in for the resume gate).
    raw_identity = (body or {}).get("identity")
    identity: dict[str, str] | None = None
    if isinstance(raw_identity, dict):
        sub = raw_identity.get("sub")
        email = raw_identity.get("email")
        if (
            isinstance(sub, str) and 1 <= len(sub) <= 200
            and isinstance(email, str) and 1 <= len(email) <= 200
        ):
            identity = {"sub": sub, "email": email}

    # Compute turn index (0-based count of user messages so far).
    turn_index = max(
        0,
        sum(1 for m in messages if isinstance(m, dict) and m.get("role") == "user") - 1,
    )

    raw_ip = _client_ip(conn)

    # Rate-limit first — this needs only raw_ip, no geo, and is effectively
    # free (in-memory), so it's the cheapest possible early-exit.
    # Spec 72: an avatar turn spends the avatar budget (checked below)
    # instead of a chat question, so the budgets never overlap and running
    # out of avatar still leaves every chat question for Voice.
    ip_hash = limiter.hash_ip(raw_ip)
    want_avatar = (body or {}).get("avatar") is True
    allowed = want_avatar or limiter.check_and_record(session_id, ip_hash)[0]

    # Best-effort geo on the untruncated IP, only for the audit log — it
    # never feeds the model. Kick it off now so it runs concurrently with
    # _ensure_session below instead of serially gating the stream start;
    # bounded by lookup_geo's 250ms timeout and exception-swallowing.
    geo_task = asyncio.create_task(lookup_geo(raw_ip))

    if not allowed:
        geo = await geo_task
        client_meta = {
            "ip_truncated": _truncate_ip(raw_ip),
            "ua":           (conn.headers.get("user-agent") or "")[:500],
            "ref":          (conn.headers.get("referer") or "")[:500],
            "country":      (geo or {}).get("country"),
            "region":       (geo or {}).get("region"),
            "city":         (geo or {}).get("city"),
        }
        # Both session and IP buckets cap at 10/24h, so the user-facing
        # message is the same regardless of which one fired.
        msg = (
            "Thanks for the conversation. That's the question budget for "
            "today (10 per visitor). For anything more, the best place is "
            "LinkedIn: https://www.linkedin.com/in/glahoti/. Catch you "
            "tomorrow!"
        )
        asyncio.create_task(
            log_interaction({
                "sessionId":      session_id,
                "turnIndex":      turn_index,
                "question":       user_text[:4000],
                "response":       "",
                "toolCalls":      [],
                "tokensInput":    None,
                "tokensOutput":   None,
                "model":          None,
                "modelFallbackDepth": None,
                "latencyMs":      None,
                "status":         "rate_limited",
                "errorMessage":   None,
                "identity":       identity,
                "userAgent":      client_meta.get("ua"),
                "referrer":       client_meta.get("ref"),
                "ip":             client_meta.get("ip_truncated"),
                "country":        client_meta.get("country"),
                "region":         client_meta.get("region"),
                "city":           client_meta.get("city"),
                "agentVersion":   _AGENT_VERSION,
                "citationsCount": None,
                "suggestionsCount": None,
                "cta":            None,
            })
        )
        return (429, {"error": msg})

    # Only the session is on the critical path. `geo_task` keeps running in
    # the background and is awaited by `_log_turn` after the stream closes.
    await _ensure_session(session_id)
    client_meta = {
        "ip_truncated": _truncate_ip(raw_ip),
        "ua":           (conn.headers.get("user-agent") or "")[:500],
        "ref":          (conn.headers.get("referer") or "")[:500],
    }

    # Spec 67: Avatar mode. A capped avatar turn is not an error and does
    # not run the agent: the widget offers Voice mode and re-asks the same
    # question there, so answering it here too would be paid for twice
    # (and put the question in the session history twice).
    avatar_refusal: tuple[str, str] | None = None
    if want_avatar:
        ok_visitor, _ = limiter.check_and_record(session_id, ip_hash, bucket="avatar")
        if not ok_visitor:
            avatar_refusal = (AVATAR_VISITOR_CAP_REPLY, "avatar")
        elif not avatar_speak.budget.reserve(avatar_speak.RESERVE_SECONDS):
            avatar_refusal = (AVATAR_SITE_CAP_REPLY, "site")
            logger.info("avatar daily budget spent (%.0fs used)", avatar_speak.budget.used_seconds)
    if avatar_refusal:
        geo_task.cancel()
        return _capped_avatar_stream(*avatar_refusal)

    text_stream = _stream_agent(
        session_id,
        user_text,
        turn_index=turn_index,
        identity=identity,
        client_meta=client_meta,
        geo_task=geo_task,
        avatar=want_avatar,
        reply_mode=_reply_mode(body, want_avatar),
        visitor_emails=frozenset(
            e for m in messages if isinstance(m, dict) and m.get("role") == "user"
            for e in emails_in(str(m.get("content") or ""))
        ),
        contact_intent=has_contact_intent(user_text),
    )
    # Prompt-injection attempts keep the text agent's fixed refusal.
    if want_avatar and _live_brain_on() and not _INJECTION_RE.search(user_text):
        fallback = _stream_agent(
            session_id, user_text, turn_index=turn_index, identity=identity,
            client_meta=client_meta, geo_task=None, avatar=False, reply_mode="text",
            contact_intent=has_contact_intent(user_text),
        )
        stream = _live_avatar_stream(
            session_id, user_text, turn_index=turn_index, identity=identity,
            client_meta=client_meta, geo_task=geo_task, fallback=fallback,
        )
    else:
        stream = _with_avatar(text_stream) if want_avatar else text_stream

    return stream


def register_routes(app: FastAPI) -> None:
    """Attach the portfolio chat routes to a FastAPI app."""

    @app.get("/healthz")
    async def healthz() -> dict[str, bool]:
        return {"ok": True}

    # Network probes: no model, no data, no cost. They stream a timestamped
    # tick every `interval_ms`, so a browser can see whether something between
    # it and Atlas (a corporate inspection proxy such as Netskope or Zscaler)
    # holds a stream back and releases it in bursts, and whether padding the
    # start or switching to a WebSocket gets through live. Open to any origin
    # on purpose: they return nothing but the server's own clock.
    _PROBE_MAX_TICKS = 20
    _PROBE_MAX_PAD = 16384

    def _probe_args(pad: int, interval_ms: int, ticks: int) -> tuple[int, float, int]:
        return (max(0, min(pad, _PROBE_MAX_PAD)), max(100, min(interval_ms, 2000)) / 1000,
                max(1, min(ticks, _PROBE_MAX_TICKS)))

    @app.get("/api/stream-probe")
    async def stream_probe(pad: int = 0, interval_ms: int = 500, ticks: int = 10) -> StreamingResponse:
        pad, interval, ticks = _probe_args(pad, interval_ms, ticks)

        async def gen() -> AsyncIterator[str]:
            if pad:
                yield ":" + " " * pad + "\n\n"
            start = time.monotonic()
            for i in range(ticks):
                yield _sse({"tick": i, "serverMs": int((time.monotonic() - start) * 1000)})
                await asyncio.sleep(interval)
            yield _sse({"done": True})

        return StreamingResponse(gen(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
        })

    @app.websocket("/api/stream-probe-ws")
    async def stream_probe_ws(ws: WebSocket, interval_ms: int = 500, ticks: int = 10) -> None:
        _, interval, ticks = _probe_args(0, interval_ms, ticks)
        await ws.accept()
        start = time.monotonic()
        try:
            for i in range(ticks):
                await ws.send_json({"tick": i, "serverMs": int((time.monotonic() - start) * 1000)})
                await asyncio.sleep(interval)
            await ws.send_json({"done": True})
            await ws.close()
        except WebSocketDisconnect:
            pass

    @app.post("/api/stream-probe/report")
    async def stream_probe_report(request: Request) -> JSONResponse:
        """The widget runs the probes above once a day in the background and
        posts only the timings here (per tick: client arrival minus server
        send, in ms), so a slow network path can be diagnosed without asking
        the visitor to do anything. Logged, not stored."""
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = None
        if not isinstance(body, dict) or not isinstance(body.get("sessionId"), str):
            return JSONResponse({"error": "bad request"}, status_code=400)
        ip = _client_ip(request)
        ok, _ = limiter.check_and_record(body["sessionId"][:128], limiter.hash_ip(ip), bucket="probe_report")
        if not ok:
            return JSONResponse({"ok": False})

        def ints(v: Any) -> list[int] | str:
            if isinstance(v, list):
                return [int(x) for x in v[:_PROBE_MAX_TICKS] if isinstance(x, (int, float))]
            return str(v)[:40]

        ua = (request.headers.get("user-agent") or "")[:300]
        logger.info(
            "stream-probe: os=%s ip=%s sse=%s padded=%s ws=%s ua=%s",
            "Windows" if "Windows" in ua else "Mac" if "Mac OS" in ua else "iOS" if "iPhone" in ua else "Android" if "Android" in ua else "other",
            _truncate_ip(ip), ints(body.get("sse")), ints(body.get("ssePadded")), ints(body.get("ws")), ua,
        )
        return JSONResponse({"ok": True})

    @app.post("/api/agent-live/warm")
    async def live_warm(request: Request) -> JSONResponse:
        """The widget calls this when a visitor starts typing in Avatar mode,
        so the Live session is open (and ~1.5s faster) by the time they send.
        Never blocks the visitor: the session opens in the background."""
        if not _live_brain_on():
            return JSONResponse({"warming": False})
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = None
        session_id = (body or {}).get("sessionId") if isinstance(body, dict) else None
        if not isinstance(session_id, str) or not (8 <= len(session_id) <= 128):
            return JSONResponse({"error": "sessionId required"}, status_code=400)
        ip_hash = limiter.hash_ip(_client_ip(request))
        ok, _ = limiter.check_and_record(session_id, ip_hash, bucket="live_warm")
        if not ok:
            return JSONResponse({"warming": False})
        await _ensure_session(session_id)
        asyncio.create_task(live_brain.warm_pool.warm(session_id))
        return JSONResponse({"warming": True})

    @app.get("/api/agent-chat/warm")
    async def warm() -> dict[str, bool]:
        # Mere arrival of this request spins up Cloud Run if cold. Also nudge the
        # resend-mcp-server, which is a second min-instances=0 service on the
        # send path: warming it here means an actual resume request later doesn't
        # have to wait out its cold start.
        #
        # Spec 50: prime the TTS credentials/client too. The first Vertex call
        # in a container costs ~3s more than a warm one, and with sentence
        # chunking that lands on the first clip a visitor hears. Same tax, same
        # fix, for transcription — voice input is mic-tap-gated and
        # mobile-heavy, so without this most real transcribe requests were each
        # container's first-ever call, paying the cold ADC/TLS cost.
        # All three are independent, so run them concurrently rather than
        # awaiting each in turn; warm_speak/warm_transcribe are sync functions
        # doing blocking ADC calls, offloaded to a thread so they can't stall
        # the event loop for other concurrent requests.
        mcp_ready, speak_ready, transcribe_ready = await asyncio.gather(
            warm_mcp_server(),
            asyncio.to_thread(warm_speak),
            asyncio.to_thread(warm_transcribe),
        )
        return {
            "ok": True,
            "mcpReady": mcp_ready,
            "speakReady": speak_ready,
            "transcribeReady": transcribe_ready,
        }

    # ~3x the client's 30s recording cap at 24kbps opus, so a legitimate clip
    # never trips this — it exists to stop a crafted request from posting a
    # huge body straight into a Gemini call.
    _MAX_AUDIO_B64_CHARS = 2_200_000

    @app.post("/api/agent-transcribe")
    async def agent_transcribe(request: Request) -> Any:
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return JSONResponse(
                status_code=400, content={"error": "Body must be JSON."}
            )

        session_id = (body or {}).get("sessionId")
        mime_type = (body or {}).get("mimeType")
        audio_b64 = (body or {}).get("audio")
        if not isinstance(session_id, str) or not session_id:
            return JSONResponse(
                status_code=400, content={"error": "Missing sessionId."}
            )
        if not isinstance(mime_type, str):
            return JSONResponse(
                status_code=400, content={"error": "Missing mimeType."}
            )
        mime = normalize_mime(mime_type)
        if mime is None:
            return JSONResponse(
                status_code=400, content={"error": "Unsupported audio format."}
            )
        if not isinstance(audio_b64, str) or not audio_b64:
            return JSONResponse(
                status_code=400, content={"error": "Missing audio."}
            )
        if len(audio_b64) > _MAX_AUDIO_B64_CHARS:
            return JSONResponse(
                status_code=400, content={"error": "Recording too large."}
            )

        # Own bucket (see rate_limit.py): transcribing must never spend one
        # of the visitor's 10 chat questions. No geo lookup, no audit log —
        # this isn't a chat turn.
        raw_ip = _client_ip(request)
        ip_hash = limiter.hash_ip(raw_ip)
        allowed, _reason = limiter.check_and_record(
            session_id, ip_hash, bucket="voice"
        )
        if not allowed:
            return JSONResponse(
                status_code=429,
                content={
                    "error": (
                        "That's the voice-input budget for today. "
                        "Type your question instead."
                    )
                },
            )

        text, _model_used = await transcribe_audio(audio_b64, mime)
        if not text:
            return JSONResponse(
                status_code=502,
                content={
                    "error": (
                        "Transcription is unavailable right now. "
                        "Type your question instead."
                    )
                },
            )
        return {"text": text[:1000]}

    @app.post("/api/agent-speak")
    async def agent_speak(request: Request) -> Any:
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return JSONResponse(
                status_code=400, content={"error": "Body must be JSON."}
            )

        session_id = (body or {}).get("sessionId")
        text = (body or {}).get("text")
        if not isinstance(session_id, str) or not session_id:
            return JSONResponse(
                status_code=400, content={"error": "Missing sessionId."}
            )
        if not isinstance(text, str) or not text.strip():
            return JSONResponse(
                status_code=400, content={"error": "Missing text."}
            )
        if len(text) > MAX_TEXT_CHARS:
            return JSONResponse(
                status_code=400, content={"error": "Text too long to speak."}
            )

        # Own bucket (see rate_limit.py): synthesis must never spend one of
        # the visitor's 10 chat questions. No geo lookup, no audit log — the
        # chat turn that produced this text was already logged, and logging
        # again per sentence chunk would multiply one answer into several
        # rows.
        raw_ip = _client_ip(request)
        ip_hash = limiter.hash_ip(raw_ip)
        allowed, _reason = limiter.check_and_record(
            session_id, ip_hash, bucket="speak"
        )
        if not allowed:
            return JSONResponse(
                status_code=429,
                content={"error": "That's the spoken-reply budget for today."},
            )

        audio_b64, model_used = await speak_text(text)
        if not audio_b64:
            return JSONResponse(
                status_code=502,
                content={"error": "Speech is unavailable right now."},
            )
        return {"audio": audio_b64, "mime": "audio/wav", "model": model_used}

    _SSE_HEADERS = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}

    @app.post("/api/agent-chat")
    async def agent_chat(request: Request) -> Any:
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return JSONResponse(
                status_code=400, content={"error": "Body must be JSON."}
            )
        result = await _open_chat_turn(body, request)
        if isinstance(result, tuple):
            return JSONResponse(status_code=result[0], content=result[1])
        return StreamingResponse(result, media_type="text/event-stream", headers=_SSE_HEADERS)

    @app.websocket("/api/agent-live")
    async def agent_live(ws: WebSocket) -> None:
        """A hands-free avatar conversation (spec 71).

        In: the first text frame is {"start": {"sessionId"}}; then binary
        frames of 16 kHz PCM16 mic audio (100 ms at most each) and text
        frames {"text"}, {"mute"}, {"end"}. Out: binary frames are the
        face's fMP4 video; text frames are JSON events: state, userWords,
        words {text, at}, interrupted, show (a target key), turnEnd, end {reason, capped, kind}.
        Gated by ATLAS_LIVE_CONVO=1.
        """
        if os.environ.get("ATLAS_LIVE_CONVO", "") != "1" or not _ws_origin_allowed(ws):
            await ws.close(code=1008)
            return
        await ws.accept()
        try:
            first = await ws.receive_json()
            session_id = first["start"]["sessionId"]
            assert isinstance(session_id, str) and 8 <= len(session_id) <= 128
        except Exception:  # noqa: BLE001 - malformed start
            await ws.send_json({"end": {"reason": "bad request", "capped": False}})
            await ws.close()
            return

        raw_ip = _client_ip(ws)
        ip_hash = limiter.hash_ip(raw_ip)
        client_meta = {
            "ip_truncated": _truncate_ip(raw_ip),
            "ua": (ws.headers.get("user-agent") or "")[:500],
            "ref": (ws.headers.get("referer") or "")[:500],
        }
        # One lookup per conversation, awaited by each turn's audit row (an
        # awaited-again Task just returns its result). Bounded and
        # exception-swallowing like the chat route's.
        geo_task = asyncio.create_task(lookup_geo(raw_ip))

        async def refuse(reason: str, kind: str) -> None:
            await ws.send_json({"end": {"reason": reason, "capped": True, "kind": kind}})
            await ws.close()

        # Spec 72: a conversation spends only the avatar's own budget, the
        # first question here and each later one as its turn ends. It never
        # touches the 10 chat questions, so a visitor out of avatar turns is
        # handed to Voice with those still intact. `kind` says which cap:
        # "avatar" is this visitor's share, "site" the day's spend for all.
        if not limiter.check_and_record(session_id, ip_hash, bucket="avatar")[0]:
            return await refuse(AVATAR_VISITOR_CAP_REPLY, "avatar")
        reserved = avatar_speak.RESERVE_SECONDS
        if not avatar_speak.budget.reserve(reserved):
            return await refuse(AVATAR_SITE_CAP_REPLY, "site")

        await _ensure_session(session_id)
        convo = live_brain.LiveConversation(live_brain.ToolDispatcher(session_id))
        turns = 0
        end_reason, capped, cap_kind = "ended", False, None
        goodbye = False
        try:
            await convo.open()
            await convo.seed(await _chat_history(session_id))
        except Exception:  # noqa: BLE001
            logger.exception("live conversation: could not open")
            avatar_speak.budget.settle(reserved, 0.0)
            await ws.send_json({"end": {"reason": "Avatar is unavailable right now.", "capped": False}})
            await ws.close()
            await convo.close()
            return
        await ws.send_json({"state": "listening"})

        async def uplink() -> None:
            # Mic audio and controls from the browser.
            while True:
                msg = await ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    return
                if msg.get("bytes") is not None:
                    pcm = msg["bytes"]
                    if 0 < len(pcm) <= 3200 and len(pcm) % 2 == 0:  # <= 100 ms of 16 kHz PCM16
                        await convo.send_audio(pcm)
                    continue
                try:
                    ctl = json.loads(msg.get("text") or "{}")
                except ValueError:
                    continue
                if ctl.get("end"):
                    return
                if ctl.get("mute"):
                    await convo.mute()
                if isinstance(ctl.get("text"), str) and ctl["text"].strip():
                    await convo.send_text(ctl["text"].strip()[:1000])

        up = asyncio.ensure_future(uplink())
        try:
            events = convo.events().__aiter__()
            while True:
                nxt = asyncio.ensure_future(events.__anext__())
                done, _ = await asyncio.wait({nxt, up}, return_when=asyncio.FIRST_COMPLETED)
                if up in done:
                    nxt.cancel()
                    break
                try:
                    kind, value = nxt.result()
                except StopAsyncIteration:
                    break
                if kind == "video":
                    await ws.send_bytes(value)
                elif kind == "words":
                    await ws.send_json({"words": _words_event(value, convo)})
                elif kind == "user_words":
                    await ws.send_json({"userWords": value})
                elif kind == "state":
                    await ws.send_json({"state": value})
                elif kind == "interrupted":
                    await ws.send_json({"interrupted": True})
                elif kind == "show":
                    await ws.send_json({"show": value})  # spec 78: a target key, never a URL
                elif kind == "turn_end":
                    turn = value
                    turns += 1
                    avatar_speak.budget.settle(reserved, turn["spoken_seconds"])
                    reserved = 0.0  # settled; the next question reserves afresh
                    await ws.send_json({"turnEnd": {k: turn[k] for k in ("question", "answer", "status", "first_word_ms")}})
                    if turn["question"] or turn["answer"]:
                        try:
                            await _remember_live_turn(session_id, turn["question"], turn["answer"])
                        except Exception:  # history is best effort
                            logger.exception("live conversation: could not record the turn")
                    logger.info(
                        "live-convo: turn=%d first_word_ms=%s tools=%s spoke=%.1fs ($%.3f) status=%s",
                        turns, turn["first_word_ms"], turn["tools"], turn["spoken_seconds"],
                        turn["spoken_seconds"] * avatar_speak.USD_PER_SPEAKING_SECOND, turn["status"],
                    )
                    asyncio.create_task(_log_turn(geo_task, {
                        "sessionId": session_id, "turnIndex": turns,
                        "question": turn["question"][:4000], "response": turn["answer"][:16000],
                        "toolCalls": turn["calls"][:20], "model": avatar_speak.AVATAR_MODEL,
                        "latencyMs": turn["first_word_ms"],
                        "status": "injection" if _INJECTION_RE.search(turn["question"]) else turn["status"],
                        "userAgent": client_meta["ua"], "referrer": client_meta["ref"],
                        "ip": client_meta["ip_truncated"], "agentVersion": _AGENT_VERSION,
                    }))
                    # The next question is charged now, so a visitor at a cap
                    # is told before asking rather than cut off mid-answer. Not
                    # after Atlas's own check-in (spec 79): nobody asked anything.
                    if not turn["question"]:
                        continue
                    if not limiter.check_and_record(session_id, ip_hash, bucket="avatar")[0]:
                        end_reason, capped, cap_kind = AVATAR_VISITOR_CAP_REPLY, True, "avatar"
                        break
                    if not avatar_speak.budget.reserve(avatar_speak.RESERVE_SECONDS):
                        end_reason, capped, cap_kind = AVATAR_SITE_CAP_REPLY, True, "site"
                        break
                    reserved = avatar_speak.RESERVE_SECONDS
                elif kind == "end":
                    goodbye = value == "goodbye"  # spec 79: Atlas said goodbye; nothing to explain
                    end_reason = {"goodbye": "", "idle": "Ended after a quiet stretch.", "max": "Conversations last up to five minutes.",
                                  "error": "The avatar dropped the connection."}.get(value, "ended")
                    break
        except Exception:  # noqa: BLE001 - browser gone mid-send
            logger.info("live conversation: client left")
        finally:
            up.cancel()
            await convo.close()
            if reserved:
                avatar_speak.budget.settle(reserved, 0.0)
            try:
                end_evt = {"reason": end_reason, "capped": capped}
                if goodbye:
                    end_evt["goodbye"] = True
                if cap_kind:
                    end_evt["kind"] = cap_kind
                await ws.send_json({"end": end_evt})
                await ws.close()
            except Exception:  # noqa: BLE001 - already closed
                pass
            logger.info("live-convo: ended session=%s turns=%d reason=%s", session_id[:8], turns, "goodbye" if goodbye else end_reason)

    @app.websocket("/api/agent-chat-ws")
    async def agent_chat_ws(ws: WebSocket) -> None:
        """The same turn as /api/agent-chat, over a WebSocket.

        Corporate inspection proxies (measured: a Netskope-managed laptop)
        hold an HTTP stream until it completes and release it in one burst,
        so text, voice and avatar arrive seconds late; the same proxy passed
        WebSocket frames through live (stream-probe, 2026-09-29). Each SSE
        event goes out as one text frame with the same JSON; the client sends
        the request as its first frame and `{"abort": true}` to stop.
        """
        if not _ws_origin_allowed(ws):
            await ws.close(code=1008)
            return
        await ws.accept()
        try:
            body = await ws.receive_json()
        except Exception:  # noqa: BLE001 - not JSON, or gone already
            await ws.close(code=1003)
            return
        result = await _open_chat_turn(body, ws)
        if isinstance(result, tuple):
            await ws.send_json({"httpStatus": result[0], **result[1]})
            await ws.close()
            return
        stop = asyncio.Event()

        async def watch() -> None:
            # A disconnect or {"abort": true} ends the turn at once, so a
            # closed tab never keeps a model or avatar session running.
            try:
                while True:
                    msg = await ws.receive_json()
                    if isinstance(msg, dict) and msg.get("abort"):
                        break
            except Exception:  # noqa: BLE001 - disconnect
                pass
            stop.set()

        watcher = asyncio.ensure_future(watch())
        try:
            async for chunk in result:
                if stop.is_set():
                    break
                for line in chunk.split("\n"):
                    if line.startswith("data: "):
                        await ws.send_text(line[6:])
        except Exception:  # noqa: BLE001 - client went away mid-send
            logger.info("agent-chat-ws: client left mid-turn")
        finally:
            watcher.cancel()
            await result.aclose()
            try:
                await ws.close()
            except Exception:  # noqa: BLE001 - already closed
                pass
