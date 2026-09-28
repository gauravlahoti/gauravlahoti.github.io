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


def test_scorecard_note_shapes_are_diverted() -> None:
    # Both seen in the spec 67 scorecard, run 3.
    cases = [
        ("Resume routing question, destination email not provided, asking visitor for their email address.",
         "I would be happy to email you Gaurav's resume. What email address should I send it to?"),
        ("Compound code generation and note request. I'll decline writing code per safety guidelines, "
         "but invite Jane to share her own personal note to pass along to Gaurav.",
         "I don't generate code, so I'll leave that part. Want to tell him what's on your mind?"),
    ]
    for note, reply in cases:
        raw = note + reply  # no space after the note, as the model wrote it
        for chunks in ([raw], list(raw)):
            assert _run(chunks) == (reply, note)


def test_a_reply_that_opens_with_a_request_word_is_left_alone() -> None:
    for reply in ("Good request. He'd be glad to hear more about the project.",
                  "Fair question. Gaurav is full-time at Deloitte, and takes select consulting work."):
        assert _run(list(reply)) == (reply, "")


# --- the [[NOTE]] protocol (NoteFilter) -------------------------------------

from app.app_utils.lead_note import NoteFilter  # noqa: E402


def _run_filter(chunks: list[str]) -> tuple[str, str]:
    f = NoteFilter()
    shown, notes = "", []
    for c in chunks:
        out, note = f.push(c)
        shown += out
        notes.append(note)
    out, note = f.flush()
    notes.append(note)
    return shown + out, " ".join(n for n in notes if n)


def test_note_block_goes_to_thinking_for_every_chunking() -> None:
    raw = "[[NOTE]]Resume request, missing email, asking the visitor.[[/NOTE]]\nWhat email should I send it to?"
    for i in range(len(raw) + 1):
        assert _run_filter([raw[:i], raw[i:]]) == (
            "What email should I send it to?", "Resume request, missing email, asking the visitor."), f"split {i}"


def test_a_second_block_mid_reply_is_lifted_too() -> None:
    raw = "[[NOTE]]Cert question.[[/NOTE]]He holds fourteen. [[NOTE]]calling get_projects[[/NOTE]]Want more?"
    shown, note = _run_filter(list(raw))
    assert shown == "He holds fourteen. Want more?"
    assert "[[" not in shown and "get_projects" in note


def test_unclosed_block_never_swallows_more_than_the_limit() -> None:
    raw = "[[NOTE]]plan " + "x" * 700 + " Real answer."
    shown, note = _run_filter([raw])
    assert "[[NOTE]]" not in shown and note


def test_reply_is_never_left_empty_by_the_backstop() -> None:
    # The whole reply looked like an untagged note: show it rather than nothing.
    raw = "Weather question, declining and routing to LinkedIn."
    shown, _ = _run_filter(list(raw))
    assert shown == raw


def test_without_note_strips_blocks_for_speech_and_logs() -> None:
    f = NoteFilter()
    raw = "[[NOTE]]Cert question, calling get_certifications.[[/NOTE]]\nHe holds fourteen."
    f.push(raw)
    f.flush()
    assert f.without_note(raw) == "He holds fourteen."
