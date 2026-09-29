"""Hands-free avatar conversation (spec 71): the state machine and the route.

The conversation is where the avatar is least supervised: it listens
continuously, takes turns by itself and can be interrupted. What must hold:
the visitor sees an honest state (listening, thinking, speaking), every turn
is recorded once with its real outcome, and the route enforces the same
origin, limits and budget as a typed question. No network: the Live session
is faked.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import ClassVar

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import api, live_brain
from app.app_utils import avatar_speak
from app.rate_limit import limiter


def _msg(heard=None, said=None, interrupted=False, complete=False, tool=None):
    sc = SimpleNamespace(
        input_transcription=SimpleNamespace(text=heard) if heard else None,
        output_transcription=SimpleNamespace(text=said) if said else None,
        model_turn=None, interrupted=interrupted, turn_complete=complete,
    )
    return SimpleNamespace(tool_call=tool, server_content=sc)


class FakeSession:
    def __init__(self, script):
        self.script = list(script)
        self.audio: list[bytes] = []

    async def receive(self):
        while self.script:
            item = self.script.pop(0)
            if item == "pause":
                await asyncio.sleep(0.5)
                continue
            yield item
        await asyncio.sleep(3600)

    async def send_realtime_input(self, audio=None, audio_stream_end=None):
        if audio is not None:
            self.audio.append(audio.data)

    async def send_tool_response(self, function_responses=None):
        self.tool_responses = function_responses


async def _run_convo(script, seconds=1.5):
    convo = live_brain.LiveConversation(live_brain.ToolDispatcher("c1"))
    convo._session = FakeSession(script)
    convo._tasks = [asyncio.ensure_future(convo._read()), asyncio.ensure_future(convo._tick())]
    out = []

    async def collect():
        async for kind, value in convo.events():
            out.append((kind, value))

    task = asyncio.ensure_future(collect())
    await asyncio.sleep(seconds)
    task.cancel()
    for t in convo._tasks:
        t.cancel()
    return out


class TestConversationStates:
    @pytest.mark.asyncio
    async def test_a_spoken_turn_goes_listening_thinking_speaking_listening(self) -> None:
        out = await _run_convo([
            _msg(heard="Which AWS certs"), _msg(heard=" does he hold?"), "pause",
            _msg(said="He holds three."), _msg(complete=True),
        ])
        states = [v for k, v in out if k == "state"]
        assert states == ["thinking", "speaking", "listening"]
        turn = next(v for k, v in out if k == "turn_end")
        assert turn["question"] == "Which AWS certs does he hold?"
        assert turn["answer"] == "He holds three."
        assert turn["status"] == "ok"
        assert [v for k, v in out if k == "user_words"] == ["Which AWS certs", " does he hold?"]

    @pytest.mark.asyncio
    async def test_talking_over_the_avatar_ends_its_turn_as_interrupted(self) -> None:
        out = await _run_convo([
            _msg(heard="Where does he work?"), _msg(said="He works at"),
            _msg(interrupted=True), _msg(heard="Actually, his certs?"),
        ])
        kinds = [k for k, _ in out]
        assert "interrupted" in kinds
        turn = next(v for k, v in out if k == "turn_end")
        assert turn["status"] == "interrupted" and turn["answer"] == "He works at"
        # the next question starts a fresh turn
        assert [v for k, v in out if k == "user_words"][-1] == "Actually, his certs?"

    @pytest.mark.asyncio
    async def test_idle_conversation_ends(self, monkeypatch) -> None:
        monkeypatch.setattr(live_brain, "CONVO_IDLE_S", 0.3)
        out = await _run_convo([], seconds=1.0)
        assert ("end", "idle") in out


# --- the route ------------------------------------------------------------------

ORIGIN = "https://gauravlahoti.dev"


class FakeConvo:
    instances: ClassVar[list[FakeConvo]] = []

    def __init__(self, dispatcher) -> None:
        self.dispatcher = dispatcher
        self.clock = SimpleNamespace(edge=1.0)
        self.audio: list[bytes] = []
        self.texts: list[str] = []
        self.history = None
        self.closed = False
        self.go = asyncio.Event()
        FakeConvo.instances.append(self)

    async def open(self) -> None:
        pass

    async def seed(self, history) -> None:
        self.history = history

    async def send_audio(self, pcm) -> None:
        self.audio.append(pcm)
        self.go.set()

    async def send_text(self, text) -> None:
        self.texts.append(text)
        self.go.set()

    async def mute(self) -> None:
        pass

    async def events(self):
        yield ("video", b"face")
        await self.go.wait()
        yield ("user_words", "Hi")
        yield ("state", "speaking")
        yield ("words", "Hello there.")
        yield ("turn_end", {"question": "Hi", "answer": "Hello there.", "tools": [], "calls": [],
                            "first_word_ms": 900, "spoken_seconds": 2.0, "status": "ok"})
        yield ("end", "idle")

    async def close(self) -> None:
        self.closed = True


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("ALLOW_ORIGINS", ORIGIN)
    monkeypatch.setenv("ATLAS_LIVE_CONVO", "1")
    FakeConvo.instances = []
    monkeypatch.setattr(live_brain, "LiveConversation", FakeConvo)
    monkeypatch.setattr(avatar_speak, "budget", avatar_speak.AvatarBudget(daily_seconds=600))
    monkeypatch.setattr(limiter, "check_and_record", lambda *a, **k: (True, None))
    logged = []

    async def fake_log(geo_task, payload):
        logged.append(payload)

    monkeypatch.setattr(api, "_log_turn", fake_log)
    app = FastAPI()
    api.register_routes(app)
    c = TestClient(app)
    c.logged = logged
    return c


def _start(sid="convo-sess-1"):
    return {"start": {"sessionId": sid}}


def test_route_is_off_unless_switched_on(client, monkeypatch) -> None:
    monkeypatch.setenv("ATLAS_LIVE_CONVO", "0")
    with pytest.raises(WebSocketDisconnect) as err:
        with client.websocket_connect("/api/agent-live", headers={"origin": ORIGIN}) as ws:
            ws.receive_json()
    assert err.value.code == 1008


def test_other_origins_are_refused(client) -> None:
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/agent-live", headers={"origin": "https://evil.example"}) as ws:
            ws.receive_json()


def test_a_conversation_streams_the_face_the_words_and_the_turn(client) -> None:
    with client.websocket_connect("/api/agent-live", headers={"origin": ORIGIN}) as ws:
        ws.send_json(_start())
        assert ws.receive_json() == {"state": "listening"}
        assert ws.receive_bytes() == b"face"
        ws.send_bytes(b"\x00\x01" * 640)  # 80 ms of mic audio
        got = [ws.receive_json() for _ in range(5)]
    assert got[0] == {"userWords": "Hi"}
    assert got[1] == {"state": "speaking"}
    assert got[2]["words"]["text"] == "Hello there."
    assert got[3]["turnEnd"]["answer"] == "Hello there."
    assert got[4]["end"]["capped"] is False
    convo = FakeConvo.instances[0]
    assert convo.audio == [b"\x00\x01" * 640] and convo.closed
    assert client.logged[0]["question"] == "Hi" and client.logged[0]["model"] == avatar_speak.AVATAR_MODEL


def test_oversized_audio_frames_are_dropped(client) -> None:
    with client.websocket_connect("/api/agent-live", headers={"origin": ORIGIN}) as ws:
        ws.send_json(_start("convo-sess-2"))
        ws.receive_json()
        ws.receive_bytes()
        ws.send_bytes(bytes(10_000))  # far more than 100 ms
        ws.send_json({"text": "Hi"})
        ws.receive_json()
    assert FakeConvo.instances[0].audio == []
    assert FakeConvo.instances[0].texts == ["Hi"]


def test_the_turn_joins_the_shared_chat(client) -> None:
    with client.websocket_connect("/api/agent-live", headers={"origin": ORIGIN}) as ws:
        ws.send_json(_start("convo-sess-3"))
        ws.receive_json()
        ws.receive_bytes()
        ws.send_json({"text": "Hi"})
        for _ in range(5):
            ws.receive_json()

    async def history():
        return await api._chat_history("convo-sess-3")

    turns = asyncio.run(history())
    assert [(c.role, c.parts[0].text) for c in turns] == [("user", "Hi"), ("model", "Hello there.")]


def test_a_malformed_start_is_answered_and_closed(client) -> None:
    with client.websocket_connect("/api/agent-live", headers={"origin": ORIGIN}) as ws:
        ws.send_json({"hello": 1})
        assert ws.receive_json() == {"end": {"reason": "bad request", "capped": False}}


def _limiter_spent(monkeypatch, spent: str) -> list[str]:
    """Every bucket open except `spent`; returns the buckets charged."""
    charged: list[str] = []

    def check(session_id, ip_hash, bucket="chat"):
        charged.append(bucket)
        return (bucket != spent, None)

    monkeypatch.setattr(limiter, "check_and_record", check)
    return charged


def test_a_spent_chat_budget_doesnt_stop_a_conversation(client, monkeypatch) -> None:
    # Spec 72: a conversation spends only the avatar's budget, so the 10
    # chat questions stay for Voice mode and never gate the avatar.
    charged = _limiter_spent(monkeypatch, "chat")
    with client.websocket_connect("/api/agent-live", headers={"origin": ORIGIN}) as ws:
        ws.send_json(_start("convo-sess-5"))
        assert ws.receive_json() == {"state": "listening"}
    assert "chat" not in charged and "avatar" in charged


def test_a_spent_avatar_budget_refuses_with_its_kind(client, monkeypatch) -> None:
    _limiter_spent(monkeypatch, "avatar")
    with client.websocket_connect("/api/agent-live", headers={"origin": ORIGIN}) as ws:
        ws.send_json(_start("convo-sess-6"))
        end = ws.receive_json()["end"]
    assert end == {"reason": api.AVATAR_VISITOR_CAP_REPLY, "capped": True, "kind": "avatar"}
    assert FakeConvo.instances == []


def test_a_spent_site_budget_refuses_as_site(client, monkeypatch) -> None:
    monkeypatch.setattr(avatar_speak, "budget", avatar_speak.AvatarBudget(daily_seconds=0))
    with client.websocket_connect("/api/agent-live", headers={"origin": ORIGIN}) as ws:
        ws.send_json(_start("convo-sess-7"))
        end = ws.receive_json()["end"]
    assert end["kind"] == "site" and end["capped"] is True


class TestFillerBeforeTools:
    @pytest.mark.asyncio
    async def test_filler_and_answer_after_a_tool_are_one_reply(self, monkeypatch) -> None:
        async def get_work_history(role_filter=None):
            return [{"company": "EY"}]
        monkeypatch.setattr(live_brain, "READ_TOOLS", [get_work_history])
        call = SimpleNamespace(function_calls=[SimpleNamespace(id="t1", name="get_work_history", args={})])
        out = await _run_convo([
            _msg(heard="Tell me about EY."),
            _msg(said="Let me look into that."), _msg(tool=call), _msg(complete=True),
            "pause",
            _msg(said="He was a Consultant at EY."), _msg(complete=True),
        ], seconds=1.5)
        turns = [v for k, v in out if k == "turn_end"]
        assert len(turns) == 1
        assert turns[0]["answer"] == "Let me look into that. He was a Consultant at EY."
        assert turns[0]["question"] == "Tell me about EY."


class TestToolEvents:
    """Spec 73: the widget shows each tool call as a hex, from names alone."""

    @pytest.mark.asyncio
    async def test_a_tool_call_is_announced_by_name(self) -> None:
        call = SimpleNamespace(function_calls=[SimpleNamespace(id="t1", name="get_projects", args={"domain": "ai"})])
        out = await _run_convo([_msg(heard="What has he built?"), _msg(tool=call)], seconds=0.3)
        assert ("tool", ["get_projects"]) in out

    @pytest.mark.asyncio
    async def test_arguments_and_unknown_names_never_reach_the_page(self) -> None:
        call = SimpleNamespace(function_calls=[
            SimpleNamespace(id="t1", name="send_resume", args={"email": "visitor@example.com"}),
            SimpleNamespace(id="t2", name="made_up_tool", args={}),
        ])
        out = await _run_convo([_msg(tool=call)], seconds=0.3)
        tools = [v for k, v in out if k == "tool"]
        assert tools == [["send_resume"]]
        assert "visitor@example.com" not in repr(tools)
