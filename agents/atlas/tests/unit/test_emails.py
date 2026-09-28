"""Spec 67: Atlas must never show an email address it wasn't given.

A visitor asked for Gaurav's email and got a work address the model had
invented from his name and employer. Only his public contact address, or an
address the visitor typed, may ever appear."""

from __future__ import annotations

import random

from app import api
from app.app_utils.emails import (
    CONTACT_EMAIL,
    NO_CONTACT_REPLACEMENT,
    EmailGuard,
    emails_in,
    fix_emails,
)

LEAK = "You can reach Gaurav directly at glahoti@deloitte.com or by dropping a note here."


def test_invented_address_becomes_the_contact_address_on_contact_intent() -> None:
    out = fix_emails(LEAK, set(), contact_intent=True)
    assert "deloitte" not in out
    assert f"at {CONTACT_EMAIL} or" in out


def test_invented_address_without_contact_intent_points_elsewhere() -> None:
    out = fix_emails(LEAK, set(), contact_intent=False)
    assert "@" not in out and NO_CONTACT_REPLACEMENT in out


def test_contact_and_visitor_addresses_are_kept() -> None:
    text = f"Sent to Jane@Example.com. Gaurav is at {CONTACT_EMAIL}."
    assert fix_emails(text, {"jane@example.com"}, contact_intent=True) == text


def test_emails_in_finds_visitor_addresses() -> None:
    assert emails_in("my email is jane.r+jobs@example.co.uk, thanks") == {"jane.r+jobs@example.co.uk"}


def test_stream_never_leaks_a_split_address() -> None:
    rng = random.Random(67)
    want = fix_emails(LEAK, set(), contact_intent=True)
    for _ in range(200):
        cuts = sorted(rng.sample(range(1, len(LEAK)), rng.randint(1, 12)))
        g, out, prev = EmailGuard(set(), contact_intent=True), "", 0
        for c in [*cuts, len(LEAK)]:
            piece = g.push(LEAK[prev:c])
            assert "deloitte" not in piece
            out += piece
            prev = c
        assert out + g.flush() == want


def test_output_filter_chains_dashes_and_emails() -> None:
    f = api._OutputFilter(frozenset(), contact_intent=True)
    raw = "Reach him — glahoti@deloitte.com — any time."
    streamed = "".join(f.push(ch) for ch in raw) + f.flush()
    assert streamed == f.whole(raw) == f"Reach him, {CONTACT_EMAIL}, any time."
