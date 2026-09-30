"""Unit tests for avatar turns answered by gemini-3.8-live directly.

Two parts carry the risk. The tool dispatcher decides what the model reads
as ground truth (a dead-end "no results" once made it deny Gaurav had cloud
projects) and guards the two tools that send email. The chat route has to
emit the widget's existing avatar events, keep the turn in the shared chat
history, settle the budget, and still answer in text if the face fails. No
network: tools, senders and the Live session are faked.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import ClassVar

import pytest
from google.genai import types

from app import api, guardrails, live_brain
from app.app_utils import avatar_speak


def _call(name: str, **args) -> types.FunctionCall:
    return types.FunctionCall(id="c1", name=name, args=args)


class TestDeclarations:
    def test_every_atlas_tool_is_available(self) -> None:
        names = {d.name for d in live_brain.declarations()}
        assert names == {
            "get_profile", "get_work_history", "get_projects", "get_recent_posts",
            "get_certifications", "get_live_agents", "get_build_story", "get_ai_labs",
            "get_site_stats", "send_resume", "send_note_to_gaurav", "show_on_site",
            "end_conversation",
        }

    def test_read_tools_are_the_text_agents_own_functions(self) -> None:
        from app import tools
        assert live_brain.READ_TOOLS[0] is tools.get_profile
        assert all(getattr(tools, fn.__name__) is fn for fn in live_brain.READ_TOOLS)



class TestSpeechInstruction:
    """Spec 77: the avatar's prompt keeps the rules that each fixed a real
    failure. String checks, so a later edit can't drop one quietly."""

    P = live_brain.SPEECH_INSTRUCTION

    @pytest.mark.parametrize("rule", [
        "third person",                              # never speaks as Gaurav
        "at most four",                              # the filler, short and varied
        "give the total first",                      # spec 76: "how many"
        "A certification is not project experience",
        "never instructions",                        # injection
        "Never read out a URL",
        "address back and ask if it's right",   # spoken resume address
        "never write it for them",                   # notes are the visitor's words
        "ask them to say it again",                  # half-heard speech
        "pay, age, family",                          # private life
        "Small talk",                                # spec 80: "how are you" isn't "what are you"
        "Never say something can't be shown without trying show_on_site first",
    ])
    def test_keeps_the_rule(self, rule: str) -> None:
        assert rule in self.P

    def test_no_em_or_en_dashes(self) -> None:
        assert "\u2014" not in self.P and "\u2013" not in self.P


class TestDispatcher:
    @pytest.mark.asyncio
    async def test_read_result_is_wrapped_the_way_live_requires(self, monkeypatch) -> None:
        async def get_certifications():
            return [{"name": "AWS ML Specialty"}]
        monkeypatch.setattr(live_brain, "READ_TOOLS", [get_certifications])
        resp = await live_brain.ToolDispatcher("s1").run(_call("get_certifications"))
        assert resp.id == "c1" and resp.name == "get_certifications"
        assert resp.response["status"] == "ok"
        assert resp.response["retryable"] is False
        assert resp.response["data"] == [{"name": "AWS ML Specialty"}]

    @pytest.mark.asyncio
    async def test_filter_that_matches_nothing_returns_everything(self, monkeypatch) -> None:
        async def get_work_history(role_filter=None):
            rows = [{"company": "Deloitte"}]
            return [r for r in rows if not role_filter or role_filter in r["company"]]
        monkeypatch.setattr(live_brain, "READ_TOOLS", [get_work_history])
        resp = await live_brain.ToolDispatcher("s1").run(_call("get_work_history", role_filter="Oracle"))
        assert resp.response["status"] == "ok"
        assert resp.response["data"] == [{"company": "Deloitte"}]
        assert "Oracle" in resp.response["message"]

    @pytest.mark.asyncio
    async def test_a_failing_tool_is_reported_not_raised(self, monkeypatch) -> None:
        async def get_profile():
            raise RuntimeError("corpus down")
        monkeypatch.setattr(live_brain, "READ_TOOLS", [get_profile])
        resp = await live_brain.ToolDispatcher("s1").run(_call("get_profile"))
        assert resp.response["status"] == "error"

    @pytest.mark.asyncio
    async def test_resume_goes_to_the_real_sender_with_the_session(self) -> None:
        sent = []

        async def fake_resume(email, *, session_id=None):
            sent.append((email, session_id))
            return {"ok": True, "code": "ok", "message": "Sent."}

        d = live_brain.ToolDispatcher("sess-9", send_resume_fn=fake_resume)
        # Spec 81: unconfirmed never sends; confirmed=true, matching what was
        # presented, does.
        unconfirmed = await d.run(_call("send_resume", email="jane@example.com"))
        assert sent == [] and unconfirmed.response["status"] == "needs_confirmation"
        resp = await d.run(_call("send_resume", email="jane@example.com", confirmed=True))
        assert sent == [("jane@example.com", "sess-9")]
        assert resp.response["status"] == "ok"
        assert d.calls == [
            {"name": "send_resume", "args": {"email": "jane@example.com"}},
            {"name": "send_resume", "args": {"email": "jane@example.com", "confirmed": True}},
        ]

    @pytest.mark.asyncio
    async def test_note_with_code_is_blocked_before_sending(self) -> None:
        sent = []

        async def fake_note(*args, **kwargs):
            sent.append(args)
            return {"ok": True, "code": "ok", "message": "Sent."}

        d = live_brain.ToolDispatcher("s1", send_note_fn=fake_note)
        resp = await d.run(_call("send_note_to_gaurav", visitor_email="a@b.com",
                                 message="def add(a, b):\n    return a + b\n"))
        assert sent == []
        assert resp.response["status"] == guardrails.GUARDRAIL_BLOCK_CODE


class FakeTurn:
    """Speaks two caption chunks around two video frames."""

    fail_open = False
    instances: ClassVar[list[FakeTurn]] = []

    def __init__(self, dispatcher) -> None:
        self.dispatcher = dispatcher
        self.clock = SimpleNamespace(edge=2.0)
        self.asked: list[tuple[str, int]] = []
        self.closed = False
        self.transcript: list[str] = []
        FakeTurn.instances.append(self)

    alive = True
    warmed = False

    async def open(self) -> None:
        if FakeTurn.fail_open:
            raise RuntimeError("quota")
        self.opened = True

    def attach(self, dispatcher) -> None:
        self.dispatcher = dispatcher

    async def ask(self, question, history=None) -> None:
        self.asked.append((question, len(history or [])))

    async def events(self):
        yield ("video", b"idle")
        for chunk in ("He holds three ", "AWS certifications."):
            self.transcript.append(chunk)
            yield ("words", chunk)
        yield ("video", b"talk")

    text = property(lambda self: "".join(self.transcript))
    first_word_ms = 1200
    spoken_seconds = property(lambda self: 3.0 if self.transcript else 0.0)

    async def close(self) -> None:
        self.closed = True


@pytest.fixture
def fake_turn(monkeypatch: pytest.MonkeyPatch):
    FakeTurn.fail_open = False
    FakeTurn.instances = []
    monkeypatch.setattr(live_brain, "LiveBrainTurn", FakeTurn)
    monkeypatch.setattr(live_brain, "warm_pool", live_brain.WarmPool())
    budget = avatar_speak.AvatarBudget(daily_seconds=600)
    monkeypatch.setattr(avatar_speak, "budget", budget)
    logged = []

    async def fake_log(geo_task, payload):
        logged.append(payload)

    monkeypatch.setattr(api, "_log_turn", fake_log)
    yield SimpleNamespace(budget=budget, logged=logged)


async def _fallback():
    yield f"data: {json.dumps({'delta': 'text answer'})}\n\n"
    yield f"data: {json.dumps({'done': True})}\n\n"


async def _run(session_id: str, question: str) -> list[dict]:
    await api._ensure_session(session_id)
    stream = api._live_avatar_stream(
        session_id, question, turn_index=0, identity=None, client_meta={},
        geo_task=None, fallback=_fallback(),
    )
    out = [json.loads(c[6:]) async for c in stream]
    await asyncio.sleep(0)  # let the audit-log task run
    return out


class TestLiveAvatarStream:
    @pytest.mark.asyncio
    async def test_emits_the_widgets_existing_avatar_events(self, fake_turn) -> None:
        events = await _run("live-a", "Which AWS certifications does he hold?")
        keys = [next(iter(e)) for e in events]
        assert keys == ["avatarVideo", "avatarWords", "delta", "avatarWords", "delta",
                        "avatarVideo", "avatarEnd", "done"]
        assert events[1]["avatarWords"] == {"text": "He holds three ", "at": 3.5}
        assert FakeTurn.instances[0].closed

    @pytest.mark.asyncio
    async def test_turn_joins_the_shared_chat_history(self, fake_turn) -> None:
        await _run("live-b", "Which AWS certifications does he hold?")
        history = await api._chat_history("live-b")
        assert [(c.role, c.parts[0].text) for c in history] == [
            ("user", "Which AWS certifications does he hold?"),
            ("model", "He holds three AWS certifications."),
        ]
        # The next avatar question is asked with that history.
        await _run("live-b", "And Google Cloud?")
        assert FakeTurn.instances[-1].asked == [("And Google Cloud?", 2)]

    @pytest.mark.asyncio
    async def test_budget_settles_to_spoken_time_and_turn_is_logged(self, fake_turn) -> None:
        fake_turn.budget.reserve(avatar_speak.RESERVE_SECONDS)
        await _run("live-c", "Hi")
        assert fake_turn.budget.used_seconds == pytest.approx(3.0)
        assert fake_turn.logged[0]["model"] == avatar_speak.AVATAR_MODEL
        assert fake_turn.logged[0]["response"] == "He holds three AWS certifications."

    @pytest.mark.asyncio
    async def test_open_failure_answers_in_text_instead(self, fake_turn) -> None:
        FakeTurn.fail_open = True
        events = await _run("live-d", "Hi")
        assert events == [
            {"avatarUnavailable": {"reason": "Avatar is unavailable right now."}},
            {"delta": "text answer"},
            {"done": True},
        ]


class TestChatHistory:
    @pytest.mark.asyncio
    async def test_meta_blocks_and_notes_are_stripped(self) -> None:
        await api._ensure_session("hist-1")
        await api._remember_live_turn("hist-1", "Q?", "Answer. [[META]]{\"cta\":null}[[/META]]")
        history = await api._chat_history("hist-1")
        assert history[-1].parts[0].text == "Answer."


class TestWarmHandover:
    @pytest.mark.asyncio
    async def test_a_warmed_session_is_used_without_opening_again(self, fake_turn) -> None:
        warm = FakeTurn(live_brain.ToolDispatcher("live-w"))
        live_brain.warm_pool._pool["live-w"] = warm
        events = await _run("live-w", "Hi")
        assert events[-1] == {"done": True}
        assert warm.asked == [("Hi", 0)]
        assert not getattr(warm, "opened", False)
        assert len(live_brain.warm_pool) == 0  # claimed, not reusable

    @pytest.mark.asyncio
    async def test_a_dead_warm_session_is_replaced_by_a_fresh_one(self, fake_turn) -> None:
        dead = FakeTurn(live_brain.ToolDispatcher("live-x"))
        dead.alive = False
        live_brain.warm_pool._pool["live-x"] = dead
        await _run("live-x", "Hi")
        assert dead.asked == []
        assert FakeTurn.instances[-1].asked == [("Hi", 0)]


# --- StreamTrimmer, on a small hand-built fMP4 ------------------------------

def _box(typ: bytes, payload: bytes) -> bytes:
    return (8 + len(payload)).to_bytes(4, "big") + typ + payload


def _full(typ: bytes, payload: bytes) -> bytes:
    return _box(typ, b"\x00\x00\x00\x00" + payload)


def _trak(tid: int, handler: bytes) -> bytes:
    tkhd = _full(b"tkhd", bytes(8) + tid.to_bytes(4, "big") + bytes(4))
    hdlr = _full(b"hdlr", bytes(4) + handler + bytes(12))
    return _box(b"trak", tkhd + _box(b"mdia", hdlr))


def _init() -> bytes:
    mvex = _box(b"mvex", _full(b"trex", (1).to_bytes(4, "big") + bytes(16)))
    return _box(b"ftyp", b"isom" + bytes(4)) + _box(b"moov", _trak(1, b"vide") + _trak(2, b"soun") + mvex)


def _frag(tid: int, key: bool, tag: bytes) -> bytes:
    tfhd = _box(b"tfhd", b"\x00\x00\x00\x00" + tid.to_bytes(4, "big"))
    flags = 0 if key else 0x10000
    trun = _box(b"trun", b"\x00\x00\x00\x04" + (1).to_bytes(4, "big") + flags.to_bytes(4, "big"))
    return _box(b"moof", _box(b"traf", tfhd + trun)) + _box(b"mdat", tag)


class TestStreamTrimmer:
    def test_hands_over_header_and_idle_since_the_last_keyframe(self) -> None:
        t = live_brain.StreamTrimmer()
        stream = _init() + _frag(1, True, b"k1") + _frag(2, True, b"a1") + _frag(1, False, b"v2") \
            + _frag(1, True, b"k2") + _frag(2, True, b"a2") + _frag(1, False, b"v3")
        assert t.feed(stream[:40]) == [] and t.feed(stream[40:]) == []  # nothing before the question
        held = b"".join(t.release())
        assert held.startswith(_init())
        assert b"k1" not in held and b"k2" in held and held.endswith(_frag(1, False, b"v3"))

    def test_passes_whole_boxes_through_after_the_question(self) -> None:
        t = live_brain.StreamTrimmer()
        t.feed(_init() + _frag(1, True, b"k1"))
        t.release()
        nxt = _frag(1, False, b"v2")
        assert t.feed(nxt[:10]) == []  # half a box waits for the rest
        assert b"".join(t.feed(nxt[10:])) == nxt

    def test_audio_before_any_keyframe_is_dropped(self) -> None:
        t = live_brain.StreamTrimmer()
        t.feed(_init() + _frag(2, True, b"a0") + _frag(1, False, b"v0") + _frag(1, True, b"k1"))
        held = b"".join(t.release())
        assert b"a0" not in held and b"v0" not in held and b"k1" in held



class TestTurnEndsAfterTheAnswer:
    """Spec 75: a single avatar turn ends after the answer, not at the
    turn_complete that closes the tool call, even when the filler's
    transcript trails in after the tool has answered."""

    class _Session:
        def __init__(self, script):
            self.script = list(script)

        async def receive(self):
            while self.script:
                item = self.script.pop(0)
                if item == "pause":
                    await asyncio.sleep(0.2)
                    continue
                yield item
            await asyncio.sleep(3600)

        async def send_tool_response(self, function_responses=None):
            pass

    @staticmethod
    def _msg(said=None, complete=False, tool=None):
        sc = SimpleNamespace(
            output_transcription=SimpleNamespace(text=said) if said else None,
            model_turn=None, turn_complete=complete,
        )
        return SimpleNamespace(tool_call=tool, server_content=sc)

    @pytest.mark.asyncio
    async def test_filler_then_tool_then_answer(self, monkeypatch) -> None:
        async def get_certifications():
            return [{"name": "AWS Certified AI Practitioner"}]
        monkeypatch.setattr(live_brain, "READ_TOOLS", [get_certifications])
        turn = live_brain.LiveBrainTurn(live_brain.ToolDispatcher("s-75"))
        call = SimpleNamespace(function_calls=[_call("get_certifications")])
        m = self._msg
        turn._session = self._Session([
            m(tool=call), "pause",
            m(said="Let me check."), m(complete=True), "pause",
            m(said="He holds an AWS AI cert."), m(complete=True),
        ])
        turn.asked_at = 0.0
        turn._reader = asyncio.ensure_future(turn._read())
        events = []
        while True:
            kind, value = await asyncio.wait_for(turn._out.get(), timeout=3)
            events.append((kind, value))
            if kind == "end":
                break
        turn._reader.cancel()
        assert [v for k, v in events if k == "words"] == ["Let me check.", "He holds an AWS AI cert."]



class TestCertCounts:
    """Spec 76: "how many certifications?" is answered from a stated total,
    not from the model counting a list, or the three tagged `cloud`."""

    @pytest.mark.asyncio
    async def test_the_result_states_the_total_and_the_split(self, monkeypatch) -> None:
        async def get_certifications():
            return [
                {"name": "A", "issuer": "Anthropic", "category": "ai"},
                {"name": "B", "issuer": "AWS", "category": "ai"},
                {"name": "C", "issuer": "Google Cloud", "category": "cloud"},
                {"name": "D", "issuer": "Google Cloud", "category": "security"},
            ]
        monkeypatch.setattr(live_brain, "READ_TOOLS", [get_certifications])
        resp = await live_brain.ToolDispatcher("s-76").run(_call("get_certifications"))
        msg = resp.response["message"]
        assert "4 certifications in total" in msg
        assert "1 from Anthropic, 1 from AWS, 2 from Google Cloud" in msg
        assert "not the vendor" in msg
        assert len(resp.response["data"]) == 4


class TestShowOnSite:
    """Spec 78: the avatar puts a page or section on screen by key. Only a
    known key reaches the page, and the widget owns what each key means."""

    @staticmethod
    def _dispatcher() -> tuple[live_brain.ToolDispatcher, list[str]]:
        d = live_brain.ToolDispatcher("s-78")
        shown: list[str] = []
        d.on_show = shown.append
        return d, shown

    @pytest.mark.asyncio
    async def test_a_known_target_is_shown(self) -> None:
        d, shown = self._dispatcher()
        resp = await d.run(_call("show_on_site", target="MCP-Lab"))
        assert shown == ["mcp-lab"]
        assert resp.response["status"] == "ok"
        assert "on the visitor's screen" in resp.response["message"]

    @pytest.mark.asyncio
    async def test_an_unknown_target_never_reaches_the_page(self) -> None:
        d, shown = self._dispatcher()
        for target in ("https://evil.example", "/admin", "__proto__", ""):
            resp = await d.run(_call("show_on_site", target=target))
            assert resp.response["status"] == "invalid_argument"
        assert shown == []

    @pytest.mark.asyncio
    async def test_the_off_site_lab_is_a_link_not_a_page(self) -> None:
        d, shown = self._dispatcher()
        resp = await d.run(_call("show_on_site", target="rag-lab"))
        assert resp.response["status"] == "off_site" and shown == []

    @pytest.mark.asyncio
    async def test_without_a_page_to_show_on_it_says_so(self) -> None:
        resp = await live_brain.ToolDispatcher("s-78").run(_call("show_on_site", target="labs"))
        assert resp.response["status"] == "unavailable"

    @pytest.mark.asyncio
    async def test_a_single_turn_relays_it_and_rebinds_on_attach(self) -> None:
        turn = live_brain.LiveBrainTurn(live_brain.ToolDispatcher("warm"))
        visitor = live_brain.ToolDispatcher("visitor")
        turn.attach(visitor)
        await visitor.run(_call("show_on_site", target="labs"))
        assert turn._out.get_nowait() == ("show", "labs")

    @pytest.mark.asyncio
    async def test_the_stream_sends_the_key_as_avatarShow(self, fake_turn, monkeypatch) -> None:
        async def events(self):
            yield ("show", "mcp-lab")
            yield ("words", "Here's the MCP lab.")
        monkeypatch.setattr(FakeTurn, "events", events)
        out = await _run("live-78", "Show me the MCP lab")
        assert {"avatarShow": "mcp-lab"} in out
        assert all(e.get("delta") != "mcp-lab" for e in out)

    def test_targets_match_the_widgets_map(self) -> None:
        import re
        from pathlib import Path
        js = (Path(__file__).resolve().parents[4] / "assets/js/site-stage.js").read_text()
        block = js[js.index("export const SITE_TARGETS"):js.index("};", js.index("export const SITE_TARGETS"))]
        keys = set(re.findall(r'^\s*"([a-z-]+)":', block, re.M))
        assert keys == set(live_brain.SHOW_TARGETS)

    def test_every_lab_on_the_site_can_be_shown_or_linked(self) -> None:
        from pathlib import Path
        concepts = json.loads((Path(__file__).resolve().parents[4] / "content/ai-concepts.json").read_text())["concepts"]
        for c in concepts:
            slug = c["href"].strip("/").split("/")[-1]
            assert slug in live_brain.SHOW_TARGETS or slug in live_brain.OFF_SITE, slug


class TestOpenAnything:
    """Spec 80: agents, their diagrams and the Loops layers open by name, from
    a catalog built from agents.json, and each opening says what's next."""

    AGENTS: ClassVar[list[dict]] = [
        {"id": "pulse", "name": "Pulse", "headline": "Ambient digest", "diagramSvg": "d/pulse.svg"},
        {"id": "error-lens", "name": "ErrorLens", "headline": "Triage", "diagramSvg": "d/el.svg"},
        {"id": "nodiag", "name": "No Diagram", "headline": "x"},
    ]

    @pytest.fixture(autouse=True)
    def _agents(self, monkeypatch) -> None:
        async def get_agents():
            return self.AGENTS
        monkeypatch.setattr(live_brain.corpus_live, "get_agents", get_agents)

    @pytest.mark.asyncio
    @pytest.mark.parametrize(("raw", "key"), [
        ("agent:pulse", "agent:pulse"),
        ("agent:Pulse", "agent:pulse"),
        ("agent:ErrorLens", "agent:error-lens"),
        ("agent:error lens:diagram", "agent:error-lens:diagram"),
        ("agent:pulse:diagram", "agent:pulse:diagram"),
        ("loops:harness", "loops:harness"),
        ("live-agents", "live-agents"),
    ])
    async def test_resolves(self, raw: str, key: str) -> None:
        found = await live_brain.resolve_show_target(raw)
        assert found is not None and found[0] == key

    @pytest.mark.asyncio
    @pytest.mark.parametrize("raw", [
        "agent:nope", "agent:../x", "agent:", "agent:pulse:source", "agent:nodiag:diagram",
        "loops:everything", "agent:https://evil.example",
    ])
    async def test_never_resolves(self, raw: str) -> None:
        assert await live_brain.resolve_show_target(raw) is None

    @pytest.mark.asyncio
    async def test_opening_the_agents_page_says_what_can_open_next(self) -> None:
        d = live_brain.ToolDispatcher("s-80")
        shown: list[str] = []
        d.on_show = shown.append
        resp = await d.run(_call("show_on_site", target="live-agents"))
        nxt = [o["target"] for o in resp.response["data"]["canOpenNext"]]
        assert "agent:pulse" in nxt and "agent:pulse:diagram" in nxt and "agent:nodiag:diagram" not in nxt
        assert "agent:" not in resp.response["message"]  # keys stay out of what's read aloud
        resp = await d.run(_call("show_on_site", target="agent:pulse"))
        assert [o["target"] for o in resp.response["data"]["canOpenNext"]] == ["agent:pulse:diagram"]
        assert shown == ["live-agents", "agent:pulse"]


class TestEmailConfirmation:
    """Spec 81: a spoken/transcribed email must be read back and explicitly
    confirmed before anything sends. This is a real gate, not just a prompt
    hope — it was skipped once in production and a resume went to a wrong
    address."""

    @pytest.mark.asyncio
    async def test_the_first_call_never_sends_even_with_confirmed_true(self) -> None:
        sent = []

        async def fake_resume(email, *, session_id=None):
            sent.append(email)
            return {"ok": True, "code": "ok", "message": "Sent."}

        d = live_brain.ToolDispatcher("s", send_resume_fn=fake_resume)
        # A model that hallucinates confirmed=true with nothing presented yet
        # must still be refused: there is no prior read-back to have confirmed.
        resp = await d.run(_call("send_resume", email="jane@example.com", confirmed=True))
        assert sent == [] and resp.response["status"] == "needs_confirmation"

    @pytest.mark.asyncio
    async def test_confirming_a_different_address_than_presented_never_sends(self) -> None:
        sent = []

        async def fake_resume(email, *, session_id=None):
            sent.append(email)
            return {"ok": True, "code": "ok", "message": "Sent."}

        d = live_brain.ToolDispatcher("s", send_resume_fn=fake_resume)
        await d.run(_call("send_resume", email="jane@example.com"))
        resp = await d.run(_call("send_resume", email="john@example.com", confirmed=True))
        assert sent == [] and resp.response["status"] == "needs_confirmation"

    @pytest.mark.asyncio
    async def test_confirming_the_same_address_sends_once(self) -> None:
        sent = []

        async def fake_resume(email, *, session_id=None):
            sent.append(email)
            return {"ok": True, "code": "ok", "message": "Sent."}

        d = live_brain.ToolDispatcher("s", send_resume_fn=fake_resume)
        await d.run(_call("send_resume", email="Jane@Example.com"))
        resp = await d.run(_call("send_resume", email="jane@example.com", confirmed=True))
        assert sent == ["jane@example.com"] and resp.response["status"] == "ok"

    @pytest.mark.asyncio
    async def test_a_repeated_call_without_confirmed_never_sends(self) -> None:
        """A model that just calls the tool again with the same address, but
        forgets confirmed=true, must not be treated as confirmation."""
        sent = []

        async def fake_resume(email, *, session_id=None):
            sent.append(email)
            return {"ok": True, "code": "ok", "message": "Sent."}

        d = live_brain.ToolDispatcher("s", send_resume_fn=fake_resume)
        await d.run(_call("send_resume", email="jane@example.com"))
        resp = await d.run(_call("send_resume", email="jane@example.com"))
        assert sent == [] and resp.response["status"] == "needs_confirmation"

    @pytest.mark.asyncio
    async def test_send_note_to_gaurav_needs_the_same_confirmation(self) -> None:
        sent = []

        async def fake_note(visitor_email, message, *, session_id=None):
            sent.append((visitor_email, message))
            return {"ok": True, "code": "ok", "message": "Sent."}

        d = live_brain.ToolDispatcher("s", send_note_fn=fake_note)
        await d.run(_call("send_note_to_gaurav", visitor_email="a@b.com", message="Loved the site!"))
        assert sent == []
        resp = await d.run(_call(
            "send_note_to_gaurav", visitor_email="a@b.com", message="Loved the site!", confirmed=True))
        assert sent == [("a@b.com", "Loved the site!")] and resp.response["status"] == "ok"

    @pytest.mark.asyncio
    async def test_confirmations_for_the_two_tools_are_independent(self) -> None:
        resume_sent, note_sent = [], []

        async def fake_resume(email, *, session_id=None):
            resume_sent.append(email)
            return {"ok": True, "code": "ok", "message": "Sent."}

        async def fake_note(visitor_email, message, *, session_id=None):
            note_sent.append(visitor_email)
            return {"ok": True, "code": "ok", "message": "Sent."}

        d = live_brain.ToolDispatcher("s", send_resume_fn=fake_resume, send_note_fn=fake_note)
        await d.run(_call("send_resume", email="jane@example.com"))
        # Confirming the NOTE tool must not be satisfied by the resume's pending entry.
        resp = await d.run(_call("send_note_to_gaurav", visitor_email="jane@example.com",
                                 message="Hi there", confirmed=True))
        assert note_sent == [] and resp.response["status"] == "needs_confirmation"
