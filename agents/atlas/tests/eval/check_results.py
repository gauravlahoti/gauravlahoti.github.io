#!/usr/bin/env python3
"""Pass/fail gate over `agents-cli eval grade` output.

agents-cli's `eval grade` only scores and writes a report — it does not
itself enforce a threshold or fail the process. This script reads the
latest artifacts/grade_results/results_*.json, checks per-case scores
against THRESHOLDS, prints a table, and exits non-zero on any miss so
`make eval` / `make eval-quick` keep acting as a real deploy gate.

Usage: check_results.py [results.json] [dataset.json]
  results.json defaults to the newest artifacts/grade_results/results_*.json
  dataset.json (the eval_cases file used to generate) is used to map each
  result's eval_case_index back to its eval_case_id for readable output;
  if omitted, cases are labelled by index only.

Real results.json shape (confirmed against a live run on agents-cli 1.2.1):
{
  "eval_case_results": [
    {
      "eval_case_index": 0,
      "response_candidate_results": [
        {
          "response_index": 0,
          "metric_results": {
            "<metric_name>": {
              "metric_name": "...", "score": <float|null>,
              "explanation": "...", "error_message": "..." | null
            }
          }
        }
      ]
    }
  ]
}
Both metrics here are custom CodeExecutionMetric entries (eval_config.yaml)
that call Gemini directly, not agents-cli's managed Vertex metrics — so
metric names in results.json match THRESHOLDS keys below verbatim, no
"_v1" suffix (that suffix only applies to agents-cli's built-in metrics,
which this project stopped using after finding them broken).
"""
from __future__ import annotations

import glob
import json
import os
import sys

THRESHOLDS = {
    "atlas_response_quality": 0.85,
    "atlas_tool_use_quality": 0.8,
}

RESULTS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "artifacts", "grade_results")
TRACES_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "artifacts", "traces")


def _latest_results_file() -> str:
    candidates = sorted(glob.glob(os.path.join(RESULTS_DIR, "results_*.json")))
    if not candidates:
        print(f"ERROR: no results_*.json found under {RESULTS_DIR}", file=sys.stderr)
        sys.exit(1)
    return candidates[-1]


def _latest_traces_file() -> str | None:
    candidates = sorted(glob.glob(os.path.join(TRACES_DIR, "traces_*.json")))
    return candidates[-1] if candidates else None


def _case_id_map(dataset_path: str | None) -> dict[int, str]:
    """Map eval_case_index -> eval_case_id.

    IMPORTANT: eval_case_index refers to position within the TRACES file
    used for grading, not position in the original dataset — when
    `eval generate` drops failed cases, the survivors are re-indexed
    sequentially in the trace. So prefer reading IDs straight out of the
    latest trace file (which carries the correct eval_case_id per case);
    only fall back to the static dataset_path if no trace file is found
    (and note that fallback is only exact when nothing was dropped).
    """
    traces_path = _latest_traces_file()
    if traces_path and os.path.exists(traces_path):
        with open(traces_path) as f:
            cases = json.load(f).get("eval_cases", [])
        return {i: c.get("eval_case_id", str(i)) for i, c in enumerate(cases)}
    if not dataset_path or not os.path.exists(dataset_path):
        return {}
    with open(dataset_path) as f:
        cases = json.load(f).get("eval_cases", [])
    return {i: c.get("eval_case_id", str(i)) for i, c in enumerate(cases)}


def main() -> None:
    results_path = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else _latest_results_file()
    dataset_path = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
    id_map = _case_id_map(dataset_path)

    print(f">> Checking {results_path}")
    with open(results_path) as f:
        data = json.load(f)

    case_results = data.get("eval_case_results")
    if not isinstance(case_results, list) or not case_results:
        print("ERROR: no 'eval_case_results' list found — results.json shape has changed.")
        print("Inspect the file directly and update check_results.py.")
        sys.exit(1)

    failed = False
    print(f"{'case':<32} {'metric':<32} {'score':>7}  status")
    print("-" * 84)
    for case in case_results:
        idx = case.get("eval_case_index")
        cid = id_map.get(idx, str(idx))
        for candidate in case.get("response_candidate_results", []):
            metric_results = candidate.get("metric_results", {})
            for mname, mres in metric_results.items():
                score = mres.get("score")
                err = mres.get("error_message")
                threshold = THRESHOLDS.get(mname)
                if err:
                    failed = True
                    print(f"{cid:<32} {mname:<32} {'ERR':>7}  FAIL ({err[:60]})")
                    continue
                if threshold is None or score is None:
                    # unthresholded/unknown metric — report but don't gate
                    print(f"{cid:<32} {mname:<32} {score!s:>7}  (no threshold)")
                    continue
                ok = score >= threshold
                failed = failed or not ok
                status = "PASS" if ok else f"FAIL (< {threshold})"
                print(f"{cid:<32} {mname:<32} {score:>7.3f}  {status}")

    if failed:
        print("\nEVAL FAILED — one or more cases are below threshold or errored.")
        sys.exit(1)
    print("\nEVAL PASSED — all cases at or above threshold.")


if __name__ == "__main__":
    main()
