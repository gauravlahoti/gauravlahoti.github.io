"""In-process per-IP-hash and per-session sliding-window rate limiter.

Best-effort across Cloud Run instances: each instance keeps its own counters.
At `min-instances=0, max-instances=5, concurrency=80` for portfolio traffic
this is acceptable — a determined attacker could fan across instances, but
they'd still hit the model RPM quota first.

# Strategy

Buckets are independent budgets keyed by a name (see `BUCKETS` below), so
spending one never touches another. Each bucket is defended at two layers so
no single identifier (sessionId, web-session, machine, IP) exceeds it in its
window:

- Layer 1 — sessionId (per page-load UUID). The Nth+1 hit on the same
  `sessionId` in the window returns 429.
- Layer 2 — IP-hash (per network endpoint, per UTC day). Stops the trivial
  "reload page to get a new sessionId" bypass; the IP cap is the true
  ceiling.

IP is hashed with `sha256(ip + UTC_DATE)` so the hash rotates daily by
construction — no manual salt rotation needed.

**`chat`** — 10 messages / 24h per layer. This is the visitor-facing question
budget: a visitor who reloads to escape the session cap is stopped by the IP
cap. After 24 hours, both budgets refresh. Raised from 4 once spec 51's
keep-warm ping stopped scale-to-zero from silently resetting these in-process
counters, which made the cap bind for the first time.

**`voice`** — 12 / 24h per layer. Transcribing must never spend a chat
question (a bad recording shouldn't cost the visitor one of their 10
answers), so it's a wholly separate budget. It's higher than `chat` because
re-recording after a mis-transcription is normal, expected usage, not abuse.

**`speak`** — 60 / 24h per layer. Synthesis is charged per sentence chunk,
not per reply (see `agent-speech.js`), so a single spoken answer costs
several slots. At ~5 chunks an answer this is roughly 12 spoken replies a
day, which keeps the deliberate margin over the 10 chat questions that can
produce them. This bucket must be resized whenever `chat` is. Like
`voice`, it must never spend a chat question — and unlike both others, going
over it is harmless: the reply is already on screen, it just stops being
read aloud.
"""

from __future__ import annotations

import hashlib
import threading
import time
from collections import defaultdict, deque
from datetime import UTC, datetime

BUCKETS: dict[str, dict[str, int]] = {
    "chat":  {"session": 10, "ip": 10, "window_s": 24 * 60 * 60},
    "voice": {"session": 12, "ip": 12, "window_s": 24 * 60 * 60},
    "speak": {"session": 60, "ip": 60, "window_s": 24 * 60 * 60},
}


class RateLimiter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, deque[float]] = defaultdict(deque)
        self._ips: dict[str, deque[float]] = defaultdict(deque)

    @staticmethod
    def hash_ip(ip: str) -> str:
        salt = datetime.now(UTC).strftime("%Y-%m-%d")
        return hashlib.sha256(f"{ip}|{salt}".encode()).hexdigest()[:16]

    def check_and_record(
        self,
        session_id: str,
        ip_hash: str,
        *,
        bucket: str = "chat",
        now: float | None = None,
    ) -> tuple[bool, str | None]:
        """Returns (allowed, reason).

        On allow, the request is also recorded against both layers of
        `bucket`. On deny, nothing is recorded.
        """
        limits = BUCKETS[bucket]
        window_s = limits["window_s"]
        ts = now if now is not None else time.time()
        session_key = f"{bucket}|{session_id}"
        ip_key = f"{bucket}|{ip_hash}"

        with self._lock:
            session_q = self._sessions[session_key]
            self._evict(session_q, ts - window_s)
            if len(session_q) >= limits["session"]:
                return False, "session"

            ip_q = self._ips[ip_key]
            self._evict(ip_q, ts - window_s)
            if len(ip_q) >= limits["ip"]:
                return False, "ip"

            session_q.append(ts)
            ip_q.append(ts)
            return True, None

    @staticmethod
    def _evict(q: deque[float], cutoff: float) -> None:
        while q and q[0] < cutoff:
            q.popleft()


limiter = RateLimiter()
