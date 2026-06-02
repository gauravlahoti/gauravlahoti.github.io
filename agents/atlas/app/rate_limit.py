"""In-process per-IP-hash and per-session sliding-window rate limiter.

Best-effort across Cloud Run instances: each instance keeps its own counters.
At `min-instances=0, max-instances=3, concurrency=80` for portfolio traffic
this is acceptable — a determined attacker could fan across instances, but
they'd still hit the model RPM quota first.

# Strategy

Hard cap: **4 messages per visitor**, defended at two layers so no single
identifier (sessionId, web-session, machine, IP) gets more than 4 questions
in a 24-hour window.

- Layer 1 — sessionId (per page-load UUID): 4 per 24h. The 5th hit on the
  same `sessionId` returns 429.
- Layer 2 — IP-hash (per network endpoint, per UTC day): 4 per 24h. Stops
  the trivial "reload page to get a new sessionId" bypass; the IP cap is
  the true ceiling.

IP is hashed with `sha256(ip + UTC_DATE)` so the hash rotates daily by
construction — no manual salt rotation needed.

Both buckets share the same `4 / 24h` shape so the limits agree: a visitor
who reloads to escape the session cap will be stopped by the IP cap. After
24 hours, both budgets refresh.
"""

from __future__ import annotations

import hashlib
import threading
from collections import defaultdict, deque
from datetime import UTC, datetime

SESSION_WINDOW_S = 24 * 60 * 60  # 24 hours
SESSION_LIMIT = 4

IP_WINDOW_S = 24 * 60 * 60  # 24 hours
IP_LIMIT = 4


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
        now: float | None = None,
    ) -> tuple[bool, str | None]:
        """Returns (allowed, reason).

        On allow, the request is also recorded against both buckets.
        On deny, nothing is recorded.
        """
        import time

        ts = now if now is not None else time.time()

        with self._lock:
            session_q = self._sessions[session_id]
            self._evict(session_q, ts - SESSION_WINDOW_S)
            if len(session_q) >= SESSION_LIMIT:
                return False, "session"

            ip_q = self._ips[ip_hash]
            self._evict(ip_q, ts - IP_WINDOW_S)
            if len(ip_q) >= IP_LIMIT:
                return False, "ip"

            session_q.append(ts)
            ip_q.append(ts)
            return True, None

    @staticmethod
    def _evict(q: deque[float], cutoff: float) -> None:
        while q and q[0] < cutoff:
            q.popleft()


limiter = RateLimiter()
