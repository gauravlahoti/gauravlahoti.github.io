"""Best-effort IP → city/region/country lookup for the agent audit log.

Uses ip-api.com's free, no-key JSON endpoint. Returns None on any failure
so the audit log path remains unblocked. The lookup runs on the
untruncated client IP — the IP itself is still stored truncated.
"""
from __future__ import annotations

import ipaddress
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_TIMEOUT_S = 0.25
_ENDPOINT = "http://ip-api.com/json/{ip}?fields=status,country,countryCode,regionName,city"


def _is_lookupable(ip: str) -> bool:
    if not ip:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
    )


async def lookup_geo(ip: str) -> dict[str, str] | None:
    """Resolve `ip` to {country, country_code, region, city}, or None."""
    if not _is_lookupable(ip):
        return None
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.get(_ENDPOINT.format(ip=ip))
            if r.status_code != 200:
                return None
            data: dict[str, Any] = r.json()
    except Exception as exc:
        logger.debug("geo lookup failed for %s: %s", ip, exc)
        return None
    if data.get("status") != "success":
        return None
    return {
        "country":      str(data.get("country") or "")[:64],
        "country_code": str(data.get("countryCode") or "")[:8],
        "region":       str(data.get("regionName") or "")[:64],
        "city":         str(data.get("city") or "")[:64],
    }
