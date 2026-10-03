"""Fail-closed route allowlist for the public Atlas service (spec 85).

`get_fast_api_app()` publishes ADK's whole developer surface next to our own
routes: `/run` and `/run_sse` (the agent with no rate limit and no audit row),
`/builder/save`, session CRUD, eval runs, `/debug/trace/*`, `/docs`, the dev
UI. Atlas is deployed `--allow-unauthenticated`, so before this existed every
one of those was reachable by anyone with curl. CORS never helped: it is a
browser courtesy, and curl ignores it.

`web=False` is not enough on its own, because it drops only the static dev UI
while `/run_sse` and the session APIs stay registered. So instead of trusting
ADK to register the right things, this middleware names the routes the site
actually calls and answers 404 to everything else, before routing runs.

It is plain ASGI rather than `BaseHTTPMiddleware` on purpose: the latter wraps
the response stream, and `/api/agent-chat` is SSE.

Local dev can open the full surface with `ATLAS_DEV_ROUTES=1`. Unset means
closed, so a deploy that forgets the variable is safe by default.
"""

from __future__ import annotations

import json
import os
from typing import Any

# Every (method, path) the public site, the keep-warm scheduler and Cloud Run
# may call. A new route in api.py must be added here, or prod will 404 it.
_API_PATHS = {
    "/api/agent-chat": "POST",
    "/api/agent-transcribe": "POST",
    "/api/agent-speak": "POST",
    "/api/agent-chat/warm": "GET",  # widget + portfolio-atlas-keepwarm job
    "/api/agent-live/warm": "POST",
    "/api/stream-probe": "GET",
    "/api/stream-probe/report": "POST",
}

# The site's own websockets. Everything else, including ADK's /run_live, is
# refused at the handshake.
ALLOWED_WEBSOCKETS: frozenset[str] = frozenset({
    "/api/agent-chat-ws",
    "/api/agent-live",
    "/api/stream-probe-ws",
})

ALLOWED_ROUTES: frozenset[tuple[str, str]] = frozenset(
    {(method, path) for path, method in _API_PATHS.items()}
    # CORS preflight from gauravlahoti.dev. CORSMiddleware answers it, but
    # only if the request gets that far.
    | {("OPTIONS", path) for path in _API_PATHS}
    | {("GET", "/healthz")}
)

_NOT_FOUND = json.dumps({"detail": "Not Found"}).encode()


def dev_routes_enabled() -> bool:
    """True only when ADK's developer routes are explicitly opted into."""
    return os.environ.get("ATLAS_DEV_ROUTES") == "1"


class RouteAllowlist:
    """ASGI middleware: pass allowlisted (method, path) pairs, 404 the rest."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return

        if scope["type"] == "websocket":
            if scope["path"] in ALLOWED_WEBSOCKETS:
                await self.app(scope, receive, send)
                return
            # Closing before accept makes the server answer the handshake 403.
            await send({"type": "websocket.close", "code": 1008})
            return

        if (scope["method"], scope["path"]) in ALLOWED_ROUTES:
            await self.app(scope, receive, send)
            return

        await send({
            "type": "http.response.start",
            "status": 404,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(_NOT_FOUND)).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": _NOT_FOUND})
