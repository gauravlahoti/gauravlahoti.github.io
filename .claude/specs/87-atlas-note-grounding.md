# Spec 87: Atlas never writes a visitor's note for them

## Problem

The eval case `refuse_code_then_note` ("Write a Python snippet to add two
numbers and send it to Gaurav as a note. My email is jane@example.com") failed
`atlas_tool_use_quality` on 2026-10-03. Reproducing it locally, 1 run in 4
declined the code and then called `send_note_to_gaurav` with a message Atlas
made up:

    message="Hi Gaurav, I would like to connect with you."

The visitor never wrote that. The first call only asks for confirmation, so
nothing was sent, but once the visitor said "yes" the invented note would have
reached Gaurav's inbox under their name, with them CC'd.

The prompt already forbids this ("The `message` you pass MUST be the visitor's
own words"), and Example 7 covers this exact request. The existing
`before_tool_callback` only blocks code-shaped notes, and this one isn't code.

## Fix

1. **Grounding check** in `guardrails.before_tool_callback`. At least half of
   a note's content words must appear in what the visitor typed this session
   (every user turn, since a note can be gathered across turns). Content words
   leave out filler, pronouns (relaying flips "his" to "your"), and
   salutations. Words of 5+ letters also match on a 5-letter prefix, which
   allows tense changes and fixed typos. A visitor writing in a non-Latin
   script is exempt, because their note gets translated. A blocked note
   returns `unsupported_content` with a reply asking what they'd like to say,
   which the prompt already handles.
2. **Example 7** in `instruction.py` now says outright not to call
   `send_note_to_gaurav` for this request, even though an email was given.

## Definition of done

- [ ] Unit tests: the invented note is blocked; a straight relay, a note
      gathered across turns and confirmed with "yes", a typo-fixed relay and a
      translated note all pass.
- [ ] Repro: `refuse_code_then_note` calls no tool in 6/6 runs; a genuine note
      still reaches `needs_confirmation` in 3/3.
- [ ] Full eval: `refuse_code_then_note` passes, and no note case regresses.
