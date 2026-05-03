"""Smoke test: send a fixture log entry to the configured AGENT_LOG_URL.

Usage (from portfolio-agent/ directory):
    uv run python -m app.app_utils.audit_log_smoke

Requires AGENT_LOG_URL and AGENT_LOG_TOKEN to be set (typically via .env
or make audit target). Exits 0 on success, 1 on failure.
"""
from __future__ import annotations

import asyncio
import os
import sys

import httpx


async def main() -> int:
    url = os.environ.get("AGENT_LOG_URL", "").strip()
    token = os.environ.get("AGENT_LOG_TOKEN", "").strip()
    if not url or not token:
        print("ERROR: AGENT_LOG_URL and AGENT_LOG_TOKEN must be set.", file=sys.stderr)
        return 1

    payload = {
        "sessionId": "smoke-test-session",
        "turnIndex": 0,
        "question": "Smoke test question from audit_log_smoke.py",
        "response": "Smoke test response",
        "toolCalls": [{"name": "get_profile", "args": {}}],
        "tokensInput": 10,
        "tokensOutput": 5,
        "latencyMs": 42,
        "status": "ok",
        "errorMessage": None,
        "identity": None,
        "userAgent": "smoke-test/1.0",
        "referrer": "",
        "ip": "127.0.0.1",
        "agentVersion": "smoke",
    }

    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.post(
            url,
            json=payload,
            headers={"X-Internal-Token": token, "Content-Type": "application/json"},
        )

    if r.status_code == 200:
        print(f"OK: {r.json()}")
        return 0
    else:
        print(f"FAIL {r.status_code}: {r.text[:300]}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
