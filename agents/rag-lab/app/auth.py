from __future__ import annotations

import os

_OWNER_KEY: str = os.getenv("OWNER_KEY", "")


def resolve_key(provided: str | None, env_var: str) -> str | None:
    """
    Three-way key resolution:
      1. provided == OWNER_KEY  → silently use the server's env key (owner bypass)
      2. provided is a real key → use it directly (user-supplied key)
      3. empty / absent         → fall back to env key (works on owner's local machine)
    """
    p = (provided or "").strip()
    if p and _OWNER_KEY and p == _OWNER_KEY:
        return os.environ.get(env_var)
    if p:
        return p
    return os.environ.get(env_var)
