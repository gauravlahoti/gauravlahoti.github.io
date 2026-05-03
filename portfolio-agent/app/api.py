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
import time
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from google.adk.runners import InMemoryRunner
from google.genai import types

from app.agent import root_agent
from app.app_utils.audit_log import log_interaction
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


_INJECTION_REPLY_PREFIX = "I'm an agent representing Gaurav and I only answer"
_TOO_LONG_REPLY_PREFIX = "Your message is a bit long for me to handle"


async def _stream_agent(
    session_id: str,
    user_text: str,
    *,
    turn_index: int,
    identity: dict[str, str] | None,
    client_meta: dict[str, str],
) -> AsyncIterator[str]:
    """Run the latest user message through the ADK runner and yield SSE chunks.

    Tracks an emitted-text buffer so we only forward *new* characters from
    each event (handles both incremental and cumulative event payloads
    without duplicating output).
    """
    new_message = types.Content(
        role="user", parts=[types.Part.from_text(text=user_text)]
    )

    start = time.monotonic()
    emitted = ""
    tool_calls: list[dict[str, Any]] = []
    usage: dict[str, int | None] = {"input": None, "output": None}
    status = "ok"
    error_message: str | None = None

    try:
        async for event in _runner.run_async(
            user_id=session_id,
            session_id=session_id,
            new_message=new_message,
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
            if full.startswith(emitted):
                delta = full[len(emitted):]
            elif emitted.startswith(full):
                # Final event echoing prior partial; nothing new.
                delta = ""
            else:
                # Disjoint event (separate model turn after a tool call) —
                # emit the whole thing and reset the buffer.
                delta = full
                emitted = ""
            if delta:
                emitted += delta
                yield _sse({"delta": delta})
    except Exception as exc:
        logger.exception("agent-chat stream failed")
        status = "error"
        error_message = repr(exc)[:500]
        yield _sse(
            {
                "delta": "Sorry — the agent hit an error. Try again, or "
                "reach Gaurav on LinkedIn for anything urgent."
            }
        )

    # Detect guardrail short-circuits by matching the canned reply prefixes
    # (set in guardrails.py). This avoids threading state through callbacks.
    if status == "ok":
        if emitted.startswith(_INJECTION_REPLY_PREFIX):
            status = "injection_blocked"
        elif emitted.startswith(_TOO_LONG_REPLY_PREFIX):
            status = "too_long"

    yield _sse({"done": True})

    # Fire-and-forget audit log after the response is fully streamed.
    asyncio.create_task(
        log_interaction({
            "sessionId":    session_id,
            "turnIndex":    turn_index,
            "question":     user_text[:4000],
            "response":     emitted[:16000],
            "toolCalls":    tool_calls[:20],
            "tokensInput":  usage["input"],
            "tokensOutput": usage["output"],
            "latencyMs":    int((time.monotonic() - start) * 1000),
            "status":       status,
            "errorMessage": error_message,
            "identity":     identity,
            "userAgent":    client_meta.get("ua"),
            "referrer":     client_meta.get("ref"),
            "ip":           client_meta.get("ip_truncated"),
            "agentVersion": _AGENT_VERSION,
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
        client_meta = {
            "ip_truncated": _truncate_ip(raw_ip),
            "ua":           (request.headers.get("user-agent") or "")[:500],
            "ref":          (request.headers.get("referer") or "")[:500],
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
                    "sessionId":    session_id,
                    "turnIndex":    turn_index,
                    "question":     user_text[:4000],
                    "response":     "",
                    "toolCalls":    [],
                    "tokensInput":  None,
                    "tokensOutput": None,
                    "latencyMs":    None,
                    "status":       "rate_limited",
                    "errorMessage": None,
                    "identity":     identity,
                    "userAgent":    client_meta.get("ua"),
                    "referrer":     client_meta.get("ref"),
                    "ip":           client_meta.get("ip_truncated"),
                    "agentVersion": _AGENT_VERSION,
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
