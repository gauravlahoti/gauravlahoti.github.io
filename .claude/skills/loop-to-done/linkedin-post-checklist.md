# LinkedIn post Definition of Done

Reusable checklist for the `linkedin-post` target in `loop-to-done`. Pinned
2026-07-12 (no existing spec/audit covers LinkedIn drafts). Use this file
verbatim for every future "loop a LinkedIn post" request instead of
re-deriving the rule.

The check is **not** a single shell command — LinkedIn copy needs judgment
and live fact verification, which no grep can do. The mechanism that makes
it machine-checkable anyway: **spawn a fresh, independent reviewer** (Agent
tool, fresh `general-purpose` agent, never a `fork` and never the same run
that wrote/revised the draft) and hand it this file plus the current draft.
The reviewer must actually use WebSearch to verify facts, not assume them.
Pass condition: the reviewer returns **zero violations across all four
criteria below**, itemized. Grep pre-checks below are cheap, deterministic
gates you can run yourself before or alongside the agent pass — they never
replace it, since criteria 2 and 3 aren't grep-checkable.

## Criterion 1 — Voice (CLAUDE.md rules)

- No em-dashes anywhere: `grep -nF '—' <draft>` → 0 hits.
- No filler/LLM-isms: `grep -niE 'delve|leverage|in the realm of|navigate the landscape|unlock|game.?changer|revolutioni[sz]e|seamlessly|robust solution|it'"'"'s worth noting|it'"'"'s not just|cutting.edge|transformative' <draft>` → 0 hits.
- Reads in a natural spoken tone: short, plain sentences, contractions okay,
  no clause-stacking. This part is judgment — the reviewer reads it aloud
  in its head and flags anything that sounds like marketing copy or a
  model talking.

## Criterion 2 — Fact-check (hardest gate, never skip)

- Every named person, quote, product, and event is verified **verbatim**
  via WebSearch/WebFetch by the reviewer itself, not taken on the drafter's
  word.
- Quotes must match the source wording (paraphrase is a violation if
  presented as a direct quote — check the quotation marks).
- Titles/roles must be exactly what the source says — no upgrading "built
  X" into "creator of X", no assuming a company/product affiliation that
  isn't confirmed. (Concrete failure mode already caught once: calling
  Peter Steinberger "the creator of Codex" — he didn't create Codex.)
- If a claim can't be confirmed, it's a violation until dropped or reframed
  as explicit opinion.

## Criterion 3 — Required structure

For the Loop Engineering post specifically (and any post routed through
this same rule should state its own structure up front the same way):

1. Opens with the two verified quotes (currently Boris Cherny and Peter
   Steinberger on loops vs. prompting).
2. Defines what a loop is, in contrast to a prompt.
3. States the 4-condition test: does it repeat, is there a clear
   definition of done, can you afford to be wasteful running it, does it
   have the tools it needs.
4. Lists the four building blocks: Trigger, Execution Skills, Goal +
   Verification, Output + Memory.
5. Closes with a CTA pointing at the relevant site content (currently the
   Engineering Loops lab in AI Labs).

## Criterion 4 — Length + format

- Character count under LinkedIn's practical comfort zone: `wc -m <draft>`
  → **< 2000** characters (this is looser than `linkedin-post-writer`'s own
  1300–1500 target/3000 hard cap — 2000 is the ceiling this loop enforces).
- Matches Gaurav's established post format: a hook in the first 1-2 lines,
  short paragraphs separated by blank lines, 3-5 hashtags on the final
  line, closes with a specific question (not "Thoughts?").

## Fix delegation

When a check fails, delegate the fix by criterion:

- Criterion 1 (voice) → targeted `Edit` removing the flagged word/dash, or
  re-run through the `linkedin-post-writer` skill for a tone pass.
- Criterion 2 (facts) → drop or reframe the unverified claim; re-verify the
  replacement before re-checking.
- Criterion 3 (structure) → `Edit` to restore the missing element; don't
  redraft the whole post for a single missing piece.
- Criterion 4 (length/format) → trim prose, don't just delete hashtags to
  hit the count.

Then spawn **another fresh reviewer** (never the same one, never the
drafting run) to re-check. Cap: 3 retries per criterion, per the parent
skill's default.
