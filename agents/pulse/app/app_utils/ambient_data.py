"""Ambient-agent data tools — read/mark D1 via the resume-gate Worker.

The ambient agent has no direct database access; the Worker is the only thing
that can reach D1. These helpers GET/POST the Worker's /api/ambient/* endpoints,
authenticating with the shared X-Internal-Token (AGENT_LOG_TOKEN) — the same
secret audit_log.py uses. The base URL is derived from AGENT_LOG_URL by
stripping the /api/agent-log suffix (same trick as resume_send._check_url).

Each function is registered as an ADK tool, so it returns a plain
JSON-serialisable structure and NEVER raises: on misconfig or transport error
it returns an empty list / {"ok": False, ...} so the agent can react in-band.
"""
from __future__ import annotations

import asyncio
import calendar
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_TIMEOUT_S = 8.0


def _base_url() -> str:
    base = os.environ.get("AGENT_LOG_URL", "").strip()
    return base.replace("/api/agent-log", "") if base else ""


def _token() -> str:
    return os.environ.get("AGENT_LOG_TOKEN", "").strip()


def _headers(token: str) -> dict[str, str]:
    return {"X-Internal-Token": token, "Content-Type": "application/json"}


# --- The report period (spec 84) -----------------------------------------------
# Pulse runs Mon and Thu at 08:00 IST (Cloud Scheduler `portfolio-ambient-agent`,
# Asia/Kolkata). Each report covers the time since the previous scheduled run
# (Thu->Mon is 4 days, Mon->Thu is 3), so consecutive reports tile with no
# overlap, and compares with the same span one week earlier, like for like.
IST = timezone(timedelta(hours=5, minutes=30))
RUN_WEEKDAYS = (0, 3)          # Monday, Thursday
RUN_HOUR = 8
_GRACE = timedelta(minutes=5)  # the run that just fired is not "the last report"


def report_period(now: datetime | None = None) -> dict[str, Any]:
    """{from, to, prev_from, prev_to} as unix seconds, plus the datetimes."""
    now = (now or datetime.now(timezone.utc)).astimezone(IST)
    probe = now - _GRACE
    start = probe.replace(hour=RUN_HOUR, minute=0, second=0, microsecond=0)
    while start.weekday() not in RUN_WEEKDAYS or start > probe:
        start -= timedelta(days=1)
        start = start.replace(hour=RUN_HOUR, minute=0, second=0, microsecond=0)
    week = timedelta(days=7)
    return {
        "from": int(start.timestamp()), "to": int(now.timestamp()),
        "prev_from": int((start - week).timestamp()), "prev_to": int((now - week).timestamp()),
        "start": start, "end": now,
    }


def _period_params() -> dict[str, int]:
    p = report_period()
    return {k: p[k] for k in ("from", "to", "prev_from", "prev_to")}


async def get_recent_interactions() -> list[dict[str, Any]]:
    """Return recent visitor conversations with the portfolio chat agent.

    Covers the report period: since the previous scheduled report (Mon or
    Thu 08:00 IST). Use this first.

    Returns:
        A list of interaction dicts, most-recent first. Each:
        {question, response, status, country, city, logged_at}. `status` is one
        of ok | error | injection_blocked | too_long | rate_limited — anything
        other than "ok" is a gap worth flagging. Returns an empty list when the
        Worker is unreachable or unconfigured.
    """
    base = _base_url()
    token = _token()
    if not base or not token:
        logger.info("ambient interactions skipped: AGENT_LOG_URL/TOKEN unset")
        return []
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.get(
                f"{base}/api/ambient/interactions",
                params=_period_params(),
                headers=_headers(token),
            )
        if r.status_code != 200:
            logger.warning("ambient interactions failed: %s %s", r.status_code, r.text[:200])
            return []
        return list(r.json().get("interactions", []))
    except Exception as exc:
        logger.warning("ambient interactions errored: %s", exc)
        return []


async def get_visitor_stats() -> dict[str, Any]:
    """Return pre-aggregated site + agent metrics for the digest.

    Combines real pageview analytics and Atlas conversations: how many, in which
    mode (text, voice, avatar, hands-free conversation), how they ended, what
    pages and sources brought people in. Use it as context for your headline
    and action; the email renders every number itself, so never restate them.

    The period is the time since the previous scheduled report, compared
    with the same span one week earlier (`period` in the result).

    Returns:
        A dict (empty {} if the Worker is unreachable) with keys:
          all_time:    {pageviews, unique_visitors, conversations, send_failures, ...}
          period: {from, to, prev_from, prev_to}  (unix seconds)
          window / prev_window: {pageviews, unique_visitors, conversations, ...}
          usage_mtd: [{model, turns, tokens_in, tokens_out, avatar_seconds}]
            this month's model usage
          model_spend_usd: {tokens, avatar, total} this month's ESTIMATED
            Gemini + avatar spend in USD, billed to adk-deploy-trail, which the
            billing export can't see
          modes / prev_modes: [{mode, turns, sessions, avatar_seconds,
                                median_first_ms}]
          statuses: [{status, count}]   (ok, interrupted, scope_blocked, ...)
          top_pages: [{path, views, visitors}], top_referrers: [{source, views}]
          emails: {resumes, notes, failures}, fallback: {turns, fell_back}
          top_posts: [{post_id, reactions, comments, reposts}]
          top_questions: [{question, count}], geo: [{country, city, count}],
          errors: [{question, status, error_message, logged_at}],
          chat_models: [{model, count}]
    """
    base = _base_url()
    token = _token()
    if not base or not token:
        logger.info("ambient stats skipped: AGENT_LOG_URL/TOKEN unset")
        return {}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.get(
                f"{base}/api/ambient/stats",
                params=_period_params(),
                headers=_headers(token),
            )
        if r.status_code != 200:
            logger.warning("ambient stats failed: %s %s", r.status_code, r.text[:200])
            return {}
        stats = dict(r.json())
        stats["model_spend_usd"] = estimate_model_spend(stats.get("usage_mtd") or [])
        return stats
    except Exception as exc:
        logger.warning("ambient stats errored: %s", exc)
        return {}


# --- Cost watch (spec 84) -----------------------------------------------------

# One run asks twice (the agent for context, the email to render), and a
# Lighthouse run takes ~30s, so successful results are reused for 10 minutes.
_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_CACHE_TTL_S = 600.0


def _cached(name: str):
    def deco(fn):
        async def wrapper() -> dict[str, Any]:
            hit = _CACHE.get(name)
            if hit and time.monotonic() - hit[0] < _CACHE_TTL_S:
                return hit[1]
            value = await fn()
            _CACHE[name] = (time.monotonic(), value)  # failures too: one run, one attempt
            return value
        wrapper.__name__, wrapper.__doc__ = fn.__name__, fn.__doc__
        return wrapper
    return deco


_PROJECT = "gcp-experiments-490306"
_REGION = "us-central1"
# Services that are meant to run an instance all day. Atlas is deliberate
# (no cold starts for visitors); anything else with min-instances > 0 is how
# the 2026-09-20 intake test leak looked.
ALWAYS_ON_OK = {"atlas"}


def _budget() -> float:
    try:
        return float(os.environ.get("PULSE_COST_BUDGET", "1200"))
    except ValueError:
        return 1200.0


async def _always_on_services() -> list[dict[str, Any]] | None:
    """Cloud Run services with min-instances > 0, read with Pulse's own
    identity. None when it can't tell (local dev, no credentials)."""
    try:
        import google.auth
        import google.auth.transport.requests

        def token() -> str:
            creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
            creds.refresh(google.auth.transport.requests.Request())
            return creds.token

        bearer = await asyncio.to_thread(token)
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.get(
                f"https://run.googleapis.com/v2/projects/{_PROJECT}/locations/{_REGION}/services",
                headers={"Authorization": f"Bearer {bearer}"},
            )
        if r.status_code != 200:
            logger.warning("cloud run list failed: %s %s", r.status_code, r.text[:200])
            return None
        out = []
        for svc in r.json().get("services", []):
            name = svc.get("name", "").rsplit("/", 1)[-1]
            mins = max(
                int((svc.get("scaling") or {}).get("minInstanceCount") or 0),
                int(((svc.get("template") or {}).get("scaling") or {}).get("minInstanceCount") or 0),
            )
            if mins > 0:
                out.append({"service": name, "min_instances": mins, "expected": name in ALWAYS_ON_OK})
        return out
    except Exception as exc:  # noqa: BLE001 - the email still goes out without it
        logger.warning("cloud run list errored: %s", exc)
        return None


async def _cloud_run_hours_mtd() -> dict[str, float] | None:
    """Billable instance-hours per Cloud Run service this month, from Cloud
    Monitoring. The bill has no per-service line, so Cloud Run's cost is
    split by these shares (idle instance time dominates this site's bill)."""
    try:
        import google.auth
        import google.auth.transport.requests

        def token() -> str:
            creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
            creds.refresh(google.auth.transport.requests.Request())
            return creds.token

        bearer = await asyncio.to_thread(token)
        now = datetime.now(timezone.utc)
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        span = max(60, int((now - start).total_seconds()))
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.get(
                f"https://monitoring.googleapis.com/v3/projects/{_PROJECT}/timeSeries",
                headers={"Authorization": f"Bearer {bearer}"},
                params={
                    "filter": 'metric.type="run.googleapis.com/container/billable_instance_time" '
                              'AND resource.type="cloud_run_revision"',
                    "interval.startTime": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "interval.endTime": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "aggregation.alignmentPeriod": f"{span}s",
                    "aggregation.perSeriesAligner": "ALIGN_SUM",
                    "aggregation.crossSeriesReducer": "REDUCE_SUM",
                    "aggregation.groupByFields": "resource.label.service_name",
                },
            )
        if r.status_code != 200:
            logger.warning("cloud run hours failed: %s %s", r.status_code, r.text[:200])
            return None
        hours: dict[str, float] = {}
        for ts in r.json().get("timeSeries", []):
            name = ts["resource"]["labels"].get("service_name", "?")
            secs = sum(float(p["value"].get("doubleValue") or 0) for p in ts.get("points", []))
            hours[name] = hours.get(name, 0.0) + secs / 3600
        return hours or None
    except Exception as exc:  # noqa: BLE001
        logger.warning("cloud run hours errored: %s", exc)
        return None


def split_cloud_run(mtd: float, hours: dict[str, float] | None) -> list[dict[str, Any]]:
    """Pure: Cloud Run's month-to-date cost shared out by instance-hours."""
    total = sum((hours or {}).values())
    if not mtd or not total:
        return []
    rows = [{"service": name, "hours": round(h, 1), "mtd": round(mtd * h / total, 2)}
            for name, h in (hours or {}).items() if h > 0]
    return sorted(rows, key=lambda r: -r["mtd"])


def summarize_costs(raw: dict[str, Any], budget: float, today: datetime) -> dict[str, Any]:
    """Pure: the Worker's ?view=digest payload -> what the email shows."""
    by_service = [r for r in raw.get("by_service") or [] if float(r.get("mtd") or 0) > 0]
    mtd = round(sum(float(r["mtd"]) for r in by_service), 2)
    daily = [float(d.get("total") or 0) for d in raw.get("daily") or []]
    days_in_month = calendar.monthrange(today.year, today.month)[1]
    # Run-rate from the last 7 days, so a step change (a new always-on
    # service) moves the forecast within days instead of being averaged away.
    recent = daily[-7:]
    per_day = (sum(recent) / len(recent)) if recent else 0.0
    remaining = max(0, days_in_month - today.day)
    forecast = round(mtd + per_day * remaining, 2)
    movers = []
    for w in raw.get("weeks") or []:
        this, last = float(w.get("this_week") or 0), float(w.get("last_week") or 0)
        monthly = this / 7 * 30
        if monthly >= 100 and (last == 0 or this >= 1.5 * last):
            movers.append({"service": w.get("service"), "this_week": round(this, 2),
                           "last_week": round(last, 2), "new": last == 0})
    latest = raw.get("export_latest")
    stale = True
    if latest:
        try:
            stamp = datetime.fromisoformat(re.sub(r"(\.\d+)?( UTC|Z)?$", "", latest)).replace(tzinfo=timezone.utc)
            stale = today - stamp > timedelta(days=3)
        except ValueError:
            stale = False
    services = [{"service": r["service"], "mtd": round(float(r["mtd"]), 2)} for r in by_service]
    by_share = services[:4]
    rest = round(sum(r["mtd"] for r in services[4:]), 2)
    if rest > 0:
        by_share.append({"service": "Other", "mtd": rest})
    return {
        "ok": True,
        "currency": raw.get("currency") or "INR",
        "usd_rate": float(raw["usd_rate"]) if raw.get("usd_rate") else None,
        "daily": [round(v, 2) for v in daily],
        "days_in_month": days_in_month,
        "by_service": by_share,
        "mtd": mtd,
        "per_day": round(per_day, 2),
        "forecast": forecast,
        "budget": budget,
        "over_budget": forecast > budget,
        "top_services": [{"service": r["service"], "mtd": round(float(r["mtd"]), 2)} for r in by_service[:3]],
        "movers": movers[:3],
        "stale": stale,
        "month_start": today.day <= 4,
    }


@_cached("cost")
async def get_cost_summary() -> dict[str, Any]:
    """Return this month's Google Cloud spend for the digest's Cost watch.

    Month-to-date net cost (after credits), a month-end forecast at the last
    seven days' run-rate, the budget, the top services, week-over-week movers
    and any Cloud Run service left running an instance all day that isn't
    meant to. Context only: the email renders the numbers itself.

    Returns:
        {ok, currency, mtd, forecast, budget, over_budget, top_services,
        movers, always_on, stale} or {ok: False, reason, detail} when billing
        data isn't reachable. reason "export_pending" means the export is on
        but has no data yet: that resolves itself, so don't recommend fixing
        permissions or settings. Never raises.
    """
    base = _base_url()
    token = os.environ.get("COST_MONITOR_TOKEN", "").strip()
    always_on = await _always_on_services()
    if not base or not token:
        return {"ok": False, "reason": "not_configured", "always_on": always_on}
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(
                f"{base}/api/gcp-cost",
                params={"view": "digest"},
                headers={"Authorization": f"Bearer {token}"},
            )
        if r.status_code != 200:
            logger.warning("cost summary failed: %s %s", r.status_code, r.text[:200])
            # The export's table only appears once Google delivers the first
            # data, up to a day after it's enabled. Say that, so neither the
            # email nor the model guesses at permissions.
            pending = "Not found: Table" in r.text
            return {"ok": False, "reason": "export_pending" if pending else "unavailable",
                    "detail": ("The billing export is enabled, but Google hasn't delivered the first data "
                               "yet; it usually arrives within a day. Nothing to fix.") if pending
                    else "The billing data couldn't be read this run.",
                    "always_on": always_on}
        summary = summarize_costs(r.json(), _budget(), datetime.now(timezone.utc))
        summary["always_on"] = always_on
        run_mtd = next((float(x["mtd"]) for x in r.json().get("by_service") or [] if x.get("service") == "Cloud Run"), 0.0)
        summary["cloud_run_services"] = split_cloud_run(run_mtd, await _cloud_run_hours_mtd())
        return summary
    except Exception as exc:  # noqa: BLE001
        logger.warning("cost summary errored: %s", exc)
        return {"ok": False, "reason": "unavailable", "always_on": always_on}


_POST_ID_RE = re.compile(r"(\d{10,})")


async def get_post_titles() -> dict[str, str]:
    """LinkedIn post id -> its first line, from the live posts.json. Not a
    tool; the email uses it to name the top posts. {} on any failure."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.get("https://gauravlahoti.dev/content/posts.json")
        posts = r.json() if r.status_code == 200 else []
        out = {}
        for p in posts if isinstance(posts, list) else []:
            m = _POST_ID_RE.search(str(p.get("url") or ""))
            if m:
                out[m.group(1)] = str(p.get("firstLine") or "").strip()
        return out
    except Exception as exc:  # noqa: BLE001
        logger.warning("post titles errored: %s", exc)
        return {}


# --- Website performance (spec 84) --------------------------------------------

_SITE = "https://gauravlahoti.dev/"
_PSI = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
_METRICS = {
    "first-contentful-paint": "fcp",
    "largest-contentful-paint": "lcp",
    "total-blocking-time": "tbt",
    "cumulative-layout-shift": "cls",
    "speed-index": "speed_index",
    "total-byte-weight": "page_weight",
}


@_cached("perf")
async def get_site_performance() -> dict[str, Any]:
    """Return a fresh Lighthouse run of the home page on mobile, via Google's
    PageSpeed Insights API, for website recommendations.

    Gives the performance score (0-100), the lab metrics with their display
    values (FCP, LCP, TBT, CLS, speed index, page weight), the top savings
    opportunities with estimated milliseconds saved, and Chrome real-user
    field data when the site has enough traffic for it. Compare against the
    site's own budget: FCP under 1.5s on 4G, Lighthouse performance 90+.

    Returns:
        {ok, score, metrics, opportunities: [{title, savings_ms}], field} or
        {ok: False, reason}. Never raises; takes up to a minute.
    """
    try:
        import google.auth
        import google.auth.transport.requests

        def token() -> str:
            creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
            creds.refresh(google.auth.transport.requests.Request())
            return creds.token

        params = {"url": _SITE, "strategy": "mobile", "category": "performance"}
        headers: dict[str, str] = {}
        # The PageSpeed API rejects Cloud Run's identity token (its scope is
        # cloud-platform), so it uses a key restricted to this one API
        # (Secret Manager `pagespeed-api-key`). The token path is a fallback.
        if os.environ.get("PAGESPEED_API_KEY", "").strip():
            params["key"] = os.environ["PAGESPEED_API_KEY"].strip()
        else:
            headers = {"Authorization": f"Bearer {await asyncio.to_thread(token)}",
                       "X-Goog-User-Project": _PROJECT}
        async with httpx.AsyncClient(timeout=90.0) as client:
            r = await client.get(_PSI, params=params, headers=headers)
        if r.status_code != 200:
            logger.warning("pagespeed failed: %s %s", r.status_code, r.text[:200])
            return {"ok": False, "reason": f"pagespeed returned {r.status_code}"}
        return summarize_psi(r.json())
    except Exception as exc:  # noqa: BLE001
        logger.warning("pagespeed errored: %s", exc)
        return {"ok": False, "reason": "unavailable"}


def summarize_psi(data: dict[str, Any]) -> dict[str, Any]:
    """Pure: a PageSpeed Insights v5 response -> the few facts Pulse needs."""
    lr = data.get("lighthouseResult") or {}
    audits = lr.get("audits") or {}
    score = ((lr.get("categories") or {}).get("performance") or {}).get("score")
    metrics = {key: (audits.get(audit) or {}).get("displayValue") for audit, key in _METRICS.items()}
    opps = []
    for a in audits.values():
        details = a.get("details") or {}
        saving = details.get("overallSavingsMs") or 0
        if details.get("type") == "opportunity" and saving >= 100:
            opps.append({"title": a.get("title"), "savings_ms": int(saving)})
    field_metrics = (data.get("loadingExperience") or {}).get("metrics") or {}
    field = {k.lower(): (v or {}).get("category") for k, v in field_metrics.items()}
    return {
        "ok": True,
        "score": round(score * 100) if isinstance(score, (int, float)) else None,
        "metrics": metrics,
        "opportunities": sorted(opps, key=lambda o: -o["savings_ms"])[:5],
        "field": field or None,
    }


# --- What changed recently (spec 84) ------------------------------------------

_REPO = "gauravlahoti/gauravlahoti.github.io"


async def get_recent_changes(days: int = 21) -> dict[str, Any]:
    """Return what shipped to the site recently: the merged commits on main
    (date and title, which names the spec it implements), newest first.

    Check every recommendation against this before you make it. If a change
    already fixed the problem, drop it, or, when the evidence predates the fix,
    say to confirm the fix from that date holds. Conversations carry
    `logged_at` (unix seconds) to compare with.

    Args:
        days: How far back to look. Default 21.

    Returns:
        {ok, changes: [{date, title}]} or {ok: False, reason}. Never raises.
    """
    since = (datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 90)))).strftime("%Y-%m-%dT%H:%M:%SZ")
    headers = {"Accept": "application/vnd.github+json"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.get(f"https://api.github.com/repos/{_REPO}/commits",
                                 params={"sha": "main", "since": since, "per_page": 60}, headers=headers)
        if r.status_code != 200:
            logger.warning("recent changes failed: %s %s", r.status_code, r.text[:200])
            return {"ok": False, "reason": f"github returned {r.status_code}"}
        changes = [
            {"date": c["commit"]["author"]["date"][:10], "title": c["commit"]["message"].splitlines()[0][:160]}
            for c in r.json()
            if not c["commit"]["message"].startswith("Merge ")
        ]
        return {"ok": True, "changes": changes}
    except Exception as exc:  # noqa: BLE001
        logger.warning("recent changes errored: %s", exc)
        return {"ok": False, "reason": "unavailable"}


# --- Model spend estimate (spec 84) --------------------------------------------
# Gemini and the avatar run on adk-deploy-trail, billed to an account the
# billing export can't read, so their spend is estimated from usage.
#
# Token prices: Gemini API standard paid tier, USD per 1M tokens (input,
# output including thinking), from ai.google.dev/gemini-api/docs/pricing,
# checked 2026-10-02. Introductory rates run to 2026-12-31 and double from
# 2027-01-01. Vertex AI list prices may differ; override with
# PULSE_PRICE_IN_PER_1M / PULSE_PRICE_OUT_PER_1M (applies to every model).
# The avatar is priced per spoken second, Atlas's own rate
# (agents/atlas/app/app_utils/avatar_speak.py USD_PER_SPEAKING_SECOND).
# Not counted: voice transcription and speech, eval runs.
_INTRO_UNTIL = datetime(2027, 1, 1, tzinfo=timezone.utc)
_TOKEN_PRICES = {  # model prefix -> (in, out) introductory; doubled after
    "gemini-3.8-flash": (0.75, 3.75),
    "gemini-3.7-flash": (0.75, 3.75),
    "gemini-3.6-flash": (0.75, 3.75),
}
AVATAR_USD_PER_S = 6192 / 1e6 * 1.0 + 25 / 1e6 * 12.0


def _rate(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def token_prices(model: str, when: datetime | None = None) -> tuple[float, float]:
    """(input, output) USD per 1M tokens for a model on a date."""
    when = when or datetime.now(timezone.utc)
    base = next((v for k, v in _TOKEN_PRICES.items() if (model or "").startswith(k)), (0.75, 3.75))
    mult = 1.0 if when < _INTRO_UNTIL else 2.0
    return (_rate("PULSE_PRICE_IN_PER_1M", base[0] * mult), _rate("PULSE_PRICE_OUT_PER_1M", base[1] * mult))


def tokens_cost_usd(model: str, tokens_in: float, tokens_out: float, when: datetime | None = None) -> float:
    pin, pout = token_prices(model, when)
    return tokens_in * pin / 1e6 + tokens_out * pout / 1e6


def estimate_model_spend(usage: list[dict[str, Any]], when: datetime | None = None) -> dict[str, float]:
    tokens = sum(tokens_cost_usd(str(u.get("model") or ""), float(u.get("tokens_in") or 0),
                                 float(u.get("tokens_out") or 0), when) for u in usage)
    secs = sum(float(u.get("avatar_seconds") or 0) for u in usage)
    avatar = secs * _rate("PULSE_AVATAR_USD_PER_S", AVATAR_USD_PER_S)
    return {"tokens": round(tokens, 2), "avatar": round(avatar, 2), "total": round(tokens + avatar, 2),
            "avatar_seconds": round(secs, 1)}
