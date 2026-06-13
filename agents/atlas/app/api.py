"""Custom HTTP routes for the portfolio chat widget.

The static site (`assets/js/agent-widget.js`) talks to these routes — not
ADK's native `/run_sse` — so the frontend stays decoupled from ADK's internal
event format. Three routes:

- `POST /api/agent-chat` — SSE stream emitting `{"delta": str}` per chunk and
  `{"done": true}` to close. Request shape mirrors spec #20:
      {"sessionId": "uuid-v4", "messages": [{"role": "user|assistant", "content": str}, ...]}
- `GET  /api/agent-chat/warm` — 200 OK, no work. Frontend fires this on
  FAB-open to spin up Cloud Run before the user types.
- `GET  /healthz` — Cloud Run liveness probe.

Rate limiting is enforced before the ADK runner is invoked. The strategy
is layered: 4 messages per sessionId per 24h AND 4 messages per IP-hash
per 24h. The IP cap is the ceiling — reloading to get a fresh sessionId
does not bypass it. See `rate_limit.py` for details.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections.abc import AsyncIterator
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import InMemoryRunner
from google.genai import types

from app.agent import root_agent
from app.app_utils.audit_log import log_interaction
from app.app_utils.geo_lookup import lookup_geo
from app.guardrails import INJECTION_REPLY_PREFIX, TOO_LONG_REPLY_PREFIX
from app.rate_limit import limiter

_AGENT_VERSION = os.environ.get("COMMIT_SHA", "dev")

logger = logging.getLogger(__name__)

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
    # Cloud Run forwards via X-Forwarded-For. Take the first entry (the
    # original client). Fallback to the socket peer.
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
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
_ALLOWED_CTA = {"topmate", "linkedin"}
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


def _parse_meta(raw: str) -> tuple[list[dict], list[str], str | None]:
    """Parse a raw meta-block JSON string into (citations, suggestions, cta).

    Returns empty collections on any failure — never raises.
    Uses rfind so the LAST [[META]] in the full response wins (defends
    against a forged earlier sentinel echoed by the model).
    """
    try:
        obj = json.loads(raw)
        # citations: validate each entry
        raw_cites = obj.get("citations") or []
        citations: list[dict] = []
        for c in raw_cites[:3]:
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
            citations.append({"id": cid, "url": url[:500], "label": str(label)[:80]})
        # suggestions: 2–3 non-empty strings ≤ 80 chars; drop off-scope
        # (generic tech-definition) suggestions Atlas would only decline.
        raw_sugg = obj.get("suggestions") or []
        suggestions = [
            str(s)[:80]
            for s in raw_sugg
            if isinstance(s, str) and s.strip() and not _is_offscope_suggestion(s)
        ][:3]
        # cta: null or one of the allowed values
        raw_cta = obj.get("cta")
        cta = raw_cta if isinstance(raw_cta, str) and raw_cta in _ALLOWED_CTA else None
        return citations, suggestions, cta
    except Exception:
        logger.warning("meta-block parse failed on: %r", raw[:200])
        return [], [], None


async def _stream_agent(
    session_id: str,
    user_text: str,
    *,
    turn_index: int,
    identity: dict[str, str] | None,
    client_meta: dict[str, str],
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
    # user_visible: text actually forwarded to the client (excludes meta block)
    user_visible: list[str] = []
    # pending: holds back chars that might be the start of [[META]]
    pending = ""
    meta_open = False
    meta_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    usage: dict[str, int | None] = {"input": None, "output": None}
    status = "ok"
    error_message: str | None = None
    # For delta de-dup (cumulative vs incremental Gemini events)
    emitted_len = 0  # chars already flushed to user_visible / pending

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

    try:
        async for event in _runner.run_async(
            user_id=session_id,
            session_id=session_id,
            new_message=new_message,
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

            # Collect token usage from usage_metadata.
            um = getattr(event, "usage_metadata", None)
            if um is not None:
                inp = getattr(um, "prompt_token_count", None)
                out = getattr(um, "candidates_token_count", None)
                if inp is not None:
                    usage["input"] = int(inp)
                if out is not None:
                    usage["output"] = int(out)

            if content is None:
                continue
            # Skip events that are not from the model (tool calls etc.).
            author = getattr(event, "author", None)
            if author is not None and author == "user":
                continue
            parts = getattr(content, "parts", None) or []
            text_chunks: list[str] = []
            for part in parts:
                t = getattr(part, "text", None)
                if t:
                    text_chunks.append(t)
            if not text_chunks:
                continue
            full = "".join(text_chunks)

            # Delta de-dup: Gemini can send cumulative or incremental payloads.
            total_so_far = "".join(user_visible) + pending + "".join(meta_parts)
            if full.startswith(total_so_far):
                new_text = full[len(total_so_far):]
            elif total_so_far.startswith(full):
                new_text = ""
            else:
                # Disjoint (post-tool-call turn) — treat as fresh
                new_text = full
                emitted_len = 0

            if not new_text:
                continue

            for chunk in _absorb(new_text):
                if chunk:
                    yield _sse({"delta": chunk})

    except Exception as exc:
        logger.exception("agent-chat stream failed")
        status = "error"
        error_message = repr(exc)[:500]
        yield _sse(
            {
                "delta": "Hmm, something went wrong on my end. Mind trying "
                "that again? Gaurav's on LinkedIn for anything urgent."
            }
        )

    # Flush any remaining safe pending chars (unlikely but defensive).
    if pending and not meta_open:
        user_visible.append(pending)
        yield _sse({"delta": pending})
        pending = ""

    # Assemble the user-visible response text (no [[META]] content).
    visible_text = "".join(user_visible)

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

    if status == "ok" and meta_parts:
        raw_meta = "".join(meta_parts)
        # Strip trailing [[/META]] if present
        close_idx = raw_meta.find(_META_CLOSE)
        if close_idx != -1:
            raw_meta = raw_meta[:close_idx]
        citations_payload, suggestions_payload, cta_payload = _parse_meta(raw_meta.strip())

    # Emit structured events before done.
    if citations_payload:
        yield _sse({"citations": citations_payload})
    if suggestions_payload:
        yield _sse({"suggestions": suggestions_payload})
    if cta_payload:
        yield _sse({"cta": cta_payload})

    yield _sse({"done": True})

    # Fire-and-forget audit log after the response is fully streamed.
    asyncio.create_task(
        log_interaction({
            "sessionId":      session_id,
            "turnIndex":      turn_index,
            "question":       user_text[:4000],
            "response":       visible_text[:16000],  # no [[META]] content
            "toolCalls":      tool_calls[:20],
            "tokensInput":    usage["input"],
            "tokensOutput":   usage["output"],
            "latencyMs":      int((time.monotonic() - start) * 1000),
            "status":         status,
            "errorMessage":   error_message,
            "identity":       identity,
            "userAgent":      client_meta.get("ua"),
            "referrer":       client_meta.get("ref"),
            "ip":             client_meta.get("ip_truncated"),
            "country":        client_meta.get("country"),
            "region":         client_meta.get("region"),
            "city":           client_meta.get("city"),
            "agentVersion":   _AGENT_VERSION,
            "citationsCount": len(citations_payload),
            "suggestionsCount": len(suggestions_payload),
            "cta":            cta_payload,
        })
    )


def register_routes(app: FastAPI) -> None:
    """Attach the portfolio chat routes to a FastAPI app."""

    @app.get("/healthz")
    async def healthz() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/api/agent-chat/warm")
    async def warm() -> dict[str, bool]:
        # Mere arrival of this request spins up Cloud Run if cold.
        return {"ok": True}

    @app.post("/api/agent-chat")
    async def agent_chat(request: Request) -> Any:
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return JSONResponse(
                status_code=400, content={"error": "Body must be JSON."}
            )

        session_id = (body or {}).get("sessionId")
        messages = (body or {}).get("messages")
        if not isinstance(session_id, str) or not session_id:
            return JSONResponse(
                status_code=400, content={"error": "Missing sessionId."}
            )
        if not isinstance(messages, list) or not messages:
            return JSONResponse(
                status_code=400, content={"error": "Missing messages."}
            )

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
            return JSONResponse(
                status_code=400,
                content={"error": "No user message in payload."},
            )
        user_text = last_user["content"].strip()
        if not user_text:
            return JSONResponse(
                status_code=400, content={"error": "Empty user message."}
            )

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

        raw_ip = _client_ip(request)
        # Best-effort geo on the untruncated IP. Never blocks the request:
        # bounded by lookup_geo's 250ms timeout and exception-swallowing.
        geo = await lookup_geo(raw_ip)
        client_meta = {
            "ip_truncated": _truncate_ip(raw_ip),
            "ua":           (request.headers.get("user-agent") or "")[:500],
            "ref":          (request.headers.get("referer") or "")[:500],
            "country":      (geo or {}).get("country"),
            "region":       (geo or {}).get("region"),
            "city":         (geo or {}).get("city"),
        }

        ip_hash = limiter.hash_ip(raw_ip)
        allowed, _reason = limiter.check_and_record(session_id, ip_hash)
        if not allowed:
            # Both session and IP buckets cap at 4/24h, so the user-facing
            # message is the same regardless of which one fired.
            msg = (
                "Thanks for the conversation — that's the question budget for "
                "today (4 per visitor). For anything more, the best place is "
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
            return JSONResponse(
                status_code=429, content={"error": msg}
            )

        await _ensure_session(session_id)

        return StreamingResponse(
            _stream_agent(
                session_id,
                user_text,
                turn_index=turn_index,
                identity=identity,
                client_meta=client_meta,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )
