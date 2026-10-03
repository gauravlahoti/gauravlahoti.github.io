"""Unit tests for the fail-closed route allowlist in app/route_allowlist.py.

Covers: ADK's developer routes 404ing, the site's own routes passing through,
CORS preflight still reaching CORSMiddleware, the site's websockets passing
and ADK's being refused, the opt-in env flag, and every route api.py registers
being on the allowlist (so a new route can't ship without it and silently 404
in prod).

Run with: uv run pytest tests/unit/test_route_allowlist.py -v
"""

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import APIRoute, APIWebSocketRoute
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.route_allowlist import (
    ALLOWED_ROUTES,
    ALLOWED_WEBSOCKETS,
    RouteAllowlist,
    dev_routes_enabled,
)

_ORIGIN = "https://gauravlahoti.dev"


def _build_app() -> FastAPI:
    """A stand-in for the composed app: our routes plus ADK-shaped ones."""
    app = FastAPI()
    app.add_middleware(CORSMiddleware, allow_origins=[_ORIGIN], allow_methods=["*"])

    for method, path in ALLOWED_ROUTES:
        if method != "OPTIONS":
            app.add_api_route(path, lambda: {"ok": True}, methods=[method])

    # A sample of what get_fast_api_app() registers.
    for path in ("/run", "/run_sse", "/builder/save", "/feedback"):
        app.add_api_route(path, lambda: {"leak": True}, methods=["POST"])
    for path in ("/list-apps", "/dev-ui/", "/docs-like", "/apps/app/users/u/sessions"):
        app.add_api_route(path, lambda: {"leak": True}, methods=["GET"])

    async def echo(ws: WebSocket) -> None:
        await ws.accept()
        await ws.send_text("ok")
        await ws.close()

    for path in ALLOWED_WEBSOCKETS:
        app.add_api_websocket_route(path, echo)
    # ADK's live endpoint.
    app.add_api_websocket_route("/run_live", echo)

    app.add_middleware(RouteAllowlist)
    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(_build_app())


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/run"),
        ("POST", "/run_sse"),
        ("POST", "/builder/save"),
        ("POST", "/feedback"),
        ("GET", "/list-apps"),
        ("GET", "/dev-ui/"),
        ("GET", "/docs"),
        ("GET", "/openapi.json"),
        ("GET", "/apps/app/users/u/sessions"),
        # Right path, wrong method.
        ("GET", "/api/agent-chat"),
        ("POST", "/healthz"),
        # Near-misses on an allowed path.
        ("POST", "/api/agent-chat/"),
        ("POST", "/api/agent-chat-evil"),
    ],
)
def test_non_allowlisted_routes_404(client, method, path):
    resp = client.request(method, path)
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Not Found"}


@pytest.mark.parametrize(("method", "path"), sorted(r for r in ALLOWED_ROUTES if r[0] != "OPTIONS"))
def test_allowlisted_routes_pass_through(client, method, path):
    assert client.request(method, path).json() == {"ok": True}


def test_cors_preflight_still_answered(client):
    resp = client.options(
        "/api/agent-chat",
        headers={"Origin": _ORIGIN, "Access-Control-Request-Method": "POST"},
    )
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == _ORIGIN


@pytest.mark.parametrize("path", sorted(ALLOWED_WEBSOCKETS))
def test_allowlisted_websockets_pass_through(client, path):
    with client.websocket_connect(path) as ws:
        assert ws.receive_text() == "ok"


@pytest.mark.parametrize("path", ["/run_live", "/api/agent-chat", "/api/agent-live-evil"])
def test_other_websockets_refused(client, path):
    with pytest.raises(WebSocketDisconnect), client.websocket_connect(path):
        pass


def test_every_api_route_is_allowlisted():
    """A route added to api.py but not to the allowlist would 404 in prod."""
    from app.api import register_routes

    app = FastAPI()
    register_routes(app)
    registered = {
        (method, route.path)
        for route in app.routes
        if isinstance(route, APIRoute)
        for method in route.methods - {"HEAD"}
    }
    assert registered, "register_routes registered nothing"
    assert registered <= ALLOWED_ROUTES, registered - ALLOWED_ROUTES

    sockets = {route.path for route in app.routes if isinstance(route, APIWebSocketRoute)}
    assert sockets <= ALLOWED_WEBSOCKETS, sockets - ALLOWED_WEBSOCKETS


@pytest.mark.parametrize(("value", "expected"), [(None, False), ("", False), ("0", False), ("true", False), ("1", True)])
def test_dev_routes_flag_is_opt_in(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("ATLAS_DEV_ROUTES", raising=False)
    else:
        monkeypatch.setenv("ATLAS_DEV_ROUTES", value)
    assert dev_routes_enabled() is expected
