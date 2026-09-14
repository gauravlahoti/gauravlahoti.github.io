# Spec 59 — Atlas latency instrumentation, and clamping what the build story recites

**Status:** Implemented (deployed `atlas-00043-6qx`)
**Date:** 2026-09-15
**Branch:** `59-atlas-latency-disclosure`

## Why

Two problems surfaced in real use immediately after spec 58 shipped.

1. **"The second question takes forever."** The widget's 10s stall message was appearing, and the voice lagged badly behind the text. This was blocking a video recording.
2. **Atlas recited an inventory of internal tooling.** Asked to "list me all the skills he created and internal tool names", it named `/create-spec`, `/implement-spec`, `/ship` and walked through every skill.

Problem 2 was **spec 58's fault, not a jailbreak.** `content/build-story.json` contained a directory listing (`method[].commands` named the slash commands; `harness[].skills` enumerated six skills one per clause), and the prompt section spec 58 added pushed toward breadth — "don't undersell it", "give the concrete specifics", "never wave the question off", "stay candid" — with only *accuracy* brakes and no *breadth* brake anywhere in 432 lines. Atlas did what it was told.

## The headline finding: the turn-2 cliff was not real

The original evidence was turn 1 at 7.2s against turn 2 at 13.6s. **Those were different questions** (a certifications lookup vs the skills probe), so the comparison was worthless. Re-measured properly, identical question at turn 1 and turn 2, three runs:

| Run | Turn 1 TTFT | Turn 2 TTFT |
|---|---|---|
| A | 5,383ms | 3,037ms |
| B | 3,986ms | 9,793ms |
| C | 2,839ms | 2,060ms |

Turn 2 was **faster in two of three runs**. There is no turn-2 cliff. The real characteristic is variance: identical input ranges 2.0s to 9.8s, and the 10s stall message fires on that tail.

Correlating prompt size against TTFT across the run set: **token count varies 14%, TTFT varies 375%, r = 0.59** resting almost entirely on a single 18k-token point. Prefill size is not the dominant term in this range, which is the measured reason the prompt-trimming lever underperformed.

## What shipped

**Latency**
- `lookup_geo` moved off the critical path. It was awaited *before the SSE stream opened*, for a telemetry field that never reaches the model. Now resolved in `_log_turn` after `done` ships. Turn-1 TTFT improved from ~7.2s to ~4.1s mean.
- **`speak.py` event-loop stall fixed.** `_get_credentials()` calls `_creds.refresh()`, a synchronous network round-trip, and it was being called inline from `async def speak_text`. ADC tokens expire hourly, so once an hour that froze the entire uvicorn event loop, stalling every in-flight SSE chat stream and every concurrent TTS request. Now wrapped in `asyncio.to_thread`, matching what the warm route in `api.py` already did.
- **TTFT instrumentation.** A `chat-timing` log line carrying `turn`, `latency_ms`, `ttf_thinking_ms`, `ttf_delta_ms`, tokens and model. Deliberately Cloud Logging rather than the audit row: the Worker persists a fixed column set and would silently drop unknown keys.
- System instruction trimmed 12,728 → 11,813 tokens (-7.2%) by merging worked examples 2+3 and 4+4b, cutting 6, 8 and 10, and compressing the citations section. Rules unchanged; only restatements and redundant examples removed.

**Disclosure**
- `content/build-story.json` rewritten to practice-not-inventory: no literal command names, no per-skill enumeration, no internal doc contents. Counts kept (they are the credibility).
- **`steps` dropped from `get_live_agents` entirely.** Spec 58 introduced this and it was the more serious exposure: `agents.json` `steps` names live endpoint paths, D1 table names, the retention window, the per-session rate-limit number, and states that injection stripping exists and where it sits in the pipeline. `techDecisions` is kept, since that is the part that answers "why".
- `agent_name` tightened from substring to exact-or-3-char-prefix. A one-character probe previously unlocked build detail for several agents at once.
- A breadth brake added to `instruction.py`, plus a worked example. There is **no guardrail seam** for this: the injection regex is lexical and targets prompt-extraction phrasings, and `# Hard limit` is about *doing work*. A recon question does no work and contains no injection tokens, so it passes every callback untouched. The rule has to live in the prompt and in the corpus text.
- `content/agents.json` factual bug fixed: Atlas's `techDecisions` claimed `min-instances=0` with a keep-warm ping, a configuration abandoned in spec 51.

## What was tried and reverted: ADK context caching

`ContextCacheConfig(cache_intervals=10, ttl_seconds=1800, min_tokens=4096)` was deployed (`atlas-00042-p6l`) and reverted the same session. It caused **two** regressions:

1. **Latency 2.5x worse**, turn 2 from 13.6s to 34.3s:
   ```
   turn=0 latency_ms=5661  ttf_delta_ms=4691  tokens_in=15895 thinking=21 out=164
   turn=1 latency_ms=33838 ttf_delta_ms=32352 tokens_in=17113 thinking=32 out=196
   ```
   32 seconds to first token while generating 196 output tokens. Entirely pre-generation. The cached prefix appears to be rewritten each turn rather than reused, because history grows and shifts it, so every turn pays a write and none get a hit.
2. **Tool selection degraded.** `make eval` failed four cases on `atlas_tool_use_quality`. With the cache removed and nothing else changed, three returned to 1.000:

   | Case | Cache on | Cache off |
   |---|---|---|
   | `followups_present` | 0.300 | 1.000 |
   | `compound_two_questions` | 0.500 | 1.000 |
   | `no_tooling_inventory` | 0.000 | 1.000 |

The rationale is recorded inline at the `App(...)` call so it is not re-enabled on theory. It is `@experimental` in this ADK version.

## On ADK Skills

Considered and rejected *for latency*. Spec 37 already built this (five `SKILL.md` files, `SkillToolset`) and commit `d37bc42` removed it, because live tools give the same progressive-disclosure shape while staying current. Three reasons it does not apply here:

- The corpus is already on-demand. Spec 37's problem (6-8K of corpus injected every turn) is solved.
- The remaining prompt is *rules*, not data, and the load-bearing parts cannot be deferred: the `[[META]]` block is required on every reply, third-person applies to every sentence. Only ~2,200 tokens (19%) are genuinely conditional.
- Those conditional sections are resume routing, note routing and engagement routing — **the highest-value interactions on the site.** Skills would add an LLM round trip precisely when a visitor is trying to make contact, to make trivia marginally faster.

Worth building as a *demo* of progressive disclosure, which is the on-brand reason spec 37 itself gave. Not as a latency fix.

## Definition of done

- [x] Turn-2 claim re-measured with the question held constant; cliff disproved.
- [x] Geo lookup off the hot path; `speak.py` event-loop stall fixed; TTFT instrumented.
- [x] Context caching measured, reverted, and documented inline.
- [x] Build story carries no command names, skill enumeration, or internal doc contents.
- [x] `steps` unreachable from `get_live_agents` on every code path.
- [x] Short-probe `agent_name` no longer unlocks build detail.
- [x] Disclosure probes answer with practice, not inventory (two phrasings verified live).
- [x] Cut examples spot-checked: vendor-scoped certs still emit correct badges; availability still routes to `linkedin`, not Topmate.
- [x] 125 unit + integration tests pass.
- [ ] `make eval` green on the trimmed prompt. `certs_to_artifact` scored 0.500 on `atlas_tool_use_quality` in the cache-free run despite calling exactly the right two tools (`get_certifications`, `get_build_story`), and scored 1.000 on the same case in spec 58. Treated as judge variance pending a second sample; see the known instability of this metric.

## Notes

- The thinking panel remains far more verbose than the prompt asks for. Confirmed pre-existing in spec 58 by reproducing it on an untouched path. Still deserves its own spec.
- The voice trailing the text on long replies is **by design** (spec 57) and was not touched. The genuine voice bug fixed here is the event-loop stall. Chunk seams remain architectural; spec 50's deferred `streamingSynthesize` is the real fix.
- `content/*.json` ships to Pages and is fetchable by URL, and `instruction.py` is public on GitHub. Prompt hardening changes what Atlas *volunteers*, not what a determined visitor can *retrieve* — which is why the disclosure fix edits the corpus text, not just the prompt.
