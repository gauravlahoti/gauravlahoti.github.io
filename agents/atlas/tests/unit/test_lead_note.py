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


def test_note_about_whats_missing_and_its_follow_on_are_both_diverted() -> None:
    # Seen in the spec 67 scorecard (voice mode): a note with no tool name,
    # plus a second planning sentence.
    reply = ("Resume question, missing recipient email address. No tool call possible yet.\n\n"
             "I can send Gaurav's resume to your inbox! What email address should I use?")
    for chunks in ([reply], list(reply)):
        shown, note = _run(chunks)
        assert note == "Resume question, missing recipient email address. No tool call possible yet."
        assert shown == "I can send Gaurav's resume to your inbox! What email address should I use?"


def test_question_type_opener_without_planning_is_the_reply() -> None:
    for reply in ("Good question, he is full-time at Deloitte and takes select consulting work.",
                  "Certification question, and the short answer: Gaurav holds fourteen of them."):
        assert _run(list(reply)) == (reply, "")


def test_a_note_followed_by_a_normal_sentence_keeps_that_sentence() -> None:
    reply = "Availability question, calling get_profile. Gaurav is full-time at Deloitte."
    shown, note = _run(list(reply))
    assert note == "Availability question, calling get_profile."
    assert shown == "Gaurav is full-time at Deloitte."


def test_without_note_strips_a_multi_sentence_note() -> None:
    reply = "Resume question, missing email. No tool call possible yet. What's your email?"
    g = LeadNoteGuard()
    for ch in reply:
        g.push(ch)
    g.flush()
    assert g.without_note(reply) == "What's your email?"
