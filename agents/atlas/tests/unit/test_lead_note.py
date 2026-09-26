"""Unit tests for LeadNoteGuard (spec 67): the working note Atlas sometimes
writes into its reply at thinking level LOW must be diverted to the Thinking
panel, and nothing else may ever be held back or changed."""

from __future__ import annotations

from app.app_utils.lead_note import LeadNoteGuard


def _run(chunks: list[str]) -> tuple[str, str]:
    g = LeadNoteGuard()
    shown, notes = "", ""
    for c in chunks:
        out, note = g.push(c)
        shown += out
        notes += note
    out, note = g.flush()
    return shown + out, notes + note


def test_leaked_note_is_diverted_even_without_a_space_after_it() -> None:
    shown, note = _run(["Availability question, calling get_profile for the consulting ",
                        "status and route.Gaurav is full-time at Deloitte."])
    assert note == "Availability question, calling get_profile for the consulting status and route."
    assert shown == "Gaurav is full-time at Deloitte."


def test_note_on_its_own_line_is_diverted() -> None:
    shown, note = _run(["Certification question, calling get_certifications for the full list.\n",
                        "He holds 14 certifications."])
    assert note.startswith("Certification question")
    assert shown == "He holds 14 certifications."


def test_ordinary_reply_is_released_early_and_untouched() -> None:
    g = LeadNoteGuard()
    out, note = g.push("Gaurav is a Cloud and AI-Native Architect at Deloitte, working")
    assert note == ""
    assert out == "Gaurav is a Cloud and AI-Native Architect at Deloitte, working"
    assert g.push(" on agents.") == (" on agents.", "")


def test_reply_mentioning_a_question_is_not_mistaken_for_a_note() -> None:
    reply = "Good question. He is open to select consulting work."
    shown, note = _run([reply])
    assert note == ""
    assert shown == reply


def test_short_reply_is_released_at_end_of_stream() -> None:
    shown, note = _run(["Hi there!"])
    assert (shown, note) == ("Hi there!", "")


def test_without_note_removes_the_note_from_the_full_text() -> None:
    g = LeadNoteGuard()
    g.push("Availability question, calling get_profile.Gaurav is full-time.")
    g.flush()
    assert g.without_note("Availability question, calling get_profile.Gaurav is full-time.") == "Gaurav is full-time."
