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
        assert {"avatarWords": "Hello there."} in events

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

    def test_default_budget_is_about_five_dollars(self) -> None:
        dollars = avatar_speak.DAILY_BUDGET_SECONDS * avatar_speak.USD_PER_SPEAKING_SECOND
        assert 4.5 <= dollars <= 5.5
