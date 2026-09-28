"""Unit tests for the avatar voice (spec 67).

The avatar speaks inside the chat turn's own SSE stream, so the parts worth
pinning down are the stream merge (nothing lost, nothing leaked, `done` held
until the avatar finishes, failures fall back cleanly) and the daily budget,
which would quietly overspend if it settled wrong. No network: the Live
session is faked.
"""

from __future__ import annotations

import asyncio
import base64
import json
import struct
from types import SimpleNamespace
from typing import ClassVar

import pytest

from app import api
from app.app_utils import avatar_speak


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


async def _text_stream(script: str | None = "Hello there."):
    yield _sse({"delta": "Hello "})
    yield _sse({"delta": "there."})
    if script is not None:
        yield _sse({api._AVATAR_SCRIPT_KEY: script})
    yield _sse({"done": True})


class FakeLive:
    """Idles with one frame, then speaks whatever script it was given."""

    fail_open = False
    instances: ClassVar[list[FakeLive]] = []

    def __init__(self) -> None:
        self.said: list[str] = []
        self.closed = False
        self._go = asyncio.Event()
        self.words_first_at = None
        self.last_media_at = None
        self.bytes = 0
        self.clock = SimpleNamespace(edge=2.0)
        FakeLive.instances.append(self)

    async def open(self) -> None:
        if FakeLive.fail_open:
            raise RuntimeError("quota")

    async def say(self, text: str) -> None:
        self.said.append(text)
        self._go.set()

    async def events(self):
        yield ("video", b"idle")
        await self._go.wait()
        yield ("words", "Hello there.")
        yield ("video", b"talk")

    @property
    def spoken_seconds(self) -> float:
        return 2.0 if self.said else 0.0

    async def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def fake_live(monkeypatch: pytest.MonkeyPatch):
    FakeLive.fail_open = False
    FakeLive.instances = []
    monkeypatch.setattr(avatar_speak, "LiveAvatar", FakeLive)
    monkeypatch.setattr(avatar_speak, "budget", avatar_speak.AvatarBudget(daily_seconds=600))
    yield


async def _collect(stream) -> list[dict]:
    return [json.loads(c[6:]) async for c in stream]


class TestWithAvatar:
    @pytest.mark.asyncio
    async def test_speaks_the_script_and_holds_done_until_it_finishes(self) -> None:
        events = await _collect(api._with_avatar(_text_stream()))
        keys = [next(iter(e)) for e in events]
        assert keys[-1] == "done"
        assert keys.index("avatarEnd") < keys.index("done")
        assert FakeLive.instances[0].said == ["Hello there."]
        videos = [base64.b64decode(e["avatarVideo"]) for e in events if "avatarVideo" in e]
        assert videos == [b"idle", b"talk"]
        # Each caption chunk carries when its last word is heard.
        assert {"avatarWords": {"text": "Hello there.", "at": 2.0 + avatar_speak.WORDS_LEAD_S}} in events

    @pytest.mark.asyncio
    async def test_internal_script_event_never_reaches_the_browser(self) -> None:
        events = await _collect(api._with_avatar(_text_stream()))
        assert not any(api._AVATAR_SCRIPT_KEY in e for e in events)
        assert [e["delta"] for e in events if "delta" in e] == ["Hello ", "there."]

    @pytest.mark.asyncio
    async def test_no_speakable_reply_ends_cleanly_without_speaking(self) -> None:
        events = await _collect(api._with_avatar(_text_stream(script=None)))
        assert FakeLive.instances[0].said == []
        assert events[-1] == {"done": True}
        assert FakeLive.instances[0].closed

    @pytest.mark.asyncio
    async def test_open_failure_falls_back_and_text_still_arrives(self) -> None:
        FakeLive.fail_open = True
        events = await _collect(api._with_avatar(_text_stream()))
        assert any("avatarUnavailable" in e for e in events)
        assert [e["delta"] for e in events if "delta" in e] == ["Hello ", "there."]
        assert events[-1] == {"done": True}

    @pytest.mark.asyncio
    async def test_budget_is_settled_to_actual_speaking_time(self) -> None:
        avatar_speak.budget.reserve(avatar_speak.RESERVE_SECONDS)  # what the route reserves
        await _collect(api._with_avatar(_text_stream()))
        assert avatar_speak.budget.used_seconds == pytest.approx(2.0)


class TestCappedAvatarStream:
    @pytest.mark.asyncio
    async def test_capped_turn_only_offers_voice_and_ends(self) -> None:
        # The widget re-asks the same question in Voice mode, so the capped
        # turn must carry no answer of its own.
        events = await _collect(api._capped_avatar_stream("You've reached today's avatar limit."))
        assert events == [
            {"avatarUnavailable": {"reason": "You've reached today's avatar limit.", "capped": True}},
            {"done": True},
        ]


def _box(typ: bytes, *payload: bytes) -> bytes:
    body = b"".join(payload)
    return struct.pack(">I4s", 8 + len(body), typ) + body


def _init_segment(track_id: int, timescale: int) -> bytes:
    tkhd = _box(b"tkhd", b"\0\0\0\7", b"\0" * 8, struct.pack(">I", track_id), b"\0" * 68)
    mdhd = _box(b"mdhd", b"\0" * 4, b"\0" * 8, struct.pack(">I", timescale), b"\0" * 8)
    trex = _box(b"trex", b"\0" * 4, struct.pack(">III", track_id, 1, 512), b"\0" * 8)
    return _box(b"ftyp", b"iso6") + _box(b"moov", _box(b"trak", tkhd, _box(b"mdia", mdhd)), _box(b"mvex", trex))


def _fragment(track_id: int, decode_time: int, samples: int, sample_dur: int | None = None) -> bytes:
    flags = 0x8 if sample_dur is not None else 0
    tfhd = _box(b"tfhd", struct.pack(">I", flags), struct.pack(">I", track_id),
                struct.pack(">I", sample_dur) if sample_dur is not None else b"")
    tfdt = _box(b"tfdt", b"\1\0\0\0", struct.pack(">Q", decode_time))
    trun = _box(b"trun", struct.pack(">I", 0), struct.pack(">I", samples))
    return _box(b"moof", _box(b"traf", tfhd, tfdt, trun)) + _box(b"mdat", b"\0" * 16)


class TestFragmentClock:
    def test_reads_decode_time_plus_sample_durations(self) -> None:
        clock = avatar_speak.FragmentClock()
        assert clock.feed(_init_segment(1, 12288)) == 0.0
        # 24 samples of 512 ticks at 12288/s = 1s, starting at 2s.
        assert clock.feed(_fragment(1, 2 * 12288, 24)) == pytest.approx(3.0)
        # A tfhd default duration overrides trex.
        assert clock.feed(_fragment(1, 3 * 12288, 10, sample_dur=1229)) == pytest.approx(3 + 10 * 1229 / 12288)

    def test_boxes_split_across_chunks_are_read_once_whole(self) -> None:
        clock = avatar_speak.FragmentClock()
        data = _init_segment(1, 12288) + _fragment(1, 0, 24)
        for i in range(0, len(data), 7):
            clock.feed(data[i:i + 7])
        assert clock.edge == pytest.approx(1.0)

    def test_garbage_never_moves_the_clock_back_or_raises(self) -> None:
        clock = avatar_speak.FragmentClock()
        clock.feed(_init_segment(1, 12288) + _fragment(1, 0, 48))
        clock.feed(b"\0\0\0\x10moofgarbage!")
        assert clock.edge == pytest.approx(2.0)


class TestClipToSentences:
    def test_short_text_is_untouched(self) -> None:
        assert avatar_speak.clip_to_sentences("One. Two.", limit=100) == "One. Two."

    def test_cuts_at_a_sentence_end(self) -> None:
        text = "First sentence here. Second sentence here. Third one runs long."
        assert avatar_speak.clip_to_sentences(text, limit=45) == "First sentence here. Second sentence here."

    def test_one_huge_sentence_falls_back_to_a_word_boundary(self) -> None:
        out = avatar_speak.clip_to_sentences("word " * 50, limit=23)
        assert len(out) <= 23
        assert not out.endswith(" ")


class TestBudget:
    def test_refuses_once_spent(self) -> None:
        budget = avatar_speak.AvatarBudget(daily_seconds=60)
        assert budget.reserve(40)
        assert not budget.reserve(30)

    def test_settle_returns_the_unused_reservation(self) -> None:
        budget = avatar_speak.AvatarBudget(daily_seconds=60)
        budget.reserve(40)
        budget.settle(40, 15)
        assert budget.used_seconds == pytest.approx(15)

    def test_failed_turn_costs_nothing(self) -> None:
        budget = avatar_speak.AvatarBudget(daily_seconds=60)
        budget.reserve(40)
        budget.settle(40, 0)
        assert budget.used_seconds == 0

    def test_default_budget_is_about_ten_dollars(self) -> None:
        # Doubled from ~$5/day on launch day (see avatar_speak.py's comment) —
        # this bound is a deliberate guardrail against a silent cost creep,
        # not a magic number, so update it alongside DAILY_BUDGET_SECONDS.
        dollars = avatar_speak.DAILY_BUDGET_SECONDS * avatar_speak.USD_PER_SPEAKING_SECOND
        assert 9.5 <= dollars <= 10.5


class TestScriptAligner:
    SCRIPT = "Gaurav is full-time at Deloitte, but he considers select consulting work."

    def test_restores_the_spaces_the_transcription_dropped(self) -> None:
        a = avatar_speak.ScriptAligner(self.SCRIPT)
        chunks = ["Gaurav is", "full-time", "at", "Deloitte,", "but he considers", "select", "consulting work."]
        assert "".join(a.feed(c) for c in chunks) == self.SCRIPT

    def test_keeps_the_scripts_own_casing_and_punctuation(self) -> None:
        a = avatar_speak.ScriptAligner(self.SCRIPT)
        assert a.feed("gaurav IS") == "Gaurav is"

    def test_unplaceable_chunk_passes_through_with_a_space(self) -> None:
        a = avatar_speak.ScriptAligner(self.SCRIPT)
        a.feed("Gaurav is")
        assert a.feed("umm") == " umm"

    def test_rest_completes_captions_the_transcription_skipped(self) -> None:
        a = avatar_speak.ScriptAligner(self.SCRIPT)
        a.feed("Gaurav is full-time")
        assert a.rest() == " at Deloitte, but he considers select consulting work."

    def test_whitespace_only_chunks_add_nothing(self) -> None:
        a = avatar_speak.ScriptAligner(self.SCRIPT)
        assert a.feed("   ") == ""

    def test_unspoken_lead_text_never_shreds_the_captions(self) -> None:
        # The reply opened with text the avatar skipped: every later chunk
        # still aligns, and nothing is glued together.
        script = "Availability question, calling get_profile.Gaurav is full-time at Deloitte."
        a = avatar_speak.ScriptAligner(script)
        out = "".join(a.feed(c) for c in ["Gaurav is", "full-time", "at", "Deloitte."])
        assert out == "Gaurav is full-time at Deloitte."
        assert a.rest() == ""

    def test_fallback_chunks_are_spaced(self) -> None:
        a = avatar_speak.ScriptAligner("Completely different words.")
        assert "".join(a.feed(c) for c in ["full-time", "at", "Deloitte"]) == "full-time at Deloitte"

    def test_rest_is_empty_when_nothing_ever_matched(self) -> None:
        a = avatar_speak.ScriptAligner("Some script.")
        a.feed("unrelated")
        assert a.rest() == ""

    def test_paragraph_break_matches_and_is_kept(self) -> None:
        script = "Depending on scope and timing.\n\nIf you have a project, drop a note."
        a = avatar_speak.ScriptAligner(script)
        out = "".join(a.feed(c) for c in ["Depending on scope", "and timing. If you", "have a project,", "drop a note."])
        assert out == script

    def test_a_passed_through_chunk_is_never_repeated(self) -> None:
        script = "One two three four five six."
        a = avatar_speak.ScriptAligner(script)
        out = "".join(a.feed(c) for c in ["One two", "thre four", "five six."])
        assert out.count("four") == 1
        assert out.endswith("five six.")
