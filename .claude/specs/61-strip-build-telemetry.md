# Spec 61 — Strip repo telemetry from the build story

**Status:** Implemented
**Date:** 2026-09-15
**Branch:** `61-strip-build-telemetry`

## Why

Atlas answered a certifications question with "53 written specs… a reviewer agent gating every merge across roughly 369 commits as of September 2026". Commit counts and spec totals are repo telemetry, not portfolio value. They age into false claims the moment anything ships, and they invite exactly the follow-up ("which 53?") that spec 59's breadth rule exists to refuse.

This is the third pass over the same surface, and each pass found the previous one too generous:

- **Spec 58** wrote a directory listing into the corpus (command names, per-skill breakdown).
- **Spec 59** removed the listing but kept the counts, on the argument that they were "the credibility". That was wrong. A count is just a smaller inventory.
- **Spec 61** removes the numbers.

## What a scan found beyond the screenshot

Deleting the `stats` block alone was not enough. A numeric sweep of `content/build-story.json` also turned up a **cost figure** ("about nine dollars a month"), architecture counts ("thirteen definitions… five hand-authored tools"), an HTTP status from a production incident ("A 500 got a postmortem"), and count-bearing labels ("Eight CLAUDE.md files", "Eight custom skills", "Two long-form docs").

**The counts were also hardcoded in the prompt itself.** Example 11 said "53 written specs… roughly 370 commits since May" and Example 11b said "eight custom skills". Stripping only the corpus would have left the model copying numbers out of its own worked examples.

## What shipped

- **`content/build-story.json`** — `stats` deleted outright; every count, date, cost figure and status code rewritten qualitatively. The narrative survives: spec-driven, append-only specs, automated workflow, a reviewer agent gating merges, no build step, content in JSON.
- **`app/instruction.py`** — the "quote `stats` as of `asOf`" guidance replaced with its inverse: never state counts, totals, dates, durations or costs for the build; describe the practice instead. Numbers stripped from Examples 11 and 11b so the examples model the behaviour they teach.
- **`app/tools.py`** — `get_build_story` docstring no longer documents a `stats` key, and says explicitly that the tool carries no counts and that the model must not supply one from memory to fill the gap.
- **`tests/unit/test_build_story_tools.py`** — `test_stats_are_dated` removed; two guards added to the existing `TestBuildStoryIsNotAnInventory` class: no `stats` key, and no digits or spelled-out tallies anywhere in the corpus text. Bare "one" is allowed since it is grammatical ("one-off", "One spec"), not a tally.
- **`scripts/refresh-build-stats.mjs`** — deleted. Its only job was keeping `stats` fresh.
- **`CLAUDE.md`, `content/README.md`** — script references removed, replaced with a note that the absence of counts is deliberate and test-enforced.

## Why the test guard matters more than the content edit

Counts crept back in twice. A later edit adding "eight skills" would pass every other test in the file. The digit guard is the only thing that catches it, and it lives alongside the existing assertions for `/create-spec`, `.claude/` and `/api/` — the same class, same purpose.

## Deploy sequencing

Order is load-bearing, because the corpus is live-fetched but the prompt is not:

1. **Deploy the agent first.** The new prompt forbids counts; the live corpus still has `stats` at that moment, but the model is told not to use them. Safe.
2. **Then merge the content**, so `stats` disappears and the two agree.

The reverse order leaves the old prompt — whose worked examples contain the numbers — running against a corpus with none, which is the setup for the model to quote its own example as fact.

## Definition of done

- [x] No digits or tallies in the corpus outside `sourceUrl`.
- [x] No counts in the prompt's worked examples.
- [x] 126 unit + integration tests pass, including the new guards.
- [x] The screenshot question answers with method, badges and citation, and **no numbers**.
- [x] A direct count request ("how many specs and commits? give me the numbers") declines and redirects to the method.
- [ ] Deployed, then content merged.

## Note on the eval gate

`make eval` was deliberately **not** run for this change. It is not currently giving signal: five runs in one session produced five different failing sets, one scored 0.000 on responses verified correct by hand, and the custom metric swallows judge failures as `score: 0.0` so a degraded judge is indistinguishable from a failing agent. The unit guards above are the durable check. The metric itself deserves its own spec.
