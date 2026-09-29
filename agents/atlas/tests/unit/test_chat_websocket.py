"""/api/agent-chat-ws: the chat turn over a WebSocket.

Exists because a Netskope-managed laptop received the SSE stream in one
burst at the end while WebSocket frames came through live. The route must
answer exactly like the SSE route (it shares `_open_chat_turn`), reject
other origins itself (CORS doesn't cover WebSockets), and stop the turn
when the visitor aborts or leaves. The agent is faked: no model calls.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import api
from app.rate_limit import limiter

ORIGIN = "https://gauravlahoti.dev"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ALLOW_ORIGINS", ORIGIN)
    closed: list[bool] = []

    async def fake_stream_agent(session_id, user_text, **kwargs):
        try:
            yield f"data: {json.dumps({'delta': 'Hello '})}\n\n"
            yield f"data: {json.dumps({'delta': user_text})}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        finally:
            closed.append(True)

    monkeypatch.setattr(api, "_stream_agent", fake_stream_agent)
    monkeypatch.setattr(limiter, "check_and_record", lambda *a, **k: (True, None))
    app = FastAPI()
    api.register_routes(app)
    c = TestClient(app)
    c.closed = closed
    return c


def _turn(text: str = "hi", sid: str = "ws-sess-1") -> dict:
    return {"sessionId": sid, "messages": [{"role": "user", "content": text}]}


def test_same_events_as_the_sse_route(client) -> None:
    with client.websocket_connect("/api/agent-chat-ws", headers={"origin": ORIGIN}) as ws:
        ws.send_json(_turn("there"))
        frames = [ws.receive_json() for _ in range(3)]
    sse = client.post("/api/agent-chat", json=_turn("there", "sse-sess-1")).text
    sse_events = [json.loads(f[6:]) for f in sse.split("\n\n") if f.startswith("data: ")]
    assert frames == sse_events == [{"delta": "Hello "}, {"delta": "there"}, {"done": True}]


def test_other_origins_are_refused(client) -> None:
    with pytest.raises(WebSocketDisconnect) as err:
        with client.websocket_connect("/api/agent-chat-ws", headers={"origin": "https://evil.example"}) as ws:
            ws.receive_json()
    assert err.value.code == 1008


def test_a_bad_request_comes_back_as_its_http_status(client) -> None:
    with client.websocket_connect("/api/agent-chat-ws", headers={"origin": ORIGIN}) as ws:
        ws.send_json({"sessionId": "ws-sess-2", "messages": []})
        assert ws.receive_json() == {"httpStatus": 400, "error": "Missing messages."}


def test_the_turn_is_closed_when_it_ends(client) -> None:
    with client.websocket_connect("/api/agent-chat-ws", headers={"origin": ORIGIN}) as ws:
        ws.send_json(_turn())
        for _ in range(3):
            ws.receive_json()
    assert client.closed == [True]
