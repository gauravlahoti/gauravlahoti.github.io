"""Unit tests for the fail-closed route allowlist in app/route_allowlist.py.

Covers: ADK's developer routes 404ing, Pulse's own routes passing through,
websockets being refused, the opt-in env flag, and every route api.py
registers being on the allowlist (so a new route can't ship without it and
silently 404 in prod).

Run with: uv run pytest tests/unit/test_route_allowlist.py -v
"""

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.routing import APIRoute, APIWebSocketRoute
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.route_allowlist import ALLOWED_ROUTES, RouteAllowlist, dev_routes_enabled


def _build_app() -> FastAPI:
    """A stand-in for the composed app: our routes plus ADK-shaped ones."""
    app = FastAPI()

    for method, path in ALLOWED_ROUTES:
        app.add_api_route(path, lambda: {"ok": True}, methods=[method])

    # A sample of what get_fast_api_app() registers.
    for path in ("/run", "/run_sse", "/builder/save", "/feedback"):
        app.add_api_route(path, lambda: {"leak": True}, methods=["POST"])
    for path in ("/list-apps", "/dev-ui/", "/apps/app/users/u/sessions"):
        app.add_api_route(path, lambda: {"leak": True}, methods=["GET"])

    async def run_live(ws: WebSocket) -> None:
        await ws.accept()

    app.add_api_websocket_route("/run_live", run_live)
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
        ("GET", "/api/ambient/run"),
        ("POST", "/healthz"),
        # Near-misses on an allowed path.
        ("POST", "/api/ambient/run/"),
        ("POST", "/api/ambient/run-evil"),
    ],
)
def test_non_allowlisted_routes_404(client, method, path):
    resp = client.request(method, path)
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Not Found"}


@pytest.mark.parametrize(("method", "path"), sorted(ALLOWED_ROUTES))
def test_allowlisted_routes_pass_through(client, method, path):
    assert client.request(method, path).json() == {"ok": True}


def test_websocket_refused(client):
    with pytest.raises(WebSocketDisconnect), client.websocket_connect("/run_live"):
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
    assert not any(isinstance(r, APIWebSocketRoute) for r in app.routes), (
        "api.py added a websocket; the allowlist refuses every websocket"
    )


@pytest.mark.parametrize(("value", "expected"), [(None, False), ("", False), ("0", False), ("true", False), ("1", True)])
def test_dev_routes_flag_is_opt_in(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("PULSE_DEV_ROUTES", raising=False)
    else:
        monkeypatch.setenv("PULSE_DEV_ROUTES", value)
    assert dev_routes_enabled() is expected
