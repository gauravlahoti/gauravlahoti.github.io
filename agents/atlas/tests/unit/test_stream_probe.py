"""The network probes stream the server's own clock and nothing else.

They exist to tell, from a visitor's browser, whether a corporate
inspection proxy holds Atlas's streams back (seen on a Netskope-managed
laptop). What matters: bounded work per request, no model calls, and a
readable tick sequence over both SSE and WebSocket.
"""

from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import api


def _client() -> TestClient:
    app = FastAPI()
    api.register_routes(app)
    return TestClient(app)


def _events(text: str) -> list[dict]:
    return [json.loads(f[6:]) for f in text.split("\n\n") if f.startswith("data: ")]


def test_sse_probe_streams_ticks_then_done_and_allows_any_origin() -> None:
    r = _client().get("/api/stream-probe?interval_ms=100&ticks=3")
    assert r.headers["access-control-allow-origin"] == "*"
    events = _events(r.text)
    assert [e.get("tick") for e in events[:-1]] == [0, 1, 2]
    assert events[-1] == {"done": True}


def test_sse_probe_pads_with_a_comment_the_widget_parser_ignores() -> None:
    r = _client().get("/api/stream-probe?pad=64&interval_ms=100&ticks=1")
    assert r.text.startswith(":" + " " * 64 + "\n\n")
    assert _events(r.text)[0]["tick"] == 0


def test_sse_probe_limits_are_clamped() -> None:
    r = _client().get("/api/stream-probe?pad=999999&interval_ms=100&ticks=500")
    assert len(r.text.split("\n\n", 1)[0]) == 1 + 16384
    assert len(_events(r.text)) == 21  # 20 ticks + done


def test_websocket_probe_streams_ticks_then_done() -> None:
    with _client().websocket_connect("/api/stream-probe-ws?interval_ms=100&ticks=2") as ws:
        got = [ws.receive_json() for _ in range(3)]
    assert [g.get("tick") for g in got[:2]] == [0, 1]
    assert got[2] == {"done": True}
