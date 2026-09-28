"""Unit tests for the no-dashes guarantee (spec 67): nothing Atlas writes may
carry an em or en dash, and the streaming guard must agree with the one-shot
function however the reply is chunked."""

from __future__ import annotations

import random

import pytest

from app.app_utils.dashes import DashGuard, strip_dashes

EM, EN = chr(0x2014), chr(0x2013)

CASES = [
    (f"Gaurav Lahoti {EM} a Senior Cloud & AI-Native Architect {EM} leads it.",
     "Gaurav Lahoti, a Senior Cloud & AI-Native Architect, leads it."),
    (f"He worked there 2019{EN}2021.", "He worked there 2019-2021."),
    (f"He worked there 2019 {EN} 2021.", "He worked there 2019-2021."),
    (f"Three clouds{EM}GCP, AWS, Azure.", "Three clouds: GCP, AWS, Azure."),
    (f"Model Context Protocol (MCP) {EM} A six-act walkthrough", "Model Context Protocol (MCP): A six-act walkthrough"),
    (f"He paused {EM} I think he meant it.", "He paused, I think he meant it."),
    (f"It ends here {EM}.", "It ends here."),
    ("AWS - Azure - GCP", "AWS, Azure, GCP"),
    ("cloud - data - security", "cloud, data, security"),
    (f"{EM} Opening dash", "Opening dash"),
    (f"Line one.\n{EM} Line two", "Line one.\nLine two"),
    ("state-of-the-art AI-native", "state-of-the-art AI-native"),
    (f"LinkedIn {EM} agents post", "LinkedIn, agents post"),
    ("No dashes at all.", "No dashes at all."),
]


@pytest.mark.parametrize("raw,want", CASES)
def test_strip_dashes(raw: str, want: str) -> None:
    assert strip_dashes(raw) == want
    assert EM not in strip_dashes(raw) and EN not in strip_dashes(raw)


def _stream(text: str, cuts: list[int]) -> str:
    g, out, prev = DashGuard(), "", 0
    for c in [*cuts, len(text)]:
        out += g.push(text[prev:c])
        prev = c
    return out + g.flush()


@pytest.mark.parametrize("raw,want", CASES)
def test_stream_matches_one_shot_for_every_split(raw: str, want: str) -> None:
    for i in range(len(raw) + 1):
        assert _stream(raw, [i]) == want, f"split at {i}"


def test_stream_matches_one_shot_for_random_chunking() -> None:
    rng = random.Random(67)
    text = " ".join(r for r, _ in CASES)
    want = strip_dashes(text)
    for _ in range(300):
        cuts = sorted(rng.sample(range(1, len(text)), rng.randint(1, 25)))
        assert _stream(text, cuts) == want
