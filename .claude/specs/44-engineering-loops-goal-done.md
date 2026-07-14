# Spec 44: Engineering Loops — The Goal + Definition-of-Done Loop (Loop layer)

## Overview
The loop-engineering layer (layer 04) of the Engineering Loops lab
(`/ai-labs/engineering-loops/`) shows the supervisor stepping out, an autonomous
trigger, an "idle harness" problem callout, and the "it grows itself" chips. It never
shows the thing that actually defines loop engineering: **a goal**, a **definition of
done**, and a **feedback loop that iterates until the definition of done passes**. This
spec adds those three, and in doing so gives the loop layer its first animation (today
it is the only static layer of the four).

## Problem / motivation
- **No goal depicted.** `targetGlyph()` (bullseye, `engineering-loops.js:188`),
  `dg.goalLabel = "the goal"` and `dg.feedbackLabel = "feedback loop"`
  (`content/engineering-loops.json`) are all defined but **unused** — the scaffolding was
  stubbed and never wired into `buildAll()`.
- **No stopping rule shown.** The layer's own copy already promises it
  (`definition`: "Give it a goal and a stopping rule…"; `caption`: "goal → act → check →
  repeat"), but the visuals and the code comment at `engineering-loops.js:1184-1188`
  contradict it, framing the outer loop as "open-ended by design … doesn't terminate."
- **The loop layer has no `anims.loop`.** `anims.prompt/context/harness` exist; loop has
  none, so it reveals instantly (via the `startLayerAnim`→`revealDemarcation` no-anim
  branch) and reads as flat next to the three animated layers.

## Reframing (locked)
Per goal, the loop runs **until its definition of done passes, then stops**. The
scheduler/trigger can later start the next goal. This reconciles "loops until done" (one
goal terminates) with the existing "open-ended" idea (the system keeps taking new
goals). Update the `engineering-loops.js:1184-1188` comment to match this framing.

## Scope (locked)
**Full:** goal + done-gate + animated feedback loop + 2 new narration lines + audio
regen. Visual diagram changes land and are verified on localhost FIRST; ElevenLabs TTS
is generated LAST, only after the visuals are confirmed.

## Design — additions to the loop layer in `buildAll()` (`engineering-loops.js`, `gl`/`cll`)

Split the two concepts to where each is actually used, so the outer cycle reads
start → run → check → done:

1. **The goal (top band).** A `targetGlyph()` bullseye + `dg.goalLabel` ("the goal")
   placed between the supervisor and the trigger clock. The supervisor "sets policy
   once" → draw a thin tether (same `.loops-supervise-line` dashed style) from the
   supervisor to the goal, so "policy" reads concretely as *the goal the human sets*.
   Then goal → trigger → run.
2. **The done-gate (bottom-right, the open space at x≈968–1390 / y≈852–960).** A
   loop-blue rounded node "meets definition of done?" (`dg.doneGateLabel`). The harness
   output exits the harness bottom edge (~x1150) and drops into the gate.
   - **Yes branch:** short arrow to "✓ done · ship it" (`dg.doneYes`); reuse the blue
     check styling (`.loops-task-check` fill = `--loops-loop`). This is where the loop
     terminates for this goal.
   - **No branch:** "✗ not yet · loop again" (`dg.doneNo`, red ✗ via `.loops-retry-x`),
     routed as a loop-blue **feedback arc** up the right margin (x≈1410) and back into
     the harness's top-right edge — the run repeats. The arc wraps the harness, making
     "it keeps running" literal. It deliberately re-enters the harness (not the clock):
     the clock starts the *first* run, the feedback arc drives the *repeats*, so the arc
     never has to cross the top-band problem callout (x880–1320).
3. **`anims.loop` (new).** The loop layer's first animation, `repeat: -1`:
   - A dot rides goal → trigger → into harness (a run) → out the bottom to the gate.
   - First 1–2 laps take the **No** arc (gate flashes "✗ not yet", dot loops back up into
     the harness and runs again) — this is the "until done" beat.
   - Final lap the gate flips to **✓ done**, the dot exits to "ship it", "goal reached"
     lights, then the timeline resets and repeats (ambient, like the other layers).
   - Reuse `travelDot()` with `layer: "loop"` so `stopLayerAnim("loop")` cleans up its
     dots. Reuse `orthoConnector()` for the gate wiring and a curved/ortho arc for the
     feedback return.
   - Consequence (intended): `revealDemarcation("loop", …)` now fires on the anim's first
     `onRepeat` (via `startLayerAnim`'s existing `onRepeat` wiring) instead of instantly.
     The loop boundary **and the coda chart** (`chartSection._reveal`, gated on
     `revealDemarcation("loop")`) now appear after one full cycle — consistent with the
     other three layers. Verify the chart still reveals.

## Step-count / narration impact
Loop currently has **7 `put()` steps ↔ 7 narration lines ↔ 7 MP3s** (`loop-01..07.mp3`),
mapped 1:1; `narration.playLayer` warns on mismatch and plays extra steps caption-only.
This spec adds **2 steps** (goal; done-gate + feedback arc) → **9 steps**. Two new
narration lines are needed to keep 1:1, e.g.:
- after the supervisor line: *"And you hand it two things — a goal, and a definition of
  done: the rule that says when the work is actually finished."*
- near the gate: *"So it runs, checks its own output against that definition of done, and
  if it isn't there yet it loops and tries again — until it passes."*
Insert them in the loop `narration[]` in the new step order.

## Content — `content/engineering-loops.json`
- `diagram`: reuse `goalLabel`; add `doneGateLabel` ("meets definition of done?"),
  `doneYes` ("✓ done · ship it"), `doneNo` ("✗ not yet · loop again"),
  `goalReached` ("goal reached"). (`feedbackLabel` already exists.)
- `layers[].loop.narration`: insert the 2 lines above in new step order.

## CSS — `assets/css/engineering-loops.css`
Add near the existing loop-layer block (`.loops-loop-problem-frame`, ~L256):
- `.loops-done-gate` — loop-blue rounded node stroke (mirror `.loops-node-rect` +
  `--loops-loop`).
- `.loops-feedback-arc` — loop-blue connector, reuse `.loops-conn-line` weight or slightly
  heavier; solid.
- Reuse `.loops-retry-x` (red ✗) and `.loops-task-check`/new `.loops-done-yes` (blue ✓).

## Cache-bust + docs
- Bump `?v=` on the CSS `<link>` and page `<script>` in
  `ai-labs/engineering-loops/index.html` (JS + CSS + JSON changed).
- Update the loop-layer paragraph in `ai-labs/engineering-loops/CLAUDE.md` (and the root
  `CLAUDE.md` architecture row) to describe the goal + done-gate + feedback loop + new
  `anims.loop`.

## Audio generation (LAST)
After visuals verified on localhost, regenerate loop audio:
`node scripts/generate-engineering-loops-narration.mjs --layer=loop --force`
(requires `ELEVENLABS_API_KEY`). Run manually/locally. Renumbering shifts existing
`loop-0x.mp3` → verify all 9 regenerate.

## Verification
```bash
python3 -m http.server 5173   # open /ai-labs/engineering-loops/#loop
```
- Focus the loop layer: goal, trigger, done-gate reveal in order; the dot iterates
  (✗ not yet → loop again) then lands ✓ done and exits.
- Loop boundary + coda chart still reveal (now after one anim cycle).
- Tour reaches loop, narration (or captions) covers goal + definition of done; advances
  cleanly.
- `prefers-reduced-motion`: static render, all captions at once, no crash.
- Prev/Next/dot mid-loop: `stopLayerAnim("loop")` clears dots, no stray dots, no console
  errors.
- If audio not regenerated: new steps caption-only, one `console.warn` on step/line
  mismatch, no crash.

## Status
- [x] Content (`diagram` keys + 2 narration lines) — loop now 9 steps ↔ 9 narration lines
- [x] `buildAll()` loop visuals: goal (on the supervisor tether), done-gate, feedback arc
- [x] `anims.loop` (first loop-layer animation) + reframe js:1184-1188 comment
- [x] CSS `.loops-done-gate` / `.loops-feedback-arc` / `.loops-done-edge` / `.loops-done-yes`
- [x] `?v=` bump (css 56 / page-script 125)
- [ ] Root + lab `CLAUDE.md` docs update (do with commit)
- [ ] Regenerate `loop-*.mp3` (needs `ELEVENLABS_API_KEY`) — LAST, after visuals verified
- [ ] End-to-end verification per checklist
