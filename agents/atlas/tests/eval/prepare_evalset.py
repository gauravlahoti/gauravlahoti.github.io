#!/usr/bin/env python3
"""Give each `make eval` run a fresh test email, so resume/note-send cases
don't inherit a previous run's rate-limit state.

`send_resume` and `send_note_to_gaurav` (app/tools.py) enforce a real
1-send-per-address-per-24h rate limit against the LIVE production Cloudflare
Worker + D1 (app/app_utils/resume_send.py's `_check_rate_limit` — not a
mock). The checked-in evalset fixtures hardcode the same literal test
addresses ("jane.recruiter@example.com", "jane@example.com") in every eval
case, every run. Only the first `make eval` in any 24h window gets a genuine
send; every run after that hits the real rate limit, which changes the
tool's actual behavior and makes `atlas_tool_use_quality` score those cases
0.0 — not because the agent chose the wrong tool, but because the eval
harness shares mutable state with production with no run isolation.

Fix: tag each test email with a run-unique suffix (`+eval<timestamp>`) before
handing the dataset to `agents-cli eval run`. Standard `+tag` addressing is
accepted by the email validation in app/tools.py, so this needs no changes
to production code — the source-of-truth fixture files stay untouched and
readable; only a generated copy (gitignored, under artifacts/) is templated.

Usage: prepare_evalset.py <source.evalset.json> <output.evalset.json>
"""
from __future__ import annotations

import json
import re
import sys
import time

_TEST_EMAIL_RE = re.compile(r"([\w.-]+)@example\.com")


def _tag(match: re.Match[str], run_id: str, counter: list[int]) -> str:
    local = match.group(1)
    if "+" in local:
        # Already tagged (shouldn't happen from a clean source fixture, but
        # don't double-tag if this is ever run twice on its own output).
        return match.group(0)
    # Suffixed with a per-occurrence counter, not just the run id: two eval
    # cases in the same file can share a base address (e.g. "jane@..." shows
    # up in both `note_with_email` and `refuse_code_then_note`) — tagging by
    # run alone would give both the same final address and reintroduce a
    # same-run collision, just at case-pair granularity instead of run
    # granularity.
    counter[0] += 1
    return f"{local}+eval{run_id}-{counter[0]}@example.com"


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    src_path, out_path = sys.argv[1], sys.argv[2]

    run_id = str(int(time.time()))
    with open(src_path) as f:
        text = f.read()

    n_matches = len(_TEST_EMAIL_RE.findall(text))
    counter = [0]
    tagged = _TEST_EMAIL_RE.sub(lambda m: _tag(m, run_id, counter), text)

    # Round-trip through json to fail loudly on malformed output rather than
    # writing a broken dataset silently.
    data = json.loads(tagged)

    with open(out_path, "w") as f:
        json.dump(data, f, indent=2)

    print(f"prepare_evalset: {src_path} -> {out_path} ({n_matches} test emails tagged +eval{run_id})")


if __name__ == "__main__":
    main()
