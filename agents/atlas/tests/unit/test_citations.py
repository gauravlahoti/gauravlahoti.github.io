"""Spec 67: a combined citation marker ("[1, 2]") is split into single ones,
so the widget links each and speech never reads the numbers aloud."""

from __future__ import annotations

import pytest

from app import api
from app.app_utils.citations import CitationGuard, split_markers
from app.app_utils.speak import sanitize_for_speech

CASES = [
    ("platforms [1, 2]. Next", "platforms [1][2]. Next"),
    ("platforms [1,2,3].", "platforms [1][2][3]."),
    ("one [1] and two [2].", "one [1] and two [2]."),
    ("see [see below] and [[META]]{}[[/META]]", "see [see below] and [[META]]{}[[/META]]"),
    ("a list [1, 2 and more", "a list [1, 2 and more"),
]


@pytest.mark.parametrize("raw,want", CASES)
def test_split_markers(raw: str, want: str) -> None:
    assert split_markers(raw) == want


@pytest.mark.parametrize("raw,want", CASES)
def test_stream_matches_one_shot_for_every_split(raw: str, want: str) -> None:
    for i in range(len(raw) + 1):
        g = CitationGuard()
        assert g.push(raw[:i]) + g.push(raw[i:]) + g.flush() == want, f"split at {i}"


def test_output_filter_splits_markers_streamed_and_whole() -> None:
    f = api._OutputFilter(frozenset(), contact_intent=False)
    raw = "At Deloitte he led multi-agent AI platforms [1, 2]. Want details?"
    streamed = "".join(f.push(ch) for ch in raw) + f.flush()
    assert streamed == f.whole(raw) == "At Deloitte he led multi-agent AI platforms [1][2]. Want details?"


def test_speech_never_reads_a_combined_marker() -> None:
    assert "1" not in sanitize_for_speech("He led AI platforms [1, 2].")
