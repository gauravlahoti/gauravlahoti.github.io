# Evaluation Sets

This directory contains evaluation datasets for `agents-cli eval` (Agent Platform Evaluation SDK, not the older ADK-native `adk eval` format).

## Running Evaluations

```bash
make eval-quick   # cheap 2-case smoke eval against basic.evalset.json
make eval         # full 16-case gate against portfolio.evalset.json, required before deploy
```

Both targets first run `tests/eval/prepare_evalset.py`, which copies the
checked-in fixture to `artifacts/eval_datasets/` with every test email
(`@example.com`) tagged `+eval<run>-<n>` — `send_resume`/`send_note_to_gaurav`
enforce a real 1-send-per-address-per-24h limit against the live production
Worker/D1, so reusing the same literal address run after run means only the
first `make eval` in a 24h window gets a genuine send and every run after
that scores `atlas_tool_use_quality` as if the agent picked the wrong tool.
Tagging keeps each run (and each case within a run) on its own address, so
that state never bleeds across runs. The checked-in `.evalset.json` files
stay untouched — only the generated, gitignored copy is templated.

Both targets then run `agents-cli eval run --dataset <generated file>
--config ../eval_config.yaml` (chains `eval generate` + `eval grade`) and
`tests/eval/check_results.py`, which applies the pass/fail thresholds and
gives `make eval` a real non-zero exit code on regressions — `agents-cli
eval grade` itself only scores and writes a report, it doesn't enforce a
bar. `check_results.py` still reads the original (non-generated) fixture
for case-id labelling — case order and ids are unaffected by tagging.

## Dataset format

Each `.evalset.json` is a flat `EvaluationDataset` with single-turn prompts:

```json
{
  "eval_cases": [
    {
      "eval_case_id": "case_id",
      "prompt": {
        "role": "user",
        "parts": [{"text": "User message"}]
      }
    }
  ]
}
```

For multi-turn continuations, use `agent_data.turns` instead of `prompt` (see
`~/.claude/skills/google-agents-cli-eval/references/dataset_schema.md`).

## Metrics (`../eval_config.yaml`)

Both metrics are `CodeExecutionMetric` custom functions (not agents-cli's
declarative `LLMMetric` or built-in managed metrics — those were tried
first and found broken against the live Vertex Evaluation Service as of
agents-cli 1.2.1; see the comment atop `eval_config.yaml`). Each
`custom_function` calls Gemini directly via the free-tier `GEMINI_API_KEY`,
so grading stays off Vertex AI entirely.

- `atlas_response_quality` — LLM-judge checking Atlas's 10 product rubrics
  (persona, scope, links, plain_text, grounded, email_policy, directness,
  citations, resume_fallback, compound_completeness). Threshold 0.85.
- `atlas_tool_use_quality` — LLM-judge on whether the right tools were
  called for each prompt, given the prompt, the tool catalog, and the
  actual tool calls made. Replaces the old ADK-native
  `tool_trajectory_avg_score` hardcoded expected-tool-call matching; no
  expected-tool data needs to live in the dataset itself. Threshold 0.8.

## Creating custom evalsets

1. Copy `basic.evalset.json` as a template.
2. Add cases with representative prompts (happy path + edge cases).
3. Point `--dataset` at the new file, or extend `eval_config.yaml`'s
   `metrics_to_run` if a new rubric is needed.
