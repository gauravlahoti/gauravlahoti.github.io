"""Fail-closed route allowlist for the public Pulse service (spec 86).

`get_fast_api_app()` publishes ADK's whole developer surface next to our own
routes: `/run` and `/run_sse` (the agent, which can read visitor analytics and
send email), `/builder/save`, session CRUD, eval runs, `/docs`, the dev UI.
Pulse is deployed `--allow-unauthenticated` so Cloud Scheduler can reach it,
which made every one of those reachable by anyone with curl. Our own routes
check `x-internal-token`; ADK's check nothing.

So this middleware names the routes Pulse's callers actually use and answers
404 to everything else, before routing runs. Same design as Atlas's
`app/route_allowlist.py` (spec 85). Pulse has no browser callers and no
websockets, so its list is shorter and every websocket is refused.

Local dev can open the full surface with `PULSE_DEV_ROUTES=1`. Unset means
closed, so a deploy that forgets the variable is safe by default.
"""

from __future__ import annotations

import json
import os
from typing import Any

# Every (method, path) Cloud Scheduler and Cloud Run may call. A new route in
# api.py must be added here, or prod will 404 it.
ALLOWED_ROUTES: frozenset[tuple[str, str]] = frozenset({
    ("POST", "/api/ambient/run"),      # portfolio-ambient-agent job
    ("POST", "/api/ambient/metrics"),  # portfolio-ambient-metrics job
    ("GET", "/healthz"),
})

_NOT_FOUND = json.dumps({"detail": "Not Found"}).encode()


def dev_routes_enabled() -> bool:
    """True only when ADK's developer routes are explicitly opted into."""
    return os.environ.get("PULSE_DEV_ROUTES") == "1"


class RouteAllowlist:
    """ASGI middleware: pass allowlisted (method, path) pairs, 404 the rest."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return

        if scope["type"] == "websocket":
            # ADK exposes /run_live over a websocket. Nothing calls Pulse over
            # one, so refuse the handshake (the server answers it 403).
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
